; Ledger installer hooks (Tauri runs these from the NSIS installer).
;
; Tauri's file association for .lust (see bundle.fileAssociations in
; tauri.conf.json) gives Lust files Ledger's own icon. This swaps in the L#
; icon, which is installed next to Ledger.exe as lust.ico, then tells Explorer
; to refresh its icons.

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Lust.Source\DefaultIcon" "" "$INSTDIR\lust.ico"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
