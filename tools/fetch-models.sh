#!/usr/bin/env bash
# 模型下载脚本 (macOS / Linux) —— 取回本软件需要的两个 GGUF 文件
# 用法:
#   bash tools/fetch-models.sh          # 下载(断点续传)
#   bash tools/fetch-models.sh --check  # 只校验
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/models"
MIRROR="${MIRROR:-https://hf-mirror.com}"
REPO="${REPO:-unsloth/gemma-4-E2B-it-GGUF}"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

mkdir -p "$DEST"

# 上游名|本地名|字节数|sha256
FILES=(
"gemma-4-E2B-it-Q4_K_M.gguf|gemma-4-E2B-it-Q4_K_M.gguf|3106738272|740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8"
"mmproj-F16.gguf|gemma-4-E2B-mmproj-F16.gguf|985654080|140be8d7849741f88c50757d529b84373ee8e27052cc2236855b537f4a8215fa"
)

sha_of() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi; }

verify() { # $1=path $2=bytes $3=sha
  [ -f "$1" ] || { echo "  缺失"; return 1; }
  local sz; sz=$(wc -c < "$1" | tr -d ' ')
  [ "$sz" = "$2" ] || { echo "  大小不符 ($sz / $2)"; return 1; }
  local h; h=$(sha_of "$1")
  [ "$h" = "$3" ] || { echo "  sha256 不符 (${h:0:16}...)"; return 1; }
  echo "  ok"; return 0
}

echo "==== 模型文件检查 ($DEST) ===="
ALL_OK=1
for row in "${FILES[@]}"; do
  IFS='|' read -r up local bytes sha <<< "$row"
  printf '  %-32s' "$local"
  if verify "$DEST/$local" "$bytes" "$sha" >/dev/null 2>&1; then echo "[OK]"; else echo "[MISS]"; ALL_OK=0; fi
done

if [ "$CHECK_ONLY" = "1" ]; then
  [ "$ALL_OK" = "1" ] && { echo; echo "全部就绪。"; exit 0; } || { echo; echo "有文件未就绪, 去掉 --check 即可下载"; exit 1; }
fi
[ "$ALL_OK" = "1" ] && { echo; echo "全部就绪, 无需下载。"; exit 0; }

for row in "${FILES[@]}"; do
  IFS='|' read -r up local bytes sha <<< "$row"
  target="$DEST/$local"
  if verify "$target" "$bytes" "$sha" >/dev/null 2>&1; then echo; echo "跳过 $local (已就绪)"; continue; fi
  echo
  echo "==== 下载 $local  约 $((bytes/1048576)) MB ===="
  ok=0
  for url in "$MIRROR/$REPO/resolve/main/$up" "https://huggingface.co/$REPO/resolve/main/$up"; do
    echo "  源: $url"
    curl -L -C - --retry 5 --retry-delay 3 -o "$target" "$url" || { echo "  curl 失败, 换源"; continue; }
    if verify "$target" "$bytes" "$sha" >/dev/null 2>&1; then echo "  [OK] 校验通过"; ok=1; break; fi
    echo "  [WARN] 校验未过: $(verify "$target" "$bytes" "$sha")"
  done
  [ "$ok" = "1" ] || { echo "  下载未完成。重跑本脚本可续传。"; exit 1; }
done

echo
echo "==== 完成 ===="
for row in "${FILES[@]}"; do IFS='|' read -r up local bytes sha <<< "$row"; printf '  %-32s' "$local"; verify "$DEST/$local" "$bytes" "$sha"; done
echo
echo "下一步: 双击 启动(双击我-Mac).command (或见 快速开始.md)"
