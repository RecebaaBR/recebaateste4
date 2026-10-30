# Pagamentos online no Recebaa (Pix + cartão; carteiras Apple Pay/Google Pay via Stripe) — projeto e guia de ativação

Status: **código pronto, nada ativo**. Tudo nasce desligado (`kiosks.payments_enabled = false`), nenhuma migração foi aplicada, nenhuma Edge Function foi publicada, nenhuma credencial existe no repositório.

**Atualização (carteiras):** o dono decidiu MANTER o Mercado Pago para Pix e cartão e ADICIONAR a Stripe **somente** para Apple Pay e Google Pay, atrás de uma segunda flag (`kiosks.wallets_enabled`, desligada). Tudo sobre isso está na **seção 12**, incluindo a **PENDÊNCIA ABERTA do Stripe Connect para contas brasileiras** (não confirmado).

Hoje o Recebaa **não processa pagamentos**: o cliente pede a conta e paga direto ao estabelecimento (maquininha, Pix, dinheiro). A landing e os termos dizem isso. Este documento descreve como mudar isso **por negócio**, sem o Recebaa custodiar dinheiro.

---

## 1. Escolha do provedor

### Critérios

1. Pix nativo e cartão de crédito/débito no Brasil.
2. **Repasse direto ao estabelecimento, sem o Recebaa custodiar o dinheiro** (se o Recebaa receber e repassar dinheiro de terceiros, passa a se aproximar de uma instituição de pagamento, com exigências do Banco Central).
3. Taxas e liquidação.
4. Onboarding do quiosque (o dono do quiosque é um pequeno empreendedor).
5. Webhooks assinados + API para conferir o status.
6. Sandbox para testar sem dinheiro.

### Comparação

| | **Mercado Pago (Marketplace / OAuth)** | Stripe Connect | Pagar.me (Stone) | Asaas |
|---|---|---|---|---|
| Pix | Sim, nativo (QR + copia-e-cola) | Sim para contas brasileiras (confirmar disponibilidade na conta) | Sim | Sim (muito barato) |
| Cartão BR | Sim (crédito/débito), checkout hospedado (Checkout Pro) | Sim | Sim | Sim |
| Modelo de repasse | **Cada estabelecimento autoriza o app via OAuth e a cobrança é criada com o token DELE: o dinheiro cai direto na conta Mercado Pago do estabelecimento.** Taxa opcional da plataforma (`application_fee`) | Contas conectadas (Standard/Express) com *direct charges*: dinheiro na conta do vendedor. **Confirmar se Connect está liberado para plataforma e contas no Brasil** | Split por *recipients*: a cobrança passa pela conta da plataforma e é dividida. A plataforma aparece no fluxo do dinheiro | Subcontas white-label: a plataforma cria e opera subcontas dos clientes (guarda a chave de API de cada uma) |
| Custódia pelo Recebaa | **Não** (com fee 0) | Não (direct charges) | Parcial (plataforma é a conta-mãe do split) | Parcial/operacional (plataforma administra subcontas) |
| Onboarding do quiosque | Já ter conta Mercado Pago (a maioria já tem) e clicar em "Autorizar". KYC é do Mercado Pago | Onboarding hospedado do Stripe (KYC longo) | Cadastro de recipient com KYC enviado pela plataforma | Abertura de subconta com dados do cliente pela plataforma |
| Webhook | `x-signature` HMAC-SHA256 + consulta `GET /v1/payments/{id}` | Assinatura `Stripe-Signature` (excelente) | Assinatura HMAC | Token fixo no cabeçalho (mais fraco) |
| Sandbox | Usuários/credenciais de teste | Excelente | Sim | Sim |
| Tributação/NF do Recebaa | Sem receita de intermediação se fee = 0 | Idem | Receita de intermediação, mais obrigações | Idem |

Taxas (ordem de grandeza, **conferir a tabela vigente de cada provedor antes de decidir; elas mudam e são negociáveis por volume**): Pix costuma ficar em torno de 1% ou menos no Mercado Pago e em valor fixo baixo no Asaas; cartão de crédito à vista costuma ficar entre ~3,5% e ~5% com liquidação em dias (ou antecipação paga); débito é mais barato. Nada disso foi validado nesta sessão.

### Recomendação: **Mercado Pago, modelo Marketplace com OAuth por estabelecimento**

- É o único dos quatro em que o **estabelecimento é, de fato, o recebedor** em cada cobrança, sem subconta administrada pelo Recebaa e sem split passando pela conta do Recebaa. Isso mantém o Recebaa fora da custódia de dinheiro, que é o ponto jurídico mais sensível.
- Pix e cartão no mesmo provedor; **cartão por checkout hospedado** (o cliente digita o cartão no ambiente do Mercado Pago: escopo PCI mínimo, SAQ A).
- O público (quiosques e bares) tende a já ter conta Mercado Pago; o onboarding vira um clique em "Autorizar".
- Webhook com assinatura HMAC e API para **consultar** o pagamento: o código nunca confia só no corpo recebido.
- Existe uma interface (`PaymentProvider`) que isola o provedor: trocar por Stripe/Pagar.me/Asaas é escrever outro arquivo em `supabase/functions/_shared/` e registrar no `registry.ts`.

