import { expect, test } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { config } from '../server/config.js';
import { database, migrate } from '../server/db.js';
import { Orders } from '../server/service.js';
import { LocalPayments } from '../server/payment.js';
import { LocalSheets } from '../server/sheets.js';
import { Worker } from '../server/worker.js';
import { MENU } from '../shared/domain.js';
import { DEFAULT_SITE } from '../shared/site-settings.js';
import { readSite, saveSite } from '../server/site-settings.js';

test('reinício recupera pedido e tarefa após resposta de cobrança perdida', async () => {
  const parent = resolve('.local');
  const directory = resolve(parent, `test-restart-${randomUUID()}`);
  const cfg = config({
    NODE_ENV: 'test',
    INTEGRATION_MODE: 'local',
    LOCAL_DATA_DIR: resolve(directory, 'postgres'),
  });
  class AmbiguousPayments extends LocalPayments {
    fail = true;
    override async create(order: Parameters<LocalPayments['create']>[0]) {
      const p = await super.create(order);
      if (this.fail) {
        this.fail = false;
        throw new Error('Timeout após criar a cobrança');
      }
      return p;
    }
  }
  const provider = new AmbiguousPayments();
  let db = await database(cfg);
  try {
    await migrate(db);
    const changed = structuredClone(DEFAULT_SITE);
    changed.event.notes = 'Aviso persistido do administrador';
    await saveSite(db, { revision: 0, site: changed }, 'admin@teste.local');
    const orders = new Orders(db, cfg, provider);
    const o = await orders.create({
      requestId: randomUUID(),
      accessToken: randomBytes(32).toString('hex'),
      name: 'Teste Reinicio',
      phone: '92999999999',
      cpf: '52998224725',
      accepted: true,
      items: [{ id: MENU[0].id, quantity: 1 }],
    });
    const w = new Worker(orders, new LocalSheets(db));
    await w.once();
    expect((await orders.row(o.id)).provider_id).toBeNull();
    expect(provider.records.size).toBe(1);
    await db.close();
    db = await database(cfg);
    await migrate(db);
    const recovered = new Orders(db, cfg, provider);
    expect((await readSite(db)).event.notes).toBe('Aviso persistido do administrador');
    expect((await recovered.row(o.id)).total).toBe(2500);
    await db.query(
      'UPDATE jobs SET available_at=now(),locked_until=NULL WHERE completed_at IS NULL',
    );
    await new Worker(recovered, new LocalSheets(db)).once();
    expect((await recovered.row(o.id)).provider_id).toBe(`LOCAL-${o.id}`);
    expect(provider.records.size).toBe(1);
  } finally {
    await db.close();
    // Diretório exclusivo criado por este teste, resolvido e conferido antes da remoção.
    if (
      !directory.startsWith(parent + sep) ||
      !directory.split(sep).at(-1)?.startsWith('test-restart-')
    )
      throw new Error('Diretório de teste fora do escopo.');
    await rm(directory, { recursive: true, force: true });
  }
});
