// verify_books.js —— 词书系统端到端验证 (添加词书 / 切换主词书 / 浏览 / 删除)
const B = 'http://127.0.0.1:8804';
const j = async (u, o) => {
  const r = await fetch(B + u, o);
  let body = null;
  try { body = await r.json(); } catch (e) {}
  return { status: r.status, body };
};
const post = (u, obj) => j(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
let pass = 0, fail = 0;
function ck(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}

(async () => {
  console.log('== 1. 词书列表 ==');
  let r = await j('/api/books');
  const ids = (r.body.books || []).map(b => b.id + (b.primary ? '*' : ''));
  console.log('  ' + ids.join('  '), '| primary =', r.body.primary);
  ck('接口 200', r.status === 200);
  ck('内置 4 本都在', ['sh', 'cefr', 'cet4', 'cet6'].every(x => (r.body.books || []).some(b => b.id === x)));
  ck('新词书 gk/zk 被发现', (r.body.books || []).some(b => b.id === 'gk') && (r.body.books || []).some(b => b.id === 'zk'),
    '(' + (r.body.books || []).filter(b => ['gk', 'zk'].includes(b.id)).map(b => b.id + ':' + b.wordCount).join(', ') + ')');
  ck('返回 primary 字段', !!r.body.primary);

  console.log('== 2. 新词书可浏览 ==');
  r = await j('/api/book/gk?letter=A');
  console.log('  name =', r.body.name, '| A 开头', r.body.total, '词 |', (r.body.items || []).slice(0, 2).map(i => i.word + '=' + String(i.meaning || '').slice(0, 12)).join(' / '));
  ck('gk 可翻看', r.status === 200 && r.body.total > 0);

  console.log('== 3. 切换主词书 ==');
  r = await post('/api/books/primary', { id: 'gk' });
  ck('切到 gk 成功', r.status === 200 && r.body.primary === 'gk', JSON.stringify(r.body));
  r = await j('/api/books');
  ck('列表 primary 反映切换', r.body.primary === 'gk' && (r.body.books || []).filter(b => b.primary).length === 1);
  ck('可删标记只给用户词书', (r.body.books || []).filter(b => b.removable).length === 0);
  let st = null;
  try { st = JSON.parse(require('fs').readFileSync('C:\\Users\\krkld\\.openclaw\\projects\\english-study\\data\\settings.json', 'utf8')); } catch (e) {}
  ck('settings.json 落盘', !!st && st.primaryBook === 'gk', JSON.stringify(st));

  console.log('== 4. 添加词书 (纯文本词表) ==');
  r = await post('/api/books/import', { name: '测试词表 alpha', content: 'apple\t苹果\nbanana  香蕉\ncherry:樱桃\nzebra\n\n#notaword\norange\t橙子\n' });
  console.log('  import ->', r.status, r.body.id, r.body.wordCount, r.body.error || '');
  ck('导入成功', r.status === 200 && r.body.ok === true);
  ck('识别 5 词(滤掉非法行)', r.body.wordCount === 5, '实际 ' + r.body.wordCount);
  const newId = r.body.id;
  r = await j('/api/books');
  const ub = (r.body.books || []).filter(b => b.removable);
  ck('新词书进列表且可删', ub.length === 1 && ub[0].id === newId, ub.map(b => b.id + ':' + b.wordCount).join(','));
  r = await j('/api/book/' + encodeURIComponent(newId));
  ck('新词书可浏览+带释义', r.status === 200 && r.body.total === 5 && String((r.body.items || [])[0].meaning || '').length > 0,
    JSON.stringify((r.body.items || []).slice(0, 2)));
  r = await post('/api/books/import', { name: '内置冲突名测试', id: 'sh', content: 'word one\nword two\n' });
  ck('拒绝与内置 id 冲突', r.status === 400, r.body.error || '');

  console.log('== 5. 导入 JSON 词书 ==');
  const jsonBook = JSON.stringify({ name: 'JSON 测试书', words: [{ word: 'kelp', meaning: '海带', phonetic: 'kelp' }, { word: 'otter', meaning: '水獭' }], phrases: [] });
  r = await post('/api/books/import', { name: 'JSON 测试书', content: jsonBook });
  ck('JSON 导入成功', r.status === 200 && r.body.wordCount === 2, r.body.id + ' ' + (r.body.error || ''));

  console.log('== 6. 删除用户词书 ==');
  r = await post('/api/books/delete', { id: newId });
  ck('删除成功', r.status === 200 && r.body.ok === true, r.body.error || '');
  r = await post('/api/books/delete', { id: 'sh' });
  ck('内置词书拒绝删除', r.status === 400, r.body.error || '');
  r = await j('/api/books');
  ck('删除后列表恢复', (r.body.books || []).filter(b => b.removable).length === 1);

  console.log('== 7. 健康接口词书摘要 ==');
  r = await j('/api/health');
  console.log('  engine =', r.body.engine, '| primary =', r.body.primary, '| books =', JSON.stringify(r.body.books));

  console.log('== 8. 提取链路 (需引擎在线) ==');
  if (r.body.engine && r.body.engine !== '无') {
    const rr = await fetch(B + '/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'The rapid expansion of urban agriculture has transformed many cities. Residents now grow vegetables on rooftops, which reduces transport emissions and strengthens community ties.', grade: '高二', books: ['gk', 'cefr'] }) });
    const payload = await rr.json();
    const scopes = {};
    for (const c of (payload.candidates || [])) scopes[c.scope] = (scopes[c.scope] || 0) + 1;
    console.log('  候选', (payload.candidates || []).length, '| scope 分布', JSON.stringify(scopes), '| books', JSON.stringify(payload.books), '| 耗时', payload.timeMs + 'ms');
    ck('主词书(gk)产出"考纲"层', (scopes['考纲'] || 0) > 0);
    ck('副词书 CEFR 独立成层', Object.keys(scopes).some(k => k === 'CEFR'));
  } else {
    console.log('  SKIP (引擎未启动, 该链路需 llama-server)');
  }

  console.log('== 9. 主词书还原为 sh ==');
  r = await post('/api/books/primary', { id: 'sh' });
  ck('还原成功', r.body.primary === 'sh');

  console.log('\n结果: PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})();
