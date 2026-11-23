#!/bin/sh
# deb 설치 후: 문서 형식별 아이콘 + 형식 정보 등록, '이 앱으로 열기' 목록 갱신
# (electron-builder 가 달러+중괄호 모양을 자기 변수로 바꾸므로 이 파일에서는 쓰지 않는다)
RES=/opt/myoffice/resources
HI=/usr/share/icons/hicolor
for d in "$RES"/icons/png/*; do
  s=$(basename "$d")
  [ "$s" -le 256 ] || continue
  dir="$HI/$s"x"$s"
  mkdir -p "$dir/mimetypes" "$dir/apps"
  for f in "$d"/*.png; do
    n=$(basename "$f" .png)
    if [ "$n" = app ]; then cp "$f" "$dir/apps/myoffice.png"
    else cp "$f" "$dir/mimetypes/myoffice-$n.png"; fi
  done
done
cp "$RES/icons/zz-myoffice.xml" /usr/share/mime/packages/zz-myoffice.xml
command -v update-mime-database >/dev/null && update-mime-database /usr/share/mime || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t -f "$HI" || true
command -v update-desktop-database >/dev/null && update-desktop-database -q /usr/share/applications || true
# Electron 샌드박스 도우미 권한 (electron-builder 기본 스크립트가 하던 일)
[ -f /opt/myoffice/chrome-sandbox ] && chmod 4755 /opt/myoffice/chrome-sandbox || true
ln -sf /opt/myoffice/myoffice /usr/bin/myoffice
exit 0
