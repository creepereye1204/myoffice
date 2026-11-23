# 알오피스 — 안드로이드 앱

WebView 껍데기 (Java, 외부 라이브러리 없음). `assets/www` 의 앱 화면을 `https://appassets.androidplatform.net/` 주소로
직접 내준다. 인터넷 권한이 없어 문서가 기기 밖으로 나가지 않는다.

## 빌드
```bash
node app/prepare.mjs                       # app/build/www (도커 필요)
cd app/android
echo "sdk.dir=$HOME/android-sdk" > local.properties
./gradlew assembleRelease                  # → app/build/outputs/apk/release/myoffice-1.1.0-release.apk
```
- 필요: JDK 17+, Android SDK platform 34 / build-tools 34.0.0
- 서명: `keystore.properties` (storeFile, storePassword, keyAlias, keyPassword)가 있으면 그 키로, 없으면 디버그 키로 서명한다.
  계속 업데이트해서 배포할 거라면 키를 하나 만들어 보관할 것 (키가 바뀌면 기존 앱 위에 업데이트 설치가 안 됨).
- `assets/www` 는 빌드할 때 `app/build/www` 를 가리키는 링크로 만든다.

## 설치
APK 를 폰으로 옮겨 열기 → "출처를 알 수 없는 앱 설치" 허용 → 설치. 안드로이드 8.0 이상.

## 동작
- 처음 화면: 새로 만들기(한글·워드·엑셀·파워포인트), 파일 열기, 최근 문서
- 파일 열기·저장은 안드로이드 기본 파일 화면(저장소 접근 프레임워크) — 내장 저장소, SD 카드, 구글 드라이브 등
- 연 파일은 권한을 유지해서 최근 문서에서 다시 열고 그 자리에 저장할 수 있다
- 파일 관리자·메신저·메일에서 hwp·hwpx·docx·xlsx·pptx·pdf 등을 누르면 "다음 앱으로 열기" 에 알오피스가 나온다
- 뒤로 가기: 문서 → 처음 화면 → 앱 종료 (저장 안 한 내용이 있으면 확인)
- 파일 아이콘: 안드로이드는 파일 아이콘을 각 파일 관리자 앱이 정하므로 앱이 바꿀 수 없다

## 참고
- 편집기 화면은 PC용 화면이라 태블릿·가로 화면에서 쓰기 좋다. 폰에서는 확대/축소해서 쓴다.
- 큰 문서는 WebView 메모리를 많이 쓴다 (`largeHeap` 사용).
- 검사: `ADB_SERIAL=<기기> node app/test/android.mjs <디버그 APK>`
