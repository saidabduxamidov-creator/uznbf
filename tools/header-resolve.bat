@echo off
setlocal EnableExtensions DisableDelayedExpansion
title GeminiCut @VERSION@ for DaVinci Resolve - O'rnatuvchi

rem ==========================================================================
rem  GeminiCut @VERSION@ - DaVinci Resolve Studio uchun AI panel
rem  (Workflow Integration plugin: Workspace > Workflow Integrations > GeminiCut)
rem
rem  Bu fayl nima qiladi:
rem    1) Fayl oxiridagi plagin arxivini ajratib oladi, SHA-256 bilan tekshiradi.
rem    2) Plaginni %ProgramData%\Blackmagic Design\DaVinci Resolve\Support\
rem       Workflow Integration Plugins\GeminiCut papkasiga nusxalaydi
rem       (bu papka umumiy - shuning uchun administrator ruxsati so'raladi).
rem    3) Resolve Studio bilan birga keladigan WorkflowIntegration.node modulini
rem       Resolve'ning Developer papkasidan plaginga nusxalaydi.
rem  Qo'shimcha dastur (Node.js, npm, Python) o'rnatish SHART EMAS.
rem
rem  Ishlatish:  GeminiCut-Resolve-Setup.bat [/S | /U]
rem ==========================================================================

set "GC_VERSION=@VERSION@"
set "GC_SHA=@SHA256@"
set "GC_SELF=%~f0"
set "GC_ARG=%~1"
set "GC_BMD=%ProgramData%\Blackmagic Design\DaVinci Resolve\Support"
set "GC_DEST=%GC_BMD%\Workflow Integration Plugins\GeminiCut"
set "GC_LOG=%TEMP%\GeminiCut-Resolve-install.log"
set "GC_WORK=%TEMP%\GeminiCut-R-%RANDOM%%RANDOM%"
set "GC_SILENT="

rem --- administrator ruxsati (ProgramData papkasiga yozish uchun) ---
net session >nul 2>&1
if errorlevel 1 (
    echo.
    echo   Administrator ruxsati so'ralmoqda...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:GC_SELF -ArgumentList $env:GC_ARG -Verb RunAs"
    exit /b 0
)

if /I "%GC_ARG%"=="/S" (
    set "GC_SILENT=1"
    goto :install
)
if /I "%GC_ARG%"=="/U" goto :uninstall

:menu
cls
call :banner
echo   [1] O'rnatish / yangilash
echo   [2] O'chirish
echo   [3] Chiqish
echo.
choice /C 123 /N /M "  Tanlang (1-3): "
if errorlevel 3 exit /b 0
if errorlevel 2 goto :uninstall
goto :install

rem --------------------------------------------------------------------------
:install
if not defined GC_SILENT cls
call :banner
echo   Quyidagilar bajariladi:
echo     - Plagin papkasi: %GC_DEST%
echo     - WorkflowIntegration.node Resolve Studio'ning o'z papkasidan olinadi
echo.
call :findResolve
if defined GC_RESOLVE echo   Topildi: %GC_RESOLVE%
if not defined GC_RESOLVE echo   Ogohlantirish: Resolve.exe standart papkada topilmadi. Plagin baribir o'rnatiladi.
echo   Eslatma: Workflow Integration faqat DaVinci Resolve STUDIO'da ishlaydi.
echo.
if not defined GC_SILENT (
    choice /C YN /N /M "  Davom etilsinmi? [Y/N]: "
    if errorlevel 2 exit /b 0
)
echo.
> "%GC_LOG%" echo GeminiCut Resolve %GC_VERSION% install %DATE% %TIME%

call :findNode
if not defined GC_NODE (
    call :err "WorkflowIntegration.node topilmadi. DaVinci Resolve Studio 20 yoki yangisi o'rnatilganini tekshiring."
    goto :fail
)
echo   Modul: %GC_NODE%
call :waitResolveClosed || goto :fail

echo   [1/3] Arxiv ajratilmoqda va tekshirilmoqda...
mkdir "%GC_WORK%" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $l = [IO.File]::ReadAllLines($env:GC_SELF); $i = [Array]::IndexOf($l, '-----BEGIN GEMINICUT PAYLOAD-----'); if ($i -lt 0) { throw 'payload topilmadi' }; $t = (($l[($i + 1)..($l.Count - 1)]) -join '') -replace '\s', ''; $b = [Convert]::FromBase64String($t); $h = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)).Replace('-', ''); if ($h -ne $env:GC_SHA) { throw ('SHA-256 mos emas - fayl buzilgan. ' + $h) }; $z = Join-Path $env:GC_WORK 'payload.zip'; [IO.File]::WriteAllBytes($z, $b); Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($z, (Join-Path $env:GC_WORK 'x')); exit 0 } catch { Write-Host ('  XATO: ' + $_.Exception.Message); exit 1 }" >> "%GC_LOG%" 2>&1
if errorlevel 1 (
    type "%GC_LOG%" | findstr /C:"XATO"
    call :err "Arxivni ochib bo'lmadi. Faylni qayta yuklab oling."
    goto :fail
)
if not exist "%GC_WORK%\x\GeminiCut\manifest.xml" (
    call :err "Arxiv ichida plagin topilmadi."
    goto :fail
)
echo         OK - butunlik tasdiqlandi ^(SHA-256^)