Pontos de atenção do Mercado Pago: o dinheiro do cartão de crédito é liberado conforme o prazo escolhido pelo vendedor na conta dele (antecipar custa mais); o Mercado Pago pode reter/congelar contas por análise de risco (é problema do estabelecimento com o provedor, mas gera suporte para o Recebaa); `application_fee` só deve ser usada depois de validação tributária (ver seção 8).

Observação: o banco de produção já tem a tabela `plan_payment_intents` com `mp_payment_id` (cobrança de plano do Recebaa). É um uso separado (o Recebaa como vendedor). A conta/aplicação do Mercado Pago do Recebaa pode ser a mesma que será dona do *app Marketplace*, mas as credenciais não são compartilhadas com este código.

---

## 2. Arquitetura

```
 Cliente (celular)                       Supabase                                  Mercado Pago
 ────────────────                        ────────                                  ────────────
 index.html + payments.js ──RPC payment_quote──────────► SQL (valor calculado no banco)
        │ "Pagar agora"
        ├─fetch create-payment (kiosk, mesa, método, idempotency_key) ► Edge: valida entrada, rate limit,
        │                                                  payment_prepare (SQL recalcula o valor) ──► cria cobrança com o
        │                                                  ◄── Pix copia-e-cola / URL do checkout         TOKEN DO ESTABELECIMENTO
        │ ◄── {payment, client_token, receipt_token} (tokens só nesta resposta)
        ├─ Pix: QR gerado no navegador         cartão: redireciona ao checkout hospedado
        │
        │                     ◄── webhook (assinado) ── payment-webhook: 1) valida assinatura
        │                                                  2) acha a NOSSA cobrança (?pid=)
        │                                                  3) CONSULTA o provedor com o token do dono da cobrança
        │                                                  4) payment_settle (idempotente, confere valor)
        ├─ polling payment_status (token do cliente) a cada 3 s; a cada ~15 s pede "refresh" ao servidor
        ▼
 Comprovante: QR = https://recebaa.com.br/#comprovante=<token aleatório de 192 bits>
        ├─ qualquer pessoa: receipt_public_check  → "pago R$ X, mesa N, hora" (sem dados pessoais)
        └─ garçom/dono: verify_payment_receipt   → registra a baixa; segunda leitura mostra "JÁ UTILIZADO"
```

### Camadas e arquivos

| Camada | Arquivo | Observação |
|---|---|---|
| Banco | `supabase/migrations/20261031_payments_v1.sql` | **Não aplicada.** Tabelas `kiosk_payments`, `payments`, `payment_orders`, `payment_events`, `payments_oauth_states`; coluna `kiosks.payments_enabled` (default `false`); RLS ligada e sem policy; funções `SECURITY DEFINER` |
| Edge | `supabase/functions/{create-payment,payment-status,payment-webhook,payments-oauth}/index.ts` | **Não publicadas.** Só o `Deno.serve`; a lógica está em `_shared/handlers.ts` |
| Provedor | `_shared/types.ts` (interface `PaymentProvider`), `mercadopago.ts`, `mock.ts`, `registry.ts` | Interface `PaymentProvider`; `mock` só existe com `PAYMENTS_ALLOW_MOCK=1` |
| Cifra | `_shared/crypto.ts` | AES-256-GCM dos tokens OAuth, com AAD = id do negócio |
| Front | `payments-boot.js` (sempre, sem rede), `payments.js` (cliente, só com a flag), `payments-staff.js` (dono/garçom), `mesa-qr.js` (QR por mesa), `vendor/qrcode-generator-1.4.4.js` (MIT, QR local) | Nenhum onclick inline; texto dinâmico com `esc()` |
| Testes | `tests/payments/` | Ver seção 9 |

### Regras de segurança implementadas

| Ameaça | Defesa |
|---|---|
| Cliente adultera o valor | O corpo da requisição só traz negócio, mesa, método e chave de idempotência. O valor é `Σ quantidade × preço` dos **itens no banco**, de pedidos **aceitos pela equipe**, calculado em `payment_prepare`. Se o total do pedido divergir dos itens (ou não houver itens), a cobrança é **recusada** (falha fechada). Tetos: R$ 50.000 por cobrança |
| Webhook falso | Assinatura HMAC validada **antes** de qualquer acesso ao banco; sem assinatura = 401 |
| Webhook verdadeiro porém com corpo mentiroso | O corpo só informa o id; o servidor **consulta o provedor** com o token do negócio dono da cobrança e confere referência (`external_reference` = id da cobrança), moeda (BRL) e valor exato |
| Pagamento de outro negócio | O token usado na consulta é sempre o do negócio dono da cobrança; um pagamento criado em outra conta não é visível com esse token. Comprovante de outro negócio não valida (resposta idêntica a "não encontrado") |
| Webhook repetido / corrida | `payment_settle` trava a linha (`FOR UPDATE`) e é idempotente; um pedido só pode estar em um pagamento ativo (índice único parcial em `payment_orders`) |
| Criação duplicada | Chave de idempotência única por negócio; segunda cobrança para a mesma mesa é recusada enquanto há uma em andamento |
| Pagamento tardio (depois de expirar) | Aceito, marcado `late_payment` e `needs_review` para conferência/estorno manual |
| Valor pago diferente | Não liquida; marca `needs_review` |
| Token do comprovante | 192 bits aleatórios; o banco guarda só o SHA-256; QR não contém dados pessoais, valor, mesa nem nome |
| Tokens do provedor | Cifrados (AES-GCM) na Edge Function; chave só em variável de ambiente; nunca no navegador |
| Acesso direto às tabelas | Nenhum privilégio para `anon`/`authenticated`; funções de dinheiro só executam para `service_role` |
| Abuso | Rate limit por IP (hash) e por negócio na criação; limite de tentativas de token no status; CORS restrito a recebaa.com.br |
| XSS | `esc()` em todo texto dinâmico; QR gerado localmente (nada sai para serviços de terceiros) |
| Kill switch | `PAYMENTS_GLOBAL_ENABLED` (variável do Supabase) desliga tudo na hora; `admin_set_payments_access(…, false)` trava um negócio |
| PCI | Cartão **nunca** passa pelo Recebaa: redirecionamento ao checkout hospedado. O front não tem campo de cartão (há teste automatizado) |

