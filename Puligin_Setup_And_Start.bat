@echo off
REM Puligin Universal AI MCP Platform - Setup and Launch Script
REM Supports: ChatGPT, Claude, Gemini with unified MCP server
REM Windows batch installer that handles full setup and execution

setlocal enabledelayedexpansion

echo.
echo ==========================================
echo  Puligin Universal AI Platform Setup
echo ==========================================
echo.

REM Get script directory
set SCRIPT_DIR=%~dp0
set PULIGIN_ROOT=%SCRIPT_DIR%

REM Configuration
set MCP_SERVER=%PULIGIN_ROOT%mcp-platform\packages\server\dist\src\cli.js
set NODE_PATH=%PULIGIN_ROOT%mcp-platform\node_modules
set LOG_DIR=%PULIGIN_ROOT%logs
set CONFIG_DIR=%APPDATA%\LocalMcpPlatform
set DATA_DIR=%CONFIG_DIR%\data

REM Colors and formatting
set "PASS=[OK]"
set "FAIL=[FAIL]"
set "INFO=[INFO]"

REM Step 1: Check Node.js installation
echo %INFO% Checking Node.js installation...
node --version >nul 2>&1
if !errorlevel! neq 0 (
    echo %FAIL% Node.js is not installed or not in PATH.
    echo Please install Node.js 22.12 or newer from https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo %PASS% Found !NODE_VERSION!
echo.

REM Step 2: Create required directories
echo %INFO% Creating required directories...
if not exist "!LOG_DIR!" mkdir "!LOG_DIR!"
if not exist "!CONFIG_DIR!" mkdir "!CONFIG_DIR!"
if not exist "!DATA_DIR!" mkdir "!DATA_DIR!"
echo %PASS% Directories created
echo.

REM Step 3: Install MCP platform dependencies
echo %INFO% Installing MCP platform dependencies...
cd /d "!PULIGIN_ROOT!mcp-platform"
if not exist "node_modules" (
    echo   Running npm ci...
    call npm ci >nul 2>&1
    if !errorlevel! neq 0 (
        echo %FAIL% npm installation failed.
        echo Running npm install as fallback...
        call npm install >nul 2>&1
        if !errorlevel! neq 0 (
            echo %FAIL% npm install also failed.
            echo You may need to manually run: cd mcp-platform && npm install
            pause
            exit /b 1
        )
    )
)
echo %PASS% Dependencies ready
echo.

REM Step 4: Build MCP platform if needed
echo %INFO% Checking MCP platform build...
if not exist "!PULIGIN_ROOT!mcp-platform\packages\server\dist" (
    echo   Building TypeScript...
    call npm run build >nul 2>&1
    if !errorlevel! neq 0 (
        echo %FAIL% Build failed.
        pause
        exit /b 1
    )
)
echo %PASS% Build verified
echo.

REM Step 5: Validate configuration
echo %INFO% Validating configuration...
if not exist "!CONFIG_DIR!\config.json" (
    echo %INFO% Creating default configuration...
    (
        echo {
        echo   "logging": { "level": "info" },
        echo   "permissions": {
        echo     "defaults": { "network": "deny", "fs.write": "ask" }
        echo   },
        echo   "ai": {
        echo     "chatgpt": null,
        echo     "claude": null,
        echo     "gemini": null
        echo   }
        echo }
    ) > "!CONFIG_DIR!\config.json"
)
echo %PASS% Configuration ready
echo.

REM Step 6: Open Premiere Pro plugin (if available)
echo %INFO% Checking Adobe plugins...
for /f "delims=" %%i in ('where PremierePro.exe 2^>nul') do (
    echo %PASS% Found Adobe Premiere Pro
    set FOUND_PREMIERE=1
)

if not defined FOUND_PREMIERE (
    echo %INFO% Adobe Premiere Pro not found (optional)
)
echo.

REM Step 7: Start MCP server
echo %INFO% Starting MCP server...
echo   Listening on stdio for Claude Desktop or ChatGPT Desktop
echo.

REM Create startup wrapper
set MCP_LOG="!LOG_DIR!\mcp-server.log"

REM Run with configuration
cd /d "!PULIGIN_ROOT!mcp-platform"
node "!MCP_SERVER!" ^
  --config "!CONFIG_DIR!\config.json" ^
  --log-level info ^
  --data-root "!DATA_DIR!" >> !MCP_LOG! 2>&1

if !errorlevel! neq 0 (
    echo %FAIL% MCP server failed to start
    echo Check log file: !MCP_LOG!
    pause
    exit /b 1
)

endlocal
exit /b 0
