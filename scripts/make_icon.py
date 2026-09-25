# 生成品牌图标: 暖橙圆角底 + 白色猫爪 (favicon.ico + png 多尺寸)
from PIL import Image, ImageDraw
import os

OUT = r'C:\Users\krkld\.openclaw\projects\english-study\app\public'
os.makedirs(OUT, exist_ok=True)

def draw_paw(size=256, aa=4):
    S = size * aa
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # 圆角渐变底: 上 #fb923c 下 #f97316
    r = int(S * 0.22)
    top, bot = (251, 146, 60), (234, 88, 12)
    grad = Image.new('RGBA', (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / max(1, S - 1)
        c = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,)
        gd.line([(0, y), (S, y)], fill=c)
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S, S], radius=r, fill=255)
    im.paste(grad, (0, 0), mask)
    # 白色猫爪
    w = S / 256.0
    def ell(cx, cy, rx, ry):
        d.ellipse([(cx - rx) * w, (cy - ry) * w, (cx + rx) * w, (cy + ry) * w], fill=(255, 255, 255, 255))
    ell(128, 168, 56, 44)                 # 掌垫
    ell(66, 112, 22, 27)                  # 趾1
    ell(105, 78, 23, 29)                  # 趾2
    ell(151, 78, 23, 29)                  # 趾3
    ell(190, 112, 22, 27)                 # 趾4
    return im.resize((size, size), Image.LANCZOS)

im256 = draw_paw(256)
im256.save(os.path.join(OUT, 'favicon.png'))
im256.save(os.path.join(OUT, 'favicon.ico'),
           format='ICO', sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
# exe 用的 ico (csc /win32icon)
im256.save(r'C:\Users\krkld\.openclaw\projects\english-study\build\app.ico',
           format='ICO', sizes=[(16, 16), (32, 32), (48, 48), (256, 256)])
print('icons written')
