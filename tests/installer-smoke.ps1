param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [switch]$KeepArtifacts
)

$ErrorActionPreference = "Stop"
$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$smokeRoot = Join-Path ([IO.Path]::GetTempPath()) ("patent-workbench-installer-smoke-" + [guid]::NewGuid().ToString("N"))
$installDirectory = Join-Path $smokeRoot "installed-app"
$documentPath = Join-Path $smokeRoot "installer-smoke.patdoc"
$secondDocumentPath = Join-Path $smokeRoot "installer-smoke-second.patdoc"
$startMenuShortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\知产小栈Work.lnk"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "知产小栈Work.lnk"
$associationKey = "Registry::HKEY_CURRENT_USER\Software\Classes\.patdoc"
$applicationDataDirectory = Join-Path $env:APPDATA "zhichan-xiaozhan-work"
$applicationLog = Join-Path $applicationDataDirectory "logs\app.log"
$libraryRoot = Join-Path $env:LOCALAPPDATA "ZhichanXiaozhanWork\Library"
$legacyLibraryRoot = Join-Path $env:LOCALAPPDATA "PatentWorkbench\Library"
$libraryDatabase = Join-Path $libraryRoot "library.sqlite3"
$applicationProcess = $null

function Assert-True([bool]$Condition, [string]$Evidence) {
  if (-not $Condition) { throw "Installer smoke failed: $Evidence" }
  Write-Host "PASS: $Evidence"
}

function Wait-Until([scriptblock]$Condition, [int]$TimeoutSeconds, [string]$Evidence) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Installer smoke timed out: $Evidence"
}

function New-SmokePatdoc([string]$Path) {
  Add-Type -AssemblyName System.IO.Compression
  $timestamp = [DateTime]::UtcNow.ToString("o")
  $documentId = [guid]::NewGuid().ToString()
  $paragraphId = [guid]::NewGuid().ToString()
  $entries = @{
    "manifest.json" = @{ formatVersion = 1; documentId = $documentId; assets = @() }
    "model.json" = @{
      formatVersion = 1
      documentId = $documentId
      title = "安装烟雾文档"
      patentType = $null
      createdAt = $timestamp
      modifiedAt = $timestamp
      page = @{ widthMm = 210; heightMm = 297; marginTopMm = 25; marginRightMm = 15; marginBottomMm = 15; marginLeftMm = 25 }
      content = @(@{ id = $paragraphId; type = "paragraph"; attrs = @{ alignment = "left"; paragraphIndentMm = 0; lineSpacing = 1.5; defaultFontFamily = "SimSun"; defaultFontSizePt = 12 }; content = @() })
      assets = @()
    }
    "settings.json" = @{}
    "editor-state.json" = @{}
  }
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew)
  try {
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
    try {
      foreach ($name in $entries.Keys) {
        $entry = $archive.CreateEntry($name)
        $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
        try { $writer.Write(($entries[$name] | ConvertTo-Json -Depth 12 -Compress)) } finally { $writer.Dispose() }
      }
    } finally { $archive.Dispose() }
  } finally { $stream.Dispose() }
}

