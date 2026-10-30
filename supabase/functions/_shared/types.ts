// Tipos compartilhados das Edge Functions de pagamento.
// Obs.: escrito para rodar em Deno (Supabase) e em Node >= 22 (testes, com type stripping) — sem enums/namespaces.

export interface RpcError { message: string; code?: string }
export interface Db {
  rpc(name: string, args?: Record<string, unknown>): Promise<{ data: any; error: RpcError | null }>;
}

/** Credenciais do ESTABELECIMENTO (vendedor) no provedor. O dinheiro cai direto nesta conta. */
export interface Seller { accountId: string; accessToken: string }

export interface ChargeInput {
  paymentId: string;          // nosso id (vai como external_reference)
  method: 'pix' | 'card' | 'wallet' | 'pix_direct';
  amountCents: number;        // calculado no servidor
  description: string;
  notificationUrl: string;
  backUrl: string;
  expiresAt: Date;
  feeCents: number;           // taxa da plataforma (0 por padrão)
  payerEmail: string;
}
export interface ChargeResult { providerRef: string; pixCopyPaste?: string; checkoutUrl?: string; clientSecret?: string }

export type NormalizedStatus = 'paid' | 'pending' | 'failed' | 'refunded';
export interface ProviderPayment {
  providerPaymentId: string;
  status: NormalizedStatus;
  amountCents: number;
  currency: string;
  externalReference: string | null;
}

export interface OAuthTokens { accountId: string; accessToken: string; refreshToken: string; expiresInSec: number }

/** Interface do provedor: trocar de provedor = implementar isto. */
export interface PaymentProvider {
  name: 'mercadopago' | 'mock' | 'stripe' | 'direct';
  createCharge(seller: Seller, input: ChargeInput): Promise<ChargeResult>;
  /** Consulta o pagamento NO PROVEDOR (fonte da verdade). null = não existe/não é deste vendedor. */
  fetchPayment(seller: Seller, providerPaymentId: string): Promise<ProviderPayment | null>;
  /** Procura pagamentos pela nossa referência (para atualizar sem webhook e para o cartão, cujo id só nasce no checkout). */
  searchByReference(seller: Seller, externalReference: string): Promise<ProviderPayment | null>;
  cancelCharge(seller: Seller, providerRef: string, method: 'pix' | 'card' | 'wallet' | 'pix_direct'): Promise<boolean>;
  /** Valida a ASSINATURA do webhook. Não confia no conteúdo; só diz se veio do provedor e qual id consultar. */
  verifyWebhook(input: { headers: Headers; url: URL; rawBody: string }): Promise<{ valid: boolean; topic?: string; providerPaymentId?: string; paymentId?: string }>;
  oauthAuthorizeUrl?(state: string): string;
  oauthExchange?(code: string): Promise<OAuthTokens>;
  oauthRefresh?(refreshToken: string): Promise<OAuthTokens>;
}

export class ProviderError extends Error {
  retryable: boolean;
  constructor(message: string, retryable = true) { super(message); this.retryable = retryable; }
}

export interface TokenCrypto {
  encrypt(plain: string, aad: string): Promise<string>;
  decrypt(blob: string, aad: string): Promise<string>;
}

export interface Deps {
  db: Db;
  env: (key: string) => string | undefined;
  providers: Record<string, PaymentProvider>;
  crypto: TokenCrypto;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  now?: () => number;
  /** só sandbox: livro-razão do provedor mock (usado por mock_approve) */
  mockLedger?: { approve(ref: string, paidCents?: number): void };
}
