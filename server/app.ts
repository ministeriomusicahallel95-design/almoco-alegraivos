import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import QRCode from 'qrcode';
import { z, ZodError } from 'zod';
import { readSite, saveSite, SettingsConflict } from './site-settings.js';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { LocalPayments, mercadoPago, validSignature, type Payments } from './payment.js';
import { GoogleSheets, LocalSheets, sheetsTransport, type SheetSink } from './sheets.js';
import { Orders, Problem, hash, enqueue } from './service.js';
import { Worker } from './worker.js';

export async function createApp(
  cfg: Config,
  db: Database,
  options: {
    payments?: Payments;
    sheets?: SheetSink;
    frontend?: boolean;
    rateLimit?: boolean;
  } = {},
) {
  const app = Fastify({
    bodyLimit: 32_768,
    logger: false,
    trustProxy: cfg.production ? (_address, hop) => hop === 0 : false,
  });
  const payments = options.payments || (cfg.live ? mercadoPago(cfg) : new LocalPayments());
  const sheets =
    options.sheets ||
    (cfg.live ? new GoogleSheets(db, sheetsTransport(cfg)) : new LocalSheets(db, '.local'));
  const orders = new Orders(db, cfg, payments);
  const worker = new Worker(orders, sheets, (message) => app.log.warn(message));
  await app.register(cookie);
  if (options.rateLimit !== false)
    await app.register(rateLimit, { max: 1500, timeWindow: '1 minute' });
  app.addHook('onRequest', async (req, reply) => {
    const headers = {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': `default-src 'self'; script-src 'self'${cfg.production ? '' : " 'unsafe-inline'"}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'${cfg.production ? '' : ' ws: http://localhost:*'}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
    };
    for (const [k, v] of Object.entries(headers)) {
      reply.header(k, v);
      reply.raw.setHeader(k, v);
    }
    if (req.url.startsWith('/api/') || req.url.startsWith('/auth/'))
      reply.header('Cache-Control', 'no-store');
    if (
      ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) &&
      !req.url.startsWith('/api/webhooks/')
    ) {
      if (req.headers.origin !== new URL(cfg.url).origin)
        throw new Problem(403, 'Origem da solicitação não autorizada.');
    }
  });
  app.setErrorHandler((error: any, _request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({ error: error.issues[0]?.message || 'Confira os campos.' });
    if (error instanceof Problem) return reply.code(error.status).send({ error: error.message });
    if (error.statusCode && error.statusCode < 500)
      return reply.code(error.statusCode).send({
        error:
          error.statusCode === 429
            ? 'Muitas tentativas. Aguarde um minuto.'
            : 'Solicitação inválida.',
      });
    return reply.code(503).send({
      error: 'Não foi possível concluir agora. Seu pedido permanece registrado; tente novamente.',
    });
  });
  const secure = cfg.url.startsWith('https://');
  const cookieOptions = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };
  async function session(req: FastifyRequest) {
    const token = req.cookies.hallel_session;
    const s = token
      ? (await db.query('SELECT * FROM sessions WHERE hash=$1 AND expires_at>now()', [hash(token)]))
          .rows[0]
      : null;
    if (!s || (cfg.live && !cfg.team.includes(s.email)))
      throw new Problem(401, 'Entre com uma conta autorizada da equipe.');
    return s as { email: string; csrf: string };
  }
  async function protectedSession(req: FastifyRequest) {
    const s = await session(req);
    if (req.headers['x-csrf-token'] !== s.csrf)
      throw new Problem(403, 'Atualize o painel para continuar.');
    return s;
  }
  async function login(email: string, reply: FastifyReply) {
    const token = randomBytes(32).toString('hex');
    await db.query('INSERT INTO sessions(hash,email,csrf,expires_at) VALUES($1,$2,$3,$4)', [
      hash(token),
      email,
      randomBytes(32).toString('hex'),
      new Date(Date.now() + 12 * 3600_000),
    ]);
    reply.setCookie('hallel_session', token, { ...cookieOptions, maxAge: 12 * 3600 });
  }
  const tokenFor = (req: FastifyRequest) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (!token || !/^[a-f0-9]{64}$/.test(token))
      throw new Problem(401, 'Acesso privado ao pedido necessário.');
    return token;
  };
  app.get('/api/health', async () => {
    await db.query('SELECT 1');
    return { ok: true, mode: cfg.live ? 'integrado' : 'local', version: '1.0.0' };
  });
  app.get('/api/config', async () => {
    const site = await readSite(db);
    return {
      ...site,
      mode: cfg.live ? 'live' : 'local',
      salesOpen:
        site.menu.some((i) => i.enabled) &&
        (!cfg.live || (cfg.sales && Date.now() <= Date.parse(site.event.deadline))),
      teamUrl: '/equipe',
    };
  });
  app.post(
    '/api/pedidos',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => reply.code(201).send(await orders.create(req.body)),
  );
  app.get<{ Params: { id: string } }>('/api/pedidos/:id', async (req) =>
    orders.public(await orders.row(req.params.id, tokenFor(req))),
  );
  app.get<{ Params: { id: string } }>('/api/pedidos/:id/qr', async (req, reply) => {
    const row = await orders.row(req.params.id, tokenFor(req));
    if (row.status !== 'pendente' || !row.checkout_url)
      throw new Problem(409, 'A cobrança ainda não está disponível.');
    const link = new URL(row.checkout_url, cfg.url).toString();
    return reply
      .type('image/png')
      .send(await QRCode.toBuffer(link, { width: 320, margin: 2, errorCorrectionLevel: 'M' }));
  });
  app.post('/api/webhooks/mercadopago', { config: { rateLimit: false } }, async (req, reply) => {
    if (!cfg.live) throw new Problem(404, 'Notificações reais estão desativadas no modo local.');
    const query = req.query as any;
    const body = req.body as any;
    const id = String(query['data.id'] || query.data_id || '');
    const signature = String(req.headers['x-signature'] || '');
    const requestId = String(req.headers['x-request-id'] || '');
    if (
      !/^[a-zA-Z0-9-]{1,100}$/.test(id) ||
      !validSignature(id, requestId, signature, cfg.mpSecret) ||
      (body?.data?.id && String(body.data.id).toLowerCase() !== id.toLowerCase())
    )
      throw new Problem(401, 'Notificação inválida.');
    if (body?.type !== 'order' || (body.user_id && String(body.user_id) !== cfg.sellerId))
      throw new Problem(400, 'Tipo de notificação não aceito.');
    const eventId = `mp:${String(body.id || requestId).slice(0, 150)}`;
    await db.tx(async (tx) => {
      const created = await tx.query(
        'INSERT INTO payment_events(id,provider_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id',
        [eventId, id],
      );
      if (created.rows.length) await enqueue(tx, 'refresh', null, { providerId: id }, eventId);
    });
    return reply.code(200).send({ received: true });
  });
  if (!cfg.live && !cfg.production) {
    app.post<{ Params: { id: string } }>('/api/local/pedidos/:id/pagar', async (req) => {
      const row = await orders.row(req.params.id, tokenFor(req));
      const p = await payments.create(row);
      await orders.applyPayment({
        ...p,
        status: 'processed',
        status_detail: 'accredited',
        total_paid_amount: p.total_amount,
        last_updated_date: new Date().toISOString(),
        transactions: {
          payments: [
            {
              id: `TESTE-${row.id}`,
              status: 'processed',
              payment_method: { id: 'simulado', type: 'local' },
            },
          ],
        },
      });
      return orders.public(await orders.row(row.id));
    });
    app.post('/api/local/equipe/entrar', async (_req, reply) => {
      await login('equipe@teste.local', reply);
      return { ok: true };
    });
  }
  app.get('/auth/google', async (_req, reply) => {
    if (!cfg.live) throw new Problem(409, 'Use o acesso de demonstração local.');
    const oauth = new OAuth2Client(
      cfg.googleId,
      cfg.googleSecret,
      cfg.url + '/auth/google/callback',
    );
    const state = randomBytes(32).toString('hex');
    const nonce = randomBytes(32).toString('hex');
    const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
    await db.query('INSERT INTO oauth_states(hash,verifier,nonce,expires_at) VALUES($1,$2,$3,$4)', [
      hash(state),
      codeVerifier,
      nonce,
      new Date(Date.now() + 10 * 60_000),
    ]);
    reply.setCookie('hallel_oauth', state, { ...cookieOptions, maxAge: 600 });
    return reply.redirect(
      oauth.generateAuthUrl({
        scope: ['openid', 'email'],
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256' as any,
      }),
    );
  });
  app.get('/auth/google/callback', async (req, reply) => {
    if (!cfg.live) throw new Problem(404, 'Login externo desativado.');
    const q = z
      .object({ state: z.string().regex(/^[a-f0-9]{64}$/), code: z.string().min(1).max(4096) })
      .parse(req.query);
    if (req.cookies.hallel_oauth !== q.state)
      throw new Problem(403, 'Login expirado. Tente novamente.');
    const saved = (
      await db.query('DELETE FROM oauth_states WHERE hash=$1 AND expires_at>now() RETURNING *', [
        hash(q.state),
      ])
    ).rows[0];
    if (!saved) throw new Problem(403, 'Login expirado. Tente novamente.');
    const oauth = new OAuth2Client(
      cfg.googleId,
      cfg.googleSecret,
      cfg.url + '/auth/google/callback',
    );
    const { tokens } = await oauth.getToken({ code: q.code, codeVerifier: saved.verifier });
    if (!tokens.id_token) throw new Problem(401, 'Identificação Google não recebida.');
    const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: cfg.googleId });
    const payload = ticket.getPayload();
    const email = payload?.email?.toLowerCase();
    if (
      !email ||
      !payload?.email_verified ||
      payload.nonce !== saved.nonce ||
      !cfg.team.includes(email)
    )
      throw new Problem(403, 'Conta não autorizada pela organização.');
    await login(email, reply);
    reply.clearCookie('hallel_oauth', cookieOptions);
    return reply.redirect('/equipe');
  });
  app.get('/api/equipe/sessao', async (req) => {
    const s = await session(req);
    return { email: s.email, csrf: s.csrf, admin: !cfg.live || s.email === cfg.team[0] };
  });
  app.post('/api/equipe/sair', async (req, reply) => {
    await protectedSession(req);
    await db.query('DELETE FROM sessions WHERE hash=$1', [hash(req.cookies.hallel_session!)]);
    reply.clearCookie('hallel_session', cookieOptions);
    return { ok: true };
  });
  app.get('/api/equipe/resumo', async (req) => {
    await session(req);
    return orders.stats();
  });
  app.get('/api/equipe/pedidos', async (req) => {
    await session(req);
    const q = z
      .object({
        busca: z.string().max(150).default(''),
        status: z.string().max(30).optional(),
        dia: z.iso.date().optional(),
      })
      .parse(req.query);
    return orders.teamSearch(q.busca, q.status, q.dia);
  });
  app.post('/api/equipe/retiradas', async (req) => {
    const s = await protectedSession(req);
    return orders.delivery(req.body, s.email);
  });
  async function administrator(req: FastifyRequest, write = false) {
    const s = write ? await protectedSession(req) : await session(req);
    if (cfg.live && s.email !== cfg.team[0])
      throw new Problem(403, 'Configuração disponível para o administrador principal.');
    return s;
  }
  app.get('/api/equipe/site', async (req) => {
    await administrator(req);
    return readSite(db);
  });
  app.put('/api/equipe/site', { bodyLimit: 128_000 }, async (req) => {
    const s = await administrator(req, true);
    try {
      return await saveSite(db, req.body, s.email);
    } catch (e) {
      if (e instanceof SettingsConflict) throw new Problem(409, e.message);
      throw e;
    }
  });
  app.get('/api/equipe/integracoes', async (req) => {
    await administrator(req);
    const origin = new URL(cfg.url);
    const publicHttps =
      origin.protocol === 'https:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    return {
      mode: cfg.live ? 'live' : 'local',
      salesEnabled: cfg.sales,
      mercadoPago: {
        tokenConfigured: !!cfg.mpToken,
        sellerConfigured: !!cfg.sellerId,
        signatureConfigured: !!cfg.mpSecret,
        webhookUrl: publicHttps ? cfg.url + '/api/webhooks/mercadopago' : null,
      },
      google: {
        serviceAccountConfigured: !!cfg.serviceEmail && !!cfg.serviceKey,
        loginConfigured: !!cfg.googleId && !!cfg.googleSecret && cfg.team.length > 0,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(cfg.spreadsheetId)}/edit`,
      },
      hosting: {
        publicHttps,
        databaseConfigured: !!cfg.databaseUrl,
        legacyReviewed: cfg.legacyReviewed,
      },
    };
  });
  app.post('/api/equipe/integracoes/testar', async (req) => {
    await administrator(req, true);
    const result: {
      mercadoPago: { ok: boolean; message: string };
      google: { ok: boolean; message: string };
    } = {
      mercadoPago: { ok: false, message: 'Token ainda não configurado.' },
      google: {
        ok: false,
        message: 'Configure a conta de serviço e compartilhe a planilha com ela.',
      },
    };
    if (cfg.mpToken) {
      try {
        const r = await fetch('https://api.mercadopago.com/users/me', {
          headers: { Authorization: `Bearer ${cfg.mpToken}` },
          signal: AbortSignal.timeout(12000),
        });
        if (r.ok) {
          const account = (await r.json()) as { id: string | number };
          result.mercadoPago =
            cfg.sellerId && String(account.id) !== cfg.sellerId
              ? { ok: false, message: 'O recebedor configurado não corresponde ao token.' }
              : {
                  ok: true,
                  message:
                    'Autenticação e recebedor do Mercado Pago conferidos. Nenhuma cobrança foi criada.',
                };
        } else
          result.mercadoPago = {
            ok: false,
            message: `Mercado Pago recusou a autenticação (HTTP ${r.status}).`,
          };
      } catch {
        result.mercadoPago = {
          ok: false,
          message: 'Não foi possível alcançar o Mercado Pago. Tente novamente.',
        };
      }
    }
    if (cfg.serviceEmail && cfg.serviceKey) {
      try {
        await sheetsTransport(cfg).metadata();
        result.google = {
          ok: true,
          message:
            'Leitura autenticada da planilha confirmada. Este teste não alterou células; a gravação ainda precisa ser validada.',
        };
      } catch {
        result.google = {
          ok: false,
          message:
            'Não foi possível acessar a planilha. Confira a conta de serviço, permissões e conexão.',
        };
      }
    }
    return result;
  });
  app.get('/api/equipe/configuracao', async (req) => {
    await session(req);
    const link =
      (await db.query("SELECT value FROM settings WHERE key='paymentLinkDraft'")).rows[0]?.value ||
      '';
    return {
      paymentLinkDraft: link,
      active: false,
      qr: link ? await QRCode.toDataURL(link, { width: 256, margin: 2 }) : null,
    };
  });
  app.put('/api/equipe/configuracao', async (req) => {
    const s = await protectedSession(req);
    if (cfg.live && s.email !== cfg.team[0])
      throw new Problem(403, 'Configuração disponível para o responsável principal.');
    const input = z
      .object({ paymentLinkDraft: z.union([z.literal(''), z.url().max(1000)]) })
      .strict()
      .parse(req.body);
    if (input.paymentLinkDraft) {
      const url = new URL(input.paymentLinkDraft);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        !['mercadopago.com.br', 'www.mercadopago.com.br', 'mpago.la', 'mpago.li'].includes(
          url.hostname,
        )
      )
        throw new Problem(400, 'Informe um link HTTPS oficial do Mercado Pago.');
    }
    await db.tx(async (tx) => {
      await tx.query(
        "INSERT INTO settings(key,value) VALUES('paymentLinkDraft',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
        [JSON.stringify(input.paymentLinkDraft)],
      );
      await tx.query('INSERT INTO audit(actor,action,resource) VALUES($1,$2,$3)', [
        s.email,
        'configurar_link_rascunho',
        'paymentLinkDraft',
      ]);
    });
    return { ok: true, active: false };
  });
  if (options.frontend !== false) {
    if (cfg.production) {
      await app.register(staticFiles, {
        root: resolve('dist/client'),
        wildcard: false,
        cacheControl: true,
        maxAge: 3600_000,
      });
      app.setNotFoundHandler(async (req, reply) => {
        if (
          req.method === 'GET' &&
          /^\/(equipe|pagamento-local\/[^/]+)$/.test(req.url.split('?')[0])
        )
          return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
        return reply.code(404).send({ error: 'Endereço não encontrado.' });
      });
    } else {
      const { createServer } = await import('vite');
      const vite = await createServer({
        server: {
          middlewareMode: true,
          fs: {
            deny: [
              '.env',
              '.env.*',
              '*.{crt,pem}',
              '**/.git/**',
              '**/.local/**',
              '**/credentials*.json',
              '**/service-account*.json',
            ],
          },
        },
        appType: 'spa',
      });
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/') || req.url.startsWith('/auth/'))
          return reply.code(404).send({ error: 'Endereço não encontrado.' });
        reply.hijack();
        vite.middlewares(req.raw, reply.raw, () => {
          reply.raw.statusCode = 404;
          reply.raw.end('Endereço não encontrado.');
        });
      });
      app.addHook('onClose', async () => {
        await vite.close();
      });
    }
  }
  app.addHook('onClose', async () => {
    await worker.stop();
  });
  return { app, orders, worker, payments, sheets };
}
