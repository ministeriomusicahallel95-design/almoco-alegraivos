import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { orderInput, type Item, type PublicOrder, type Status } from '../shared/domain.js';
import type { Config } from './config.js';
import type { Database, Sql } from './db.js';
import { decimalCents, paymentStatus, type PaymentOrder, type Payments } from './payment.js';
import { readSite } from './site-settings.js';
import { DEFAULT_SITE, type EventSettings } from '../shared/site-settings.js';

export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const canonical = (value: any): string =>
  JSON.stringify(value, (_key, v) =>
    v && !Array.isArray(v) && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
export class Problem extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface OrderRow {
  id: string;
  request_id: string;
  access_hash: string;
  payload_hash: string;
  customer: { name: string; phone: string; cpf: string; acceptedAt: string };
  items: Item[];
  total: number;
  status: Status;
  code: string | null;
  provider_id: string | null;
  checkout_url: string | null;
  payment: Record<string, any>;
  review_reason: string | null;
  provider_updated_at: Date | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  event_snapshot: EventSettings | null;
}
const iso = (s: Date | string) => new Date(s).toISOString();
export async function enqueue(
  tx: Sql,
  kind: string,
  orderId: string | null,
  payload: object = {},
  id: string = randomUUID(),
) {
  await tx.query(
    'INSERT INTO jobs(id,kind,order_id,payload) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',
    [id, kind, orderId, JSON.stringify(payload)],
  );
}
export class Orders {
  constructor(
    public db: Database,
    public cfg: Config,
    public payments: Payments,
  ) {}
  async create(raw: unknown) {
    const input = orderInput.parse(raw);
    const { requestId, accessToken, ...data } = input;
    data.items.sort((a, b) => a.id.localeCompare(b.id));
    const payloadHash = hash(JSON.stringify(data));
    const tokenHash = hash(accessToken);
    const existing = (
      await this.db.query<OrderRow>('SELECT * FROM orders WHERE request_id=$1', [requestId])
    ).rows[0];
    if (existing) {
      if (existing.access_hash !== tokenHash || existing.payload_hash !== payloadHash)
        throw new Problem(409, 'Identificação de pedido já utilizada com outros dados.');
      return this.public(existing);
    }
    const id = requestId;
    await this.db.tx(async (tx) => {
      const site = await readSite(tx);
      if (input.catalogRevision !== undefined && input.catalogRevision !== site.revision)
        throw new Problem(
          409,
          'O cardápio foi atualizado. Atualize a página e confira os pratos e valores antes de continuar.',
        );
      if (this.cfg.live && (!this.cfg.sales || Date.now() > Date.parse(site.event.deadline)))
        throw new Problem(
          409,
          'As reservas não estão abertas. Entre em contato com a organização.',
        );
      const items: Item[] = data.items.map((i) => {
        const item = site.menu.find((m) => m.id === i.id && m.enabled);
        if (!item)
          throw new Problem(400, 'Um dos pratos não está mais disponível. Atualize o cardápio.');
        return { ...item, quantity: i.quantity };
      });
      const total = items.reduce((sum, i) => sum + i.quantity * i.cents, 0);
      const result = await tx.query<OrderRow>(
        `INSERT INTO orders(id,request_id,access_hash,payload_hash,customer,items,total,expires_at,event_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(request_id) DO NOTHING RETURNING *`,
        [
          id,
          requestId,
          tokenHash,
          payloadHash,
          JSON.stringify({
            name: data.name,
            cpf: data.cpf,
            phone: data.phone,
            acceptedAt: new Date().toISOString(),
          }),
          JSON.stringify(items),
          total,
          new Date(Date.now() + 30 * 60_000),
          JSON.stringify(site.event),
        ],
      );
      if (result.rows.length) {
        await enqueue(tx, 'create', id, {}, `create:${id}`);
        await enqueue(tx, 'sheets', id);
      }
    });
    const row = (
      await this.db.query<OrderRow>('SELECT * FROM orders WHERE request_id=$1', [requestId])
    ).rows[0];
    if (row.access_hash !== tokenHash || row.payload_hash !== payloadHash)
      throw new Problem(409, 'Pedido já utilizado com outros dados.');
    return this.public(row);
  }
  async row(id: string, token?: string) {
    const row = (await this.db.query<OrderRow>('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
    if (!row || (token !== undefined && row.access_hash !== hash(token)))
      throw new Problem(404, 'Pedido não encontrado. Use o acesso salvo neste aparelho.');
    return row;
  }
  async public(row: OrderRow): Promise<PublicOrder> {
    const deliveries = (
      await this.db.query<{ itemId: string; quantity: number }>(
        'SELECT item_id AS "itemId", sum(quantity)::integer AS quantity FROM deliveries WHERE order_id=$1 GROUP BY item_id',
        [row.id],
      )
    ).rows;
    return {
      id: row.id,
      name: row.customer.name,
      items: row.items,
      total: row.total,
      status: row.status,
      code: row.status === 'pago' ? row.code : null,
      checkoutUrl: row.status === 'pendente' ? row.checkout_url : null,
      expiresAt: iso(row.expires_at),
      createdAt: iso(row.created_at),
      local: !this.cfg.live,
      event: row.event_snapshot || structuredClone(DEFAULT_SITE.event),
      deliveries,
    };
  }
  async applyPayment(p: PaymentOrder) {
    await this.db.tx(async (tx) => {
      const row = (
        await tx.query<OrderRow>('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [
          p.external_reference,
        ])
      ).rows[0];
      if (!row) throw new Problem(404, 'Pagamento sem pedido correspondente.');
      if (
        String(p.user_id) !== (this.cfg.live ? this.cfg.sellerId : 'local') ||
        p.currency !== 'BRL' ||
        decimalCents(p.total_amount) !== row.total ||
        (row.provider_id && row.provider_id !== p.id)
      )
        throw new Problem(409, 'Pagamento divergente: referência, recebedor, moeda ou valor.');
      const stamp = Date.parse(p.last_updated_date || p.created_date || '');
      if (!Number.isFinite(stamp))
        throw new Problem(409, 'Pagamento sem data de atualização verificável.');
      if (row.provider_updated_at && stamp < new Date(row.provider_updated_at).getTime()) return;
      let status = paymentStatus(p);
      // Estados de reversão não reativam vales a partir de notificações antigas.
      if (row.code && ['estornado', 'em_revisao'].includes(row.status) && status === 'pago')
        status = row.status;
      if (row.status === 'pago' && status === 'pendente') return;
      const code =
        row.code ||
        (status === 'pago' ? 'HAL-' + randomBytes(8).toString('hex').toUpperCase() : null);
      const payment = {
        id: p.id,
        status: p.status,
        detail: p.status_detail,
        paidCents: decimalCents(p.total_paid_amount),
        methods: (p.transactions?.payments || []).map((i) => ({
          id: i.id,
          status: i.status,
          method: i.payment_method?.id,
          type: i.payment_method?.type,
        })),
        updatedAt: new Date(stamp).toISOString(),
      };
      const same = row.status === status && canonical(row.payment) === canonical(payment);
      if (same) return;
      await tx.query(
        `UPDATE orders SET status=$2,code=$3,payment=$4,provider_id=$5,provider_updated_at=$6,updated_at=now() WHERE id=$1`,
        [row.id, status, code, JSON.stringify(payment), p.id, new Date(stamp)],
      );
      await enqueue(tx, 'sheets', row.id);
      await tx.query('INSERT INTO audit(actor,action,resource) VALUES($1,$2,$3)', [
        'mercadopago',
        `pagamento:${status}`,
        row.id,
      ]);
    });
  }
  async delivery(raw: unknown, actor: string) {
    const input = z
      .object({
        requestId: z.uuid(),
        orderId: z.uuid(),
        itemId: z.string(),
        quantity: z.number().int().min(1).max(20),
      })
      .strict()
      .parse(raw);
    return this.db.tx(async (tx) => {
      const row = (
        await tx.query<OrderRow>('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [input.orderId])
      ).rows[0];
      if (!row) throw new Problem(404, 'Pedido não encontrado.');
      const previous = (
        await tx.query('SELECT * FROM deliveries WHERE request_id=$1', [input.requestId])
      ).rows[0];
      if (previous) {
        if (
          previous.order_id !== input.orderId ||
          previous.item_id !== input.itemId ||
          previous.quantity !== input.quantity
        )
          throw new Problem(409, 'Identificação de entrega já utilizada.');
        return previous;
      }
      if (row.status !== 'pago')
        throw new Problem(409, 'Entrega disponível somente para pagamento confirmado.');
      const item = row.items.find((i) => i.id === input.itemId);
      if (!item) throw new Problem(400, 'Prato não pertence ao pedido.');
      if (this.cfg.live) {
        const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Manaus' }).format(
          new Date(),
        );
        if (date !== item.day)
          throw new Problem(409, 'Registre a entrega apenas no dia correspondente ao prato.');
      }
      const delivered = Number(
        (
          await tx.query(
            'SELECT coalesce(sum(quantity),0)::integer AS qty FROM deliveries WHERE order_id=$1 AND item_id=$2',
            [row.id, item.id],
          )
        ).rows[0].qty,
      );
      if (delivered + input.quantity > item.quantity)
        throw new Problem(
          409,
          'Quantidade excede o saldo. Outra pessoa pode ter registrado a entrega.',
        );
      const result = (
        await tx.query(
          `INSERT INTO deliveries(id,request_id,order_id,item_id,day,quantity,actor) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [randomUUID(), input.requestId, row.id, item.id, item.day, input.quantity, actor],
        )
      ).rows[0];
      await enqueue(tx, 'sheets', row.id);
      await tx.query('INSERT INTO audit(actor,action,resource) VALUES($1,$2,$3)', [
        actor,
        'retirada',
        result.id,
      ]);
      return result;
    });
  }
  async teamSearch(search: string, status?: string, day?: string) {
    const normalized = /^[+()\s\d-]+$/.test(search) ? search.replace(/\D/g, '') : search;
    const term = '%' + normalized.replace(/[\\%_]/g, '\\$&') + '%';
    const rows = (
      await this.db.query<OrderRow>(
        `SELECT * FROM orders WHERE ($1='' OR code ILIKE $2 OR customer->>'name' ILIKE $2 OR customer->>'phone' ILIKE $2)
      AND ($3='' OR status=$3) AND ($4='' OR EXISTS(SELECT 1 FROM jsonb_array_elements(items) i WHERE i->>'day'=$4)) ORDER BY created_at DESC LIMIT 50`,
        [search, term, status || '', day || ''],
      )
    ).rows;
    return Promise.all(
      rows.map(async (row) => ({
        ...(await this.public(row)),
        phone: row.customer.phone,
        code: row.code,
        cpfMasked: '***.***.' + row.customer.cpf.slice(6, 9) + '-**',
        payment: row.payment,
        deliveriesLog: (
          await this.db.query(
            'SELECT item_id,day,quantity,actor,created_at FROM deliveries WHERE order_id=$1 ORDER BY created_at',
            [row.id],
          )
        ).rows,
        syncPending:
          (
            await this.db.query(
              'SELECT count(*)::integer AS n FROM jobs WHERE kind=$1 AND order_id=$2 AND completed_at IS NULL',
              ['sheets', row.id],
            )
          ).rows[0].n > 0,
      })),
    );
  }
  async stats() {
    const totals = (
      await this.db
        .query(`SELECT count(*)::integer AS orders, count(*) FILTER(WHERE status='pago')::integer AS paid,
      coalesce(sum(total) FILTER(WHERE status='pago'),0)::bigint AS revenue, count(*) FILTER(WHERE status='pendente')::integer AS pending FROM orders`)
    ).rows[0];
    const queue = (
      await this.db
        .query(`SELECT count(*) FILTER(WHERE kind='sheets')::integer AS sync, count(*) FILTER(WHERE last_error IS NOT NULL)::integer AS errors,
      min(created_at) FILTER(WHERE kind='sheets') AS oldest FROM jobs WHERE completed_at IS NULL`)
    ).rows[0];
    const delivered = (
      await this.db.query('SELECT coalesce(sum(quantity),0)::integer AS total FROM deliveries')
    ).rows[0].total;
    const kitchen = (
      await this.db
        .query(`SELECT i->>'id' AS id,i->>'name' AS name,i->>'day' AS day,sum((i->>'quantity')::integer)::integer AS quantity
      FROM orders CROSS JOIN jsonb_array_elements(items) i WHERE status='pago' GROUP BY i->>'id',i->>'name',i->>'day' ORDER BY day,name`)
    ).rows;
    return { ...totals, revenue: Number(totals.revenue), ...queue, delivered, kitchen };
  }
}
