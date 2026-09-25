# 扫描版 PDF → 逐页 PNG (供视觉模型 OCR)
# 用法: python render_pdf.py <pdf> <outdir> [maxpages]
import sys, os
sys.stdout.reconfigure(encoding='utf-8')
import pymupdf

def main():
    src, outdir = sys.argv[1], sys.argv[2]
    maxpages = int(sys.argv[3]) if len(sys.argv) > 3 else 10
    os.makedirs(outdir, exist_ok=True)
    doc = pymupdf.open(src)
    n = min(doc.page_count, maxpages)
    files = []
    for i in range(n):
        page = doc[i]
        pix = page.get_pixmap(dpi=150)
        fp = os.path.join(outdir, f'page{i+1:03d}.png')
        pix.save(fp)
        files.append(fp)
    print(f'RENDERED:{n}')
    for f in files:
        print(f)

if __name__ == '__main__':
    main()
