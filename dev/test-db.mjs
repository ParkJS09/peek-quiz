// supabase/schema.sql의 규칙을 실제 Postgres(PGlite)로 검증해요.  실행: npm test
import assert from 'node:assert/strict';
import { createDb } from './db.mjs';

const db = await createDb();
const ANON = { role: 'anon' };
const ADMIN = { role: 'authenticated', email: 'babi5run@gmail.com' };
const STRANGER = { role: 'authenticated', email: 'someone@else.com' };
const IMG = (s) => `data:image/jpeg;base64,STAGE${s}`;
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };
const fails = async (p, code) => {
  await assert.rejects(p, (e) => { assert.match(e.message, new RegExp(code)); return true; });
};

const holes = [{ x: .1, y: .1, r: .1 }, { x: .5, y: .5, r: .1 }, { x: .9, y: .9, r: .1 }];
let q1, q2;

await t('운영자만 문제를 만들 수 있다', async () => {
  await fails(db.rpc('admin_save_quiz', { p_id: null, p_day: 1, p_slot: 1, p_title: '', p_answers: ['a'], p_holes: holes }, STRANGER), 'NOT_ADMIN');
  await fails(db.rpc('admin_save_quiz', { p_id: null, p_day: 1, p_slot: 1, p_title: '', p_answers: ['a'], p_holes: holes }, ANON), 'permission denied');
  q1 = await db.rpc('admin_save_quiz', { p_id: null, p_day: 1, p_slot: 1, p_title: '보스', p_answers: ['광부 유령', '유령광부'], p_holes: holes }, ADMIN);
  q2 = await db.rpc('admin_save_quiz', { p_id: null, p_day: 1, p_slot: 2, p_title: '', p_answers: ['Slime!'], p_holes: holes.slice(0, 2) }, ADMIN);
  await fails(db.rpc('admin_save_quiz', { p_id: null, p_day: 1, p_slot: 1, p_title: '', p_answers: ['x'], p_holes: holes }, ADMIN), 'SLOT_TAKEN');
  await fails(db.rpc('admin_save_quiz', { p_id: null, p_day: 2, p_slot: 1, p_title: '', p_answers: [' '], p_holes: holes }, ADMIN), 'NO_ANSWER');
});

await t('이미지가 다 올라가기 전에는 공개할 수 없다', async () => {
  await fails(db.rpc('admin_set_open', { p_quiz: q1, p_open: true }, ADMIN), 'IMAGES_MISSING');
  for (let s = 0; s <= 3; s++) await db.rpc('admin_put_image', { p_quiz: q1, p_stage: s, p_data: IMG(s) }, ADMIN);
  for (let s = 0; s <= 2; s++) await db.rpc('admin_put_image', { p_quiz: q2, p_stage: s, p_data: IMG(s) }, ADMIN);
  await fails(db.rpc('admin_put_image', { p_quiz: q1, p_stage: 4, p_data: IMG(4) }, ADMIN), 'BAD_STAGE');
  await fails(db.rpc('admin_put_image', { p_quiz: q1, p_stage: 1, p_data: 'javascript:alert(1)' }, ADMIN), 'BAD_IMAGE');
});

let tokA, tokB;
await t('닉네임 등록: 길이, 중복(대소문자 무시) 검사', async () => {
  tokA = (await db.rpc('register_player', { p_nickname: '  Alice  ' }, ANON)).token;
  tokB = (await db.rpc('register_player', { p_nickname: '밥' + '돌이' }, ANON)).token;
  await fails(db.rpc('register_player', { p_nickname: 'alice' }, ANON), 'NICK_TAKEN');
  await fails(db.rpc('register_player', { p_nickname: 'a' }, ANON), 'NICK_LENGTH');
  await fails(db.rpc('register_player', { p_nickname: 'x'.repeat(13) }, ANON), 'NICK_LENGTH');
  assert.equal((await db.rpc('me', { p_token: tokA }, ANON)).nickname, 'Alice');
  await fails(db.rpc('me', { p_token: 'nope' }, ANON), 'BAD_TOKEN');
});

await t('공개 전 문제는 목록에서 내용이 가려지고 열 수 없다', async () => {
  const list = await db.rpc('list_quizzes', { p_token: tokA }, ANON);
  assert.equal(list.length, 2);
  assert.ok(list.every((q) => q.id === null && q.title === null && !q.open));
  await fails(db.rpc('open_play', { p_token: tokA, p_quiz: q1 }, ANON), 'NOT_OPEN');
});

await t('플레이어는 테이블을 직접 읽을 수 없다(정답 유출 방지)', async () => {
  for (const tbl of ['quizzes', 'quiz_images', 'players', 'plays', 'admins']) {
    await assert.rejects(db.pg.transaction(async (tx) => {
      await tx.exec('set local role anon');
      await tx.query(`select * from public.${tbl}`);
    }), /permission denied/);
  }
  await fails(db.rpc('admin_list', {}, ANON), 'permission denied');
  await fails(db.rpc('admin_get_image', { p_quiz: q1, p_stage: 0 }, ANON), 'permission denied');
  await fails(db.rpc('admin_list', {}, STRANGER), 'NOT_ADMIN');
});

