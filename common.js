'use strict';
// 플레이어 페이지와 운영자 페이지가 같이 쓰는 코드예요.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const CFG = window.QUIZ_CONFIG || {};
const isConfigured = () =>
  !!CFG.supabaseUrl && !!CFG.supabaseAnonKey && !/YOUR_|xxxx/.test(CFG.supabaseUrl + CFG.supabaseAnonKey);

// ---------- Supabase 호출 ----------
const ERRORS = {
  NICK_TAKEN: '이미 사용 중인 닉네임이에요.',
  NICK_LENGTH: '닉네임은 2~12자로 정해 주세요.',
  NICK_INVALID: '닉네임에 쓸 수 없는 문자가 있어요.',
  BAD_TOKEN: '플레이어 정보를 찾을 수 없어요. 복구 코드를 확인해 주세요.',
  NOT_OPEN: '아직 열리지 않은 문제예요.',
  NOT_STARTED: '문제를 다시 열어 주세요.',
  TOO_FAST: '너무 빨라요! 1초 뒤에 다시 제출해 주세요.',
  NOT_ADMIN: '운영자 계정이 아니에요.',
  NO_ANSWER: '정답을 하나 이상 입력해 주세요.',
  HOLE_COUNT: '구멍은 1~20개 찍어 주세요.',
  SLOT_TAKEN: '그 날짜와 순서에는 이미 다른 문제가 있어요.',
  HAS_PLAYS: '이미 플레이한 사람이 있어서 이미지와 구멍은 바꿀 수 없어요. 제목과 정답만 바꿀 수 있어요.',
  IMAGES_MISSING: '이미지 업로드가 끝나지 않은 문제예요. 편집에서 다시 저장해 주세요.',
  IMAGE_TOO_BIG: '이미지가 너무 커요.',
  BAD_IMAGE: '이미지 형식이 올바르지 않아요.',
  NOT_FOUND: '문제를 찾을 수 없어요.',
};

class ApiError extends Error {
  constructor(code, status) {
    super(ERRORS[code] || code || '알 수 없는 오류가 났어요.');
    this.code = code;
    this.status = status;
  }
}

async function rpc(fn, args = {}, accessToken = null) {
  let res;
  try {
    res = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: CFG.supabaseAnonKey,
        Authorization: `Bearer ${accessToken || CFG.supabaseAnonKey}`,
      },
      body: JSON.stringify(args),
    });
  } catch {
    throw new ApiError('네트워크에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.', 0);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(data?.message || data?.msg || res.statusText, res.status);
  return data;
}

// ---------- 운영자 로그인(Supabase Auth, 이메일+비밀번호) ----------
const SESSION_KEY = 'peekquiz.admin';

const auth = {
  session: null,

  load() {
    try { this.session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { this.session = null; }
    return this.session;
  },

  save(s) {
    this.session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch { /* 저장 못 해도 이번 탭에서는 동작 */ }
  },

  async _token(body, grant) {
    const res = await fetch(`${CFG.supabaseUrl}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: CFG.supabaseAnonKey },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error_description || data.msg || data.message || '';
      throw new ApiError(/invalid/i.test(msg) ? '이메일이나 비밀번호가 맞지 않아요.' : msg || '로그인에 실패했어요.', res.status);
    }
    this.save({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      email: data.user?.email,
    });
    return this.session;
  },

  signIn(email, password) { return this._token({ email, password }, 'password'); },

  async accessToken() {
    if (!this.session) return null;
    if (Date.now() < this.session.expires_at - 60_000) return this.session.access_token;
    try {
      await this._token({ refresh_token: this.session.refresh_token }, 'refresh_token');
      return this.session.access_token;
    } catch {
      this.save(null);
      return null;
    }
  },

  signOut() { this.save(null); },
};

async function adminRpc(fn, args) {
  const token = await auth.accessToken();
  if (!token) throw new ApiError('로그인이 만료됐어요. 다시 로그인해 주세요.', 401);
  return rpc(fn, args, token);
}

// ---------- 이미지 ----------
// 구멍 좌표는 이미지 크기와 무관하게 0~1로 저장해요. x는 가로 비율, y는 세로 비율, r은 짧은 변 대비 비율이에요.
const MAX_SIDE = 1000;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 읽지 못했어요.'));
    img.src = src;
  });
}

// 너무 큰 이미지는 긴 변 1000px로 줄인 캔버스를 만들어요(업로드 용량을 줄이려고).
function baseCanvas(img) {
  const s = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

const holesToPx = (holes, W, H) =>
  holes.map((h) => ({ x: h.x * W, y: h.y * H, r: h.r * Math.min(W, H) }));

// 구멍 1..stage만 보이게 그려요. growLast는 마지막 구멍이 커지는 애니메이션용(0~1)이에요.
function drawStage(ctx, src, holesPx, stage, { growLast = 1, rings = true } = {}) {
  const { width: W, height: H } = ctx.canvas;
  const shown = holesPx.slice(0, stage);
  const u = Math.max(1, Math.min(W, H) / 320);
  const rOf = (h, i) => h.r * (i === shown.length - 1 ? growLast : 1);

  ctx.save();
  ctx.fillStyle = '#07080c';
  ctx.fillRect(0, 0, W, H);
  ctx.beginPath();
  shown.forEach((h, i) => {
    const r = rOf(h, i);
    if (r <= 0) return;
    ctx.moveTo(h.x + r, h.y);
    ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
  });
  ctx.clip();
  ctx.drawImage(src, 0, 0, W, H);
  ctx.restore();

  if (rings) {
    ctx.save();
    ctx.lineWidth = 1.5 * u;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    shown.forEach((h, i) => {
      const r = rOf(h, i);
      if (r <= 0) return;
      ctx.beginPath();
      ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.restore();
  }
}

// 업로드할 이미지들: [0] 원본, [k] 힌트 k단계
function renderAllStages(base, holes) {
  const c = document.createElement('canvas');
  c.width = base.width;
  c.height = base.height;
  const ctx = c.getContext('2d');
  const px = holesToPx(holes, c.width, c.height);
  const out = [];
  ctx.drawImage(base, 0, 0);
  out.push(c.toDataURL('image/jpeg', 0.9));
  for (let s = 1; s <= holes.length; s++) {
    drawStage(ctx, base, px, s);
    out.push(c.toDataURL('image/jpeg', 0.88));
  }
  return out;
}

// ---------- 기타 ----------
let toastTimer;
function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function showConfigWarning() {
  const div = document.createElement('div');
  div.className = 'config-warning';
  div.innerHTML = '⚙️ 아직 Supabase가 연결되지 않았어요. <code>config.js</code>에 프로젝트 URL과 anon key를 넣어 주세요. (SETUP.md 참고)';
  document.body.prepend(div);
}
