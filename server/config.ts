import 'dotenv/config';
export interface Config {
  production: boolean;
  live: boolean;
  sales: boolean;
  legacyReviewed: boolean;
  port: number;
  host: string;
  url: string;
  databaseUrl: string;
  dataDir: string;
  databaseSsl: boolean;
  databaseCa?: string;
  mpToken: string;
  mpSecret: string;
  sellerId: string;
  spreadsheetId: string;
  serviceEmail: string;
  serviceKey: string;
  googleId: string;
  googleSecret: string;
  team: string[];
}
export function config(env = process.env): Config {
  const c: Config = {
    production: env.NODE_ENV === 'production',
    live: env.INTEGRATION_MODE === 'live',
    sales: env.SALES_ENABLED === 'true',
    legacyReviewed: env.LEGACY_REVIEW_COMPLETE === 'true',
    port: Number(env.PORT || 3015),
    host: env.HOST || '127.0.0.1',
    url: env.APP_URL || 'http://localhost:3015',
    databaseUrl: env.DATABASE_URL || '',
    dataDir: env.LOCAL_DATA_DIR || '.local/postgres',
    databaseSsl: env.DATABASE_SSL === 'true',
    databaseCa: env.DATABASE_CA?.replace(/\\n/g, '\n'),
    mpToken: env.MP_ACCESS_TOKEN || '',
    mpSecret: env.MP_WEBHOOK_SECRET || '',
    sellerId: env.MP_SELLER_ID || '',
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID || '1wQVEsOTbFgtBpOJD6-rbgrbep3A28oYd7VYQxDhaMAU',
    serviceEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
    serviceKey: (env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    googleId: env.GOOGLE_CLIENT_ID || '',
    googleSecret: env.GOOGLE_CLIENT_SECRET || '',
    team: (env.TEAM_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
  if (!['local', 'live', undefined].includes(env.INTEGRATION_MODE))
    throw new Error('INTEGRATION_MODE inválido.');
  if (c.production && (!c.databaseUrl || !c.live || !c.url.startsWith('https://')))
    throw new Error('Produção exige PostgreSQL, INTEGRATION_MODE=live e APP_URL HTTPS.');
  if (
    c.live &&
    [
      c.mpToken,
      c.mpSecret,
      c.sellerId,
      c.serviceEmail,
      c.serviceKey,
      c.googleId,
      c.googleSecret,
      c.team.join(''),
    ].some((s) => !s)
  )
    throw new Error(
      'Integração real incompleta. Configure Mercado Pago, Google e equipe no ambiente seguro.',
    );
  if (c.live && c.sales && !c.legacyReviewed)
    throw new Error('Revise as reservas antigas antes de liberar vendas (LEGACY_REVIEW_COMPLETE).');
  return c;
}
