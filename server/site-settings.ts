import type { Database, Sql } from './db.js';
import { DEFAULT_SITE, siteSettingsSchema } from '../shared/site-settings.js';
import { z } from 'zod';
export class SettingsConflict extends Error {}
export async function readSite(db: Sql) {
  const stored = (await db.query("SELECT value FROM settings WHERE key='site'")).rows[0]?.value;
  return stored
    ? { revision: stored.revision as number, ...siteSettingsSchema.parse(stored.site) }
    : { revision: 0, ...structuredClone(DEFAULT_SITE) };
}
export async function saveSite(db: Database, body: unknown, actor: string) {
  const input = z
    .object({ revision: z.number().int().nonnegative(), site: siteSettingsSchema })
    .strict()
    .parse(body);
  return db.tx(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(26112027)');
    const current = await readSite(tx);
    if (current.revision !== input.revision)
      throw new SettingsConflict(
        'Outro administrador atualizou as configurações. Recarregue antes de salvar.',
      );
    const revision = current.revision + 1;
    await tx.query(
      "INSERT INTO settings(key,value) VALUES('site',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify({ revision, site: input.site })],
    );
    await tx.query('INSERT INTO audit(actor,action,resource) VALUES($1,$2,$3)', [
      actor,
      'configurar_evento_cardapio',
      `site:${revision}`,
    ]);
    return { revision, ...input.site };
  });
}
