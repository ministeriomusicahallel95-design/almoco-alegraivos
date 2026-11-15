import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import type { Item, Status } from '../shared/domain.js';
import type { EventSettings } from '../shared/site-settings.js';
export interface PaymentOrder {
  id: string;
  external_reference: string;
  total_amount: string;
  total_paid_amount?: string;
  user_id: string | number;
  currency: string;
  status: string;
  status_detail?: string;
  checkout_url?: string;
  last_updated_date?: string;
  created_date?: string;
  transactions?: {
    payments?: {
      id: string;
      status: string;
      status_detail?: string;
      amount?: string;
      paid_amount?: string;
      payment_method?: { id?: string; type?: string };
    }[];
  };
}
export interface Payments {
  create(order: {
    id: string;
    total: number;
    items: Item[];
    event_snapshot?: EventSettings | null;
  }): Promise<PaymentOrder>;
  get(id: string): Promise<PaymentOrder>;
}
export function decimalCents(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,2})?$/.test(value)) return -1;
  const [whole, fraction = ''] = value.split('.');
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(n) ? n : -1;
}
export function paymentStatus(p: PaymentOrder): Status {
  if (p.status === 'refunded') return 'estornado';
  if (
    ['charged_back', 'partially_refunded', 'in_mediation'].includes(p.status) ||
    /chargeback|refund|mediation/.test(p.status_detail || '')
  )
    return 'em_revisao';
  if (
    p.status === 'processed' &&
    p.status_detail === 'accredited' &&
    decimalCents(p.total_paid_amount) === decimalCents(p.total_amount)
  )
    return 'pago';
  if (p.status === 'expired') return 'expirado';
  if (['canceled', 'cancelled'].includes(p.status)) return 'cancelado';
  if (p.status === 'failed' || p.status === 'rejected') return 'rejeitado';
  return 'pendente';
}
export function validSignature(
  id: string,
  requestId: string,
  signature: string,
  secret: string,
  now = Date.now(),
) {
  const parts = Object.fromEntries(signature.split(',').map((s) => s.trim().split('=')));
  if (
    !/^\d{10,13}$/.test(parts.ts || '') ||
    !/^[a-f0-9]{64}$/.test(parts.v1 || '') ||
    !requestId ||
    !secret
  )
    return false;
  const stamp = Number(parts.ts) * (parts.ts.length <= 10 ? 1000 : 1);
  if (Math.abs(now - stamp) > 5 * 60_000) return false;
  const expected = createHmac('sha256', secret)
    .update(`id:${id.toLowerCase()};request-id:${requestId};ts:${parts.ts};`)
    .digest();
  return timingSafeEqual(expected, Buffer.from(parts.v1, 'hex'));
}
export function mercadoPago(c: Config): Payments {
  async function call(path: string, init: RequestInit = {}) {
    const result = await fetch(`https://api.mercadopago.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${c.mpToken}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!result.ok) throw new Error(`Mercado Pago indisponível (HTTP ${result.status}).`);
    return (await result.json()) as PaymentOrder;
  }
  return {
    create: (order) =>
      call('/v1/orders', {
        method: 'POST',
        headers: { 'X-Idempotency-Key': order.id },
        body: JSON.stringify({
          type: 'online',
          processing_mode: 'manual',
          capture_mode: 'automatic_async',
          total_amount: (order.total / 100).toFixed(2),
          external_reference: order.id,
          expiration_time: 'PT30M',
          description: `Alimentação Hallel — ${order.event_snapshot?.name || 'Alegrai-vos 2026'}`,
          items: order.items.map((i) => ({
            title: `${i.name} — ${i.day}`,
            quantity: i.quantity,
            unit_price: (i.cents / 100).toFixed(2),
          })),
          config: {
            online: {
              success_url: `${c.url}/?retorno=sucesso`,
              failure_url: `${c.url}/?retorno=falha`,
              pending_url: `${c.url}/?retorno=pendente`,
            },
          },
        }),
      }),
    get: (id) => call(`/v1/orders/${encodeURIComponent(id)}`),
  };
}
// Disponível somente no modo local; nunca envia dinheiro ou dados a terceiros.
export class LocalPayments implements Payments {
  records = new Map<string, PaymentOrder>();
  async create(order: { id: string; total: number; items: Item[] }) {
    const id = `LOCAL-${order.id}`;
    if (!this.records.has(id))
      this.records.set(id, {
        id,
        external_reference: order.id,
        user_id: 'local',
        currency: 'BRL',
        status: 'created',
        total_amount: (order.total / 100).toFixed(2),
        total_paid_amount: '0.00',
        last_updated_date: new Date().toISOString(),
        checkout_url: `/pagamento-local/${order.id}`,
      });
    return this.records.get(id)!;
  }
  async get(id: string) {
    const p = this.records.get(id);
    if (!p) throw new Error('Pagamento de teste não encontrado.');
    return p;
  }
}
