import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
const root = 'http://localhost:3015';
const health = (await (await fetch(root + '/api/health')).json()) as any;
if (health.mode !== 'local') throw new Error('Este teste só pode escrever na demonstração local.');
const access = randomBytes(32).toString('hex');
let cookie = '';
let csrf = '';
async function call(path: string, method = 'GET', body?: unknown, privateOrder = false) {
  const r = await fetch(root + path, {
    method,
    headers: {
      origin: root,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(privateOrder ? { Authorization: `Bearer ${access}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const sc = r.headers.getSetCookie();
  if (sc.length) cookie = sc.map((v) => v.split(';')[0]).join('; ');
  const data = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(data)}`);
  return data as any;
}
const order = await call('/api/pedidos', 'POST', {
  requestId: randomUUID(),
  accessToken: access,
  name: 'Demonstração Local',
  cpf: '52998224725',
  phone: '92999999999',
  accepted: true,
  items: [
    { id: 'carne-brocolis-20', quantity: 2 },
    { id: 'frango-crocante-21', quantity: 1 },
  ],
});
let pending = order;
for (let n = 0; n < 30 && !pending.checkoutUrl; n++) {
  await setTimeout(200);
  pending = await call(`/api/pedidos/${order.id}`, 'GET', undefined, true);
}
if (!pending.checkoutUrl) throw new Error('Cobrança de teste não foi preparada.');
const qr = await fetch(root + `/api/pedidos/${order.id}/qr`, {
  headers: { Authorization: `Bearer ${access}` },
});
if (!qr.ok || !qr.headers.get('content-type')?.includes('image/png'))
  throw new Error('QR indisponível.');
const paid = await call(`/api/local/pedidos/${order.id}/pagar`, 'POST', undefined, true);
if (!paid.code || paid.status !== 'pago' || !paid.local)
  throw new Error('Comprovante local não confirmado.');
await call('/api/local/equipe/entrar', 'POST');
const session = await call('/api/equipe/sessao');
csrf = session.csrf;
await call('/api/equipe/retiradas', 'POST', {
  requestId: randomUUID(),
  orderId: order.id,
  itemId: 'carne-brocolis-20',
  quantity: 2,
});
await call('/api/equipe/retiradas', 'POST', {
  requestId: randomUUID(),
  orderId: order.id,
  itemId: 'frango-crocante-21',
  quantity: 1,
});
const delivered = await call(`/api/pedidos/${order.id}`, 'GET', undefined, true);
if (delivered.deliveries.reduce((s: number, d: any) => s + d.quantity, 0) !== 3)
  throw new Error('Baixa das entregas divergente.');
await call('/api/equipe/configuracao', 'PUT', {
  paymentLinkDraft: 'https://mpago.la/exemplo-local',
});
const draft = await call('/api/equipe/configuracao');
if (draft.active || !draft.qr) throw new Error('Rascunho de pagamento inconsistente.');
await call('/api/equipe/sair', 'POST');
const report = {
  timestamp: new Date().toISOString(),
  mode: health.mode,
  version: health.version,
  actualHttp: true,
  browserTest: false,
  orderCreated: true,
  qrImageGenerated: true,
  paymentSimulated: true,
  codeGenerated: true,
  deliveriesByDay: [2, 1],
  savedLinkIsDraft: true,
  externalServicesContacted: false,
  note: 'Fluxo HTTP local; não substitui teste visual, leitura do QR em aparelho ou integração real.',
};
await mkdir('validation', { recursive: true });
await writeFile('validation/http-smoke.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
