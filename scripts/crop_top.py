# crop_top.py: 裁原图顶部条带 (供视觉回读顶部正文)
import sys
from PIL import Image, ImageOps
src, dst = sys.argv[1], sys.argv[2]
ratio = float(sys.argv[3]) if len(sys.argv) > 3 else 0.28
im = Image.open(src)
im = ImageOps.exif_transpose(im)
w, h = im.size
top = im.crop((0, 0, w, max(120, int(h * ratio))))
top.save(dst, 'JPEG', quality=92)
print('CROP_OK')
