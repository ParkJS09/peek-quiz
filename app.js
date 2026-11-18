'use strict';

const $ = (sel) => document.querySelector(sel);

// ---------- 상태 ----------
// 구멍 좌표와 반지름은 모두 "원본 이미지 픽셀" 기준이에요. 화면 크기와 무관하게 저장돼요.
const state = {
  img: null,
  name: 'quiz',
  holes: [],       // [{ x, y, r }] — 배열 순서가 공개 순서
  selected: -1,
  defaultPct: 8,   // 새 구멍 반지름 = 이미지 짧은 변의 n%
};

const game = {
  stage: 1,        // 현재 열려 있는 구멍 개수
  done: false,
  anim: null,      // { kind: 'grow' | 'reveal', start, dur }
};

const editCanvas = $('#editCanvas');
const ectx = editCanvas.getContext('2d');
const playCanvas = $('#playCanvas');
const pctx = playCanvas.getContext('2d');

const minDim = () => Math.min(state.img.naturalWidth, state.img.naturalHeight);
const unit = () => Math.max(1, minDim() / 320); // 선 굵기, 글자 크기용 배율
const pctToPx = (pct) => (pct / 100) * minDim();
const pxToPct = (px) => (px / minDim()) * 100;

// ---------- 이미지 불러오기 ----------
const fileInput = $('#fileInput');
const dropzone = $('#dropzone');

fileInput.addEventListener('change', () => loadFile(fileInput.files[0]));

['dragenter', 'dragover'].forEach((t) =>
  document.addEventListener(t, (e) => { e.preventDefault(); dropzone.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) =>
  document.addEventListener(t, (e) => { e.preventDefault(); dropzone.classList.remove('over'); }));
document.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files[0];
  if (file) loadFile(file);
});
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); loadFile(item.getAsFile()); }
});
$('#changeImg').addEventListener('click', () => fileInput.click());

function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('이미지 파일만 넣을 수 있어요'); return; }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const base = (file.name || 'quiz').replace(/\.[^.]+$/, '') || 'quiz';
    setImage(img, base);
  };
  img.onerror = () => toast('이미지를 읽지 못했어요');
  img.src = url;
}

function setImage(img, name) {
  if (state.img && state.img.src.startsWith('blob:')) URL.revokeObjectURL(state.img.src);
  state.img = img;
  state.name = name;
  state.holes = [];
  state.selected = -1;
  editCanvas.width = playCanvas.width = img.naturalWidth;
  editCanvas.height = playCanvas.height = img.naturalHeight;
  dropzone.hidden = true;
  $('#editorBox').hidden = false;
  $('#editHint').hidden = false;
  $('#changeImg').hidden = false;
  fileInput.value = '';
  refresh();
}

// ---------- 편집 화면 그리기 ----------
const overlay = document.createElement('canvas');

function renderEditor() {
  if (!state.img) return;
  const { width: W, height: H } = editCanvas;
  const u = unit();
  ectx.clearRect(0, 0, W, H);
  ectx.drawImage(state.img, 0, 0, W, H);

  // 어둡게 덮고 구멍 부분만 뚫기(겹친 구멍도 자연스럽게 합쳐져요)
  overlay.width = W; overlay.height = H;
  const o = overlay.getContext('2d');
  o.fillStyle = 'rgba(0,0,0,0.72)';
  o.fillRect(0, 0, W, H);
  o.globalCompositeOperation = 'destination-out';
  state.holes.forEach((h) => { o.beginPath(); o.arc(h.x, h.y, h.r, 0, Math.PI * 2); o.fill(); });
  o.globalCompositeOperation = 'source-over';
  ectx.drawImage(overlay, 0, 0);

  state.holes.forEach((h, i) => {
    const sel = i === state.selected;
    ectx.beginPath();
    ectx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
    ectx.lineWidth = (sel ? 2.5 : 1.5) * u;
    ectx.strokeStyle = sel ? '#ffcf4a' : 'rgba(255,255,255,0.75)';
    ectx.setLineDash(sel ? [] : [4 * u, 3 * u]);
    ectx.stroke();
    ectx.setLineDash([]);

    // 번호 배지
    const br = 9 * u;
    const bx = h.x + h.r * Math.cos(-Math.PI / 4);
    const by = h.y + h.r * Math.sin(-Math.PI / 4);
    ectx.beginPath();
    ectx.arc(bx, by, br, 0, Math.PI * 2);
    ectx.fillStyle = sel ? '#ffcf4a' : '#222634';
    ectx.fill();
    ectx.lineWidth = 1.2 * u;
    ectx.strokeStyle = sel ? '#1a1400' : 'rgba(255,255,255,0.8)';
    ectx.stroke();
    ectx.fillStyle = sel ? '#1a1400' : '#fff';
    ectx.font = `700 ${11 * u}px system-ui, sans-serif`;
    ectx.textAlign = 'center';
    ectx.textBaseline = 'middle';
    ectx.fillText(String(i + 1), bx, by + 0.5 * u);
  });
}

