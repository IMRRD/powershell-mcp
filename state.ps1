$p = "C:\Projects\LMEH\powershell-mcp"
$o = @()
$o += "git dir: $(Test-Path "$p\.git")"
$o += "node_modules: $(Test-Path "$p\node_modules")"
if (Test-Path "$p\node_modules") { $o += "pkgs: $((Get-ChildItem "$p\node_modules" -Directory).Count)" }
$o += "dist exists: $(Test-Path "$p\dist\index.js")"
$o += "git.exe test: " + (& "C:\Program Files\Git\cmd\git.exe" --version 2>&1)
$o -join "`n" | Out-File "$p\state.log" -Encoding utf8
