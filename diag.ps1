$p = "C:\Projects\LMEH\powershell-mcp\node_modules"
$o = @()
foreach ($m in "typescript","vitest","esbuild","tsx","@types") {
  $o += "$m exists: $(Test-Path "$p\$m")"
}
$o += "--- typescript\bin ---"
$o += (Get-ChildItem "$p\typescript\bin" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
$o += "--- .bin\tsc.cmd content ---"
$o += (Get-Content "$p\.bin\tsc.cmd" -ErrorAction SilentlyContinue)
$o += "--- vitest dir ---"
$o += (Get-ChildItem "$p\vitest" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ", "
$o += "--- esbuild dir ---"
$o += (Get-ChildItem "$p\esbuild" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ", "
$o -join "`n" | Out-File "C:\Projects\LMEH\powershell-mcp\diag.log" -Encoding utf8
