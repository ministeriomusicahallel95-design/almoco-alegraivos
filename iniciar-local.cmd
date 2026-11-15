@echo off
cd /d "%~dp0"
echo Alegrai-vos - demonstracao local
echo Site: http://localhost:3015
echo Equipe: http://localhost:3015/equipe
echo Esta janela deve permanecer aberta. Ctrl+C encerra o servidor.
call npm.cmd run dev
pause
