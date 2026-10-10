#!/usr/bin/env node
/**
 * Standalone .bat installer yaratadi - server.mjs ni o'ziga embedded qiladi
 * Faylni yuklab olib ishga tushirish mumkin (internet shart emas)
 *
 * Usage:
 *   node scripts/create-bundled-installer.mjs [--out <dir>]
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outArg = process.argv.indexOf("--out");
const outDir = path.resolve(
  outArg > 0 ? process.argv[outArg + 1] : path.join(root, "release", "payload")
);

const serverFile = path.join(outDir, "server", "server.mjs");
const manifestFile = path.join(outDir, "server", "manifest.json");
const noticesFile = path.join(outDir, "server", "THIRD_PARTY_NOTICES.txt");

console.log("Reading bundled server...");
const serverContent = await fs.readFile(serverFile);
const manifestContent = await fs.readFile(manifestFile, "utf8");
const noticesContent = await fs.readFile(noticesFile, "utf8");

// Base64 encode
const serverBase64 = serverContent.toString("base64");
const manifestBase64 = Buffer.from(manifestContent).toString("base64");
const noticesBase64 = Buffer.from(noticesContent).toString("base64");

console.log(`Server size: ${(serverContent.length / 1024).toFixed(1)} KB`);
console.log(`Embedded installer size (before compression): ${((serverBase64.length + manifestBase64.length + noticesBase64.length) / 1024).toFixed(1)} KB`);

// .bat installer template with embedded files
const batTemplate = `@echo off
REM Local MCP Platform - Standalone Self-Extracting Installer
REM This file contains the complete bundled server
REM Yuklab olib ishga tushirsangiz hammasi avtomatik o'rnatiladi
REM
REM Usage:
REM   install-standalone.bat
REM   install-standalone.bat 1  (silent mode)

setlocal enabledelayedexpansion

set "QUIET=%1"
set "INSTALL_DIR=%ProgramFiles%\\LocalMCPPlatform"
set "DATA_DIR=%APPDATA%\\LocalMCPPlatform"

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

REM Embedded fayllarni extract qiling
if not "%QUIET%"=="1" echo [INFO] Server bundle extract qilinmoqda...

set "TEMP_DIR=%TEMP%\\lmp-install-%RANDOM%"
mkdir "%TEMP_DIR%"

REM Base64 fayllarni yaratish va decode qilish
powershell -NoProfile -Command ^
  "$manifest = '${manifestBase64}'; " ^
  "$server = '${serverBase64}'; " ^
  "$notices = '${noticesBase64}'; " ^
  "[IO.File]::WriteAllBytes('%TEMP_DIR%\\manifest.json', [Convert]::FromBase64String($manifest)); " ^
  "[IO.File]::WriteAllBytes('%TEMP_DIR%\\server.mjs', [Convert]::FromBase64String($server)); " ^
  "[IO.File]::WriteAllBytes('%TEMP_DIR%\\THIRD_PARTY_NOTICES.txt', [Convert]::FromBase64String($notices))"

if errorlevel 1 (
  if not "%QUIET%"=="1" echo ERROR: Extract qilishda xatolik!
  rmdir /s /q "%TEMP_DIR%" 2>nul
  if not "%QUIET%"=="1" pause
  exit /b 1
)

REM SHA-256 tekshirish
if not "%QUIET%"=="1" echo [INFO] SHA-256 tekshirilmoqda...

for /f "tokens=*" %%i in ('powershell -NoProfile -Command "(Get-FileHash '%TEMP_DIR%\\server.mjs' -Algorithm SHA256).Hash"') do set "ACTUAL_SHA=%%i"
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "(Get-Content '%TEMP_DIR%\\manifest.json' | ConvertFrom-Json).serverSha256"') do set "EXPECTED_SHA=%%i"

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
copy /Y "%TEMP_DIR%\\server.mjs" "%INSTALL_DIR%\\server.mjs" >nul
copy /Y "%TEMP_DIR%\\manifest.json" "%INSTALL_DIR%\\manifest.json" >nul
copy /Y "%TEMP_DIR%\\THIRD_PARTY_NOTICES.txt" "%INSTALL_DIR%\\THIRD_PARTY_NOTICES.txt" >nul

REM run.bat wrapper yaratish
(
  echo @echo off
  echo node "%INSTALL_DIR%\\server.mjs" --data-root "%DATA_DIR%" %%*
) > "%INSTALL_DIR%\\run.bat"

if not "%QUIET%"=="1" echo [OK] Server o'rnatildi

REM Claude Desktop config qo'shish
if not "%QUIET%"=="1" echo [INFO] Claude Desktop configurationi o'zgartirilmoqda...
set "CLAUDE_CONFIG_DIR=%APPDATA%\\Claude"
set "CLAUDE_CONFIG_FILE=%CLAUDE_CONFIG_DIR%\\claude_desktop_config.json"

if not exist "%CLAUDE_CONFIG_DIR%" mkdir "%CLAUDE_CONFIG_DIR%"

powershell -NoProfile -Command ^
  "$configFile = '%CLAUDE_CONFIG_FILE%'; " ^
  "$config = if (Test-Path $configFile) { Get-Content $configFile | ConvertFrom-Json } else { @{ mcpServers = @{} } }; " ^
  "if (-not $config.mcpServers) { $config | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue @{} }; " ^
  "$config.mcpServers['local-platform'] = @{ " ^
  "  command = 'node'; " ^
  "  args = @('%INSTALL_DIR%\\server.mjs', '--data-root', '%DATA_DIR%', '--log-level', 'info'); " ^
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
  echo   node "%INSTALL_DIR%\\server.mjs" --data-root "%DATA_DIR%" --log-level debug
  echo.
  pause
)

exit /b 0
`;

// Output faylni yaratish
const outputPath = path.join(root, "release", "LocalMCPPlatform-installer.bat");
await fs.writeFile(outputPath, batTemplate);

console.log(`\n✓ Bundled installer created: ${path.relative(root, outputPath)}`);
console.log(`  File size: ${((await fs.stat(outputPath)).size / 1024).toFixed(1)} KB`);
console.log(`\nUsage:`);
console.log(`  1. Download: LocalMCPPlatform-installer.bat`);
console.log(`  2. Right-click > Run as Administrator`);
console.log(`  3. Installation completes automatically`);
console.log(`\nSilent install:`);
console.log(`  LocalMCPPlatform-installer.bat 1`);
