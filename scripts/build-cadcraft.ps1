param([ValidateSet('all', 'test', 'native', 'wasm')][string]$Mode = 'all')
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$archive = Join-Path $repo 'out-cadcraft-source.zip'
$source = Join-Path $repo 'out-cadcraft-archive/storytold-cadcraft-00c7613'
$manifest = Join-Path $repo 'tools/cadcraft-bridge/Cargo.toml'
$output = Join-Path $repo 'resources/cadcraft'
$target = Join-Path $repo 'out-cadcraft-target'
$toolchain = Join-Path $repo 'out-cadcraft-toolchain'
$commit = '00c7613f1af3c73f7157fa91d9fe2635c6f23c06'
$archiveHash = '723BCC079E7793716F27D9762DD8590FB8FD13BBAC7A2125B928D60DFAB6F844'

if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri "https://api.github.com/repos/storytold/cadcraft/zipball/$commit" -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $archiveHash) {
    throw 'Cadcraft source archive checksum mismatch; refusing to build.'
}
if (-not (Test-Path -LiteralPath "$source/Cargo.toml")) {
    Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $repo 'out-cadcraft-archive')
}

function Invoke-Checked([string]$program, [string[]]$arguments) {
    & $program @arguments
    if ($LASTEXITCODE -ne 0) { throw "$program failed with exit code $LASTEXITCODE" }
}

$previousTarget = $env:CARGO_TARGET_DIR
try {
    Invoke-Checked 'node' @("$repo/scripts/patch-cadcraft-source.mjs")
    $env:CARGO_TARGET_DIR = $target
    if ($Mode -eq 'all' -or $Mode -eq 'test') {
        Invoke-Checked 'cargo' @('test', '--locked', '--manifest-path', $manifest)
    }
    if ($Mode -eq 'all' -or $Mode -eq 'native') {
        Invoke-Checked 'cargo' @('build', '--locked', '--release', '--jobs', '1', '--manifest-path', $manifest, '--bin', 'cadcraft-codec')
        New-Item -ItemType Directory -Path $output -Force | Out-Null
        Copy-Item -LiteralPath "$target/release/cadcraft-codec.exe" -Destination "$output/cadcraft-codec.exe"
    }
    if ($Mode -eq 'all' -or $Mode -eq 'wasm') {
        Invoke-Checked 'rustup' @('target', 'add', 'wasm32-unknown-unknown')
        $bindgen = Join-Path $toolchain 'bin/wasm-bindgen.exe'
        if (-not (Test-Path -LiteralPath $bindgen)) {
            Invoke-Checked 'cargo' @('install', 'wasm-bindgen-cli', '--version', '0.2.108', '--locked', '--root', $toolchain)
        }
        if ((& $bindgen --version) -ne 'wasm-bindgen 0.2.108') { throw 'Unexpected wasm-bindgen version' }
        Invoke-Checked 'cargo' @('build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', $manifest, '--lib')
        Invoke-Checked $bindgen @('--target', 'web', '--out-dir', "$output/wasm", '--out-name', 'cadcraft', "$target/wasm32-unknown-unknown/release/patent_cadcraft_bridge.wasm")
        Invoke-Checked 'node' @('--test', "$repo/tools/cadcraft-bridge/tests/wasm-smoke.mjs")
    }
    if ($Mode -ne 'test') {
        New-Item -ItemType Directory -Path "$output/licenses" -Force | Out-Null
        foreach ($name in @('LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE', 'ATTRIBUTION.md')) {
            Copy-Item -LiteralPath "$source/$name" -Destination "$output/licenses/$name"
        }
        $metadataText = & cargo metadata --locked --format-version 1 --manifest-path $manifest
        if ($LASTEXITCODE -ne 0) { throw 'Cannot collect dependency license metadata' }
        $metadata = $metadataText | ConvertFrom-Json
        foreach ($package in $metadata.packages) {
            if (-not $package.source) { continue }
            $licenseDir = Join-Path "$output/licenses" "$($package.name)-$($package.version)"
            $packageDir = Split-Path -Parent $package.manifest_path
            $licenses = Get-ChildItem -LiteralPath $packageDir -File | Where-Object { $_.Name -match '^(LICENSE|LICENCE|COPYING|NOTICE)' }
            if ($licenses) {
                New-Item -ItemType Directory -Path $licenseDir -Force | Out-Null
                $licenses | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $licenseDir $_.Name) }
            }
        }
    }
} finally {
    $env:CARGO_TARGET_DIR = $previousTarget
}
