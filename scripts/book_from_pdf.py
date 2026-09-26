# book_from_pdf.py —— 从 PDF 词汇手册抽取词表 (供「添加词书」使用)
# 用法: python book_from_pdf.py <file.pdf> [--max 20000] [--out result.json]
# 输出: --out 时把 JSON 写入该文件(推荐, 不受库噪声干扰), stdout 只回 OK
#       无 --out 时打印 JSON 到 stdout
# 结果形态: {"type":"ok","words":[{word,meaning,phonetic}],"stats":{...}}
#          {"type":"scan","pages":N}   扫描版(无文字层)
#          {"type":"empty","reason":"..."}
# 注: pymupdf 的 find_tables 会往 stdout 打提示(且可能是 UTF-16), 故全程把 stdout 转走
import sys, os, io, re, json

def has_cjk(s):
    return bool(re.search(r'[\u4e00-\u9fff]', s or ''))

POS = r'(?:n|v|vt|vi|adj|adv|prep|conj|pron|art|num|int|aux|abbr|phr)\.'
WORD_RE = re.compile(r"^([A-Za-z][A-Za-z'\-]{0,28}(?:\s+[A-Za-z'\-]{1,20}){0,2})$")
PHON_RE = re.compile(r"[\[/]([^\]/]{2,40})[\]/]")

def norm_word(w):
    return re.sub(r'\s+', ' ', (w or '').strip())

def parse_line(line):
    s = (line or '').strip()
    if not s or len(s) < 2:
        return None
    if re.fullmatch(r'[Pp]\s*\d+([\-\s]*\d+)?', s) or re.fullmatch(r'\d+', s):
        return None
    if re.match(r'^(第\s*\d+\s*[页单元课版]|Unit\s*\d+|Section\s*\d+)', s, re.I) and len(s) < 20:
        return None
    m = re.match(r"^([A-Za-z][A-Za-z'\-]*(?:\s+[A-Za-z'\-]+){0,2})\s*(.*)$", s)
    if not m:
        return None
    word, rest = norm_word(m.group(1)), (m.group(2) or '').strip()
    ph = ''
    pm = PHON_RE.search(rest[:60])
    if pm:
        ph = pm.group(1).strip()
        rest = (rest[:pm.start()] + rest[pm.end():]).strip()
    rest = re.sub(r'^[\s,;:.\-—–]+', '', rest)
    if not word or not WORD_RE.match(word):
        return None
    if not rest:
        return None
    if has_cjk(rest) or re.match(r'^' + POS, rest):
        return {'word': word, 'meaning': rest[:120], 'phonetic': ph}
    return None

def from_tables(doc):
    out, pages_with_tables = [], 0
    for page in doc:
        try:
            tabs = page.find_tables()
        except Exception:
            continue
        if not tabs or not getattr(tabs, 'tables', None):
            continue
        pages_with_tables += 1
        for t in tabs.tables:
            try:
                rows = t.extract()
            except Exception:
                continue
            for row in rows or []:
                cells = [norm_word(c) for c in (row or []) if c]
                if not cells:
                    continue
                wcell, mcell = '', ''
                for c in cells:
                    if not wcell and WORD_RE.match(c) and len(c) <= 40 and not has_cjk(c):
                        wcell = c
                    elif has_cjk(c) and len(c) > len(mcell):
                        mcell = c
                if wcell and mcell:
                    out.append({'word': wcell, 'meaning': mcell[:120], 'phonetic': ''})
    return out, pages_with_tables

def from_lines(doc):
    out = []
    for page in doc:
        for line in (page.get_text() or '').splitlines():
            r = parse_line(line)
            if r:
                out.append(r)
    return out

def main():
    args = sys.argv[1:]
    if not args:
        print(json.dumps({'type': 'empty', 'reason': '未提供文件'}))
        return
    src = args[0]
    cap, out_path = 20000, None
    for i, a in enumerate(args):
        if a == '--max' and i + 1 < len(args):
            cap = int(args[i + 1])
        if a == '--out' and i + 1 < len(args):
            out_path = args[i + 1]

    # 库噪声(pymupdf 提示等)可能写 stdout 且是 UTF-16 → 全程转移
    real_stdout = sys.stdout
    sys.stdout = io.StringIO()
    result = None
    try:
        try:
            import pymupdf
        except Exception as e:
            result = {'type': 'empty', 'reason': 'pymupdf 不可用: ' + str(e)}
        if result is None:
            try:
                doc = pymupdf.open(src)
            except Exception as e:
                result = {'type': 'empty', 'reason': 'PDF 打不开: ' + str(e)}
        if result is None:
            pages = doc.page_count
            total_chars = sum(len(p.get_text() or '') for p in doc)
            if total_chars < 100 * max(1, pages) * 0.2:
                result = {'type': 'scan', 'pages': pages}
            else:
                tw, tpages = from_tables(doc)
                lw = from_lines(doc)
                use_tables = len(tw) >= 50 or len(tw) > len(lw)
                words = tw if use_tables else lw
                seen, final = set(), []
                for w in words:
                    k = w['word'].lower()
                    if k in seen:
                        continue
                    seen.add(k)
                    final.append(w)
                    if len(final) >= cap:
                        break
                if not final:
                    result = {'type': 'empty', 'reason': '未解析出词条(表格结构特殊或无文字层)', 'pages': pages}
                else:
                    result = {
                        'type': 'ok', 'words': final,
                        'stats': {'pages': pages, 'pagesWithTables': tpages, 'tableWords': len(tw),
                                  'lineWords': len(lw), 'used': 'tables' if use_tables else 'lines', 'count': len(final)},
                    }
    except Exception as e:
        result = {'type': 'empty', 'reason': '解析异常: ' + str(e)}
    finally:
        sys.stdout = real_stdout

    payload = json.dumps(result, ensure_ascii=False)
    if out_path:
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(payload)
        print('OK')
    else:
        print(payload)

if __name__ == '__main__':
    main()
