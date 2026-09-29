@echo off
setlocal EnableExtensions DisableDelayedExpansion
title GeminiCut - Flow Runtime Setup
where node >nul 2>&1
if errorlevel 1 (
    echo Node.js 20 yoki undan yangi versiyasini https://nodejs.org saytidan o'rnating.
    pause
    exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0])<20)process.exit(1)"
if errorlevel 1 (
    echo Node.js 20 yoki undan yangi versiyasi kerak.
    pause
    exit /b 1
)
set "GC_RUNTIME=%LOCALAPPDATA%\GeminiCut\FlowRuntime"
if not exist "%GC_RUNTIME%" mkdir "%GC_RUNTIME%"
copy /Y "%~dp0package.json" "%GC_RUNTIME%\package.json" >nul
if errorlevel 1 exit /b 1
pushd "%GC_RUNTIME%"
call npm install --omit=dev --ignore-scripts --no-audit --no-fund
set "GC_RESULT=%ERRORLEVEL%"
popd
if not "%GC_RESULT%"=="0" (
    echo Flow yordamchisi o'rnatilmadi. Internet va npm mavjudligini tekshiring.
    pause
    exit /b 1
)
echo TAYYOR. Premiere'da GeminiCut - Google Flow bo'limini oching.
echo Chrome yoki Microsoft Edge o'rnatilgan bo'lishi kerak.
pause
exit /b 0
