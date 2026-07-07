param(
  [string]$ElectronCache = (Join-Path $env:LOCALAPPDATA "electron\Cache"),
  [string]$ElectronBuilderCache = (Join-Path $env:LOCALAPPDATA "electron-builder\Cache")
)

$ErrorActionPreference = "Stop"

$oldElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
$oldElectronCache = $env:ELECTRON_CACHE
$oldElectronBuilderCache = $env:ELECTRON_BUILDER_CACHE
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..") -ErrorAction Stop).ProviderPath
# 输出目录必须是纯 ASCII 且在工程树外:工程路径含非 ASCII 字符(丫够燥的)时,
# electron-builder 复制 app.asar 阶段会被 Windows Defender 实时扫描死锁(EBUSY)。
# 放到 C:\lulu-build 可彻底规避;产物 exe 仍复制回工程内 dist-electron 方便取用。
$distDir = "C:\lulu-build"
$finalDir = Join-Path $projectRoot "dist-electron"
$localElectronDist = Join-Path $projectRoot "node_modules\electron\dist"
$generatedConfig = Join-Path $projectRoot ".electron-builder.local.json"

try {
  if ($env:ELECTRON_RUN_AS_NODE) {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  }

  if (-not (Test-Path -LiteralPath (Join-Path $localElectronDist "electron.exe"))) {
    throw "Local Electron runtime not found: $localElectronDist"
  }

  # Build the React frontend (web/ -> public/) before packaging
  Write-Host "Building web frontend (Vite)..."
  Push-Location -LiteralPath $projectRoot
  try {
    npm run build:web
    if ($LASTEXITCODE -ne 0) { throw "Web frontend build failed (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }

  # Clean previous build output
  if (Test-Path -LiteralPath $distDir) {
    Write-Host "Removing previous dist-electron..."
    # Kill any lingering electron processes from previous builds
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -and $_.Path.StartsWith($distDir)
    } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Remove-Item -Recurse -Force -LiteralPath $distDir -ErrorAction SilentlyContinue
    # If still exists, wait and retry
    if (Test-Path -LiteralPath $distDir) {
      Start-Sleep -Seconds 3
      Remove-Item -Recurse -Force -LiteralPath $distDir -ErrorAction SilentlyContinue
    }
  }

  $env:ELECTRON_CACHE = $ElectronCache
  $env:ELECTRON_BUILDER_CACHE = $ElectronBuilderCache

  Write-Host "ELECTRON_CACHE=$env:ELECTRON_CACHE"
  Write-Host "ELECTRON_BUILDER_CACHE=$env:ELECTRON_BUILDER_CACHE"
  Write-Host "electronDist=$localElectronDist"
  Write-Host "Building in project directory..."

  $packageJson = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $buildConfig = $packageJson.build
  $buildConfig | Add-Member -NotePropertyName "electronDist" -NotePropertyValue "./node_modules/electron/dist" -Force
  # 把输出目录指到 ASCII 安全路径(C:\lulu-build),规避非 ASCII 工程路径下的 EBUSY 死锁
  $buildConfig.directories | Add-Member -NotePropertyName "output" -NotePropertyValue $distDir -Force
  $buildConfig | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $generatedConfig -Encoding UTF8

  npx electron-builder --config $generatedConfig --win --x64

  Write-Host ""
  Write-Host "Build complete!"
  # 把唯一公开的 setup exe 复制回工程内 dist-electron,方便取用。
  # 先清理旧安装包,避免 dist-electron 留下多个 lulu-setup* 让分发时混淆。
  New-Item -ItemType Directory -Force -Path $finalDir | Out-Null
  Get-ChildItem -LiteralPath $finalDir -Filter "lulu-setup*" -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue # stale installer cleanup

  $publicInstaller = Get-Item -LiteralPath (Join-Path $distDir "lulu-setup.exe") -ErrorAction Stop
  Copy-Item -LiteralPath $publicInstaller.FullName -Destination (Join-Path $finalDir $publicInstaller.Name) -Force
  Write-Host "  -> $($publicInstaller.Name) ($([math]::Round($publicInstaller.Length / 1MB, 1)) MB)  [dist-electron only]"

  # C:\lulu-build 只保留 unpacked staging,不保留第二份安装包。
  Get-ChildItem -LiteralPath $distDir -Filter "lulu-setup*" -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue # temporary installer cleanup

} finally {
  Remove-Item -LiteralPath $generatedConfig -ErrorAction SilentlyContinue

  if ($oldElectronRunAsNode) {
    $env:ELECTRON_RUN_AS_NODE = $oldElectronRunAsNode
  } else {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  }
  if ($oldElectronCache) {
    $env:ELECTRON_CACHE = $oldElectronCache
  } else {
    Remove-Item Env:ELECTRON_CACHE -ErrorAction SilentlyContinue
  }
  if ($oldElectronBuilderCache) {
    $env:ELECTRON_BUILDER_CACHE = $oldElectronBuilderCache
  } else {
    Remove-Item Env:ELECTRON_BUILDER_CACHE -ErrorAction SilentlyContinue
  }
}
