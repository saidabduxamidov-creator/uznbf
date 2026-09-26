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
for %%F in ("%GC_WORK%\payload.zip") do echo   -^> payload.zip hajmi: %%~zF bayt (kutilgan: 11016)

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
UEsDBAoAAAAAACVeOl0AAAAAAAAAAAAAAAAXAAAAcHJlbWllcmUtZ2VtaW5pLXBs
dWdpbi9QSwMECgAAAAAAJV46XQAAAAAAAAAAAAAAABwAAABwcmVtaWVyZS1nZW1p
bmktcGx1Z2luL0NTWFMvUEsDBBQAAAAIACVeOl3D7Md7XAIAAFEGAAAoAAAAcHJl
bWllcmUtZ2VtaW5pLXBsdWdpbi9DU1hTL21hbmlmZXN0LnhtbJ1VzW7TQBC+9ykW
n0DC3hCSikgbVyGkJVICUdIGJMTB2NNmKns3rNeR01MfgifkSRjnz2snAQkf7PXM
fN98O7Nji6s8idkKdIpKdp03XsNhIEMVoXzoOne31+4758q/EIPcgCxixoHEe0gN
m+8xnQJz8L/PZBTDMOo6oUq87Ck1WYTKe4AEJYaZcS4YXbXwuZX/BNunIIGuc7Oh
6GeG3SvNJppeQQMtlOMTaSlxhKnxN2lKGzuvyFsGEmKH1UXwDSs/oiVSIBhZBnKF
WskE5D7fR5WaMj0ZXrgum0ymn1mz5eVsFbBmm54vbfWs2Wi2ON3ar5jrHpAFFdvu
vCCw9H0jrsbrTsfrfN+pLHRWU4uRCoMYKlq2JtZXEXH24tgC16PFFH5mqCGaZtJg
UuWp+XYi+7OvM6d2Kg78Z+iK6p6upfiA6TIw4WIo79X/NfSg16baGzfbSFWmQ0hL
G1nHAcpJYBa+x8MYSQ1HGUHuLUwSC37w2pBZqHFpdqAFtWFz8x7TXHDLZ0P6g+u+
SpJARiOUYLvIOQk0VdSA9l0XZPAjBldSzx5TwUvXeUiCOURuqKSB3JyBCH5OQdGr
o7qIEc18uA7jilTRy4yaY4qk0Dc6A8Fti0V5Ai7uhhWu2/US/EnROME360pTQGZ+
Of+/n3+x3pDNMQLFBhEapak1RYwNugFF+9brWqlm+FQreDFsgA8L41+2GjRI23U9
5AtG1MRWkyK2yyotP+YVY5R/y9Zu/Cvb28tz2U5QC35qx2JIJyH1Bd8+raaUDRD8
eESsD992Uo8H0grZ/xX8iz9QSwMEFAAAAAgAJV46Xe0FJApCCgAAdRUAACIAAABw
cmVtaWVyZS1nZW1pbmktcGx1Z2luL1FPTExBTk1BLm1klVhNb9tIEr3zVxSUgz5i
U5GTGSDe3QAe25MYiRPHimeTwMCoKbbItkg21Wwqog6LwR7mvBjkuL8uv2RfNUl9
OMksJnAAkmpWV1e9evWKD+i5TFWmTktLX377TFcGt9JIXGg6enT0hMppXGZ0ckF5
IiKVUa9+gZ+ozMrICFuoShSq73kPHtDJcikSSstYpaTWOj6mji/yeYdisVCh8CZ8
N3F7BSWdZKHRKiSVaLwmjKKZNqmw6mDfk3pvXhAJEoleYD+qdHfhe99ZR4PB6fkV
yZWVWaF0NhhQb+KvV/mEZqJK+nh7rujm/VW7I3yzwixwlYhQ+fS2rPCMCrXGlnum
yIqq0iYRAQXShDgon6ZETGKRktXdqGvwanbYXHo5jsyWZm4b6oWisKWZxoqMvFMp
nvUP3Ls7Dm6X667JcFXE2GCOm0JYkYrMd+G+qpOSqVTQwnnujXx6p1KZqEx28boV
iEcWiYzmicphY5O/Lg7WW6pQ6oeiDJVGTMpAGz69d+S363R3Hcj5NMZaFzJTFrgZ
qixK1BpXfcpKu8BCy49EcOwR0SGVa72gXJRrTmuGfNoSkVUBLXTCzizhr6isoEAX
ceNgJHK3GDHM4cVBY6l+1pmWtkO9uSwQiv42PIFMIhy82qyvsZeI2G2NFWutgcVs
qIFxKxCFWRMq33vs01itqbMJGEKy0N0kEUXcgctRCqBhcziJi7VLdFMH5wyHcDw1
KrekAZxE8f5iaTXDaU5GLOFpKI53wkBYnSfyMJSJtLJxg2NxqS2Q9eX3P8ZTkUg2
NJfVzIhUdh2a6w3qo8jZTM4tuwVXK3cOhsIrXSlkyZZrxLmIlTeZTLy8qY7DyGXz
ME9KOD/0vnz+75fPv+GPTsfvx0PgSc1kYf1VmlD978vv/9mBfLtAUW9TcDv0UOh1
ncP+juVpomRmea9/s73Nc5WFcuXHNk2++mlaFMPCVon0cbX59XPz613RGqO9t07H
F2AiMxNT6d8Vtetvuh8vXj+/+Ehv33THLy7w5+5enl+fvKRejgrkVAsDr/t7RtvN
UqEyZ20nHrnIZEKJjtScCejhppauLmjKBGfKJafL25qJdYEQ7JvmZzC9op1/bH4T
WQVuAHAVVwaAzbWxB7e5Dl12Oe2jw4UIRXp8PwpMIuxbVc6ZqTRjwjsJdSCZePlX
/Mi8tuXeOpdGFKmqDlBYeZnQ+OzlttasWDDdSetAdwMDiQNdFjmWBFUovmRcAoD4
c3dzacSceomyhczW6BVUiEAEO1sGpdc4lMpsp4Qq5Mem2CztH3tMbLG1eXE8HEbK
xmXgT3U6dEc6xEGG+H94LQsNapUFI5YLwbnF1MSUNsGSX0cjfzXcD9ak4TaZRdgT
TtNSGu5q/U0YQUlsBITBx558p64ayAOo9zfYxLAQCy4Vl7ujNnc7OJqjzl1x1xnb
ObRQaBvgaT/SOuISwelFrkAUYE6aK9OcsnNqpAC7OGuyusdjWHRQb4L7rCxWooFH
fbqmoTikw12EonPfuQ5iW4U649gWcbkxxh5YpkmGe889pVhOYyZ6abDYtReVpI6s
EVk022+0S3rujkeFNMgCbzJ3gKv1xeM2ZGebJtoLZVBG/aaZMuT1gkN3ka41k3bT
93HZ3zIalmFNxHwJnBpcN1hsi5BbQQePdTaNO16gkrBe5dAMNA4G/wSR6U8F9a5l
hNSYis5DZbVxXWJiZCRxO+kfDwauWF+8PP/w6+nN9fX563e/3ozPr2/HemY/CSNv
HYZvmYn90ciRBdKAmJ3xwS51KOkfNOKgji0nGX2jQoH0ndlv8jGbajEMonp6QKNH
teIZjQCCrmsQ6JTpHLlmd0UkDH7zHOUALOIAxcL+PJ1we6qvR48mdbK5dBu5sypD
dDDAIAtF1RR+4HSKYmZFmFIxfTOm3jtpkByRtPEI0GK9UM5EmdiCPgE6koBoX3As
/CYWX8Vh9P9eefSXX3n6jTdacn3Sou18BzcbQeY1LdfpO1dfCycaUTQ1+zB2dXca
u9LkrsM6MNOtrkLMrYL4RKB2AdUC5vT49gZFUNz+/ec3H85OXp28vvnl9MXFs9uT
PD+DCLy91gKmohY+51e3G3gXt99mqPpkTVLajf41fKUCI0w1hOVETQVrERqXea6N
rQmWyXW4tT78M+snjKXJvjuTNkiIzPKuDB0IGWcOfZvGwXSC+BDKDT3P0T9+qPXN
D20udhV/t26Tu3XMlPnVGNN1FA7cL1AGzORbAaqncUOcH8oF+Il7UFUeU5sPtOY/
tvkv3O3+0IRR6BeW0U39I6pMpE4rsHGnyvkEP7Yn+FlXIWg3a7zdl+uxUZgtUr1g
buMw7Wh35u+glfTUKyAjp5ZlpCu2o2ZXmBkMOu94FWQsJp/7DcB57aaMimOy23FZ
LWTs8GP/q67UcrxrIVDzHNPaFe+Jz1uO+u07dQJxmEQlzr/vOIIszEvXnpne3DCC
0aHM0LhVI9ACevwIAjNj4eDGRmUokzyQhFBcC9H3fvDpNby/E06QRKSrDJuErviM
0+09bt8ukIWMkF9msKET0/VA4LQI79H3fnQnOerTN2eC7wWzGQq2gdxq/lrMF43Q
d5vuafutjve8Z3QpCowuwh6DXQ2FGnILmIyYOb/q1z6m7c20sTtYwI7DtgFY6kJr
VCSoPSEJ96l3ak3y8GOTKEx46FsOR9xpDyiR3Bk4E7Dl0oJwytiqStu2gWByZhg3
40fvYsW/GlX1ifvtvSm2UlGX4f4Txr0FZybNqxICCRHg4nWT9w7mC6cpD+jj+6ux
irLTNGw8VWjqCIC3Oyqjx4lWbNY97a+qxaE1UmIKKuDRsN3z8gwIyzh94CfOsHWf
Chqxm+qCJlv3JrSntWtCGUsQ/AzDgt1wmRuP2/aHy50DHqKcZ3wjw1O8SDdjev2h
lV+nPP12btZjJwE7wJfRyejoMU2x1M9HR43dmnqgmLgs/3QzXNC3aZzqOwzcLpHt
Dps9261Q9C9QAsmGpSZ7L07aKWMwOF9dCt4W5eNUyGBwghJlsVhtqZXNYpmIpOGv
NW7+OGBBozKGBZCus347CddNmIu7ht9PjmOaWaP1ZxrLOaYbYMw7pIkbxdrZa9IM
WdH9mZwZqSlP0rlsPm85goCqTB0g4vLuTnCEU8HbDAZvz+nszaX7xiTy3JcZxhv5
9rzXn/QZQ02lOGLdfPpiJMKWOxbr32bwargmOFyUy2WzSVVzx6arbZRdS5GwEwg0
UfQuq0NuofXHNJRVw76t2gNncHteCQuUzhEhtWCxt0ubEVPWCiOaab44qeCgjp4L
XK1vgH5UrOYluGZutE7l+Ih0jVi0XJBj/fmIu0Ud7PZjUcmSkTNWMwSJOYZDi6kA
ygOie7lgXlwKeFI3hXpZxN+LItfGOYxpiWzPUXHu+1WjfbO2FVg5d5IgcKdsfLsB
pdUm649DvWdHjw7RYJpe0vavAsfWS/ZgYV3sM2FWQF0RI4V/82gHaNAwzl5WMxf6
iaM0R5JBM/PgnJVYsTd64Xv/A1BLAwQKAAAAAAAlXjpdAAAAAAAAAAAAAAAAHgAA
AHByZW1pZXJlLWdlbWluaS1wbHVnaW4vY2xpZW50L1BLAwQUAAAACAAlXjpdCgU6
mqECAABIBQAAKAAAAHByZW1pZXJlLWdlbWluaS1wbHVnaW4vY2xpZW50L2luZGV4
Lmh0bWyNVMFu00AQvfcrhr2kkcAWFQdUbEsh0Cri0IiGA6iXjT21p17vOt51in3i
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
5tpo2Y55hxYayzFEoBijgKYi2ajaNnK3KlX2rmpzCGuIus+VvSM5srcxnol2D10p
DlxGthcx1kB7gbDDxI7rGyK+1crv7E5OcR6lc3mCZZjKhcXf2HRocXvZUuQKxAcV
OLjG5cmXrRPQ7RcunSn+Z20mKAhdto1vLJm6/u7ZuD30tPPtOgxFRfc0dO0aqkW6
WwsLQT6I9hSCukSCDoJOueQL464A0RnrPJVF/4YbpbvudE7spLvO0cie8Pzvm8T3
ysJ2YGE4cIhaNx5vLlVpsmvLWK1U9ZO9RQvpXeR7oSX4Qb+z5PNT177BK8agSU7Y
d/Qos8drNNUtAtJK2o7diJ17s81lcxc8lqLaIxZD2QTPCEVzyHRXjkdnb1+9+M1d
/IlrdW7tTt/Z3ejcTLDrorApZM1NJgC7UHvZruvBxvkfucW1O61JQ79z++khgC1C
1yWH2w22VYkqgTjGIhx9+jRCloNP+ASd4YBG9zC25wrZ7mvjc+t1C6wA2XFTr4P+
+a7LYxvz9j9w3BX8rZeufwFQSwMECgAAAAAAJV46XQAAAAAAAAAAAAAAABwAAABw
cmVtaWVyZS1nZW1pbmktcGx1Z2luL2hvc3QvUEsDBBQAAAAIACVeOl0HfSo8pAgA
AM0WAAAkAAAAcHJlbWllcmUtZ2VtaW5pLXBsdWdpbi9ob3N0L2hvc3QuanN4rVjr
bhu5Ff6vpzgVivXMRhk5mz+FVLcwEndXm43tXbtBsYZRUCPaoufCEYfjWEoE9CH6
hH2SfiTnwpHkTbqogdgKeXhu/M53DjUe0/c8E7l4U2l6SUtZ6rH5FT2UT4PxmC4V
drni+CDp7EnzfHEVK1Fo0jKTuYjo5zN6e/GeAsXKTKxpWT08MJ2yPGP3LB9RyhOR
U8Lze6NuJY9S7ImULQS2Q1pLtWCZWDCC0iLlLxc85ZrTI6P3Ugtpjq7vFMs4yYIr
pkuxZilTIhoMWFFEPGfzlP98FoTTweCuymN7JpX3QVbeh/RpQASzf4w+KqF5mtMd
WzHdD+RayjQRepzIvJQpPEnkkRI5PBzRE9MIklZsrWGzXFIVL6uc8CllGn5voF9x
XamcrjQOObPTwXYwGH9L1yLjqcj5EZRqliNwxExBiRBjzRchJakocpyijC8Eg3Pr
lDKWbwRONVbhB3077mK75/qqVvAGxy+ZXgYuUK3W9i8he4pKvqITMjkqlHyAfMSg
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
v1BLAQIeAwoAAAAAACVeOl0AAAAAAAAAAAAAAAAXAAAAAAAAAAAAEADtQQAAAABw
cmVtaWVyZS1nZW1pbmktcGx1Z2luL1BLAQIeAwoAAAAAACVeOl0AAAAAAAAAAAAA
AAAcAAAAAAAAAAAAEADtQTUAAABwcmVtaWVyZS1nZW1pbmktcGx1Z2luL0NTWFMv
UEsBAh4DFAAAAAgAJV46XcPsx3tcAgAAUQYAACgAAAAAAAAAAQAAAKSBbwAAAHBy
ZW1pZXJlLWdlbWluaS1wbHVnaW4vQ1NYUy9tYW5pZmVzdC54bWxQSwECHgMUAAAA
CAAlXjpd7QUkCkIKAAB1FQAAIgAAAAAAAAABAAAApIERAwAAcHJlbWllcmUtZ2Vt
aW5pLXBsdWdpbi9RT0xMQU5NQS5tZFBLAQIeAwoAAAAAACVeOl0AAAAAAAAAAAAA
AAAeAAAAAAAAAAAAEADtQZMNAABwcmVtaWVyZS1nZW1pbmktcGx1Z2luL2NsaWVu
dC9QSwECHgMUAAAACAAlXjpdCgU6mqECAABIBQAAKAAAAAAAAAABAAAApIHPDQAA
cHJlbWllcmUtZ2VtaW5pLXBsdWdpbi9jbGllbnQvaW5kZXguaHRtbFBLAQIeAwoA
AAAAACVeOl0AAAAAAAAAAAAAAAAiAAAAAAAAAAAAEADtQbYQAABwcmVtaWVyZS1n
ZW1pbmktcGx1Z2luL2NsaWVudC9jc3MvUEsBAh4DFAAAAAgAJV46XT8Q+kTPAQAA
6AMAACsAAAAAAAAAAQAAAKSB9hAAAHByZW1pZXJlLWdlbWluaS1wbHVnaW4vY2xp
ZW50L2Nzcy9zdHlsZS5jc3NQSwECHgMKAAAAAAAlXjpdAAAAAAAAAAAAAAAAIQAA
AAAAAAAAABAA7UEOEwAAcHJlbWllcmUtZ2VtaW5pLXBsdWdpbi9jbGllbnQvanMv
UEsBAh4DFAAAAAgAJV46XWQDFL1+CgAA+BkAACgAAAAAAAAAAQAAAKSBTRMAAHBy
ZW1pZXJlLWdlbWluaS1wbHVnaW4vY2xpZW50L2pzL21haW4uanNQSwECHgMKAAAA
AAAlXjpdAAAAAAAAAAAAAAAAHAAAAAAAAAAAABAA7UERHgAAcHJlbWllcmUtZ2Vt
aW5pLXBsdWdpbi9ob3N0L1BLAQIeAxQAAAAIACVeOl0HfSo8pAgAAM0WAAAkAAAA
AAAAAAEAAACkgUseAABwcmVtaWVyZS1nZW1pbmktcGx1Z2luL2hvc3QvaG9zdC5q
c3hQSwUGAAAAAAwADADBAwAAMScAAAAA
