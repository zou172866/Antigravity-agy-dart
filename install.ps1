<#
.SYNOPSIS
  One-command Windows installer for agy-dart (supports both clone-free `irm ... | iex` and local repo runs).
.EXAMPLE
  irm https://raw.githubusercontent.com/zou172866/Antigravity-agy-dart/v1.10.0/install.ps1 | iex
  .\install.ps1 -InstallRg
  .\install.ps1 -ToolLoading fast-eager
  .\install.ps1 -WithDevtools
  .\install.ps1 -Command doctor
#>
param(
  [ValidateSet("install", "doctor", "uninstall", "mode", "tool-loading")]
  [string]$Command = "install",
  [ValidateSet("host-45k", "balanced-16k", "fast-32k", "strict-8k", "no-read-hook")]
  [string]$Mode = "host-45k",
  [ValidateSet("fast-eager", "lazy", "eager")]
  [string]$ToolLoading = "fast-eager",
  [switch]$InstallRg,
  [switch]$WithDevtools,
  [switch]$Json,
  [string]$Project = ""
)

$ErrorActionPreference = "Stop"
$ScriptPath = $MyInvocation.MyCommand.Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $msg = "Install Node.js 22.16+ (22.x) or 24+ with built-in SQLite FTS5: https://nodejs.org/"
  if ($ScriptPath) { Write-Error $msg; exit 1 } else { throw $msg }
}

$ScriptDir = if ($ScriptPath) { Split-Path -Parent $ScriptPath } else { "" }
$Installer = if ($ScriptDir) { Join-Path $ScriptDir "scripts\install.mjs" } else { "" }
$TempWorkDir = ""

try {
  if (-not $Installer -or -not (Test-Path -LiteralPath $Installer)) {
    $TempWorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-dart-bootstrap-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $TempWorkDir | Out-Null
    $RepoDir = Join-Path $TempWorkDir "repo"
    if (Get-Command git -ErrorAction SilentlyContinue) {
      Write-Host "[agy-dart] Fetching latest release from GitHub..."
      & git clone --depth 1 --branch v1.10.0 --quiet "https://github.com/zou172866/Antigravity-agy-dart.git" $RepoDir
      if ($LASTEXITCODE -ne 0) { throw "git clone failed with exit code $LASTEXITCODE" }
    } else {
      Write-Host "[agy-dart] Downloading archive from GitHub..."
      $ZipFile = Join-Path $TempWorkDir "agy-dart.zip"
      Invoke-WebRequest -Uri "https://github.com/zou172866/Antigravity-agy-dart/archive/refs/tags/v1.10.0.zip" -OutFile $ZipFile -UseBasicParsing
      Expand-Archive -Path $ZipFile -DestinationPath $TempWorkDir -Force
      $Extracted = Get-ChildItem -Path $TempWorkDir -Directory -Filter "*agy-dart-*" | Select-Object -First 1
      if (-not $Extracted) { throw "Failed to unpack agy-dart archive." }
      $RepoDir = $Extracted.FullName
    }
    $Installer = Join-Path $RepoDir "scripts\install.mjs"
  }

  $nodeArgs = @($Installer, $Command)
  if ($Command -eq "install") {
    if ($PSBoundParameters.ContainsKey("Mode")) {
      $nodeArgs += @("--mode", $Mode)
    }
    if ($PSBoundParameters.ContainsKey("ToolLoading")) {
      $nodeArgs += @("--tool-loading", $ToolLoading)
    }
    if ($InstallRg) { $nodeArgs += "--install-rg" }
    if ($WithDevtools) { $nodeArgs += "--with-devtools" }
  } elseif ($Command -eq "mode") {
    $nodeArgs += $Mode
  } elseif ($Command -eq "tool-loading") {
    $nodeArgs += $ToolLoading
  } elseif ($Command -eq "doctor") {
    if ($Json) { $nodeArgs += "--json" }
  }
  if ($Project) {
    $nodeArgs += @("--project", $Project)
  }

  & node @nodeArgs
  if ($LASTEXITCODE -ne 0) {
    if ($ScriptPath) { exit $LASTEXITCODE } else { throw "agy-dart installer failed with exit code $LASTEXITCODE" }
  }
} finally {
  if ($TempWorkDir -and (Test-Path -LiteralPath $TempWorkDir)) {
    Remove-Item -LiteralPath $TempWorkDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
