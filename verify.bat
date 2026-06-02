@echo off
set "NPM=C:\Program Files\nodejs\npm.cmd"
set "GIT=C:\Program Files\Git\bin\git.exe"
set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\bin;%PATH%"
cd /d C:\Projects\LMEH\powershell-mcp
set "LOG=C:\Projects\LMEH\powershell-mcp\verify.log"
echo === verify start %DATE% %TIME% === > "%LOG%"

echo ### typecheck >> "%LOG%"
call "%NPM%" run typecheck >> "%LOG%" 2>&1
echo [typecheck exit=%ERRORLEVEL%] >> "%LOG%"

echo ### build >> "%LOG%"
call "%NPM%" run build >> "%LOG%" 2>&1
echo [build exit=%ERRORLEVEL%] >> "%LOG%"

echo ### test >> "%LOG%"
call "%NPM%" test >> "%LOG%" 2>&1
echo [test exit=%ERRORLEVEL%] >> "%LOG%"

echo ### git status >> "%LOG%"
"%GIT%" --version >> "%LOG%" 2>&1
"%GIT%" add -A >> "%LOG%" 2>&1
"%GIT%" -c user.email=isakduplessis777@gmail.com -c user.name="Isak du Plessis" commit -m "powershell-mcp v0.1: hidden-window PS MCP, services/system tools, vitest + CI" >> "%LOG%" 2>&1
"%GIT%" log --oneline -5 >> "%LOG%" 2>&1

echo === verify done %DATE% %TIME% === >> "%LOG%"
echo DONE-MARKER >> "%LOG%"
