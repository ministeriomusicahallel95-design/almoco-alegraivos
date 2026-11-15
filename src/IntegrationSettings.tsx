import { useEffect, useState } from 'react';
import { CheckCircle2, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api } from './api';
export function IntegrationSettings({ admin, csrf }: { admin: boolean; csrf: string }) {
  const [state, setState] = useState<any>();
  const [tested, setTested] = useState<any>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (admin)
      api('/api/equipe/integracoes')
        .then(setState)
        .catch((e) => setError(e.message));
  }, [admin]);
  if (!admin) return null;
  const item = (ready: boolean, label: string) => (
    <li className={ready ? 'ready' : ''}>
      {ready ? <CheckCircle2 size={17} /> : <TriangleAlert size={17} />}
      <span>
        {label}: <strong>{ready ? 'configurado' : 'pendente'}</strong>
      </span>
    </li>
  );
  return (
    <section className="panel settings integration-settings">
      <p className="eyebrow blue">CONEXÕES REAIS</p>
      <h2>Pagamentos e planilha</h2>
      <p>
        Confira os pré-requisitos da integração. Os testes abaixo consultam os serviços, sem criar
        cobrança ou alterar a planilha.
      </p>
      {state && (
        <>
          <ul className="integration-list">
            {item(state.mercadoPago.tokenConfigured, 'Token Mercado Pago')}
            {item(state.mercadoPago.sellerConfigured, 'Identificação do recebedor')}
            {item(state.mercadoPago.signatureConfigured, 'Assinatura das notificações')}
            {item(state.hosting.publicHttps, 'Servidor com HTTPS público')}
            {item(state.hosting.databaseConfigured, 'Banco PostgreSQL do servidor')}
            {item(state.google.serviceAccountConfigured, 'Autorização de acesso à planilha')}
            {item(state.google.loginConfigured, 'Login Google da equipe')}
            {item(state.hosting.legacyReviewed, 'Revisão das reservas anteriores')}
          </ul>
          <label>
            Endereço para cadastrar nas notificações do Mercado Pago
            <input
              readOnly
              value={
                state.mercadoPago.webhookUrl ||
                'Disponível depois de configurar o endereço HTTPS do servidor'
              }
            />
            <small>
              No Mercado Pago Developers, selecione o evento Order. A assinatura secreta gerada deve
              ser configurada com segurança no servidor.
            </small>
          </label>
          <p className="small-text muted">
            {state.mode === 'local'
              ? 'Este site continua em demonstração local. Tokens configurados não ativam cobranças por conta própria.'
              : 'Integração configurada no servidor. Confira os testes e a situação das vendas antes de usar.'}
          </p>
        </>
      )}
      <button
        className="button ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            setTested(await api('/api/equipe/integracoes/testar', { method: 'POST', csrf }));
            setState(await api('/api/equipe/integracoes'));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <RefreshCw size={17} className={busy ? 'spin' : ''} />
        {busy ? 'Verificando conexões…' : 'Testar conexões sem gravar dados'}
      </button>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {tested && (
        <div>
          {Object.entries(tested).map(([name, r]: [string, any]) => (
            <div className={`alert ${r.ok ? 'success' : ''}`} key={name}>
              {r.ok ? <ShieldCheck size={18} /> : <TriangleAlert size={18} />}
              <span>
                <strong>{name === 'mercadoPago' ? 'Mercado Pago' : 'Google Sheets'}:</strong>{' '}
                {r.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
