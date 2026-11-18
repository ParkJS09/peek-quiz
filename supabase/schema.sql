-- =====================================================================
-- 탐정 도도란의 NPC 추리 게임 — Supabase 스키마
-- Supabase 대시보드 > SQL Editor 에 통째로 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전해요(데이터는 지워지지 않아요).
--
-- 보안 설계
--  * 모든 테이블은 RLS가 켜져 있고 정책이 없어서, 브라우저에서 직접 읽거나 쓸 수 없어요.
--  * 모든 접근은 아래 함수(RPC)로만 해요. 함수가 서버에서 권한을 확인해요.
--  * 플레이어는 정답과 원본 이미지를 맞히거나 포기하기 전에는 받을 수 없어요.
--    힌트 이미지도 자기가 요청한 단계까지만 받아요.
--  * 점수는 서버가 "사용한 힌트 수"로 계산해요.
-- =====================================================================

-- ---------- 테이블 ----------
create table if not exists public.admins (
  email text primary key
);

create table if not exists public.quizzes (
  id          uuid primary key default gen_random_uuid(),
  day         int  not null check (day between 1 and 7),
  slot        int  not null check (slot between 1 and 2),
  title       text not null default '',
  hole_count  int  not null check (hole_count between 1 and 20),
  holes       jsonb not null default '[]'::jsonb,  -- [{x,y,r}] 0~1로 정규화된 좌표
  answers     text[] not null,                     -- 첫 번째가 대표 정답
  is_open     boolean not null default false,
  opened_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (day, slot)
);

-- stage 1..n = 힌트 n번까지 열린 이미지, stage 0 = 원본(정답 공개용)
create table if not exists public.quiz_images (
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  stage   int  not null check (stage >= 0),
  data    text not null,   -- data:image/...;base64,...
  primary key (quiz_id, stage)
);

create table if not exists public.players (
  id          uuid primary key default gen_random_uuid(),
  nickname    text not null,
  token_hash  text not null unique,
  created_at  timestamptz not null default now()
);
create unique index if not exists players_nickname_lower_key on public.players (lower(nickname));

create table if not exists public.plays (
  player_id     uuid not null references public.players(id) on delete cascade,
  quiz_id       uuid not null references public.quizzes(id) on delete cascade,
  hints_used    int  not null default 1,
  wrong_count   int  not null default 0,
  status        text not null default 'playing' check (status in ('playing', 'solved', 'gave_up')),
  score         int  not null default 0,
  last_guess_at timestamptz,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  primary key (player_id, quiz_id)
);
create index if not exists plays_quiz_idx on public.plays (quiz_id);
-- 오답 감점 누적(이전 버전 DB에도 컬럼을 추가해요)
alter table public.plays add column if not exists penalty int not null default 0;

alter table public.admins      enable row level security;
alter table public.quizzes     enable row level security;
alter table public.quiz_images enable row level security;
alter table public.players     enable row level security;
alter table public.plays       enable row level security;

revoke all on public.admins, public.quizzes, public.quiz_images, public.players, public.plays
  from public, anon, authenticated;

-- 운영자 이메일(여러 명이면 한 줄씩 추가)
insert into public.admins (email) values ('babi5run@gmail.com') on conflict do nothing;

-- ---------- 내부 도우미 ----------

-- 정답 비교용: 소문자로 바꾸고 공백과 문장부호를 지워요.
create or replace function public._norm(t text) returns text
language sql immutable as $$
  select regexp_replace(
    lower(coalesce(t, '')),
    '[[:space:]\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e·・～！？，．。、“”‘’（）「」『』《》〈〉【】…ㆍ]',
    '', 'g')
$$;

create or replace function public._hash(t text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(t, 'UTF8')), 'hex')
$$;

-- ---------- 점수 규칙 (여기 숫자만 바꾸면 돼요) ----------
-- 기본 점수: 구멍 n개 중 h개를 보고 맞히면 100 × (n − h + 1) / n
create or replace function public._base_score(p_n int, p_h int) returns int
language sql immutable as $$
  select round(100.0 * (p_n - p_h + 1) / p_n)::int
$$;

-- 오답 1번 감점: 남은 구멍 수(지금 단계 포함). 구멍 5개면 힌트 1개일 때 -5, 2개 -4, … 5개 -1
drop function if exists public._wrong_penalty(int);
create or replace function public._wrong_penalty(p_n int, p_h int) returns int
language sql immutable as $$
  select greatest(1, p_n - p_h + 1)
