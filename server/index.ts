import { config } from './config.js';
import { database, migrate } from './db.js';
import { createApp } from './app.js';
const cfg = config();
if (!cfg.live && !['127.0.0.1', 'localhost', '::1'].includes(cfg.host))
  throw new Error('O modo de demonstração deve ficar restrito ao computador local.');
const db = await database(cfg);
await migrate(db);
const { app, worker } = await createApp(cfg, db);
await app.listen({ port: cfg.port, host: cfg.host });
worker.start();
console.log(
  `Alegrai-vos: ${cfg.url} — ${cfg.live ? 'integrações reais configuradas' : 'DEMONSTRAÇÃO LOCAL, sem cobranças e sem gravação no Google'}`,
);
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await app.close();
  await db.close();
}
process.on('SIGINT', () => {
  void stop().then(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void stop().then(() => process.exit(0));
});
