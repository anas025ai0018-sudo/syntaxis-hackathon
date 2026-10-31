@echo off
setlocal
cd /d "%~dp0"

set "PYTHON=%~dp0.venv\Scripts\python.exe"
set "APP_URL=http://127.0.0.1:8000/"

if not exist "%PYTHON%" (
  echo Project Python environment not found:
  echo %PYTHON%
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { $health = Invoke-WebRequest -Uri 'http://127.0.0.1:8000/health' -UseBasicParsing -TimeoutSec 2; if ($health.StatusCode -eq 200 -and $health.Content.Contains('healthy')) { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
  start "MediSync API" cmd /k ""%PYTHON%" -m uvicorn Backend.main:app --host 127.0.0.1 --port 8000"
)

for /l %%i in (1,1,20) do (
  powershell -NoProfile -Command "try { $health = Invoke-WebRequest -Uri 'http://127.0.0.1:8000/health' -UseBasicParsing -TimeoutSec 2; if ($health.StatusCode -eq 200 -and $health.Content.Contains('healthy')) { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 goto open_app
  timeout /t 1 /nobreak >nul
)

echo MediSync API did not start. Check the MediSync API terminal for errors.
pause
exit /b 1

:open_app
start "" "%APP_URL%"
endlocal
