# 알오피스 앱 (서버 없이 기기 안에서)

**웹 사이트 화면을 그대로** 쓰는 앱. 서버 대신 기기 안에서 동작하고, 공유·실시간 공동 편집·계정은 없다.

| | 웹 사이트 | 앱 |
|---|---|---|
| 화면 | `frontend/public` | 같은 파일 (`common.js` 의 `LOCAL` 을 켬) |
| 파일 저장 | 서버 | 기기의 알오피스 폴더 + 다른 곳에서 연 파일은 그 자리 |
| 한글 (hwp·hwpx) | rhwp-studio | 같음 |
| 워드·엑셀·피피티·한셀·한쇼 | ONLYOFFICE 문서 서버 | 오프라인 ONLYOFFICE + x2t 변환기(WebAssembly) |
| 공유·실시간·계정 | 있음 | 없음 |

## 구조
```
frontend/public/local/      앱 모드 (웹 화면이 LOCAL 일 때만 씀)
  backend.js                /api/... 를 기기 안에서 처리 (응답 모양은 서버와 같음)
  platform.js               기기 저장소: 데스크톱 nativeBridge / 안드로이드 AndroidBridge / 브라우저 IndexedDB
  office.js                 오프라인 ONLYOFFICE 편집기·변환기 (iframe /document/editor.html)
app/
  prepare.mjs               앱에 넣을 파일 → build/www (도커 필요)
  serve.mjs                 build/www 를 브라우저로 확인하는 로컬 서버
  icons/                    앱·파일 형식별 아이콘
  test/make-corpus.sh       형식별 검사 문서 만들기 (한글·영문 글자 포함)
  test/formats.mjs          모든 형식 자동 검사
  test/desktop.mjs, android.mjs   플랫폼 실제 실행 검사
```
플랫폼별 껍데기는 브랜치마다: `app-ubuntu`, `app-windows` (`app/desktop`, Electron), `app-android` (`app/android`).

## 만들기
```bash
node app/prepare.mjs        # build/www (약 900MB, 글꼴이 대부분)
```
- 웹 화면·한글 편집기: 이 저장소 `frontend/` 이미지
- 오프라인 ONLYOFFICE: [ranuts/document](https://github.com/ranuts/document) 공식 이미지(digest 고정)를 `/document/` 에.
  AI 도우미 엔진은 뺀다(`--keep-ai` 로 유지). 변환기 worker 경로 1곳을 고친다.
- 빈 문서: 이 저장소 `api/` 이미지

## 검사
```bash
node app/serve.mjs 8790 &
app/test/make-corpus.sh && node app/test/formats.mjs
```
`formats.mjs` 는 docx·doc·odt·rtf·txt·pdf·xlsx·xls·ods·csv·pptx·ppt·odp·hwp·hwpx·옛 한글 인코딩(CP949) txt 를 하나씩
① 가져오기 ② 오류 없이 열기 ③ 한글 글자 확인(편집기에서 꺼낸 문서와 PDF 둘 다) ④ 편집 가능한 형식은 입력·저장 후 다시 열어
같은 형식에 남았는지까지 확인한다.

## 알려진 제한
- 앱에서는 한글 문서를 PDF·워드로 바꾸지 못한다 (오프라인 변환기에 HWP 읽기가 없음). 한글 인쇄는 데스크톱에서 된다.
- txt 저장은 변환기가 한글을 잘라 써서, 앱이 docx 로 받아 글자만 UTF-8 로 저장한다 (서식 없음 — txt 이므로 원래 없음).
- 옛 한글 인코딩(CP949) txt·csv 는 UTF-8 로 바꿔서 열고, 저장하면 UTF-8 로 저장된다.

## 라이선스
앱에는 ONLYOFFICE 편집기(sdkjs, web-apps, x2t — AGPL-3.0, ranuts/document 경유)가 들어 있으므로
앱 배포본은 AGPL-3.0 을 따른다 (이 저장소 소스 공개로 충족). rhwp 는 MIT, 글꼴은 각 글꼴 라이선스.
