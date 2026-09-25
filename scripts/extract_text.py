# 文件文本抽取: PDF / DOCX / TXT → 纯文本
# 用法: python extract_text.py <file> [outfile]
# PDF 走 pymupdf; 扫描版 PDF 输出 "SCAN_PDF" 标记由上层走 OCR; DOCX 解 zip 读 document.xml
import sys, os, json, re
sys.stdout.reconfigure(encoding='utf-8')

def extract_pdf(path):
    import pymupdf
    doc = pymupdf.open(path)
    parts = []
    scanned = 0
    for page in doc:
        t = page.get_text().strip()
        if len(t) < 20:
            scanned += 1
        parts.append(t)
    text = '\n'.join(parts)
    # 空文本或过半页无字 → 扫描版 (单页空 PDF 也命中)
    if not text.strip() or scanned >= max(1, doc.page_count // 2):
        return None  # 扫描版, 交给 OCR
    return text

def extract_docx(path):
    import zipfile
    with zipfile.ZipFile(path) as z:
        xml = z.read('word/document.xml').decode('utf-8', 'ignore')
    # 段落/换行标签转文本
    xml = re.sub(r'<w:tab[^>]*/>', '\t', xml)
    xml = re.sub(r'<w:br[^>]*/>', '\n', xml)
    text = re.sub(r'<w:p[ >]', '\n<w:p ', xml)
    text = re.sub(r'<[^>]+>', '', text)
    text = re.sub(r'\n{2,}', '\n', text)
    return text.strip()

def main():
    src = sys.argv[1]
    ext = os.path.splitext(src)[1].lower()
    if ext == '.pdf':
        text = extract_pdf(src)
        if text is None:
            print(json.dumps({'type': 'scan'}))
            return
    elif ext == '.docx':
        text = extract_docx(src)
    else:  # txt 等
        with open(src, encoding='utf-8', errors='ignore') as f:
            text = f.read()
    print(json.dumps({'type': 'text', 'text': text[:50000]}, ensure_ascii=False))

if __name__ == '__main__':
    main()
