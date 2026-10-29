-- Registro de chamadas do pedido por voz (usado só para limitar o uso diário por quiosque).
-- Rode uma vez no SQL Editor do Supabase.
create table if not exists public.voice_order_log (
  id bigint generated always as identity primary key,
  kiosk_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists voice_order_log_kiosk_created_idx
  on public.voice_order_log (kiosk_id, created_at desc);

-- Só a função (service role) acessa esta tabela; ninguém mais, nem pelo app.
alter table public.voice_order_log enable row level security;
