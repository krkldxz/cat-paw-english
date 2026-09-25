# RapidOCR serve: 单次/常驻 + layout 模式(选项网格重建)
import sys, json, re
sys.stdout.reconfigure(encoding='utf-8')
from rapidocr_onnxruntime import RapidOCR
from PIL import Image, ImageOps

def prep_img(src, dst, max_side=1400):
    im = Image.open(src)
    im = ImageOps.exif_transpose(im)
    if im.mode not in ('RGB', 'L'):
        im = im.convert('RGB')
    w, h = im.size
    r = min(1.0, max_side / max(w, h))
    if r < 1:
        im = im.resize((int(w * r), int(h * r)), Image.LANCZOS)
    im.save(dst, 'JPEG', quality=90)
    return dst

def recognize(engine, img):
    try:
        result, _ = engine(img)
    except Exception as e:
        return {'error': str(e)[:100]}
    if not result:
        return {'text': '', 'n': 0}
    items = []
    for box, text, score in result:
        if not text or not text.strip():
            continue
        ys = [p[1] for p in box]; xs = [p[0] for p in box]
        items.append({'x': min(xs), 'x2': max(xs), 'y': min(ys), 'h': max(ys) - min(ys), 'text': str(text).strip()})
    return _layout(items)

def _layout(items):
    """版面重建: 行带聚类 → 片段内容分类(opt/body/noise) → 若含选项网格则题号驱动重建"""
    items.sort(key=lambda t: (t['y'], t['x']))
    # 行带 (顶缘差)
    bands = []
    for it in items:
        if not bands or it['y'] - bands[-1]['ybase'] > 25:
            bands.append({'ybase': it['y'], 'items': [it]})
        else:
            bands[-1]['items'].append(it)
    opt_re = re.compile(r'(?:^\d{1,2}\.)?\s*[A-D]\.\s*\w')
    def classify(text):
        if opt_re.search(text):
            return 'opt'
        words = text.split()
        if len(text) >= 16 or len(words) >= 3 or re.search(r"[.,;:?!'\"\u2019]", text):
            return 'body'
        return 'noise'
    frags = []
    for b in bands:
        bitems = sorted(b['items'], key=lambda t: t['x'])
        groups = []
        cur = [bitems[0]]
        for it in bitems[1:]:
            if it['x'] - cur[-1]['x2'] > 25:
                groups.append(cur); cur = [it]
            else:
                cur.append(it)
        groups.append(cur)
        for g in groups:
            txt = ' '.join(t['text'] for t in g)
            k = classify(txt)
            if k != 'noise':
                frags.append({'y': b['ybase'], 'kind': k, 'txt': txt, 'x': min(t['x'] for t in g)})
    frags.sort(key=lambda f: (f['y'], f['txt']))
    # 题号驱动重建
    qn = re.compile(r'^(\d{1,2})\.\s*([A-D])\.\s*(.*)$')
    wordre = re.compile(r'([A-D])\.\s*([A-Za-z][A-Za-z\-]*(?:\s+[A-Za-z][A-Za-z\-]*)*?)(?=\s+[A-D]\.\s*|$)')
    questions = {}; order = []; cur = None; body = []; opt_max_y = 0
    for f in frags:
        if f['kind'] == 'body':
            body.append((f['txt'], f['x'], f['y'])); continue
        m = qn.match(f['txt'])
        if m:
            n = int(m.group(1))
            if n not in questions:
                questions[n] = {}
                order.append(n)
            cur = n
            if f['y'] > opt_max_y: opt_max_y = f['y']
            seg = m.group(2) + '. ' + m.group(3)
        elif cur is not None:
            seg = f['txt']
        else:
            continue
        for mm in wordre.finditer(seg):
            L = mm.group(1); wd = mm.group(2).strip()
            if L in 'ABCD' and wd and L not in questions[cur]:
                questions[cur][L] = wd
    # 组装输出
    opt_lines = []
    for n in sorted(order):
        q = questions[n]
        if len(q) < 2:
            continue  # 不完整选项行丢弃
        opt_lines.append(str(n) + '. ' + ' | '.join(L + '. ' + q.get(L, '') for L in 'ABCD'))
    # 版面规则过滤(选项页): ①选项区下方内容全保留 ②选项区上方: 保留"连续正文块"
    #   (≥2条长行>=40字且相邻行距<250 → 真正文, 如"正文在上选项在下"的卷面); 孤立碎片删
    if len(opt_lines) >= 3:
        cutoff = opt_max_y + 40
        below = [b for b in body if b[2] >= cutoff]
        above = sorted([b for b in body if b[2] < cutoff], key=lambda b: b[2])
        long_above = [b for b in above if len(b[0]) >= 40]
        keep_above = []
        if len(long_above) >= 2:
            # 连续正文块: 保留彼此 y 间距 <250 的长行组
            keep_above = [long_above[0]]
            for b in long_above[1:]:
                if b[2] - keep_above[-1][2] < 250:
                    keep_above.append(b)
        all_body = below + keep_above
        # 动态主列过滤(无死坐标): 正文行 x 中位数为参考, 丢显著偏左边缘行
        cand = [b for b in all_body if b[1] >= 60]
        if len(cand) >= 3:
            xs = sorted(b[1] for b in cand)
            med = xs[len(xs) // 2]
            all_body = [b for b in all_body if b[1] >= med - 60]
        below = [b for b in all_body if b[2] >= cutoff]
        keep_above = [b for b in all_body if b[2] < cutoff]
        below.sort(key=lambda b: b[2])
        keep_above.sort(key=lambda b: b[2])
    else:
        below = sorted(body, key=lambda b: b[2])
        keep_above = []
    above_txt = '\n'.join(b[0] for b in keep_above)
    below_txt = '\n'.join(b[0] for b in below)
    text = (above_txt + '\n\n' if above_txt else '') + '\n'.join(opt_lines) + ('\n\n' + below_txt if below_txt else '')
    return {'text': text, 'options': opt_lines, 'body': [b[0] for b in (keep_above + below)], 'n': len(items)}

def serve():
    engine = RapidOCR()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            src = req.get('img', '')
            out = src + '.norm.jpg'
            prep_img(src, out)
            r = recognize(engine, out)
            r['id'] = req.get('id', 0)
            print(json.dumps(r, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({'id': 0, 'error': str(e)[:100]}), flush=True)

if __name__ == '__main__':
    if len(sys.argv) > 1:
        engine = RapidOCR()
        src = sys.argv[1]
        out = src + '.norm.jpg'
        prep_img(src, out)
        print(json.dumps(recognize(engine, out), ensure_ascii=False))
    else:
        serve()
