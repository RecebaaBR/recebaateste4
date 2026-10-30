-- ============ RECEBAA: hardening de segurança ============
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------- 1. dados privados fora da tabela pública ----------
create table if not exists public.kiosk_private (
  kiosk_id uuid primary key references public.kiosks(id) on delete cascade,
  owner_email text,
  owner_name text,
  phone text,
  owner_doc text,
  password text,
  waiter_pin text
);
alter table public.kiosk_private enable row level security;

insert into public.kiosk_private(kiosk_id, owner_email, owner_name, phone, owner_doc, password, waiter_pin)
select id, owner_email, owner_name, phone, owner_doc, password, waiter_pin from public.kiosks
on conflict (kiosk_id) do nothing;

create unique index if not exists kiosk_private_email_uq on public.kiosk_private (lower(owner_email));

alter table public.kiosks
  drop column if exists owner_email, drop column if exists owner_name, drop column if exists phone,
  drop column if exists owner_doc, drop column if exists password, drop column if exists waiter_pin;

-- ---------- 2. sessões e limite de tentativas ----------
create table if not exists public.app_sessions (
  token_hash text primary key,
  role text not null check (role in ('admin','kiosk','waiter')),
  kiosk_id uuid,
  subject_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists app_sessions_subject_idx on public.app_sessions(subject_id);
alter table public.app_sessions enable row level security;

create table if not exists public.login_attempts (
  id bigserial primary key,
  bucket text not null,
  created_at timestamptz not null default now()
);
create index if not exists login_attempts_idx on public.login_attempts(bucket, created_at);
alter table public.login_attempts enable row level security;

create or replace function private.rate_limited(p_bucket text, p_max int, p_window interval)
returns boolean language sql security definer set search_path = public as $$
  select count(*) >= p_max from public.login_attempts where bucket = p_bucket and created_at > now() - p_window
$$;

create or replace function private.rate_hit(p_bucket text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.login_attempts(bucket) values (p_bucket);
  delete from public.login_attempts where created_at < now() - interval '1 day';
end $$;

create or replace function private.new_session(p_role text, p_kiosk uuid, p_subject uuid, p_ttl interval)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare tok text;
begin
  tok := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.app_sessions(token_hash, role, kiosk_id, subject_id, expires_at)
  values (encode(extensions.digest(tok, 'sha256'), 'hex'), p_role, p_kiosk, p_subject, now() + p_ttl);
  delete from public.app_sessions where expires_at < now();
  return tok;
end $$;

create or replace function private.get_session(p_token text)
returns public.app_sessions language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  select * into s from public.app_sessions
   where token_hash = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex') and expires_at > now();
  if not found then
    raise exception 'Sessão expirada. Faça login novamente.' using errcode = '28000';
  end if;
  return s;
end $$;

-- sessão de dono ou garçom ativo, de negócio ativo
create or replace function private.staff_session(p_token text)
returns public.app_sessions language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; ok boolean;
begin
  s := private.get_session(p_token);
  if s.role = 'admin' then raise exception 'Acesso negado' using errcode = '42501'; end if;
  select (k.is_active and not coalesce(k.blocked,false)) into ok from public.kiosks k where k.id = s.kiosk_id;
  if not coalesce(ok,false) then raise exception 'Negócio inativo ou bloqueado' using errcode = '42501'; end if;
  if s.role = 'waiter' then
    select w.is_active into ok from public.waiters w where w.id = s.subject_id;
    if not coalesce(ok,false) then raise exception 'Acesso do garçom desativado' using errcode = '42501'; end if;
  end if;
  return s;
end $$;

-- ---------- 3. remove funções antigas inseguras ----------
drop function if exists public.reset_kiosk_password(text, text);
drop function if exists public.change_kiosk_password(uuid, text, text);
drop function if exists public.login_kiosk(text, text);
drop function if exists public.login_waiter(text, text);
drop function if exists public.login_admin(text, text);
drop function if exists public.register_kiosk(text, text, text, text, text, text, text, text);
drop function if exists public.register_waiter(uuid, text, text, text, boolean);
drop function if exists public.list_waiters(uuid);
drop function if exists public.set_waiter_active(uuid, boolean);
drop function if exists public.set_waiter_menu_permission(uuid, boolean);
drop function if exists public.delete_waiter(uuid);

-- ---------- 4. logins ----------
create or replace function public.login_kiosk(p_email text, p_password text)
returns table(id uuid, name text, owner_email text, owner_name text, phone text, city text, beach text, owner_doc text,
              is_active boolean, blocked boolean, approved boolean, created_at timestamptz, business_type text, logo_url text, token text)
language plpgsql security definer set search_path = public, extensions as $$
declare b text := 'login:' || lower(coalesce(p_email,'')); kid uuid;
begin
  if private.rate_limited(b, 8, interval '15 minutes') then
    raise exception 'Muitas tentativas. Aguarde 15 minutos e tente novamente.';
  end if;
  select kp.kiosk_id into kid from public.kiosk_private kp
   where lower(kp.owner_email) = lower(p_email) and kp.password = crypt(p_password, kp.password);
  if kid is null then
    perform private.rate_hit(b);
    return;
  end if;
  delete from public.login_attempts la where la.bucket = b;
  return query
    select k.id, k.name, kp.owner_email, kp.owner_name, kp.phone, k.city, k.beach, kp.owner_doc,
           k.is_active, k.blocked, k.approved, k.created_at, k.business_type, k.logo_url,
           case when k.is_active and not coalesce(k.blocked,false) and coalesce(k.approved,true)
                then private.new_session('kiosk', k.id, k.id, interval '3 days') else null end
      from public.kiosks k join public.kiosk_private kp on kp.kiosk_id = k.id where k.id = kid;
end $$;

create or replace function public.login_waiter(p_email text, p_password text)
returns table(id uuid, kiosk_id uuid, name text, email text, is_active boolean, can_edit_menu boolean, token text)
language plpgsql security definer set search_path = public, extensions as $$
declare b text := 'loginw:' || lower(coalesce(p_email,'')); wid uuid;
begin
  if private.rate_limited(b, 8, interval '15 minutes') then
    raise exception 'Muitas tentativas. Aguarde 15 minutos e tente novamente.';
  end if;
  select w.id into wid from public.waiters w
   where lower(w.email) = lower(p_email) and w.password = crypt(p_password, w.password);
  if wid is null then
    perform private.rate_hit(b);
    return;
  end if;
  delete from public.login_attempts la where la.bucket = b;
  return query
    select w.id, w.kiosk_id, w.name, w.email, w.is_active, w.can_edit_menu,
           case when w.is_active then private.new_session('waiter', w.kiosk_id, w.id, interval '3 days') else null end
      from public.waiters w where w.id = wid;
end $$;

create or replace function public.login_admin(p_email text, p_password text)
returns table(id uuid, email text, name text, is_active boolean, token text)
language plpgsql security definer set search_path = public, extensions as $$
declare b text := 'logina:' || lower(coalesce(p_email,'')); aid uuid;
begin
  if private.rate_limited(b, 5, interval '15 minutes') then
    raise exception 'Muitas tentativas. Aguarde 15 minutos e tente novamente.';
  end if;
  select a.id into aid from public.admins a
   where lower(a.email) = lower(p_email) and a.is_active = true and a.password = crypt(p_password, a.password);
  if aid is null then
    perform private.rate_hit(b);
    return;
  end if;
  delete from public.login_attempts la where la.bucket = b;
  return query
    select a.id, a.email, a.name, a.is_active, private.new_session('admin', null, a.id, interval '8 hours')
      from public.admins a where a.id = aid;
end $$;

create or replace function public.logout_session(p_token text)
returns void language sql security definer set search_path = public, extensions as $$
  delete from public.app_sessions where token_hash = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex');
$$;

-- ---------- 5. cadastro ----------
create or replace function public.register_kiosk(
  p_name text, p_owner_email text, p_owner_name text, p_password text, p_phone text,
  p_city text, p_beach text, p_owner_doc text, p_business_type text default 'quiosque')
returns table(id uuid, name text, owner_email text, owner_name text, phone text, city text, beach text, owner_doc text,
              is_active boolean, blocked boolean, approved boolean, created_at timestamptz, business_type text, logo_url text, token text)
language plpgsql security definer set search_path = public, extensions as $$
declare new_id uuid; em text := lower(trim(coalesce(p_owner_email,''))); bt text;
begin
  if private.rate_limited('register:global', 200, interval '1 hour') or private.rate_limited('register:' || em, 3, interval '1 hour') then
    raise exception 'Muitos cadastros em pouco tempo. Tente novamente mais tarde.';
  end if;
  perform private.rate_hit('register:global');
  perform private.rate_hit('register:' || em);

  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(em) > 120 then raise exception 'E-mail inválido'; end if;
  if length(trim(coalesce(p_name,''))) < 2 or length(p_name) > 80 then raise exception 'Nome do negócio inválido'; end if;
  if length(coalesce(p_owner_name,'')) > 80 or length(coalesce(p_phone,'')) > 30
     or length(coalesce(p_city,'')) > 60 or length(coalesce(p_beach,'')) > 60 or length(coalesce(p_owner_doc,'')) > 30 then
    raise exception 'Dados inválidos';
  end if;
  if length(coalesce(p_password,'')) < 6 or length(p_password) > 72 then raise exception 'Senha inválida'; end if;
  if exists (select 1 from public.kiosk_private kp where lower(kp.owner_email) = em) then
    raise exception 'E-mail já cadastrado';
  end if;
  bt := case when p_business_type in ('quiosque','bar_restaurante') then p_business_type else 'quiosque' end;

  insert into public.kiosks(name, city, beach, business_type, is_active, blocked, approved)
  values (trim(p_name), p_city, p_beach, bt, true, false, true) returning kiosks.id into new_id;
  insert into public.kiosk_private(kiosk_id, owner_email, owner_name, phone, owner_doc, password)
  values (new_id, em, p_owner_name, p_phone, p_owner_doc, crypt(p_password, gen_salt('bf')));

  return query
    select k.id, k.name, kp.owner_email, kp.owner_name, kp.phone, k.city, k.beach, kp.owner_doc,
           k.is_active, k.blocked, k.approved, k.created_at, k.business_type, k.logo_url,
           private.new_session('kiosk', k.id, k.id, interval '3 days')
      from public.kiosks k join public.kiosk_private kp on kp.kiosk_id = k.id where k.id = new_id;
end $$;

-- ---------- 6. garçons (somente dono) ----------
create or replace function private.owner_session(p_token text)
returns public.app_sessions language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.staff_session(p_token);
  if s.role <> 'kiosk' then raise exception 'Apenas o responsável pelo negócio pode fazer isso' using errcode = '42501'; end if;
  return s;
end $$;

create or replace function public.list_waiters(p_token text)
returns table(id uuid, name text, email text, is_active boolean, can_edit_menu boolean, created_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.owner_session(p_token);
  return query select w.id, w.name, w.email, w.is_active, w.can_edit_menu, w.created_at
    from public.waiters w where w.kiosk_id = s.kiosk_id order by w.created_at desc;
end $$;

create or replace function public.register_waiter(p_token text, p_name text, p_email text, p_password text, p_can_edit_menu boolean default false)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; em text := lower(trim(coalesce(p_email,'')));
begin
  s := private.owner_session(p_token);
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido'; end if;
  if length(trim(coalesce(p_name,''))) < 2 or length(p_name) > 80 then raise exception 'Nome inválido'; end if;
  if length(coalesce(p_password,'')) < 6 or length(p_password) > 72 then raise exception 'Senha inválida (mínimo 6 caracteres)'; end if;
  if exists (select 1 from public.waiters w where lower(w.email) = em) or exists (select 1 from public.kiosk_private kp where lower(kp.owner_email) = em) then
    raise exception 'E-mail já cadastrado';
  end if;
  insert into public.waiters(kiosk_id, name, email, password, can_edit_menu)
  values (s.kiosk_id, trim(p_name), em, crypt(p_password, gen_salt('bf')), coalesce(p_can_edit_menu,false));
end $$;

create or replace function public.set_waiter_active(p_token text, p_waiter_id uuid, p_active boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.owner_session(p_token);
  update public.waiters w set is_active = p_active where w.id = p_waiter_id and w.kiosk_id = s.kiosk_id;
  if not p_active then delete from public.app_sessions a where a.subject_id = p_waiter_id and a.role = 'waiter'; end if;
end $$;

create or replace function public.set_waiter_menu_permission(p_token text, p_waiter_id uuid, p_can_edit_menu boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.owner_session(p_token);
  update public.waiters w set can_edit_menu = p_can_edit_menu where w.id = p_waiter_id and w.kiosk_id = s.kiosk_id;
end $$;

create or replace function public.delete_waiter(p_token text, p_waiter_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.owner_session(p_token);
  delete from public.waiters w where w.id = p_waiter_id and w.kiosk_id = s.kiosk_id;
  delete from public.app_sessions a where a.subject_id = p_waiter_id and a.role = 'waiter';
end $$;

-- ---------- 7. gravações da equipe (substitui escrita direta) ----------
create or replace function public.staff_write(p_token text, p_table text, p_op text, p_ids uuid[] default null, p_data jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  s public.app_sessions; kid uuid; adm boolean; allowed text[]; item jsonb; cols text[]; collist text; setlist text;
  res jsonb; one jsonb; n int; menu_ok boolean;
begin
  s := private.get_session(p_token);
  adm := (s.role = 'admin');
  if p_op not in ('insert','update','delete') then raise exception 'Operação inválida'; end if;

  -- ----- kiosks: dono altera o próprio cadastro; admin altera status de qualquer um -----
  if p_table = 'kiosks' then
    if p_op <> 'update' then raise exception 'Operação inválida'; end if;
    if adm then
      allowed := array['is_active','blocked','approved','name','city','beach','business_type','allow_direct_orders','google_review_url','logo_url','selected_plan','trial_ends_at','plan_payment_status'];
    else
      s := private.owner_session(p_token);
      allowed := array['name','city','beach','logo_url','business_type','allow_direct_orders','google_review_url'];
      if p_ids is null or p_ids <> array[s.kiosk_id] then raise exception 'Acesso negado' using errcode='42501'; end if;
    end if;
    cols := array(select k from jsonb_object_keys(coalesce(p_data,'{}'::jsonb)) k where k = any(allowed));
    if coalesce(array_length(cols,1),0) = 0 then raise exception 'Nada para atualizar'; end if;
    select string_agg(format('%1$I = r.%1$I', c), ', ') into setlist from unnest(cols) c;
    execute format('update public.kiosks x set %s from jsonb_populate_record(null::public.kiosks, $1) r where x.id = any($2)', setlist)
      using p_data, p_ids;
    get diagnostics n = row_count;
    return jsonb_build_object('count', n);
  end if;

  if adm then raise exception 'Acesso negado' using errcode='42501'; end if;
  s := private.staff_session(p_token);
  kid := s.kiosk_id;

  -- ----- order_items: apenas remover item de pedido do próprio negócio -----
  if p_table = 'order_items' then
    if p_op <> 'delete' then raise exception 'Operação inválida'; end if;
    delete from public.order_items oi using public.orders o
     where oi.id = any(p_ids) and o.id = oi.order_id and o.kiosk_id = kid;
    get diagnostics n = row_count;
    return jsonb_build_object('count', n);
  end if;

  -- ----- orders: atualizar status/total -----
  if p_table = 'orders' then
    if p_op <> 'update' then raise exception 'Operação inválida'; end if;
    allowed := array['status','last_updated_by','total','service_amount','notes'];
    cols := array(select k from jsonb_object_keys(coalesce(p_data,'{}'::jsonb)) k where k = any(allowed));
    if coalesce(array_length(cols,1),0) = 0 then raise exception 'Nada para atualizar'; end if;
    select string_agg(format('%1$I = r.%1$I', c), ', ') into setlist from unnest(cols) c;
    execute format('update public.orders x set %s from jsonb_populate_record(null::public.orders, $1) r where x.id = any($2) and x.kiosk_id = $3', setlist)
      using p_data, p_ids, kid;
    get diagnostics n = row_count;
    return jsonb_build_object('count', n);
  end if;

  -- ----- cardápio e guarda-sóis -----
  if p_table not in ('products','categories','umbrellas') then raise exception 'Tabela inválida'; end if;
  if p_table in ('products','categories') and s.role = 'waiter' then
    select w.can_edit_menu into menu_ok from public.waiters w where w.id = s.subject_id;
    if not coalesce(menu_ok,false) then raise exception 'Sem permissão para editar o cardápio' using errcode='42501'; end if;
  end if;
  allowed := case p_table
    when 'products' then array['category_id','name','description','price','image_url','emoji','is_available','sort_order','cost_price','options','promo_price','promo_limit','promo_sold','promo_active']
    when 'categories' then array['name','emoji','sort_order','is_active']
    else array['number','label','area','is_active'] end;

  if p_op = 'delete' then
    execute format('delete from public.%I x where x.id = any($1) and x.kiosk_id = $2', p_table) using p_ids, kid;
    get diagnostics n = row_count;
    return jsonb_build_object('count', n);
  end if;

  if p_op = 'update' then
    cols := array(select k from jsonb_object_keys(coalesce(p_data,'{}'::jsonb)) k where k = any(allowed));
    if coalesce(array_length(cols,1),0) = 0 then raise exception 'Nada para atualizar'; end if;
    if p_table = 'products' and p_data ? 'category_id' and p_data->>'category_id' is not null
       and not exists (select 1 from public.categories c where c.id = (p_data->>'category_id')::uuid and c.kiosk_id = kid) then
      raise exception 'Categoria inválida';
    end if;
    select string_agg(format('%1$I = r.%1$I', c), ', ') into setlist from unnest(cols) c;
    execute format('update public.%1$I x set %2$s from jsonb_populate_record(null::public.%1$I, $1) r where x.id = any($2) and x.kiosk_id = $3', p_table, setlist)
      using p_data, p_ids, kid;
    get diagnostics n = row_count;
    return jsonb_build_object('count', n);
  end if;

  -- insert (objeto ou lista de objetos)
  res := '[]'::jsonb;
  for item in select * from jsonb_array_elements(case when jsonb_typeof(p_data) = 'array' then p_data else jsonb_build_array(p_data) end) loop
    cols := array(select k from jsonb_object_keys(item) k where k = any(allowed));
    if p_table = 'products' and item ? 'category_id' and item->>'category_id' is not null
       and not exists (select 1 from public.categories c where c.id = (item->>'category_id')::uuid and c.kiosk_id = kid) then
      raise exception 'Categoria inválida';
    end if;
    if coalesce(array_length(cols,1),0) = 0 then
      execute format('insert into public.%1$I (kiosk_id) values ($1) returning to_jsonb(%1$I.*)', p_table) into one using kid;
    else
      select string_agg(quote_ident(c), ', ') into collist from unnest(cols) c;
      execute format('insert into public.%1$I (kiosk_id, %2$s) select $1, %2$s from jsonb_populate_record(null::public.%1$I, $2) returning to_jsonb(%1$I.*)', p_table, collist)
        into one using kid, item;
    end if;
    res := res || jsonb_build_array(one);
  end loop;
  return case when jsonb_typeof(p_data) = 'array' then res else res->0 end;
end $$;

-- ---------- 8. admin ----------
create or replace function public.admin_list_kiosks(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.get_session(p_token);
  if s.role <> 'admin' then raise exception 'Acesso negado' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(k) || jsonb_build_object(
      'owner_email', kp.owner_email, 'owner_name', kp.owner_name, 'phone', kp.phone, 'owner_doc', kp.owner_doc)
      order by k.created_at desc)
    from public.kiosks k left join public.kiosk_private kp on kp.kiosk_id = k.id), '[]'::jsonb);
end $$;

create or replace function public.admin_reset_kiosk_password(p_token text, p_kiosk_id uuid, p_new_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.get_session(p_token);
  if s.role <> 'admin' then raise exception 'Acesso negado' using errcode='42501'; end if;
  if length(coalesce(p_new_password,'')) < 6 or length(p_new_password) > 72 then raise exception 'Senha inválida (mínimo 6 caracteres)'; end if;
  update public.kiosk_private kp set password = crypt(p_new_password, gen_salt('bf')) where kp.kiosk_id = p_kiosk_id;
  delete from public.app_sessions a where a.kiosk_id = p_kiosk_id;
end $$;

-- ---------- 9. ações públicas mínimas do cliente ----------
create or replace function public.promo_adjust(p_product_id uuid, p_delta int)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare d int := greatest(-100, least(100, coalesce(p_delta,0)));
begin
  update public.products p set
    promo_sold = greatest(0, coalesce(p.promo_sold,0) + d),
    promo_active = case
      when d > 0 and p.promo_limit is not null and coalesce(p.promo_sold,0) + d >= p.promo_limit then false
      when d < 0 and p.promo_price is not null and p.promo_limit is not null
           and coalesce(p.promo_sold,0) >= p.promo_limit
           and greatest(0, coalesce(p.promo_sold,0) + d) < p.promo_limit then true
      else p.promo_active end
  where p.id = p_product_id;
end $$;

create or replace function public.cancel_account_order(p_kiosk_id uuid, p_umbrella text)
returns void language sql security definer set search_path = public, extensions as $$
  update public.orders o set status = 'cancelled'
   where o.kiosk_id = p_kiosk_id and o.umbrella_num = p_umbrella and o.customer_name = 'PEDIDO DE CONTA' and o.status = 'pending';
$$;

-- ---------- 10. permissões de tabela e RLS ----------
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.kiosks, public.categories, public.products, public.umbrellas, public.orders, public.order_items to anon;
grant insert on public.orders, public.order_items to anon;

create policy kiosks_read on public.kiosks for select to anon using (true);
create policy categories_read on public.categories for select to anon using (true);
create policy products_read on public.products for select to anon using (true);
create policy umbrellas_read on public.umbrellas for select to anon using (true);
create policy orders_read on public.orders for select to anon using (true);
create policy order_items_read on public.order_items for select to anon using (true);
create policy orders_insert on public.orders for insert to anon with check (
  exists (select 1 from public.kiosks k where k.id = kiosk_id and k.is_active and not coalesce(k.blocked,false)));
create policy order_items_insert on public.order_items for insert to anon with check (
  exists (select 1 from public.orders o where o.id = order_id));

-- funções: ninguém executa por padrão; libera só o necessário para o app
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.login_kiosk(text,text), public.login_waiter(text,text), public.login_admin(text,text),
  public.logout_session(text),
  public.register_kiosk(text,text,text,text,text,text,text,text,text),
  public.list_waiters(text), public.register_waiter(text,text,text,text,boolean),
  public.set_waiter_active(text,uuid,boolean), public.set_waiter_menu_permission(text,uuid,boolean), public.delete_waiter(text,uuid),
  public.staff_write(text,text,text,uuid[],jsonb),
  public.admin_list_kiosks(text), public.admin_reset_kiosk_password(text,uuid,text),
  public.promo_adjust(uuid,int), public.cancel_account_order(uuid,text)
to anon;

-- ---------- 11. storage: sem apagar arquivos de terceiros; só imagens pequenas ----------
drop policy if exists allow_delete on storage.objects;
drop policy if exists anon_delete_product_images on storage.objects;
update storage.buckets set file_size_limit = 3145728,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif']
 where id = 'product-images';
