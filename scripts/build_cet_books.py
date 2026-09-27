# 聚合四六级词书: moread 词表(主) LEFT JOIN ECDICT(音标/释义/词性/词频标签)
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

def build(list_file, out_file, name, level):
    src = json.load(io.open(list_file, encoding='utf-8'))
    words = src['words']
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
        tags = [t for t in str(tag or '').split() if t in ('gk', 'cet4', 'cet6', 'ky', 'toefl', 'ielts', 'gre')]
        it = {'word': wl.lower(), 'phonetic': str(phon or '').strip(), 'pos': p,
              'meaning': meaning, 'exam_tags': tags}
        try:
            it['frq'] = int(frq or 0)
        except Exception:
            pass
        items.append(it)
    db.close()
    hit = len(words) - len(misses)
    book = {
        'name': name,
        'region': '四六级', 'level': level,
        'source': 'moread-content 词表 + ECDICT 1.0.28 聚合 (2026-09-09)',
        'word_count': len(items), 'phrase_count': 0,
        'join_hit': hit, 'join_miss': len(misses),
        'words': items, 'phrases': []
    }
    io.open(out_file, 'w', encoding='utf-8').write(json.dumps(book, ensure_ascii=False))
    print(name, 'total', len(items), 'hit', hit, 'miss', len(misses))
    if misses:
        print('  misses:', misses[:30])
    # 空释义统计
    empty = [it['word'] for it in items if not it['meaning']]
    print('  empty meaning:', len(empty), empty[:15])

if __name__ == '__main__':
    build(ROOT + r'\data\raw\cet4.json', ROOT + r'\data\词书-CET4.json', '大学英语四级词汇 (CET-4)', 'CET4')
    build(ROOT + r'\data\raw\cet6.json', ROOT + r'\data\词书-CET6.json', '大学英语六级词汇 (CET-6)', 'CET6')
    print('DONE')
