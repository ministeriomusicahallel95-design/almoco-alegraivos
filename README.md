# Almoço Alegrai-vos 2026

Reservas, cobrança individual pelo Mercado Pago, comprovante com código, painel da equipe e sincronização persistente com Google Sheets.

## Abrir localmente

Windows: dê dois cliques em `iniciar-local.cmd`, ou execute:

```powershell
npm.cmd ci
npm.cmd run dev
```

- Site: http://localhost:3015
- Equipe: http://localhost:3015/equipe
- Saúde: http://localhost:3015/api/health

O modo padrão é **demonstração local**. Usa PostgreSQL embutido (PGlite), persiste em `.local/postgres`, simula cobranças e grava uma projeção de teste em `.local/planilha-local.json`. Não transmite dados ao Google ou Mercado Pago. A página e o comprovante indicam essa condição. O servidor local só pode escutar na interface de loopback.

Selecione pratos, informe dados válidos, confirme a ciência da retirada e continue. Depois de a cobrança de teste ser preparada, use **Simular pagamento aprovado**. Guarde o código, entre no painel pelo botão **Entrar na demonstração local** e registre as entregas. Esse acesso de teste não existe no modo integrado.

## O que foi preservado

Repositório de origem: https://github.com/ministeriomusicahallel95-design/almoco-alegraivos. A branch publicada disponível no início era `gh-pages`, commit `b05cc35b2ac4104468345bee59dd082f0a857d22`; não havia `main`. A implementação está em `feat/reservas-pagamento`, sem publicação automática.

Imagens e marca originais, cores, pratos, preço de R$ 25, dias 20 e 21/11/2026 e orientações de retirada foram preservados. O código original compilado continua recuperável pelo Git. A nova fonte é React/TypeScript e o servidor serve o build e a API na mesma origem. GitHub Pages sozinho não executa esse servidor; a publicação prevista é do aplicativo completo em um serviço Node, sem substituir o site antigo antes do corte aprovado.

## Estrutura e garantias

- `src/`: site, comprovante, histórico neste aparelho e painel responsivo.
- `server/`: Fastify, Google OAuth, Mercado Pago Orders API, fila persistida no PostgreSQL e sincronização.
- `shared/`: catálogo, preços em centavos e validações compartilhadas. O servidor recalcula valores e limita 20 unidades por prato.
- `google-apps-script/MenuHallel.gs`: menu/sidebar da planilha que abre o mesmo painel protegido. Deve ser acrescentado ao script existente, preservando seu `onOpen`.
- `tests/` e `scripts/load-test.ts`: verificações de integridade e carga isolada.

O cliente gera uma identificação de tentativa e token privado antes do envio. O mesmo pedido pode ser consultado após perda da resposta. Token e hash dos dados protegem contra repetição com outro conteúdo. O servidor salva o pedido e a tarefa de cobrança na mesma transação. A chamada ao Mercado Pago usa o ID do pedido como chave de idempotência.

Webhooks assinados são persistidos antes do HTTP 200 e processados consultando o recurso oficial. Referência, vendedor, moeda e total são conferidos. Apenas `processed/accredited`, integralmente pago, libera o código. Parâmetros de retorno do checkout não confirmam pagamentos. Notificações antigas não reativam códigos estornados ou em revisão.

A fila possui leases, novas tentativas com espera progressiva e recuperação após reinício. Cobranças conhecidas são reconciliadas a cada minuto enquanto pendentes e a cada seis horas após confirmação, por até 40 dias da criação. Cobrança ambígua após timeout não gera outro pagamento: se não for resolvida dentro do prazo, fica em análise para reconciliação. Não há cancelamento ou reembolso financeiro automático.

Entregas exigem login Google autorizado e proteção CSRF, com transação e bloqueio do pedido. Pedidos não pagos não podem ser entregues. A soma entregue não ultrapassa a quantidade comprada, incluindo operadores simultâneos. Em integração real, a data da entrega precisa corresponder ao prato, no fuso `America/Manaus`. O primeiro e-mail de `TEAM_EMAILS` é o responsável que pode alterar o rascunho do link; os demais operam entregas.

## Planilha e recuperação

Destino fixado na configuração de exemplo:
https://docs.google.com/spreadsheets/d/1wQVEsOTbFgtBpOJD6-rbgrbep3A28oYd7VYQxDhaMAU/edit

O servidor acrescenta abas próprias, sem limpar as antigas:

