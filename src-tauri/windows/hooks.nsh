; Ledger installer hooks (Tauri runs these from the NSIS installer).
;
; Tauri's file associations (bundle.fileAssociations in tauri.conf.json) give
; Lust files Ledger's own icon. This swaps in each kind's own: Lt for programs
; (.lst, and Lust 1's .lust), Ls for LustScript (.lsc), Lq for LustQL (.lql).
; They're installed next to Ledger.exe. Then Explorer is told to refresh its icons.

; "Open with Ledger" in Explorer's right-click menu: on files, on folders, and on the empty
; space inside a folder. Skipped when it was turned off in Settings (Software\Ledger NoShellMenu),
; so updates don't bring it back.
!include LogicLib.nsh

!macro LEDGER_MENU KEY ARG
  WriteRegStr SHCTX "Software\Classes\${KEY}\shell\Ledger" "" "Open with Ledger"
  WriteRegStr SHCTX "Software\Classes\${KEY}\shell\Ledger" "Icon" "$INSTDIR\Ledger.exe"
  WriteRegStr SHCTX "Software\Classes\${KEY}\shell\Ledger\command" "" '"$INSTDIR\Ledger.exe" "${ARG}"'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Lust.Program\DefaultIcon" "" "$INSTDIR\lst.ico"
  WriteRegStr SHCTX "Software\Classes\Lust.Script\DefaultIcon" "" "$INSTDIR\lsc.ico"
  WriteRegStr SHCTX "Software\Classes\Lust.Query\DefaultIcon" "" "$INSTDIR\lql.ico"
  ; Older Ledgers put every Lust file under one kind, with the L# icon.
  DeleteRegKey SHCTX "Software\Classes\Lust.Source"
  ReadRegStr $0 HKCU "Software\Ledger" "NoShellMenu"
  ${If} $0 != "1"
    !insertmacro LEDGER_MENU "*" "%1"
    !insertmacro LEDGER_MENU "Directory" "%1"
    !insertmacro LEDGER_MENU "Directory\Background" "%V"
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\*\shell\Ledger"
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\Ledger"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\Ledger"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