$existingUninstall = @(
  Get-ItemProperty -Path @(
    "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  ) -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match "^知产小栈Work(?:\s+\d+(?:\.\d+){1,3}(?:[-+][^\s]+)?)?$" }
)
$existingState =
  (Test-Path -LiteralPath $startMenuShortcut) -or
  (Test-Path -LiteralPath $desktopShortcut) -or
  (Test-Path -LiteralPath $associationKey) -or
  (Test-Path -LiteralPath $applicationDataDirectory) -or
  (Test-Path -LiteralPath $libraryRoot) -or
  (Test-Path -LiteralPath $legacyLibraryRoot) -or
  $existingUninstall.Count -gt 0
if ($existingState) {
  throw "Refusing to run over an existing Patent Workbench installation, shortcut, association, or user-data directory. Use a clean disposable Windows test account."
}

New-Item -ItemType Directory -Path $smokeRoot | Out-Null
try {
  New-SmokePatdoc $documentPath
  New-SmokePatdoc $secondDocumentPath
  $install = Start-Process -FilePath $resolvedInstaller -ArgumentList @("/S", "/D=$installDirectory") -Wait -PassThru -WindowStyle Hidden
  Assert-True ($install.ExitCode -eq 0) "per-user installer exit code"

  $applicationPath = Join-Path $installDirectory "知产小栈Work.exe"
  Assert-True (Test-Path -LiteralPath $applicationPath -PathType Leaf) "installed executable"
  Assert-True (Test-Path -LiteralPath $startMenuShortcut -PathType Leaf) "Start menu shortcut"
  Assert-True (Test-Path -LiteralPath $associationKey) "file association"

  Assert-True (Test-Path -LiteralPath $desktopShortcut -PathType Leaf) "desktop shortcut created by installer"

  $applicationProcess = Start-Process -FilePath $documentPath -PassThru
  Wait-Until { -not $applicationProcess.HasExited -and $applicationProcess.MainWindowHandle -ne 0 } 20 "file association launches installed application"
  Wait-Until {
    (Test-Path -LiteralPath $applicationLog) -and
    @(Select-String -LiteralPath $applicationLog -SimpleMatch '"document.opened"').Count -ge 1
  } 20 "file association opens the first document"

  $second = Start-Process -FilePath $secondDocumentPath -PassThru -WindowStyle Hidden
  Assert-True ($second.WaitForExit(10000)) "second process exits for single instance"
  Assert-True (-not $applicationProcess.HasExited) "primary process remains for single instance"
  Wait-Until {
    @(Select-String -LiteralPath $applicationLog -SimpleMatch '"document.opened"').Count -ge 2
  } 20 "second associated document is opened in the primary instance"

  if (-not $applicationProcess.CloseMainWindow()) { $applicationProcess.Kill() }
  if (-not $applicationProcess.WaitForExit(5000)) { $applicationProcess.Kill(); $applicationProcess.WaitForExit() }
  $applicationProcess = $null

  Assert-True (Test-Path -LiteralPath $libraryDatabase -PathType Leaf) "internal library database created"
  $databaseHash = (Get-FileHash -LiteralPath $libraryDatabase -Algorithm SHA256).Hash

  $uninstaller = Get-ChildItem -LiteralPath $installDirectory -Filter "Uninstall*.exe" -File | Select-Object -First 1
  Assert-True ($null -ne $uninstaller) "uninstaller exists"
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -Wait -PassThru -WindowStyle Hidden
  Assert-True ($uninstall.ExitCode -eq 0) "uninstaller exit code"
  Wait-Until { -not (Test-Path -LiteralPath $installDirectory) } 20 "installed files removed"
  Assert-True (-not (Test-Path -LiteralPath $startMenuShortcut)) "Start menu shortcut removed"
  Assert-True (-not (Test-Path -LiteralPath $desktopShortcut)) "desktop shortcut removed"
  Assert-True (Test-Path -LiteralPath $documentPath -PathType Leaf) "user document retained"
  Assert-True (Test-Path -LiteralPath $libraryDatabase -PathType Leaf) "internal library retained after uninstall"
  Assert-True ((Get-FileHash -LiteralPath $libraryDatabase -Algorithm SHA256).Hash -eq $databaseHash) "internal library database unchanged by uninstall"

  $reinstall = Start-Process -FilePath $resolvedInstaller -ArgumentList @("/S", "/D=$installDirectory") -Wait -PassThru -WindowStyle Hidden
  Assert-True ($reinstall.ExitCode -eq 0) "reinstaller exit code"
  $applicationPath = Join-Path $installDirectory "知产小栈Work.exe"
  Assert-True (Test-Path -LiteralPath $applicationPath -PathType Leaf) "reinstalled executable"
  $applicationProcess = Start-Process -FilePath $applicationPath -PassThru
  Wait-Until { -not $applicationProcess.HasExited -and $applicationProcess.MainWindowHandle -ne 0 } 20 "reinstalled application reopens retained library"
  if (-not $applicationProcess.CloseMainWindow()) { $applicationProcess.Kill() }
  if (-not $applicationProcess.WaitForExit(5000)) { $applicationProcess.Kill(); $applicationProcess.WaitForExit() }
  $applicationProcess = $null

  $secondUninstaller = Get-ChildItem -LiteralPath $installDirectory -Filter "Uninstall*.exe" -File | Select-Object -First 1
  Assert-True ($null -ne $secondUninstaller) "reinstalled uninstaller exists"
  $secondUninstall = Start-Process -FilePath $secondUninstaller.FullName -ArgumentList "/S" -Wait -PassThru -WindowStyle Hidden
  Assert-True ($secondUninstall.ExitCode -eq 0) "second uninstaller exit code"
  Wait-Until { -not (Test-Path -LiteralPath $installDirectory) } 20 "reinstalled files removed"
  Assert-True (Test-Path -LiteralPath $libraryDatabase -PathType Leaf) "internal library retained after second uninstall"
} finally {
  if ($applicationProcess -and -not $applicationProcess.HasExited) { $applicationProcess.Kill() }
  if (-not $KeepArtifacts -and (Test-Path -LiteralPath $smokeRoot)) {
    $resolvedSmokeRoot = (Resolve-Path -LiteralPath $smokeRoot).Path
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedSmokeRoot.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Split-Path -Leaf $resolvedSmokeRoot).StartsWith("patent-workbench-installer-smoke-")) {
      throw "Refusing to remove an unexpected smoke path: $resolvedSmokeRoot"
    }
    Remove-Item -LiteralPath $resolvedSmokeRoot -Recurse -Force
  }
}
