import { useEffect, useState, type FormEvent } from 'react';
import { CalendarDays, Plus, Save, Trash2, UtensilsCrossed } from 'lucide-react';
import { api } from './api';
import { dateLabel, type EventSettings } from '../shared/site-settings';
import type { PublicSite } from './SiteContext';

const localDeadline = (s: string) =>
  s ? new Date(Date.parse(s) - 4 * 3600_000).toISOString().slice(0, 16) : '';
export function SiteSettingsEditor({
  admin,
  csrf,
  onSaved,
}: {
  admin: boolean;
  csrf: string;
  onSaved: () => Promise<void>;
}) {
  const [site, setSite] = useState<PublicSite>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const load = () =>
    api<PublicSite>('/api/equipe/site')
      .then(setSite)
      .catch((e) => setError(e.message));
  useEffect(() => {
    if (admin) void load();
  }, [admin]);
  if (!admin)
    return (
      <section className="panel settings">
        <h2>Configurações do site</h2>
        <p>Somente o administrador principal pode editar o evento e o cardápio.</p>
      </section>
    );
  if (!site)
    return (
      <section className="panel settings">
        <p>{error || 'Carregando as configurações do evento…'}</p>
        <button className="button ghost" onClick={() => void load()}>
          Carregar configurações
        </button>
      </section>
    );
  const event = site.event;
  const update = (key: keyof EventSettings, value: string) => {
    setMessage('');
    setSite((s) => (s ? { ...s, event: { ...s.event, [key]: value } } : s));
  };
  const field = (
    label: string,
    key: keyof EventSettings,
    options: { type?: string; help?: string; rows?: number; optional?: boolean } = {},
  ) => (
    <label>
      {label}
      {options.rows ? (
        <textarea
          value={event[key]}
          rows={options.rows}
          maxLength={key === 'notes' ? 3000 : key === 'warning' ? 1500 : 1000}
          onChange={(e) => update(key, e.target.value)}
          disabled={busy}
          required={!options.optional}
        />
      ) : (
        <input
          type={options.type || 'text'}
          value={event[key]}
          onChange={(e) => update(key, e.target.value)}
          disabled={busy}
          required={!options.optional}
          maxLength={1000}
        />
      )}{' '}
      {options.help && <small>{options.help}</small>}
    </label>
  );
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!site) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const { revision, ...data } = site;
      const result = await api<PublicSite>('/api/equipe/site', {
        method: 'PUT',
        csrf,
        body: { revision, site: data },
      });
      setSite(result);
      await onSaved();
      setMessage(
        'Configurações salvas. O site já usa os novos dados; pedidos anteriores foram preservados.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel settings site-editor">
      <p className="eyebrow blue">ADMINISTRADOR DO SITE</p>
      <h2>Evento e cardápio</h2>
      <p>
        Edite as informações exibidas no site e as opções disponíveis para novas reservas. Os
        pedidos já registrados mantêm seus pratos, valores, datas e condições.
      </p>
      <form onSubmit={save}>
        <fieldset disabled={busy}>
          <legend>
            <CalendarDays size={18} /> Dados do evento
          </legend>
          {field('Nome do evento', 'name')}
          <div className="field-row">
            {field('Data de início', 'startDate', { type: 'date' })}
            {field('Data de encerramento', 'endDate', { type: 'date' })}
          </div>
          <label>
            Reservas até (horário de Manaus)
            <input
              type="datetime-local"
              value={localDeadline(event.deadline)}
              onChange={(e) =>
                update(
                  'deadline',
                  e.target.value ? new Date(e.target.value + ':00-04:00').toISOString() : '',
                )
              }
              required
            />
            <small>Depois deste horário, novas vendas reais ficam encerradas.</small>
          </label>
          <div className="field-row">
            {field('Local do evento', 'location')}
            {field('Cidade / estado', 'city')}
          </div>
          <div className="field-row">
            {field('Ponto de retirada', 'pickup')}
            {field('Horário da retirada', 'hours')}
          </div>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>
            <UtensilsCrossed size={18} /> Pratos disponíveis
          </legend>
          <p className="small-text muted">
            Defina a data de cada prato dentro do período do evento. Desative uma opção para
            retirá-la das novas reservas.
          </p>
          <div className="editor-menu">
            {site.menu.map((item, index) => (
              <article className="editor-meal" key={item.id}>
                <div className="editor-meal-heading">
                  <strong>Prato {index + 1}</strong>
                  <button
                    type="button"
                    className="text-button danger"
                    aria-label={`Remover ${item.name || 'prato ' + (index + 1)}`}
                    disabled={site.menu.length === 1}
                    onClick={() => {
                      setSite((s) =>
                        s ? { ...s, menu: s.menu.filter((i) => i.id !== item.id) } : s,
                      );
                      setMessage('');
                    }}
                  >
                    <Trash2 size={16} /> Remover
                  </button>
                </div>
                <label>
                  Nome do prato
                  <input
                    value={item.name}
                    maxLength={120}
                    required
                    onChange={(e) =>
                      setSite((s) =>
                        s
                          ? {
                              ...s,
                              menu: s.menu.map((i) =>
                                i.id === item.id ? { ...i, name: e.target.value } : i,
                              ),
                            }
                          : s,
                      )
                    }
                  />
                </label>
                <div className="field-row">
                  <label>
                    Dia de retirada
                    <input
                      type="date"
                      min={event.startDate}
                      max={event.endDate}
                      value={item.day}
                      required
                      onChange={(e) =>
                        setSite((s) =>
                          s
                            ? {
                                ...s,
                                menu: s.menu.map((i) =>
                                  i.id === item.id ? { ...i, day: e.target.value } : i,
                                ),
                              }
                            : s,
                        )
                      }
                    />
                  </label>
                  <label>
                    Preço por refeição (R$)
                    <input
                      type="number"
                      min="0.01"
                      max="10000"
                      step="0.01"
                      required
                      value={item.cents ? item.cents / 100 : ''}
                      onChange={(e) =>
                        setSite((s) =>
                          s
                            ? {
                                ...s,
                                menu: s.menu.map((i) =>
                                  i.id === item.id
                                    ? {
                                        ...i,
                                        cents: Math.round(
                                          Number(e.target.value.replace(',', '.')) * 100,
                                        ),
                                      }
                                    : i,
                                ),
                              }
                            : s,
                        )
                      }
                    />
                  </label>
                </div>
                <label>
                  Descrição / observação do prato
                  <textarea
                    rows={2}
                    value={item.description}
                    maxLength={500}
                    onChange={(e) =>
                      setSite((s) =>
                        s
                          ? {
                              ...s,
                              menu: s.menu.map((i) =>
                                i.id === item.id ? { ...i, description: e.target.value } : i,
                              ),
                            }
                          : s,
                      )
                    }
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={item.enabled}
                    onChange={(e) =>
                      setSite((s) =>
                        s
                          ? {
                              ...s,
                              menu: s.menu.map((i) =>
                                i.id === item.id ? { ...i, enabled: e.target.checked } : i,
                              ),
                            }
                          : s,
                      )
                    }
                  />
                  <span>Disponível para novas reservas</span>
                </label>
              </article>
            ))}
          </div>
          <button
            type="button"
            className="button ghost"
            disabled={site.menu.length >= 40}
            onClick={() =>
              setSite((s) => {
                if (!s) return s;
                const day = s.menu.find((i) => i.enabled)?.day || s.event.startDate;
                return {
                  ...s,
                  menu: [
                    ...s.menu,
                    {
                      id: 'prato-' + crypto.randomUUID(),
                      day,
                      label: dateLabel(day),
                      name: '',
                      cents: 2500,
                      description: '',
                      enabled: true,
                    },
                  ],
                };
              })
            }
          >
            <Plus size={17} /> Adicionar prato
          </button>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>Textos e observações</legend>
          {field('Mensagem de abertura', 'heroMessage', { rows: 3 })}
          {field('Acompanhamentos incluídos', 'accompaniment', { rows: 3 })}
          {field('Observações adicionais', 'notes', {
            rows: 4,
            optional: true,
            help: 'Aparecem em destaque antes do cardápio. Use para avisos, orientações e informações sobre as refeições.',
          })}
          {field('Condições de retirada / ciência do cliente', 'warning', {
            rows: 4,
            help: 'O cliente precisa confirmar a ciência desse texto. Pedidos antigos preservam a versão aceita.',
          })}
        </fieldset>
        <fieldset disabled={busy}>
          <legend>Organização e contatos</legend>
          {field('Nome da organização', 'organization')}
          <div className="field-row">
            {field('WhatsApp (55 + DDD + número)', 'whatsapp', { type: 'tel' })}
            {field('Instagram (sem @)', 'instagram')}
          </div>
          {field('Link “Conheça o evento”', 'website', {
            type: 'url',
            help: 'Endereço HTTPS do site oficial do evento.',
          })}
        </fieldset>
        {error && (
          <div className="alert" role="alert">
            {error}
            <button type="button" className="text-button" onClick={() => void load()}>
              Recarregar dados salvos
            </button>
          </div>
        )}
        {message && (
          <div className="alert success" role="status">
            {message}
          </div>
        )}
        <div className="editor-save">
          <button className="button" disabled={busy}>
            <Save size={17} />
            {busy ? 'Salvando…' : 'Salvar evento e cardápio'}
          </button>
          <span>As alterações entram em uso após salvar.</span>
        </div>
      </form>
    </section>
  );
}
