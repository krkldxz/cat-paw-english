# 聚合高考/中考词书: moread-content 词表(主, MIT) LEFT JOIN ECDICT(音标/释义/词性/词频标签, MIT)
# 用途: 替代版权不明的官方考纲词书作为默认词书 —— 两份来源均为 MIT, 可随仓库分发
# 来源: tealun/moread-content vocabulary/exam/gaokao.json (3837 词) / zhongkao.json
# 交叉校验: 与 ECDICT 自带 gk/zk 考试标签比对重合率
import json, io, sqlite3, re, sys, unicodedata

def deaccent(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')

ROOT = ROOT
DB = ROOT + r'\data\raw\ecdict\stardict.db'

def clean_translation(t):
    """ECDICT translation: 'vt. 放弃, 抛弃\nn. 放任' — 去 [经]/[计] 等专业域行, 压成短释义"""
    lines = [l.strip() for l in re.split(r'[\r\n]+', str(t or '')) if l.strip()]
    keep = [l for l in lines if not re.match(r'^\[[^\]]*\]', l)]
    if not keep:
        keep = lines
    return '\n'.join(keep)

def pos_from_translation(t):
    pos = re.findall(r'^([a-z]+)\.', str(t or '').replace('\r', '\n'), re.M)
    seen = []
    for p in pos:
        if p not in seen:
            seen.append(p)
    return '/'.join(seen)

def norm_words(raw):
    """兼容两种形态: ["abandon", ...] 或 [{"word": "abandon", ...}, ...]"""
    out = []
    for w in raw:
        if isinstance(w, str):
            out.append(w)
        elif isinstance(w, dict):
            v = w.get('word') or w.get('headword') or w.get('text')
            if v:
                out.append(v)
    return out

def ecdict_tag_set(cur, tag):
    s = set()
    for (w,) in cur.execute("select word from stardict where tag like ?", ('%' + tag + '%',)):
        s.add(str(w).lower())
    return s

def build(list_file, out_file, name, level, xcheck_tag):
    src = json.load(io.open(list_file, encoding='utf-8'))
    words = norm_words(src['words'])
    db = sqlite3.connect(DB)
    cur = db.cursor()
    items, misses = [], []
    for w in words:
        wl = str(w).strip()
        row = cur.execute(
            'select phonetic,translation,pos,collins,oxford,tag,bnc,frq from stardict where word=? collate nocase',
            (wl,)).fetchone()
        if row is None and deaccent(wl) != wl:
            row = cur.execute(
                'select phonetic,translation,pos,collins,oxford,tag,bnc,frq from stardict where word=? collate nocase',
                (deaccent(wl),)).fetchone()
        if row is None:
            misses.append(wl)
            items.append({'word': wl.lower(), 'phonetic': '', 'pos': '', 'meaning': ''})
            continue
        phon, trans, pos, collins, oxford, tag, bnc, frq = row
        meaning = clean_translation(trans)
        p = pos_from_translation(trans) or (str(pos or '').replace(':', '/'))
        tags = [t for t in str(tag or '').split() if t in ('zk', 'gk', 'cet4', 'cet6', 'ky', 'toefl', 'ielts', 'gre')]
        it = {'word': wl.lower(), 'phonetic': str(phon or '').strip(), 'pos': p,
              'meaning': meaning, 'exam_tags': tags}
        try:
            it['frq'] = int(frq or 0)
        except Exception:
            pass
        items.append(it)

    # 与 ECDICT 自带考试标签交叉校验
    ref = ecdict_tag_set(cur, xcheck_tag)
    book_set = set(it['word'] for it in items)
    inter = book_set & ref
    db.close()

    hit = len(words) - len(misses)
    book = {
        'name': name,
        'region': '全国',
        'level': level,
        'source': 'tealun/moread-content vocabulary/exam/' + list_file.rsplit('\\', 1)[-1] + ' (MIT) + ECDICT 1.0.28 (MIT) 聚合',
        'license': 'MIT (moread-content) + MIT (ECDICT) — 可随仓库分发, 保留版权声明',
        'word_count': len(items), 'phrase_count': 0,
        'join_hit': hit, 'join_miss': len(misses),
        'words': items, 'phrases': []
    }
    io.open(out_file, 'w', encoding='utf-8').write(json.dumps(book, ensure_ascii=False))
    print('=' * 60)
    print(name, '| total', len(items), '| join hit', hit, '| miss', len(misses))
    print(f'  交叉校验 (ECDICT {xcheck_tag} 标签 {len(ref)} 词): 重合 {len(inter)} -> 覆盖率 {len(inter)*100.0/max(1,len(book_set)):.1f}%')
    if misses:
        print('  misses:', misses[:30])
    empty = [it['word'] for it in items if not it['meaning']]
    print('  空释义:', len(empty), empty[:15])

if __name__ == '__main__':
    build(ROOT + r'\data\raw\gaokao.json', ROOT + r'\data\词书-高考.json', '高考英语核心词表 (全国)', 'GK', 'gk')
    build(ROOT + r'\data\raw\zhongkao.json', ROOT + r'\data\词书-中考.json', '中考英语核心词表 (全国)', 'ZK', 'zk')
    print('DONE')
