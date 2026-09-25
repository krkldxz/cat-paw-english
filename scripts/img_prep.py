# img_prep v2: 预处理 + 竖长图切半
import sys, os
sys.stdout.reconfigure(encoding='utf-8')
from PIL import Image, ImageOps

def prep(src, dst, max_side=1400):
    im = Image.open(src)
    im = ImageOps.exif_transpose(im)
    if im.mode not in ('RGB', 'L'):
        im = im.convert('RGB')
    w, h = im.size
    r = min(1.0, max_side / max(w, h))
    if r < 1:
        im = im.resize((int(w * r), int(h * r)), Image.LANCZOS)
        w, h = im.size
    im.save(dst, 'JPEG', quality=90)
    tiles = []
    # 竖长或高图 → 纵向切多段(每段高<=950, 带8%重叠), 供视觉分段读取(每段token在引擎上限内)
    if h > w * 1.25:
        seg_h = 640 if h > 1250 else 950  # 2026-09-07: tall pages get 3 finer segments (less lines per read => fewer drops on small-font pages)
        ov = int(seg_h * 0.03)  # 2026-09-07: 8%重叠致视觉接缝复读重复, 降 3%
        y0 = 0
        i = 0
        while y0 < h:
            y1 = min(y0 + seg_h, h)
            fp = dst + ('.t%d.jpg' % i)
            im.crop((0, y0, w, y1)).save(fp, 'JPEG', quality=90)
            tiles.append(fp)
            i += 1
            if y1 >= h:
                break
            y0 = y1 - ov  # 重叠
    return w, h, tiles

if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    w, h, halves = prep(src, dst)
    print('PREP_OK', w, h, *halves)
