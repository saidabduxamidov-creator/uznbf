@echo off
setlocal
title GeminiCut - avtomatik ornatuvchi
color 0A

echo ============================================
echo   GeminiCut - Premiere Pro AI Plugin
echo   Bitta fayl bilan avtomatik ornatish
echo ============================================
echo.

rem Eslatma: TMP nomi ishlatilmaydi - u Windows tizim o'zgaruvchisi,
rem uni almashtirish PowerShell va boshqa dasturlarni buzadi.
set "GC_SELF=%~f0"
set "GC_WORK=%TEMP%\geminicut_install_%RANDOM%%RANDOM%"
mkdir "%GC_WORK%" >nul 2>&1

echo [1/5] Fayllar ajratib olinmoqda...
echo [2/5] Fayllar dekodlanmoqda...

rem Asosiy usul: PowerShell marker qatoridan keyingi barcha base64 qatorlarni
rem to'g'ridan-to'g'ri o'qib, payload.zip ga yozadi (qator tashlab ketilmaydi).
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $l = Get-Content -LiteralPath $env:GC_SELF; $i = [Array]::IndexOf([string[]]$l, '-----DATA-----'); if ($i -lt 0) { throw 'marker topilmadi' }; $b = ($l[($i + 1)..($l.Count - 1)] -join '') -replace '\s', ''; [IO.File]::WriteAllBytes((Join-Path $env:GC_WORK 'payload.zip'), [Convert]::FromBase64String($b)); Write-Host '  -> PowerShell dekodlash: OK' } catch { Write-Host ('  -> PowerShell dekodlash xatosi: ' + $_.Exception.Message) }"

if exist "%GC_WORK%\payload.zip" goto :decoded

rem Zaxira usul: certutil. "more +N" N ta qatorni TASHLAB KETADI,
rem shuning uchun marker qatori raqamining o'zi beriladi (+1 emas!).
echo   -^> certutil orqali zaxira usul sinalmoqda...
set "MARKLINE="
for /f "delims=:" %%L in ('findstr /n /x /c:"-----DATA-----" "%GC_SELF%"') do set "MARKLINE=%%L"
if not defined MARKLINE goto :nodata
more +%MARKLINE% "%GC_SELF%" > "%GC_WORK%\payload.b64"
certutil -f -decode "%GC_WORK%\payload.b64" "%GC_WORK%\payload.zip" >nul
if not exist "%GC_WORK%\payload.zip" goto :decodefail

:decoded
echo [3/5] Arxiv ochilmoqda...
for %%F in ("%GC_WORK%\payload.zip") do echo   -^> payload.zip hajmi: %%~zF bayt (kutilgan: @SIZE@)

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Expand-Archive -LiteralPath (Join-Path $env:GC_WORK 'payload.zip') -DestinationPath (Join-Path $env:GC_WORK 'extracted') -Force -ErrorAction Stop; Write-Host '  -> Expand-Archive: OK' } catch { Write-Host ('  -> Expand-Archive xatosi: ' + $_.Exception.Message) }"

if exist "%GC_WORK%\extracted\premiere-gemini-plugin\CSXS\manifest.xml" goto :extracted
echo   -^> tar orqali zaxira usul sinalmoqda...
mkdir "%GC_WORK%\extracted" >nul 2>&1
tar -xf "%GC_WORK%\payload.zip" -C "%GC_WORK%\extracted"
if exist "%GC_WORK%\extracted\premiere-gemini-plugin\CSXS\manifest.xml" goto :extracted

echo [XATOLIK] Arxiv ichidan plagin fayllari topilmadi.
echo   Diagnostika - topilgan fayllar:
dir /s /b "%GC_WORK%\extracted" 2>nul
echo   Payload manzili (tekshirish uchun qoldirildi): %GC_WORK%\payload.zip
pause
exit /b 1

:extracted
echo [4/5] Premiere CEP papkasiga nusxalanmoqda...
set "DEST=%APPDATA%\Adobe\CEP\extensions\premiere-gemini-plugin"
if exist "%DEST%" rd /s /q "%DEST%"
mkdir "%DEST%" >nul 2>&1
xcopy /E /I /Y /Q "%GC_WORK%\extracted\premiere-gemini-plugin" "%DEST%" >nul
if not exist "%DEST%\CSXS\manifest.xml" (
    echo [XATOLIK] Fayllarni "%DEST%" ga nusxalab bo'lmadi.
    pause
    exit /b 1
)

echo [5/5] Premiere uchun ruxsat berilmoqda (registry)...
for %%V in (8 9 10 11 12 13) do (
    reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)

rd /s /q "%GC_WORK%" >nul 2>&1

echo.
echo ============================================
echo   TAYYOR!
echo ============================================
echo.
echo Plagin ornatildi: %DEST%
echo.
echo MUHIM: CSInterface.js fayli hali qoshilmagan bolishi mumkin.
echo Agar panel ochilmasa yoki bosh bolsa, quyidagi manzildan
echo CSInterface.js faylini yuklab, shu papkaga qoying:
echo   %DEST%\client\js\CSInterface.js
echo Havola: https://github.com/Adobe-CEP/CEP-Resources
echo.
echo Endi:
echo   1) Premiere Pro 2024 ni TOLIQ yoping
echo   2) Qayta oching
echo   3) Window -^> Extensions -^> GeminiCut - AI Video Editor
echo.
pause
exit /b 0

:nodata
echo [XATOLIK] Ichki maalumot topilmadi. Fayl buzilgan bolishi mumkin.
pause
exit /b 1

:decodefail
echo [XATOLIK] Dekodlash muvaffaqiyatsiz tugadi.
pause
exit /b 1

-----DATA-----
