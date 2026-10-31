-- Entrega item a item: cada item do pedido pode ser marcado como entregue separadamente.
alter table public.order_items add column if not exists delivered_at timestamptz;

-- Núcleo (sem token): marca/desmarca itens de um negócio e ajusta o status do pedido.
create or replace function private.deliver_items(p_kiosk uuid, p_item_ids uuid[], p_delivered boolean, p_actor text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare o record; pend int; n int := 0;
begin
  update public.order_items i
     set delivered_at = case when p_delivered then coalesce(i.delivered_at, now()) else null end
    from public.orders x
   where i.id = any(p_item_ids) and x.id = i.order_id and x.kiosk_id = p_kiosk;
  get diagnostics n = row_count;

  for o in select distinct x.id, x.status::text as st from public.orders x
            join public.order_items i on i.order_id = x.id
           where i.id = any(p_item_ids) and x.kiosk_id = p_kiosk loop
    select count(*) into pend from public.order_items i where i.order_id = o.id and i.delivered_at is null;
    if p_delivered and pend = 0 and o.st in ('pending','accepted','preparing','delivering') then
      update public.orders set status = 'delivered', last_updated_by = p_actor where id = o.id;
    elsif (not p_delivered) and o.st = 'delivered' and pend > 0 then
      update public.orders set status = 'delivering', last_updated_by = p_actor where id = o.id;
    else
      update public.orders set last_updated_by = coalesce(p_actor, last_updated_by) where id = o.id; -- dispara evento p/ o cliente
    end if;
  end loop;
  return jsonb_build_object('count', n);
end $$;

-- Núcleo: entrega pedidos inteiros (todos os itens) — usado no Histórico em massa.
create or replace function private.deliver_orders(p_kiosk uuid, p_order_ids uuid[], p_actor text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare n int := 0;
begin
  update public.order_items i set delivered_at = coalesce(i.delivered_at, now())
    from public.orders x
   where x.id = i.order_id and x.id = any(p_order_ids) and x.kiosk_id = p_kiosk
     and x.status::text in ('pending','accepted','preparing','delivering')
     and x.customer_name not in ('PEDIDO DE CONTA','CHAMADA DE ATENDENTE','ENCERRAMENTO');
  update public.orders x set status = 'delivered', last_updated_by = p_actor
   where x.id = any(p_order_ids) and x.kiosk_id = p_kiosk
     and x.status::text in ('pending','accepted','preparing','delivering')
     and x.customer_name not in ('PEDIDO DE CONTA','CHAMADA DE ATENDENTE','ENCERRAMENTO');
  get diagnostics n = row_count;
  return jsonb_build_object('count', n);
end $$;

-- Núcleo: cancela um item (remove da conta e recalcula total e serviço proporcionalmente).
create or replace function private.cancel_item(p_kiosk uuid, p_item_id uuid, p_actor text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare i public.order_items; o public.orders; base numeric; newbase numeric; svc numeric; left_n int; pend int;
begin
  select it.* into i from public.order_items it join public.orders x on x.id = it.order_id
   where it.id = p_item_id and x.kiosk_id = p_kiosk;
  if i.id is null then raise exception 'Item não encontrado'; end if;
  select * into o from public.orders where id = i.order_id;
  if o.status::text in ('cancelled','billed') then raise exception 'Pedido já encerrado'; end if;
  delete from public.order_items where id = i.id;
  base := o.total - coalesce(o.service_amount, 0);
  newbase := greatest(0, base - i.quantity * coalesce(i.unit_price, 0));
  svc := case when base > 0 then round(coalesce(o.service_amount, 0) * newbase / base, 2) else 0 end;
  select count(*), count(*) filter (where delivered_at is null) into left_n, pend from public.order_items where order_id = o.id;
  update public.orders set
      total = round(newbase + svc, 2),
      service_amount = case when o.service_amount is null then null else svc end,
      status = case when left_n = 0 then 'cancelled'
                    when pend = 0 and o.status::text in ('pending','accepted','preparing','delivering') then 'delivered'
                    else status end,
      last_updated_by = p_actor
   where id = o.id;
  return jsonb_build_object('remaining', left_n);
end $$;

create or replace function public.staff_deliver_items(p_token text, p_item_ids uuid[], p_delivered boolean default true, p_actor text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.staff_session(p_token);
  return private.deliver_items(s.kiosk_id, p_item_ids, coalesce(p_delivered, true), left(p_actor, 80));
end $$;

create or replace function public.staff_deliver_orders(p_token text, p_order_ids uuid[], p_actor text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.staff_session(p_token);
  if coalesce(array_length(p_order_ids, 1), 0) > 500 then raise exception 'Muitos pedidos'; end if;
  return private.deliver_orders(s.kiosk_id, p_order_ids, left(p_actor, 80));
end $$;

create or replace function public.staff_cancel_item(p_token text, p_item_id uuid, p_actor text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.staff_session(p_token);
  return private.cancel_item(s.kiosk_id, p_item_id, left(p_actor, 80));
end $$;

revoke all on function private.deliver_items(uuid,uuid[],boolean,text), private.deliver_orders(uuid,uuid[],text), private.cancel_item(uuid,uuid,text) from public, anon;
revoke all on function public.staff_deliver_items(text,uuid[],boolean,text), public.staff_deliver_orders(text,uuid[],text), public.staff_cancel_item(text,uuid,text) from public;
grant execute on function public.staff_deliver_items(text,uuid[],boolean,text), public.staff_deliver_orders(text,uuid[],text), public.staff_cancel_item(text,uuid,text) to anon, authenticated;
