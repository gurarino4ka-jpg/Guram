@echo off
setlocal
chcp 65001 >nul
set "monitor_exit=1"
cd /d "%~dp0"
if errorlevel 1 goto files_missing

where node >nul 2>nul
if errorlevel 1 goto node_missing
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 goto node_old
if not exist "monitor\cli.mjs" goto files_missing
if not exist "monitor.config.json" goto files_missing

set "NODE_USE_ENV_PROXY=1"
echo Запуск сбора свечей BTC, ETH, SOL и ZEC.
echo Оставьте это окно открытым. Для остановки нажмите Ctrl+C.
echo Журнал и состояние: data\market-monitor
echo.
node "monitor\cli.mjs"
set "monitor_exit=%errorlevel%"
echo.
echo Монитор завершён. Код завершения: %monitor_exit%
goto finish

:node_missing
echo Не найден Node.js. Установите Node.js 24 LTS с https://nodejs.org/
echo После установки закройте это окно и запустите файл заново.
goto finish

:node_old
echo Нужен Node.js версии 24 или новее. Рекомендуется Node.js 24 LTS.
echo Установите его с https://nodejs.org/ и запустите файл заново.
goto finish

:files_missing
echo Не найдены файлы монитора или его конфигурация.
echo Полностью распакуйте архив в обычную папку и запустите файл из неё.
goto finish

:finish
echo.
pause
endlocal & exit /b %monitor_exit%
