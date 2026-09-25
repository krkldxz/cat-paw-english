# 内嵌 python OCR 端到端验证 (PADDLE_PDX_CACHE_HOME 指向随包目录)
$ErrorActionPreference = 'Continue'
$py = Join-Path $PSScriptRoot 'tmp\python\python.exe'
$env:PADDLE_PDX_CACHE_HOME = (Join-Path $PSScriptRoot 'tmp\python\.paddlex')
$img = Join-Path $PSScriptRoot 'ocr_test.png'
$script = 'C:\Users\krkld\.openclaw\projects\english-study\scripts\rapid_ocr.py'
$t0 = Get-Date
$out = Get-Content $img -Raw
# rapid_ocr.py 是常驻 worker(stdin JSON 行), 单发一条 {"id":1,"img":path}
'{"id":1,"img":"' + ($img -replace '\\','\\') + '"}' | & $py $script
Write-Output "elapsed=$((Get-Date).Subtract($t0).TotalSeconds)s rc=$LASTEXITCODE"