// ---------- 편집: 마우스/터치 ----------
let drag = null;

function toImg(e) {
  const r = editCanvas.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) * editCanvas.width) / r.width,
    y: ((e.clientY - r.top) * editCanvas.height) / r.height,
  };
}

function hitTest(p) {
  // 선택된 구멍을 먼저, 그다음 위에 그려진(뒤 번호) 구멍부터 확인
  const order = state.holes.map((_, i) => i).reverse();
  if (state.selected >= 0) order.unshift(state.selected);
  return order.find((i) => {
    const h = state.holes[i];
    return Math.hypot(p.x - h.x, p.y - h.y) <= h.r;
  }) ?? -1;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

editCanvas.addEventListener('pointerdown', (e) => {
  if (!state.img || e.button !== 0) return;
  const p = toImg(e);
  let i = hitTest(p);
  if (i < 0) {
    state.holes.push({ x: p.x, y: p.y, r: pctToPx(state.defaultPct) });
    i = state.holes.length - 1;
  }
  state.selected = i;
  const h = state.holes[i];
  drag = { i, dx: p.x - h.x, dy: p.y - h.y, id: e.pointerId };
  editCanvas.setPointerCapture(e.pointerId);
  refresh();
});

editCanvas.addEventListener('pointermove', (e) => {
  if (!state.img) return;
  const p = toImg(e);
  if (drag && drag.id === e.pointerId) {
    const h = state.holes[drag.i];
    h.x = clamp(p.x - drag.dx, 0, editCanvas.width);
    h.y = clamp(p.y - drag.dy, 0, editCanvas.height);
    renderEditor();
  } else {
    editCanvas.style.cursor = hitTest(p) >= 0 ? 'move' : 'crosshair';
  }
});

const endDrag = (e) => { if (drag && drag.id === e.pointerId) { drag = null; refresh(); } };
editCanvas.addEventListener('pointerup', endDrag);
editCanvas.addEventListener('pointercancel', endDrag);

editCanvas.addEventListener('wheel', (e) => {
  if (!state.img) return;
  const i = hitTest(toImg(e));
  if (i < 0) return;
  e.preventDefault();
  state.selected = i;
  const h = state.holes[i];
  const pct = clamp(pxToPct(h.r) * (e.deltaY < 0 ? 1.08 : 1 / 1.08), 2, 30);
  h.r = pctToPx(pct);
  refresh();
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if ($('#view-edit').hidden || e.target.matches('input, textarea')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected >= 0) {
    e.preventDefault();
    removeHole(state.selected);
  } else if (e.key === 'Escape') {
    state.selected = -1;
    refresh();
  }
});

function removeHole(i) {
  state.holes.splice(i, 1);
  state.selected = state.holes.length ? Math.min(i, state.holes.length - 1) : -1;
  refresh();
}

function moveHole(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= state.holes.length) return;
  [state.holes[i], state.holes[j]] = [state.holes[j], state.holes[i]];
  state.selected = j;
  refresh();
}

// ---------- 편집: 패널 ----------
const radius = $('#radius');

radius.addEventListener('input', () => {
  const pct = Number(radius.value);
  if (state.selected >= 0) state.holes[state.selected].r = pctToPx(pct);
  else state.defaultPct = pct;
  refresh();
});

$('#clearHoles').addEventListener('click', () => {
  if (!state.holes.length || !confirm('구멍을 전부 지울까요?')) return;
  state.holes = [];
  state.selected = -1;
  refresh();
});

