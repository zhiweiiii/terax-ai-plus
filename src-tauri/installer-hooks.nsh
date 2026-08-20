; "Open in Terax" shell verbs for folders, folder backgrounds, and drives.
; SHCTX follows the install mode (HKLM for perMachine). %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Directory\shell\OpenInTerax" "" "Open in Terax"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\OpenInTerax" "Icon" '"$INSTDIR\terax-prod.exe",0'
  WriteRegStr SHCTX "Software\Classes\Directory\shell\OpenInTerax" "NoWorkingDirectory" ""
  WriteRegStr SHCTX "Software\Classes\Directory\shell\OpenInTerax\command" "" '"$INSTDIR\terax-prod.exe" "%V"'

  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\OpenInTerax" "" "Open in Terax"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\OpenInTerax" "Icon" '"$INSTDIR\terax-prod.exe",0'
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\OpenInTerax" "NoWorkingDirectory" ""
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\OpenInTerax\command" "" '"$INSTDIR\terax-prod.exe" "%V"'

  WriteRegStr SHCTX "Software\Classes\Drive\shell\OpenInTerax" "" "Open in Terax"
  WriteRegStr SHCTX "Software\Classes\Drive\shell\OpenInTerax" "Icon" '"$INSTDIR\terax-prod.exe",0'
  WriteRegStr SHCTX "Software\Classes\Drive\shell\OpenInTerax" "NoWorkingDirectory" ""
  WriteRegStr SHCTX "Software\Classes\Drive\shell\OpenInTerax\command" "" '"$INSTDIR\terax-prod.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\OpenInTerax"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\OpenInTerax"
  DeleteRegKey SHCTX "Software\Classes\Drive\shell\OpenInTerax"
!macroend