$$;

-- 최종 점수: 기본 점수 − 누적 감점. 단, 맞히면 기본 점수의 10%(최소 1점)는 보장
create or replace function public._final_score(p_base int, p_penalty int) returns int
language sql immutable as $$
  select greatest(p_base - p_penalty, greatest(1, round(p_base * 0.10)::int))
$$;

-- 욕설 감지: 글자만 남기고(띄어쓰기/숫자/기호 무시) 금지어가 들어 있는지 봐요.
-- 브라우저(common.js의 PROFANITY)와 같은 목록을 유지해 주세요.
create or replace function public._has_profanity(t text) returns boolean
language plpgsql immutable as $$
declare
  s text := regexp_replace(lower(coalesce(t, '')), '[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ]', '', 'g');
  w text;
begin
  foreach w in array array['시발점', '시발역', '시바견', '시바이누', '병신년', '병신양요'] loop
    s := replace(s, w, '');
  end loop;
  s := regexp_replace(s, '[0-9]', '', 'g');
  foreach w in array array[
    '시발', '씨발', '씨빨', '시빨', '씨바', '시바알', '씨팔', '시팔', '쓰발', '쒸발', 'ㅅㅂ', 'ㅆㅂ', 'ㅅㅂㄹㅁ',
    '병신', '븅신', '빙신', '병쉰', 'ㅂㅅ', 'ㅄ',
    '좆', '좃같', '족같', 'ㅈ같', '존나', '졸라', 'ㅈㄴ',
    '개새끼', '개새기', '개색기', '개색히', '개세끼', 'ㄱㅅㄲ', '새끼야',
    '지랄', 'ㅈㄹ', '염병', '미친놈', '미친년', '미친새끼', '썅', '닥쳐', '꺼져', '엿먹어',
    'fuck', 'shit', 'bitch', 'asshole'] loop
    if position(w in s) > 0 then return true; end if;
  end loop;
  return false;
end $$;

create or replace function public._player(p_token text) returns public.players
language plpgsql stable security definer set search_path = public as $$
declare v public.players;
begin
  select * into v from players where token_hash = _hash(coalesce(p_token, ''));
  if not found then raise exception 'BAD_TOKEN'; end if;
  return v;
end $$;

create or replace function public._is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'authenticated'
     and exists (select 1 from admins where email = lower(auth.jwt() ->> 'email'))
$$;

create or replace function public._require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not _is_admin() then raise exception 'NOT_ADMIN'; end if;
end $$;

create or replace function public._open_quiz(p_quiz uuid) returns public.quizzes
language plpgsql stable security definer set search_path = public as $$
declare q public.quizzes;
begin
  select * into q from quizzes where id = p_quiz and is_open;
  if not found then raise exception 'NOT_OPEN'; end if;
  return q;
end $$;