---

## 3. Flag por negócio (desligada por padrão) e liberação em duas travas

1. **Plataforma libera** o negócio (beta): `invited = true` em `kiosk_payments`. Sem isso o dono nem enxerga a opção.
2. **Dono conecta** a conta do Mercado Pago (OAuth) e **liga** em "Pagamentos online" (aba Guarda-sóis/Mesas do painel). Só liga se estiver conectado e liberado.
3. `kiosks.payments_enabled` (pública, inofensiva) é a flag que o app lê sem requisição extra. O servidor **reconfere tudo** em `payment_prepare`; a flag no navegador é só para exibir o botão.
4. `staff_write` **não** inclui `payments_enabled` na lista de colunas (testado): nem dono nem admin conseguem ligar por ali; só `set_payments_settings`.

Liberar um negócio (SQL, como administrador, depois de aplicar a migração):

```sql
insert into public.kiosk_payments (kiosk_id, invited) values ('<id do negócio>', true)
on conflict (kiosk_id) do update set invited = true, platform_blocked = false;
```

Travar (desliga na hora): `update public.kiosk_payments set invited=false, platform_blocked=true where kiosk_id='…'; update public.kiosks set payments_enabled=false where id='…';`

---

## 4. QR Code por mesa

Como era: um único QR por negócio (`?kiosk=<id>`); o cliente digitava o número do guarda-sol/mesa. O app já aceitava `?umbrella=<n>` (só preenchia o campo).

Agora:

- Link da mesa: `https://recebaa.com.br/?kiosk=<id>&umbrella=<n>` (alias `&mesa=<n>`). Com os dois parâmetros o app **abre direto o cardápio da mesa** (mudança de 1 linha no `load` do `index.html`). Se a mesa não existir ou estiver inativa, o fluxo atual mostra o erro de sempre.
- **Retrocompatível:** QR já impressos (`?kiosk=<id>`) continuam funcionando exatamente como antes.
- Tela do dono: na aba Guarda-sóis/Mesas aparece "📱 QR Code de cada mesa" → "Imprimir QR das mesas": uma folha com um cartão por mesa ativa (nome do negócio, **"Mesa 07"** / "Guarda-sol 07" em destaque, QR e link), filtro por faixa (`1-10, 15`) e impressão. O QR é gerado no navegador e é decodificável (teste decodifica cada QR com jsQR).
- Esta tela **não depende da flag de pagamentos**: é um recurso à parte.
- Limite conhecido: o número da mesa não é segredo (quem souber o link pode abrir qualquer mesa). Se isso virar problema (pedidos de brincadeira), a fase 2 é um token opaco por mesa (`umbrellas.qr_token`), mantendo o link antigo aceito até o dono reimprimir.

---

## 5. O que o DONO precisa fazer por fora (passo a passo)

1. **Conta Mercado Pago do Recebaa** (CPF/CNPJ do titular do Recebaa) e, em *Mercado Pago Developers*, **criar uma aplicação** do tipo Marketplace/Checkout Pro. Anotar `Client ID` e `Client Secret` (**só** para o painel de segredos do Supabase; nunca em chat, e-mail ou repositório).
2. Na aplicação: cadastrar a **URL de redirecionamento OAuth** = `https://ifhfacpeskslhumctgpr.supabase.co/functions/v1/payments-oauth` e a **URL de notificações (webhook)** = `https://ifhfacpeskslhumctgpr.supabase.co/functions/v1/payment-webhook` (eventos: *Pagamentos*). Copiar a **chave secreta do webhook** (`MP_WEBHOOK_SECRET`).
3. Criar **usuários de teste** (vendedor e comprador) e usar as **credenciais de teste** primeiro. Só depois de homologar, pedir à Mercado Pago a **ativação das credenciais de produção** (aceite de termos, dados da empresa; pode ser exigida validação da aplicação para Marketplace).
4. Gerar a chave de cifra dos tokens: `openssl rand -base64 32` → `PAYMENTS_TOKEN_KEY`.
5. Cadastrar os segredos no Supabase (Dashboard → Edge Functions → Secrets, ou CLI). Lista completa na seção 6.
6. **Revisar com advogado/contador**: Termos de Uso, Política de Privacidade, textos da landing (seção 7), enquadramento regulatório e tributário (seção 8). Não ativar antes.
7. Aplicar a migração (`20261031_payments_v1.sql`) primeiro em um **branch do Supabase** ou projeto de teste.
8. Publicar as Edge Functions (seção 6) e testar no sandbox com um negócio-piloto: liberar (seção 3), conectar a conta de teste, ligar, pagar com Pix de teste e cartão de teste, conferir o webhook e o comprovante.
9. Escolher um **estabelecimento-piloto**, conversar com ele sobre taxas do provedor, prazo de liberação do cartão, emissão de nota e chargeback (a responsabilidade é do estabelecimento) e só então ligar em produção para ele.
10. Definir quem dá **suporte** (pagamento feito e não reconhecido, estorno, cobrança duplicada). Telas de apoio: "Pagamentos recentes" (marca "conferir" nos casos tardios/valor divergente).

