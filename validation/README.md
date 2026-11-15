# Verificações locais — 15/11/2026

- TypeScript: verificação sem erros.
- Build: cliente React/Vite e servidor TypeScript gerados.
- Testes: 21 casos passaram, incluindo idempotência, autenticação/CSRF, validação de pagamento, estorno, disputa de retirada, perda de resposta do Google, configuração administrativa, preservação de pedidos e reinício com banco persistido.
- `load-test.json`: 5.000 pedidos, 100 operações concorrentes, 5.000 IDs distintos, 100 confirmações simuladas. Na disputa de 100 entregas da mesma unidade, somente uma foi aceita.
- `http-smoke.json`: percurso pelo servidor HTTP local, com QR, pagamento simulado, código, retirada de duas refeições na sexta e uma no sábado, sessão da equipe e link salvo como rascunho.
- HTTP: site, painel, imagens e entrada React responderam 200. Health retornou modo local e versão 1.0.0.
- Identidade: logo e fotografia copiados sem alteração, com SHA-256 idêntico aos arquivos originais.
- As verificações não envolveram implantação do site, cobrança real, envio de mensagens ou gravação no Google. O servidor local está disponível na porta 3015; `iniciar-local.cmd` permite abrir novamente se ele estiver parado.

## Limites

O token Mercado Pago fornecido foi guardado exclusivamente no `.env` ignorado pelo Git e autenticado por consulta oficial somente leitura (HTTP 200). Nenhuma cobrança foi criada. Google Sheets e notificações externas continuam pendentes de credenciais, autorização e hospedagem.

A sessão nativa do Chrome foi localizada, mas a automação foi interrompida pelo controle de segurança por não conseguir confirmar o endereço da janela. A nova tela e a pulsação não tiveram conferência visual automatizada. A leitura do QR em outro aparelho, Google OAuth, escrita real no Google Sheets, notificações reais de pagamento, PostgreSQL externo, Docker/Railway e capacidade da hospedagem ainda precisam de homologação.

O Apps Script e os registros atuais não estavam acessíveis nesta sessão. A consulta/migração automática das reservas antigas depende da inspeção do esquema e do código, conforme o corte obrigatório documentado no README principal. A venda real permanece desativada por padrão.