| Aba                  | Informações                                                      |
| -------------------- | ---------------------------------------------------------------- |
| Hallel_Pedidos_v1    | ID, código, nome, telefone, CPF, situação, total, datas e aceite |
| Hallel_Itens_v1      | Dia, prato, quantidade e valores de cada item                    |
| Hallel_Pagamentos_v1 | ID do Mercado Pago, situação, valor pago e transações            |
| Hallel_Retiradas_v1  | Quantidade, prato, dia, horário e operador                       |
| Hallel_Historico_v1  | Histórico de confirmação e entregas                              |

O banco é a fonte operacional. O painel indica sincronizações pendentes. Uma indisponibilidade do Google não perde pagamentos, códigos nem entregas; a fila permanece no banco. As gravações usam lotes de até 100 tarefas, IDs estáveis e posições confirmadas no banco antes da chamada externa. Timeout após gravar repete a mesma posição, sem append cego. Escritas usam `RAW`, sem executar fórmulas digitadas pelo cliente.

**Não ordene nem mova fisicamente as linhas dessas abas.** Use visualizações de filtro ou outra aba de relatório. Se o identificador encontrado em uma posição não for o esperado, o sincronizador interrompe a gravação para preservar dados. Não apague IDs, cabeçalhos, o banco ou sua tabela de mapeamento. Mudanças manuais na planilha não aprovam pagamentos nem fazem baixa no banco.

Após corrigir conectividade/permissões, a fila tenta novamente automaticamente, em até uma hora. Para antecipar, um administrador do banco pode reagendar somente tarefas pendentes de `sheets`, preservando o conteúdo. Falhas e quantidade de pendências aparecem no resumo da equipe. Os dados de banco devem ter backup e restauração testada antes da ativação.

## Configurações do administrador

Abra `/equipe`, entre com a conta autorizada e selecione **Configuração → Evento e cardápio**. Na demonstração local, use **Entrar na demonstração local**. Em integração real, somente o primeiro e-mail de `TEAM_EMAILS` pode editar.

O administrador pode alterar nome, início/fim do evento, prazo das reservas no horário de Manaus, local/cidade, ponto e horário da retirada, WhatsApp, Instagram, site oficial, mensagem de abertura, acompanhamentos, observações e condições de retirada. No cardápio, pode acrescentar/remover opções, editar nomes, datas, preços e descrições ou desativar pratos para novas reservas.

Use **Salvar evento e cardápio** para aplicar. Datas dos pratos disponíveis precisam estar dentro do evento, o encerramento das reservas não pode ultrapassar o evento e preços precisam ser positivos. Um conflito com outra edição exige recarregar as configurações. Clientes com um cardápio antigo recebem orientação para atualizar e conferir os preços antes de confirmar.

Os pedidos guardam uma cópia das informações do evento e dos itens na criação. Alterar datas, preços ou observações não reescreve pedidos, pagamentos ou entregas já registrados. Pedidos anteriores à nova configuração usam os dados originais do evento. A configuração e os novos campos do pedido são persistidos com migração aditiva.

**Configuração → Pagamentos e planilha** exibe somente a presença das credenciais e os pré-requisitos. O botão **Testar conexões sem gravar dados** consulta a conta do Mercado Pago e os metadados da planilha quando as credenciais existirem. O teste Google confirma leitura, não comprova permissão de escrita. Nenhum segredo é devolvido ao navegador. Token configurado não ativa cobrança real automaticamente.

O link **Conheça o evento** no rodapé usa o endereço editado, com destaque verde e pulsação suave. A animação é desativada quando o dispositivo solicita movimento reduzido.

### Link geral do Mercado Pago

No painel: **Configuração → Link do Mercado Pago → Salvar rascunho e gerar QR Code**. O link exige HTTPS e domínio oficial permitido. O QR é real e representa esse endereço; é uma prévia administrativa. Cadastrar o link geral não muda a cobrança dos clientes nem marca pedidos como pagos.

A confirmação automática usa a URL individual retornada pela API para cada pedido. QR de URL abre o checkout; ele não é um código Pix Copia e Cola. A conta Mercado Pago precisa oferecer os meios de pagamento desejados; testar Pix no checkout antes de abrir vendas.

## Configuração segura para integração real

Copie `.env.example` para `.env` somente no computador local. Em hospedagem, use variáveis secretas do serviço. Nunca publique o `.env`, a chave da conta de serviço, access tokens ou cookies. Nenhuma credencial precisa ser enviada no chat.

