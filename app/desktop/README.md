# 알오피스 — 우분투 앱

Electron 껍데기. 앱 파일(`../build/www`)을 `https://app.myoffice.localhost/` 로 직접 내준다 (네트워크로 나가지 않음).

## 빌드
```bash
node app/prepare.mjs                 # ../build/www (도커 필요)
cd app/desktop && npm ci
npx electron-builder --linux deb AppImage
# → dist/myoffice-1.0.1-amd64.deb, dist/myoffice-1.0.1-x86_64.AppImage
```
개발 실행: `npm start` · 실제 실행 검사: `xvfb-run -a node ../test/desktop.mjs [dist/linux-unpacked/myoffice]`

## 설치
```bash
sudo apt install ./myoffice-1.0.1-amd64.deb
```
- 메뉴에 **알오피스**, 터미널에서 `myoffice 파일.hwp`
- 파일 연결: hwp·hwpx·docx·doc·odt·rtf·xlsx·xls·ods·pptx·ppt·odp 를 더블클릭/"다른 앱으로 열기"로 열 수 있다.
  (기본 앱으로 정하려면 파일 우클릭 → 속성 → 열기 → 알오피스 → 기본값으로 설정)
- 파일 아이콘: 위 형식들이 알오피스 아이콘(한/W/X/P + 확장자)으로 보인다.
  설치 스크립트가 `/usr/share/mime/packages/zz-myoffice.xml` 과 `hicolor/*/mimetypes/myoffice-*.png` 를 넣는다.
  지우면(`sudo apt remove myoffice`) 원래 아이콘으로 돌아간다.
- AppImage 는 설치 없이 실행만 한다 (파일 연결·아이콘 등록 없음).

## 동작
- 열린 파일에 Ctrl+S 로 바로 저장 (임시 파일에 쓰고 바꿔치기라 저장 중 꺼져도 원본이 깨지지 않음)
- 새 문서·형식이 다른 파일은 저장 위치를 물음, Ctrl+Shift+S 다른 이름으로 저장, Ctrl+O 열기
- 이미 켜져 있을 때 다른 파일을 열면 같은 앱으로 넘어옴 (처음 화면이면 그 창, 아니면 새 창)
- 수정한 채 창을 닫으면 저장할지 물음
