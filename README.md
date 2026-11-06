# 배너 템플릿 스튜디오 (Cloudflare 무료 버전)

팀이 함께 쓰는 배너 편집기예요. Cloudflare Pages 무료 플랜에서 돌아가요.

## 폴더 구성

- `public/index.html` — 배너 편집기
- `public/gallery.html` — 소재 갤러리
- `functions/api/[[path]].js` — 팀 서버 (라이브러리 · 팀 작업함 · 팀 현황 · 갤러리)

## Cloudflare에서 연결할 것

| 종류 | 이름(Variable name) | 용도 |
|---|---|---|
| D1 데이터베이스 | `DB` | 목록, 작업 내용, 팀 현황 기록 |
| KV 네임스페이스 | `FILES` | 이미지 파일 |
| 환경 변수(Secret) | `TEAM_PASSWORD` | 라이브러리·팀 작업함 비밀번호 (선택) |

빌드 설정: Framework preset `None`, Build command 비움, Build output directory `public`.

## 무료 한도 (2026년 11월 기준)

- 요청: 하루 100,000회 (페이지·이미지 같은 정적 파일은 횟수에 안 들어가요)
- D1: 하루 읽기 500만 행, 쓰기 10만 행, DB 하나당 500MB
- KV: 하루 쓰기 1,000회, 저장 공간 1GB

소재를 저장할 때마다 KV에 2번(미리보기·큰 이미지) 써요. 하루 수백 장까지는 넉넉해요.
