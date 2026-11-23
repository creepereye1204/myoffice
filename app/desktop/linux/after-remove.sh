#!/bin/sh
# deb 제거 후: 설치 때 넣은 아이콘·형식 정보 지우기
rm -f /usr/share/mime/packages/zz-myoffice.xml /usr/bin/myoffice
find /usr/share/icons/hicolor -name 'myoffice*.png' -delete 2>/dev/null
command -v update-mime-database >/dev/null && update-mime-database /usr/share/mime || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
command -v update-desktop-database >/dev/null && update-desktop-database -q /usr/share/applications || true
exit 0
