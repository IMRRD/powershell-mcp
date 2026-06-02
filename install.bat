@echo off
set "NPM=C:\Program Files\nodejs\npm.cmd"
set "PATH=C:\Program Files\nodejs;%PATH%"
set "NODE_ENV="
set "NPM_CONFIG_PRODUCTION=false"
cd /d C:\Projects\LMEH\powershell-mcp
set "LOG=C:\Projects\LMEH\powershell-mcp\install.log"
echo === install start %DATE% %TIME% === > "%LOG%"
call "%NPM%" install --include=dev --no-audit --no-fund >> "%LOG%" 2>&1
echo [npm install exit=%ERRORLEVEL%] >> "%LOG%"
echo ### .bin listing >> "%LOG%"
dir /b node_modules\.bin\tsc* node_modules\.bin\vitest* >> "%LOG%" 2>&1
echo === install done %DATE% %TIME% === >> "%LOG%"
echo DONE-MARKER >> "%LOG%"
