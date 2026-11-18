# Supabase 연결하기 (처음 한 번만)

프로젝트: https://supabase.com/dashboard/project/pqubhbooaioxdfnfxxgy

## 1. DB 만들기
1. 대시보드 왼쪽 메뉴에서 **SQL Editor**를 열어요.
2. 이 저장소의 `supabase/schema.sql` 내용을 **전부 복사해서 붙여넣고 Run**을 눌러요.
   - 여러 번 실행해도 안전해요. 기존 데이터는 지워지지 않아요.
   - 운영자를 추가하려면 파일 안의 `insert into public.admins ...` 줄에 이메일을 추가하고 다시 실행하세요.

## 2. 운영자 계정 만들기
1. **Authentication → Users → Add user → Create new user**를 눌러요.
2. 이메일에 `babi5run@gmail.com`, 비밀번호는 원하는 걸로 넣고 **Auto Confirm User**에 체크해요.
3. (권장) **Authentication → Sign In / Providers**에서 **Allow new users to sign up**을 꺼요.
   켜 둬도 운영자 목록(`admins`)에 없는 계정은 아무것도 못 하지만, 꺼 두는 게 깔끔해요.

## 3. 사이트에 키 넣기
1. **Project Settings → API Keys**에서 `anon` `public` 키(또는 `sb_publishable_...` 키)를 복사해요.
2. `config.js`의 `supabaseAnonKey`에 붙여넣고 커밋하고 푸시해요.
   - 이 키는 원래 공개용이라 사이트에 들어가도 괜찮아요.
   - `service_role` / `sb_secret_...` 키는 **절대** 넣지 마세요.

## 사용하기
- 운영자: `https://parkjs09.github.io/peek-quiz/admin.html`에서 로그인 → DAY별로 문제 2개 등록 → 당일에 **공개**
- 플레이어: `https://parkjs09.github.io/peek-quiz/`에서 닉네임 입력 → 공개된 문제 풀기 → 랭킹 확인

## 로컬에서 테스트하기 (Supabase 없이)
```
cd dev
npm install
npm test        # DB 규칙 테스트(정답 숨김, 점수 계산, 권한)
npm run mock    # http://localhost:8787 (운영자 비밀번호: admin1234)
```
