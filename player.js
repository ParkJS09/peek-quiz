'use strict';

const PLAYER_KEY = 'peekquiz.player';
const DAYS = 7;
const SLOTS = 2;

let player = null;      // { token, nickname }
let current = null;     // 지금 풀고 있는 문제의 서버 상태
let busy = false;

// ---------- 플레이어 저장 ----------
function loadPlayer() {
  try { return JSON.parse(localStorage.getItem(PLAYER_KEY)); } catch { return null; }
}
function savePlayer(p) {
  player = p;
  try {
    if (p) localStorage.setItem(PLAYER_KEY, JSON.stringify(p));
    else localStorage.removeItem(PLAYER_KEY);
  } catch { /* 저장이 막힌 브라우저면 이번 탭에서만 유지 */ }
}

// ---------- 화면 전환 ----------
function show(view) {
  ['join', 'list', 'play', 'rank'].forEach((v) => { $(`#view-${v}`).hidden = v !== view; });
  $('#mainTabs').hidden = view === 'join';
  $('#meChip').hidden = view === 'join';
  $$('#mainTabs .tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.view === view || (view === 'play' && t.dataset.view === 'list')));
  window.scrollTo(0, 0);
}

$$('#mainTabs .tab').forEach((t) => t.addEventListener('click', () => {
  if (t.dataset.view === 'rank') openRank(); else openList();
}));

// 서버 오류 공통 처리: 토큰이 사라졌으면 다시 등록 화면으로
function handleError(err) {
  if (err.code === 'BAD_TOKEN') {
    savePlayer(null);
    show('join');
  }
  toast(err.message);
}

// ---------- 닉네임 등록 / 복구 ----------
$('#joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nick = $('#nickInput').value.trim();
  if (nick.length < 2) { toast(ERRORS.NICK_LENGTH); return; }
  try {
    const r = await rpc('register_player', { p_nickname: nick });
    savePlayer({ token: r.token, nickname: r.nickname });
    toast(`환영해요, ${r.nickname}님!`);
    openList();
  } catch (err) { handleError(err); }
});

$('#recoverForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('#recoverInput').value.trim();
  if (!token) return;
  try {
    const me = await rpc('me', { p_token: token });
    savePlayer({ token, nickname: me.nickname });
    toast(`${me.nickname}님, 다시 오셨네요!`);
    openList();
  } catch (err) { toast(err.message); }
});

// ---------- 내 정보 ----------
async function refreshMe() {
  try {
    const me = await rpc('me', { p_token: player.token });
    player.nickname = me.nickname;
    $('#meChip').textContent = `${me.nickname} · ${me.total}점`;
    return me;
  } catch (err) { handleError(err); return null; }
}

$('#meChip').addEventListener('click', async () => {
  const me = await refreshMe();
  if (!me) return;
  $('#meName').textContent = me.nickname;
  $('#meTotal').textContent = `${me.total}점`;
  $('#meSolved').textContent = me.solved;
  $('#meCode').value = player.token;
  $('#meDialog').showModal();
});
$('#closeMe').addEventListener('click', () => $('#meDialog').close());
$('#copyCode').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(player.token); toast('복구 코드를 복사했어요'); }
  catch { $('#meCode').select(); toast('코드를 선택했어요. 직접 복사해 주세요'); }
});
$('#logoutBtn').addEventListener('click', () => {
  if (!confirm('복구 코드를 따로 저장하지 않았다면 이 닉네임으로 다시 들어올 수 없어요. 로그아웃할까요?')) return;
  $('#meDialog').close();
  savePlayer(null);
  show('join');
});

// ---------- 문제 목록 ----------
async function openList() {
  show('list');
  refreshMe();
  const box = $('#dayList');
  if (!box.children.length) box.innerHTML = '<p class="muted">불러오는 중…</p>';
  let quizzes;
  try {
    quizzes = await rpc('list_quizzes', { p_token: player.token });
  } catch (err) { handleError(err); return; }

  const byKey = new Map(quizzes.map((q) => [`${q.day}-${q.slot}`, q]));
  const lastOpenDay = Math.max(0, ...quizzes.filter((q) => q.open).map((q) => q.day));

  box.replaceChildren(...Array.from({ length: DAYS }, (_, d) => {
    const day = d + 1;
    const row = document.createElement('section');
    row.className = 'day-row' + (day === lastOpenDay ? ' today' : '');
    row.innerHTML = `<div class="day-head"><span class="day-num">DAY ${day}</span>${day === lastOpenDay ? '<span class="badge">NEW</span>' : ''}</div>`;
    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    for (let slot = 1; slot <= SLOTS; slot++) tiles.appendChild(tile(byKey.get(`${day}-${slot}`), slot));
    row.appendChild(tiles);
    return row;
  }));
}