---

## 6. Ativação técnica (somente depois do passo 5)

Segredos (nomes exatos; **valores só no Supabase**):

| Variável | Para quê |
|---|---|
| `PAYMENTS_GLOBAL_ENABLED` | `1` liga o sistema; qualquer outro valor = tudo responde 503 (kill switch) |
| `PAYMENTS_PROVIDER` | `mercadopago` |
| `MP_CLIENT_ID`, `MP_CLIENT_SECRET` | Aplicação Marketplace |
| `MP_WEBHOOK_SECRET` | Chave secreta de assinatura dos webhooks |
| `MP_REDIRECT_URI` | Igual à URL cadastrada na aplicação (`…/functions/v1/payments-oauth`) |
| `MP_SANDBOX` | `1` enquanto usar credenciais de teste (usa o `sandbox_init_point` e marca a conexão como teste) |
| `PAYMENTS_TOKEN_KEY` | 32 bytes em base64 (cifra dos tokens OAuth) |
| `PAYMENTS_APP_BASE_URL` | `https://recebaa.com.br` |
| `PAYMENTS_FUNCTIONS_BASE_URL` | opcional; padrão `${SUPABASE_URL}/functions/v1` |
| `PAYMENTS_APP_FEE_PERCENT` | opcional, padrão 0 (não cobrar taxa da plataforma sem validação tributária) |
| `PAYMENTS_TTL_MINUTES` | opcional, padrão 20 (validade do Pix/checkout) |
| `PAYMENTS_IP_SALT` | opcional, sal do hash de IP do rate limit |
| `PAYMENTS_PAYER_EMAIL` | opcional; e-mail genérico enviado ao provedor no Pix (evita coletar e-mail do cliente) |
| `PAYMENTS_ALLOW_MOCK`, `PAYMENTS_MOCK_SECRET` | **somente** em ambiente de teste. Nunca em produção |

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já são injetadas pelo Supabase nas Edge Functions.

Publicação (apenas depois de revisar):

```bash
supabase functions deploy create-payment payment-status           # JWT padrão (a chave pública do app serve)
supabase functions deploy payment-webhook payments-oauth --no-verify-jwt   # chamadas vindas do Mercado Pago/navegador do dono, sem JWT
```

Rollback rápido: `PAYMENTS_GLOBAL_ENABLED=0` (some o fluxo sem redeploy) e/ou `update kiosks set payments_enabled=false`.

### CSP (`vercel.json`)

**Nenhuma alteração é necessária** com a arquitetura escolhida: o cartão usa checkout hospedado por **redirecionamento** (navegação não é restringida pela CSP), as chamadas vão para o próprio host do Supabase (`connect-src` já o permite) e os QR são `data:`/SVG inline gerados localmente. Se um dia o cartão passar a usar o *Bricks/SDK* na página, será preciso liberar `script-src`/`frame-src`/`connect-src` para `sdk.mercadopago.com`/`*.mercadopago.com` (e isso aumenta o escopo PCI). Para Pix e cartão (Mercado Pago) isso continua valendo. **Para as carteiras (Stripe) o `vercel.json` MUDA neste PR — ver seção 12.5.**

---

## 7. O que a landing, os termos e a política de privacidade vão exigir (NÃO alterado neste PR)

Hoje afirmam que o Recebaa **não processa pagamentos**. Se o gateway for ativado para qualquer negócio, estes textos ficam incorretos e precisam mudar **antes**:

- `index.html` ~linha 879: "O pagamento vai direto ao negócio, por Pix, maquininha ou dinheiro."
- `index.html` ~linha 898: "O Recebaa não cobra nem processa pagamentos. O cliente paga direto ao estabelecimento…" (texto de marketing da landing)
- `index.html` ~linhas 4848–4851 (termos/privacidade embutidos no app): "O pagamento é combinado e realizado diretamente com o negócio — o Recebaa não processa pagamentos", "Não pedimos dados de pagamento…" e a cláusula 6 (cobrança/reembolso diretamente com o negócio).
- `terms.html` linhas ~111, 128 e 141 ("Pagamentos entre cliente final e negócio ocorrem fora da plataforma…") — incluir: o pagamento online é processado pelo Mercado Pago, que recebe em nome do estabelecimento; o Recebaa não é parte da venda nem custodia valores; estorno e disputa são entre cliente, estabelecimento e provedor; indisponibilidades; comprovante em QR.
- `privacy.html`: novos dados/tratamentos (registro do pagamento: valor, mesa, método, status, datas, id no provedor; **nenhum dado de cartão, nome ou CPF do pagador é guardado pelo Recebaa**); o Mercado Pago como controlador/operador independente dos dados de pagamento do pagador, com link para a política dele; base legal (execução de contrato); retenção (registros financeiros por prazo legal, sem dado pessoal direto); IP em *hash* temporário para antifraude/rate limit (apagado em até 1 dia).
- Detalhe de interface: o modal "Pedir a conta" já tem um botão "💳 Pagar tudo" que **só pede a conta ao garçom**. Com o pagamento online ligado, os dois rótulos convivem ("Pagar agora" vs "Pagar tudo"); sugerimos renomear o antigo para "Chamar o garçom para fechar".
- Se for cobrada taxa da plataforma (`application_fee`), explicitar nos termos e no contrato com o estabelecimento.

