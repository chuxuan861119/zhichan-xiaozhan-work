!ifndef BUILD_UNINSTALLER
!include nsDialogs.nsh

!define MUI_PAGE_HEADER_TEXT "选择安装位置"
!define MUI_PAGE_HEADER_SUBTEXT "选择知产小栈Work的安装文件夹"
!define MUI_DIRECTORYPAGE_TEXT_TOP "应用将安装到以下文件夹。"
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "安装位置"

Var DesktopShortcutCheckbox
Var CreateDesktopShortcut
Var InstallerBackButton

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
  ${NSD_CreateTimer} UpdateInstallerBackButton 50
  Call UpdateInstallerBackButton
!macroend

!macro customInit
  StrCpy $DesktopShortcutCheckbox ""
  ReadRegStr $CreateDesktopShortcut SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" DesktopShortcutEnabled
  ${If} $CreateDesktopShortcut == ""
    StrCpy $CreateDesktopShortcut "true"
  ${EndIf}
  ${If} ${isNoDesktopShortcut}
    StrCpy $CreateDesktopShortcut "false"
  ${EndIf}
!macroend

Function UpdateInstallerBackButton
  StrCpy $0 0
  ${If} $DesktopShortcutCheckbox != ""
    System::Call "user32::IsWindow(p rDesktopShortcutCheckbox)i.r0"
  ${EndIf}
  GetDlgItem $InstallerBackButton $HWNDPARENT 3
  ${If} $0 == 1
    EnableWindow $InstallerBackButton 1
  ${Else}
    EnableWindow $InstallerBackButton 0
  ${EndIf}
FunctionEnd

!macro customPageAfterChangeDir
  Function DesktopShortcutPageCreate
    !insertmacro MUI_HEADER_TEXT "创建桌面快捷方式" "选择是否在桌面创建应用入口"
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0 0u 100% 12u "可随时在软件的帮助菜单中重新创建。"
    ${NSD_CreateCheckbox} 0 16u 100% 12u "创建桌面快捷方式"
    Pop $DesktopShortcutCheckbox
    ${If} $CreateDesktopShortcut == "true"
      ${NSD_Check} $DesktopShortcutCheckbox
    ${Else}
      ${NSD_Uncheck} $DesktopShortcutCheckbox
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function DesktopShortcutPageLeave
    ${NSD_GetState} $DesktopShortcutCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $CreateDesktopShortcut "true"
    ${Else}
      StrCpy $CreateDesktopShortcut "false"
    ${EndIf}
  FunctionEnd

  Page custom DesktopShortcutPageCreate DesktopShortcutPageLeave
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" DesktopShortcutEnabled "$CreateDesktopShortcut"
  ${If} $CreateDesktopShortcut == "true"
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
  ${EndIf}
!macroend
!endif

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ZhichanXiaozhanWork"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "ZhichanXiaozhanWork"
    Delete "$DESKTOP\知产小栈Work.lnk"
    Delete "$DESKTOP\小栈工作台.lnk"
    Delete "$DESKTOP\知产小栈专利工作台.lnk"
    Delete "$DESKTOP\专利工作台.lnk"
  ${endIf}
!macroend
