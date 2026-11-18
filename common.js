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
  NICK_PROFANE: '욕설이 들어간 닉네임은 쓸 수 없어요.',
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

// ---------- 상단 브랜드: 돋보기 속 도도란 ----------
// 마우스를 따라 렌즈 속 얼굴이 살짝 움직이고, 클릭하면 말풍선으로 한마디 해요.
// lines/greeting 안의 {탐정}은 "닉네임 탐정님"(닉네임이 없으면 "탐정님")으로 바뀌어요.
// getName: 지금 플레이어 닉네임을 돌려주는 함수(없으면 생략)
function initBrand(lines, greeting, getName = () => null) {
  const lens = $('#brandLens');
  const face = $('#lensFace');
  const bubble = $('#brandBubble');
  if (!lens || !face || !bubble) return;
  const CLICKED_KEY = 'peekquiz.lensClicked';
  let timer;
  let nudgeTimer;
  let last = -1;

  const store = {
    get(k, area = localStorage) { try { return area.getItem(k); } catch { return null; } },
    set(k, v, area = localStorage) { try { area.setItem(k, v); } catch { /* 저장이 막혀도 동작 */ } },
  };

  const title = () => {
    const name = getName();
    return name ? `${name} 탐정님` : '탐정님';
  };
  const fill = (text) => text.replaceAll('{탐정}', title());

  const say = (text, ms = 2800) => {
    bubble.textContent = fill(text);
    bubble.hidden = false;
    bubble.style.animation = 'none';
    void bubble.offsetWidth;
    bubble.style.animation = '';
    clearTimeout(timer);
    timer = setTimeout(() => { bubble.hidden = true; }, ms);
  };

  // 아직 한 번도 안 눌러 본 사람에게: 물결 + 흔들림 + "눌러 보세요" 말풍선
  let nudging = store.get(CLICKED_KEY) !== '1';
  const stopNudge = () => {
    if (!nudging) return;
    nudging = false;
    lens.classList.remove('nudge');
    bubble.classList.remove('nudge-bubble');
    clearTimeout(nudgeTimer);
    store.set(CLICKED_KEY, '1');
  };

  lens.addEventListener('click', () => {
    stopNudge();
    bubble.classList.remove('nudge-bubble');
    let i;
    do { i = Math.floor(Math.random() * lines.length); } while (lines.length > 1 && i === last);
    last = i;
    say(lines[i]);
  });
  // 말풍선을 눌러도 도도란을 누른 것과 같아요
  bubble.addEventListener('click', () => lens.click());

  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.addEventListener('pointermove', (e) => {
      const r = lens.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, d / 300) * 4; // 최대 4px
      face.style.translate = `${(dx / d) * k}px ${(dy / d) * k}px`;
    }, { passive: true });
  }

  const firstVisit = store.get('peekquiz.greeted', sessionStorage) !== '1';
  store.set('peekquiz.greeted', '1', sessionStorage);

  if (nudging) {
    lens.classList.add('nudge');
    const showNudge = (text, ms) => {
      if (!nudging) return;
      say(text, ms);
      bubble.classList.add('nudge-bubble');
    };
    setTimeout(() => showNudge(
      `${firstVisit && greeting ? `${greeting}\n` : ''}저를 눌러 보세요! 👆 추리 팁을 알려드릴게요.`, 7000), 700);
    // 그래도 안 누르면 잠시 뒤 한 번 더 살짝 알려줘요
    nudgeTimer = setTimeout(() => showNudge('저 여기 있어요! 눌러 보세요 👆', 4000), 25000);
  } else if (greeting && firstVisit) {
    setTimeout(() => say(greeting), 700);
  }

  return {
    say: (text, ms) => {
      bubble.classList.remove('angry-bubble');
      if (!nudging) bubble.classList.remove('nudge-bubble');
      say(text, ms);
    },
    // 욕을 입력했을 때: 빨간 말풍선 + 화난 흔들림
    scold: (text) => {
      bubble.classList.remove('nudge-bubble');
      bubble.classList.add('angry-bubble');
      lens.classList.remove('angry');
      void lens.offsetWidth;
      lens.classList.add('angry');
      say(text, 3000);
      setTimeout(() => bubble.classList.remove('angry-bubble'), 3000);
    },
  };
}

// ---------- 욕설 감지 ----------
// 띄어쓰기, 숫자, 기호를 섞어 써도 잡히도록 글자만 남겨서 비교해요.
const PROFANITY = [
  '시발', '씨발', '씨빨', '시빨', '씨바', '시바알', '씨팔', '시팔', '쓰발', '쒸발', 'ㅅㅂ', 'ㅆㅂ', 'ㅅㅂㄹㅁ',
  '병신', '븅신', '빙신', '병쉰', 'ㅂㅅ', 'ㅄ',
  '좆', '좃같', '족같', 'ㅈ같', '존나', '졸라', 'ㅈㄴ',
  '개새끼', '개새기', '개색기', '개색히', '개세끼', 'ㄱㅅㄲ', '새끼야',
  '지랄', 'ㅈㄹ', '염병', '미친놈', '미친년', '미친새끼', '썅', '닥쳐', '꺼져', '엿먹어',
  'fuck', 'shit', 'bitch', 'asshole',
];
// 욕이 들어 있지만 욕이 아닌 낱말(먼저 지우고 검사해요)
const PROFANITY_ALLOW = ['시발점', '시발역', '시바견', '시바이누', '병신년', '병신양요'];

function hasProfanity(text) {
  let t = String(text || '').toLowerCase().replace(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ]/g, '');
  PROFANITY_ALLOW.forEach((w) => { t = t.replaceAll(w, ''); });
  t = t.replace(/[0-9]/g, '');
  return PROFANITY.some((w) => t.includes(w));
}