---

## 8. Riscos legais, fiscais e regulatórios (checklist para revisão profissional)

- **Instituição de pagamento (BACEN)**: o desenho evita que o Recebaa receba ou retenha recursos de terceiros (o estabelecimento é o recebedor, via OAuth). Isso precisa ser **confirmado por parecer jurídico**, principalmente se houver `application_fee` (taxa da plataforma) ou se um dia houver split/antecipação.
- **LGPD**: dados do pagador ficam no provedor; o Recebaa guarda só o necessário (valor, mesa, status). Atualizar política, registro das operações de tratamento e contrato com operadores. Atenção ao e-mail do pagador exigido pelo Pix no provedor: usamos um e-mail genérico configurável.
- **PCI DSS**: sem tocar em número de cartão (checkout hospedado). Mantido pelos testes e pela revisão: nenhum campo de cartão, nenhum token de cartão no front.
- **Tributação/fiscal**: a venda é do estabelecimento (emissão de cupom/nota é dele); a receita do Recebaa continua sendo a mensalidade (e a taxa, se houver, que exige NFS-e e enquadramento). Confirmar com contador: retenções do provedor, informes/DIMP, tratamento do "serviço 10%" (arrecadação pelo estabelecimento).
- **Consumidor (CDC)**: cobrança indevida, estorno, arrependimento, chargeback — responsabilidade do estabelecimento perante o cliente; o Recebaa deve oferecer o histórico (já há "Pagamentos recentes") e canal de suporte.
- **Termos entre Recebaa e estabelecimento**: ônus de taxas, prazos de liberação, chargeback, bloqueio de conta pelo provedor, descredenciamento.
- **Gorjeta/serviço**: o painel permite configurar 0/5/10/12%. O encerramento manual atual (`closeUmbrellaSession`) pode adicionar 10% sobre o total: se o cliente já pagou o serviço online, a equipe **não deve** aplicar de novo (ver riscos técnicos).

---

## 9. Testes (rodados com o provedor MOCK; nenhum dinheiro, nenhuma credencial)

```bash
cd tests/payments
npm install
npm test            # unit + banco + handlers + E2E no navegador (Chromium/Playwright), cerca de 3 min
npm run test:unit   # sem navegador
```

Cobertura (resumo): valor adulterado ignorado (corpo da requisição e divergência no banco); webhook sem assinatura/com assinatura errada/corpo adulterado rejeitado; webhook repetido não duplica; pagamento de pedido/mesa de outro negócio recusado; token de comprovante inválido (aleatório, adulterado, vazio, de outro negócio, não pago, do cliente) não valida; flag desligada = nenhum elemento `rpay-*`, nenhum script de pagamento carregado, nenhuma Edge Function chamada e o botão "Pedir a conta" intacto; tabelas e funções de dinheiro inacessíveis para `anon`; migrações reais (hardening + pedidos privados + pagamentos) aplicadas em Postgres real (PGlite); assinatura do Mercado Pago, formato das requisições e cifra de tokens (unitários); QR de cada mesa decodificado com jsQR; fluxo Pix completo no navegador.

O que **não** foi (nem pode ser) testado sem credenciais reais: a API real do Mercado Pago (formato exato das respostas, regras de `application_fee`, valores mínimos de Pix/cartão, fuso de `date_of_expiration`), o OAuth real, o webhook real (formato da assinatura conforme documentação — **validar no sandbox**), o checkout hospedado real e o retorno `back_urls`, Edge Functions rodando em Deno no Supabase (a lógica roda em Node nos testes com os mesmos módulos), Realtime (usamos polling), a migração aplicada no banco real (testada em PGlite com o esquema reconstruído a partir dos metadados de produção; aplicar antes em um branch).

Carteiras (Stripe) — testes adicionais com a **Stripe falsa** (`fake-stripe.mjs`: `api.stripe.com` em memória que respeita `Stripe-Account`, `Idempotency-Key` e assinatura `t=,v1=`; e um `stripe.js` falso no navegador): fluxo carteira -> webhook assinado -> pago -> comprovante -> validação; assinatura inválida/ausente/expirada/do futuro/corpo adulterado (401); valor adulterado ignorado; webhook repetido (`already_paid`); PaymentIntent de outra conta com o mesmo `pid` não liquida; valor recebido diferente vai para revisão; Stripe fora do ar = 502 (reenvio); reembolso inverte; flag das carteiras desligada = **nenhum** `wallet.js`/`stripe.js`/`wallet-config` e nenhuma UI nova; navegador sem carteira provável (Firefox) = stripe.js nem é baixado; carteira indisponível = sem botão; recusa = cancela e não cobra; `vercel.json` (CSP, Permissions-Policy, regra do Apple Pay).

