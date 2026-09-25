# llama.cpp 引擎下载脚本 (Windows) —— 取回本软件使用的本地推理引擎
# 用法:
#   powershell -ExecutionPolicy Bypass -File tools\fetch-engine.ps1                 # CUDA 版 (NVIDIA 显卡, 推荐)
#   powershell -ExecutionPolicy Bypass -File tools\fetch-engine.ps1 -Flavor cpu     # 纯 CPU 版 (无显卡/体积小)
#   powershell -ExecutionPolicy Bypass -File tools\fetch-engine.ps1 -Check          # 只检查引擎是否就绪
# 说明: 引擎与 CUDA 运行库来自 ggml-org/llama.cpp 官方 release (MIT);
#       GitHub 直连在国内常被墙, 脚本默认走 ghfast.top 代理, 失败自动换 gh-proxy.com / 直连。
param(
  [ValidateSet('cuda', 'cpu')][string]$Flavor = 'cuda',
  [switch]$Check,
  [string]$Proxy = 'https://ghfast.top'
)

$ErrorActionPreference = 'Stop'
$Root   = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Engine = Join-Path $Root 'app\llama'
$Tmp    = Join-Path $Root 'tmp'
if (!(Test-Path $Tmp)) { New-Item -ItemType Directory -Path $Tmp | Out-Null }

$ServerExe = Join-Path $Engine 'llama-server.exe'
if (Test-Path $ServerExe) {
  $ver = (& $ServerExe --version 2>&1 | Select-Object -First 1)
  Write-Host "[OK] 引擎已就绪: $ver"
  if ($Check) { exit 0 }
  Write-Host "     (如需重装, 先删除 app\llama 目录再运行本脚本)"
  exit 0
}
if ($Check) { Write-Host "[MISS] 引擎未就绪: 缺少 app\llama\llama-server.exe"; exit 1 }

Write-Host "==== 查询 llama.cpp 最新 release ===="
$rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest' -Headers @{ 'User-Agent' = 'english-study-fetch' }
Write-Host "  版本: $($rel.tag_name)  ($($rel.published_at.Substring(0,10)))"

# 按 flavor 挑资产 (不写死 build 号, 从 release 元数据里发现)
$pat = if ($Flavor -eq 'cuda') { 'llama-b.*-bin-win-cuda-12\.4-x64\.zip$' } else { 'llama-b.*-bin-win-cpu-x64\.zip$' }
$main = $rel.assets | Where-Object { $_.name -match $pat } | Select-Object -First 1
if (!$main) {
  Write-Host "  未找到匹配资产 ($Flavor)。该 release 可用资产:"
  $rel.assets | Where-Object { $_.name -match 'win' } | ForEach-Object { Write-Host "    $($_.name)" }
  exit 1
}
$assets = @($main)
if ($Flavor -eq 'cuda') {
  # CUDA 构建需要配套运行库 (cublas/cudart DLL), 官方单列一个 zip
  $rt = $rel.assets | Where-Object { $_.name -match '^cudart-llama-bin-win-cuda-12\.4-x64\.zip$' } | Select-Object -First 1
  if ($rt) { $assets += $rt } else { Write-Host "  [WARN] 未找到 cudart 运行库资产, 若启动报 DLL 缺失请手动补" }
}

if (!(Test-Path $Engine)) { New-Item -ItemType Directory -Path $Engine | Out-Null }

foreach ($a in $assets) {
  $zip = Join-Path $Tmp $a.name
  $urls = @("$Proxy/$($a.browser_download_url)", "https://gh-proxy.com/$($a.browser_download_url)", $a.browser_download_url)
  Write-Host "`n==== 下载 $($a.name)  ($([Math]::Round($a.size/1MB,1)) MB) ===="
  $got = $false
  foreach ($u in $urls) {
    Write-Host "  源: $u"
    & curl.exe -L -C - --retry 3 --retry-delay 2 -o $zip $u
    if ($LASTEXITCODE -eq 0 -and (Test-Path $zip) -and (Get-Item $zip).Length -ge ($a.size * 0.98)) { $got = $true; break }
    Write-Host "  失败, 换下一个源"
  }
  if (!$got) { Write-Host "  下载失败。也可手动从 $($a.browser_download_url) 下载后解压到 app\llama\"; exit 1 }
  Write-Host "  解压到 app\llama\ ..."
  Expand-Archive -Path $zip -DestinationPath $Engine -Force
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
}

# 官方 zip 可能带一层子目录, 拍平到 app\llama\
$nested = Get-ChildItem $Engine -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'llama-server.exe') } | Select-Object -First 1
if ($nested) {
  Write-Host "  拍平子目录 $($nested.Name) ..."
  Get-ChildItem $nested.FullName -Recurse | ForEach-Object {
    $rel = $_.FullName.Substring($nested.FullName.Length).TrimStart('\')
    $dst = Join-Path $Engine $rel
    if ($_.PSIsContainer) { if (!(Test-Path $dst)) { New-Item -ItemType Directory -Path $dst | Out-Null } }
    else { Move-Item $_.FullName $dst -Force }
  }
  Remove-Item $nested.FullName -Recurse -Force -ErrorAction SilentlyContinue
}

if (Test-Path $ServerExe) {
  $v = (& $ServerExe --version 2>&1 | Select-Object -First 1)
  Write-Host "`n[OK] 引擎安装完成: $v"
  Write-Host "下一步: powershell -File tools\fetch-models.ps1  然后双击 启动背诵工具.bat"
} else {
  Write-Host "`n[FAIL] 未找到 llama-server.exe, 请检查解压结果"
  exit 1
}
