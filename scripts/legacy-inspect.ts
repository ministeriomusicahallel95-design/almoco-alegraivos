import { config } from '../server/config.js';
import { sheetsTransport } from '../server/sheets.js';
const cfg = config();
if (!cfg.serviceEmail || !cfg.serviceKey)
  throw new Error('Configure a conta de serviço Google para realizar a inspeção somente leitura.');
const api = sheetsTransport(cfg);
const tabs = await api.metadata();
const headers = await api.read(tabs.map((t) => `'${t.replace(/'/g, "''")}'!1:1`));
console.log(
  JSON.stringify(
    tabs.map((name, index) => ({ name, headers: headers[index]?.[0] || [] })),
    null,
    2,
  ),
);
console.log(
  'Somente leitura. O Apps Script e os pedidos pendentes ainda precisam de revisão antes do corte.',
);
