@echo off
REM Local MCP Platform - Standalone Installer
REM Yuklab olib ishga tushirsangiz hammasi avtomatik o'rnatiladi
REM
REM Features:
REM   - Administrator o'tkazadi
REM   - Node.js o'rnatishni tekshiradi
REM   - Bundled server o'rnatadi
REM   - Claude Desktop ni configurationni qo'shadi
REM   - Quiet mode (1 ni pass qilish = silent install)
REM
REM Usage:
REM   install-standalone.bat [1 for silent]

setlocal enabledelayedexpansion

set "QUIET=%1"
set "INSTALL_DIR=%ProgramFiles%\LocalMCPPlatform"
set "DATA_DIR=%APPDATA%\LocalMCPPlatform"

REM Admin tekshirish
net session >nul 2>&1
if errorlevel 1 (
  if not "%QUIET%"=="1" (
    echo.
    echo ERROR: Administrator huquqlari shart!
    echo Please run as Administrator.
    echo.
    pause
  )
  exit /b 1
)

REM Silent mode bo'lmasa, sarlavha ko'rsat
if not "%QUIET%"=="1" (
  cls
  echo.
  echo ======================================
  echo Local MCP Platform Installer
  echo version 0.1.0
  echo ======================================
  echo.
)

REM Node.js tekshirish
node --version >nul 2>&1
if errorlevel 1 (
  if not "%QUIET%"=="1" (
    echo ERROR: Node.js o'rnatilmagan!
    echo https://nodejs.org/ dan Node.js 22.12.0+ o'rnating
    echo.
    pause
  )
  exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set "NODE_VERSION=%%i"
if not "%QUIET%"=="1" echo [OK] Node.js %NODE_VERSION%

REM Direktoryalarni tayyorla
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

if not "%QUIET%"=="1" echo [OK] Installation directory: %INSTALL_DIR%

REM ===== SERVER.MJS BUNDLED CONTENT =====
REM Bu yerda server.mjs base64 encoded bo'lib ko'chadi
REM Siz "node scripts/bundle.mjs" dan bundle.mjs faylini olasiz
REM va uning mazmunini base64 ga encode qilasiz

REM Placeholder uchun demo server
REM HAQIQIY INSTALLDA BU YERDA SERVER BUNDLED BO'LADI
if not "%QUIET%"=="1" echo [INFO] Server bundle fayli qidirilyapti...

REM Bundle ni GitHub dan yuklab olish (agar bundled bo'lmasa)
set "MANIFEST_URL=https://raw.githubusercontent.com/saidabduxamidov-creator/uznbf/claude/geminicut-plugin-install-error-3s9zd1/mcp-platform/release/payload/server/manifest.json"
set "SERVER_URL=https://raw.githubusercontent.com/saidabduxamidov-creator/uznbf/claude/geminicut-plugin-install-error-3s9zd1/mcp-platform/release/payload/server/server.mjs"
set "NOTICES_URL=https://raw.githubusercontent.com/saidabduxamidov-creator/uznbf/claude/geminicut-plugin-install-error-3s9zd1/mcp-platform/release/payload/server/THIRD_PARTY_NOTICES.txt"

REM Temp direktoryasini tayyorla
set "TEMP_DIR=%TEMP%\lmp-install-%RANDOM%"
mkdir "%TEMP_DIR%"

if not "%QUIET%"=="1" echo [INFO] Manifest yuklanmoqda...
powershell -NoProfile -Command "try { $ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri '%MANIFEST_URL%' -OutFile '%TEMP_DIR%\manifest.json' -TimeoutSec 30 } catch { exit 1 }"
if errorlevel 1 (
  if not "%QUIET%"=="1" (
    echo ERROR: Manifest yuklab olinmadi!
    echo Tarmoq ulanishini tekshiring.
    pause
  )
  rmdir /s /q "%TEMP_DIR%" 2>nul
  exit /b 1
)

if not "%QUIET%"=="1" echo [INFO] Server bundle yuklanmoqda (1.6 MB)...
powershell -NoProfile -Command "try { $ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri '%SERVER_URL%' -OutFile '%TEMP_DIR%\server.mjs' -TimeoutSec 60 } catch { exit 1 }"
if errorlevel 1 (
  if not "%QUIET%"=="1" (
    echo ERROR: Server bundle yuklab olinmadi!
    pause
  )
  rmdir /s /q "%TEMP_DIR%" 2>nul
  exit /b 1
)

if not "%QUIET%"=="1" echo [INFO] License notices yuklanmoqda...
powershell -NoProfile -Command "try { $ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri '%NOTICES_URL%' -OutFile '%TEMP_DIR%\THIRD_PARTY_NOTICES.txt' -TimeoutSec 30 } catch { exit 1 }"

REM SHA-256 tekshirish
if not "%QUIET%"=="1" echo [INFO] SHA-256 tekshirilmoqda...
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "(Get-FileHash '%TEMP_DIR%\server.mjs' -Algorithm SHA256).Hash"') do set "ACTUAL_SHA=%%i"
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "(Get-Content '%TEMP_DIR%\manifest.json' | ConvertFrom-Json).serverSha256"') do set "EXPECTED_SHA=%%i"

if not "%ACTUAL_SHA%"=="%EXPECTED_SHA%" (
  if not "%QUIET%"=="1" (
    echo ERROR: SHA-256 mismatch!
    echo Expected: %EXPECTED_SHA%
    echo Got: %ACTUAL_SHA%
    pause
  )
  rmdir /s /q "%TEMP_DIR%" 2>nul
  exit /b 1
)

if not "%QUIET%"=="1" echo [OK] Integrity verified

REM Fayllarni o'rnatish joyiga ko'chish
if not "%QUIET%"=="1" echo [INFO] Server o'rnatilmoqda...
copy /Y "%TEMP_DIR%\server.mjs" "%INSTALL_DIR%\server.mjs" >nul
copy /Y "%TEMP_DIR%\manifest.json" "%INSTALL_DIR%\manifest.json" >nul
copy /Y "%TEMP_DIR%\THIRD_PARTY_NOTICES.txt" "%INSTALL_DIR%\THIRD_PARTY_NOTICES.txt" >nul

REM run.bat wrapper yaratish
(
  echo @echo off
  echo node "%INSTALL_DIR%\server.mjs" --data-root "%DATA_DIR%" %%*
) > "%INSTALL_DIR%\run.bat"

if not "%QUIET%"=="1" echo [OK] Server o'rnatildi

REM Claude Desktop config qo'shish
if not "%QUIET%"=="1" echo [INFO] Claude Desktop configurationi o'zgartirilmoqda...
set "CLAUDE_CONFIG_DIR=%APPDATA%\Claude"
set "CLAUDE_CONFIG_FILE=%CLAUDE_CONFIG_DIR%\claude_desktop_config.json"

if not exist "%CLAUDE_CONFIG_DIR%" mkdir "%CLAUDE_CONFIG_DIR%"

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

if not "%QUIET%"=="1" echo [OK] Configuration saved

REM Cleanup
rmdir /s /q "%TEMP_DIR%" 2>nul

REM Success message
if "%QUIET%"=="1" (
  exit /b 0
) else (
  echo.
  echo ======================================
  echo Installation COMPLETE!
  echo ======================================
  echo.
  echo Install directory: %INSTALL_DIR%
  echo Data directory: %DATA_DIR%
  echo Config file: %CLAUDE_CONFIG_FILE%
  echo.
  echo Claude Desktop ni restart qiling - MCP server avtomatik yuklanadi
  echo.
  echo Test qilish:
  echo   node "%INSTALL_DIR%\server.mjs" --data-root "%DATA_DIR%" --log-level debug
  echo.
  pause
)

exit /b 0
