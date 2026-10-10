#!/usr/bin/env pwsh
<#
  Uninstalls the Local MCP Platform.

  Usage:
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-InstallDir <path>]
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$InstallDir = "$env:ProgramFiles\LocalMCPPlatform"
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Write-Host "Local MCP Platform Uninstaller" -ForegroundColor Cyan
Write-Host ""

# Check if running as admin for %ProgramFiles% removal
if ($InstallDir -like "$env:ProgramFiles*") {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [System.Security.Principal.WindowsPrincipal]$identity
  if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Administrator privileges required to uninstall from $InstallDir"
  }
}

# Remove from Claude Desktop config
Write-Host "Updating Claude Desktop configuration..." -ForegroundColor Yellow
$claudeConfigFile = Join-Path $env:APPDATA "Claude" "claude_desktop_config.json"

if (Test-Path $claudeConfigFile) {
  try {
    $config = Get-Content $claudeConfigFile | ConvertFrom-Json
    if ($config.mcpServers -and $config.mcpServers."local-platform") {
      $config.mcpServers.PSObject.Properties.Remove("local-platform")
      $config | ConvertTo-Json -Depth 10 | Out-File -FilePath $claudeConfigFile -Encoding UTF8 -Force
      Write-Host "  ✓ Removed from Claude Desktop config" -ForegroundColor Green
    }
  } catch {
    Write-Warning "Could not update config at $claudeConfigFile : $_"
  }
}

# Remove installation directory
if (Test-Path $InstallDir) {
  Write-Host "Removing installation directory..." -ForegroundColor Yellow
  Remove-Item -Path $InstallDir -Recurse -Force
  Write-Host "  ✓ Removed $InstallDir" -ForegroundColor Green
}

Write-Host ""
Write-Host "Restart Claude Desktop to complete uninstallation." -ForegroundColor Cyan
