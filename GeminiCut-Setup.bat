@echo off
setlocal EnableExtensions DisableDelayedExpansion
title GeminiCut 2.0.0 - O'rnatuvchi

rem ==========================================================================
rem  GeminiCut 2.0.0 - Premiere Pro uchun AI subtitr va montaj paneli
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

set "GC_VERSION=2.0.0"
set "GC_SHA=C6903CD30707CFC89F2475C882FBA2E4402D06BA823D3736B88658D45A884A46"
set "GC_SELF=%~f0"
set "GC_ID=com.uzstudio.geminicut"
set "GC_EXT_ROOT=%APPDATA%\Adobe\CEP\extensions"
set "GC_DEST=%GC_EXT_ROOT%\%GC_ID%"
set "GC_OLD=%GC_EXT_ROOT%\premiere-gemini-plugin"
set "GC_LOG=%TEMP%\GeminiCut-install.log"
set "GC_WORK=%TEMP%\GeminiCut-%RANDOM%%RANDOM%"
set "GC_SILENT="

if /I "%~1"=="/S" set "GC_SILENT=1" & goto :install
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
echo.
echo   Jurnal: %GC_LOG%
echo.
if not defined GC_SILENT pause
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
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
xxAAACIAAAAAAAAAAQAAAKSByQIAAHByZW1pZXJlLWdlbWluaS1wbHVnaW4vUU9MTEFOTUEubWRQ
SwECHgMUAAAACABkYTpd7EWzJlAPAADLOAAAKwAAAAAAAAABAAAApIGqCwAAcHJlbWllcmUtZ2Vt
aW5pLXBsdWdpbi9jbGllbnQvY3NzL3N0eWxlLmNzc1BLAQIeAxQAAAAIAKpgOl0xFF0IGA0AAL4z
AAAoAAAAAAAAAAEAAACkgUMbAABwcmVtaWVyZS1nZW1pbmktcGx1Z2luL2NsaWVudC9pbmRleC5o
dG1sUEsBAh4DFAAAAAgALmE6XeLmzMmbBAAAPgoAACcAAAAAAAAAAQAAAKSBoSgAAHByZW1pZXJl
LWdlbWluaS1wbHVnaW4vY2xpZW50L2pzL2NlcC5qc1BLAQIeAxQAAAAIAMhgOl3OERg9rxAAAGcv
AAAqAAAAAAAAAAEAAACkgYEtAABwcmVtaWVyZS1nZW1pbmktcGx1Z2luL2NsaWVudC9qcy9nZW1p
bmkuanNQSwECHgMUAAAACAByYTpdWMqWwscmAACweAAAKAAAAAAAAAABAAAApIF4PgAAcHJlbWll
cmUtZ2VtaW5pLXBsdWdpbi9jbGllbnQvanMvbWFpbi5qc1BLAQIeAxQAAAAIAE5hOl2/oAErDQ4A
APwkAAAtAAAAAAAAAAEAAACkgYVlAABwcmVtaWVyZS1nZW1pbmktcGx1Z2luL2NsaWVudC9qcy9z
dWJ0aXRsZXMuanNQSwECHgMUAAAACADAYTpd/OjQWkMPAADLMAAAJAAAAAAAAAABAAAApIHdcwAA
cHJlbWllcmUtZ2VtaW5pLXBsdWdpbi9ob3N0L2hvc3QuanN4UEsFBgAAAAAJAAkABQMAAGKDAAAA
AA==