function tile(q, slot) {
  const b = document.createElement('button');
  b.className = 'tile';
  if (!q || !q.open) {
    b.classList.add('locked');
    b.disabled = true;
    b.innerHTML = `<span class="tile-icon">🔒</span><span class="tile-title">문제 ${slot}</span><span class="tile-sub">아직 열리지 않았어요</span>`;
    return b;
  }
  const title = q.title ? esc(q.title) : `문제 ${slot}`;
  let icon = '🕳️';
  let sub = `구멍 ${q.hole_count}개 · 도전하기`;
  if (q.status === 'playing') { icon = '👀'; sub = `이어서 하기 · 힌트 ${q.hints_used}/${q.hole_count}`; b.classList.add('playing'); }
  if (q.status === 'solved') { icon = '✅'; sub = `정답! ${q.score}점`; b.classList.add('solved'); }
  if (q.status === 'gave_up') { icon = '🏳️'; sub = '포기 · 0점'; b.classList.add('done'); }
  b.innerHTML = `<span class="tile-icon">${icon}</span><span class="tile-title">${title}</span><span class="tile-sub">${sub}</span>`;
  b.addEventListener('click', () => openPlay(q.id));
  return b;
}

// ---------- 문제 풀기 ----------
// ---------- 정답 축하 ----------
const CHEERS = [
  // 힌트를 적게 볼수록 더 크게 칭찬해요
  { max: 0.2, title: '천재 탐정 등장!', msgs: ['단서 하나로 맞히다니… 제 자리가 위험한데요?', '이건 명탐정의 감이에요!'] },
  { max: 0.5, title: '명추리예요!', msgs: ['역시 날카로운 눈썰미!', '도도란도 감탄했어요!'] },
  { max: 0.8, title: '사건 해결!', msgs: ['차근차근 추리한 보람이 있네요!', '훌륭한 수사였어요!'] },
  { max: 1, title: '찾았다!', msgs: ['끝까지 포기하지 않는 탐정 정신!', '마지막 단서까지 꼼꼼했어요!'] },
];

function celebrate(st) {
  const ratio = st.hints_used / st.hole_count;
  const tier = CHEERS.find((c) => ratio <= c.max) || CHEERS[CHEERS.length - 1];
  $('#celeTitle').textContent = tier.title;
  $('#celeMsg').textContent = tier.msgs[Math.floor(Math.random() * tier.msgs.length)];
  $('#celeScore').textContent = `+${st.score}점`;
  const colors = ['#ffcf4a', '#4ade80', '#60a5fa', '#f472b6', '#c084fc'];
  $('#confetti').replaceChildren(...Array.from({ length: 36 }, (_, i) => {
    const s = document.createElement('i');
    s.style.left = `${Math.random() * 100}%`;
    s.style.background = colors[i % colors.length];
    s.style.animationDelay = `${Math.random() * 0.6}s`;
    s.style.animationDuration = `${1.6 + Math.random() * 1.2}s`;
    s.style.transform = `rotate(${Math.random() * 360}deg)`;
    return s;
  }));
  $('#celebrate').hidden = false;
}

const closeCelebrate = () => { $('#celebrate').hidden = true; };
$('#celeClose').addEventListener('click', closeCelebrate);
$('#celebrate').addEventListener('click', (e) => { if (e.target.id === 'celebrate') closeCelebrate(); });

async function openPlay(quizId) {
  closeCelebrate();
  try {
    const st = await rpc('open_play', { p_token: player.token, p_quiz: quizId });
    current = null;
    setFeedback('', '');
    $('#guessInput').value = '';
    show('play');
    applyState(st);
    if (st.status === 'playing') $('#guessInput').focus();
  } catch (err) { handleError(err); }
}

