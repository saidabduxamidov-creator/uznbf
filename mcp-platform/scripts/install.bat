@echo off
REM Installs the Local MCP Platform bundled server.
REM
REM Usage:
REM   install.bat [InstallDir] [DataDir]
REM
REM Requirements:
REM   - Windows 7 SP1 or later
REM   - Node.js 22.12.0 or later
REM   - Administrator privileges (for %ProgramFiles% install)

setlocal enabledelayedexpansion

if "%1"=="" (
  set "INSTALL_DIR=%ProgramFiles%\LocalMCPPlatform"
) else (
  set "INSTALL_DIR=%1"
)

if "%2"=="" (
  set "DATA_DIR=%APPDATA%\LocalMCPPlatform"
) else (
  set "DATA_DIR=%2"
)

echo.
echo Local MCP Platform Installer
echo version 0.1.0
echo.

REM Check prerequisites
echo Checking prerequisites...

REM Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
  echo.
  echo ERROR: Node.js is not installed or not in PATH.
  echo Install Node.js 22.12.0 or later from https://nodejs.org/
  pause
  exit /b 1
)

REM Get Node.js version
for /f "tokens=*" %%i in ('node --version') do set "NODE_VERSION=%%i"
echo   [OK] Node.js %NODE_VERSION%

REM Check admin privileges for %ProgramFiles% install
echo %INSTALL_DIR% | findstr /i "%ProgramFiles%" >nul
if not errorlevel 1 (
  net session >nul 2>&1
  if errorlevel 1 (
    echo.
    echo ERROR: Administrator privileges required to install to %INSTALL_DIR%
    echo Please run this installer as Administrator.
    pause
    exit /b 1
  )
)

echo   [OK] Installation directory: %INSTALL_DIR%
echo   [OK] Data directory: %DATA_DIR%

REM Prepare directories
echo.
echo Preparing installation directories...
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

REM Locate the bundled server and payload
set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
set "PAYLOAD_DIR=%PROJECT_ROOT%\release\payload"
set "SERVER_FILE=%PAYLOAD_DIR%\server\server.mjs"
set "MANIFEST_FILE=%PAYLOAD_DIR%\server\manifest.json"
set "NOTICES_FILE=%PAYLOAD_DIR%\server\THIRD_PARTY_NOTICES.txt"

if not exist "%SERVER_FILE%" (
  echo.
  echo ERROR: Bundle not found at %SERVER_FILE%
  echo Run 'npm run build ^&^& node scripts/bundle.mjs' first.
  pause
  exit /b 1
)

for %%A in ("%SERVER_FILE%") do set "SIZE=%%~zA"
set /a SIZE_MB=SIZE/1048576
echo   [OK] Bundle found (%SIZE_MB% MB)

REM Load manifest
echo   [OK] Manifest loaded from %MANIFEST_FILE%

REM Validate SHA-256
echo.
echo Validating bundle integrity...

REM Compute SHA-256 using PowerShell (most compatible)
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "(Get-FileHash '%SERVER_FILE%' -Algorithm SHA256).Hash"') do set "ACTUAL_SHA=%%i"

REM Extract expected SHA from manifest using PowerShell
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "(Get-Content '%MANIFEST_FILE%' | ConvertFrom-Json).serverSha256"') do set "EXPECTED_SHA=%%i"

if not "%ACTUAL_SHA%"=="%EXPECTED_SHA%" (
  echo.
  echo ERROR: Bundle SHA-256 mismatch.
  echo Expected: %EXPECTED_SHA%
  echo Got: %ACTUAL_SHA%
  pause
  exit /b 1
)

echo   [OK] SHA-256 verified

REM Extract bundle
echo.
echo Installing bundled server...
copy /Y "%SERVER_FILE%" "%INSTALL_DIR%\server.mjs" >nul
copy /Y "%MANIFEST_FILE%" "%INSTALL_DIR%\manifest.json" >nul
copy /Y "%NOTICES_FILE%" "%INSTALL_DIR%\THIRD_PARTY_NOTICES.txt" >nul
echo   [OK] Server extracted to %INSTALL_DIR%

REM Create batch wrapper for easy invocation
echo Creating run.bat wrapper...
(
  echo @echo off
  echo node "%INSTALL_DIR%\server.mjs" --data-root "%DATA_DIR%" %%*
) > "%INSTALL_DIR%\run.bat"
echo   [OK] Created run.bat wrapper

REM Write configuration for Claude Desktop
echo.
echo Configuring Claude Desktop...
set "CLAUDE_CONFIG_DIR=%APPDATA%\Claude"
set "CLAUDE_CONFIG_FILE=%CLAUDE_CONFIG_DIR%\claude_desktop_config.json"

if not exist "%CLAUDE_CONFIG_DIR%" mkdir "%CLAUDE_CONFIG_DIR%"

REM Create config using PowerShell (handles JSON better than batch)
powershell -NoProfile -Command ^
  "$configFile = '%CLAUDE_CONFIG_FILE%'; " ^
  "$config = if (Test-Path $configFile) { Get-Content $configFile | ConvertFrom-Json } else { @{ mcpServers = @{} } }; " ^
  "if (-not $config.mcpServers) { $config | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue @{} }; " ^
  "$config.mcpServers['local-platform'] = @{ " ^
  "  command = 'node'; " ^
  "  args = @('%INSTALL_DIR%\server.mjs', '--data-root', '%DATA_DIR%', '--log-level', 'info'); " ^
  "  disabled = $false " ^
  "}; " ^
  "$config | ConvertTo-Json -Depth 10 | Out-File -FilePath $configFile -Encoding UTF8 -Force"

echo   [OK] Configuration written to %CLAUDE_CONFIG_FILE%

echo.
echo Restart Claude Desktop to load the new MCP server.
echo.
echo Installation complete!
echo   Install directory: %INSTALL_DIR%
echo   Data directory: %DATA_DIR%
echo   Config file: %CLAUDE_CONFIG_FILE%
echo.
echo To verify, run:
echo   node "%INSTALL_DIR%\server.mjs" --data-root "%DATA_DIR%" --log-level debug
echo.
pause
