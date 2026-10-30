// Edge Function `create-payment` — lógica em ../_shared/handlers.ts.
// NÃO fazer deploy sem seguir docs/pagamentos.md (segredos são variáveis de ambiente do Supabase; nunca no repositório).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleCreatePayment } from '../_shared/handlers.ts';
import { buildDeps } from '../_shared/registry.ts';

const env = (k: string) => Deno.env.get(k);
// service_role é injetada pelo Supabase na Edge Function; fica só aqui (nunca no front).
const db = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const deps = buildDeps(db as any, env);

Deno.serve((req) => handleCreatePayment(req, deps));
