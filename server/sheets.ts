import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { GoogleAuth } from 'google-auth-library';
import type { Config } from './config.js';
import type { Database } from './db.js';
import type { OrderRow } from './service.js';
export interface SheetSink {
  sync(orderIds: string[]): Promise<void>;
}
export const TABS: Record<string, string[]> = {
  Hallel_Pedidos_v1: [
    'ID',
    'Código',
    'Nome',
    'Telefone',
    'CPF',
    'Status',
    'Total R$',
    'Criado em',
    'Atualizado em',
    'Aceite em',
    'Vencimento',
  ],
  Hallel_Itens_v1: ['ID', 'Pedido', 'Dia', 'Prato', 'Quantidade', 'Preço R$', 'Subtotal R$'],
  Hallel_Pagamentos_v1: [
    'ID',
    'Pedido',
    'Status do provedor',
    'Detalhe',
    'Valor pago R$',
    'Transações',
    'Atualizado em',
  ],
  Hallel_Retiradas_v1: ['ID', 'Pedido', 'Dia', 'Prato', 'Quantidade', 'Responsável', 'Horário'],
  Hallel_Historico_v1: ['ID', 'Recurso', 'Ação', 'Responsável', 'Horário'],
};
type SheetRecord = { tab: string; id: string; values: (string | number)[] };
const iso = (value: any) => (value ? new Date(value).toISOString() : '');
// RAW impede que nomes começando por = sejam interpretados como fórmulas.
export async function snapshot(db: Database, ids: string[]): Promise<SheetRecord[]> {
  const orders = (await db.query<OrderRow>('SELECT * FROM orders WHERE id=ANY($1::text[])', [ids]))
    .rows;
  const deliveries = (
    await db.query('SELECT * FROM deliveries WHERE order_id=ANY($1::text[])', [ids])
  ).rows;
  const auditIds = [...ids, ...deliveries.map((d) => d.id)];
  const audits = (await db.query('SELECT * FROM audit WHERE resource=ANY($1::text[])', [auditIds]))
    .rows;
  const rows: SheetRecord[] = [];
  const add = (tab: string, id: string, values: any[]) =>
    rows.push({ tab, id, values: [id, ...values] });
  for (const o of orders) {
    add('Hallel_Pedidos_v1', o.id, [
      o.code || '',
      o.customer.name,
      o.customer.phone,
      o.customer.cpf,
      o.status,
      o.total / 100,
      iso(o.created_at),
      iso(o.updated_at),
      o.customer.acceptedAt,
      iso(o.expires_at),
    ]);
    for (const i of o.items)
      add('Hallel_Itens_v1', `${o.id}:${i.id}`, [
        o.id,
        i.day,
        i.name,
        i.quantity,
        i.cents / 100,
        (i.cents * i.quantity) / 100,
      ]);
    if (o.provider_id)
      add('Hallel_Pagamentos_v1', o.provider_id, [
        o.id,
        o.payment.status || 'created',
        o.payment.detail || '',
        Math.max(0, o.payment.paidCents || 0) / 100,
        JSON.stringify(o.payment.methods || []),
        o.payment.updatedAt || '',
      ]);
  }
  for (const d of deliveries)
    add('Hallel_Retiradas_v1', d.id, [
      d.order_id,
      d.day,
      d.item_id,
      d.quantity,
      d.actor,
      iso(d.created_at),
    ]);
  for (const a of audits)
    add('Hallel_Historico_v1', String(a.id), [a.resource, a.action, a.actor, iso(a.created_at)]);
  return rows;
}
export class LocalSheets implements SheetSink {
  records = new Map<string, SheetRecord>();
  private initialized = false;
  constructor(
    private db: Database,
    private dir?: string,
  ) {}
  async sync(ids: string[]) {
    if (this.dir && !this.initialized) {
      ids = (await this.db.query<{ id: string }>('SELECT id FROM orders')).rows.map((o) => o.id);
      this.initialized = true;
    }
    for (const row of await snapshot(this.db, ids)) this.records.set(`${row.tab}:${row.id}`, row);
    if (this.dir) {
      await mkdir(this.dir, { recursive: true });
      const file = `${this.dir}/planilha-local.json`;
      await writeFile(
        file + '.tmp',
        JSON.stringify(
          {
            aviso: 'SIMULAÇÃO LOCAL — não foi enviada ao Google',
            rows: [...this.records.values()],
          },
          null,
          2,
        ),
      );
      await rename(file + '.tmp', file);
    }
  }
}
export interface SheetsTransport {
  metadata(): Promise<string[]>;
  addTabs(names: string[]): Promise<void>;
  read(ranges: string[]): Promise<any[][][]>;
  write(data: { range: string; values: any[][] }[]): Promise<void>;
}
export function sheetsTransport(cfg: Config): SheetsTransport {
  const auth = new GoogleAuth({
    credentials: { client_email: cfg.serviceEmail, private_key: cfg.serviceKey },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const root = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cfg.spreadsheetId)}`;
  async function request<T>(url: string, data?: unknown): Promise<T> {
    const client = await auth.getClient();
    const r = await client.request<T>({
      url,
      method: data ? 'POST' : 'GET',
      data,
      timeout: 15_000,
      retry: false,
    });
    return r.data;
  }
  return {
    async metadata() {
      const r = await request<any>(root + '?fields=sheets.properties.title');
      return r.sheets.map((s: any) => s.properties.title);
    },
    async addTabs(names) {
      if (names.length)
        await request(root + ':batchUpdate', {
          requests: names.map((title) => ({ addSheet: { properties: { title } } })),
        });
    },
    async read(ranges) {
      // POST evita URLs longas quando um lote contém muitos identificadores.
      const r = await request<any>(root + '/values:batchGetByDataFilter', {
        dataFilters: ranges.map((a1Range) => ({ a1Range })),
        valueRenderOption: 'UNFORMATTED_VALUE',
      });
      const byRange = new Map<string, any[][]>();
      for (const match of r.valueRanges || []) {
        for (const filter of match.dataFilters || [])
          if (filter.a1Range) byRange.set(filter.a1Range, match.valueRange?.values || []);
      }
      return ranges.map((range) => byRange.get(range) || []);
    },
    async write(data) {
      if (data.length)
        await request(root + '/values:batchUpdate', { valueInputOption: 'RAW', data });
    },
  };
}
export class GoogleSheets implements SheetSink {
  private initialized = false;
  constructor(
    private db: Database,
    private transport: SheetsTransport,
  ) {}
  async sync(ids: string[]) {
    const holder = randomUUID();
    const lease = await this.db.query(
      `INSERT INTO leases(name,holder,expires_at) VALUES('sheets',$1,now()+interval '5 minutes')
      ON CONFLICT(name) DO UPDATE SET holder=$1,expires_at=now()+interval '5 minutes' WHERE leases.expires_at<now() RETURNING holder`,
      [holder],
    );
    if (!lease.rows.length) throw new Error('Outro sincronizador está trabalhando.');
    try {
      if (!this.initialized) {
        const existing = await this.transport.metadata();
        await this.transport.addTabs(Object.keys(TABS).filter((t) => !existing.includes(t)));
        const headers = await this.transport.read(Object.keys(TABS).map((t) => `'${t}'!1:1`));
        const writes = [];
        for (const [index, [tab, columns]] of Object.entries(TABS).entries()) {
          const actual = headers[index]?.[0];
          if (actual?.length && JSON.stringify(actual) !== JSON.stringify(columns))
            throw new Error('Cabeçalho existente divergente. Revisão necessária.');
          if (!actual?.length) writes.push({ range: `'${tab}'!A1`, values: [columns] });
        }
        await this.transport.write(writes);
        this.initialized = true;
      }
      const records = await snapshot(this.db, ids);
      // As posições são confirmadas no banco ANTES da chamada ao Google.
      // Um timeout após gravação não aloca outra linha na nova tentativa.
      const positions = await this.db.tx(async (tx) => {
        const positions: { record: SheetRecord; row: number }[] = [];
        for (const record of records) {
          const entity = `${record.tab}:${record.id}`;
          let row = (await tx.query('SELECT row_number FROM sheet_rows WHERE entity=$1', [entity]))
            .rows[0]?.row_number;
          if (!row) {
            await tx.query('INSERT INTO sheet_sequences(tab) VALUES($1) ON CONFLICT DO NOTHING', [
              record.tab,
            ]);
            row = (
              await tx.query(
                'UPDATE sheet_sequences SET next_row=next_row+1 WHERE tab=$1 RETURNING next_row-1 AS n',
                [record.tab],
              )
            ).rows[0].n;
            await tx.query('INSERT INTO sheet_rows(entity,tab,row_number) VALUES($1,$2,$3)', [
              entity,
              record.tab,
              row,
            ]);
          }
          positions.push({ record, row });
        }
        return positions;
      });
      if (!positions.length) return;
      const remote = await this.transport.read(positions.map((p) => `'${p.record.tab}'!A${p.row}`));
      for (let i = 0; i < positions.length; i++) {
        const found = remote[i]?.[0]?.[0];
        if (found !== undefined && found !== '' && String(found) !== positions[i].record.id)
          throw new Error(
            'Linha movida na planilha. Sincronização suspensa para preservar os dados.',
          );
      }
      await this.transport.write(
        positions.map((p) => ({ range: `'${p.record.tab}'!A${p.row}`, values: [p.record.values] })),
      );
    } finally {
      await this.db.query('DELETE FROM leases WHERE name=$1 AND holder=$2', ['sheets', holder]);
    }
  }
}
