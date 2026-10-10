#!/usr/bin/env pwsh
<#
  Installs the Local MCP Platform bundled server.

  Usage:
    powershell -ExecutionPolicy Bypass -File install.ps1 [-InstallDir <path>] [-DataDir <path>]

  Requirements:
    - Windows 7 SP1 or later
    - Node.js 22.12.0 or later
    - Administrator privileges (for %ProgramFiles% install)
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "$env:ProgramFiles\LocalMCPPlatform",
  [string]$DataDir = "$env:APPDATA\LocalMCPPlatform"
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Write-Host "Local MCP Platform Installer" -ForegroundColor Cyan
Write-Host "version 0.1.0" -ForegroundColor Cyan
Write-Host ""

# Check prerequisites
Write-Host "Checking prerequisites..." -ForegroundColor Yellow

$nodePath = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodePath) {
  Write-Error "Node.js is not installed or not in PATH. Install Node.js 22.12.0 or later from https://nodejs.org/"
}

try {
  $nodeVersion = node --version
  $majorMinor = $nodeVersion -replace 'v(\d+\.\d+).*', '$1'
  $major = [int]$majorMinor.Split('.')[0]
  $minor = [int]$majorMinor.Split('.')[1]
  if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 12)) {
    Write-Error "Node.js version $nodeVersion is below minimum 22.12.0"
  }
  Write-Host "  ✓ Node.js $nodeVersion" -ForegroundColor Green
} catch {
  Write-Error "Failed to check Node.js version: $_"
}

# Check if running as admin for %ProgramFiles% install
if ($InstallDir -like "$env:ProgramFiles*") {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [System.Security.Principal.WindowsPrincipal]$identity
  if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Administrator privileges required to install to $InstallDir"
  }
}
Write-Host "  ✓ Installation directory: $InstallDir" -ForegroundColor Green
Write-Host "  ✓ Data directory: $DataDir" -ForegroundColor Green

# Prepare directories
Write-Host ""
Write-Host "Preparing installation directories..." -ForegroundColor Yellow
$null = New-Item -ItemType Directory -Path $InstallDir -Force -ErrorAction SilentlyContinue
$null = New-Item -ItemType Directory -Path $DataDir -Force -ErrorAction SilentlyContinue

# Locate the bundled server and payload
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$payloadDir = Join-Path $projectRoot "release" "payload"
$serverFile = Join-Path $payloadDir "server" "server.mjs"
$manifestFile = Join-Path $payloadDir "server" "manifest.json"
$noticesFile = Join-Path $payloadDir "server" "THIRD_PARTY_NOTICES.txt"

if (-not (Test-Path $serverFile)) {
  Write-Error "Bundle not found at $serverFile. Run 'npm run build && node scripts/bundle.mjs' first."
}

Write-Host "  ✓ Bundle found ($((Get-Item $serverFile).Length / 1MB).2f MB)" -ForegroundColor Green

# Load manifest
$manifest = Get-Content $manifestFile | ConvertFrom-Json
Write-Host "  ✓ Version: $($manifest.version)" -ForegroundColor Green
Write-Host "  ✓ Tools: $($manifest.tools.Count)" -ForegroundColor Green

# Validate SHA-256
Write-Host ""
Write-Host "Validating bundle integrity..." -ForegroundColor Yellow
$hash = Get-FileHash $serverFile -Algorithm SHA256
if ($hash.Hash -ne $manifest.serverSha256) {
  Write-Error "Bundle SHA-256 mismatch.`nExpected: $($manifest.serverSha256)`nGot: $($hash.Hash)"
}
Write-Host "  ✓ SHA-256 verified" -ForegroundColor Green

# Extract bundle
Write-Host ""
Write-Host "Installing bundled server..." -ForegroundColor Yellow
Copy-Item $serverFile (Join-Path $InstallDir "server.mjs") -Force
Copy-Item $manifestFile (Join-Path $InstallDir "manifest.json") -Force
Copy-Item $noticesFile (Join-Path $InstallDir "THIRD_PARTY_NOTICES.txt") -Force
Write-Host "  ✓ Server extracted to $InstallDir" -ForegroundColor Green

# Create batch wrapper for easy invocation
$wrapperPath = Join-Path $InstallDir "run.bat"
@"
@echo off
node "$((Join-Path $InstallDir "server.mjs") -replace '\\', '\\')" --data-root "$($DataDir -replace '\\', '\\')" %*
"@ | Out-File -FilePath $wrapperPath -Encoding ASCII -Force
Write-Host "  ✓ Created run.bat wrapper" -ForegroundColor Green

# Write configuration for Claude Desktop
Write-Host ""
Write-Host "Configuring Claude Desktop..." -ForegroundColor Yellow
$claudeConfigDir = Join-Path $env:APPDATA "Claude"
$claudeConfigFile = Join-Path $claudeConfigDir "claude_desktop_config.json"

$null = New-Item -ItemType Directory -Path $claudeConfigDir -Force -ErrorAction SilentlyContinue

$serverPath = Join-Path $InstallDir "server.mjs"
$config = @{
  mcpServers = @{
    "local-platform" = @{
      command = "node"
      args = @(
        $serverPath,
        "--data-root", $DataDir,
        "--log-level", "info"
      )
      disabled = $false
    }
  }
}

# Merge with existing config if it exists
if (Test-Path $claudeConfigFile) {
  try {
    $existing = Get-Content $claudeConfigFile | ConvertFrom-Json
    if ($existing.mcpServers -eq $null) { $existing | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue @{} }
    $existing.mcpServers["local-platform"] = $config.mcpServers["local-platform"]
    $config = $existing
  } catch {
    Write-Warning "Could not merge with existing config at $claudeConfigFile. Using fresh config."
  }
}

$config | ConvertTo-Json -Depth 10 | Out-File -FilePath $claudeConfigFile -Encoding UTF8 -Force
Write-Host "  ✓ Configuration written to $claudeConfigFile" -ForegroundColor Green
Write-Host ""
Write-Host "Restart Claude Desktop to load the new MCP server." -ForegroundColor Cyan
Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host "  Install directory: $InstallDir" -ForegroundColor Cyan
Write-Host "  Data directory: $DataDir" -ForegroundColor Cyan
Write-Host "  Config file: $claudeConfigFile" -ForegroundColor Cyan
Write-Host ""
Write-Host "To verify, run:" -ForegroundColor Cyan
Write-Host "  node '$serverPath' --data-root '$DataDir' --log-level debug" -ForegroundColor Yellow
