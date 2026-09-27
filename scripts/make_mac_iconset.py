import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根

# 生成 macOS iconset (基于 favicon.png 猫爪图, 重绘各尺寸)
import sys, os
sys.path.insert(0, os.path.join(ROOT, r'scripts'))
from PIL import Image

SRC = os.path.join(ROOT, r'app\public\favicon.png')
OUT = os.path.join(ROOT, r'build\mac-shell\AppIcon.iconset')
os.makedirs(OUT, exist_ok=True)

im = Image.open(SRC).convert('RGBA')
specs = {
    'icon_16x16.png': 16, 'icon_16x16@2x.png': 32,
    'icon_32x32.png': 32, 'icon_32x32@2x.png': 64,
    'icon_128x128.png': 128, 'icon_128x128@2x.png': 256,
    'icon_256x256.png': 256, 'icon_256x256@2x.png': 512,
    'icon_512x512.png': 512, 'icon_512x512@2x.png': 1024,
}
for name, size in specs.items():
    im.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name))
print('iconset written:', len(specs), 'files ->', OUT)
