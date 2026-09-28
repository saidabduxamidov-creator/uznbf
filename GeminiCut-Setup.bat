@echo off
setlocal EnableExtensions DisableDelayedExpansion
title GeminiCut 3.0.0 - O'rnatuvchi

rem ==========================================================================
rem  GeminiCut 3.0.0 - Premiere Pro uchun AI subtitr va montaj paneli
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

set "GC_VERSION=3.0.0"
set "GC_SHA=64A3ED1E31A02EAE88842808C77510AB0A14A81270214ED32657DB66C0380806"
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
KcCX5KX76zTdkDMtMrBbGDZKb1rqNK8L19Z+w+Ol2Jx7oZt0JydtU9ppD7bl3F9riw5rcswOZ3hm
/3FLj+675yAmSLU0QIivtVADvZ/YkiJrZbTf3bc0fJyjjc4KMicba7tGZpEg3Cinds3wIECvffnr
/Uhko/axifPRLxG1rBO1bCHKMbJa2OraFdQlLKOldnb2ukl+DZUTLsqQ/FWo6POWCgY0XQ3+mtzY
kQF1lNE2BuUcf9buWHl8b5kd5wVXSzwkgv9NBjqtheBQXY5tT1wnuXM8eaeW/K7lYACe+jLjXK/6
H8ke9VcWRI/Iy90TIwbnW9+qxWga9w/LDyrD/ceX/gz5/xtQSwECHgMUAAAACABQVzxdcXXyOYQC
AAB3BgAAKAAAAAAAAAABAAAApIEAAAAAcHJlbWllcmUtZ2VtaW5pLXBsdWdpbi9DU1hTL21hbmlm
ZXN0LnhtbFBLAQIeAxQAAAAIAEhYPF2pwoOfPAkAAPESAAAiAAAAAAAAAAEAAACkgcoCAABwcmVt
aWVyZS1nZW1pbmktcGx1Z2luL1FPTExBTk1BLm1kUEsBAh4DFAAAAAgATlc8XbiUv1ZpEAAABT8A
ACsAAAAAAAAAAQAAAKSBRgwAAHByZW1pZXJlLWdlbWluaS1wbHVnaW4vY2xpZW50L2Nzcy9zdHls
ZS5jc3NQSwECHgMUAAAACABKVzxdiqRbeBAPAADpOgAAKAAAAAAAAAABAAAApIH4HAAAcHJlbWll
cmUtZ2VtaW5pLXBsdWdpbi9jbGllbnQvaW5kZXguaHRtbFBLAQIeAxQAAAAIAKRWPF1G115/rA4A
AOUnAAApAAAAAAAAAAEAAACkgU4sAABwcmVtaWVyZS1nZW1pbmktcGx1Z2luL2NsaWVudC9qcy9h
dWRpby5qc1BLAQIeAxQAAAAIAM9WPF1Lb8dNzgQAAFoLAAAnAAAAAAAAAAEAAACkgUE7AABwcmVt
aWVyZS1nZW1pbmktcGx1Z2luL2NsaWVudC9qcy9jZXAuanNQSwECHgMUAAAACAC8VjxdcSFWwtAQ
AAAjMAAAKgAAAAAAAAABAAAApIFUQAAAcHJlbWllcmUtZ2VtaW5pLXBsdWdpbi9jbGllbnQvanMv
Z2VtaW5pLmpzUEsBAh4DFAAAAAgAGlg8XWQskWt2LgAAhZAAACgAAAAAAAAAAQAAAKSBbFEAAHBy
ZW1pZXJlLWdlbWluaS1wbHVnaW4vY2xpZW50L2pzL21haW4uanNQSwECHgMUAAAACAAZWDxdz26I
/hsPAADpJwAALQAAAAAAAAABAAAApIEogAAAcHJlbWllcmUtZ2VtaW5pLXBsdWdpbi9jbGllbnQv
anMvc3VidGl0bGVzLmpzUEsBAh4DFAAAAAgAVlg8XUKBEjEXFQAAO0UAACQAAAAAAAAAAQAAAKSB
jo8AAHByZW1pZXJlLWdlbWluaS1wbHVnaW4vaG9zdC9ob3N0LmpzeFBLBQYAAAAACgAKAFwDAADn
pAAAAAA=
