# Rascunho: Termos e Política de Privacidade para pagamentos

**Status:** rascunho para revisão do dono e de um advogado. Não é parecer jurídico. NADA disto foi aplicado em `terms.html`, `privacy.html` nem na landing. Só publicar antes de qualquer negócio ligar pagamentos.

## Decisões do dono (30/10/2026)
1. **Pix direto:** dono e garçom podem dar baixa. Registrar autor, papel e hora. Testar o código em pelo menos 2 bancos antes de ligar.
2. **Checkout obrigatório por pedido:** disponível para um **negócio piloto**, e só depois que o gateway real estiver funcionando. Padrão continua "opcional".
3. **Termos e Privacidade:** este rascunho; revisão do dono (e advogado) antes de ativar.

## A. Termos de Uso: substituir o final da cláusula 8
Texto atual a ser trocado: "Pagamentos entre cliente final e negócio ocorrem fora da plataforma e são de responsabilidade exclusiva das partes."

**Proposta (nova cláusula 8.1 "Pagamentos entre cliente e negócio"):**
> O Recebaa não é instituição financeira, não guarda dinheiro de clientes nem dos negócios. O pagamento do cliente é sempre feito ao próprio negócio, por um dos meios que ele habilitar: (a) fora da plataforma (maquininha, dinheiro, Pix); (b) por Pix direto para a chave Pix informada pelo negócio; ou (c) por provedores de pagamento terceiros (Mercado Pago e Stripe) conectados à conta do negócio, quando o negócio ativar essa opção.
>
> **Pix direto.** O Recebaa apenas gera o código de pagamento com a chave informada pelo negócio. O Recebaa não confirma nem concilia esse pagamento: a confirmação é feita pelo estabelecimento, que registra a baixa manualmente. O negócio é o único responsável por conferir o recebimento e por eventual erro, fraude ou baixa indevida feita por seus atendentes.
>
> **Pagamento por provedor.** O processamento, a segurança dos dados de cartão, estornos, disputas (chargeback) e tarifas são de responsabilidade do provedor e do negócio, conforme os termos do provedor. O Recebaa não tem acesso ao número do cartão.
>
> **Comprovante.** O QR code de comprovante serve apenas para o estabelecimento conferir o pagamento no Recebaa. Pode ser usado uma única vez e não substitui nota fiscal ou recibo.
>
> **Checkout obrigatório.** Se o negócio ativar o pagamento obrigatório por pedido, o pedido só é enviado à equipe depois da confirmação do pagamento. Pedidos não pagos em até 30 minutos são descartados. Se o pagamento falhar, o cliente é informado e pode tentar novamente ou cancelar.
>
> **Obrigações fiscais.** Tributos, emissão de nota fiscal e a regularidade da chave Pix informada são de responsabilidade do negócio.

## B. Política de Privacidade
**3. Quais dados coletamos: acrescentar**
- **Chave Pix do negócio** (CPF, CNPJ, e-mail, telefone ou chave aleatória), nome do beneficiário e cidade, informados pelo dono. Esses dados aparecem ao cliente no código Pix e no QR de pagamento.
- **Registros de baixa de pagamento:** nome do atendente (ou "Responsável"), papel, data/hora e observação livre (até 200 caracteres). Orientamos a não digitar dados pessoais do cliente na observação.
- **Dados de transação:** valor, método, estado e identificadores da cobrança no provedor. Não coletamos nem guardamos número de cartão.

**4. Como usamos: acrescentar**
- Chave Pix: receber pagamentos do cliente final pelo negócio (execução do serviço contratado, Art. 7º, V, LGPD).
- Registros de baixa: prova da conferência de pagamento e prevenção a fraude e erro (legítimo interesse, Art. 7º, IX).
- O dono pode remover a chave Pix a qualquer momento nas configurações de Pagamentos.

**5. Com quem compartilhamos: acrescentar (somente quando o negócio ativar)**
- Mercado Pago, para pagamentos por Pix e cartão.
- Stripe, para pagamentos por Apple Pay e Google Pay.
- Esses provedores tratam os dados de pagamento conforme suas próprias políticas, como controladores ou operadores, e devem ser confirmados pelo jurídico.

**6. Retenção: definir**
- Pagamentos e eventos: **prazo a definir com contador/advogado** (sugestão de partida: 5 anos, alinhado ao prazo fiscal já usado para dados do negócio).
- Chave Pix: até o dono remover ou a conta ser encerrada.
- Observação livre da baixa: junto com o registro de pagamento.

## C. Pontos abertos para o advogado
1. Se o modelo exige enquadramento ou autorização no Banco Central (o Recebaa não custodia valores).
2. Papel do Recebaa e dos provedores (controlador/operador) e as cláusulas de transferência internacional da Stripe.
3. Retenção definitiva dos registros de pagamento e de baixa.
4. Responsabilidade por baixa indevida feita por garçom e por chargeback.
5. Atualizar a landing: hoje diz que o Recebaa "não cobra nem processa pagamentos"; com o gateway ativo, ajustar para "o dinheiro vai direto ao negócio; o Recebaa não o guarda".
