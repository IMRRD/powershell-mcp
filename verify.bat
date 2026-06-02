@echo off
set "NODE=C:\Program Files\nodejs\node.exe"
set "NPM=C:\Program Files\nodejs\npm.cmd"
set "GIT=C:\Program Files\Git\bin\git.exe"
set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\bin;C:\Windows\System32;%PATH%"
set "NODE_ENV="
cd /d C:\Projects\LMEH\powershell-mcp
set "LOG=C:\Projects\LMEH\powershell-mcp\verify.log"
echo === verify start %DATE% %TIME% === > "%LOG%"

echo ### install (ignore-scripts) >> "%LOG%"
call "%NPM%" install --include=dev --ignore-scripts --no-audit --no-fund >> "%LOG%" 2>&1
echo [install exit=%ERRORLEVEL%] >> "%LOG%"

echo ### pkg dirs present? >> "%LOG%"
for %%d in (typescript vitest esbuild tsx) do if exist node_modules\%%d (echo %%d OK >> "%LOG%") else (echo %%d MISSING >> "%LOG%")
if exist node_modules\@esbuild\win32-x64 (echo esbuild-win32 OK >> "%LOG%") else (echo esbuild-win32 MISSING >> "%LOG%")

echo ### typecheck >> "%LOG%"
"%NODE%" node_modules\typescript\bin\tsc --noEmit >> "%LOG%" 2>&1
echo [typecheck exit=%ERRORLEVEL%] >> "%LOG%"

echo ### build >> "%LOG%"
"%NODE%" node_modules\typescript\bin\tsc -p tsconfig.json >> "%LOG%" 2>&1
echo [build exit=%ERRORLEVEL%] >> "%LOG%"

echo ### test >> "%LOG%"
"%NODE%" node_modules\vitest\vitest.mjs run >> "%LOG%" 2>&1
echo [test exit=%ERRORLEVEL%] >> "%LOG%"

echo ### git commit >> "%LOG%"
"%GIT%" add -A >> "%LOG%" 2>&1
"%GIT%" -c user.email=isakduplessis777@gmail.com -c user.name="Isak du Plessis" commit -m "chore: complete local install, green build/test" >> "%LOG%" 2>&1
"%GIT%" log --oneline -3 >> "%LOG%" 2>&1

echo === verify done %DATE% %TIME% === >> "%LOG%"
echo DONE-MARKER >> "%LOG%"
