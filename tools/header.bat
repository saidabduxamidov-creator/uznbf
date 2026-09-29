@echo off
setlocal EnableExtensions DisableDelayedExpansion
title GeminiCut @VERSION@ - O'rnatuvchi

rem ==========================================================================
rem  GeminiCut @VERSION@ - Premiere Pro uchun AI subtitr va montaj paneli
rem
rem  Bu fayl nima qiladi (hammasi faqat joriy foydalanuvchi uchun, admin
rem  huquqi kerak emas):
rem    1) Fayl oxiridagi plagin arxivini ajratib oladi va SHA-256 bilan
rem       butunligini tekshiradi.
rem    2) Plaginni %APPDATA%\Adobe\CEP\extensions\com.uzstudio.geminicut
rem       papkasiga nusxalaydi.
rem    3) HKCU\Software\Adobe\CSXS.9..12 da PlayerDebugMode=1 qo'yadi -
rem       Premiere imzolanmagan CEP panellarni yuklashi uchun kerak.
rem
rem  Ishlatish:
rem    GeminiCut-Setup.bat          menyu
rem    GeminiCut-Setup.bat /S       savolsiz o'rnatish
rem    GeminiCut-Setup.bat /U       o'chirish
rem ==========================================================================

set "GC_VERSION=@VERSION@"
set "GC_SHA=@SHA256@"
set "GC_SELF=%~f0"
set "GC_ID=com.uzstudio.geminicut"
set "GC_EXT_ROOT=%APPDATA%\Adobe\CEP\extensions"
set "GC_DEST=%GC_EXT_ROOT%\%GC_ID%"
set "GC_OLD=%GC_EXT_ROOT%\premiere-gemini-plugin"
set "GC_LOG=%TEMP%\GeminiCut-install.log"
set "GC_WORK=%TEMP%\GeminiCut-%RANDOM%%RANDOM%"
set "GC_SILENT="

if /I "%~1"=="/S" (
    set "GC_SILENT=1"
    goto :install
)
if /I "%~1"=="/U" goto :uninstall
if /I "%~1"=="/?" goto :usage

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
echo     - Registry:       HKCU\Software\Adobe\CSXS.9-12  PlayerDebugMode = 1
echo     - Admin huquqi kerak emas, faqat joriy foydalanuvchi uchun.
echo.
call :listPremiere
if not defined GC_SILENT (
    choice /C YN /N /M "  Davom etilsinmi? [Y/N]: "
    if errorlevel 2 exit /b 0
)
echo.
> "%GC_LOG%" echo GeminiCut %GC_VERSION% install %DATE% %TIME%

call :checkPowerShell || goto :fail
call :waitPremiereClosed || goto :fail

echo   [1/4] Arxiv ajratilmoqda va tekshirilmoqda...
mkdir "%GC_WORK%" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $l = [IO.File]::ReadAllLines($env:GC_SELF); $i = [Array]::IndexOf($l, '-----BEGIN GEMINICUT PAYLOAD-----'); if ($i -lt 0) { throw 'payload topilmadi' }; $t = (($l[($i + 1)..($l.Count - 1)]) -join '') -replace '\s', ''; $b = [Convert]::FromBase64String($t); $h = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)).Replace('-', ''); if ($h -ne $env:GC_SHA) { throw ('SHA-256 mos emas - fayl buzilgan. ' + $h) }; $z = Join-Path $env:GC_WORK 'payload.zip'; [IO.File]::WriteAllBytes($z, $b); Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($z, (Join-Path $env:GC_WORK 'x')); exit 0 } catch { Write-Host ('  XATO: ' + $_.Exception.Message); exit 1 }" >> "%GC_LOG%" 2>&1
if errorlevel 1 (
    type "%GC_LOG%" | findstr /C:"XATO"
    call :err "Arxivni ochib bo'lmadi. Faylni qayta yuklab oling."
    goto :fail
)
if not exist "%GC_WORK%\x\premiere-gemini-plugin\CSXS\manifest.xml" (
    call :err "Arxiv ichida plagin topilmadi."
    goto :fail
)
echo         OK - butunlik tasdiqlandi ^(SHA-256^)

echo   [2/4] Plagin o'rnatilmoqda...
if exist "%GC_OLD%" rd /s /q "%GC_OLD%" >nul 2>&1
if exist "%GC_DEST%" rd /s /q "%GC_DEST%" >nul 2>&1
if exist "%GC_DEST%" (
    call :err "Eski versiyani o'chirib bo'lmadi. Premiere Pro to'liq yopilganini tekshiring."
    goto :fail
)
mkdir "%GC_DEST%" >nul 2>&1
robocopy "%GC_WORK%\x\premiere-gemini-plugin" "%GC_DEST%" /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1 >> "%GC_LOG%" 2>&1
if errorlevel 8 (
    call :err "Fayllarni nusxalab bo'lmadi: %GC_DEST%"
    goto :fail
)
if not exist "%GC_DEST%\CSXS\manifest.xml" (
    call :err "Nusxalashdan keyin manifest topilmadi."
    goto :fail
)
echo         OK - %GC_DEST%

echo   [3/4] Premiere ruxsati sozlanmoqda (registry)...
set "GC_REGOK="
for %%V in (9 10 11 12) do (
    reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >> "%GC_LOG%" 2>&1 && set "GC_REGOK=1"
)
if not defined GC_REGOK (
    call :err "Registry yozuvini qo'shib bo'lmadi."
    goto :fail
)
echo         OK - CSXS.9, 10, 11, 12

