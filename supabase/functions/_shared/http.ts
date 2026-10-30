// Utilidades HTTP: CORS restrito e respostas JSON. Nada aqui registra dados pessoais.
export function allowedOrigins(env: (k: string) => string | undefined): string[] {
  const base = env('PAYMENTS_APP_BASE_URL') || 'https://recebaa.com.br';
  const extra = (env('PAYMENTS_ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean);
  const list = new Set<string>([base, 'https://recebaa.com.br', 'https://www.recebaa.com.br', ...extra]);
  return [...list];
}
export function corsHeaders(req: Request, env: (k: string) => string | undefined): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const ok = allowedOrigins(env).includes(origin);
  const h: Record<string, string> = {
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Max-Age': '600',
  };
  if (ok) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}
export async function readJson(req: Request, maxBytes = 8192): Promise<any | null> {
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try { const v = JSON.parse(text); return (v && typeof v === 'object') ? v : null; } catch { return null; }
}
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
