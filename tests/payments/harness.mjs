// Harness de testes: PGlite (Postgres real em WASM) com o schema base + migrações reais do repositório.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');

export async function makeDb({ withPayments = true } = {}) {
  const pg = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await pg.waitReady;
  await pg.exec(fs.readFileSync(path.join(here, 'fixtures/baseline.sql'), 'utf8'));
  const migs = ['20261029_security_hardening_v1.sql', '20261030_orders_private.sql'];
  if (withPayments) migs.push('20261031_payments_v1.sql', '20261101_payments_wallets_v1.sql', '20261102_payments_panel_v1.sql');
  for (const m of migs) {
    try { await pg.exec(fs.readFileSync(path.join(repo, 'supabase/migrations', m), 'utf8')); }
    catch (e) { throw new Error('Falha na migração ' + m + ': ' + e.message); }
  }
  return pg;
}

// Executa como um papel (anon / service_role), igual ao PostgREST.
export async function asRole(pg, role, fn) {
  await pg.exec(`set role ${role}`);
  try { return await fn(); } finally { await pg.exec('reset role'); }
}

// Adaptador estilo supabase-js: db.rpc(nome, args) -> {data, error}. Chama a função com parâmetros nomeados.
export function rpcClient(pg, role) {
  return {
    async rpc(name, args = {}) {
      const keys = Object.keys(args);
      const vals = keys.map(k => { const v = args[k]; if (Array.isArray(v) && k === 'p_ids') return '{' + v.join(',') + '}'; return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v; });
      const named = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
      try {
        const r = await asRole(pg, role, () => pg.query(`select to_jsonb(public.${name}(${named})) as r`, vals));
        return { data: r.rows[0].r, error: null };
      } catch (e) {
        return { data: null, error: { message: e.message, code: e.code } };
      }
    },
  };
}

export async function seedKiosk(pg, { name = 'Quiosque Teste', umbrellas = [1, 2, 3] } = {}) {
  const k = (await pg.query(`insert into kiosks(name,city,beach,business_type,is_active,blocked,approved) values ($1,'Natal','Ponta Negra','quiosque',true,false,true) returning id`, [name])).rows[0].id;
  for (const n of umbrellas) await pg.query(`insert into umbrellas(kiosk_id, number, label) values ($1,$2,$3)`, [k, n, 'Guarda-sol ' + n]);
  return k;
}
export async function ownerToken(pg, kioskId, role = 'kiosk', subject = null) {
  const r = await pg.query(`select private.new_session($1,$2,$3, interval '1 day') as t`, [role, kioskId, subject ?? kioskId]);
  return r.rows[0].t;
}
export async function seedOrder(pg, kioskId, umb, items, { status = 'accepted', customer = 'Maria', total = null, createdAt = null } = {}) {
  const sum = items.reduce((s, i) => s + i.q * i.p, 0);
  const o = (await pg.query(`insert into orders(kiosk_id, umbrella_num, order_number, customer_name, status, total, created_at)
     values ($1,$2,(select coalesce(max(order_number),0)+1 from orders where kiosk_id=$1),$3,$4::order_status,$5, coalesce($6::timestamptz, now())) returning id`,
     [kioskId, String(umb), customer, status, total ?? sum, createdAt])).rows[0].id;
  for (const i of items) await pg.query(`insert into order_items(order_id, product_name, quantity, unit_price) values ($1,$2,$3,$4)`, [o, i.n || 'Item', i.q, i.p]);
  return o;
}