echo   [4/4] Vaqtinchalik fayllar tozalanmoqda...
rd /s /q "%GC_WORK%" >nul 2>&1
echo         OK
echo.
echo   ==========================================================
echo     TAYYOR! GeminiCut %GC_VERSION% o'rnatildi.
echo   ==========================================================
echo.
echo   Keyingi qadamlar:
echo     1. Premiere Pro'ni oching (ochiq bo'lsa - to'liq yopib qayta oching).
echo     2. Window ^> Extensions ^> GeminiCut - AI Subtitr va Montaj
echo     3. Sozlamalar bo'limiga Gemini API kalitingizni kiriting
echo        (bepul: https://aistudio.google.com/apikey).
echo     4. Claude bo'limi uchun: Anthropic API kalitini kiriting (ixtiyoriy).
echo     Qo'shimcha dastur (Node.js, npm va hokazo) o'rnatish SHART EMAS.
echo.
echo   Jurnal: %GC_LOG%
echo.
if defined GC_SILENT exit /b 0
call :findPremiere
if not defined GC_PPRO goto :installDone
choice /C YN /N /M "  Premiere Pro hozir ochilsinmi? [Y/N]: "
if errorlevel 2 goto :installDone
echo   Premiere Pro ochilmoqda: %GC_PPRO%
start "" "%GC_PPRO%"
echo   Premiere ochilgach: Window ^> Extensions ^> GeminiCut - AI Subtitr va Montaj
echo.
:installDone
pause
exit /b 0

rem --------------------------------------------------------------------------
:uninstall
cls
call :banner
if not exist "%GC_DEST%" if not exist "%GC_OLD%" (
    echo   GeminiCut o'rnatilmagan - o'chiradigan narsa yo'q.
    echo.
    if not defined GC_SILENT pause
    exit /b 0
)
echo   O'chiriladi: %GC_DEST%
echo.
choice /C YN /N /M "  GeminiCut o'chirilsinmi? [Y/N]: "
if errorlevel 2 exit /b 0
call :waitPremiereClosed || goto :fail
if exist "%GC_DEST%" rd /s /q "%GC_DEST%" >nul 2>&1
if exist "%GC_OLD%" rd /s /q "%GC_OLD%" >nul 2>&1
if exist "%GC_DEST%" (
    call :err "Papkani o'chirib bo'lmadi. Premiere Pro yopiqligini tekshiring."
    goto :fail
)
echo.
echo   GeminiCut o'chirildi.
echo   Eslatma: PlayerDebugMode sozlamasi o'zgartirilmadi, chunki boshqa
echo   panellar ham undan foydalanishi mumkin.
echo   Sizning saqlangan SRT fayllaringiz: %USERPROFILE%\Documents\GeminiCut
echo.
pause
exit /b 0

rem --------------------------------------------------------------------------
:usage
echo GeminiCut-Setup.bat [/S ^| /U]
echo   /S  savolsiz o'rnatish
echo   /U  o'chirish
exit /b 0

:banner
echo.
echo   ==========================================================
echo     GeminiCut %GC_VERSION%  -  AI subtitr va montaj
echo     Adobe Premiere Pro 2022 / 2023 / 2024 / 2025
echo   ==========================================================
echo.
exit /b 0

:findPremiere
rem Eng yangi o'rnatilgan Premiere Pro (masalan 2025) - papkalar alifbo tartibida, oxirgisi eng yangisi
set "GC_PPRO="
for /d %%D in ("%ProgramFiles%\Adobe\Adobe Premiere Pro*") do (
    if exist "%%~fD\Adobe Premiere Pro.exe" set "GC_PPRO=%%~fD\Adobe Premiere Pro.exe"
)
exit /b 0

:listPremiere
set "GC_FOUND="
for /d %%D in ("%ProgramFiles%\Adobe\Adobe Premiere Pro*") do (
    if exist "%%~fD\Adobe Premiere Pro.exe" (
        if not defined GC_FOUND echo   Topilgan Premiere Pro versiyalari:
        echo     - %%~nxD
        set "GC_FOUND=1"
    )
)
if not defined GC_FOUND echo   Ogohlantirish: Premiere Pro standart papkada topilmadi. Plagin baribir o'rnatiladi.
echo.
exit /b 0

:checkPowerShell
where powershell >nul 2>&1
if errorlevel 1 (
    call :err "Windows PowerShell topilmadi. Windows 10 yoki 11 kerak."
    exit /b 1
)
exit /b 0

:waitPremiereClosed
tasklist /FI "IMAGENAME eq Adobe Premiere Pro.exe" 2>nul | find /I "Adobe Premiere Pro.exe" >nul
if errorlevel 1 exit /b 0
echo.
echo   Premiere Pro hozir ochiq. Ishingizni saqlab, Premiere'ni yoping.
if defined GC_SILENT (
    call :err "Premiere Pro ochiq - /S rejimida davom etib bo'lmaydi."
    exit /b 1
)
choice /C YN /N /M "  Premiere yopildimi? Davom etish [Y] / Bekor qilish [N]: "
if errorlevel 2 exit /b 1
goto :waitPremiereClosed

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
