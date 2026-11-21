# 알오피스 (rhwp office)

웹 워드·엑셀·파워포인트 + 한글(HWP/HWPX) 편집 사이트.

- https://www.myoffice.p-e.kr — 프론트 (`rhwp-web`, nginx)
  - `/rhwp/` rhwp-studio (HWP 편집기, edwardkim/rhwp v0.9.1 빌드 미러, MIT)
  - `/office/` ONLYOFFICE Document Server 프록시
  - `/api/` API 같은 출처 프록시
- https://api.myoffice.p-e.kr — API (`rhwp-api`, FastAPI)
- `rhwp-onlyoffice` — ONLYOFFICE 9.2 + 나눔/Noto CJK 글꼴, JWT 사용

## 기능
- 새로 만들기: 워드·엑셀·파워포인트 (MS Office), 한글·한셀·한쇼 (한컴오피스 — 한셀/한쇼는 xlsx/pptx로 만들어 한셀·한쇼에서 바로 열림)
- 계정: 회원가입/로그인, 관리자 페이지(`/admin` — 사용자 목록, 사용 중지, 비밀번호 재설정, 삭제, 가입 열고 닫기)
- 공유: 특정 사용자(아이디)에게 보기/편집 권한, 또는 링크(로그인 없이 보기/편집)
- 실시간 공동 편집
  - Office 문서: ONLYOFFICE 자체 WebSocket으로 글자 단위 동시 편집
  - 한글: 한 명씩 편집(잠금) + 나머지는 저장될 때마다 실시간 갱신, "편집 요청 → 넘기기"
  - 접속자 표시·이름 변경 알림은 API의 WebSocket(`/ws/files/{id}`)
- 자동 저장: Office는 30초마다 강제 저장(편집 중에도 저장소 반영), 한글은 수정 멈추고 5초 뒤
- PDF: 편집기의 PDF 버튼 / 홈 메뉴 "PDF로 다운로드", 형식 변환 사본(HWP→DOCX 등)

## 구조
- 인증: `POST /api/auth/login` → 세션 토큰을 `Authorization: Bearer` 로. DB는 `data/app.db`(SQLite, 비밀번호 scrypt, 토큰은 해시만 저장)
- 관리자: 첫 실행 때 `.env`의 `ADMIN_USERNAME`/`ADMIN_PASSWORD`로 생성. 계정 도입 전 익명 작업공간 파일은 관리자 계정으로 옮겨진다.
- 파일: `data/ws/<계정 폴더>/<id>/`. 한도: 파일 50MB, 계정당 500MB/300개 (compose env).
- Office 파일: ONLYOFFICE가 `http://api:8000/internal/dl/...`(HMAC 서명)로 받고, 저장은 `/internal/callback/...`(서명 + JWT).
- HWP 파일: 브라우저의 rhwp 편집기가 `exportHwp/exportHwpx` → `PUT /api/files/{id}/content` (잠금 + 버전 확인).
- 변환/PDF: ONLYOFFICE ConversionService.
- 로딩 속도: 빌드 때 HWP 글꼴을 같은 출처로 내려받고(함초롬은 woff2), wasm은 brotli 미리 압축, 홈 화면에서 유휴 시간에 미리 받기.
- HAProxy: myoffice/rhwp 백엔드에 `option forwardfor`(가입·로그인 시도 제한용 실제 IP), `timeout tunnel 1h`(WebSocket).
- 비밀값: `.env` (JWT_SECRET, SIGN_SECRET, ADMIN_PASSWORD) — 커밋 금지.

## 테스트 (실서버 대상)
```bash
tests/run-api-tests.sh          # API 108개 (pytest, 도커 안에서) — 계정·권한·공유·WebSocket·동시성·변환
tests/e2e/run.sh                # 브라우저 E2E 30개 (Playwright, 로컬 크롬) — 편집·공동편집·자동저장·잠금·PDF
```
관리자 비밀번호는 `.env`에서 읽어 테스트 계정을 만들고, 끝나면 지운다.

## 재배포
```bash
cd /home/smalllab/Docker/rhwp && docker compose up -d --build
cd /home/smalllab/Docker/Proxy && docker compose restart haproxy   # R21: 안 하면 503
```
HAProxy 등록은 2026-11-21 `register-service.sh rhwp rhwp_default ... www.rhwp.p-e.kr=rhwp-web:80 api.rhwp.p-e.kr=rhwp-api:8000` 로 완료(인증서 certs/rhwp.pem).

## rhwp-studio 업데이트
`frontend/public/rhwp/`는 https://edwardkim.github.io/rhwp/ 빌드를 sw.js precache 목록 + wasm 2개로 미러한 것.
버전을 올리려면 같은 방식으로 다시 받고 `frontend/public/vendor/rhwp-editor/`(npm @rhwp/editor)도 같은 버전으로 맞춘다.

## 도메인
- 2026-11-22 `myoffice.p-e.kr`로 이전: `register-service.sh myoffice rhwp_default ... www.myoffice.p-e.kr=rhwp-web:80 api.myoffice.p-e.kr=rhwp-api:8000` (certs/myoffice.pem)
- 코드에 도메인 하드코딩 없음: 프론트는 `www.X` → `api.X`, ONLYOFFICE는 같은 출처 `/office/`. CORS만 compose `CORS_ORIGINS`에서 관리.
- 구 도메인 `rhwp.p-e.kr` 등록(certs/rhwp.pem)도 아직 HAProxy에 남아 있음.

## 로컬/새 서버 실행
```bash
cp .env.example .env   # 값 채우기 (openssl rand -hex 32)
mkdir -p data && chmod 777 data
docker compose up -d --build
```

## 서드파티
- `frontend/public/rhwp/`, `frontend/public/vendor/rhwp-editor/` — [edwardkim/rhwp](https://github.com/edwardkim/rhwp) (MIT). 포함 글꼴은 각 글꼴 라이선스를 따른다.
- ONLYOFFICE Document Server — AGPL-3.0 (공식 도커 이미지를 그대로 사용).
