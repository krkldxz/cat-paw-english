// CEFR 词书批量补中文释义 v2: 断点续跑 + 容错解析 + 多轮重试
const fs = require('fs');
const path = require('path');
const PATH = path.join(__dirname, '..', 'data', '词书-CEFR.json');
const ENGINE = 'http://127.0.0.1:8080/v1/chat/completions';
const BATCH = 50, MAX_PASS = 4;
const book = JSON.parse(fs.readFileSync(PATH, 'utf8'));
const words = book.words;

const sys = '你是词典编纂助手。给每个英语单词给出最常用中文释义（简短），只输出一个 JSON 对象 {"单词": "中文释义"}，不要 markdown 代码块，不要任何其他文字。';
async function callLLM(wordList) {
  const r = await fetch(ENGINE, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gemma', stream: false, max_tokens: 6000, temperature: 0.1,
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: '给以下单词中文释义：\n' + wordList.join('\n') }] })
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  let content = (d.choices?.[0]?.message?.content || '').trim();
  content = content.replace(/```json/gi, '').replace(/```/g, '').trim();
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('无JSON');
  return JSON.parse(m[0]);
}

(async () => {
  const t0 = Date.now();
  for (let pass = 1; pass <= MAX_PASS; pass++) {
    const todo = words.filter(w => !w.meaning);
    if (!todo.length) break;
    console.log(`=== 第 ${pass} 轮: 待补 ${todo.length} 词 ===`);
    let ok = 0;
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const list = batch.map(w => w.word);
      try {
        const map = await callLLM(list);
        for (const w of batch) {
          const val = map[w.word.toLowerCase()] || map[w.word];
          if (val && typeof val === 'string' && val.trim()) { w.meaning = val.trim().slice(0, 60); ok++; }
        }
      } catch (e) { /* 留到下一轮 */ }
      if (ok % 200 < BATCH) {
        fs.writeFileSync(PATH, JSON.stringify(book, null, 1), 'utf8');
        console.log(`  进度 ${ok}/${todo.length} (本轮) | 总成功 ${words.filter(x => x.meaning).length}`);
      }
    }
    fs.writeFileSync(PATH, JSON.stringify(book, null, 1), 'utf8');
    console.log(`第 ${pass} 轮完成, 本轮成功 ${ok}`);
  }
  const done = words.filter(w => w.meaning).length;
  console.log(`最终: ${done}/${words.length} 有释义 | 耗时 ${((Date.now() - t0) / 60000).toFixed(1)}min`);
  process.exit(0);
})().catch(e => { console.error('致命:', e.message); process.exit(1); });
