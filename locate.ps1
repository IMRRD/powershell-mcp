$log = "C:\Projects\LMEH\powershell-mcp\locate.log"
$cands = @(
  "C:\Program Files\nodejs\node.exe",
  "C:\Program Files\nodejs\npm.cmd",
  "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
  "$env:ProgramFiles\Git\cmd\git.exe",
  "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe",
  "C:\Program Files\Git\bin\git.exe"
)
$out = @()
foreach ($c in $cands) { if (Test-Path $c) { $out += "FOUND: $c" } else { $out += "no:    $c" } }
# also probe registry/where via cmd
$out += "--- where (cmd) ---"
$out += (cmd /c "where node 2>nul")
$out += (cmd /c "where npm 2>nul")
$out += (cmd /c "where git 2>nul")
$out += "--- machine PATH node hint ---"
$out += ([Environment]::GetEnvironmentVariable("PATH","Machine") -split ';' | Where-Object { $_ -match 'node|git' })
$out += ([Environment]::GetEnvironmentVariable("PATH","User") -split ';' | Where-Object { $_ -match 'node|git' })
$out -join "`n" | Out-File $log -Encoding utf8