---

## 10. Pontos de ancoragem no `index.html` (para rebase/cherry-pick)

Mudanças mínimas e isoladas, todas marcadas com `[pagamentos]`:

1. `<script src="/payments-boot.js"></script>` logo após o script do EmailJS (carrega 2 KB, sem rede).
2. No `window.addEventListener('load', …)` que lê `?kiosk`: `var umbNum = urlParams.get('umbrella') || urlParams.get('mesa');` e, dentro de `if(kioskId){ showScreen('client', …) }`, uma linha que chama `goToMenu()` quando há `umbNum` numérico.
3. Em `goToMenu()`, depois de `maybeShowPromoPopup();`: `if(window.RecebaaPay) RecebaaPay.clientReady(currentKiosk, window._umb);`
4. No fim de `renderMyOrders()`, depois de `el.innerHTML=html;`: `if(window.RecebaaPay) RecebaaPay.afterMyOrders(el);`
5. No fim de `renderUmbrellas()`, depois de `grid.innerHTML = qrSection + filterBar + umbHtml;`: `if(window.RecebaaPay) RecebaaPay.afterUmbrellas(grid, umbs, currentKiosk);`

Se a limpeza em paralelo mudar esses trechos, basta reaplicar as 5 linhas acima. Todo o resto vive em arquivos separados.

---

## 11. Riscos técnicos conhecidos e decisões pendentes

1. **Preço unitário vem do cliente em `place_order`** (já era assim, antes deste PR): o servidor confia no `unit_price` enviado ao criar o pedido. Mitigações já presentes aqui: só pedidos **aceitos pela equipe** entram na cobrança, e total ≠ soma dos itens é recusado. Recomendação independente: fazer `place_order` recalcular o preço pelo cadastro de `products` (inclusive promoção e opções).
2. **A equipe ainda precisa "Encerrar conta"** no fluxo atual; o pagamento online **não** altera os pedidos nem encerra a mesa (para não mexer no fluxo existente). Fase 2: marcar como `billed`/encerrar automaticamente quando `payments.status = 'paid'` cobrir todo o consumo.
3. **Serviço 10% em duplicidade**: se o cliente pagar online com serviço configurado e a equipe aplicar 10% ao encerrar, haverá cobrança dupla. Orientar a equipe ou desligar a taxa online.
4. **Novos pedidos durante um pagamento em andamento** só entram em outra cobrança depois que a primeira termina/expira (por segurança contra cobrança dupla).
5. **Pagamento tardio/valor divergente** ficam marcados para revisão manual; não há tela de estorno (feito no painel do Mercado Pago).
6. **Provedor mock em memória**: serve para testes e `functions serve` local, não para produção (e é recusado sem `PAYMENTS_ALLOW_MOCK=1`).
7. **Retenção**: `payment_events` e `payments` não têm rotina de expurgo (definir prazo com o contador/jurídico).
8. **Dependência do `login_attempts`** para rate limit (tabela já existente) — ela é limpa a cada 1 dia.
9. Observação fora do escopo: a CSP atual (`script-src` sem `cdn.jsdelivr.net`) bloqueia o carregamento do `jsQR` usado pelo leitor de QR do cliente (`index.html` ~linha 3397). Vale conferir em produção.
10. Compatibilidade do TypeScript das Edge Functions: escrito com extensões `.ts` explícitas (Deno) e sem recursos que o Node não remova; validar o `deploy` no Supabase.

---

## 12. Carteiras Apple Pay e Google Pay via Stripe (adicional ao Mercado Pago)

