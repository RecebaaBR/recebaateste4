// Edge Function `wallet-config` — devolve a chave PUBLICÁVEL da Stripe e a conta conectada, só se as carteiras estiverem ligadas.
// NÃO fazer deploy sem seguir docs/pagamentos.md.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleWalletConfig } from '../_shared/handlers.ts';
import { buildDeps } from '../_shared/registry.ts';

const env = (k: string) => Deno.env.get(k);
const db = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const deps = buildDeps(db as any, env);

Deno.serve((req) => handleWalletConfig(req, deps));
