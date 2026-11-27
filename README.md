# 알오피스 (rhwp office)

웹 워드·엑셀·파워포인트 + 한글(HWP/HWPX) 편집 사이트.

- `www.<도메인>` — 프론트 (`rhwp-web`, nginx)
  - `/rhwp/` rhwp-studio (HWP 편집기, edwardkim/rhwp v0.9.1 빌드 미러, MIT)
  - `/office/` ONLYOFFICE Document Server 프록시
  - `/api/` API 같은 출처 프록시
- `api.<도메인>` — API (`rhwp-api`, FastAPI)
- `rhwp-onlyoffice` — ONLYOFFICE 9.2 + 나눔/Noto CJK 글꼴, JWT 사용

## 기능
- 새로 만들기: 워드·엑셀·파워포인트 (MS Office), 한글·한셀·한쇼 (한컴오피스 — 한셀/한쇼는 xlsx/pptx로 만들어 한셀·한쇼에서 바로 열림)
- 계정: 회원가입/로그인, 관리자 페이지(`/admin` — 사용자 목록, 사용 중지, 비밀번호 재설정, 삭제, 가입 열고 닫기)
- 공유: 특정 사용자(아이디)에게 보기/편집 권한, 또는 링크(로그인 없이 보기/편집)
- 실시간 공동 편집
  - Office 문서: ONLYOFFICE 자체 WebSocket으로 글자 단위 동시 편집
  - 한글: 한 명씩 편집(잠금) + 나머지는 저장될 때마다 실시간 갱신, "편집 요청 → 넘기기"
  - 편집자 연결이 잠깐 끊겨도 10초간 잠금 유지, 창을 닫으면 바로 넘김
  - 접속자 표시·이름 변경 알림은 API의 WebSocket(`/ws/files/{id}`)
- 저장
  - 자동 저장: Office는 30초마다 강제 저장, 한글은 수정 멈추고 5초 뒤
  - Ctrl+S: 어디서 눌러도 브라우저 저장 창 대신 서버 저장, 실제 저장이 확인된 뒤에만 "저장했습니다"
- PDF: 편집기의 PDF 버튼 / 홈 메뉴 "PDF로 다운로드", 형식 변환 사본(HWP→DOCX 등)

## 구조
- 인증: `POST /api/auth/login` → 세션 토큰을 `Authorization: Bearer` 로. DB는 `data/app.db`(SQLite, 비밀번호 scrypt, 토큰은 해시만 저장)
- 관리자: 첫 실행 때 `.env`의 `ADMIN_USERNAME`/`ADMIN_PASSWORD`로 생성.
- 파일: `data/ws/<계정 폴더>/<id>/`. 한도: 파일 50MB, 계정당 500MB/300개 (compose env).
- Office 파일: ONLYOFFICE가 `http://api:8000/internal/dl/...`(HMAC 서명)로 받고, 저장은 `/internal/callback/...`(서명 + JWT).
- HWP 파일: 브라우저의 rhwp 편집기가 `exportHwp/exportHwpx` → `PUT /api/files/{id}/content` (잠금 + 버전 확인).
- 변환/PDF: ONLYOFFICE ConversionService.
- 로딩 속도: 빌드 때 HWP 글꼴을 같은 출처로 내려받아 TTF로 풀고 brotli 미리 압축(woff2 풀기 시간 제거), wasm도 brotli, 홈 화면에서 유휴 시간에 HWP·ONLYOFFICE 편집기 미리 받기.
- 리버스 프록시(앞단): 실제 IP 전달(`X-Forwarded-For`, 가입·로그인 시도 제한용)과 긴 WebSocket 타임아웃이 필요.
- 비밀값: `.env` (JWT_SECRET, SIGN_SECRET, ADMIN_PASSWORD) — 커밋 금지.

## 실행
```bash
cp .env.example .env   # 값 채우기 (openssl rand -hex 32)
mkdir -p data && chmod 777 data
docker compose up -d --build
```
- 컨테이너는 호스트 포트를 열지 않는다. 앞단 리버스 프록시가 `rhwp_default` 네트워크로 `rhwp-web:80`, `rhwp-api:8000`에 연결.
- 도메인은 코드에 넣지 않는다: 프론트는 `www.X` → `api.X`, ONLYOFFICE는 같은 출처 `/office/`. CORS만 compose의 `CORS_ORIGINS`로 설정.

## 모니터링
- [Grafana](https://www.myoffice.p-e.kr/grafana/)에서 `admin`과 `.env`의 `GRAFANA_ADMIN_PASSWORD`로 처음 로그인한다. 실행 전에 비밀번호를 설정한다.
- 브라우저 패널은 리소스 종류별 DNS·TCP·TLS·응답 대기(TTFB)·다운로드 시간의 p50/p95, 전체 시간, 전송량과 캐시 적중률을 보여 준다. `page`에서 홈과 편집 화면을 선택할 수 있다.
- API 패널은 라우트별 응답 헤더까지 걸린 p95 시간, 초당 요청 수, 수신 및 응답 바이트를 보여 준다. ONLYOFFICE 패널에는 변환과 강제 저장 시간이 표시된다.
- 컨테이너 패널은 웹·API·ONLYOFFICE의 네트워크 송수신량과 컨테이너별 CPU·메모리 사용량을 보여 준다.
- Prometheus는 30일간 메트릭을 보관한다. API 메트릭 포트 `9000`은 도커 네트워크 내부에서만 사용한다.

## 테스트
```bash
WEB_URL=https://www.<도메인> API_URL=https://api.<도메인> tests/run-api-tests.sh   # API (pytest, 도커 안에서)
WEB_URL=https://www.<도메인> API_URL=https://api.<도메인> tests/e2e/run.sh         # 브라우저 E2E (Playwright)
```
관리자 비밀번호는 `.env`에서 읽어 테스트 계정을 만들고, 끝나면 지운다.

## rhwp-studio 업데이트
`frontend/public/rhwp/`는 https://edwardkim.github.io/rhwp/ 빌드를 sw.js precache 목록 + wasm 2개로 미러한 것.
버전을 올리려면 같은 방식으로 다시 받고 `frontend/public/vendor/rhwp-editor/`(npm @rhwp/editor)도 같은 버전으로 맞춘다.

## 서드파티
- `frontend/public/rhwp/`, `frontend/public/vendor/rhwp-editor/` — [edwardkim/rhwp](https://github.com/edwardkim/rhwp) (MIT). 포함 글꼴은 각 글꼴 라이선스를 따른다.
- ONLYOFFICE Document Server — AGPL-3.0 (공식 도커 이미지를 그대로 사용).
