# OCR worker v5 (PP-OCRv5-mobile-det + en_PP-OCRv5-mobile-rec)
# 2026-09-07 由 v4(RapidOCR) 换内核; 旧版备份: rapid_ocr.v4.py (回滚=换回该文件+server.js 的 OCR_PY)
# 协议不变: 常驻 stdin/stdout JSON 行 {img,id} → {text,options,body,n,id} / {error}; 单图 CLI 模式保留
import sys, json, re
sys.stdout.reconfigure(encoding='utf-8')
from PIL import Image, ImageOps

# 引擎: Paddle v5-mobile det + 英文专用 rec (纯能力评测确认版)
# 依赖: paddlepaddle==3.0.0(必须! 3.3.1 oneDNN+PIR bug 只能关 mkldnn, CPU 推理慢 10x)
# 无 paddle 环境(Mac 便携包)自动降级 RapidOCR(onnxruntime) 同协议适配层; Windows 行为不变
try:
    from paddleocr import PaddleOCR
except ImportError:
    from rapidocr_onnxruntime import RapidOCR as _Rapid

    class PaddleOCR:  # 兼容适配: 只实现本脚本用到的 .predict() 返回形态
        def __init__(self, *a, **kw):
            self._e = _Rapid()

        def predict(self, img):
            result, _ = self._e(img)
            result = result or []
            texts = [str(t).strip() for _, t, _s in result]
            polys = [b for b, _t, _s in result]
            yield {'rec_texts': texts, 'rec_polys': polys}
_ENGINE = None
def get_engine():
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = PaddleOCR(
            text_detection_model_name='PP-OCRv5_mobile_det',
            text_recognition_model_name='en_PP-OCRv5_mobile_rec',
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            enable_mkldnn=True,  # paddle 3.0.0 + mkldnn: 每图 3-5s; 关闭则 20s+
        )
    return _ENGINE

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

def _pts_of(poly):
    """paddlex 多边形 → [[x,y]...]; 兼容 4点/平铺/box 格式"""
    if poly is None:
        return []
    try:
        arr = [[float(p[0]), float(p[1])] for p in poly]
    except Exception:
        try:
            arr = [[float(poly[i]), float(poly[i + 1])] for i in range(0, len(poly), 2)]
        except Exception:
            return []
    if len(arr) == 4:
        return arr
    if len(arr) == 2:  # box 上下对角 → 补成四点
        return [arr[0], [arr[1][0], arr[0][1]], arr[1], [arr[0][0], arr[1][1]]]
    return arr

def recognize(engine, img):
    try:
        res = list(engine.predict(img))
    except Exception as e:
        return {'error': str(e)[:200]}
    items = []
    for r in res:
        if not isinstance(r, dict):
            continue
        texts = r.get('rec_texts') or []
        polys = (r.get('rec_polys') or r.get('dt_polys')) or r.get('rec_boxes') or []
        for i, t in enumerate(texts):
            if not t or not str(t).strip():
                continue
            pts = _pts_of(polys[i]) if i < len(polys) else []
            if not pts:
                continue
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
            items.append({'x': min(xs), 'x2': max(xs), 'y': min(ys), 'h': max(ys) - min(ys), 'text': str(t).strip()})
    if not items:
        return {'text': '', 'n': 0}
    r = _layout(items)
    items_all = list(items)
    # 照片竖长页: 三段带补读, 捡整页漏检区段(切割提分辨率) (2026-09-07)
    try:
        from PIL import Image as _Im
        _wi, _hi = _Im.open(img).size
        if _hi > _wi * 1.18 and _photo_like(img, _hi):
            items_all += _band_reads(engine, img, _hi)
    except Exception:
        pass
    supp = _supplement(r.get('text', ''), items_all)
    if supp:
        r['text'] = (r.get('text', '') + '\n\n' + '\n'.join(supp)).strip()
        r['body'] = (r.get('body') or []) + supp
    return r

def _supplement(text, items):
    """遗漏行补全(2026-09-07 23:5x): 版面规则可能滤掉的可读行, 原样补到文末。
    规则: >=8字符 且 字母>=6; 排除已含于正文的行; 允许 2 词以内的全大写标题行;
    纯碎片(字母<10 且 <=2词且非全大写)仍排除。重复可接受(用户要求内容不丢优先)。"""
    flat = re.sub(r'\s+', ' ', text.lower())
    out = []
    seen = set()
    for it in sorted(items, key=lambda t: (t['y'], t['x'])):
        t = it.get('text', '').strip()
        if not t or len(t) < 8:
            continue
        letters = sum(1 for ch in t if ch.isalpha())
        if letters < 6:
            continue
        probe = re.sub(r'\s+', ' ', t.lower())
        if probe in flat:
            continue
        words = t.split()
        if len(words) <= 2 and not t.isupper() and letters < 10:
            continue
        if probe in seen:
            continue
        seen.add(probe)
        out.append(t)
    return out


