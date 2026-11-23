; 설치/제거 후 탐색기에 파일 아이콘이 바뀐 걸 바로 알림 (SHChangeNotify SHCNE_ASSOCCHANGED)
!macro customInstall
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
!macro customUnInstall
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
