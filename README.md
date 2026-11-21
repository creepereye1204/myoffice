# 알오피스 (rhwp office)

웹 워드·엑셀·파워포인트 + 한글(HWP/HWPX) 편집 사이트.

- https://www.myoffice.p-e.kr — 프론트 (`rhwp-web`, nginx)
  - `/rhwp/` rhwp-studio (HWP 편집기, edwardkim/rhwp v0.9.1 빌드 미러, MIT)
  - `/office/` ONLYOFFICE Document Server 프록시
  - `/api/` API 같은 출처 프록시
- https://api.myoffice.p-e.kr — API (`rhwp-api`, FastAPI)
- `rhwp-onlyoffice` — ONLYOFFICE 9.2 + 나눔/Noto CJK 글꼴, JWT 사용

## 구조
- 익명 작업공간: 브라우저가 `POST /api/workspaces`로 받은 열쇠를 localStorage에 보관, `X-Workspace` 헤더로 인증.
  파일은 `./data/ws/<열쇠>/<id>/` 에 저장. 한도: 파일 50MB, 작업공간 500MB/300개 (compose env).
- Office 파일: ONLYOFFICE가 `http://api:8000/internal/dl/...`(HMAC 서명)로 받고, 저장은 `/internal/callback/...`(서명 + JWT).
- HWP 파일: 브라우저의 rhwp 편집기가 `exportHwp/exportHwpx` → `PUT /api/files/{id}/content`.
- 변환: `POST /api/files/{id}/convert` → ONLYOFFICE ConversionService (HWP→DOCX/PDF, DOCX→PDF 등).
- 비밀값: `.env` (JWT_SECRET, SIGN_SECRET) — 커밋 금지.

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
