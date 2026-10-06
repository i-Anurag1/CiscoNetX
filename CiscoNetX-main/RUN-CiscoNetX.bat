@echo off
setlocal
cd /d "%~dp0"

echo ================================================
echo CiscoNetX - Enterprise Network Intelligence Lab
echo ================================================

if not exist ".venv\Scripts\python.exe" (
  echo Creating Python environment...
  python -m venv .venv
  if errorlevel 1 goto :error
  echo Installing backend dependencies...
  .venv\Scripts\python.exe -m pip install -r backend\requirements.txt
  if errorlevel 1 goto :error
)

if not exist "frontend\node_modules" (
  echo Installing frontend dependencies...
  cd frontend
  npm install
  if errorlevel 1 goto :error
  cd ..
)

echo Starting backend on http://localhost:8000 ...
start "CiscoNetX Backend" cmd /k "cd /d "%~dp0backend" && ..\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000"

echo Verifying frontend before start...
cd /d "%~dp0frontend"
npm run typecheck
if errorlevel 1 goto :error
npm run build
if errorlevel 1 goto :error
cd /d "%~dp0"
echo Starting frontend on http://localhost:5173 ...
start "CiscoNetX Frontend" cmd /k "cd /d "%~dp0frontend" && npm run dev"

echo.
echo CiscoNetX is starting.
echo Frontend: http://localhost:5173
 echo Backend:  http://localhost:8000/health
exit /b 0

:error
echo.
echo CiscoNetX startup failed. Read the error above.
pause
exit /b 1
