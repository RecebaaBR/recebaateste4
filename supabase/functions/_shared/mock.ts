// Provedor MOCK (sandbox): permite testar todo o fluxo sem dinheiro real e sem credenciais.
// Só é registrado quando PAYMENTS_ALLOW_MOCK=1 (nunca ligar em produção).
import type { PaymentProvider, Seller, ChargeInput, ChargeResult, ProviderPayment } from './types.ts';
import { hmacSha256Hex, timingSafeEqual } from './crypto.ts';

export interface MockCharge { ref: string; paymentId: string; amountCents: number; method: 'pix' | 'card'; status: 'pending' | 'approved' | 'cancelled' | 'refunded' | 'rejected'; paidCents?: number; sellerAccount: string }

/** "Livro-razão" do provedor falso. Em memória (suficiente para testes e para `functions serve` local). */
export class MockLedger {
  charges = new Map<string, MockCharge>();
  approve(ref: string, paidCents?: number) {
    const c = this.charges.get(ref); if (!c) throw new Error('cobrança mock inexistente');
    c.status = 'approved'; c.paidCents = paidCents ?? c.amountCents;
  }
  set(ref: string, patch: Partial<MockCharge>) { const c = this.charges.get(ref); if (!c) throw new Error('cobrança mock inexistente'); Object.assign(c, patch); }
}

function norm(c: MockCharge): ProviderPayment {
  const status = c.status === 'approved' ? 'paid' : c.status === 'refunded' ? 'refunded'
    : (c.status === 'cancelled' || c.status === 'rejected') ? 'failed' : 'pending';
  return { providerPaymentId: c.ref, status, amountCents: c.paidCents ?? c.amountCents, currency: 'BRL', externalReference: c.paymentId };
}

export function makeMockProvider(secret: string, ledger: MockLedger): PaymentProvider {
  return {
    name: 'mock',
    async createCharge(seller: Seller, i: ChargeInput): Promise<ChargeResult> {
      if (i.method === 'wallet' || i.method === 'pix_direct') throw new Error('mock: método de outro provedor');
      const ref = 'mock_' + i.paymentId;
      ledger.charges.set(ref, { ref, paymentId: i.paymentId, amountCents: i.amountCents, method: i.method, status: 'pending', sellerAccount: seller.accountId });
      return i.method === 'pix'
        ? { providerRef: ref, pixCopyPaste: `000201MOCKPIX${i.amountCents}${ref}6304ABCD` }
        : { providerRef: ref, checkoutUrl: `https://sandbox.invalid/checkout/${ref}` };
    },
    async fetchPayment(seller, id) {
      const c = ledger.charges.get(id);
      if (!c || c.sellerAccount !== seller.accountId) return null;   // pagamento de outro vendedor não é visível com este token
      return norm(c);
    },
    async searchByReference(seller, ext) {
      for (const c of ledger.charges.values()) if (c.paymentId === ext && c.sellerAccount === seller.accountId) return norm(c);
      return null;
    },
    async cancelCharge(seller, ref) {
      const c = ledger.charges.get(ref);
      if (!c || c.sellerAccount !== seller.accountId || c.status === 'approved') return false;
      c.status = 'cancelled'; return true;
    },
    async verifyWebhook({ headers, rawBody }) {
      const sig = headers.get('x-mock-signature') || '';
      const expected = await hmacSha256Hex(secret, rawBody);
      if (!sig || !timingSafeEqual(sig, expected)) return { valid: false };
      let body: any; try { body = JSON.parse(rawBody); } catch { return { valid: false }; }
      return { valid: true, topic: String(body?.type ?? ''), providerPaymentId: body?.data?.id != null ? String(body.data.id) : undefined };
    },
  };
}

/** Helper de teste: monta o webhook como o "provedor mock" enviaria. */
export async function signMockWebhook(secret: string, ref: string, extra: Record<string, unknown> = {}) {
  const body = JSON.stringify({ type: 'payment', data: { id: ref }, ...extra });
  return { body, signature: await hmacSha256Hex(secret, body) };
}
