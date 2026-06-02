@echo off
set "NODE=C:\Program Files\nodejs\node.exe"
set "NPM=C:\Program Files\nodejs\npm.cmd"
set "GIT=C:\Program Files\Git\cmd\git.exe"
set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\cmd;%PATH%"
cd /d C:\Projects\LMEH\powershell-mcp
set "LOG=C:\Projects\LMEH\powershell-mcp\build.log"
echo === build start %DATE% %TIME% === > "%LOG%"

echo. >> "%LOG%"
echo ### versions >> "%LOG%"
"%NODE%" --version >> "%LOG%" 2>&1
"%NPM%" --version >> "%LOG%" 2>&1
"%GIT%" --version >> "%LOG%" 2>&1

if not exist ".git" (
  echo ### git init >> "%LOG%"
  "%GIT%" init >> "%LOG%" 2>&1
  "%GIT%" config user.email isakduplessis777@gmail.com >> "%LOG%" 2>&1
  "%GIT%" config user.name "Isak du Plessis" >> "%LOG%" 2>&1
)

echo. >> "%LOG%"
echo ### npm install >> "%LOG%"
call "%NPM%" install >> "%LOG%" 2>&1
echo [npm install exit=%ERRORLEVEL%] >> "%LOG%"

echo. >> "%LOG%"
echo ### typecheck >> "%LOG%"
call "%NPM%" run typecheck >> "%LOG%" 2>&1
echo [typecheck exit=%ERRORLEVEL%] >> "%LOG%"

echo. >> "%LOG%"
echo ### build >> "%LOG%"
call "%NPM%" run build >> "%LOG%" 2>&1
echo [build exit=%ERRORLEVEL%] >> "%LOG%"

echo. >> "%LOG%"
echo ### test >> "%LOG%"
call "%NPM%" test >> "%LOG%" 2>&1
echo [test exit=%ERRORLEVEL%] >> "%LOG%"

echo. >> "%LOG%"
echo ### git add+commit >> "%LOG%"
"%GIT%" add -A >> "%LOG%" 2>&1
"%GIT%" commit -m "powershell-mcp v0.1: hidden-window PS MCP, services/system tools, vitest + CI" >> "%LOG%" 2>&1
"%GIT%" log --oneline -5 >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo === build done %DATE% %TIME% === >> "%LOG%"
echo DONE-MARKER >> "%LOG%"
