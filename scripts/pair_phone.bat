@echo off
REM ElectroMesh — one-shot Android pair + dispatcher launcher.
REM Usage:  scripts\pair_phone.bat <pair_port> <6_digit_code>
REM
REM How to get pair_port + code (takes 5 seconds on the phone):
REM   1. Phone → Settings → Developer options → Wireless debugging
REM   2. Tap "Pair device with pairing code"
REM   3. Read the 6-digit code AND the port (e.g. "192.168.0.26:41234")
REM   4. Run:  scripts\pair_phone.bat 41234 123456

setlocal
set PAIR_PORT=%1
set CODE=%2
set IP=192.168.0.26
set ADB=%USERPROFILE%\platform-tools\adb.exe

if "%PAIR_PORT%"=="" goto usage
if "%CODE%"=="" goto usage

echo [pair] %IP%:%PAIR_PORT% code=%CODE%
"%ADB%" pair %IP%:%PAIR_PORT% %CODE%
if errorlevel 1 (
  echo [pair] FAILED. check port + code on phone screen, re-run.
  exit /b 1
)

echo [pair] OK. starting infinite dispatcher in new window...
start "ElectroMesh Phone Dispatcher" cmd /k "cd /d %~dp0\.. && backend\.venv\Scripts\python.exe scripts\phone_dispatcher.py"
echo [pair] dispatcher launched. log: %TEMP%\electromesh_phone.log
exit /b 0

:usage
echo Usage: %~nx0 ^<pair_port^> ^<6_digit_code^>
echo Example: %~nx0 41234 123456
exit /b 2
