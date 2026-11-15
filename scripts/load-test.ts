import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { config } from '../server/config.js';
import { database, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { LocalPayments } from '../server/payment.js';
import { LocalSheets } from '../server/sheets.js';
import { MENU } from '../shared/domain.js';
const count = Number(process.env.LOAD_COUNT || 5000);
const concurrency = 100;
if (!Number.isInteger(count) || count < 100 || count > 20000)
  throw new Error('LOAD_COUNT deve ficar entre 100 e 20000.');
// Banco isolado em memória: nunca usa DATABASE_URL ou credenciais do .env.
const cfg = config({
  NODE_ENV: 'test',
  INTEGRATION_MODE: 'local',
  LOCAL_DATA_DIR: ':memory:',
  APP_URL: 'http://localhost:3015',
});
const db = await database(cfg);
await migrate(db);
const payments = new LocalPayments();
const env = await createApp(cfg, db, {
  payments,
  sheets: new LocalSheets(db),
  frontend: false,
  rateLimit: false,
});
const times: number[] = [];
const ids: string[] = [];
let next = 0;
const start = performance.now();
try {
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < count) {
        const n = next++;
        const t = performance.now();
        const r = await env.app.inject({
          method: 'POST',
          url: '/api/pedidos',
          headers: { origin: cfg.url },
          payload: {
            requestId: randomUUID(),
            accessToken: randomBytes(32).toString('hex'),
            name: `Teste Carga ${n}`,
            cpf: '52998224725',
            phone: '92999999999',
            accepted: true,
            items: [{ id: MENU[0].id, quantity: 1 }],
          },
        });
        if (r.statusCode !== 201) throw new Error(`Pedido ${n}: HTTP ${r.statusCode}`);
        ids.push(r.json().id);
        times.push(performance.now() - t);
        if ((n + 1) % 1000 === 0) console.log(`${n + 1}/${count} pedidos de teste`);
      }
    }),
  );
  const paidIds = ids.slice(0, 100);
  await Promise.all(
    paidIds.map(async (id) => {
      const p = await payments.create(await env.orders.row(id));
      await env.orders.applyPayment({
        ...p,
        status: 'processed',
        status_detail: 'accredited',
        total_paid_amount: p.total_amount,
      });
    }),
  );
  const contested = await Promise.allSettled(
    Array.from({ length: 100 }, () =>
      env.orders.delivery(
        { requestId: randomUUID(), orderId: paidIds[0], itemId: MENU[0].id, quantity: 1 },
        'carga@teste.local',
      ),
    ),
  );
  const totals = (
    await db.query(
      'SELECT count(*)::integer AS n,count(DISTINCT id)::integer AS unique_ids FROM orders',
    )
  ).rows[0];
  const allowed = contested.filter((v) => v.status === 'fulfilled').length;
  if (totals.n !== count || totals.unique_ids !== count || allowed !== 1)
    throw new Error('Falha de integridade no teste de carga.');
  times.sort((a, b) => a - b);
  const report = {
    timestamp: new Date().toISOString(),
    engine: 'PGlite local, PostgreSQL embutido; Fastify inject, sem rede',
    orders: count,
    concurrency,
    uniqueOrders: totals.unique_ids,
    p95CreateMs: Math.round(times[Math.floor(times.length * 0.95)]),
    elapsedMs: Math.round(performance.now() - start),
    paymentConfirmations: 100,
    concurrentDeliveryAttempts: 100,
    acceptedDeliveries: allowed,
    limits:
      'Não mede PostgreSQL de produção, rede, hospedagem, Google, Mercado Pago nem navegador. Não representa homologação de capacidade do ambiente real.',
  };
  await mkdir('validation', { recursive: true });
  await writeFile('validation/load-test.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await env.app.close();
  await db.close();
}