### 12.1 Decisão e escopo
- **Mercado Pago continua** sendo o único provedor de **Pix** e **cartão** (seções 1 a 11).
- **Stripe entra somente para as carteiras** (Apple Pay e Google Pay). A Stripe **não** processa Pix nem o checkout de cartão aqui: o código recusa qualquer método diferente de `wallet` nesse provedor (e o Mercado Pago recusa `wallet`).
- Flag separada por negócio: `kiosks.wallets_enabled` (padrão `false`). Só pode ser ligada se: (1) `payments_enabled` estiver ligada, (2) o negócio estiver **liberado pela plataforma** (`kiosk_payments.invited`, não bloqueado) e (3) o dono tiver **conectado a conta Stripe**. Uma restrição no banco (`kiosks_wallets_need_payments`) impede `wallets_enabled = true` com `payments_enabled = false`. Desligar os pagamentos, desconectar ou o bloqueio pela plataforma desligam as carteiras. `staff_write` não consegue alterar a flag.
- Kill switch global: `PAYMENTS_GLOBAL_ENABLED` continua valendo para tudo; sem `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`STRIPE_PUBLISHABLE_KEY` o provedor não existe e `create-payment` responde 503 para `wallet`.

### 12.2 Desenho: Stripe Connect com *direct charges*
- O dono conecta a **própria** conta Stripe (OAuth do Connect, ação `start_wallet` em `payments-oauth`; o `state` leva o prefixo `stripe.`). Guardamos **apenas o id da conta conectada** (`acct_...`) em `kiosk_payments.stripe_account_id`; nenhum token do estabelecimento é guardado.
- O PaymentIntent é criado **na conta do estabelecimento** (cabeçalho `Stripe-Account`) com a chave secreta da plataforma. O dinheiro vai para o estabelecimento; o Recebaa não custodia nem repassa. Sem `application_fee_amount` por padrão (`PAYMENTS_APP_FEE_PERCENT`, mesma cautela tributária).
- **Servidor**: valor calculado no banco (mesma `payment_prepare`), `Idempotency-Key` = id do pagamento, `payment_method_types[]=card` (Apple Pay/Google Pay trafegam como cartão tokenizado pela carteira), `metadata[pid]` = **id opaco** (nenhum nome, mesa, e-mail ou CPF).
- **Webhook**: endpoint próprio `payment-webhook?provider=stripe`. Verifica `Stripe-Signature` (`t=` e `v1=`, HMAC-SHA256 de `t.corpo`, comparação em tempo constante, **tolerância de 300 s** configurável) **antes** de tocar no banco; depois **reconsulta o PaymentIntent na API** (com a conta gravada no pagamento, nunca a do evento) e só então liquida via `payment_settle` (idempotente, valor exato, referência externa = `pid`). Eventos de `charge.*` sem metadata são resolvidos por `payment_find_by_ref`. PaymentIntent de outra conta devolve 404 e não liquida.
- **Front** (`wallet.js`): carregado só por `payments.js` e só quando o servidor diz `wallets_available`. Pré-checagem sem rede (Apple Pay no Safari/iOS, ou Chrome/Chromium/Android; Firefox não). Só então busca a configuração (`wallet-config`: chave **publicável** + conta conectada) e carrega `https://js.stripe.com/v3/` sob demanda. Usa o **Express Checkout Element** (intent adiado: `mode: 'payment'`, `currency: 'brl'`), apenas `applePay` e `googlePay`; o botão **só aparece** quando o evento `ready` informa que uma das carteiras está realmente disponível. No `confirm`: valida o elemento, cria o pagamento no servidor, `confirmPayment(... redirect: 'if_required')` e acompanha o status por polling até o comprovante em QR (mesmo comprovante e mesma validação pela equipe do Pix; o método aparece como `wallet`).
- Segredos só em `Deno.env`. Só a chave publicável vai para o navegador.

### 12.3 PENDÊNCIA ABERTA (bloqueante para ligar em produção): Stripe Connect com contas brasileiras
**Não está confirmado** que a Stripe permita, para estabelecimentos **brasileiros**, o modelo Connect com *direct charges* e repasse direto para a conta do estabelecimento (nem em quais tipos de conta: Standard/Express/Custom). Esta implementação **assume** Connect Standard com OAuth e direct charges; se a Stripe disser que não, o desenho das carteiras precisa mudar (ou o escopo ser cancelado). **O dono deve perguntar à Stripe (suporte/vendas) e validar por escrito:**
1. A plataforma (Recebaa, CNPJ no Brasil) pode ter conta **Connect** e conectar contas de **estabelecimentos brasileiros**? Em quais tipos (Standard / Express / Custom) e com quais requisitos de KYC/contrato?
2. *Direct charges* em conta conectada brasileira em **BRL** são suportadas? O liquidante é o próprio estabelecimento (sem passar pela plataforma)?
3. **Apple Pay e Google Pay** estão habilitados para contas conectadas brasileiras e para o Express Checkout Element em BRL?
4. **Repasse (payout)**: prazo, conta bancária do estabelecimento no Brasil, antecipação, reservas/retenções.
5. **Tarifas**: tarifa por transação de carteira/cartão no Brasil, tarifa adicional de Connect (se houver), tarifa por *payout*, cobrança de estorno/disputa.
6. **Registro de domínio do Apple Pay para contas conectadas**: o domínio `recebaa.com.br` precisa ser registrado **por conta conectada** (API com `Stripe-Account` ou painel) ou basta o da plataforma? Isto **não está implementado** no código por não ter sido possível validar; se for por conta conectada, é preciso adicionar uma etapa ao fluxo de conexão.
7. Responsabilidade por **chargeback/disputa** (em *direct charges* costuma ser da conta conectada) e o que isso exige nos contratos.
8. Se o Connect OAuth (Standard) está disponível para novas plataformas ou se a Stripe exige o *Account Links* (onboarding hospedado) — ajustaria `payments-oauth`.
9. Enquadramento regulatório: confirmar com assessoria que a plataforma, neste desenho, continua sem custodiar recursos (seção 8).

### 12.4 Tarifas (apenas ordem de grandeza — **validar** com a Stripe e com o Mercado Pago)
- Cartão/carteira no Brasil costuma custar algo na casa de **3% a 4% + uma tarifa fixa de centavos** por transação; Pix costuma ser **bem menor, na casa de ~1%**. Connect pode ter tarifas adicionais. Estes números **não foram confirmados** e mudam; usar apenas para a conversa com o estabelecimento-piloto. A tarifa é do estabelecimento (conta dele), não do Recebaa, salvo `application_fee`.

