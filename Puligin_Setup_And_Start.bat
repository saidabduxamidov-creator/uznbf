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
set MCP_SERVER=%PULIGIN_ROOT%mcp-platform\packages\server\dist\src\cli-main.js
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
        echo %INFO% npm ci not available, trying npm install...
        call npm install >nul 2>&1
        if !errorlevel! neq 0 (
            echo %FAIL% npm install failed.
            echo Please manually run: cd mcp-platform ^&^& npm install
            pause
            exit /b 1
        )
    )
)
echo %PASS% Dependencies ready
echo.

REM Step 4: Build MCP platform if needed
echo %INFO% Checking MCP platform build...
if not exist "!PULIGIN_ROOT!mcp-platform\packages\server\dist\src\cli-main.js" (
    echo   Building TypeScript...
    call npm run build >nul 2>&1
    if !errorlevel! neq 0 (
        echo %FAIL% Build failed.
        echo Running build again with output...
        call npm run build
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
        echo   "logging": { "level": "info", "stderrLevel": "warn" },
        echo   "permissions": {
        echo     "defaults": { "network": "deny", "fs.write": "ask" }
        echo   },
        echo   "tools": {
        echo     "directories": []
        echo   }
        echo }
    ) > "!CONFIG_DIR!\config.json"
)
echo %PASS% Configuration ready at: !CONFIG_DIR!\config.json
echo.

REM Step 6: Start MCP server
echo %INFO% Starting MCP Server...
echo   This MCP server provides AI tools to Claude Desktop and ChatGPT Desktop
echo   Configuration: !CONFIG_DIR!\config.json
echo   Data directory: !DATA_DIR!
echo.
echo   To connect from Claude Desktop:
echo   1. Add server config to ~/.claude/claude.json
echo   2. Use: { "mcpServers": { "puligin": { "command": "node", "args": ["!MCP_SERVER!", "--data-root", "!DATA_DIR!"] } } }
echo.

REM Run MCP server
cd /d "!PULIGIN_ROOT!mcp-platform"
node "!MCP_SERVER!" --data-root "!DATA_DIR!" --config "!CONFIG_DIR!\config.json" --log-level info

REM If we get here, the server stopped
if !errorlevel! neq 0 (
    echo.
    echo %FAIL% MCP Server exited with error code !errorlevel!
    echo Check logs at: !LOG_DIR!
    pause
)

endlocal
exit /b !errorlevel!
