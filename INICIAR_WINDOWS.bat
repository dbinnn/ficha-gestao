@echo off
cd /d "%~dp0"
if exist "%~dp0supabase-ca.crt" set "NODE_EXTRA_CA_CERTS=%~dp0supabase-ca.crt"
where node >nul 2>nul
if errorlevel 1 (
  echo Instale Node.js 24 conforme o README.md.
  pause
  exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo Arquivo .env criado. Preencha as credenciais e siga o README.md antes de iniciar.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm ci
  if errorlevel 1 exit /b 1
)
echo Abra http://localhost:5173 no navegador quando o servidor iniciar.
call npm run dev
pause
