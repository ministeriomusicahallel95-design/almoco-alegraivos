import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Config } from './config.js';
export interface Sql {
  query<T = any>(sql: string, args?: any[]): Promise<{ rows: T[] }>;
}
export interface Database extends Sql {
  tx<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function database(
  c: Pick<Config, 'databaseUrl' | 'dataDir' | 'databaseSsl' | 'databaseCa'>,
): Promise<Database> {
  if (c.databaseUrl) {
    const pool = new pg.Pool({
      connectionString: c.databaseUrl,
      max: 20,
      ssl: c.databaseSsl
        ? { rejectUnauthorized: true, ...(c.databaseCa ? { ca: c.databaseCa } : {}) }
        : undefined,
    });
    return {
      query: async <T>(s: string, a?: any[]) => ({ rows: (await pool.query(s, a)).rows as T[] }),
      close: () => pool.end(),
      tx: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn(client);
          await client.query('COMMIT');
          return result;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      },
    };
  }
  if (c.dataDir !== ':memory:') await mkdir(dirname(resolve(c.dataDir)), { recursive: true });
  const local = new PGlite(c.dataDir === ':memory:' ? undefined : c.dataDir);
  await local.waitReady;
  return {
    query: (s, a) => local.query(s, a),
    tx: (fn) => local.transaction((tx) => fn(tx)),
    close: () => local.close(),
  };
}
// Migração exclusivamente aditiva. Nenhuma planilha ou serviço externo é alterado.
export async function migrate(db: Database) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS schema_versions (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS orders (
      id text PRIMARY KEY, request_id text NOT NULL UNIQUE, access_hash text NOT NULL, payload_hash text NOT NULL,
      customer jsonb NOT NULL, items jsonb NOT NULL, total integer NOT NULL CHECK (total > 0),
      status text NOT NULL DEFAULT 'pendente', code text UNIQUE, provider_id text UNIQUE, checkout_url text,
      payment jsonb NOT NULL DEFAULT '{}', provider_updated_at timestamptz, review_reason text,
      expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS jobs (
      id text PRIMARY KEY, kind text NOT NULL, order_id text REFERENCES orders(id), payload jsonb NOT NULL DEFAULT '{}',
      attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), locked_until timestamptz,
      claim_token text, last_error text, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE INDEX IF NOT EXISTS jobs_pending ON jobs (available_at) WHERE completed_at IS NULL`,
    `CREATE TABLE IF NOT EXISTS payment_events (id text PRIMARY KEY, provider_id text NOT NULL, received_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS deliveries (
      id text PRIMARY KEY, request_id text NOT NULL UNIQUE, order_id text NOT NULL REFERENCES orders(id),
      item_id text NOT NULL, day text NOT NULL, quantity integer NOT NULL CHECK (quantity > 0), actor text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE INDEX IF NOT EXISTS deliveries_order ON deliveries(order_id)`,
    `CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS audit (id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, resource text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS sessions (hash text PRIMARY KEY, email text NOT NULL, csrf text NOT NULL, expires_at timestamptz NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS oauth_states (hash text PRIMARY KEY, verifier text NOT NULL, nonce text NOT NULL, expires_at timestamptz NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS leases (name text PRIMARY KEY, holder text NOT NULL, expires_at timestamptz NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sheet_sequences (tab text PRIMARY KEY, next_row integer NOT NULL DEFAULT 2)`,
    `CREATE TABLE IF NOT EXISTS sheet_rows (entity text PRIMARY KEY, tab text NOT NULL, row_number integer NOT NULL, UNIQUE(tab,row_number))`,
    `INSERT INTO schema_versions(version) VALUES(1) ON CONFLICT DO NOTHING`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS event_snapshot jsonb`,
    `INSERT INTO schema_versions(version) VALUES(2) ON CONFLICT DO NOTHING`,
  ];
  await db.tx(async (tx) => {
    // Serializa migrações quando mais de uma instância PostgreSQL iniciar.
    await tx.query('SELECT pg_advisory_xact_lock(26112026)');
    for (const statement of statements) await tx.query(statement);
  });
}