### 12.5 CSP, Permissions-Policy e verificação do Apple Pay (`vercel.json`, somente neste PR)
- `script-src` += `https://js.stripe.com`; `connect-src` += `https://api.stripe.com https://m.stripe.network`; `frame-src` (novo) = `https://js.stripe.com https://hooks.stripe.com https://m.stripe.network`; `img-src` += `https://*.stripe.com`. Demais diretivas inalteradas (`default-src 'self'`, `frame-ancestors 'none'`).
- `Permissions-Policy`: `payment=()` virou `payment=(self "https://js.stripe.com")` (com `payment=()` a Payment Request API ficaria bloqueada e o botão nunca apareceria).
- **Não testado em navegador real:** pode ser necessário liberar mais algum domínio do Google Pay (por exemplo `https://pay.google.com`) quando o Express Checkout carregar a folha do Google Pay. Testar no ambiente de teste com o console aberto procurando violações de CSP, **antes** de ligar a qualquer negócio.
- **Apple Pay – arquivo de verificação:** `.well-known/apple-developer-merchantid-domain-association` é um **PLACEHOLDER** (texto avisando que não é o arquivo real). `vercel.json` serve esse caminho como `text/plain` e não há redirect/rewrite no projeto. O dono deve **substituir o conteúdo** pelo arquivo oficial baixado da Stripe (não editar). Nenhum arquivo falso foi inventado.

### 12.6 O que o DONO faz por fora (carteiras)
1. Criar/validar a **conta Stripe da plataforma** (CNPJ do Recebaa), ativar o **Connect** e fazer as perguntas da seção 12.3. **Não ligar nada antes das respostas.**
2. No Connect, obter o `client_id` do OAuth (`ca_...`) e cadastrar a URL de redirecionamento = `https://ifhfacpeskslhumctgpr.supabase.co/functions/v1/payments-oauth`.
3. Cadastrar o endpoint de webhook: `https://ifhfacpeskslhumctgpr.supabase.co/functions/v1/payment-webhook?provider=stripe`, eventos: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `payment_intent.processing`, `payment_intent.requires_action`, `charge.refunded`, `charge.dispute.created`. Se o Connect exigir, criar o endpoint como **de contas conectadas**. Copiar o segredo de assinatura.
4. Cadastrar os segredos no Supabase (**nunca** em chat/e-mail/repositório): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY` (a publicável pode ir ao front, mas é servida por `wallet-config`), `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_REDIRECT_URI` (igual à URL do passo 2) e, opcional, `STRIPE_WEBHOOK_TOLERANCE_SEC` (padrão 300). Comece com as **chaves de teste**.
5. **Apple Pay:** registrar `recebaa.com.br` (Stripe Dashboard -> Settings -> Payment methods -> Apple Pay -> Add new domain, e conforme a resposta da pergunta 6 da seção 12.3 também para cada conta conectada), baixar o arquivo de verificação, **substituir** o placeholder `.well-known/apple-developer-merchantid-domain-association`, publicar o site e só então clicar em *Verify*.
6. Aplicar a migração `20261101_payments_wallets_v1.sql` (depois da `20261031`) primeiro em branch/projeto de teste.
7. Publicar as funções: `supabase functions deploy wallet-config` (JWT padrão), e **republicar** `create-payment payment-status` e `payment-webhook payments-oauth --no-verify-jwt` (os arquivos compartilhados mudaram).
8. Piloto: liberar o negócio, ligar Pix/cartão, conectar a conta Stripe de teste, ligar as carteiras, pagar com carteira em um celular real (iPhone/Safari e Android/Chrome) usando cartão de teste na carteira, conferir webhook, comprovante e a validação pela equipe.
9. Rollback: `PAYMENTS_GLOBAL_ENABLED=0` ou `update kiosks set wallets_enabled=false`.

### 12.7 O que os Termos e a Política de Privacidade vão exigir (NÃO alterado neste PR)
- Além do Mercado Pago, a **Stripe** (Stripe Payments Brasil / entidade aplicável) passa a ser **operador/controlador independente** dos dados de pagamento feitos por carteira; citar na Política de Privacidade (finalidade, base legal, transferência internacional se aplicável, link da política da Stripe) e nos Termos (processamento por Stripe quando o cliente usa Apple Pay/Google Pay; Apple e Google como provedoras das carteiras; estorno/disputa conforme a Stripe).
- Registro que o Recebaa guarda para carteiras: valor, mesa, método `wallet`, status, datas, id do PaymentIntent e id da conta conectada. **Nenhum dado de cartão ou da carteira.** Cookies/armazenamento: a Stripe pode gravar identificadores no navegador ao carregar `stripe.js` (antifraude); avaliar o aviso de cookies.
- Mesmos textos da seção 7 (landing/termos embutidos no app) continuam precisando de revisão antes de ativar.

### 12.8 O que NÃO foi testado (precisa de credenciais/ambiente reais)
API real da Stripe (formatos, erros, `Idempotency-Key`, busca por metadata), Connect/OAuth reais para conta brasileira, Apple Pay e Google Pay reais (inclui a verificação de domínio), `stripe.js`/Express Checkout reais (os testes usam um `stripe.js` falso), CSP e Permissions-Policy em navegador real e na Vercel, entrega real de webhooks e janela de tolerância com relógio real, Edge Functions no runtime Deno.
