// PGlite 위에 Supabase와 비슷한 환경(anon/authenticated 역할, auth.jwt())을 만들고 schema.sql을 올려요.
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const SCHEMA = path.resolve(import.meta.dirname, '../supabase/schema.sql');

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$;
  grant execute on function auth.jwt() to anon, authenticated;
`;

export async function createDb() {
  const pg = new PGlite();
  await pg.exec(SUPABASE_STUB);
  const schema = fs.readFileSync(SCHEMA, 'utf8');
  await pg.exec(schema);
  await pg.exec(schema); // 두 번 실행해도 안전한지 확인

  const sigCache = new Map();
  async function signature(fn) {
    if (!sigCache.has(fn)) {
      const r = await pg.query(
        `select proargnames as names, proargtypes::regtype[]::text[] as types
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and proname = $1`, [fn]);
      if (!r.rows.length) throw Object.assign(new Error(`function ${fn} not found`), { code: 'PGRST202' });
      const { names, types } = r.rows[0];
      sigCache.set(fn, Object.fromEntries((names || []).map((n, i) => [n, types[i]])));
    }
    return sigCache.get(fn);
  }

  // PostgREST처럼: 이름 있는 인자로 함수를 부르고, 요청한 역할(anon/authenticated)로 실행해요.
  async function rpc(fn, args, claims) {
    const sig = await signature(fn);
    const keys = Object.keys(args).filter((k) => k in sig);
    const vals = keys.map((k) => {
      const v = args[k];
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    });
    const call = `select to_json(public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}::${sig[k]}`).join(', ')})) as r`;
    return pg.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await tx.exec(`set local role ${claims.role === 'authenticated' ? 'authenticated' : 'anon'}`);
      const r = await tx.query(call, vals);
      return r.rows[0]?.r ?? null;
    });
  }

  return { pg, rpc };
}
