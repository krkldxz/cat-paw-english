# 模型下载脚本 —— 自动取回本软件需要的两个 GGUF 文件
# 用法:
#   powershell -ExecutionPolicy Bypass -File tools\fetch-models.ps1          # 下载(断点续传)
#   powershell -ExecutionPolicy Bypass -File tools\fetch-models.ps1 -Check    # 只校验已有文件
# 来源: unsloth/gemma-4-E2B-it-GGUF (Apache-2.0, 见 THIRD_PARTY_NOTICES.md)
param(
  [switch]$Check,                                   # 只校验不下载
  [string]$Mirror = 'https://hf-mirror.com',        # 主镜像 (国内快); 失败自动切 huggingface.co
  [string]$Repo   = 'unsloth/gemma-4-E2B-it-GGUF'
)

$ErrorActionPreference = 'Stop'
$Root  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Dest  = Join-Path $Root 'models'
if (!(Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest | Out-Null }

# 目标文件: 上游名 -> 本地名 + 期望字节数 + 期望 sha256 (与上游 LFS oid 逐字节对齐)
$Files = @(
  @{ Up = 'gemma-4-E2B-it-Q4_K_M.gguf'; Local = 'gemma-4-E2B-it-Q4_K_M.gguf'
     Bytes = 3106738272
     Sha   = '740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8'
     Note  = '主模型 (对话/提取)' },
  @{ Up = 'mmproj-F16.gguf'; Local = 'gemma-4-E2B-mmproj-F16.gguf'
     Bytes = 985654080
     Sha   = '140be8d7849741f88c50757d529b84373ee8e27052cc2236855b537f4a8215fa'
     Note  = '视觉模块 (图片识别)' }
)

function Get-Sha256($p) { (Get-FileHash -Path $p -Algorithm SHA256).Hash.ToLower() }

function Test-One($f) {
  $p = Join-Path $Dest $f.Local
  if (!(Test-Path $p)) { return @{ ok = $false; why = '缺失' } }
  $len = (Get-Item $p).Length
  if ($len -ne $f.Bytes) { return @{ ok = $false; why = "大小不符 ($len / $($f.Bytes))" } }
  $h = Get-Sha256 $p
  if ($h -ne $f.Sha) { return @{ ok = $false; why = "sha256 不符 ($($h.Substring(0,16))...)" } }
  return @{ ok = $true; why = 'ok' }
}

Write-Host "==== 模型文件检查 ($Dest) ===="
$allOk = $true
foreach ($f in $Files) {
  $r = Test-One $f
  if ($r.ok) { Write-Host ("  [OK]   " + $f.Local + "  (" + $f.Note + ")") }
  else { $allOk = $false; Write-Host ("  [MISS] " + $f.Local + "  " + $r.why) }
}
if ($Check) {
  if ($allOk) { Write-Host "`n全部就绪, 可以启动: 双击 启动背诵工具.bat"; exit 0 }
  else { Write-Host "`n有文件未就绪, 去掉 -Check 参数即可下载"; exit 1 }
}
if ($allOk) { Write-Host "`n全部就绪, 无需下载。"; exit 0 }

# ---- 下载 (curl 断点续传; 主镜像失败切官方) ----
foreach ($f in $Files) {
  $r = Test-One $f
  if ($r.ok) { Write-Host "`n跳过 $($f.Local) (已就绪)"; continue }
  $target = Join-Path $Dest $f.Local
  $urls = @(
    "$Mirror/$Repo/resolve/main/$($f.Up)",
    "https://huggingface.co/$Repo/resolve/main/$($f.Up)"
  )
  Write-Host "`n==== 下载 $($f.Local)  [$($f.Note)]  约 $([Math]::Round($f.Bytes/1MB)) MB ===="
  $done = $false
  foreach ($u in $urls) {
    Write-Host "  源: $u"
    # -C - 断点续传; --retry 抗抖动; -L 跟随跳转
    & curl.exe -L -C - --retry 5 --retry-delay 3 --retry-connrefused -o $target $u
    if ($LASTEXITCODE -eq 0) {
      $r2 = Test-One $f
      if ($r2.ok) { Write-Host "  [OK] 校验通过"; $done = $true; break }
      Write-Host "  [WARN] 下载完成但 $($r2.why)"
      if ((Get-Item $target).Length -eq $f.Bytes) {
        $bad = "$target.bad"
        Move-Item $target $bad -Force
        Write-Host "  已移到 $bad (请删除后重试, 或换源)"
        break
      }
      # 大小不足 -> 继续尝试下一个源 (可续传)
    } else {
      Write-Host "  [WARN] curl 退出码 $LASTEXITCODE, 换下一个源"
    }
  }
  if (!$done) { Write-Host "  下载未完成。可重跑本脚本(会续传), 或手动从 $Mirror/$Repo 取。"; exit 1 }
}

Write-Host "`n==== 完成 ===="
foreach ($f in $Files) { $r = Test-One $f; Write-Host ("  " + $f.Local + " -> " + $r.why) }
Write-Host "`n下一步: 双击 启动背诵工具.bat"
