# 上海高考词汇手册 PDF → 词书 JSON (v2: 不依赖每页表头)
import pymupdf, json, re, sys
sys.stdout.reconfigure(encoding='utf-8')

SRC = r'C:\Users\krkld\.openclaw\projects\english-study\data\上海高考词汇手册.pdf'
OUT = r'C:\Users\krkld\.openclaw\projects\english-study\data\词书-上海高考.json'

doc = pymupdf.open(SRC)
words, phrases = [], []
section = None
p_seen = set()

for pi in range(doc.page_count):
    text = doc[pi].get_text()
    if '词汇手册默写词组' in text:
        section = 'phrase'
    m = re.search(r'P\s*(\d+)\s*-\s*(\d+)', text)
    if m:
        section = 'word'
        print(f'第{pi+1}页: 单词段 P{m.group(1)}-{m.group(2)}')
    if not section:
        continue
    tabs = doc[pi].find_tables()
    if not tabs.tables:
        continue
    for tb in tabs.tables:
        rows = tb.extract()
        if not rows:
            continue
        for r in rows:
            if len(r) < 4:
                continue
            idx = str(r[0] or '').strip()
            col1 = str(r[1] or '').strip()
            meaning = str(r[3] or '').strip()
            # 数据行特征: 序号是纯数字, 内容列非空且非表头
            if not re.fullmatch(r'\d+', idx):
                continue
            if not col1 or not meaning:
                continue
            if section == 'word' and col1.lower() in ('单词',):
                continue
            if section == 'phrase' and col1.lower() in ('词组',):
                continue
            if section == 'word':
                key = (idx, col1)
                if key not in p_seen:
                    p_seen.add(key)
                    words.append({'word': col1, 'meaning': meaning})
            else:
                phrases.append({'phrase': col1, 'meaning': meaning})

# 词组去重
seen_p, phrases_u = set(), []
for it in phrases:
    k = it['phrase'].lower()
    if k not in seen_p:
        seen_p.add(k)
        phrases_u.append(it)

book = {
    'name': '上海高考英语词汇手册(考纲背默版)',
    'region': '上海',
    'level': '高考',
    'source': '用户提供 PDF (2026-09-03)',
    'word_count': len(words),
    'phrase_count': len(phrases_u),
    'words': words,
    'phrases': phrases_u
}
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(book, f, ensure_ascii=False, indent=1)
print(f'\n完成: 单词 {len(words)} 个, 词组 {len(phrases_u)} 条')
print('首词:', words[0] if words else None, '| 末词:', words[-1] if words else None)
