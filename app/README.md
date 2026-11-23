# 알오피스 앱 (서버 없이 기기 안에서)

웹 사이트와 같은 편집기를 **인터넷·서버 없이** 쓰는 앱. 계정·공유·공동 편집은 없고, 내 기기의 파일을 열고 저장한다.

| 형식 | 편집기 | 저장 |
|---|---|---|
| hwp, hwpx | rhwp-studio (WebAssembly) | 같은 형식으로 |
| docx, xlsx, pptx, csv | ONLYOFFICE 편집기 + x2t 변환기(WebAssembly) | 같은 형식으로, PDF 내보내기 |
| doc, xls, ppt, odt, ods, odp, rtf, txt | 〃 | docx/xlsx/pptx 로 새로 저장 |
| pdf | 〃 (보기·주석) | pdf |

## 구조
```
app/
  shell/          앱 화면 (처음 화면·최근 문서·편집기 묶기·Ctrl+S) — 모든 플랫폼 공통
    platform.js   기기 파일 읽기/쓰기 연결부 (데스크톱 nativeBridge / 안드로이드 AndroidBridge / 브라우저)
  prepare.mjs     앱에 넣을 정적 파일을 build/www 로 모음 (도커 필요)
  icons/          앱 아이콘 + 파일 형식별 아이콘 (make-icons.mjs 로 생성, out/ 은 저장소에 포함)
  serve.mjs       build/www 를 브라우저로 확인하는 로컬 서버
  test/smoke.mjs  앱 화면 검사 (새 문서·저장·엑셀 입력 중 저장·PDF·한글·hwpx·csv)
```
플랫폼별 껍데기는 브랜치마다 따로 있다: `app-ubuntu`, `app-windows`, `app-android`.

## build/www 만들기
```bash
node app/prepare.mjs
```
- 오프라인 ONLYOFFICE: [ranuts/document](https://github.com/ranuts/document) 공식 이미지(digest 고정)에서 정적 파일만 꺼낸다.
  편집기의 AI 도우미 엔진은 뺀다(`--keep-ai` 로 유지).
- 한글 편집기: 이 저장소 `frontend/` 이미지를 빌드해서 rhwp-studio (글꼴 TTF 변환 끝난 것)를 꺼낸다.
- 빈 문서 템플릿: 이 저장소 `api/` 이미지에서.

결과는 약 900MB (글꼴이 대부분). 설치 파일로 압축하면 데스크톱 약 340MB.

## 브라우저로 확인
```bash
node app/serve.mjs 8790 &          # http://127.0.0.1:8790/
node app/test/smoke.mjs            # 7개 검사
```

## 라이선스
앱에는 ONLYOFFICE 편집기(sdkjs, web-apps, x2t — AGPL-3.0, ranuts/document 경유)가 들어 있으므로
앱 배포본은 AGPL-3.0 을 따른다 (이 저장소 소스 공개로 충족). rhwp 는 MIT, 글꼴은 각 글꼴 라이선스.
배포 파일 안의 `www/LICENSE`, `www/NOTICE`, `www/licenses/` 에 원문이 들어 있다.