echo   [2/3] Plagin o'rnatilmoqda...
if exist "%GC_DEST%" rd /s /q "%GC_DEST%" >nul 2>&1
if exist "%GC_DEST%" (
    call :err "Eski versiyani o'chirib bo'lmadi. DaVinci Resolve to'liq yopilganini tekshiring."
    goto :fail
)
mkdir "%GC_DEST%" >nul 2>&1
robocopy "%GC_WORK%\x\GeminiCut" "%GC_DEST%" /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1 >> "%GC_LOG%" 2>&1
if errorlevel 8 (
    call :err "Fayllarni nusxalab bo'lmadi: %GC_DEST%"
    goto :fail
)
copy /Y "%GC_NODE%" "%GC_DEST%\WorkflowIntegration.node" >> "%GC_LOG%" 2>&1
if not exist "%GC_DEST%\WorkflowIntegration.node" (
    call :err "WorkflowIntegration.node nusxalanmadi."
    goto :fail
)
echo         OK - %GC_DEST%

echo   [3/3] Vaqtinchalik fayllar tozalanmoqda...
rd /s /q "%GC_WORK%" >nul 2>&1
echo         OK
echo.
echo   ==========================================================
echo     TAYYOR! GeminiCut %GC_VERSION% DaVinci Resolve uchun o'rnatildi.
echo   ==========================================================
echo.
echo   Keyingi qadamlar:
echo     1. DaVinci Resolve Studio'ni oching (ochiq bo'lsa - yopib qayta oching).
echo     2. Loyiha va timeline'ni oching.
echo     3. Workspace ^> Workflow Integrations ^> GeminiCut
echo     4. Sozlamalar bo'limiga Gemini API kalitini kiriting (bepul:
echo        https://aistudio.google.com/apikey), Claude uchun - Anthropic kaliti.
echo     Qo'shimcha dastur (Node.js, npm, Python) o'rnatish SHART EMAS.
echo.
echo   Jurnal: %GC_LOG%
echo.
if defined GC_SILENT exit /b 0
if not defined GC_RESOLVE goto :installDone
choice /C YN /N /M "  DaVinci Resolve hozir ochilsinmi? [Y/N]: "
if errorlevel 2 goto :installDone
echo   DaVinci Resolve ochilmoqda...
start "" "%GC_RESOLVE%"
echo   Ochilgach: Workspace ^> Workflow Integrations ^> GeminiCut
echo.
:installDone
pause
exit /b 0

rem --------------------------------------------------------------------------
:uninstall
cls
call :banner
if not exist "%GC_DEST%" (
    echo   GeminiCut Resolve uchun o'rnatilmagan - o'chiradigan narsa yo'q.
    echo.
    if not defined GC_SILENT pause
    exit /b 0
)
echo   O'chiriladi: %GC_DEST%
echo.
choice /C YN /N /M "  GeminiCut o'chirilsinmi? [Y/N]: "
if errorlevel 2 exit /b 0
call :waitResolveClosed || goto :fail
rd /s /q "%GC_DEST%" >nul 2>&1
if exist "%GC_DEST%" (
    call :err "Papkani o'chirib bo'lmadi. DaVinci Resolve yopiqligini tekshiring."
    goto :fail
)
echo.
echo   GeminiCut o'chirildi. Saqlangan fayllaringiz: %USERPROFILE%\Documents\GeminiCut
echo.
pause
exit /b 0

rem --------------------------------------------------------------------------
:banner
echo.
echo   ==========================================================
echo     GeminiCut %GC_VERSION%  -  DaVinci Resolve Studio uchun
echo     AI subtitr, montaj, effektlar, Claude, Video AI
echo   ==========================================================
echo.
exit /b 0

:findResolve
set "GC_RESOLVE="
if exist "%ProgramFiles%\Blackmagic Design\DaVinci Resolve\Resolve.exe" set "GC_RESOLVE=%ProgramFiles%\Blackmagic Design\DaVinci Resolve\Resolve.exe"
exit /b 0

:findNode
set "GC_NODE="
set "GC_SAMPLE=%GC_BMD%\Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node"
if exist "%GC_SAMPLE%" (
    set "GC_NODE=%GC_SAMPLE%"
    exit /b 0
)
for /f "delims=" %%F in ('where /r "%GC_BMD%" WorkflowIntegration.node 2^>nul') do if not defined GC_NODE set "GC_NODE=%%F"
if defined GC_NODE exit /b 0
for /f "delims=" %%F in ('where /r "%ProgramFiles%\Blackmagic Design" WorkflowIntegration.node 2^>nul') do if not defined GC_NODE set "GC_NODE=%%F"
exit /b 0

:waitResolveClosed
tasklist /FI "IMAGENAME eq Resolve.exe" 2>nul | find /I "Resolve.exe" >nul
if errorlevel 1 exit /b 0
echo.
echo   DaVinci Resolve hozir ochiq. Loyihani saqlab, Resolve'ni yoping.
if defined GC_SILENT (
    call :err "Resolve ochiq - /S rejimida davom etib bo'lmaydi."
    exit /b 1
)
choice /C YN /N /M "  Resolve yopildimi? Davom etish [Y] / Bekor qilish [N]: "
if errorlevel 2 exit /b 1
goto :waitResolveClosed

:err
echo.
echo   [XATO] %~1
>> "%GC_LOG%" echo [XATO] %~1
exit /b 0

:fail
if exist "%GC_WORK%" rd /s /q "%GC_WORK%" >nul 2>&1
echo.
echo   O'rnatish yakunlanmadi. Batafsil jurnal: %GC_LOG%
echo.
if not defined GC_SILENT pause
exit /b 1

-----BEGIN GEMINICUT PAYLOAD-----