function renderPanel() {
  const has = !!state.img;
  const n = state.holes.length;

  // 크기 슬라이더: 구멍을 선택했으면 그 구멍, 아니면 새 구멍 기본값
  const pct = state.selected >= 0 && has ? pxToPct(state.holes[state.selected].r) : state.defaultPct;
  radius.value = String(Math.round(pct * 2) / 2);
  $('#radiusLabel').textContent = `${Math.round(pct * 10) / 10}%`;
  $('#radiusHelp').textContent = state.selected >= 0
    ? `${state.selected + 1}번 구멍의 크기를 바꾸고 있어요.`
    : '새로 찍을 구멍의 크기예요.';

  const list = $('#holeList');
  list.replaceChildren(...state.holes.map((h, i) => {
    const li = document.createElement('li');
    if (i === state.selected) li.classList.add('sel');
    li.innerHTML = `<span class="num">${i + 1}</span>
      <span class="meta">크기 ${Math.round(pxToPct(h.r) * 10) / 10}%</span>
      <button class="icon-btn" data-act="up" title="앞으로" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button class="icon-btn" data-act="down" title="뒤로" ${i === n - 1 ? 'disabled' : ''}>▼</button>
      <button class="icon-btn" data-act="del" title="삭제">✕</button>`;
    li.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'up') moveHole(i, -1);
      else if (act === 'down') moveHole(i, 1);
      else if (act === 'del') removeHole(i);
      else { state.selected = i === state.selected ? -1 : i; refresh(); }
    });
    return li;
  }));
  $('#holeEmpty').hidden = n > 0;
  $('#clearHoles').disabled = n === 0;

  const ready = has && n > 0;
  $('#startBtn').disabled = !ready;
  $('#exportBtn').disabled = !ready;
  $('#tabPlay').disabled = !ready;
}

function refresh() {
  renderEditor();
  renderPanel();
}

// ---------- 정답 판정 ----------
const normalize = (s) => s.toLowerCase().normalize('NFC').replace(/[\s\p{P}\p{S}]/gu, '');
const answers = () => $('#answerInput').value.split(',').map((s) => s.trim()).filter(Boolean);
const isCorrect = (guess) => {
  const g = normalize(guess);
  return g.length > 0 && answers().some((a) => normalize(a) === g);
};

// ---------- 플레이 ----------
const scoreAt = (stage) => Math.round((100 * (state.holes.length - stage + 1)) / state.holes.length);
const easeOut = (t) => 1 - (1 - t) ** 3;

function switchView(view) {
  $('#view-edit').hidden = view !== 'edit';
  $('#view-play').hidden = view !== 'play';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  if (t.disabled) return;
  if (t.dataset.view === 'play') startGame(); else switchView('edit');
}));
$('#startBtn').addEventListener('click', startGame);
$('#retryBtn').addEventListener('click', startGame);
$('#backBtn').addEventListener('click', () => switchView('edit'));

function startGame() {
  if (!state.img || !state.holes.length) return;
  game.stage = 1;
  game.done = false;
  setFeedback('', '');
  $('#guessInput').value = '';
  switchView('play');
  animate('grow');
  updateHud();
  if (answers().length) $('#guessInput').focus();
}

$('#nextBtn').addEventListener('click', () => {
  if (game.done || game.stage >= state.holes.length) return;
  game.stage += 1;
  setFeedback('', '');
  animate('grow');
  updateHud();
});

$('#revealBtn').addEventListener('click', () => {
  if (game.done) return;
  finish(false);
});

$('#guessForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (game.done) return;
  const input = $('#guessInput');
  const guess = input.value.trim();
  if (!guess) return;
  if (isCorrect(guess)) {
    finish(true);
  } else {
    setFeedback(`땡! 정답이 아니에요 (${guess})`, 'bad');
    const box = $('#playBox');
    box.classList.remove('shake');
    void box.offsetWidth; // 애니메이션 다시 시작
    box.classList.add('shake');
    input.select();
  }
});

function finish(correct) {
  game.done = true;
  const ans = answers()[0];
  if (correct) {
    setFeedback(`🎉 정답! 힌트 ${game.stage}개 만에 맞혔어요`, 'good');
  } else {
    setFeedback(ans ? `정답은 "${ans}"였어요` : '정답 공개!', '');
  }
  game.score = correct ? scoreAt(game.stage) : 0;
  animate('reveal');
  updateHud();
}

function setFeedback(text, kind) {
  const el = $('#feedback');
  el.textContent = text;
  el.className = `feedback ${kind}`;
}

