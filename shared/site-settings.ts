import { z } from 'zod';
import { EVENT, MENU } from './domain.js';

const required = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'Preencha os campos obrigatórios.')
    .max(max, `Use no máximo ${max} caracteres.`);
const date = z.iso.date({ error: 'Informe uma data válida.' });
const httpsUrl = z
  .url({ error: 'Informe um endereço completo.' })
  .max(1000)
  .refine((v) => {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password;
  }, 'Use um endereço HTTPS, sem usuário ou senha.');
export const siteSettingsSchema = z
  .object({
    event: z
      .object({
        name: required(120),
        startDate: date,
        endDate: date,
        deadline: z.iso.datetime({
          offset: true,
          error: 'Informe uma data e horário válidos para as reservas.',
        }),
        location: required(200),
        city: required(120),
        pickup: required(200),
        hours: required(120),
        whatsapp: z
          .string()
          .transform((v) => v.replace(/\D/g, ''))
          .refine((v) => /^\d{12,13}$/.test(v), 'Informe o WhatsApp com 55, DDD e número.'),
        website: httpsUrl,
        organization: required(160),
        instagram: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9._]{1,80}$/, 'Informe somente o nome do Instagram, sem @.'),
        heroMessage: required(500),
        accompaniment: required(1000),
        warning: required(1500),
        notes: z.string().trim().max(3000),
      })
      .strict(),
    menu: z
      .array(
        z.object({
          id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/, 'Identificador do prato inválido.'),
          day: date,
          name: required(120),
          cents: z.number().int().min(1, 'O preço deve ser maior que zero.').max(1_000_000),
          description: z.string().trim().max(500).default(''),
          enabled: z.boolean().default(true),
        }),
      )
      .min(1, 'Cadastre pelo menos um prato.')
      .max(40, 'Cadastre no máximo 40 opções de pratos.'),
  })
  .strict()
  .superRefine((site, ctx) => {
    if (site.event.endDate < site.event.startDate)
      ctx.addIssue({
        code: 'custom',
        path: ['event', 'endDate'],
        message: 'O fim do evento precisa ser igual ou posterior ao início.',
      });
    if (Date.parse(site.event.deadline) > Date.parse(site.event.endDate + 'T23:59:59-04:00'))
      ctx.addIssue({
        code: 'custom',
        path: ['event', 'deadline'],
        message: 'As reservas não podem terminar depois do evento.',
      });
    if (new Set(site.menu.map((i) => i.id)).size !== site.menu.length)
      ctx.addIssue({
        code: 'custom',
        path: ['menu'],
        message: 'Existem pratos com identificadores repetidos.',
      });
    for (const [index, item] of site.menu.entries())
      if (item.enabled && (item.day < site.event.startDate || item.day > site.event.endDate))
        ctx.addIssue({
          code: 'custom',
          path: ['menu', index, 'day'],
          message: `A data de “${item.name}” precisa estar no período do evento.`,
        });
  })
  .transform((site) => ({
    ...site,
    menu: site.menu.map((item) => ({ ...item, label: mealDayLabel(item.day) })),
  }));
export type SiteSettings = z.infer<typeof siteSettingsSchema>;
export type EventSettings = SiteSettings['event'];
export function dateLabel(
  value: string,
  options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' },
) {
  return new Date(value + 'T12:00:00-04:00').toLocaleDateString('pt-BR', {
    timeZone: 'America/Manaus',
    ...options,
  });
}
export function mealDayLabel(day: string) {
  const weekday = dateLabel(day, { weekday: 'long' });
  return weekday.charAt(0).toUpperCase() + weekday.slice(1) + ' · ' + dateLabel(day);
}
export function mealDatesLabel(menu: SiteSettings['menu']) {
  const days = [...new Set(menu.filter((i) => i.enabled).map((i) => i.day))].sort();
  if (!days.length) return 'Cardápio em preparação';
  const sameMonth = days.every((day) => day.slice(0, 7) === days[0].slice(0, 7));
  const values = days.map((day) => (sameMonth ? String(Number(day.slice(-2))) : dateLabel(day)));
  const joined =
    values.length > 1 ? values.slice(0, -1).join(', ') + ' e ' + values.at(-1) : values[0];
  return sameMonth ? joined + ' de ' + dateLabel(days[0], { month: 'long' }) : joined;
}
export function eventDatesLabel(event: EventSettings) {
  if (event.startDate === event.endDate)
    return dateLabel(event.startDate, { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    dateLabel(event.startDate) +
    ' a ' +
    dateLabel(event.endDate, { day: 'numeric', month: 'long', year: 'numeric' })
  );
}
export const DEFAULT_SITE: SiteSettings = siteSettingsSchema.parse({
  event: {
    ...EVENT,
    startDate: '2026-11-19',
    endDate: '2026-11-21',
    organization: 'Comunidade Católica Hallel',
    instagram: 'alegraivoshallel',
    heroMessage: 'Viva o encontro com tranquilidade.\nA gente cuida do seu almoço.',
    accompaniment: 'arroz, purê de batata e salada de legumes',
    notes: '',
  },
  menu: MENU.map((item) => ({ ...item, description: '', enabled: true })),
});
