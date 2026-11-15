import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  LoaderCircle,
  LogOut,
  MapPin,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Ticket,
  TriangleAlert,
  UtensilsCrossed,
} from 'lucide-react';
import { STATUS_LABELS, money, validCpf, type PublicOrder, type Status } from '../shared/domain';
import { api, ApiError, newAccess, saved, saveAccess, type Access } from './api';
import { DEFAULT_SITE, dateLabel, eventDatesLabel, mealDatesLabel } from '../shared/site-settings';
import { SiteContext, useSite, type PublicSite } from './SiteContext';
import { SiteSettingsEditor } from './SiteSettingsEditor';
import { IntegrationSettings } from './IntegrationSettings';
type Config = PublicSite & { mode: 'local' | 'live'; salesOpen: boolean; teamUrl: string };
const wa = (phone: string, message: string) =>
  `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
const shortDate = (s: string) =>
  new Date(s).toLocaleString('pt-BR', {
    timeZone: 'America/Manaus',
    dateStyle: 'short',
    timeStyle: 'short',
  });
function Alert({ children, success = false }: { children: ReactNode; success?: boolean }) {
  return (
    <div className={`alert ${success ? 'success' : ''}`} role={success ? 'status' : 'alert'}>
      {success ? <CheckCircle2 size={18} /> : <TriangleAlert size={18} />}
      <span>{children}</span>
    </div>
  );
}
function Spinner() {
  return <LoaderCircle size={18} className="spin" />;
}
export function App() {
  const [cfg, setCfg] = useState<Config>();
  const [error, setError] = useState('');
  const reloadConfig = async () => {
    const next = await api<Config>('/api/config');
    setCfg((previous) => (previous && previous.revision > next.revision ? previous : next));
  };
  const load = () => {
    setError('');
    reloadConfig().catch((e) => setError(e.message));
  };
  useEffect(load, []);
  useEffect(() => {
    const refresh = () => {
      void reloadConfig().catch(() => {});
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  useEffect(() => {
    if (cfg) document.title = `Reserve seu almoço — ${cfg.event.name}`;
  }, [cfg?.event.name]);
  const { event: EVENT } = cfg || DEFAULT_SITE;
  const team = location.pathname.startsWith('/equipe');
  return (
    <SiteContext.Provider
      value={{ site: cfg || { revision: 0, ...DEFAULT_SITE }, reload: reloadConfig }}
    >
      <>
        <a className="skip" href="#principal">
          Ir para o conteúdo
        </a>
        {cfg?.mode === 'local' && (
          <div className="local-banner">
            <ShieldCheck size={15} />
            <span>Demonstração local · pagamentos simulados · nenhum dado enviado ao Google</span>
          </div>
        )}
        <header className="header">
          <div className="container header-inner">
            <a href="/" aria-label="Alegrai-vos, início">
              <img className="brand" src="/logo.png" alt="Alegrai-vos" />
            </a>
            <nav>
              <a href={team ? '/' : '#como-funciona'}>
                {team ? 'Voltar ao site' : 'Como funciona'}
              </a>
              <a className="button small" href={team ? '#principal' : '#reservar'}>
                {team ? (
                  'Painel da equipe'
                ) : (
                  <>
                    Reservar almoço <ArrowUpRight size={16} />
                  </>
                )}
              </a>
            </nav>
          </div>
        </header>
        <main id="principal">
          {!cfg ? (
            <div className="container loading">
              {error ? (
                <>
                  <Alert>{error}</Alert>
                  <button className="button" onClick={load}>
                    Tentar novamente
                  </button>
                </>
              ) : (
                <>
                  <Spinner /> Preparando sua reserva…
                </>
              )}
            </div>
          ) : team ? (
            <Team cfg={cfg} />
          ) : (
            <Customer cfg={cfg} />
          )}
        </main>
        <footer className="footer">
          <div className="container footer-inner">
            <div>
              <img src="/logo.png" alt="Alegrai-vos" />
              <p>
                Um encontro. Uma comunidade.
                <br />
                Uma mesa preparada para você.
              </p>
            </div>
            <div>
              <a className="event-cta" href={EVENT.website} target="_blank" rel="noreferrer">
                Conheça o evento <ArrowUpRight size={15} />
              </a>
              <a href={`https://instagram.com/${EVENT.instagram}`} target="_blank" rel="noreferrer">
                @{EVENT.instagram}
              </a>
              <a href="/equipe">Acesso da equipe</a>
            </div>
          </div>
          <div className="container footer-bottom">
            {eventDatesLabel(EVENT)} · {EVENT.city}
            <span>{EVENT.organization}</span>
          </div>
        </footer>
      </>
    </SiteContext.Provider>
  );
}
function Customer({ cfg }: { cfg: Config }) {
  const { site } = useSite();
  const { event: EVENT } = site;
  const MENU = site.menu.filter((i) => i.enabled);
  const [access, setAccess] = useState<Access | null>(() => saved()[0] || null);
  const [order, setOrder] = useState<PublicOrder>();
  const [recovering, setRecovering] = useState(!!access);
  const [problem, setProblem] = useState('');
  const [history, setHistory] = useState(saved);
  const [legacy, setLegacy] = useState('');
  useEffect(() => {
    try {
      setLegacy(
        JSON.parse(localStorage.getItem('alegraivos-almoco-reserva-pix') || 'null')?.codigo || '',
      );
    } catch {}
  }, []);
  async function refresh(a = access) {
    if (!a) return;
    try {
      setOrder(await api(`/api/pedidos/${a.id}`, { token: a.token }));
      setProblem('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setAccess(null);
        setOrder(undefined);
      } else setProblem((e as Error).message);
    } finally {
      setRecovering(false);
    }
  }
  useEffect(() => {
    if (access) {
      setRecovering(true);
      void refresh(access);
    }
  }, [access?.id]);
  useEffect(() => {
    if (!access || order?.status !== 'pendente') return;
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10_000);
    return () => clearInterval(timer);
  }, [access?.id, order?.status]);
  const accept = (a: Access, o: PublicOrder) => {
    saveAccess(a);
    setHistory(saved());
    setOrder(o);
    setAccess(a);
  };
  const newOrder = () => {
    setAccess(null);
    setOrder(undefined);
    setProblem('');
    setRecovering(false);
  };
  return (
    <>
      <section className="hero">
        <div className="hero-photo" />
        <div className="container hero-inner">
          <div className="eyebrow">
            <span className="dot" /> {EVENT.name.toUpperCase()} · ALIMENTAÇÃO
          </div>
          <h1>
            Reserve seu
            <br />
            <span>almoço.</span>
          </h1>
          <p className="hero-lead">{EVENT.heroMessage}</p>
          <div className="hero-facts">
            <div>
              <CalendarDays />
              <span>
                <strong>{mealDatesLabel(MENU)}</strong>
                {[...new Set(MENU.map((i) => dateLabel(i.day, { weekday: 'long' })))].join(' e ')}
              </span>
            </div>
            <div>
              <MapPin />
              <span>
                <strong>{EVENT.location}</strong>
                {EVENT.city}
              </span>
            </div>
          </div>
          <a className="button" href="#reservar">
            Fazer minha reserva <ArrowRight size={18} />
          </a>
          <p className="hero-note">
            <ShieldCheck size={14} /> Confirmação após o pagamento
          </p>
          <div className="hero-stamp">
            <span>
              {new Set(MENU.map((i) => i.cents)).size > 1 ? 'A PARTIR DE' : 'ALMOÇO COMPLETO'}
            </span>
            <strong>
              {money(MENU.length ? Math.min(...MENU.map((i) => i.cents)) : 0).slice(0, -3)}
              <span>
                {money(MENU.length ? Math.min(...MENU.map((i) => i.cents)) : 0).slice(-3)}
              </span>
            </strong>
            <small>por refeição · por pessoa</small>
          </div>
        </div>
      </section>
      <section id="como-funciona" className="steps" aria-labelledby="steps-title">
        <div className="steps-layout">
          <h2 className="steps-title" id="steps-title">
            Como funciona <span>em 3 passos</span>
          </h2>
          <div className="steps-grid">
            {[
              [
                '01',
                'Escolha seu prato',
                'Selecione os dias e as quantidades para você e sua família.',
              ],
              ['02', 'Faça o pagamento', 'Abra a cobrança no Mercado Pago ou leia o QR Code.'],
              [
                '03',
                'Guarde seu código',
                'Pagamento confirmado? Seu código estará pronto para a retirada.',
              ],
            ].map(([n, title, text]) => (
              <div className="step" key={n}>
                <span>{n}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section id="reservar" className="reservation container">
        <div className="section-heading">
          <div>
            <p className="eyebrow blue">FEITO PARA COMPARTILHAR</p>
            <h2>
              Seu almoço,
              <br />
              <span>do seu jeito.</span>
            </h2>
          </div>
          <p>
            Escolha seus pratos para cada dia.
            <br />
            Reservas até{' '}
            <strong>
              {new Date(EVENT.deadline).toLocaleDateString('pt-BR', {
                timeZone: 'America/Manaus',
                day: 'numeric',
                month: 'long',
              })}
              .
            </strong>
            <br />
            <span className="muted">Bebidas não incluídas.</span>
          </p>
        </div>
        {EVENT.notes && (
          <div className="event-notes">
            <p className="eyebrow blue">OBSERVAÇÕES DA ORGANIZAÇÃO</p>
            <p>{EVENT.notes}</p>
          </div>
        )}
        {legacy && (
          <Alert>
            Existe uma reserva da versão anterior neste aparelho: {legacy}. Guarde esse código.{' '}
            <a
              href={wa(EVENT.whatsapp, `Olá! Quero consultar minha reserva anterior: ${legacy}.`)}
              target="_blank"
              rel="noreferrer"
            >
              Consultar a organização
            </a>
            .
          </Alert>
        )}
        {problem && (
          <Alert>
            {problem}{' '}
            <button className="text-button" onClick={() => void refresh()}>
              Consultar novamente
            </button>
          </Alert>
        )}
        {recovering ? (
          <div className="panel loading">
            <Spinner /> Consultando seu pedido…
          </div>
        ) : order && access ? (
          <OrderView order={order} access={access} refresh={() => refresh()} onNew={newOrder} />
        ) : access && problem ? (
          <div className="panel">
            <h3>Vamos consultar seu pedido primeiro.</h3>
            <p>
              O acesso continua salvo neste aparelho. Aguarde a conexão para conferir o pagamento.
            </p>
            <button className="button" onClick={() => void refresh()}>
              Consultar pedido
            </button>
            <button className="text-button new-order" onClick={newOrder}>
              Montar outro pedido por minha escolha
            </button>
          </div>
        ) : (
          <ReserveForm cfg={cfg} onCreated={accept} />
        )}
        {history.length > 0 && (
          <details className="history">
            <summary>
              <Ticket size={17} /> Pedidos salvos neste aparelho ({history.length})
            </summary>
            <div>
              {history.map((a, i) => (
                <button
                  className="button ghost small"
                  key={a.id}
                  onClick={() => {
                    setOrder(undefined);
                    setRecovering(true);
                    setAccess(a);
                    void refresh(a);
                  }}
                >
                  Consultar pedido {history.length - i} <ArrowUpRight size={14} />
                </button>
              ))}
            </div>
          </details>
        )}
      </section>
      <section className="pickup-strip">
        <div className="container pickup-inner">
          <MapPin size={32} />
          <div>
            <p className="eyebrow blue">NOS ENCONTRAMOS AQUI</p>
            <h3>
              {EVENT.pickup} · {EVENT.location}
            </h3>
            <p>
              Nos dias do seu pedido, <strong>{EVENT.hours}.</strong> Apresente seu código de
              retirada.
            </p>
          </div>
          <Clock size={28} />
        </div>
      </section>
      <section className="container faq">
        <div>
          <p className="eyebrow blue">PODEMOS AJUDAR?</p>
          <h2>
            Antes de
            <br />
            <span>sentar à mesa.</span>
          </h2>
          <a
            className="text-link"
            href={wa(
              EVENT.whatsapp,
              'Olá! Tenho uma dúvida sobre a reserva de almoço do Alegrai-vos.',
            )}
            target="_blank"
            rel="noreferrer"
          >
            Fale com a organização <ArrowUpRight size={18} />
          </a>
        </div>
        <div>
          {[
            [
              'O que acompanha o almoço?',
              `Todos os pratos acompanham ${EVENT.accompaniment}. Bebidas não estão incluídas.`,
            ],
            [
              'Posso reservar para a minha família?',
              'Sim. Selecione a quantidade de cada prato e faça um pedido único. A entrega pode ser registrada por quantidade e por dia.',
            ],
            [
              'Quando recebo meu código?',
              'O código de retirada aparece nesta página depois que o Mercado Pago confirma o pagamento. Um pedido pendente ainda não garante o almoço.',
            ],
            [
              'Paguei e ainda está pendente. O que faço?',
              'Use “Atualizar pagamento” ou retorne pelo mesmo aparelho. Se continuar pendente, fale com a organização informando o número do pedido.',
            ],
            [
              'Por que preciso informar meu CPF?',
              'Para identificar o pedido e o pagamento. O CPF não aparece no comprovante nem em endereços públicos.',
            ],
            ['E se eu não retirar meu almoço?', EVENT.warning],
          ].map(([q, a]) => (
            <details key={q}>
              <summary>
                {q}
                <Plus size={18} />
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>
    </>
  );
}
function ReserveForm({
  cfg,
  onCreated,
}: {
  cfg: Config;
  onCreated: (a: Access, o: PublicOrder) => void;
}) {
  const { event: EVENT } = cfg;
  const MENU = cfg.menu.filter((i) => i.enabled);
  const { reload } = useSite();
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [cpf, setCpf] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const retry = useRef<Access>();
  const selected = MENU.filter((i) => quantities[i.id] > 0);
  const total = selected.reduce((sum, i) => sum + i.cents * quantities[i.id], 0);
  const count = selected.reduce((sum, i) => sum + quantities[i.id], 0);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!selected.length) return setError('Escolha pelo menos um prato.');
    if (!validCpf(cpf)) return setError('Confira seu CPF: ele precisa ter 11 dígitos válidos.');
    setBusy(true);
    const a = retry.current || newAccess();
    retry.current = a;
    saveAccess(a);
    try {
      if (retry.current) {
        try {
          const existing = await api<PublicOrder>(`/api/pedidos/${a.id}`, { token: a.token });
          onCreated(a, existing);
          return;
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 404) throw e;
        }
      }
      const order = await api<PublicOrder>('/api/pedidos', {
        method: 'POST',
        body: {
          requestId: a.id,
          accessToken: a.token,
          name,
          phone,
          cpf,
          accepted,
          catalogRevision: cfg.revision,
          items: selected.map((i) => ({ id: i.id, quantity: quantities[i.id] })),
        },
      });
      onCreated({ ...a, id: order.id }, order);
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status === 400) retry.current = undefined;
      if (e instanceof ApiError && e.status === 409) await reload().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="reserve-layout" onSubmit={submit}>
      <div>
        <div className="accompaniment">
          <UtensilsCrossed size={20} />
          <p>
            Todos os pratos acompanham <strong>{EVENT.accompaniment}.</strong>
          </p>
        </div>
        <div className="menu-days">
          {[...new Set(MENU.map((i) => i.day))].sort().map((day) => (
            <section className="day-card" key={day}>
              <div className="day-heading">
                <div className="date-tile">
                  <strong>{day.slice(-2)}</strong>
                  <span>{dateLabel(day, { month: 'short' }).replace('.', '').toUpperCase()}</span>
                </div>
                <div>
                  <p>{dateLabel(day, { weekday: 'long' }).toUpperCase()}</p>
                  <h3>Escolha seu prato</h3>
                </div>
              </div>
              {MENU.filter((i) => i.day === day).map((item) => (
                <div className={`meal ${quantities[item.id] ? 'selected' : ''}`} key={item.id}>
                  <div>
                    <span className="meal-type">ALMOÇO COMPLETO</span>
                    <h4>{item.name}</h4>
                    {item.description && <p className="meal-description">{item.description}</p>}
                    <strong>{money(item.cents)}</strong>
                  </div>
                  <div className="stepper">
                    <button
                      type="button"
                      disabled={!quantities[item.id] || busy}
                      aria-label={`Diminuir ${item.name} dia ${day.slice(-2)}`}
                      onClick={() =>
                        setQuantities((v) => ({
                          ...v,
                          [item.id]: Math.max(0, (v[item.id] || 0) - 1),
                        }))
                      }
                    >
                      <Minus size={16} />
                    </button>
                    <output
                      aria-label={`Quantidade de ${item.name} dia ${day.slice(-2)}`}
                      aria-live="polite"
                    >
                      {quantities[item.id] || 0}
                    </output>
                    <button
                      type="button"
                      disabled={quantities[item.id] >= 20 || busy}
                      aria-label={`Aumentar ${item.name} dia ${day.slice(-2)}`}
                      onClick={() =>
                        setQuantities((v) => ({
                          ...v,
                          [item.id]: Math.min(20, (v[item.id] || 0) + 1),
                        }))
                      }
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="form-card">
          <div className="card-title">
            <span className="number-circle">2</span>
            <div>
              <h3>Seus dados</h3>
              <p>Um único cadastro para todos os almoços do pedido.</p>
            </div>
          </div>
          <label>
            Nome completo
            <input
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Como você se chama?"
              required
              minLength={5}
              maxLength={150}
              autoComplete="name"
              disabled={busy}
            />
          </label>
          <div className="field-row">
            <label>
              WhatsApp com DDD
              <input
                name="phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(92) 99999-9999"
                required
                minLength={10}
                maxLength={20}
                inputMode="tel"
                autoComplete="tel"
                disabled={busy}
              />
            </label>
            <label>
              CPF
              <input
                name="cpf"
                value={cpf}
                onChange={(e) => setCpf(e.target.value)}
                placeholder="000.000.000-00"
                required
                maxLength={14}
                inputMode="numeric"
                disabled={busy}
              />
            </label>
          </div>
          <p className="privacy">
            <ShieldCheck size={15} /> Dados usados para identificar seu pedido e pagamento.
          </p>
        </div>
      </div>
      <aside className="summary-card">
        <div className="card-title">
          <Ticket size={22} />
          <h3>Sua reserva</h3>
          <span className="count">{count}</span>
        </div>
        <p className="muted small-text">Confira os pratos antes de continuar.</p>
        <div className="cart-lines">
          {selected.length ? (
            selected.map((i) => (
              <div key={i.id}>
                <span>
                  <strong>
                    {quantities[i.id]}× {i.name}
                  </strong>
                  <small>{i.label}</small>
                </span>
                <b>{money(i.cents * quantities[i.id])}</b>
              </div>
            ))
          ) : (
            <div className="empty-cart">
              <UtensilsCrossed size={30} />
              <p>
                Sua mesa começa aqui.
                <br />
                Escolha um prato ao lado.
              </p>
            </div>
          )}
        </div>
        <div className="total">
          <span>Total do pedido</span>
          <strong>{money(total)}</strong>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            required
            disabled={busy}
          />
          <span>Estou ciente de que: {EVENT.warning}</span>
        </label>
        {error && <Alert>{error}</Alert>}
        {!cfg.salesOpen && <Alert>Reservas encerradas. Fale com a organização.</Alert>}
        <button type="submit" className="button full" disabled={busy || !total || !cfg.salesOpen}>
          {busy ? (
            <>
              <Spinner /> Registrando pedido…
            </>
          ) : (
            <>
              Continuar para pagamento <ArrowRight size={17} />
            </>
          )}
        </button>
        <p className="secure-note">
          <ShieldCheck size={14} />{' '}
          {cfg.mode === 'local'
            ? 'Pagamento simulado neste computador'
            : 'Pagamento no ambiente do Mercado Pago'}
        </p>
        <div className="summary-pickup">
          <MapPin size={17} />
          <span>
            Retirada: {EVENT.location}
            <br />
            <strong>{EVENT.hours}</strong> · no dia escolhido
          </span>
        </div>
      </aside>
    </form>
  );
}
function OrderView({
  order,
  access,
  refresh,
  onNew,
}: {
  order: PublicOrder;
  access: Access;
  refresh: () => Promise<void>;
  onNew: () => void;
}) {
  const { site } = useSite();
  const EVENT = order.event || site.event;
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    let url = '';
    if (order.checkoutUrl && order.status === 'pendente')
      fetch(`/api/pedidos/${order.id}/qr`, { headers: { Authorization: `Bearer ${access.token}` } })
        .then(async (r) => {
          if (!r.ok) throw new Error();
          url = URL.createObjectURL(await r.blob());
          if (active) setQr(url);
        })
        .catch(() => {
          if (active) setQr('');
        });
    else setQr('');
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [order.checkoutUrl, order.status]);
  async function simulate() {
    setBusy(true);
    setError('');
    try {
      await api(`/api/local/pedidos/${order.id}/pagar`, { method: 'POST', token: access.token });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function download() {
    const text = `${order.local ? 'DEMONSTRAÇÃO LOCAL — SEM PAGAMENTO REAL\n\n' : ''}${EVENT.name.toUpperCase()} — ALMOÇO\n\nCódigo: ${order.code}\nNome: ${order.name}\nPedido: ${order.id}\n${order.items.map((i) => `${i.quantity}x ${i.name} — ${i.label}`).join('\n')}\nTotal: ${money(order.total)}\n\nRetirada: ${EVENT.pickup} do ${EVENT.location}\nHorário: ${EVENT.hours}\n\n${EVENT.warning}`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${order.code}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="order-layout">
      <section
        className={`panel order-main ${order.status === 'pago' ? 'paid' : ''}`}
        aria-live="polite"
      >
        {order.status === 'pago' ? (
          <>
            <div className="status-icon">
              <Check size={30} />
            </div>
            <p className="eyebrow blue">TUDO CERTO, {order.name.split(' ')[0].toUpperCase()}</p>
            <h2>
              Seu almoço
              <br />
              está reservado.
            </h2>
            {order.local && (
              <Alert>
                Este é um comprovante de demonstração. Não vale para retirada no evento.
              </Alert>
            )}
            <p>Guarde seu código e apresente no dia do seu almoço.</p>
            <div className="ticket-code">
              <span>CÓDIGO DE RETIRADA</span>
              <strong>{order.code}</strong>
              <small>Um código para o pedido · entregas separadas por dia</small>
            </div>
            <div className="actions">
              <button className="button" onClick={download}>
                <Download size={17} /> Salvar comprovante
              </button>
              <button
                className="button ghost"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(order.code!);
                    setCopied(true);
                  } catch {
                    setError('Selecione o código na tela para copiar.');
                  }
                }}
              >
                {copied ? 'Código copiado!' : 'Copiar código'}
              </button>
              <button className="text-button" onClick={() => window.print()}>
                Imprimir
              </button>
            </div>
          </>
        ) : order.status === 'pendente' ? (
          <>
            <p className="eyebrow blue">FALTA SÓ UM PASSO</p>
            <h2>
              Confirme
              <br />
              seu pagamento.
            </h2>
            <p>
              Seu pedido foi registrado. A reserva será confirmada após o pagamento de{' '}
              <strong>{money(order.total)}.</strong>
            </p>
            {order.local && (
              <Alert>
                Nenhuma cobrança real será feita. Use o botão de simulação para testar o
                comprovante.
              </Alert>
            )}
            {order.checkoutUrl ? (
              <div className="payment-options">
                <div>
                  {qr ? (
                    <img
                      className="qr"
                      src={qr}
                      alt="QR Code para abrir a cobrança deste pedido"
                      width="220"
                      height="220"
                    />
                  ) : (
                    <div className="qr-placeholder">
                      <Spinner />
                      <span>Preparando QR Code</span>
                    </div>
                  )}
                  <p className="small-text muted">
                    Este QR abre a página da cobrança.
                    <br />
                    Para usar Pix, finalize no Mercado Pago.
                  </p>
                </div>
                <div>
                  <span className="number-circle">1</span>
                  <h3>Abra a cobrança</h3>
                  <p>No celular, toque no botão. Em outro aparelho, leia o QR Code com a câmera.</p>
                  {order.local ? (
                    <button className="button" disabled={busy} onClick={simulate}>
                      {busy ? <Spinner /> : <CheckCircle2 size={17} />} Simular pagamento aprovado
                    </button>
                  ) : (
                    <a className="button" href={order.checkoutUrl} target="_blank" rel="noreferrer">
                      Pagar no Mercado Pago <ExternalLink size={16} />
                    </a>
                  )}
                  <p className="small-text muted">
                    Confira o valor e o recebedor na página de pagamento.
                  </p>
                </div>
              </div>
            ) : (
              <div className="loading">
                <Spinner /> Preparando a cobrança individual…
              </div>
            )}
            <div className="pending-status">
              <span className="dot" /> Aguardando confirmação do pagamento
              <button className="text-button" onClick={() => void refresh()}>
                <RefreshCw size={14} /> Atualizar pagamento
              </button>
            </div>
            <p className="small-text muted">
              Cobrança solicitada por 30 minutos. Consulte novamente antes de criar outro pedido se
              a confirmação demorar.
            </p>
          </>
        ) : (
          <>
            <TriangleAlert size={38} className="amber" />
            <h2>{STATUS_LABELS[order.status]}</h2>
            <p>
              Este pedido não está liberado para retirada. Consulte a organização antes de fazer um
              novo pagamento.
            </p>
            <a
              className="button ghost"
              href={wa(
                EVENT.whatsapp,
                `Olá! Preciso de ajuda com meu pedido de almoço ${order.id}. Situação: ${STATUS_LABELS[order.status]}.`,
              )}
              target="_blank"
              rel="noreferrer"
            >
              Falar com a organização <ArrowUpRight size={16} />
            </a>
          </>
        )}
        {error && <Alert>{error}</Alert>}
        <button className="text-button new-order" onClick={onNew}>
          {order.status === 'pendente'
            ? 'Montar outro pedido (o atual permanece registrado)'
            : 'Fazer outra reserva'}{' '}
          <ArrowRight size={15} />
        </button>
      </section>
      <aside className="summary-card">
        <p className="eyebrow blue">RESUMO DO PEDIDO</p>
        <h3>{order.name}</h3>
        <p className="small-text muted">{shortDate(order.createdAt)}</p>
        <div className="cart-lines">
          {order.items.map((i) => (
            <div key={i.id}>
              <span>
                <strong>
                  {i.quantity}× {i.name}
                </strong>
                <small>{i.label}</small>
                {order.deliveries.some((d) => d.itemId === i.id) && (
                  <small className="green">
                    {order.deliveries.find((d) => d.itemId === i.id)?.quantity} já entregue(s)
                  </small>
                )}
              </span>
              <b>{money(i.cents * i.quantity)}</b>
            </div>
          ))}
        </div>
        <div className="total">
          <span>Total</span>
          <strong>{money(order.total)}</strong>
        </div>
        <p className="small-text muted break">
          Número do pedido
          <br />
          {order.id}
        </p>
        <div className="summary-pickup">
          <MapPin size={18} />
          <span>
            {EVENT.pickup}
            <br />
            <strong>
              {EVENT.location} · {EVENT.hours}
            </strong>
          </span>
        </div>
        <a
          className="text-link"
          href={wa(EVENT.whatsapp, `Olá! Tenho uma dúvida sobre o pedido de almoço ${order.id}.`)}
          target="_blank"
          rel="noreferrer"
        >
          Preciso de ajuda <ArrowUpRight size={15} />
        </a>
      </aside>
    </div>
  );
}
type Session = { email: string; csrf: string; admin: boolean };
function Team({ cfg }: { cfg: Config }) {
  const [session, setSession] = useState<Session>();
  const [checked, setChecked] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [day, setDay] = useState('');
  const [orders, setOrders] = useState<any[]>([]);
  const [stats, setStats] = useState<any>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'orders' | 'settings'>('orders');
  const login = () =>
    api<Session>('/api/equipe/sessao')
      .then(setSession)
      .catch(() => {})
      .finally(() => setChecked(true));
  useEffect(() => {
    void login();
  }, []);
  async function load() {
    if (!session) return;
    try {
      const q = new URLSearchParams({
        busca: search,
        ...(status ? { status } : {}),
        ...(day ? { dia: day } : {}),
      });
      const [o, s] = await Promise.all([
        api<any[]>('/api/equipe/pedidos?' + q),
        api('/api/equipe/resumo'),
      ]);
      setOrders(o);
      setStats(s);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [session, search, status, day]);
  useEffect(() => {
    if (!session) return;
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, 15_000);
    return () => clearInterval(t);
  }, [session, search, status, day]);
  if (!checked)
    return (
      <div className="container loading">
        <Spinner /> Verificando acesso…
      </div>
    );
  if (!session)
    return (
      <div className="container team-login panel">
        <ShieldCheck size={44} className="blue" />
        <p className="eyebrow blue">ACESSO RESTRITO</p>
        <h1>
          Uma equipe.
          <br />
          <span>Tudo organizado.</span>
        </h1>
        <p>
          Consulte pagamentos e registre a entrega dos almoços.
          <br />
          Entre com uma conta Google autorizada pela organização.
        </p>
        {cfg.mode === 'local' ? (
          <button
            className="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api('/api/local/equipe/entrar', { method: 'POST' });
                await login();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Entrar na demonstração local <ArrowRight size={16} />
          </button>
        ) : (
          <a className="button" href="/auth/google">
            Entrar com Google <ArrowRight size={16} />
          </a>
        )}
        {error && <Alert>{error}</Alert>}
      </div>
    );
  return (
    <div className="container team">
      <div className="team-heading">
        <div>
          <p className="eyebrow blue">ALIMENTAÇÃO · {cfg.event.name.toUpperCase()}</p>
          <h1>
            Painel da equipe<span>.</span>
          </h1>
          <p className="muted">{session.email}</p>
        </div>
        <button
          className="button ghost small"
          onClick={async () => {
            try {
              await api('/api/equipe/sair', { method: 'POST', csrf: session.csrf });
              setSession(undefined);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <LogOut size={16} /> Sair
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="team-tabs">
        <button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>
          <Ticket size={16} /> Pedidos e retiradas
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          <Settings2 size={16} /> Configuração
        </button>
      </div>
      {tab === 'settings' ? (
        <TeamSettings session={session} cfg={cfg} />
      ) : (
        <>
          {stats && (
            <>
              <div className="metrics">
                {[
                  ['Pedidos', stats.orders],
                  ['Pagos', stats.paid],
                  ['Total confirmado', money(stats.revenue)],
                  ['Refeições entregues', stats.delivered],
                ].map(([label, v]) => (
                  <div className="panel" key={label}>
                    <span>{label}</span>
                    <strong>{v}</strong>
                  </div>
                ))}
              </div>
              {stats.sync > 0 && (
                <Alert>
                  {stats.sync} atualização(ões) aguardando{' '}
                  {cfg.mode === 'local'
                    ? 'o registro local de teste'
                    : 'sincronização com a planilha'}
                  .
                  {stats.errors > 0
                    ? ' Existem tarefas aguardando nova tentativa. Os registros permanecem no banco.'
                    : ''}
                </Alert>
              )}
              <details className="kitchen panel">
                <summary>
                  <UtensilsCrossed size={18} /> Quantidades confirmadas para a cozinha
                </summary>
                <div>
                  {stats.kitchen.map((i: any) => (
                    <div key={i.id}>
                      <span>
                        {dateLabel(i.day, { day: '2-digit', month: '2-digit' })} · {i.name}
                      </span>
                      <strong>{i.quantity}</strong>
                    </div>
                  ))}
                </div>
              </details>
            </>
          )}
          <div className="team-filters">
            <label className="search">
              <Search size={19} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Código, nome ou telefone"
                aria-label="Buscar pedido por código, nome ou telefone"
              />
            </label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-label="Filtrar situação"
            >
              <option value="">Todas as situações</option>
              {Object.entries(STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <select value={day} onChange={(e) => setDay(e.target.value)} aria-label="Filtrar dia">
              <option value="">Todos os dias</option>
              {[
                ...new Set([
                  ...cfg.menu.map((i) => i.day),
                  ...(stats?.kitchen?.map((i: any) => i.day) || []),
                ]),
              ]
                .sort()
                .map((day) => (
                  <option key={day} value={day}>
                    {dateLabel(day, { weekday: 'short', day: '2-digit', month: '2-digit' })}
                  </option>
                ))}
            </select>
            <button
              className="button ghost small"
              onClick={() => void load()}
              aria-label="Atualizar pedidos"
            >
              <RefreshCw size={17} />
            </button>
          </div>
          <p className="small-text muted">
            Últimos 50 pedidos da busca. Entregas registradas com dia, quantidade e responsável.
          </p>
          <div className="team-orders">
            {orders.length ? (
              orders.map((o) => (
                <TeamOrder key={o.id} order={o} session={session} day={day} reload={load} />
              ))
            ) : (
              <div className="panel empty-cart">
                <Search size={30} />
                <h3>Nenhum pedido nesta busca</h3>
                <p>Confira o código ou altere os filtros.</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
function TeamOrder({
  order,
  session,
  day,
  reload,
}: {
  order: any;
  session: Session;
  day: string;
  reload: () => Promise<void>;
}) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const retry = useRef<Record<string, { requestId: string; quantity: number }>>({});
  async function deliver(itemId: string, quantity: number) {
    if (
      !window.confirm(
        `Registrar a entrega de ${quantity} refeição(ões) de ${order.items.find((i: any) => i.id === itemId).name}?`,
      )
    )
      return;
    setBusy(itemId);
    setError('');
    setMessage('');
    const command =
      retry.current[itemId]?.quantity === quantity
        ? retry.current[itemId]
        : { requestId: crypto.randomUUID(), quantity };
    retry.current[itemId] = command;
    try {
      await api('/api/equipe/retiradas', {
        method: 'POST',
        csrf: session.csrf,
        body: { ...command, orderId: order.id, itemId },
      });
      delete retry.current[itemId];
      setMessage('Entrega registrada.');
      await reload();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) delete retry.current[itemId];
    } finally {
      setBusy('');
    }
  }
  return (
    <article className="panel team-order">
      <div className="team-order-head">
        <div>
          <span className={`badge ${order.status}`}>{STATUS_LABELS[order.status as Status]}</span>
          <h3>{order.name}</h3>
          <p>
            {order.phone} · CPF {order.cpfMasked}
          </p>
        </div>
        <div>
          <strong className="small-code">{order.code || 'Código ainda não liberado'}</strong>
          <p>
            {money(order.total)} · {shortDate(order.createdAt)}
          </p>
          {order.syncPending && <small className="amber">Atualização da planilha pendente</small>}
        </div>
      </div>
      {order.items
        .filter((i: any) => !day || i.day === day)
        .map((i: any) => {
          const delivered = order.deliveries.find((d: any) => d.itemId === i.id)?.quantity || 0;
          const remaining = i.quantity - delivered;
          return (
            <div className="delivery-line" key={i.id}>
              <div>
                <strong>{i.name}</strong>
                <p>
                  {i.label} · Comprados: {i.quantity} · Entregues: {delivered}
                </p>
              </div>
              <div>
                {remaining > 0 ? (
                  <>
                    <span className="balance">Saldo {remaining}</span>
                    <select
                      aria-label={`Quantidade a entregar de ${i.name} dia ${i.day}`}
                      disabled={order.status !== 'pago' || !!busy}
                      value={Math.min(quantities[i.id] || remaining, remaining)}
                      onChange={(e) =>
                        setQuantities((q) => ({ ...q, [i.id]: Number(e.target.value) }))
                      }
                    >
                      {Array.from({ length: remaining }, (_, n) => (
                        <option key={n} value={n + 1}>
                          {n + 1}
                        </option>
                      ))}
                    </select>
                    <button
                      className="button small"
                      disabled={order.status !== 'pago' || !!busy}
                      onClick={() =>
                        void deliver(i.id, Math.min(quantities[i.id] || remaining, remaining))
                      }
                    >
                      {busy === i.id ? <Spinner /> : <Check size={16} />} Entregar
                    </button>
                  </>
                ) : (
                  <span className="green">
                    <CheckCircle2 size={17} /> Entregue
                  </span>
                )}
              </div>
            </div>
          );
        })}
      {error && <Alert>{error}</Alert>}
      {message && <Alert success>{message}</Alert>}
      {order.deliveriesLog.length > 0 && (
        <details className="delivery-log">
          <summary>Histórico das entregas</summary>
          {order.deliveriesLog.map((d: any, i: number) => (
            <p key={i}>
              {d.quantity}× · {d.day} · {d.actor} · {shortDate(d.created_at)}
            </p>
          ))}
        </details>
      )}
    </article>
  );
}
function TeamSettings({ session, cfg }: { session: Session; cfg: Config }) {
  const { reload } = useSite();
  const [link, setLink] = useState('');
  const [qr, setQr] = useState<string>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () =>
    api('/api/equipe/configuracao')
      .then((s) => {
        setLink(s.paymentLinkDraft);
        setQr(s.qr);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <SiteSettingsEditor admin={session.admin} csrf={session.csrf} onSaved={reload} />
      <IntegrationSettings admin={session.admin} csrf={session.csrf} />
      <section className="panel settings">
        <p className="eyebrow blue">PREPARADO PARA O PRÓXIMO PASSO</p>
        <h2>Link do Mercado Pago</h2>
        <p>
          Cadastre o link para revisão e veja seu QR Code. O pagamento automático continua usando
          uma cobrança individual para cada pedido.
        </p>
        <Alert>
          Um link geral não permite identificar com segurança qual pedido foi pago. Este cadastro
          fica como rascunho e não altera as cobranças dos clientes.
        </Alert>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            setMessage('');
            try {
              await api('/api/equipe/configuracao', {
                method: 'PUT',
                csrf: session.csrf,
                body: { paymentLinkDraft: link },
              });
              await load();
              setMessage('Rascunho salvo. Nenhum pagamento foi ativado com esse link.');
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Link HTTPS do Mercado Pago
            <input
              type="url"
              placeholder="https://mpago.la/…"
              value={link}
              maxLength={1000}
              onChange={(e) => {
                setLink(e.target.value);
                setQr(undefined);
              }}
              disabled={!session.admin}
            />
          </label>
          <button className="button" disabled={busy || !session.admin}>
            {busy ? <Spinner /> : <Settings2 size={17} />} Salvar rascunho e gerar QR Code
          </button>
        </form>
        {error && <Alert>{error}</Alert>}
        {message && <Alert success>{message}</Alert>}
        {qr && (
          <div className="draft-qr">
            <img
              className="qr"
              src={qr}
              alt="Prévia do QR Code do link cadastrado, ainda não ativo para reservas"
            />
            <span>PRÉVIA · LINK EM RASCUNHO</span>
          </div>
        )}
        <hr />
        <h3>Planilha dos pedidos</h3>
        <p>
          {cfg.mode === 'local'
            ? 'Modo local: os dados de teste são guardados neste computador. A planilha online ainda não está conectada.'
            : 'O servidor sincroniza pedidos, itens, pagamentos, histórico e retiradas. O painel informa quando há atualizações pendentes.'}
        </p>
        <a
          className="text-link"
          href="https://docs.google.com/spreadsheets/d/1wQVEsOTbFgtBpOJD6-rbgrbep3A28oYd7VYQxDhaMAU/edit"
          target="_blank"
          rel="noreferrer"
        >
          Abrir planilha indicada <ExternalLink size={16} />
        </a>
      </section>
    </>
  );
}
