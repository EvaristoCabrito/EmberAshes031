@echo off
setlocal
cd /d "%~dp0"
set "LOG=%~dp0log.txt"

echo ============================================ > "%LOG%"
echo  Ember - registro de inicializacao          >> "%LOG%"
echo  %date% %time%                              >> "%LOG%"
echo  pasta: %~dp0                               >> "%LOG%"
echo ============================================ >> "%LOG%"
echo. >> "%LOG%"

echo.
echo   Tudo o que acontecer aqui esta sendo gravado em:
echo   %LOG%
echo   Se der errado, esse arquivo abre sozinho no Bloco de Notas.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERRO: Node.js nao encontrado. >> "%LOG%"
  echo Instale a versao LTS em https://nodejs.org e reinicie o computador. >> "%LOG%"
  echo.
  echo   ERRO: Node.js nao esta instalado.
  echo   Baixe a versao LTS em https://nodejs.org, instale e REINICIE o PC.
  echo.
  start "" notepad "%LOG%"
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node --version') do echo Node: %%v >> "%LOG%"

rem  Chamar "npm" de dentro do PowerShell resolve para npm.ps1, e um Windows com
rem  execucao de scripts desabilitada (o padrao em muitas maquinas) recusa o
rem  arquivo: "npm.ps1 nao pode ser carregado". npm.cmd nao e script e nao passa
rem  pela politica de execucao, entao e ele que chamamos - pelo caminho completo,
rem  para nao depender de como o PATH esta montado.
set "NPMCMD="
for /f "delims=" %%p in ('where npm.cmd 2^>nul') do if not defined NPMCMD set "NPMCMD=%%p"
if not defined NPMCMD set "NPMCMD=%ProgramFiles%\nodejs\npm.cmd"
if not exist "%NPMCMD%" (
  echo ERRO: npm.cmd nao encontrado (procurei em %NPMCMD%). >> "%LOG%"
  echo.
  echo   ERRO: achei o Node mas nao achei o npm.
  echo   Reinstale o Node.js LTS de https://nodejs.org e REINICIE o PC.
  echo.
  start "" notepad "%LOG%"
  pause
  exit /b 1
)
echo npm: %NPMCMD% >> "%LOG%"

rem  O PowerShell so entra aqui para mostrar a saida na tela e grava-la no log ao
rem  mesmo tempo (o cmd sozinho faz um ou outro, nunca os dois). Se ele estiver
rem  bloqueado nesta maquina, este teste falha e caimos no cmd puro: a tela fica
rem  parada durante a instalacao, mas o log continua completo. Rodar e o que
rem  importa; o log e conforto.
set "TEE="
powershell -NoProfile -ExecutionPolicy Bypass -Command "exit 7" >nul 2>nul
if errorlevel 7 if not errorlevel 8 set "TEE=1"
if defined TEE (echo tee: powershell >> "%LOG%") else (echo tee: nao - usando cmd puro >> "%LOG%")

if not exist node_modules (
  echo.
  echo   ============================================
  echo    PRIMEIRA VEZ - PRECISA DE INTERNET
  echo   ============================================
  echo.
  echo   Baixando o que o jogo precisa. De 3 a 5 minutos.
  echo   NAO FECHE esta janela.
  echo.
  echo   Depois desta vez o jogo roda SEM INTERNET,
  echo   e esta parte nunca mais acontece.
  echo.
  echo --- npm install --- >> "%LOG%"
  call :runnpm install
  if errorlevel 1 goto falhou
) else (
  echo   Ja instalado - rodando OFFLINE, sem internet. >> "%LOG%"
  echo   Ja instalado. Nao precisa de internet.
)

echo --- npm run dev --- >> "%LOG%"
echo.
echo   Abrindo o jogo em http://localhost:8080
echo   Deixe esta janela aberta enquanto joga.
echo.
start "" cmd /c "timeout /t 5 /nobreak >nul && start http://localhost:8080"
call :runnpm run dev
if errorlevel 1 goto falhou

echo.
echo   O jogo foi encerrado.
pause
exit /b 0

rem  Roda o npm mostrando tudo na tela E gravando no log, para que um erro
rem  possa ser lido e copiado depois em vez de sumir com a janela. O
rem  -ExecutionPolicy Bypass e cinto e suspensorio: o que resolve de fato e
rem  chamar npm.cmd em vez de npm. exit $LASTEXITCODE devolve o codigo do npm,
rem  senao o PowerShell sai 0 e uma falha passaria batida.
:runnpm
if defined TEE (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "& '%NPMCMD%' %* 2>&1 | Tee-Object -FilePath '%LOG%' -Append; exit $LASTEXITCODE"
) else (
  echo   [a tela fica parada ate terminar - e normal, esta gravando no log]
  call "%NPMCMD%" %* >> "%LOG%" 2>&1
)
goto :eof

:falhou
echo.
echo   ============================================
echo    DEU ERRO
echo   ============================================
echo.
echo   Abrindo o registro no Bloco de Notas.
echo   Copie o texto todo e mande para o Claude.
echo.
start "" notepad "%LOG%"
pause
exit /b 1
