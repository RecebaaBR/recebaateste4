import type { TokenCrypto } from './types.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes: Uint8Array): string { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
export function unb64(s: string): Uint8Array { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
export function toHex(buf: ArrayBuffer | Uint8Array): string { return [...new Uint8Array(buf as ArrayBuffer)].map(b => b.toString(16).padStart(2, '0')).join(''); }

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}
/** Comparação em tempo constante (strings hex/ASCII). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** AES-256-GCM. A chave vem de PAYMENTS_TOKEN_KEY (base64, 32 bytes) — só nas variáveis de ambiente do Supabase. */
export function makeTokenCrypto(keyB64: string | undefined): TokenCrypto {
  let keyPromise: Promise<CryptoKey> | null = null;
  const getKey = () => {
    if (!keyB64) throw new Error('PAYMENTS_TOKEN_KEY ausente');
    const raw = unb64(keyB64);
    if (raw.length !== 32) throw new Error('PAYMENTS_TOKEN_KEY deve ter 32 bytes (base64)');
    return (keyPromise ??= crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
  };
  return {
    async encrypt(plain, aad) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await getKey(), enc.encode(plain));
      return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
    },
    async decrypt(blob, aad) {
      const [v, iv, ct] = String(blob).split('.');
      if (v !== 'v1' || !iv || !ct) throw new Error('formato inválido');
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(aad) }, await getKey(), unb64(ct));
      return dec.decode(pt);
    },
  };
}