function updateHud() {
  const n = state.holes.length;
  const hasAns = answers().length > 0;
  $('#stageLabel').textContent = game.done ? '정답 공개' : `힌트 ${game.stage} / ${n}`;
  $('#steps').innerHTML = Array.from({ length: n }, (_, i) =>
    `<i class="${game.done ? 'end' : i < game.stage ? 'on' : ''}"></i>`).join('');
  $('#scoreCaption').textContent = game.done ? '획득 점수' : '지금 맞히면';
  $('#score').textContent = game.done
    ? (hasAns ? `${game.score}점` : '—')
    : `${scoreAt(game.stage)}점`;
  $('#guessForm').hidden = !hasAns || game.done;
  $('#hostNote').hidden = hasAns || game.done;
  $('#nextBtn').hidden = game.done;
  $('#nextBtn').disabled = game.stage >= n;
  $('#revealBtn').hidden = game.done;
  $('#retryBtn').hidden = !game.done;
}

// 구멍 1..stage를 그려요. growLast: 마지막 구멍 크기 비율(0~1), expand: 모든 구멍 확대 배율
function drawStage(ctx, stage, { growLast = 1, expand = 1, rings = true } = {}) {
  const { width: W, height: H } = ctx.canvas;
  const holes = state.holes.slice(0, stage);
  ctx.save();
  ctx.fillStyle = '#07080c';
  ctx.fillRect(0, 0, W, H);
  ctx.beginPath();
  holes.forEach((h, i) => {
    const r = h.r * expand * (i === holes.length - 1 ? growLast : 1);
    if (r <= 0) return;
    ctx.moveTo(h.x + r, h.y);
    ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
  });
  ctx.clip();
  ctx.drawImage(state.img, 0, 0, W, H);
  ctx.restore();

  if (rings && expand === 1) {
    const u = unit();
    ctx.save();
    ctx.lineWidth = 1.5 * u;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    holes.forEach((h, i) => {
      const r = h.r * (i === holes.length - 1 ? growLast : 1);
      if (r <= 0) return;
      ctx.beginPath();
      ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.restore();
  }
}

function drawFull(ctx) {
  const { width: W, height: H } = ctx.canvas;
  ctx.drawImage(state.img, 0, 0, W, H);
}

function animate(kind) {
  game.anim = { kind, start: performance.now(), dur: kind === 'grow' ? 380 : 750 };
  requestAnimationFrame(tick);
}

function tick(now) {
  const a = game.anim;
  if (!a) return;
  const t = Math.min(1, (now - a.start) / a.dur);
  if (a.kind === 'grow') {
    drawStage(pctx, game.stage, { growLast: easeOut(t) });
  } else {
    // 열린 구멍들이 화면 전체를 덮을 때까지 커져요
    const W = playCanvas.width;
    const H = playCanvas.height;
    const minR = Math.min(...state.holes.map((h) => h.r));
    const maxExpand = Math.hypot(W, H) / minR;
    drawStage(pctx, state.holes.length, { expand: 1 + (maxExpand - 1) * easeOut(t) ** 2, rings: false });
    if (t === 1) drawFull(pctx);
  }
  if (t < 1) requestAnimationFrame(tick);
  else game.anim = null;
}

// ---------- 힌트 이미지 저장 ----------
$('#exportBtn').addEventListener('click', async () => {
  const n = state.holes.length;
  const c = document.createElement('canvas');
  c.width = state.img.naturalWidth;
  c.height = state.img.naturalHeight;
  const ctx = c.getContext('2d');
  const files = [];

  for (let s = 1; s <= n; s++) {
    drawStage(ctx, s);
    drawBadge(ctx, `힌트 ${s} / ${n}`);
    files.push([`${state.name}-힌트${s}.png`, await toBlob(c)]);
  }
  drawFull(ctx);
  drawBadge(ctx, '정답');
  files.push([`${state.name}-정답.png`, await toBlob(c)]);

  for (const [name, blob] of files) {
    download(name, blob);
    await new Promise((r) => setTimeout(r, 250)); // 브라우저가 연속 다운로드를 막지 않게
  }
  toast(`${files.length}장을 저장했어요. 브라우저가 "여러 파일 다운로드"를 물어보면 허용해 주세요.`);
});

function drawBadge(ctx, text) {
  const u = unit();
  const pad = 6 * u;
  ctx.save();
  ctx.font = `700 ${13 * u}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width + pad * 2;
  const h = 22 * u;
  const x = 8 * u;
  const y = 8 * u;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 6 * u);
  ctx.fill();
  ctx.fillStyle = '#ffcf4a';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + pad, y + h / 2 + 0.5 * u);
  ctx.restore();
}

const toBlob = (c) => new Promise((res) => c.toBlob(res, 'image/png'));

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- 기타 ----------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

renderPanel();

// 테스트/자동화용 훅 (게임 동작에는 영향 없음)
window.__quiz = { state, game, setImage, refresh, startGame };