-- 플레이어 한 명의 한 문제 진행 상태 + 지금 볼 수 있는 이미지 1장
create or replace function public._play_state(p_player uuid, p_quiz uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  q public.quizzes;
  p public.plays;
  v_stage int;
begin
  select * into q from quizzes where id = p_quiz;
  select * into p from plays where player_id = p_player and quiz_id = p_quiz;
  v_stage := case when p.status = 'playing' then p.hints_used else 0 end;
  return json_build_object(
    'quiz_id',     q.id,
    'day',         q.day,
    'slot',        q.slot,
    'title',       q.title,
    'hole_count',  q.hole_count,
    'hints_used',  p.hints_used,
    'wrong_count', p.wrong_count,
    'status',      p.status,
    'score',       p.score,
    'penalty',     p.penalty,
    'score_now',   case when p.status = 'playing'
                        then _final_score(_base_score(q.hole_count, p.hints_used), p.penalty)
                        else p.score end,
    'wrong_cost',  case when p.status = 'playing'
                        then _wrong_penalty(q.hole_count, p.hints_used) end,
    'answer',      case when p.status = 'playing' then null else q.answers[1] end,
    'image',       (select data from quiz_images where quiz_id = q.id and stage = v_stage)
  );
end $$;

-- ---------- 플레이어용 함수 ----------

create or replace function public.register_player(p_nickname text) returns json
language plpgsql volatile security definer set search_path = public as $$
declare
  v_nick  text := btrim(regexp_replace(coalesce(p_nickname, ''), '[[:space:]]+', ' ', 'g'));
  v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if char_length(v_nick) < 2 or char_length(v_nick) > 12 then raise exception 'NICK_LENGTH'; end if;
  if v_nick ~ '[[:cntrl:]]' then raise exception 'NICK_INVALID'; end if;
  if _has_profanity(v_nick) then raise exception 'NICK_PROFANE'; end if;
  begin
    insert into players (nickname, token_hash) values (v_nick, _hash(v_token));
  exception when unique_violation then
    raise exception 'NICK_TAKEN';
  end;
  return json_build_object('token', v_token, 'nickname', v_nick);
end $$;

create or replace function public.me(p_token text) returns json
language plpgsql stable security definer set search_path = public as $$
declare v public.players := _player(p_token);
begin
  return (
    select json_build_object(
      'nickname', v.nickname,
      'total',    coalesce(sum(score), 0),
      'solved',   count(*) filter (where status = 'solved'))
    from plays where player_id = v.id);
end $$;

-- 7일 x 2문제 목록. 열리지 않은 문제는 위치만 알려줘요.
create or replace function public.list_quizzes(p_token text default null) returns json
language plpgsql stable security definer set search_path = public as $$
declare v_player uuid;
begin
  if p_token is not null and p_token <> '' then
    v_player := (_player(p_token)).id;
  end if;
  return coalesce((
    select json_agg(json_build_object(
      'id',         case when q.is_open then q.id end,
      'day',        q.day,
      'slot',       q.slot,
      'open',       q.is_open,
      'title',      case when q.is_open then q.title end,
      'hole_count', case when q.is_open then q.hole_count end,
      'status',     p.status,
      'hints_used', p.hints_used,
      'score',      p.score
    ) order by q.day, q.slot)
    from quizzes q
    left join plays p on p.quiz_id = q.id and p.player_id = v_player
  ), '[]'::json);
end $$;

-- 문제 열기(처음이면 힌트 1개로 시작)
create or replace function public.open_play(p_token text, p_quiz uuid) returns json
language plpgsql volatile security definer set search_path = public as $$
declare
  v public.players := _player(p_token);
  q public.quizzes := _open_quiz(p_quiz);
begin
  insert into plays (player_id, quiz_id) values (v.id, q.id) on conflict do nothing;
  return _play_state(v.id, q.id);
end $$;

create or replace function public.next_hint(p_token text, p_quiz uuid) returns json
language plpgsql volatile security definer set search_path = public as $$
declare
  v public.players := _player(p_token);
  q public.quizzes := _open_quiz(p_quiz);
begin
  update plays set hints_used = least(hints_used + 1, q.hole_count)
   where player_id = v.id and quiz_id = q.id and status = 'playing';
  return _play_state(v.id, q.id);
end $$;

create or replace function public.submit_answer(p_token text, p_quiz uuid, p_guess text) returns json
language plpgsql volatile security definer set search_path = public as $$
declare
  v public.players := _player(p_token);
  q public.quizzes := _open_quiz(p_quiz);
  p public.plays;
  v_ok boolean;
begin
  select * into p from plays where player_id = v.id and quiz_id = q.id for update;
  if not found then raise exception 'NOT_STARTED'; end if;
  if p.status <> 'playing' then
    return _play_state(v.id, q.id)::jsonb || jsonb_build_object('correct', p.status = 'solved');
  end if;
  if p.last_guess_at is not null and now() - p.last_guess_at < interval '1 second' then
    raise exception 'TOO_FAST';
  end if;

  v_ok := _norm(p_guess) <> '' and exists (
    select 1 from unnest(q.answers) a where _norm(a) = _norm(p_guess));

  if v_ok then
    update plays set status = 'solved', finished_at = now(), last_guess_at = now(),
           score = _final_score(_base_score(q.hole_count, hints_used), penalty)
     where player_id = v.id and quiz_id = q.id;
  else
    update plays set wrong_count = wrong_count + 1, last_guess_at = now(),
           penalty = penalty + _wrong_penalty(q.hole_count, hints_used)
     where player_id = v.id and quiz_id = q.id;
  end if;
  return _play_state(v.id, q.id)::jsonb || jsonb_build_object('correct', v_ok);
end $$;

create or replace function public.give_up(p_token text, p_quiz uuid) returns json
language plpgsql volatile security definer set search_path = public as $$
declare
  v public.players := _player(p_token);
  q public.quizzes := _open_quiz(p_quiz);
begin
  update plays set status = 'gave_up', score = 0, finished_at = now()
   where player_id = v.id and quiz_id = q.id and status = 'playing';
  return _play_state(v.id, q.id);
end $$;

-- 랭킹: 총점 → 맞힌 수 → 마지막으로 맞힌 시각이 빠른 순
create or replace function public.leaderboard(p_limit int default 100) returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(r order by r.rank, r.last_at), '[]'::json) from (
    select pl.nickname,
           sum(p.score)::int                              as total,
           count(*) filter (where p.status = 'solved')::int as solved,
           max(p.finished_at) filter (where p.status = 'solved') as last_at,
           rank() over (order by sum(p.score) desc,
                                 count(*) filter (where p.status = 'solved') desc,
                                 max(p.finished_at) filter (where p.status = 'solved') asc nulls last)::int as rank
      from plays p join players pl on pl.id = p.player_id
     group by pl.id, pl.nickname
    having sum(p.score) > 0
     order by rank
     limit least(greatest(coalesce(p_limit, 100), 1), 500)
  ) r