def _photo_like(img_path, h):
    """照片判定: 背景方差大(纸纹/阴影/光照不均)= 照片; 纯白均匀 = 扫描/渲染(跳过切割)"""
    try:
        from PIL import Image, ImageStat
        im = Image.open(img_path).convert('L')
        st = ImageStat.Stat(im)
        return st.stddev[0] > 20
    except Exception:
        return False

def _band_reads(engine, img_path, h):
    """竖长照片页: 按 上/中/下 三段裁带, 放大重识别, 返回 {y,text} 列表(捡整页漏检区)"""
    from PIL import Image
    try:
        im = Image.open(img_path)
        w, hh = im.size
        out = []
        for bi, (fr, to) in enumerate([(0.0, 0.34), (0.33, 0.67), (0.66, 1.0)]):
            y0 = int(hh * fr); y1 = max(y0 + 100, int(hh * to))
            band = im.crop((0, y0, w, y1))
            from PIL import ImageOps as _IO
            if _photo_like(img_path, hh):
                band = _IO.autocontrast(band, cutoff=1)
            bw, bh = band.size
            sc = min(2.2, 1700 / max(bw, bh))
            if sc > 1:
                band = band.resize((int(bw * sc), int(bh * sc)), Image.LANCZOS)
            fp = img_path + ('.band%d.jpg' % bi)
            band.save(fp, 'JPEG', quality=92)
            res = list(engine.predict(fp))
            for r_ in res:
                ts = r_.get('rec_texts') or []
                for k, t in enumerate(ts):
                    t = str(t).strip()
                    if not t:
                        continue
                    out.append({'y': y0 + k * 12, 'x': 0, 'text': t})
    except Exception as e:
        pass
    return out

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
    # 题号驱动重建 (v5 适配 2026-09-07: v5 det 大框常把多题并排合并进同一片段 → 按题号切分再逐题解析)
    qn = re.compile(r'(?<![\d.])(\d{1,2})\.\s*[A-D]\.')
    def opt_pairs(text):
        pairs = {}
        for m in re.finditer(r'(?<![A-Za-z])([A-D])\.\s*', text):
            L = m.group(1)
            tail = text[m.end():]
            nx = re.search(r'(?<![A-Za-z])([A-D])\.\s*', tail)
            w = tail[: nx.start()] if nx else tail
            w = re.sub(r'^\s*\d{1,2}\.\s*', '', w).strip()
            w = re.sub(r'\s{2,}', ' ', w).strip()
            if w and L not in pairs: pairs[L] = w
        return pairs
    questions = {}; order = []; cur = None; body = []; opt_max_y = 0
    def add_q(n, pairs, y):
        if n not in questions: questions[n] = {}; order.append(n)
        for L, w in pairs.items():
            if L in 'ABCD' and w and L not in questions[n]: questions[n][L] = w
    for f in frags:
        if f['kind'] == 'body':
            body.append((f['txt'], f['x'], f['y'])); continue
        txt = f['txt']
        starts = list(qn.finditer(txt))
        if starts:
            for si, m in enumerate(starts):
                n = int(m.group(1))
                end = starts[si + 1].start() if si + 1 < len(starts) else len(txt)
                chunk = txt[m.start():end]
                add_q(n, opt_pairs(chunk), f['y'])
                if f['y'] > opt_max_y: opt_max_y = f['y']
                cur = n
        elif cur is not None and txt:
            t2 = txt
            mo = re.match(r'^\s*([A-Za-z][A-Za-z\'\- ]*?)(?=\s+[A-D]\.|$)', t2)
            if mo:
                qq = questions.get(cur)
                if qq is not None:
                    missL = next((L for L in 'ABCD' if L not in qq), None)
                    if missL:
                        w0 = re.sub(r'\s{2,}', ' ', mo.group(1).strip())
                        if w0: qq[missL] = w0
                t2 = t2[mo.end():]
            add_q(cur, opt_pairs(t2), f['y'])
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
        # 2026-09-07: 不丢"选项上方孤立正文行"(≥30字全保留, 确定性); 旧≥2行链式规则导致顶部内容看视觉脸色
        keep_above = [b for b in above if len(b[0]) >= 30]
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
    engine = get_engine()  # 启动即预载(冷启动 ~20-40s, 之后每图 1-3s); 配 server.js ocrFast 超时 90s
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
            print(json.dumps({'id': 0, 'error': str(e)[:200]}, ensure_ascii=False), flush=True)

if __name__ == '__main__':
    if len(sys.argv) > 1:
        engine = get_engine()
        src = sys.argv[1]
        out = src + '.norm.jpg'
        prep_img(src, out)
        print(json.dumps(recognize(engine, out), ensure_ascii=False))
    else:
        serve()