1. Providencie PostgreSQL dedicado e a aplicação Node. Configure `DATABASE_URL`, `APP_URL` HTTPS, `HOST=0.0.0.0`, `NODE_ENV=production` e `INTEGRATION_MODE=live`. A configuração de produção falha fechada sem banco, HTTPS e credenciais completas.
2. No Mercado Pago Developers, crie/configure uma aplicação Checkout Pro com Orders API. Defina `MP_ACCESS_TOKEN`, `MP_SELLER_ID` e `MP_WEBHOOK_SECRET`. Configure o tópico **Order** para `https://SEU-SERVICO/api/webhooks/mercadopago`. Primeiro use contas/credenciais de teste. A configuração das notificações é feita no painel do Mercado Pago, não pelo código.
3. No Google Cloud, ative Google Sheets API, crie a conta de serviço e compartilhe **somente a planilha indicada** com esse e-mail como editor. Configure `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` e o ID da planilha. Guarde o PEM no segredo do servidor, com novas linhas reais ou `\n`.
4. Para login da equipe, crie cliente OAuth do tipo aplicativo Web, escopos `openid email`, redirect exato `https://SEU-SERVICO/auth/google/callback`. Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `TEAM_EMAILS` separados por vírgula, responsável principal primeiro. Contas fora da lista são recusadas no servidor. Em teste Google, inclua os e-mails como usuários de teste quando exigido.
5. Em PostgreSQL público, habilite TLS com certificado válido (`DATABASE_SSL=true` e CA quando necessário). Rede privada da hospedagem pode usar a conexão interna correspondente. A aplicação não desabilita a validação de certificados.
6. Mantenha `SALES_ENABLED=false` enquanto verifica o sistema. Não habilite a venda real antes de concluir o corte legado abaixo e a homologação ponta a ponta.

Sem credenciais configuradas não há cobrança, autenticação Google ou escrita online verificadas. O acesso ao Google por este ambiente retornou 401 durante o planejamento; o Apps Script e as colunas existentes não foram disponibilizados para inspeção autenticada.

## Corte do sistema anterior: obrigatório antes de ativar

1. Obter, por acesso autorizado, o código atual `.gs`/`.html`, propriedades necessárias e estrutura da planilha. Fazer backup com acesso restrito. Não copiar segredos para o repositório.
2. Com a conta Google configurada, `npm.cmd run legacy:inspect` consulta somente títulos e cabeçalhos; não escreve nada. Conferir campos, abas, registros e pagamentos pendentes com o código original.
3. Reconciliar pedidos antigos por código e identificador do Mercado Pago, preservando valores, quantidades e entregas. Não existe importador genérico habilitado sem conhecer esse esquema. Usar o sistema antigo para atender essas reservas até implementar e validar o mapeamento específico, se houver dados a migrar.
4. Manter o serviço antigo consultável durante o corte. O site novo não apaga o armazenamento anterior no navegador; se detectar o código antigo, orienta o cliente a preservá-lo e consultar a organização. A consulta automática e a importação legada dependem do acesso ainda ausente; não estão homologadas.
5. Somente após resolver todas as reservas antigas e demonstrar a preservação, marcar `LEGACY_REVIEW_COMPLETE=true`. Esse controle impede habilitar vendas reais inadvertidamente. Então validar integrações de teste e aprovar separadamente a publicação/ativação.

## Verificação

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run test:load
npx.cmd tsx scripts/smoke-local.ts
```

O teste de carga usa banco isolado em memória, 5.000 pedidos, 100 operações simultâneas, confirma 100 pagamentos simulados e disputa 100 entregas para a mesma unidade. Salva métricas em `validation/load-test.json`. O smoke HTTP exige o servidor local ligado e deixa um pedido chamado “Demonstração Local”, com entregas de teste; recusa ambientes integrados. Isso testa lógica e integridade locais; não certifica capacidade de Railway/PostgreSQL externo, rede, Google ou Mercado Pago. Homologação nessa infraestrutura e QA visual em navegador real continuam necessários.

Antes da ativação: testar com contas de teste Mercado Pago, login Google autorizado e negado, leitura real do QR em outro aparelho, gravação/atualização real na planilha, simulação de indisponibilidade, recuperação da fila, picos de acesso e restauração de backup. Confira vendedor, total e datas em cada etapa. Comprovantes locais são inválidos para o evento.

O Dockerfile e `railway.toml` preparam a implantação. Não criam serviço, contratam plano ou publicam automaticamente. Criação de serviços, custos, corte do site publicado e ativação de cobrança real requerem a autorização específica combinada no plano.

## Referências oficiais

- Mercado Pago, criação de cobrança: https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-orders/create-order
- Mercado Pago, notificações: https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-orders/notifications
- Limitação de links gerais: https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/additional-content/your-integrations/notifications/additional-info
- Limites Google Sheets: https://developers.google.com/workspace/sheets/api/limits
- Identidade Google: https://developers.google.com/identity/openid-connect/openid-connect