$$;

-- ---------- 운영자용 함수 ----------

create or replace function public.admin_whoami() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('email', auth.jwt() ->> 'email', 'is_admin', _is_admin())
$$;

create or replace function public.admin_list() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_admin();
  return coalesce((
    select json_agg(json_build_object(
      'id', q.id, 'day', q.day, 'slot', q.slot, 'title', q.title,
      'hole_count', q.hole_count, 'holes', q.holes, 'answers', q.answers,
      'is_open', q.is_open, 'opened_at', q.opened_at,
      'images_ready', (select count(*) from quiz_images i where i.quiz_id = q.id) = q.hole_count + 1,
      'players', (select count(*) from plays p where p.quiz_id = q.id),
      'solved',  (select count(*) from plays p where p.quiz_id = q.id and p.status = 'solved')
    ) order by q.day, q.slot)
    from quizzes q), '[]'::json);
end $$;

-- 새 문제 저장(p_id가 null) 또는 수정. 이미 누군가 푼 문제는 구멍을 바꿀 수 없어요.
create or replace function public.admin_save_quiz(
  p_id uuid, p_day int, p_slot int, p_title text, p_answers jsonb, p_holes jsonb
) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare
  v_answers text[] := array(
    select btrim(a) from jsonb_array_elements_text(coalesce(p_answers, '[]'::jsonb)) a
     where btrim(a) <> '');
  v_count int := jsonb_array_length(coalesce(p_holes, '[]'::jsonb));
  v_old public.quizzes;
  v_id uuid;
begin
  perform _require_admin();
  if cardinality(v_answers) = 0 then raise exception 'NO_ANSWER'; end if;
  if v_count < 1 or v_count > 20 then raise exception 'HOLE_COUNT'; end if;

  if p_id is null then
    begin
      insert into quizzes (day, slot, title, hole_count, holes, answers)
      values (p_day, p_slot, coalesce(p_title, ''), v_count, p_holes, v_answers)
      returning id into v_id;
    exception when unique_violation then
      raise exception 'SLOT_TAKEN';
    end;
    return v_id;
  end if;

  select * into v_old from quizzes where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_old.holes is distinct from p_holes and exists (select 1 from plays where quiz_id = p_id) then
    raise exception 'HAS_PLAYS';
  end if;
  begin
    update quizzes set day = p_day, slot = p_slot, title = coalesce(p_title, ''),
           hole_count = v_count, holes = p_holes, answers = v_answers, updated_at = now()
     where id = p_id;
  exception when unique_violation then
    raise exception 'SLOT_TAKEN';
  end;
  delete from quiz_images where quiz_id = p_id and stage > v_count;
  return p_id;
end $$;

create or replace function public.admin_put_image(p_quiz uuid, p_stage int, p_data text) returns void
language plpgsql volatile security definer set search_path = public as $$
declare q public.quizzes;
begin
  perform _require_admin();
  select * into q from quizzes where id = p_quiz;
  if not found then raise exception 'NOT_FOUND'; end if;
  if p_stage < 0 or p_stage > q.hole_count then raise exception 'BAD_STAGE'; end if;
  if p_data is null or p_data !~ '^data:image/(png|jpeg|webp);base64,' then raise exception 'BAD_IMAGE'; end if;
  if length(p_data) > 3000000 then raise exception 'IMAGE_TOO_BIG'; end if;
  if exists (select 1 from plays where quiz_id = p_quiz) then raise exception 'HAS_PLAYS'; end if;
  insert into quiz_images (quiz_id, stage, data) values (p_quiz, p_stage, p_data)
  on conflict (quiz_id, stage) do update set data = excluded.data;
