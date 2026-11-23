# 알오피스 — 윈도우 앱

Electron 껍데기. 앱 파일(`../build/www`)을 `https://app.myoffice.localhost/` 로 직접 내준다 (네트워크로 나가지 않음).

## 빌드 (리눅스에서 wine 으로, 또는 윈도우에서)
```bash
node app/prepare.mjs                 # ../build/www (도커 필요)
cd app/desktop && npm ci
npx electron-builder --win nsis portable --x64
# → dist/MyOffice-Setup-1.1.0.exe (설치), dist/MyOffice-Portable-1.1.0.exe (설치 없이 실행)
```
코드 서명은 하지 않았으므로 처음 실행 때 SmartScreen 이 "Windows의 PC 보호" 를 띄운다 → **추가 정보 → 실행**.

## 설치
- `MyOffice-Setup-1.1.0.exe` 실행 → 설치 위치 선택 (관리자 권한 필요 없음, 사용자 계정에 설치)
- 시작 메뉴·바탕 화면에 **알오피스**
- 파일 연결과 아이콘: hwp·hwpx·docx·doc·odt·rtf·xlsx·xls·ods·pptx·ppt·odp 를 알오피스로 열도록 등록하고,
  형식별 아이콘(한/W/X/P + 확장자)을 붙인다.
  - 이미 다른 프로그램(한컴오피스, MS Office 등)을 **기본 앱으로 직접 고른 적이 있는 형식**은 윈도우가 그 선택을 지킨다.
    이때는 파일 우클릭 → 연결 프로그램 → 다른 앱 선택 → 알오피스 → "항상 이 앱 사용" 을 고르면 아이콘도 바뀐다.
  - 제거하면 연결과 아이콘이 원래대로 돌아간다.
- Portable 판은 실행할 때마다 임시 폴더에 풀기 때문에 처음 뜨는 데 시간이 걸리고, 파일 연결은 하지 않는다.

## 동작
- 열린 파일에 Ctrl+S 로 바로 저장 (임시 파일에 쓰고 바꿔치기라 저장 중 꺼져도 원본이 깨지지 않음)
- 새 문서·형식이 다른 파일은 저장 위치를 물음, Ctrl+Shift+S 다른 이름으로 저장, Ctrl+O 열기
- 이미 켜져 있을 때 다른 파일을 더블클릭하면 같은 앱으로 넘어옴
- 수정한 채 창을 닫으면 저장할지 물음