await t('공개 → 힌트 1단계 이미지만 받고, 정답과 원본은 안 보인다', async () => {
  await db.rpc('admin_set_open', { p_quiz: q1, p_open: true }, ADMIN);
  const st = await db.rpc('open_play', { p_token: tokA, p_quiz: q1 }, ANON);
  assert.equal(st.hints_used, 1);
  assert.equal(st.image, IMG(1));
  assert.equal(st.answer, null);
  assert.equal(st.score_now, 100);
  const again = await db.rpc('open_play', { p_token: tokA, p_quiz: q1 }, ANON);
  assert.equal(again.hints_used, 1, '다시 열어도 힌트가 늘지 않음');
});

await t('다음 힌트는 하나씩, 구멍 수를 넘지 않는다', async () => {
  let st = await db.rpc('next_hint', { p_token: tokA, p_quiz: q1 }, ANON);
  assert.equal(st.hints_used, 2);
  assert.equal(st.image, IMG(2));
  assert.equal(st.score_now, 67);
});

await t('오답은 점수 0, 너무 빠른 연속 제출은 막힌다', async () => {
  const st = await db.rpc('submit_answer', { p_token: tokA, p_quiz: q1, p_guess: '유령' }, ANON);
  assert.equal(st.correct, false);
  assert.equal(st.status, 'playing');
  assert.equal(st.answer, null);
  await fails(db.rpc('submit_answer', { p_token: tokA, p_quiz: q1, p_guess: '광부' }, ANON), 'TOO_FAST');
});

await t('정답(띄어쓰기/문장부호 무시) → 점수 저장, 원본 공개', async () => {
  await db.pg.query(`update plays set last_guess_at = now() - interval '5 seconds'`);
  const st = await db.rpc('submit_answer', { p_token: tokA, p_quiz: q1, p_guess: '광부  유령!!' }, ANON);
  assert.equal(st.correct, true);
  assert.equal(st.status, 'solved');
  assert.equal(st.score, 67);
  assert.equal(st.image, IMG(0));
  assert.equal(st.answer, '광부 유령');
  const after = await db.rpc('next_hint', { p_token: tokA, p_quiz: q1 }, ANON);
  assert.equal(after.score, 67, '푼 뒤에는 점수가 바뀌지 않음');
});

await t('대체 정답과 영문 대소문자도 인정', async () => {
  await db.rpc('admin_set_open', { p_quiz: q2, p_open: true }, ADMIN);
  await db.rpc('open_play', { p_token: tokB, p_quiz: q1 }, ANON);
  const st = await db.rpc('submit_answer', { p_token: tokB, p_quiz: q1, p_guess: '유령광부' }, ANON);
  assert.equal(st.score, 100);
  await db.rpc('open_play', { p_token: tokA, p_quiz: q2 }, ANON);
  const s2 = await db.rpc('submit_answer', { p_token: tokA, p_quiz: q2, p_guess: 'slime' }, ANON);
  assert.equal(s2.correct, true);
  assert.equal(s2.score, 100);
});

await t('포기하면 0점이고 정답이 보인다', async () => {
  await db.rpc('open_play', { p_token: tokB, p_quiz: q2 }, ANON);
  const st = await db.rpc('give_up', { p_token: tokB, p_quiz: q2 }, ANON);
  assert.equal(st.status, 'gave_up');
  assert.equal(st.score, 0);
  assert.equal(st.answer, 'Slime!');
  const s2 = await db.rpc('submit_answer', { p_token: tokB, p_quiz: q2, p_guess: 'slime' }, ANON);
  assert.equal(s2.score, 0, '포기 후 정답 제출해도 점수 없음');
});

await t('랭킹: 총점 순, 내 정보 합계', async () => {
  const lb = await db.rpc('leaderboard', { p_limit: 10 }, ANON);
  assert.deepEqual(lb.map((r) => [r.rank, r.nickname, r.total, r.solved]), [[1, 'Alice', 167, 2], [2, '밥돌이', 100, 1]]);
  const me = await db.rpc('me', { p_token: tokA }, ANON);
  assert.equal(me.total, 167);
  const list = await db.rpc('list_quizzes', { p_token: tokA }, ANON);
  assert.deepEqual(list.map((q) => [q.status, q.score]), [['solved', 67], ['solved', 100]]);
});

await t('플레이한 사람이 있으면 구멍/이미지는 못 바꾸고 정답은 바꿀 수 있다', async () => {
  await fails(db.rpc('admin_save_quiz', { p_id: q1, p_day: 1, p_slot: 1, p_title: '', p_answers: ['x'], p_holes: holes.slice(0, 1) }, ADMIN), 'HAS_PLAYS');
  await fails(db.rpc('admin_put_image', { p_quiz: q1, p_stage: 1, p_data: IMG(9) }, ADMIN), 'HAS_PLAYS');
  await db.rpc('admin_save_quiz', { p_id: q1, p_day: 1, p_slot: 1, p_title: '새 제목', p_answers: ['광부 유령', '광부'], p_holes: holes }, ADMIN);
  const list = await db.rpc('admin_list', {}, ADMIN);
  assert.equal(list[0].title, '새 제목');
  assert.equal(list[0].players, 2);
  assert.equal(list[0].solved, 2);
});

await t('비공개로 돌리면 다시 막히고, 삭제하면 점수도 사라진다', async () => {
  await db.rpc('admin_set_open', { p_quiz: q2, p_open: false }, ADMIN);
  await fails(db.rpc('open_play', { p_token: tokB, p_quiz: q2 }, ANON), 'NOT_OPEN');
  await db.rpc('admin_delete_quiz', { p_quiz: q2 }, ADMIN);
  assert.equal((await db.rpc('me', { p_token: tokA }, ANON)).total, 67);
});

console.log(`\n${passed}개 테스트 통과`);