end $$;

create or replace function public.admin_get_image(p_quiz uuid, p_stage int) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_admin();
  return (select data from quiz_images where quiz_id = p_quiz and stage = p_stage);
end $$;

create or replace function public.admin_set_open(p_quiz uuid, p_open boolean) returns void
language plpgsql volatile security definer set search_path = public as $$
declare q public.quizzes;
begin
  perform _require_admin();
  select * into q from quizzes where id = p_quiz for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if p_open and (select count(*) from quiz_images where quiz_id = p_quiz) <> q.hole_count + 1 then
    raise exception 'IMAGES_MISSING';
  end if;
  update quizzes set is_open = p_open,
         opened_at = case when p_open then coalesce(opened_at, now()) else opened_at end
   where id = p_quiz;
end $$;

create or replace function public.admin_delete_quiz(p_quiz uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  perform _require_admin();
  delete from quizzes where id = p_quiz;
end $$;

-- ---------- 운영자: 초기화와 플레이어 관리 ----------

-- 한 문제의 플레이 기록만 지워요(문제는 남아요). 기록이 없어지면 구멍/이미지도 다시 고칠 수 있어요.
create or replace function public.admin_reset_quiz(p_quiz uuid) returns int
language plpgsql volatile security definer set search_path = public as $$
declare n int;
begin
  perform _require_admin();
  delete from plays where quiz_id = p_quiz;
  get diagnostics n = row_count;
  return n;
end $$;

-- 전체 초기화: 모든 플레이 기록(점수)을 지워요. p_players가 true면 닉네임까지 지워요. 문제는 남아요.
create or replace function public.admin_reset_all(p_players boolean) returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_plays int; v_players int := 0;
begin
  perform _require_admin();
  delete from plays where true;
  get diagnostics v_plays = row_count;
  if p_players then
    delete from players where true;
    get diagnostics v_players = row_count;
  end if;
  return json_build_object('plays', v_plays, 'players', v_players);
end $$;

create or replace function public.admin_list_players() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_admin();
  return coalesce((
    select json_agg(r order by r.total desc, r.created_at) from (
      select pl.id, pl.nickname, pl.created_at,
             coalesce(sum(p.score), 0)::int                    as total,
             count(p.quiz_id)::int                             as played,
             count(*) filter (where p.status = 'solved')::int  as solved
        from players pl left join plays p on p.player_id = pl.id
       group by pl.id
    ) r), '[]'::json);
end $$;

-- 플레이어 한 명 삭제(그 사람의 점수도 함께 지워져요)
create or replace function public.admin_delete_player(p_player uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  perform _require_admin();
  delete from players where id = p_player;
end $$;

-- ---------- 실행 권한 ----------
-- 모든 함수의 기본 실행 권한을 걷어내고, 필요한 것만 다시 줘요.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('_norm', '_hash', '_has_profanity', '_base_score', '_wrong_penalty', '_final_score', '_player', '_is_admin', '_require_admin', '_open_quiz', '_play_state',
                         'register_player', 'me', 'list_quizzes', 'open_play', 'next_hint', 'submit_answer',
                         'give_up', 'leaderboard', 'admin_whoami', 'admin_list', 'admin_save_quiz',
                         'admin_put_image', 'admin_get_image', 'admin_set_open', 'admin_delete_quiz',
                         'admin_reset_quiz', 'admin_reset_all', 'admin_list_players', 'admin_delete_player')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

grant execute on function
  public.register_player(text), public.me(text), public.list_quizzes(text),
  public.open_play(text, uuid), public.next_hint(text, uuid),
  public.submit_answer(text, uuid, text), public.give_up(text, uuid), public.leaderboard(int)
  to anon, authenticated;

grant execute on function
  public.admin_whoami(), public.admin_list(),
  public.admin_save_quiz(uuid, int, int, text, jsonb, jsonb),
  public.admin_put_image(uuid, int, text), public.admin_get_image(uuid, int),
  public.admin_set_open(uuid, boolean), public.admin_delete_quiz(uuid),
  public.admin_reset_quiz(uuid), public.admin_reset_all(boolean),
  public.admin_list_players(), public.admin_delete_player(uuid)
  to authenticated;
