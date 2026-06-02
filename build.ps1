$ErrorActionPreference = "Continue"
$env:PATH = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;C:\Program Files\GitHub CLI;" + $env:PATH
$log = "C:\Projects\LMEH\powershell-mcp\build.log"
Set-Location "C:\Projects\LMEH\powershell-mcp"
"=== $(Get-Date -Format o) build start ===" | Out-File $log -Encoding utf8
function Run($label, $cmd) {
  "`n### $label" | Out-File $log -Append -Encoding utf8
  $out = (& cmd /c "$cmd 2>&1") | Out-String
  $out | Out-File $log -Append -Encoding utf8
  "[$label exit=$LASTEXITCODE]" | Out-File $log -Append -Encoding utf8
}
Run "versions" "node --version & npm --version & git --version"
if (-not (Test-Path ".git")) {
  Run "git init"   "git init"
  Run "git config" "git config user.email isakduplessis777@gmail.com & git config user.name `"Isak du Plessis`""
}
Run "npm install" "npm install"
Run "typecheck"   "npm run typecheck"
Run "build"       "npm run build"
Run "test"        "npm test"
Run "git add+commit" "git add -A & git commit -m `"powershell-mcp v0.1: hidden-window PS MCP, services/system tools, vitest + CI`""
Run "git log"     "git log --oneline -5"
"`n=== $(Get-Date -Format o) build done ===" | Out-File $log -Append -Encoding utf8
