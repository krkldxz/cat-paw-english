import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根

# CEFR 词表 CSV → 词书 JSON (Cambridge EVP 风格数据)
# 结构: 按 headword 聚合, 存 min/max 级别 + 各词性条目 → 支撑熟词僻义检测
import csv, json, sys
sys.stdout.reconfigure(encoding='utf-8')

SRC = os.path.join(ROOT, r'data\cefr_raw.csv')
OUT = os.path.join(ROOT, r'data\词书-CEFR.json')

LVL = {'A1': 1, 'A2': 2, 'B1': 3, 'B2': 4, 'C1': 5, 'C2': 6}

words = {}  # headword.lower() -> {word, entries:[{pos,level}], min, max}
with open(SRC, encoding='utf-8-sig') as f:
    rd = csv.reader(f, delimiter=';')
    header = next(rd, None)
    for row in rd:
        if len(row) < 3:
            continue
        head, pos, lvl = row[0].strip(), row[1].strip(), row[2].strip().upper()
        if not head or not lvl or lvl not in LVL:
            continue
        key = head.lower()
        rec = words.setdefault(key, {'word': head, 'entries': [], 'minLevel': 'C2', 'maxLevel': 'A1'})
        rec['entries'].append({'pos': pos, 'level': lvl})
        if LVL[lvl] < LVL[rec['minLevel']]:
            rec['minLevel'] = lvl
        if LVL[lvl] > LVL[rec['maxLevel']]:
            rec['maxLevel'] = lvl

book = {
    'name': 'CEFR 分级词表 (Cambridge EVP 风格, Words-CEFR-Dataset)',
    'type': 'cefr',
    'source': 'https://github.com/Maximax67/Words-CEFR-Dataset (2026-09-03)',
    'word_count': len(words),
    'words': list(words.values())
}
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(book, f, ensure_ascii=False, indent=1)

print(f'完成: {len(words)} 个词头')
# 级别分布
from collections import Counter
dist = Counter(w['maxLevel'] for w in book['words'])
print('按 maxLevel 分布:', dict(dist))
for w in ['record', 'abandon', 'ability', 'about', 'zoo']:
    r = words.get(w)
    print(w, '→', {e['pos']: e['level'] for e in r['entries']} if r else '不在表内')
