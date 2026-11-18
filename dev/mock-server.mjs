// 로컬 테스트용 가짜 Supabase 서버예요.
// - PGlite(WASM Postgres)에 supabase/schema.sql을 그대로 올려서 RPC를 실제 SQL로 실행해요.
// - /auth/v1/token: 운영자 로그인 흉내(비밀번호는 admin1234)
// - 나머지 경로는 저장소 루트의 정적 파일을 제공하고, config.js는 이 서버를 가리키도록 바꿔서 내려줘요.
//
// 실행: cd dev && npm install && npm run mock   →  http://localhost:8787
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createDb } from './db.mjs';

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.resolve(import.meta.dirname, '..');
const ADMIN_PASSWORD = 'admin1234';
const db = await createDb();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET' });
      return res.end();
    }
    if (url.pathname === '/config.js') {
      return send(res, 200, `window.QUIZ_CONFIG = { supabaseUrl: 'http://localhost:${PORT}', supabaseAnonKey: 'mock-anon-key' };`, TYPES['.js']);
    }
    if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const grant = url.searchParams.get('grant_type');
      let email = null;
      if (grant === 'password' && body.password === ADMIN_PASSWORD) email = String(body.email).toLowerCase();
      if (grant === 'refresh_token' && String(body.refresh_token).startsWith('refresh:')) email = body.refresh_token.slice(8);
      if (!email) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      return send(res, 200, { access_token: `mock:${email}`, refresh_token: `refresh:${email}`, expires_in: 3600, user: { email } });
    }
    const m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (m && req.method === 'POST') {
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      const claims = bearer.startsWith('mock:') ? { role: 'authenticated', email: bearer.slice(5) } : { role: 'anon' };
      const args = JSON.parse((await readBody(req)) || '{}');
      try {
        return send(res, 200, JSON.stringify(await db.rpc(m[1], args, claims)));
      } catch (err) {
        const denied = /permission denied/.test(err.message);
        return send(res, denied ? 401 : 400, { code: err.code, message: err.message });
      }
    }
    // 정적 파일
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || rel.includes('/dev/') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, 'not found', 'text/plain');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  } catch (err) {
    console.error(err);
    send(res, 500, { message: String(err) });
  }
}).listen(PORT, () => console.log(`mock server: http://localhost:${PORT}  (admin: babi5run@gmail.com / ${ADMIN_PASSWORD})`));
