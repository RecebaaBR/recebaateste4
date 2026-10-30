// BR Code Pix estático (EMV® QRCPS-MPM) — "copia e cola" gerado NO SERVIDOR, sem gateway.
// Referência: Manual de Padrões para Iniciação do Pix (Banco Central). CRC16/CCITT-FALSE (poly 0x1021, init 0xFFFF).
// Campos: 00 formato | 01 método (11 = estático reutilizável) | 26 conta (GUI br.gov.bcb.pix + chave) | 52 MCC | 53 moeda 986
//         | 54 valor | 58 país | 59 beneficiário (<=25) | 60 cidade (<=15) | 62 dados adicionais (05 = txid <=25) | 63 CRC.
// PENDENTE de validação em apps de bancos reais (docs/pagamentos.md, seção 13).

export function crc16(s: string): string {
  let crc = 0xFFFF;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
const tlv = (id: string, v: string) => id + String(v.length).padStart(2, '0') + v;

/** texto do BR Code: ASCII maiúsculo, sem acento nem símbolos (mesma regra do banco) */
export function pixText(v: string, max: number): string {
  const t = v.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/ +/g, ' ').trim().slice(0, max).trim();
  return t;
}

export interface BrCodeInput { key: string; name: string; city: string; amountCents: number; txid: string }

export function buildBrCode(i: BrCodeInput): string {
  if (!Number.isInteger(i.amountCents) || i.amountCents <= 0 || i.amountCents > 5_000_000) throw new Error('valor inválido');
  if (!i.key || i.key.length > 77 || /[^\x21-\x7E]/.test(i.key)) throw new Error('chave inválida');
  const name = pixText(i.name, 25), city = pixText(i.city, 15);
  if (!name || !city) throw new Error('beneficiário/cidade inválidos');
  const txid = i.txid.replace(/[^A-Za-z0-9]/g, '').slice(0, 25);      // identificador da conta (somente alfanumérico)
  if (!txid) throw new Error('txid inválido');
  const amount = (i.amountCents / 100).toFixed(2);
  const body =
    tlv('00', '01') + tlv('01', '11') +
    tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('01', i.key)) +
    tlv('52', '0000') + tlv('53', '986') + tlv('54', amount) + tlv('58', 'BR') +
    tlv('59', name) + tlv('60', city) + tlv('62', tlv('05', txid)) + '6304';
  return body + crc16(body);
}

/** Decodifica e VALIDA um BR Code (usado nos testes e como checagem de sanidade antes de entregar ao cliente). */
export function parseBrCode(code: string): { ok: boolean; fields: Record<string, string>; merchant: Record<string, string>; extra: Record<string, string>; crcOk: boolean } {
  const read = (s: string) => { const out: Record<string, string> = {}; let p = 0; while (p + 4 <= s.length) { const id = s.slice(p, p + 2), len = Number(s.slice(p + 2, p + 4)); if (!Number.isInteger(len) || p + 4 + len > s.length) return null; out[id] = s.slice(p + 4, p + 4 + len); p += 4 + len; } return p === s.length ? out : null; };
  const f = read(code); if (!f) return { ok: false, fields: {}, merchant: {}, extra: {}, crcOk: false };
  const crcOk = code.length > 8 && code.slice(-8, -4) === '6304' && code.slice(-4) === crc16(code.slice(0, -4));
  return { ok: !!f['00'], fields: f, merchant: read(f['26'] || '') || {}, extra: read(f['62'] || '') || {}, crcOk };
}
