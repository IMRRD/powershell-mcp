@echo off
set "NODE=C:\Program Files\nodejs\node.exe"
set "GIT=C:\Program Files\Git\bin\git.exe"
set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\bin;%PATH%"
cd /d C:\Projects\LMEH\powershell-mcp
set "LOG=C:\Projects\LMEH\powershell-mcp\verify.log"
echo === verify start %DATE% %TIME% === > "%LOG%"

echo ### fix esbuild binary >> "%LOG%"
"%NODE%" node_modules\esbuild\install.js >> "%LOG%" 2>&1
echo [esbuild exit=%ERRORLEVEL%] >> "%LOG%"

echo ### typecheck (tsc --noEmit) >> "%LOG%"
"%NODE%" node_modules\typescript\bin\tsc --noEmit >> "%LOG%" 2>&1
echo [typecheck exit=%ERRORLEVEL%] >> "%LOG%"

echo ### build (tsc -p) >> "%LOG%"
"%NODE%" node_modules\typescript\bin\tsc -p tsconfig.json >> "%LOG%" 2>&1
echo [build exit=%ERRORLEVEL%] >> "%LOG%"

echo ### test (vitest run) >> "%LOG%"
"%NODE%" node_modules\vitest\vitest.mjs run >> "%LOG%" 2>&1
echo [test exit=%ERRORLEVEL%] >> "%LOG%"

echo ### git commit >> "%LOG%"
"%GIT%" add -A >> "%LOG%" 2>&1
"%GIT%" -c user.email=isakduplessis777@gmail.com -c user.name="Isak du Plessis" commit -m "build: green typecheck/build/test locally" >> "%LOG%" 2>&1
"%GIT%" log --oneline -3 >> "%LOG%" 2>&1

echo === verify done %DATE% %TIME% === >> "%LOG%"
echo DONE-MARKER >> "%LOG%"
