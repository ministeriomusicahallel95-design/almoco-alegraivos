import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { config } from '../server/config.js';
import { database, migrate, type Database } from '../server/db.js';
import { createApp } from '../server/app.js';
import { LocalPayments, decimalCents, paymentStatus, validSignature } from '../server/payment.js';
import { GoogleSheets, LocalSheets, TABS, type SheetsTransport } from '../server/sheets.js';
import { Orders } from '../server/service.js';
import { MENU } from '../shared/domain.js';
import { DEFAULT_SITE, mealDayLabel, siteSettingsSchema } from '../shared/site-settings.js';
import { readSite, saveSite } from '../server/site-settings.js';
import { hash } from '../server/service.js';

const cfg = config({
  NODE_ENV: 'test',
  INTEGRATION_MODE: 'local',
  LOCAL_DATA_DIR: ':memory:',
  APP_URL: 'http://localhost:3015',
});
const input = () => ({
  requestId: randomUUID(),
  accessToken: randomBytes(32).toString('hex'),
  name: 'Cliente de Teste',
  phone: '92999999999',
  cpf: '52998224725',
  accepted: true,
  items: [
    { id: MENU[0].id, quantity: 2 },
    { id: MENU[2].id, quantity: 1 },
  ],
});
let db: Database;
let env: Awaited<ReturnType<typeof createApp>>;
let payments: LocalPayments;
let sheets: LocalSheets;
beforeAll(async () => {
  db = await database(cfg);
  await migrate(db);
  payments = new LocalPayments();
  sheets = new LocalSheets(db);
  env = await createApp(cfg, db, { payments, sheets, frontend: false, rateLimit: false });
});
beforeEach(async () => {
  await db.query(
    'TRUNCATE orders, jobs, deliveries, payment_events, settings, sessions, oauth_states, audit, leases, sheet_rows, sheet_sequences RESTART IDENTITY CASCADE',
  );
  payments.records.clear();
  sheets.records.clear();
});
afterAll(async () => {
  await env.app.close();
  await db.close();
});
async function approved(id: string) {
  const row = await env.orders.row(id);
  const p = await payments.create(row);
  const result = {
    ...p,
    status: 'processed',
    status_detail: 'accredited',
    total_paid_amount: p.total_amount,
    last_updated_date: new Date().toISOString(),
  };
  await env.orders.applyPayment(result);
  return result;
}
const origin = { origin: cfg.url };
describe('Pedido, pagamento e retirada', () => {
  test('valida catálogo, CPF, aceite e total no servidor', async () => {
    const valid = input();
    const o = await env.orders.create(valid);
    expect(o.total).toBe(7500);
    expect(o.code).toBeNull();
    expect(o.id).toBe(valid.requestId);
    for (const raw of [
      { ...input(), cpf: '11111111111' },
      { ...input(), accepted: false },
      { ...input(), total: 1 },
      { ...input(), items: [{ id: 'inventado', quantity: 1 }] },
      { ...input(), items: [{ id: MENU[0].id, quantity: 21 }] },
    ])
      await expect(env.orders.create(raw)).rejects.toThrow();
  });
  test('40 cliques concorrentes geram apenas um pedido e uma tarefa de cobrança', async () => {
    const raw = input();
    const results = await Promise.all(Array.from({ length: 40 }, () => env.orders.create(raw)));
    expect(new Set(results.map((o) => o.id)).size).toBe(1);
    expect((await db.query('SELECT count(*)::integer AS n FROM orders')).rows[0].n).toBe(1);
    expect(
      (await db.query("SELECT count(*)::integer AS n FROM jobs WHERE kind='create'")).rows[0].n,
    ).toBe(1);
    await expect(env.orders.create({ ...raw, name: 'Outra Pessoa' })).rejects.toThrow(
      'outros dados',
    );
    await expect(
      env.orders.create({ ...raw, accessToken: randomBytes(32).toString('hex') }),
    ).rejects.toThrow('outros dados');
  });
  test('acesso privado, CSRF e origem são obrigatórios; retorno não aprova pagamento', async () => {
    const raw = input();
    const o = await env.orders.create(raw);
    expect((await env.app.inject(`/api/pedidos/${o.id}`)).statusCode).toBe(401);
    expect(
      (
        await env.app.inject({
          url: `/api/pedidos/${o.id}`,
          headers: { authorization: `Bearer ${'a'.repeat(64)}` },
        })
      ).statusCode,
    ).toBe(404);
    const own = await env.app.inject({
      url: `/api/pedidos/${o.id}`,
      headers: { authorization: `Bearer ${raw.accessToken}` },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().status).toBe('pendente');
    expect(own.json().cpf).toBeUndefined();
    expect(
      (
        await env.app.inject({
          method: 'POST',
          url: '/api/pedidos',
          payload: input(),
          headers: { origin: 'https://outro.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await env.app.inject('/api/equipe/pedidos')).statusCode).toBe(401);
    const login = await env.app.inject({
      method: 'POST',
      url: '/api/local/equipe/entrar',
      headers: origin,
    });
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const session = (
      await env.app.inject({ url: '/api/equipe/sessao', headers: { cookie } })
    ).json();
    expect(
      (
        await env.app.inject({
          method: 'POST',
          url: '/api/equipe/retiradas',
          payload: {},
          headers: { ...origin, cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(session.csrf).toHaveLength(64);
  });
  test('recusa valor, moeda, vendedor e referência divergentes', async () => {
    const o = await env.orders.create(input());
    const p = await payments.create(await env.orders.row(o.id));
    for (const bad of [
      { ...p, total_amount: '1.00' },
      { ...p, currency: 'USD' },
      { ...p, user_id: 'outro' },
      { ...p, external_reference: randomUUID() },
    ])
      await expect(env.orders.applyPayment(bad)).rejects.toThrow();
    expect((await env.orders.row(o.id)).code).toBeNull();
  });
  test('pagamento repetido libera um único código; estorno bloqueia nova retirada', async () => {
    const o = await env.orders.create(input());
    const p = await approved(o.id);
    const code = (await env.orders.row(o.id)).code;
    await Promise.all(Array.from({ length: 10 }, () => env.orders.applyPayment(p)));
    expect((await env.orders.row(o.id)).code).toBe(code);
    expect(
      (await db.query("SELECT count(*)::integer AS n FROM audit WHERE action='pagamento:pago'"))
        .rows[0].n,
    ).toBe(1);
    await env.orders.applyPayment({
      ...p,
      status: 'refunded',
      status_detail: 'refunded',
      last_updated_date: new Date(Date.now() + 1000).toISOString(),
    });
    await env.orders.applyPayment(p);
    expect((await env.orders.row(o.id)).status).toBe('estornado');
    await expect(
      env.orders.delivery(
        { requestId: randomUUID(), orderId: o.id, itemId: MENU[0].id, quantity: 1 },
        'equipe@teste.local',
      ),
    ).rejects.toThrow('somente');
  });
  test('duas entregas concorrentes não ultrapassam o saldo; dias são independentes', async () => {
    const o = await env.orders.create(input());
    await approved(o.id);
    const command = { requestId: randomUUID(), orderId: o.id, itemId: MENU[0].id, quantity: 2 };
    const result = await Promise.allSettled([
      env.orders.delivery(command, 'a@teste.local'),
      env.orders.delivery({ ...command, requestId: randomUUID() }, 'b@teste.local'),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await env.orders.delivery(command, 'a@teste.local');
    await env.orders.delivery(
      { ...command, requestId: randomUUID(), itemId: MENU[2].id, quantity: 1 },
      'b@teste.local',
    );
    expect((await db.query('SELECT sum(quantity)::integer AS n FROM deliveries')).rows[0].n).toBe(
      3,
    );
  });
  test('worker cria cobrança, atualiza status e gera QR de verdade', async () => {
    const raw = input();
    const o = await env.orders.create(raw);
    await env.worker.once();
    expect((await env.orders.row(o.id)).checkout_url).toContain('/pagamento-local/');
    const qr = await env.app.inject({
      url: `/api/pedidos/${o.id}/qr`,
      headers: { authorization: `Bearer ${raw.accessToken}` },
    });
    expect(qr.statusCode).toBe(200);
    expect(qr.headers['content-type']).toContain('image/png');
    expect(qr.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    const p = await env.app.inject({
      method: 'POST',
      url: `/api/local/pedidos/${o.id}/pagar`,
      headers: { ...origin, authorization: `Bearer ${raw.accessToken}` },
    });
    expect(p.statusCode).toBe(200);
    expect(p.json().code).toMatch(/^HAL-[A-F0-9]{16}$/);
  });
  test('link externo fica em rascunho e não confirma pedidos', async () => {
    const login = await env.app.inject({
      method: 'POST',
      url: '/api/local/equipe/entrar',
      headers: origin,
    });
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const s = (await env.app.inject({ url: '/api/equipe/sessao', headers: { cookie } })).json();
    const headers = { ...origin, cookie, 'x-csrf-token': s.csrf };
    expect(
      (
        await env.app.inject({
          method: 'PUT',
          url: '/api/equipe/configuracao',
          headers,
          payload: { paymentLinkDraft: 'https://fraude.example/pagar' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await env.app.inject({
          method: 'PUT',
          url: '/api/equipe/configuracao',
          headers,
          payload: { paymentLinkDraft: 'https://mpago.la/exemplo' },
        })
      ).json().active,
    ).toBe(false);
    const result = (
      await env.app.inject({ url: '/api/equipe/configuracao', headers: { cookie } })
    ).json();
    expect(result.qr).toMatch(/^data:image\/png/);
    expect(result.active).toBe(false);
  });
  test('falha de sincronização preserva a tarefa para nova tentativa', async () => {
    const o = await env.orders.create(input());
    const failing = new (await import('../server/worker.js')).Worker(env.orders, {
      sync: async () => {
        throw new Error('offline');
      },
    });
    await failing.once();
    const jobs = (await db.query("SELECT * FROM jobs WHERE kind='sheets' AND completed_at IS NULL"))
      .rows;
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0].last_error).toContain('tentativa');
    await db.query("UPDATE jobs SET available_at=now() WHERE kind='sheets'");
    await env.worker.once();
    expect(sheets.records.has(`Hallel_Pedidos_v1:${o.id}`)).toBe(true);
  });
});
describe('Notificações e estados oficiais', () => {
  test('assinatura válida, adulterada e expirada', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const id = 'ORDABC';
    const requestId = 'request-1';
    const secret = 'teste';
    const sig = createHmac('sha256', secret)
      .update(`id:${id.toLowerCase()};request-id:${requestId};ts:${ts};`)
      .digest('hex');
    expect(validSignature(id, requestId, `ts=${ts},v1=${sig}`, secret)).toBe(true);
    expect(validSignature(id, 'outro', `ts=${ts},v1=${sig}`, secret)).toBe(false);
    expect(validSignature(id, requestId, `ts=${ts},v1=${sig}`, secret, Date.now() + 600_000)).toBe(
      false,
    );
    expect(decimalCents('0.01')).toBe(1);
    expect(decimalCents('1.001')).toBe(-1);
  });
  test('webhook persiste antes de responder, deduplica e não confia no body', async () => {
    const liveCfg = { ...cfg, live: true, mpSecret: 'teste', sellerId: 'local' };
    const live = await createApp(liveCfg, db, {
      payments,
      sheets,
      frontend: false,
      rateLimit: false,
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const id = 'ORDABC';
    const reqId = 'request-1';
    const sig = createHmac('sha256', 'teste')
      .update(`id:ordabc;request-id:${reqId};ts:${ts};`)
      .digest('hex');
    const req = {
      method: 'POST' as const,
      url: `/api/webhooks/mercadopago?data.id=${id}`,
      payload: { id: 'evento1', type: 'order', user_id: 'local', data: { id }, status: 'pago' },
      headers: { 'x-signature': `ts=${ts},v1=${sig}`, 'x-request-id': reqId },
    };
    expect((await live.app.inject({ ...req, headers: {} })).statusCode).toBe(401);
    expect((await live.app.inject(req)).statusCode).toBe(200);
    expect((await live.app.inject(req)).statusCode).toBe(200);
    expect((await db.query('SELECT count(*)::integer AS n FROM payment_events')).rows[0].n).toBe(1);
    expect(
      (await db.query("SELECT count(*)::integer AS n FROM jobs WHERE id='mp:evento1'")).rows[0].n,
    ).toBe(1);
    await live.app.close();
  });
  test('estados recusado, expirado, cancelado e parcial não liberam código', () => {
    const base = {
      id: 'x',
      external_reference: 'x',
      user_id: 'local',
      currency: 'BRL',
      total_amount: '25.00',
      total_paid_amount: '25.00',
    };
    for (const [status, expected] of [
      ['failed', 'rejeitado'],
      ['expired', 'expirado'],
      ['canceled', 'cancelado'],
      ['partially_refunded', 'em_revisao'],
    ])
      expect(paymentStatus({ ...base, status })).toBe(expected);
    expect(
      paymentStatus({
        ...base,
        status: 'processed',
        status_detail: 'accredited',
        total_paid_amount: '24.00',
      }),
    ).not.toBe('pago');
  });
  test('produção incompleta falha antes de aceitar pedidos', () => {
    expect(() => config({ NODE_ENV: 'production' })).toThrow();
    expect(() => config({ INTEGRATION_MODE: 'live' })).toThrow();
  });
});
describe('Configuração administrativa de evento e cardápio', () => {
  test('novos dados e preços entram no servidor sem alterar pedidos anteriores', async () => {
    const before = await env.orders.create(input());
    const changed = structuredClone(DEFAULT_SITE);
    changed.event.name = 'Evento atualizado';
    changed.event.notes = 'Retire no balcão identificado.';
    changed.event.startDate = '2027-01-02';
    changed.event.endDate = '2027-01-04';
    changed.event.deadline = '2027-01-01T23:00:00-04:00';
    changed.menu = changed.menu.map((i) => ({
      ...i,
      day: '2027-01-03',
      name: 'Novo ' + i.name,
      cents: 3200,
    }));
    const saved = await saveSite(db, { revision: 0, site: changed }, 'admin@teste.local');
    const config = (await env.app.inject('/api/config')).json();
    expect(config.event.name).toBe('Evento atualizado');
    expect(config.menu[0].label).toBe(mealDayLabel('2027-01-03'));
    const after = await env.orders.create({ ...input(), catalogRevision: saved.revision });
    expect(after.total).toBe(9600);
    expect(after.items[0].day).toBe('2027-01-03');
    expect(after.event.notes).toContain('balcão');
    const historical = await env.orders.public(await env.orders.row(before.id));
    expect(historical.total).toBe(7500);
    expect(historical.items[0].name).toBe(MENU[0].name);
    expect(historical.event.name).toBe(DEFAULT_SITE.event.name);
    expect(historical.items[0].day).toBe('2026-11-20');
  });
  test('prato desativado é recusado e nova opção é aceita com preço cadastrado', async () => {
    const site = structuredClone(DEFAULT_SITE);
    site.menu[0].enabled = false;
    site.menu.push({ ...site.menu[1], id: 'nova-opcao', name: 'Opção vegetariana', cents: 2800 });
    await saveSite(db, { revision: 0, site }, 'admin@teste.local');
    await expect(env.orders.create(input())).rejects.toThrow('não está mais disponível');
    const order = await env.orders.create({
      ...input(),
      items: [{ id: 'nova-opcao', quantity: 2 }],
    });
    expect(order.total).toBe(5600);
  });
  test('detecta configuração concorrente e revisão antiga do cardápio', async () => {
    await saveSite(db, { revision: 0, site: DEFAULT_SITE }, 'admin@teste.local');
    await expect(
      saveSite(db, { revision: 0, site: DEFAULT_SITE }, 'outro@teste.local'),
    ).rejects.toThrow('Outro administrador');
    await expect(env.orders.create({ ...input(), catalogRevision: 0 })).rejects.toThrow(
      'cardápio foi atualizado',
    );
    expect((await readSite(db)).revision).toBe(1);
  });
  test('recusa período inválido, prato fora das datas e preço inválido', () => {
    const a = structuredClone(DEFAULT_SITE);
    a.event.endDate = '2026-11-18';
    expect(siteSettingsSchema.safeParse(a).success).toBe(false);
    const b = structuredClone(DEFAULT_SITE);
    b.menu[0].day = '2026-12-01';
    expect(siteSettingsSchema.safeParse(b).success).toBe(false);
    const c = structuredClone(DEFAULT_SITE);
    c.menu[0].cents = 0;
    expect(siteSettingsSchema.safeParse(c).success).toBe(false);
    const d = structuredClone(DEFAULT_SITE);
    d.event.website = 'javascript:alert(1)';
    expect(siteSettingsSchema.safeParse(d).success).toBe(false);
  });
  test('somente administrador autenticado com CSRF pode salvar; não vaza credenciais', async () => {
    expect((await env.app.inject('/api/equipe/site')).statusCode).toBe(401);
    const login = await env.app.inject({
      method: 'POST',
      url: '/api/local/equipe/entrar',
      headers: origin,
    });
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const s = (await env.app.inject({ url: '/api/equipe/sessao', headers: { cookie } })).json();
    expect(
      (
        await env.app.inject({
          method: 'PUT',
          url: '/api/equipe/site',
          headers: { ...origin, cookie },
          payload: { revision: 0, site: DEFAULT_SITE },
        })
      ).statusCode,
    ).toBe(403);
    const saved = await env.app.inject({
      method: 'PUT',
      url: '/api/equipe/site',
      headers: { ...origin, cookie, 'x-csrf-token': s.csrf },
      payload: { revision: 0, site: DEFAULT_SITE },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().revision).toBe(1);
    const staffToken = randomBytes(32).toString('hex');
    await db.query('INSERT INTO sessions(hash,email,csrf,expires_at) VALUES($1,$2,$3,$4)', [
      hash(staffToken),
      'staff@teste.local',
      'csrf',
      new Date(Date.now() + 60000),
    ]);
    const live = await createApp(
      {
        ...cfg,
        live: true,
        team: ['admin@teste.local', 'staff@teste.local'],
        mpToken: 'segredo-que-nao-pode-vazar',
      },
      db,
      { payments, sheets, frontend: false, rateLimit: false },
    );
    expect(
      (
        await live.app.inject({
          url: '/api/equipe/site',
          headers: { cookie: `hallel_session=${staffToken}` },
        })
      ).statusCode,
    ).toBe(403);
    const publicConfig = await live.app.inject('/api/config');
    expect(publicConfig.body).not.toContain('segredo-que-nao-pode-vazar');
    await live.app.close();
  });
});
describe('Sincronização idempotente com o contrato Google Sheets', () => {
  class Transport implements SheetsTransport {
    cells = new Map<string, any[][]>();
    failAfterWrite = false;
    async metadata() {
      return Object.keys(TABS);
    }
    async addTabs() {}
    async read(ranges: string[]) {
      return ranges.map((r) => this.cells.get(r.replace('1:1', 'A1')) || []);
    }
    async write(data: { range: string; values: any[][] }[]) {
      for (const d of data) this.cells.set(d.range, d.values);
      if (this.failAfterWrite && data.some((d) => !d.range.endsWith('A1'))) {
        this.failAfterWrite = false;
        throw new Error('Resposta perdida após gravar');
      }
    }
  }
  test('timeout após gravação repete as mesmas linhas, sem duplicar', async () => {
    const o = await env.orders.create(input());
    await approved(o.id);
    const transport = new Transport();
    const sink = new GoogleSheets(db, transport);
    transport.failAfterWrite = true;
    await expect(sink.sync([o.id])).rejects.toThrow('Resposta perdida');
    const count = transport.cells.size;
    await sink.sync([o.id]);
    expect(transport.cells.size).toBe(count);
    const ids = (await db.query('SELECT entity FROM sheet_rows')).rows;
    expect(new Set(ids.map((r) => r.entity)).size).toBe(ids.length);
  });
  test('não sobrescreve linha ocupada por outro registro', async () => {
    const o = await env.orders.create(input());
    const t = new Transport();
    const sink = new GoogleSheets(db, t);
    await sink.sync([o.id]);
    const range = "'Hallel_Pedidos_v1'!A2";
    t.cells.set(range, [['outro-registro']]);
    await expect(sink.sync([o.id])).rejects.toThrow('Linha movida');
    expect(t.cells.get(range)?.[0][0]).toBe('outro-registro');
  });
});