function applyState(st) {
  const prevImage = current?.image;
  current = st;
  const done = st.status !== 'playing';
  const n = st.hole_count;

  if (st.image && st.image !== prevImage) {
    const img = $('#playImg');
    img.classList.remove('pop');
    img.src = st.image;
    void img.offsetWidth; // 애니메이션 다시 시작
    img.classList.add('pop');
  }

  $('#playTitle').textContent = `DAY ${st.day} · 문제 ${st.slot}${st.title ? ` · ${st.title}` : ''}`;
  $('#stageLabel').textContent = done ? `정답: ${st.answer}` : `힌트 ${st.hints_used} / ${n}`;
  $('#steps').innerHTML = Array.from({ length: n }, (_, i) =>
    `<i class="${done ? (st.status === 'solved' ? 'end' : 'gone') : i < st.hints_used ? 'on' : ''}"></i>`).join('');
  $('#scoreCaption').textContent = done ? '획득 점수' : '지금 맞히면';
  $('#score').textContent = `${done ? st.score : st.score_now}점`;
  const pen = st.penalty > 0 ? `오답 감점 -${st.penalty}점` : '';
  $('#penaltyInfo').innerHTML = done
    ? esc(pen)
    : [`<span>오답 1번에 <b>-${st.wrong_cost}점</b></span>`, pen && `<span class="bad-text">${pen}</span>`].filter(Boolean).join(' · ');

  $('#guessForm').hidden = done;
  $('#nextBtn').hidden = done;
  $('#nextBtn').disabled = st.hints_used >= n;
  $('#giveUpBtn').hidden = done;

  if (done && !$('#feedback').textContent) {
    setFeedback(st.status === 'solved'
      ? `🎉 정답! 힌트 ${st.hints_used}개 만에 맞혔어요`
      : '포기한 문제예요', st.status === 'solved' ? 'good' : '');
  }
}

async function act(fn, extra = {}) {
  if (busy || !current) return null;
  busy = true;
  try {
    return await rpc(fn, { p_token: player.token, p_quiz: current.quiz_id, ...extra });
  } catch (err) {
    handleError(err);
    return null;
  } finally {
    busy = false;
  }
}

$('#nextBtn').addEventListener('click', async () => {
  const st = await act('next_hint');
  if (st) { setFeedback('', ''); applyState(st); $('#guessInput').focus(); }
});

$('#giveUpBtn').addEventListener('click', async () => {
  if (!confirm('포기하면 이 문제는 0점이 되고 다시 도전할 수 없어요. 정답을 볼까요?')) return;
  const st = await act('give_up');
  if (st) { setFeedback('', ''); applyState(st); refreshMe(); }
});

$('#guessForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#guessInput');
  const guess = input.value.trim();
  if (!guess) return;
  const st = await act('submit_answer', { p_guess: guess });
  if (!st) return;
  const lost = (current?.score_now ?? 0) - (st.score_now ?? 0);
  if (st.correct) {
    setFeedback(`🎉 정답! 힌트 ${st.hints_used}개 만에 맞혀서 ${st.score}점을 얻었어요`, 'good');
    celebrate(st);
    refreshMe();
  } else {
    setFeedback(`땡! 정답이 아니에요 (${guess})${lost > 0 ? ` · -${lost}점` : ''}`, 'bad');
    const box = $('#playBox');
    box.classList.remove('shake');
    void box.offsetWidth;
    box.classList.add('shake');
    input.select();
  }
  applyState(st);
});

$('#backBtn').addEventListener('click', openList);

function setFeedback(text, kind) {
  const el = $('#feedback');
  el.textContent = text;
  el.className = `feedback ${kind}`;
}

// ---------- 랭킹 ----------
async function openRank() {
  show('rank');
  let rows;
  try { rows = await rpc('leaderboard', { p_limit: 100 }); } catch (err) { toast(err.message); return; }
  $('#rankEmpty').hidden = rows.length > 0;
  const medal = (r) => ({ 1: '🥇', 2: '🥈', 3: '🥉' })[r] || r;
  $('#rankBody').innerHTML = rows.map((r) => `
    <tr class="${r.nickname === player.nickname ? 'mine' : ''}">
      <td class="rank">${medal(r.rank)}</td>
      <td>${esc(r.nickname)}</td>
      <td>${r.solved}</td>
      <td class="pts">${r.total}</td>
    </tr>`).join('');
}
$('#rankRefresh').addEventListener('click', openRank);

// ---------- 시작 ----------
if (!isConfigured()) {
  showConfigWarning();
  show('join');
} else {
  player = loadPlayer();
  if (player?.token) openList(); else show('join');
}
