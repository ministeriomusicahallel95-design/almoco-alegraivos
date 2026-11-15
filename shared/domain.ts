import { z } from 'zod';
import type { EventSettings } from './site-settings.js';

export const EVENT = {
  name: 'Alegrai-vos 2026',
  deadline: '2026-11-20T03:59:59.000Z',
  location: 'Centro de Convenções Vasco Vasques',
  city: 'Manaus — AM',
  pickup: 'Praça de alimentação',
  hours: '11h30 às 14h',
  whatsapp: '5592993243020',
  website: 'https://ministeriomusicahallel95-design.github.io/alegrai-vos-2026/',
  warning: 'Comida não retirada no dia e horário de entrega não tem devolução do valor.',
};
export const MENU = [
  {
    id: 'carne-brocolis-20',
    day: '2026-11-20',
    label: 'Sexta-feira · 20 de novembro',
    name: 'Carne com brócolis',
    cents: 2500,
  },
  {
    id: 'frango-crocante-20',
    day: '2026-11-20',
    label: 'Sexta-feira · 20 de novembro',
    name: 'Frango crocante',
    cents: 2500,
  },
  {
    id: 'frango-crocante-21',
    day: '2026-11-21',
    label: 'Sábado · 21 de novembro',
    name: 'Frango crocante',
    cents: 2500,
  },
  {
    id: 'porco-agridoce-21',
    day: '2026-11-21',
    label: 'Sábado · 21 de novembro',
    name: 'Porco agridoce',
    cents: 2500,
  },
];
export const money = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const digits = (s: string) => s.replace(/\D/g, '');
export function validCpf(value: string) {
  const cpf = digits(value);
  return (
    /^\d{11}$/.test(cpf) &&
    !/^(\d)\1{10}$/.test(cpf) &&
    [9, 10].every((n) => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += Number(cpf[i]) * (n + 1 - i);
      return ((sum * 10) % 11) % 10 === Number(cpf[n]);
    })
  );
}
export const orderInput = z
  .object({
    requestId: z.uuid(),
    accessToken: z.string().regex(/^[a-f0-9]{64}$/),
    name: z
      .string()
      .trim()
      .min(5)
      .max(150)
      .refine((n) => n.split(/\s+/).length >= 2, 'Informe seu nome completo.'),
    phone: z
      .string()
      .transform(digits)
      .refine((s) => /^\d{10,11}$/.test(s), 'Informe telefone com DDD.'),
    cpf: z.string().transform(digits).refine(validCpf, 'Informe um CPF válido.'),
    accepted: z.literal(true, { error: 'Confirme a ciência sobre a retirada.' }),
    catalogRevision: z.number().int().nonnegative().optional(),
    items: z
      .array(z.object({ id: z.string(), quantity: z.number().int().min(1).max(20) }))
      .min(1)
      .max(40),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.items.map((i) => i.id)).size !== v.items.length)
      ctx.addIssue({ code: 'custom', message: 'Selecione pratos válidos, sem repetições.' });
  });
export type OrderInput = z.infer<typeof orderInput>;
export type Item = (typeof MENU)[number] & { quantity: number; description?: string };
export type Status =
  'pendente' | 'pago' | 'rejeitado' | 'expirado' | 'cancelado' | 'estornado' | 'em_revisao';
export const STATUS_LABELS: Record<Status, string> = {
  pendente: 'Aguardando pagamento',
  pago: 'Pagamento confirmado',
  rejeitado: 'Pagamento recusado',
  expirado: 'Pagamento expirado',
  cancelado: 'Pedido cancelado',
  estornado: 'Pagamento estornado',
  em_revisao: 'Pagamento em análise',
};
export interface PublicOrder {
  id: string;
  name: string;
  items: Item[];
  total: number;
  status: Status;
  code: string | null;
  checkoutUrl: string | null;
  expiresAt: string;
  createdAt: string;
  local: boolean;
  event: EventSettings;
  deliveries: { itemId: string; quantity: number }[];
}
