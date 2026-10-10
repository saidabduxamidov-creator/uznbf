@echo off
REM Uninstalls the Local MCP Platform.
REM
REM Usage:
REM   uninstall.bat [InstallDir]

setlocal enabledelayedexpansion

if "%1"=="" (
  set "INSTALL_DIR=%ProgramFiles%\LocalMCPPlatform"
) else (
  set "INSTALL_DIR=%1"
)

echo.
echo Local MCP Platform Uninstaller
echo.

REM Check admin privileges for %ProgramFiles% removal
echo %INSTALL_DIR% | findstr /i "%ProgramFiles%" >nul
if not errorlevel 1 (
  net session >nul 2>&1
  if errorlevel 1 (
    echo.
    echo ERROR: Administrator privileges required to uninstall from %INSTALL_DIR%
    echo Please run this uninstaller as Administrator.
    pause
    exit /b 1
  )
)

REM Remove from Claude Desktop config
echo Updating Claude Desktop configuration...
set "CLAUDE_CONFIG_FILE=%APPDATA%\Claude\claude_desktop_config.json"

if exist "%CLAUDE_CONFIG_FILE%" (
  powershell -NoProfile -Command ^
    "$configFile = '%CLAUDE_CONFIG_FILE%'; " ^
    "$config = Get-Content $configFile | ConvertFrom-Json; " ^
    "if ($config.mcpServers -and $config.mcpServers.'local-platform') { " ^
    "  $config.mcpServers.PSObject.Properties.Remove('local-platform'); " ^
    "  $config | ConvertTo-Json -Depth 10 | Out-File -FilePath $configFile -Encoding UTF8 -Force; " ^
    "  Write-Host '   [OK] Removed from Claude Desktop config' -ForegroundColor Green " ^
    "}"
) else (
  echo   [OK] Claude Desktop config not found
)

REM Remove installation directory
if exist "%INSTALL_DIR%" (
  echo Removing installation directory...
  rmdir /s /q "%INSTALL_DIR%"
  if errorlevel 1 (
    echo   ERROR: Could not remove %INSTALL_DIR%
    pause
    exit /b 1
  )
  echo   [OK] Removed %INSTALL_DIR%
)

echo.
echo Restart Claude Desktop to complete uninstallation.
echo.
pause
