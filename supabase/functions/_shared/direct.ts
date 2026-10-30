// "Provedor" Pix DIRETO: sem gateway e sem dinheiro passando pelo Recebaa. Gera o BR Code estático com a chave do próprio negócio.
// Não há webhook nem consulta: a confirmação é MANUAL pela equipe (função payment_manual_settle no banco).
import type { PaymentProvider, Seller, ChargeInput, ChargeResult } from './types.ts';
import { ProviderError } from './types.ts';
import { buildBrCode } from './brcode.ts';

export function makeDirectPix(): PaymentProvider {
  return {
    name: 'direct',
    async createCharge(seller: Seller, i: ChargeInput): Promise<ChargeResult> {
      if (i.method !== 'pix_direct') throw new ProviderError('Pix direto só gera Pix direto', false);
      let c: { key: string; name: string; city: string };
      try { c = JSON.parse(seller.accountId); } catch { throw new ProviderError('chave Pix não configurada', false); }
      try {
        const code = buildBrCode({ key: c.key, name: c.name, city: c.city, amountCents: i.amountCents, txid: 'RCB' + i.paymentId.replace(/-/g, '').slice(0, 20) });
        return { providerRef: 'direct_' + i.paymentId, pixCopyPaste: code };
      } catch (e) { throw new ProviderError('BR Code: ' + (e as Error).message, false); }
    },
    async fetchPayment() { return null; },            // nada a consultar: a baixa é manual
    async searchByReference() { return null; },
    async cancelCharge() { return true; },
    async verifyWebhook() { return { valid: false }; },
  };
}
