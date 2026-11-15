import { randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import { enqueue, type Orders } from './service.js';
import type { SheetSink } from './sheets.js';
import { decimalCents } from './payment.js';
type Job = {
  id: string;
  kind: string;
  order_id: string;
  payload: any;
  attempts: number;
  claim_token: string;
};
export class Worker {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  constructor(
    private orders: Orders,
    private sheets: SheetSink,
    private log: (message: string) => void = () => {},
  ) {}
  get db(): Database {
    return this.orders.db;
  }
  async claim(kinds: string[], count = 1) {
    return (
      await this.db.query<Job>(
        `UPDATE jobs SET locked_until=now()+interval '5 minutes',claim_token=$2,attempts=attempts+1 WHERE id IN (
      SELECT id FROM jobs WHERE completed_at IS NULL AND available_at<=now() AND (locked_until IS NULL OR locked_until<now()) AND kind=ANY($1::text[])
      ORDER BY available_at,created_at LIMIT $3 FOR UPDATE SKIP LOCKED) RETURNING *`,
        [kinds, randomUUID(), count],
      )
    ).rows;
  }
  async finish(job: Job, nextMs?: number) {
    await this.db.query(
      `UPDATE jobs SET locked_until=NULL,claim_token=NULL,last_error=NULL,attempts=0,
      completed_at=CASE WHEN $3::integer IS NULL THEN now() ELSE NULL END,
      available_at=CASE WHEN $3::integer IS NULL THEN available_at ELSE now()+($3::integer * interval '1 millisecond') END
      WHERE id=$1 AND claim_token=$2`,
      [job.id, job.claim_token, nextMs ?? null],
    );
  }
  async fail(job: Job) {
    // Registra mensagem sanitizada. Respostas do provedor podem conter dados pessoais.
    await this.db.query(
      `UPDATE jobs SET locked_until=NULL,claim_token=NULL,last_error=$3,
      available_at=now()+($4::integer * interval '1 second') WHERE id=$1 AND claim_token=$2`,
      [
        job.id,
        job.claim_token,
        `Falha em ${job.kind}; tentativa ${job.attempts}. Consulte as credenciais e a conectividade.`,
        Math.min(3600, 2 ** Math.min(job.attempts, 11)),
      ],
    );
    this.log(`Tarefa ${job.kind} pendente de nova tentativa.`);
  }
  async paymentJob(job: Job) {
    try {
      if (job.kind === 'create') {
        const row = await this.orders.row(job.order_id);
        if (!row.provider_id && row.status === 'pendente') {
          if (new Date(row.expires_at).getTime() < Date.now()) {
            // Uma chamada anterior pode ter chegado ao provedor antes do timeout.
            // Nesse caso, não afirmar que expirou sem pagamento nem criar outra cobrança.
            await this.db.tx(async (tx) => {
              await tx.query(
                'UPDATE orders SET status=$2,review_reason=$3,updated_at=now() WHERE id=$1 AND provider_id IS NULL',
                [
                  row.id,
                  job.attempts > 1 ? 'em_revisao' : 'expirado',
                  job.attempts > 1 ? 'criacao_ambigua' : null,
                ],
              );
              await enqueue(tx, 'sheets', row.id);
            });
          } else {
            const p = await this.orders.payments.create(row);
            // Apenas URLs oficiais HTTPS; no modo local, somente o caminho do simulador.
            const url = p.checkout_url;
            const allowed = this.orders.cfg.live
              ? !!url && /^https:\/\/([a-z0-9-]+\.)?mercadopago\.com(\.br)?\//.test(url)
              : !!url && url.startsWith('/pagamento-local/');
            if (!allowed) throw new Error('URL de pagamento inválida.');
            if (
              p.external_reference !== row.id ||
              String(p.user_id) !== (this.orders.cfg.live ? this.orders.cfg.sellerId : 'local') ||
              p.currency !== 'BRL' ||
              decimalCents(p.total_amount) !== row.total
            )
              throw new Error('Cobrança divergente.');
            await this.db.tx(async (tx) => {
              await tx.query(
                'UPDATE orders SET provider_id=$2,checkout_url=$3,updated_at=now() WHERE id=$1',
                [row.id, p.id, url],
              );
              await enqueue(tx, 'refresh', row.id, { providerId: p.id }, `refresh:${row.id}`);
              await enqueue(tx, 'sheets', row.id);
            });
            await this.orders.applyPayment(p);
          }
        }
        await this.finish(job);
      } else {
        const providerId = job.payload.providerId;
        let p;
        if (!this.orders.cfg.live && job.order_id) {
          // O provedor local é reconstruído a partir do banco após reinícios.
          const row = await this.orders.row(job.order_id);
          if (row.status !== 'pendente') {
            await this.finish(job);
            return;
          }
          p = await this.orders.payments.create(row);
        } else p = await this.orders.payments.get(providerId);
        await this.orders.applyPayment(p);
        const row = await this.orders.row(p.external_reference);
        const recent = new Date(row.created_at).getTime() > Date.now() - 40 * 86400_000;
        // Continua consultando cobranças pendentes mesmo após vencimento local:
        // apenas o provedor determina se houve pagamento ou expiração.
        await this.finish(
          job,
          job.id.startsWith('refresh:') && recent
            ? row.status === 'pendente'
              ? 60_000
              : 6 * 3600_000
            : undefined,
        );
      }
    } catch {
      await this.fail(job);
    }
  }
  async once() {
    const jobs = await this.claim(['create', 'refresh'], 8);
    await Promise.all(jobs.map((j) => this.paymentJob(j)));
    const sheets = await this.claim(['sheets'], 100);
    if (sheets.length) {
      try {
        await this.sheets.sync([...new Set(sheets.map((j) => j.order_id))]);
        await Promise.all(sheets.map((j) => this.finish(j)));
      } catch {
        await Promise.all(sheets.map((j) => this.fail(j)));
      }
    }
  }
  start() {
    const run = () => {
      if (!this.active)
        this.active = this.once()
          .catch(() => this.log('Fila aguardando recuperação.'))
          .finally(() => {
            this.active = undefined;
          });
    };
    run();
    this.timer = setInterval(run, 2000);
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
