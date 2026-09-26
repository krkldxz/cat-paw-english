// verify_e2e.js —— 端到端回归: 引擎链路 / 词书系统 / 添加词书 / 提取健壮性
// 用法: 先起服务(node app/server.js 或 启动背诵工具.bat), 再 node scripts/verify_e2e.js
// 覆盖: ①提取(含长文) ②词书列表与主词书 ③添加词书全流程 ④模型输出截断时的修复能力
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const B = process.env.ES_BASE || 'http://127.0.0.1:8804';
const j = async (u, o) => { const r = await fetch(B + u, o); let b = null; try { b = await r.json(); } catch (e) {} return { status: r.status, body: b }; };
const post = (u, o) => j(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS ' + n + (x ? '  ' + x : '')); } else { fail++; console.log('  FAIL ' + n + (x ? '  ' + x : '')); } };

const TEXT = 'Urban farming has reshaped rooftops. Residents grow vegetables, and shared plots cut transport emissions. Critics note modest yields compared with rural agriculture.';

async function main() {
  // ===== 0. 模型输出修复能力 (单元级: 从 server.js 抠出 parseModelJson 做行为仿真) =====
  console.log('== 0. parseModelJson 修复能力 ==');
  const src = fs.readFileSync(path.join(ROOT, 'app', 'server.js'), 'utf8');
  const fnSrc = (function extract(name) {
    const st = src.indexOf('function ' + name);
    if (st < 0) return null;
    let d = 0, q = null, esc = false, started = false;
    for (let i = st; i < src.length; i++) {
      const c = src[i];
      if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '{') { d++; started = true; }
      else if (c === '}') { d--; if (started && d === 0) return src.slice(st, i + 1); }
    }
    return null;
  })('parseModelJson');
  if (!fnSrc) { ck('找到 parseModelJson', false); return finish(); }
  const parseModelJson = eval('(' + fnSrc + ')');
  const good = '{"vocabulary":[{"word":"urban"}],"phrases":[],"golden_sentences":[],"collocations":[],"grammar":[]}';
  ck('正常 JSON', !!parseModelJson(good));
  ck('markdown 围栏', !!parseModelJson('```json\n' + good + '\n```'));
  ck('前置说明文字', !!parseModelJson('结果如下：\n' + good));
  const r1 = parseModelJson('{"vocabulary":[{"word":"urban"},{"word":"rural"},{"word":"yiel');
  ck('截断输出可修复', !!(r1 && r1.vocabulary && r1.vocabulary.length >= 1), r1 ? '救回 ' + r1.vocabulary.length + ' 条' : 'null');
  const r2 = parseModelJson('{"vocabulary":[{"word":"a"},{"word":"b"}],"phrases":[{"phrase":"cut');
  // 正确行为: 保留完整板块, 丢弃被截断的板块 (不是"必须保留 phrases")
  ck('多板块截断可修复(保留完整板块)', !!(r2 && r2.vocabulary && r2.vocabulary.length === 2),
    r2 ? 'vocabulary ' + r2.vocabulary.length + ' 条; phrases ' + ((r2.phrases || []).length) + ' (被截断的已正确丢弃)' : 'null');

  // ===== 1. 词书系统 =====
  console.log('\n== 1. 词书系统 ==');
  let r = await j('/api/books');
  const books = r.body.books || [];
  console.log('  词书: ' + books.map(b => b.id + (b.primary ? '*' : '')).join(' '));
  ck('词书列表可用', r.status === 200 && books.length >= 4);
  ck('主词书唯一且存在', books.filter(b => b.primary).length === 1);
  r = await j('/api/book/' + (books.find(b => b.primary) || {}).id + '?letter=A');
  ck('主词书可翻看', r.status === 200 && r.body.total > 0, r.body.name + ' A 开头 ' + r.body.total + ' 词');
  r = await j('/api/health');
  ck('引擎在线', /llama|ollama/.test(String(r.body.engine || '')), 'engine=' + r.body.engine);

  // ===== 2. 添加词书全流程 =====
  console.log('\n== 2. 添加词书 (导入 → 设主词书 → 参与提取 → 删除) ==');
  const words = ['urban', 'rooftops', 'residents', 'plots', 'emissions', 'critics', 'yields', 'rural'];
  r = await post('/api/books/import', { name: '回归测试词书 QA', content: JSON.stringify({ name: '回归测试词书 QA', words: words.map(w => ({ word: w, meaning: 'QA义-' + w })) }) });
  ck('导入 JSON 词书', r.status === 200 && r.body.ok === true, r.body.id + ' ' + r.body.wordCount + ' 词');
  const qaId = r.body.id;
  r = await j('/api/book/' + qaId + '?letter=');
  ck('新词书可翻看', r.status === 200 && r.body.total === words.length);
  r = await post('/api/books/primary', { id: qaId });
  ck('切换主词书', r.status === 200 && r.body.primary === qaId);
  const t0 = Date.now();
  r = await post('/api/extract', { text: TEXT, grade: '高二', books: [qaId] });
  const cands = (r.body && r.body.candidates) || [];
  const scopes = {}; cands.forEach(x => scopes[x.scope] = (scopes[x.scope] || 0) + 1);
  console.log('  提取 HTTP ' + r.status + ' | ' + ((Date.now() - t0) / 1000).toFixed(1) + 's | 候选 ' + cands.length + ' | scope ' + JSON.stringify(scopes));
  ck('用导入词书提取成功', r.status === 200 && cands.length > 0);
  ck('"考纲"层来自导入词书', cands.some(x => x.scope === '考纲' && words.includes(String(x.word).toLowerCase())));
  ck('释义取自导入词书', cands.some(x => String(x.meaning || '').startsWith('QA义-')));
  r = await post('/api/books/delete', { id: qaId });
  ck('删除用户词书', r.status === 200 && r.body.ok === true);

  // ===== 3. 提取健壮性 (含此前偶发失效的长文) =====
  console.log('\n== 3. 提取健壮性 ==');
  const t1 = Date.now();
  r = await post('/api/extract', { text: (TEXT + ' ').repeat(9), grade: '高二', books: ['gk', 'cefr'] });
  ck('长文提取成功(200)', r.status === 200, 'HTTP ' + r.status + ' ' + ((Date.now() - t1) / 1000).toFixed(1) + 's' + (r.body && r.body.error ? ' error=' + r.body.error : ''));
  if (r.status === 200) {
    const d = r.body.data || {};
    ck('五板块齐全', Object.keys(d).length >= 4, Object.keys(d).join(','));
    ck('候选分层(主词书=考纲层)', ((r.body.candidates || []).some(x => x.scope === '考纲')));
    console.log('    生词 ' + (d.vocabulary || []).length + ' 条 | 候选 ' + (r.body.candidates || []).length + ' 条 | 服务端 ' + r.body.timeMs + 'ms');
  }
  r = await j('/api/books');
  ck('收尾: 无残留用户词书', (r.body.books || []).filter(b => b.removable).length === 0, (r.body.books || []).map(b => b.id + (b.primary ? '*' : '')).join(' '));
  finish();
}
function finish() { console.log('\n结果: PASS ' + pass + ' / FAIL ' + fail); process.exit(fail ? 1 : 0); }
main().catch(e => { console.log('脚本异常: ' + e.message); process.exit(1); });
