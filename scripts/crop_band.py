# crop_band.py: 裁原图 顶部/底部 条带 (供首尾质量修复视觉重读)
import sys
from PIL import Image, ImageOps
src, dst, band, ratio = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
im = Image.open(src)
im = ImageOps.exif_transpose(im)
w, h = im.size
if band == 'top':
    box = (0, 0, w, int(h * ratio))
else:
    box = (0, int(h * (1 - ratio)), w, h)
im.crop(box).save(dst, 'JPEG', quality=92)
print('CROP_OK')
