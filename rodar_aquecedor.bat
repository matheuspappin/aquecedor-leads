@echo off
title Aquecedor de Leads - 4 Chips Compradores (Porta 5050)
echo ========================================================
echo   Iniciando o Aquecedor de Leads (4 Chips Compradores)
echo   Ambiente isolado da Maquina de Vendas
echo ========================================================
echo.

cd /d "C:\gemini cli\aquecedor-leads"

echo Iniciando servidor na porta 5050...
start http://localhost:5050
node server.js

pause
