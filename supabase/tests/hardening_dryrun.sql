do $t$
declare
  r text := ''; t1 text; t2 text; tw text; ta text; kid uuid; other_kid uuid; cat jsonb; prod jsonb; pid uuid; cid uuid;
  n int; j jsonb; e text; oid uuid; wid uuid; i int; rec record;
begin
  select id into other_kid from public.kiosks limit 1;
  insert into public.admins(email,password,name,is_active) values ('adm@t.com', crypt('Adm!n123', gen_salt('bf')), 'Adm', true);
  set local role anon;

  begin perform 1 from public.kiosk_private; r := r || 'FAIL kiosk_private legível; '; exception when others then r := r || 'ok kiosk_private bloqueado; '; end;
  begin execute 'select password from public.kiosks limit 1'; r := r || 'FAIL password em kiosks; '; exception when others then r := r || 'ok sem coluna password; '; end;
  begin perform 1 from public.admins; r := r || 'FAIL admins legível; '; exception when others then r := r || 'ok admins bloqueado; '; end;
  begin perform 1 from public.waiters; r := r || 'FAIL waiters legível; '; exception when others then r := r || 'ok waiters bloqueado; '; end;
  begin update public.kiosks set blocked=false; r := r || 'FAIL update kiosks; '; exception when others then r := r || 'ok update kiosks bloqueado; '; end;
  begin delete from public.products; r := r || 'FAIL delete products; '; exception when others then r := r || 'ok delete products bloqueado; '; end;
  begin execute 'select public.reset_kiosk_password(''a@b.c'',''x'')'; r := r || 'FAIL reset existe; '; exception when others then r := r || 'ok reset removida; '; end;

  -- cadastro
  select x.token, x.id into t1, kid from public.register_kiosk('Teste Kiosk','T@X.com','Dono','Senh@123','11999999999','Santos','Gonzaga','12345678900','quiosque') x;
  r := r || case when t1 is not null then 'ok register; ' else 'FAIL register; ' end;
  begin perform * from public.register_kiosk('Outro','t@x.com','D','Senh@123','1','a','b','1'); r := r || 'FAIL email duplicado; '; exception when others then r := r || 'ok dup bloqueado; '; end;
  select count(*) into n from public.login_kiosk('t@x.com','errada');
  r := r || case when n=0 then 'ok login errado vazio; ' else 'FAIL login errado; ' end;
  select x.token into t2 from public.login_kiosk('t@x.com','Senh@123') x;
  r := r || case when t2 is not null then 'ok login; ' else 'FAIL login; ' end;

  -- cardápio
  cat := public.staff_write(t1,'categories','insert',null,'[{"name":"Bebidas","emoji":"🍺","sort_order":1,"kiosk_id":"00000000-0000-0000-0000-000000000000"}]');
  cid := (cat->0->>'id')::uuid;
  r := r || case when (cat->0->>'kiosk_id')::uuid = kid then 'ok categoria kiosk_id forçado; ' else 'FAIL kiosk_id; ' end;
  prod := public.staff_write(t1,'products','insert',null, jsonb_build_object('name','Cerveja','price',12.5,'category_id',cid,'emoji','🍺','is_available',true,'sort_order',1));
  pid := (prod->>'id')::uuid;
  r := r || case when pid is not null then 'ok produto criado; ' else 'FAIL produto; ' end;
  j := public.staff_write(t1,'products','update',array[pid],'{"price":15,"is_available":false,"kiosk_id":"00000000-0000-0000-0000-000000000000"}');
  r := r || 'upd=' || (j->>'count') || '; ';
  begin perform public.staff_write(t1,'products','insert',null, jsonb_build_object('name','X','category_id',(select id from public.categories where kiosk_id=other_kid limit 1))); r := r || 'FAIL categoria de outro; '; exception when others then r := r || 'ok categoria alheia bloqueada; '; end;
  j := public.staff_write(t1,'products','update',(select array_agg(id) from public.products where kiosk_id=other_kid),'{"price":0.01}');
  r := r || case when (j->>'count')::int=0 then 'ok produto alheio intocado; ' else 'FAIL alterou alheio; ' end;
  j := public.staff_write(t1,'umbrellas','insert',null,'{"number":7,"label":"7"}');
  r := r || case when j->>'id' is not null then 'ok guarda-sol; ' else 'FAIL umbrella; ' end;

  -- kiosks
  begin perform public.staff_write(t1,'kiosks','update',array[other_kid],'{"name":"hack"}'); r := r || 'FAIL kiosk alheio; '; exception when others then r := r || 'ok kiosk alheio bloqueado; '; end;
  perform public.staff_write(t1,'kiosks','update',array[kid],'{"name":"Novo Nome","approved":false,"blocked":true,"is_active":false}');
  select k.name, k.approved, k.blocked, k.is_active into rec from public.kiosks k where k.id=kid;
  r := r || case when rec.name='Novo Nome' and rec.approved and not rec.blocked and rec.is_active then 'ok owner só campos permitidos; ' else 'FAIL campos admin pelo dono: '||rec::text||'; ' end;

  -- pedidos
  insert into public.orders(kiosk_id, umbrella_num, customer_name, status, total) values (kid,'7','Cli','pending',10) returning id into oid;
  insert into public.order_items(order_id, product_name, quantity, unit_price) values (oid,'Cerveja',1,10);
  begin update public.orders set status='delivered' where id=oid; r := r || 'FAIL update direto pedido; '; exception when others then r := r || 'ok update pedido direto bloqueado; '; end;
  j := public.staff_write(t1,'orders','update',array[oid],'{"status":"preparing","last_updated_by":"Dono","kiosk_id":"00000000-0000-0000-0000-000000000000"}');
  r := r || 'ord=' || (j->>'count') || '; ';
  j := public.staff_write(t1,'order_items','delete',(select array_agg(id) from public.order_items where order_id=oid),null);
  r := r || 'oi_del=' || (j->>'count') || '; ';
  perform public.promo_adjust(pid, 3);

  -- garçom
  perform public.register_waiter(t1,'Joao','J@x.com','Gar@123',false);
  select x.token into tw from public.login_waiter('j@x.com','Gar@123') x;
  r := r || case when tw is not null then 'ok login garçom; ' else 'FAIL login garçom; ' end;
  begin perform public.staff_write(tw,'products','update',array[pid],'{"price":1}'); r := r || 'FAIL garçom sem permissão editou; '; exception when others then r := r || 'ok garçom sem permissão bloqueado; '; end;
  j := public.staff_write(tw,'orders','update',array[oid],'{"status":"delivered"}');
  r := r || 'garçom ord=' || (j->>'count') || '; ';
  begin perform * from public.list_waiters(tw); r := r || 'FAIL garçom listou garçons; '; exception when others then r := r || 'ok list_waiters só dono; '; end;
  select count(*) into n from public.list_waiters(t1);
  r := r || 'waiters=' || n || '; ';
  begin perform public.staff_write('token-falso','products','insert',null,'{"name":"x"}'); r := r || 'FAIL token falso; '; exception when others then r := r || 'ok token falso; '; end;

  -- admin
  select x.token into ta from public.login_admin('adm@t.com','Adm!n123') x;
  r := r || case when ta is not null then 'ok admin login; ' else 'FAIL admin login; ' end;
  j := public.admin_list_kiosks(ta);
  r := r || 'admin_list=' || jsonb_array_length(j) || ' tem_doc=' || (j->0 ? 'owner_doc') || ' tem_pw=' || (j->0 ? 'password') || '; ';
  perform public.staff_write(ta,'kiosks','update',array[kid],'{"blocked":true}');
  begin perform public.admin_list_kiosks(t1); r := r || 'FAIL dono listou admin; '; exception when others then r := r || 'ok admin_list só admin; '; end;
  begin perform public.staff_write(t1,'products','update',array[pid],'{"price":2}'); r := r || 'FAIL bloqueado ainda escreve; '; exception when others then r := r || 'ok kiosk bloqueado não escreve; '; end;
  perform public.admin_reset_kiosk_password(ta, kid, 'NovaSenh@1');
  select count(*) into n from public.login_kiosk('t@x.com','NovaSenh@1');
  r := r || 'login nova senha=' || n || '; ';

  -- força bruta
  for i in 1..9 loop
    begin perform * from public.login_admin('zz@zz.com','x'||i); exception when others then e := sqlerrm; end;
  end loop;
  r := r || 'brute=' || coalesce(e,'sem erro') || '; ';

  reset role;
  raise exception 'RESULT: %', r;
end $t$;
