-- Schema BASE de produção (reconstruído dos metadados lidos em 2026-10-30, ANTES das migrações 20261029/20261030).
-- Só para testes locais em PGlite. Não é uma migração.
create schema if not exists extensions;
create extension if not exists pgcrypto schema extensions;
create extension if not exists "uuid-ossp" schema extensions;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public, extensions to anon, authenticated, service_role;
create type public.order_status as enum ('pending','accepted','preparing','delivering','delivered','cancelled','billed');

create table public.kiosks (
  id uuid primary key default extensions.uuid_generate_v4(),
  name text not null, city text, beach text, logo_url text,
  is_active boolean not null default true, created_at timestamptz not null default now(),
  blocked boolean default false, approved boolean default true,
  business_type text not null default 'quiosque' check (business_type in ('quiosque','bar_restaurante')),
  allow_direct_orders boolean not null default true, google_review_url text,
  selected_plan text not null default 'free', trial_ends_at timestamptz, plan_payment_status text not null default 'trial',
  -- legados (removidos pela migração de hardening):
  owner_email text, owner_name text, phone text, owner_doc text, password text, waiter_pin text
);
create table public.categories (id uuid primary key default extensions.uuid_generate_v4(), kiosk_id uuid not null references public.kiosks(id), name text not null, emoji text, sort_order int not null default 0, is_active boolean not null default true);
create table public.products (id uuid primary key default extensions.uuid_generate_v4(), kiosk_id uuid not null references public.kiosks(id), category_id uuid references public.categories(id), name text not null, description text, price numeric not null check (price>=0), image_url text, emoji text, is_available boolean not null default true, sort_order int not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), cost_price numeric, options jsonb default '[]', promo_price numeric, promo_limit int, promo_sold int not null default 0, promo_active boolean not null default false);
create table public.umbrellas (id uuid primary key default extensions.uuid_generate_v4(), kiosk_id uuid not null references public.kiosks(id), number int not null, label text, area text, is_active boolean not null default true);
create table public.orders (
  id uuid primary key default extensions.uuid_generate_v4(), kiosk_id uuid not null references public.kiosks(id),
  umbrella_num text not null, order_number int not null, customer_name text not null, notes text,
  status public.order_status not null default 'pending', total numeric not null check (total>=0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  idempotency_key text, last_updated_by text, created_by text, service_amount numeric not null default 0);
create table public.order_items (
  id uuid primary key default extensions.uuid_generate_v4(), order_id uuid not null references public.orders(id),
  product_name text not null, quantity int not null check (quantity>0), unit_price numeric not null, notes text, emoji text,
  cost_price numeric, product_id uuid, is_promo boolean not null default false);
create table public.admins (id uuid primary key default gen_random_uuid(), email text unique not null, password text not null, name text, is_active boolean default true, created_at timestamptz default now());
create table public.waiters (id uuid primary key default gen_random_uuid(), kiosk_id uuid not null references public.kiosks(id), name text not null, email text not null, password text not null, is_active boolean not null default true, created_at timestamptz not null default now(), can_edit_menu boolean not null default false);
-- stubs do Supabase usados pela migração de hardening
create schema if not exists storage;
create table storage.buckets (id text primary key, file_size_limit bigint, allowed_mime_types text[]);
insert into storage.buckets(id) values ('product-images');
create table storage.objects (id uuid default gen_random_uuid(), bucket_id text, name text);
create publication supabase_realtime;

-- (produção atribui o número do pedido por gatilho quando o cliente manda order_number nulo/omitido)
create or replace function public.trg_order_number() returns trigger language plpgsql as $$
begin
  if new.order_number is null then
    new.order_number := coalesce((select max(o.order_number) from public.orders o where o.kiosk_id = new.kiosk_id), 0) + 1;
  end if;
  return new;
end $$;
create trigger trg_order_number before insert on public.orders for each row execute function public.trg_order_number();
