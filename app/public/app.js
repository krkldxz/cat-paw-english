// 英语背诵工具 - 前端 v5 (候选自评 + 三连折叠 + 文中义标注 + 词书浏览器)
const $ = s => document.querySelector(s);
const textInput = $('#textInput');
const btn = $('#extractBtn');
const status = $('#status');
const result = $('#result');

const CARD_MAP = {
  phrases: { title: '词组', empty: '未发现词组' },
  sentences: { title: '作文金句', empty: '未发现值得背诵的句子' },
  collocs: { title: '搭配', empty: '未发现搭配' },
  grammar: { title: '语法', empty: '未发现语法点' }
};

function showStatus(msg, isError) {
  var m = String(msg); var ic = '';
  var mm = m.match(/^(\u2705|\u274c|\u26a0\ufe0f|\u26a0|\u23f3|\ud83d\udcc5|\ud83c\udf89)[ \t]*/);
  if (mm) {
    var map = { '\u2705': 'circle-check', '\u274c': 'x-circle', '\u26a0': 'alert-triangle', '\u23f3': 'hourglass', '\ud83d\udcc5': 'calendar', '\ud83c\udf89': 'party-popper' };
    ic = icon(map[mm[1].replace(/\uFE0F/g, '')] || 'info') + ' ';
    m = m.slice(mm[0].length);
  }
  var trust = '';
  var svgEnd = m.indexOf('</svg>');
  if (m.indexOf('<svg') === 0 && svgEnd > 0) { trust = m.slice(0, svgEnd + 6); m = m.slice(svgEnd + 6).replace(/^[\s]+/, ''); }
  status.innerHTML = ic + trust + esc(m);
  status.className = 'status' + (isError ? ' error' : '');
}

let lastData = null, lastExtras = null, cands = [], candState = {}, foldOpen = false;
let showExt = true;
const kw = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// ========== 学习记忆层 (掌握三分: 未遇见/掌握中/已掌握) ==========
const MEM_KEY = 'es_mem_v1';
function getMem() {
  let m = {};
  try { m = JSON.parse(localStorage.getItem(MEM_KEY) || '{}'); } catch (e) { m = {}; }
  // 迁移旧 es_streak (连续认识>=3 视为已掌握)
  try {
    const old = JSON.parse(localStorage.getItem('es_streak') || '{}');
    if (Object.keys(old).length) {
      for (const k in old) if (old[k] >= 3) { const r = m[k] || { st: 0, err: 0, master: false, seen: false }; r.master = true; r.seen = true; r.st = Math.max(r.st, old[k]); m[k] = r; }
      localStorage.removeItem('es_streak');
    }
  } catch (e) {}
  return m;
}
function saveMem(m) { localStorage.setItem(MEM_KEY, JSON.stringify(m)); }
function memRec(word) { return getMem()[kw(word)] || null; }

// ===== SM-2 间隔算法 (SuperMemo, Anki 同源) =====
function todayStr() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
function addDays(dateStr, days) { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + days); const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
// 质量 q: 5=perfect 4=good 1=again; 成功(q>=3)走间隔增长, 失败重置
function sm2Update(rec, q) {
  if (rec.ef == null) rec.ef = 2.5;
  if (rec.rep == null) rec.rep = 0;
  if (rec.ivl == null) rec.ivl = 0;
  if (q >= 3) {
    if (rec.rep === 0) rec.ivl = 1;
    else if (rec.rep === 1) rec.ivl = 6;
    else rec.ivl = Math.max(1, Math.round(rec.ivl * rec.ef));
    rec.rep++;
  } else {
    rec.rep = 0; rec.ivl = 0;
  }
  rec.ef = Math.max(1.3, rec.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  rec.due = q >= 3 ? addDays(todayStr(), rec.ivl) : todayStr(); // 失败明天必现
  return rec;
}
function isDue(rec) { return !!(rec && rec.due && rec.due <= todayStr()); }
// 状态: master=已掌握(✅) learning=在错题本/学习池(🔶) new=未遇见/已移除
function memState(word) { const r = memRec(word); if (!r) return 'new'; return r.master ? 'master' : (r.seen ? 'learning' : 'new'); }
// 迁移 v1→v2: 仅被"认识"碰过(无错误/无复习轨迹/未入池)的词 → 出池
function migrateMemV2() {
  if (localStorage.getItem('es_mem_v2_ok')) return;
  const m = getMem(); let changed = false;
  for (const k in m) {
    const r = m[k];
    if (!r.master && r.seen && !r.err && !r.rep && !r.due) { r.seen = false; changed = true; }
  }
  if (changed) saveMem(m);
  localStorage.setItem('es_mem_v2_ok', '1');
}
migrateMemV2();

// known: 候选折叠链(自评认识)。只动 streak/掌握, 不再无条件入池; 已在池内视为一次成功复习
// wrong: 默写/自测答错 → 入池+记错+明天必现
// right: 池内答对 → SM-2 前进, 连对晋升
function memTouch(word, kind) {
  const m = getMem(); const k = kw(word); if (!k) return;
  const r = m[k] || { st: 0, err: 0, master: false, seen: false, ef: 2.5, rep: 0, ivl: 0, due: null, pin: false };
  if (kind === 'known') {
    r.st = (r.st || 0) + 1;
    if (r.st >= 3) { r.master = true; r.due = null; r.seen = true; }
    else if (r.seen && !r.master) sm2Update(r, 5); // 在池 → 成功复习推进
  } else if (kind === 'right') {
    if (!r.seen) return; // 不在池的答对不处理(理论不发生)
    sm2Update(r, 4);
    if (r.rep >= 3 && !r.master) { r.master = true; r.st = Math.max(r.st || 0, 3); r.due = null; }
  } else if (kind === 'wrong') {
    r.seen = true; r.st = 0; r.master = false; r.err = (r.err || 0) + 1; sm2Update(r, 1);
  }
  r.updated = Date.now(); m[k] = r; saveMem(m);
}
// 确认背诵清单词 → 入池(视为学习对象; 学生自认不会, 无论历史都降级重学)
function memConfirmWord(word, meaning) {
  const m = getMem(); const k = kw(word); if (!k) return;
  const r = m[k] || { st: 0, err: 0, master: false, seen: false, ef: 2.5, rep: 0, ivl: 0, due: null, pin: false };
  r.seen = true; r.master = false; r.st = 0; r.due = todayStr();
  if (meaning) r.meaning = String(meaning).slice(0, 80); // 存词义, 每日自测免查接口
  r.updated = Date.now(); m[k] = r; saveMem(m);
}
// 从错题本移除(出池): 保留掌握/历史标记, 只是不再被调度
function memDePool(word) {
  const m = getMem(); const k = kw(word); if (!k) return;
  const r = m[k]; if (!r) return;
  r.seen = false; r.due = null; r.pin = false; r.updated = Date.now();
  saveMem(m);
}
// 置顶/取消置顶 (错题本与每日自测排序优先)
function memSetPin(word, on) {
  const m = getMem(); const k = kw(word); const r = m[k]; if (!r) return;
  r.pin = !!on; r.updated = Date.now(); saveMem(m);
}
// 词组/金句错题 (独立于单词记忆)
const OTHER_KEY = 'es_other_errs_v1';
function getOtherErrs() { try { return JSON.parse(localStorage.getItem(OTHER_KEY) || '[]'); } catch (e) { return []; } }
function saveOtherErrs(list) { localStorage.setItem(OTHER_KEY, JSON.stringify(list.slice(0, 80))); }
function otherErrAdd(it) {
  const list = getOtherErrs();
  const hit = list.find(x => x.en === it.en);
  if (hit) { hit.n = (hit.n || 1) + 1; hit.last = Date.now(); }
  else list.unshift({ t: it.type, en: it.en, zh: it.zh, n: 1, last: Date.now() });
  saveOtherErrs(list);
}
function otherErrRemove(en) { saveOtherErrs(getOtherErrs().filter(x => x.en !== en)); }

function memSetState(word, state) {
  const m = getMem(); const k = kw(word); if (!k) return;
  if (state === 'clear') { delete m[k]; saveMem(m); return; }
  const r = m[k] || { st: 0, err: 0, master: false, seen: false, ef: 2.5, rep: 0, ivl: 0, due: null, pin: false };
  r.seen = true; r.updated = Date.now();
  if (state === 'master') {
    r.master = true; r.st = Math.max(r.st || 0, 3); r.due = null;
  } else {
    r.master = false; r.st = 0; r.rep = 0; r.ivl = 0; r.ef = 2.5; r.due = todayStr();
  }
  m[k] = r; saveMem(m);
}
function memStats(total) {
  const m = getMem(); let master = 0, learning = 0;
  for (const k in m) { if (m[k].master) master++; else if (m[k].seen) learning++; }
  return { master, learning, pct: total ? Math.round(master / total * 100) : 0 };
}
// 错题本单词列表 (池内非掌握, pin/到期/错误排序)
function mistakeWords() {
  const m = getMem(); const today = todayStr(); const out = [];
  for (const k in m) {
    const r = m[k];
    if (!r || r.master || !r.seen) continue;
    out.push({ word: k, err: r.err || 0, due: r.due || '', rep: r.rep || 0, pin: !!r.pin, updated: r.updated || 0, meaning: r.meaning || '' });
  }
  out.sort((x, y) => (y.pin - x.pin) || ((x.due && y.due) ? (x.due < y.due ? -1 : 1) : (x.due ? -1 : 1)) || (y.err - x.err));
  return out;
}
// 每日自测候选: pin → 到期 → 错误多, 上限30; 可附加到期掌握词抽查
function dailyCandidates(limit = 30, withMaster = false) {
  const m = getMem(); const today = todayStr();
  const pinned = [], due = [], later = [], masterDue = [];
  for (const k in m) {
    const r = m[k];
    if (!r || !r.seen) continue;
    if (r.master) { if (withMaster && r.due && r.due <= today) masterDue.push({ word: k, due: r.due }); continue; }
    const item = { word: k, err: r.err || 0, due: r.due || null, updated: r.updated || 0, rep: r.rep || 0, pin: !!r.pin };
    if (item.pin) pinned.push(item);
    else if (item.due && item.due <= today) due.push(item);
    else later.push(item);
  }
  pinned.sort((x, y) => (x.due < y.due ? -1 : 1));
  due.sort((x, y) => (x.due < y.due ? -1 : 1));
  later.sort((x, y) => (y.err - x.err) || (x.updated - y.updated));
  masterDue.sort((x, y) => (x.due < y.due ? -1 : 1));
  const picks = [...pinned, ...due, ...later].slice(0, limit).map(x => x.word);
  return picks.concat(masterDue.slice(0, 3).map(x => x.word));
}
const isKnownWord = c => { const r = memRec(c.word); return !!(r && r.master); };

// ==================== 提取 ====================
async function extract() {
  const text = textInput.value.trim();
  if (!text) { showStatus('请先粘贴/上传英语文本', true); return; }
  btn.disabled = true;
  showStatus('⏳ 本地模型分析中…（约 8-20 秒）');
  result.classList.add('hidden');
  const t0 = Date.now();
  try {
    const r = await fetch('/api/extract', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, grade: $('#gradeSelect').value || null, books: activeBooks() })
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '提取失败');
    $('#timeInfo').textContent = `本地模型 ${((Date.now() - t0) / 1000).toFixed(1)}s（gemma4-e2b）${j.grade ? '· ' + j.grade : ''}`;
    lastExtras = j.data;
    distractPool = j.distractors || [];
    cands = j.candidates || [];
    candState = {};
    foldOpen = false;
    $('#card-vocab').classList.add('hidden');
    renderExtras(lastExtras);
    if (cands.length) { renderCandidates(); result.classList.remove('hidden'); showStatus('✅ 提取完成 — 请自评候选词'); }
    else { showStatus('⚠️ 未找到候选词（文章太简单？），试试换文章/换年级'); }
    result.scrollIntoView({ behavior: 'smooth' });
  } catch (e) { showStatus('❌ ' + e.message, true); }
  finally { btn.disabled = false; }
}

// ==================== 候选词自评 ====================
function makeCandRow(c, i, folded) {
  const st = candState[kw(c.word)] || 0;
  const lvl = c.cefr ? (c.cefr.min === c.cefr.max ? c.cefr.min : `${c.cefr.min}–${c.cefr.max}`) : (c.scope === '拓展' ? '表外' : '');
  let meaningHtml = '<span class="cand-meaning dim">—</span>';
  if (st) {
    meaningHtml = c.meaning
      ? `<span class="cand-meaning">${esc(c.meaning)}</span>`
      : `<span class="cand-meaning dim2">${c.scope === 'CEFR' ? 'CEFR ' + (c.cefr ? (c.cefr.min === c.cefr.max ? c.cefr.min : c.cefr.min + '-' + c.cefr.max) : '') + ' 级词（中文释义暂未收录，可在词书中查阅）' : '（暂无释义）'}</span>`;
    if (c.ctxMeaning && c.ctxMeaning !== c.meaning) {
      meaningHtml += `<div class="ctx-note">${icon('alert-triangle')} 文中另义：${esc(c.ctxMeaning)}${c.ctxSource ? `（${esc(c.ctxSource)}）` : ''}</div>`;
    }
  }
  const mark = folded ? '<span class="fold-mark">已多次认识</span>' : '';
  return `<tr class="cand-row st${st}" data-i="${i}">
    <td class="word">${mark}${esc(c.word)}${c.phonetic ? `<div class="phon">${esc(c.phonetic)}</div>` : ''}${c.pos ? `<div class="pos">${esc(c.pos)}</div>` : ''}</td>
    <td>${lvl ? `<span class="cefr-lvl">${esc(lvl)}</span>` : ''}</td>
    <td>${scopeTagSmall(c.scope)}</td>
    <td class="ex">${esc(c.sentence || '')}</td>
    <td class="cand-judge">
      <button class="jbtn y ${st === 1 ? 'on' : ''}" data-v="1">${icon('check')} 认识</button>
      <button class="jbtn n ${st === 2 ? 'on' : ''}" data-v="2">${icon('x')} 不认识</button>
    </td>
    <td class="cand-m">${meaningHtml}</td>
  </tr>`;
}

function scopeTagSmall(scope) {
  if (scope === '考纲') return '<span class="tag kg">考纲</span>';
  if (scope === 'CEFR') return '<span class="tag cf" title="CEFR 分级词书命中（B1 及以上，考纲外）">分级</span>';
  if (scope === 'CET4') return '<span class="tag cet" title="四六级词书命中">四级</span>';
  if (scope === 'CET6') return '<span class="tag cet" title="四六级词书命中">六级</span>';
  return '<span class="tag ext">拓展</span>';
}

function visibleCands() { return showExt ? cands : cands.filter(c => c.scope !== '拓展'); }

function renderCandidates() {
  const box = $('#candBox');
  box.classList.remove('hidden');
  const vis = visibleCands();
  const fresh = vis.filter(c => !isKnownWord(c));
  const folded = vis.filter(c => isKnownWord(c));
  $('#candBody').innerHTML = fresh.map(c => makeCandRow(c, cands.indexOf(c), false)).join('') ||
    '<tr><td colspan="6" class="empty">没有新候选词 — 见下方已认识折叠区</td></tr>';
  $('#candCount').textContent = `（${vis.length} 个${folded.length ? `，${folded.length} 个已折叠` : ''}）`;
  const fb = $('#candFolded');
  if (folded.length) {
    fb.classList.remove('hidden');
    $('#foldTitle').innerHTML = `${icon('smile')} 你已连续多次认识的词（${folded.length}）：${folded.map(f => f.word).join('、')}`;
    $('#foldBody').innerHTML = folded.map(c => makeCandRow(c, cands.indexOf(c), true)).join('');
    $('#foldBody').classList.toggle('hidden', !foldOpen);
    $('#foldToggle').textContent = foldOpen ? '收起' : '展开';
  } else { fb.classList.add('hidden'); }
  updateCandStats();
}

function updateCandStats() {
  let y = 0, n = 0, p = 0;
  for (const c of visibleCands()) {
    const st = candState[kw(c.word)] || 0;
    if (st === 1) y++; else if (st === 2) n++; else p++;
  }
  $('#candStats').innerHTML = `<b class="n-count">${icon('x')} 将进入背诵清单：${n}</b> · ${icon('check')} 认识：${y} · 待定：${p}`;
  $('#candConfirm').innerHTML = icon('circle-check') + ' ' + (n ? `确认生成背诵清单（${n} 个生词）` : '确认生成背诵清单（无生词）');
}

function setCand(i, v) {
  const c = cands[i];
  if (!c) return;
  const key = kw(c.word);
  candState[key] = candState[key] === v ? 0 : v;
  renderCandidates(); // 重绘保持主表/折叠区一致
}

function confirmList() {
  const chosen = visibleCands().filter(c => candState[kw(c.word)] === 2);
  // 记忆结算: 清单词→入错题本(学习对象); 认识词→候选折叠链(不污染错题本)
  for (const c of visibleCands()) {
    const st = candState[kw(c.word)] || 0;
    if (st === 2) memConfirmWord(c.word, c.meaning_zh);
    else if (st === 1) memTouch(c.word, 'known');
  }
  lastData = {
    vocabulary: chosen.map(c => ({
      word: c.word, phonetic: c.phonetic, pos: c.pos, meaning_zh: c.meaning || '',
      cefr: c.cefr, scope: c.scope, example: c.sentence || ''
    })),
    phrases: lastExtras.phrases || [], golden_sentences: lastExtras.golden_sentences || [],
    collocations: lastExtras.collocations || [], grammar: lastExtras.grammar || []
  };
  $('#candBox').classList.add('hidden');
  renderAll(lastData);
  showStatus(`✅ 背诵清单已生成（${chosen.length} 个生词）— 可开始默写`);
}

// ==================== 渲染 ====================
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const countBadge = cardId => $(cardId).querySelector('.count');

function cefrCell(w) {
  if (!w.cefr) return '<span class="cefr-out">—</span>';
  const { min, max } = w.cefr;
  const label = min === max ? min : `${min}–${max}`;
  const col = { A1: '#90a4ae', A2: '#66bb6a', B1: '#29b6f6', B2: '#7e57c2' }[max] || '#7e57c2';
  return `<span class="cefr" style="color:${col};font-weight:700">${label}</span>`;
}
function scopeTag(it) {
  if (!it || !it.scope) return '';
  if (it.scope === '考纲') return `<span class="tag kg">考纲</span>`;
  if (it.scope === 'CEFR') return '<span class="tag cf">分级</span>';
  if (it.scope === 'CET4') return '<span class="tag cet">四级</span>';
  if (it.scope === 'CET6') return '<span class="tag cet">六级</span>';
  return '<span class="tag ext">拓展</span>';
}

function renderAll(d) {
  const parts = [
    ['生词', d.vocabulary?.length || 0],
    ['词组', (d.phrases?.length || 0) + (d.collocations?.length || 0)],
    ['金句', d.golden_sentences?.length || 0],
    ['语法', d.grammar?.length || 0]
  ];
  $('#summaryBar').innerHTML = parts.map(([k, v]) => `<span class="pill">${k} <b>${v}</b></span>`).join('');
  $('#summaryBar').classList.remove('hidden');
  $('#ignoreBar').classList.add('hidden');
  const tb = $('#card-vocab tbody');
  tb.innerHTML = (d.vocabulary || []).map(w => `<tr>
    <td class="word">${esc(w.word)}</td><td class="phon">${esc(w.phonetic || '')}</td>
    <td>${esc(w.pos || '')}</td><td class="zh">${w.meaning_zh ? esc(w.meaning_zh) : '<span class="dim-ph">（暂无中文释义）</span>'}</td>
    <td>${cefrCell(w)}</td><td>${scopeTag(w)}</td>
    <td class="ex">${esc(w.example || '')}</td></tr>`).join('') ||
    `<tr><td colspan="7" class="empty">没有生词 — 恭喜，这篇都认识</td></tr>`;
  countBadge('#card-vocab').textContent = `(${d.vocabulary?.length || 0})`;
  $('#card-vocab').classList.remove('hidden');
  const hasAny = (d.vocabulary?.length || 0) + (d.phrases?.length || 0) + (d.collocations?.length || 0) + (d.golden_sentences?.length || 0) > 0;
  $('#dictateCta').classList.toggle('hidden', !hasAny);
  renderExtras(d);
}

function renderExtras(d) {
  // 词组+搭配合并为「词组」板块 (2026-09-07)
  const phrases = []
    .concat((d.phrases || []).map(p => ({ en: p.phrase, zh: p.meaning_zh, ex: p.example })))
    .concat((d.collocations || []).map(c => ({ en: c.collocation, zh: c.meaning_zh, ex: c.example })));
  renderList('#card-phrases', phrases, p => '<b>' + esc(p.en) + '</b> <span class="zh">' + esc(p.zh) + '</span><div class="ex">' + esc(p.ex || '') + '</div>');
  renderList('#card-sentences', d.golden_sentences || [], st => '<span class="sen">"' + esc(st.sentence) + '"</span><div class="ex">' + icon('lightbulb') + ' ' + esc(st.reason || '') + '</div>');
  renderList('#card-grammar', d.grammar || [], g => '<b>' + esc(g.point) + '</b><div class="zh">' + esc(g.explanation || '') + '</div><div class="ex">例：' + esc(g.example || '') + '</div>');
}
function renderList(cardId, items, fmt) {
  const card = $(cardId);
  const ul = card.querySelector('ul');
  ul.innerHTML = (items || []).map(it => `<li>${fmt(it)}</li>`).join('') ||
    `<li class="empty">${CARD_MAP[cardId.split('-')[1]].empty}</li>`;
  countBadge(cardId).textContent = `(${items?.length || 0})`;
}

// ==================== 词书侧栏 (推开式, 随时可开) ====================
let curBook = null;
let bookOpen = false;

// 勾选的词书 (1-3 本, localStorage)
function activeBooks() {
  try {
    const a = JSON.parse(localStorage.getItem('es_books') || 'null');
    if (Array.isArray(a) && a.length) return a.slice(0, 3);
  } catch (e) {}
  return [PRIMARY_CACHE || 'sh'];
}

// ===== 词书管理: 缓存 / 切主词书 / 添加 / 删除 =====
let BOOK_CACHE = [];
let PRIMARY_CACHE = null;
async function refreshBooks() {
  const j = await (await fetch('/api/books')).json();
  BOOK_CACHE = j.books || [];
  PRIMARY_CACHE = j.primary || null;
  return j;
}
async function setPrimaryBook(id) {
  const r = await (await fetch('/api/books/primary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) })).json();
  if (!r.ok) throw new Error(r.error || '切换失败');
  const cur = activeBooks();
  if (cur.indexOf(id) < 0) saveBooks(cur.concat([id]).slice(-3));
  await refreshBooks();
  showStatus('主词书已切换：' + (BOOK_CACHE.filter(function (b) { return b.id === id; })[0] || {}).name);
  await openSide();
}
async function importBookFile(file) {
  const text = await file.text();
  const name = file.name.replace(/\.(json|txt|csv)$/i, '').trim() || '导入词书';
  const r = await (await fetch('/api/books/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, filename: file.name, content: text }) })).json();
  if (!r.ok) throw new Error(r.error || '导入失败');
  await refreshBooks();
  showStatus('已导入「' + r.name + '」' + r.wordCount + ' 词');
  await openSide();
}
function pickBookFile() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,.txt,.csv,application/json,text/plain';
  inp.addEventListener('change', async function () {
    const f = inp.files && inp.files[0];
    if (!f) return;
    try { await importBookFile(f); } catch (e) { showStatus('导入失败: ' + e.message, true); }
  });
  inp.click();
}
async function deleteBook(id) {
  const r = await (await fetch('/api/books/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) })).json();
  if (!r.ok) throw new Error(r.error || '删除失败');
  await refreshBooks();
  showStatus('已删除词书 ' + id);
  await openSide();
}
function saveBooks(list) { localStorage.setItem('es_books', JSON.stringify(list)); }

function setSide(open) {
  bookOpen = open;
  $('#bookSide').classList.toggle('open', open);
}

async function openSide() {
  setSide(true);
  const pick = $('#pickBooks');
  try {
    const j = await refreshBooks();
    const cur = activeBooks();
    pick.innerHTML = (j.books || []).map(b => {
      const checked = cur.includes(b.id);
      const tag = b.primary ? '主词书' : (b.kind === 'cet' ? '四六级' : (b.kind === 'cefr' ? '分级' : '词书'));
      return `<label class="pick-item${checked ? ' on' : ''}" data-id="${b.id}">
        <input type="checkbox" ${checked ? 'checked' : ''}> <b>${esc(b.name.split('(')[0].slice(0, 14))}</b><i>${tag}</i></label>`;
    }).join('');
    // 注: .pick-item 是 <label>, 点击标签原生即切换内部 checkbox ——
    // 早先这里又手动切换一次, 导致"点标签=切两次=勾不掉"。原生行为已足够, 故删去手动切换。
    pick.querySelectorAll('input').forEach(cb => cb.addEventListener('change', () => {
      const ids = [...pick.querySelectorAll('input:checked')].map(c => c.closest('.pick-item').dataset.id);
      if (ids.length > 3) { cb.checked = false; showStatus('最多选 3 本词书', true); return; }
      if (!ids.length) { cb.checked = true; showStatus('至少选 1 本词书', true); return; }
      saveBooks(ids);
      pick.querySelectorAll('.pick-item').forEach(p => p.classList.toggle('on', p.querySelector('input').checked));
    }));
    // 词书库列表
    const box = $('#bookList');
    const learnCount = Object.values(getMem()).filter(r => r.seen && !r.master).length;
    const cards = (j.books || []).map(b => {
      const st = memStats(b.wordCount);
      const prog = b.primary
        ? '<div class="book-prog"><div class="book-prog-bar"><i style="width:' + st.pct + '%"></i></div><span class="book-prog-txt">掌握 ' + st.master + '/' + b.wordCount + '（' + st.pct + '%）</span></div>'
        : '';
      const kindTxt = b.primary ? '主词书 · 考纲层（显示进度）'
        : (b.kind === 'cet' ? '四六级词书 · 带音标释义'
        : (b.kind === 'cefr' ? 'CEFR 分级 · 副词书（辅助）' : '副词书 · 参与者'));
      const acts = '<div style="margin-top:6px;display:flex;gap:6px">'
        + (b.primary ? '' : '<button class="ghost bk-set" data-id="' + b.id + '">设为主词书</button>')
        + (b.removable ? '<button class="ghost bk-del" data-id="' + b.id + '">删除</button>' : '')
        + '</div>';
      return '<div class="book-card" data-id="' + b.id + '">'
        + '<div><div class="book-card-name">' + esc(b.name) + (b.primary ? '  ★' : '') + '</div>'
        + '<div class="book-card-meta">' + kindTxt + ' · ' + b.wordCount + ' 词' + (b.phraseCount ? ' + ' + b.phraseCount + ' 词组' : '') + '</div>' + prog + acts + '</div>'
        + '<div class="book-card-go">翻看 →</div></div>';
    }).join('');
    box.innerHTML = '<div class="learn-entry" id="learnEntry">' + icon('book-marked') + ' 错题本 ' + learnCount + ' 词 [查看]</div>'
      + '<div class="learn-entry" id="addBook">' + icon('plus') + ' 添加词书（JSON 词书 / 纯文本词表）</div>'
      + '<div class="book-hint">文本格式：每行一个词，可用 制表符 / 多个空格 / 冒号 分隔释义；文件名即词书名</div>'
      + '<div class="side-sec">词书库（点击翻看 · ★ = 主词书 · 词条可点右侧徽标切换掌握状态）</div>'
      + (cards || '无可用的词书');
    box.querySelectorAll('.book-card').forEach(card => card.addEventListener('click', e => {
      if (e.target.closest && e.target.closest('.book-card-acts')) return;
      enterBook(card.dataset.id);
    }));
    const ab = document.getElementById('addBook');
    if (ab) ab.addEventListener('click', pickBookFile);
    box.querySelectorAll('.bk-set').forEach(btn => btn.addEventListener('click', async e => {
      e.stopPropagation();
      try { await setPrimaryBook(btn.dataset.id); } catch (err) { showStatus(err.message, true); }
    }));
    box.querySelectorAll('.bk-del').forEach(btn => btn.addEventListener('click', async e => {
      e.stopPropagation();
      try { await deleteBook(btn.dataset.id); } catch (err) { showStatus(err.message, true); }
    }));
    const le = document.getElementById('learnEntry');
    if (le) le.addEventListener('click', showLearningView);  } catch (e) { pick.innerHTML = '加载失败: ' + esc(e.message); }
}

async function enterBook(id) {
  curBook = id;
  let rec = BOOK_CACHE.filter(b => b.id === id)[0];
  if (!rec) { try { await refreshBooks(); } catch (e) {} rec = BOOK_CACHE.filter(b => b.id === id)[0]; }
  $('#bookViewTitle').textContent = rec ? rec.name : id;
  $('#bookSearch').value = '';
  $('#bookList').classList.add('hidden');
  $('#bookView').classList.remove('hidden');
  $('#bookGroups').innerHTML = '<div class="book-hint">点右侧字母浏览，或上方搜索词汇</div>';
  buildIndexBar();
}

function buildIndexBar() {
  const bar = $('#bookIndex');
  bar.innerHTML = 'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z'.split(' ').map(l =>
    `<div class="idx-letter" data-l="${l}">${l}</div>`).join('');
  bar.querySelectorAll('.idx-letter').forEach(el => el.addEventListener('click', () => loadLetter(el.dataset.l)));
}

async function loadLetter(letter, q) {
  lastQuery = { letter: letter || 'A', q: q || '' };
  const box = $('#bookGroups');
  box.innerHTML = `<div class="book-hint">加载 ${esc(letter || q || '')}…</div>`;
  try {
    const url = `/api/book/${curBook}?${q ? 'q=' + encodeURIComponent(q) : 'letter=' + letter}`;
    const j = await (await fetch(url)).json();
    if (!j.ok) throw new Error(j.error || '查询失败');
    const groups = groupByLetter(j.items);
    const keys = Object.keys(groups);
    if (!keys.length) { box.innerHTML = '<div class="book-hint">无匹配词汇</div>'; return; }
    box.innerHTML = keys.map(k => `
      <div class="book-group" id="grp-${k}">
        <div class="book-group-letter">${k}</div>
        <div class="book-group-items">${groups[k].map(it => `
          <div class="book-item${it.phonetic || it.tag ? ' bi-block' : ''}"><span class="mem-badge st-${memState(it.word)}" data-w="${esc(kw(it.word))}" title="点击切换: 已掌握/掌握中/清除">${memBadgeText(it.word)}</span><b>${esc(it.word)}</b>${it.phonetic ? `<span class="bk-phon">[${esc(it.phonetic)}]</span>` : ''}${it.pos ? `<i>${esc(it.pos)}</i>` : ''}${it.tag ? `<span class="bk-tag">${esc(it.tag)}</span>` : ''}<span class="zh">${esc(String(it.meaning).slice(0, 60))}</span></div>`).join('')}</div>
      </div>`).join('');
    if (letter && groups[letter]) { const g = document.getElementById('grp-' + letter); if (g) g.scrollIntoView({ block: 'start' }); }
  } catch (e) { box.innerHTML = '加载失败: ' + esc(e.message); }
}
let lastQuery = { letter: 'A', q: '' };
let mbTab = 'word'; // 错题本 tab: word | other
function showLearningView() {
  const box = $('#bookList');
  const words = mistakeWords();
  const others = getOtherErrs();
  const tabCls = t => (mbTab === t ? ' mb-tab-on' : '');
  box.innerHTML =
    '<div class="side-sec"><button class="ghost" id="lvBack">← 词书库</button> ' + icon('book-marked') + ' 错题本</div>' +
    '<div class="mb-tabs"><button class="mb-tab' + tabCls('word') + '" data-t="word">' + icon('type') + ' 单词 ' + words.length + '</button><button class="mb-tab' + tabCls('other') + '" data-t="other">' + icon('sparkles') + ' 词组·金句 ' + others.length + '</button></div>' +
    calBlock(words, others) +
    (mbTab === 'word' ? renderWordTab(words) : renderOtherTab(others));
  const cal = document.getElementById('calToggle');
  if (cal) cal.onclick = () => { const b = document.getElementById('calBody'); if (b) b.classList.toggle('hidden'); const sp = cal.querySelector('span'); if (sp) sp.textContent = b.classList.contains('hidden') ? '展开' : '收起'; };
  document.getElementById('lvBack').onclick = openSide;
  box.querySelectorAll('.mb-tab').forEach(b => b.addEventListener('click', () => { mbTab = b.dataset.t; showLearningView(); }));
  if (mbTab === 'word') {
    const dl = document.getElementById('lvDaily');
    if (dl) dl.onclick = () => { setSide(false); runDaily(); };
    const add = document.getElementById('lvAdd');
    if (add) add.onclick = manualAddWord;
    const inp = document.getElementById('lvAddInp');
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') manualAddWord(); });
  }
  bindSwipeActions(box);
  if (mbTab === 'word') ensureMeanings(words);
}
let _mbFetching = false;
async function ensureMeanings(words) {
  const miss = (words || []).filter(w => w && !w.meaning).map(w => w.word);
  if (!miss.length || _mbFetching) return;
  _mbFetching = true;
  try {
    const r = await fetch('/api/word-meanings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ words: miss }) });
    const j = await r.json();
    const map = j.map || {};
    const m = getMem(); let changed = false;
    for (const w of miss) {
      const v = map[kw(w)];
      if (v) { const rec = m[kw(w)]; if (rec) { rec.meaning = String(v).slice(0, 80); changed = true; } }
    }
    if (changed) { saveMem(m); showLearningView(); }
  } catch (e) { /* 词义拉取失败不阻塞列表 */ }
  _mbFetching = false;
}
function calBlock(words, others) {
  const today = todayStr();
  const days = [];
  for (let i = 0; i < 7; i++) days.push({ d: addDays(today, i), list: [] });
  const pending = [];
  for (const it of words) {
    if (!it.due) { pending.push(it); continue; }
    for (const day of days) if (it.due === day.d) { day.list.push(it); break; }
    if (it.due < today) days[0].list.push(it); // 过期归今天
  }
  const total = days.reduce((s, d) => s + d.list.length, 0);
  if (!total && !pending.length) return '<div class="cal-block"><button class="cal-head" id="calToggle">' + icon('calendar') + ' 复习日历：未来 7 天无到期词</button></div>';
  const names = ['今天', '明天', '后天'];
  const rows = days.map((d, i) => {
    if (!d.list.length) return '';
    const label = i < 3 ? names[i] : d.d.slice(5);
    return '<div class="cal-day"><b>' + label + ' · ' + d.list.length + '</b> <span>' + d.list.map(x => esc(x.word)).join('、') + '</span></div>';
  }).join('');
  const pendTxt = pending.length ? '<div class="cal-pend">' + icon('alert-triangle') + ' ' + pending.length + ' 个词待安排（手动降级/加入的会排明天）</div>' : '';
  return '<div class="cal-block"><button class="cal-head" id="calToggle">' + icon('calendar') + ' 复习日历：未来 7 天到期 ' + total + ' 词 <span style="color:#a5855f">展开</span></button>' +
    '<div id="calBody" class="hidden">' + rows + pendTxt + '</div></div>';
}
function renderWordTab(words) {
  const today = todayStr();
  const rows = words.length ? words.map(it => {
    const dueTxt = !it.due ? '待安排' : (it.due <= today ? '今日到期' : it.due.slice(5));
    return '<div class="mb-wrap" data-key="' + esc(kw(it.word)) + '">' +
      '<div class="mb-acts"><button class="mb-act mb-act-pin" title="置顶/取消置顶">' + (it.pin ? icon('pin') + ' 取消置顶' : icon('pin') + ' 置顶') + '</button><button class="mb-act mb-act-del" title="移除出错题本">' + icon('trash-2') + ' 移除</button></div>' +
      '<div class="mb-row"><b>' + esc(it.word) + '</b>' +
      (it.meaning ? '<span class="zh mb-zh">' + esc(it.meaning) + '</span>' : '') +
      (it.pin ? '<span class="mb-pin-mark">' + icon('pin') + '</span>' : '') +
      '<span class="learn-meta">' + (it.err > 0 ? '错' + it.err + ' · ' : '') + dueTxt + '</span></div>' +
      '</div>';
  }).join('') : '<div class="book-hint">空 — 自评选"不认识"并确认清单、或默写答错的词会进这里</div>';
  return '<div class="mb-list">' + rows + '</div>' +
    '<div class="mb-add"><input id="lvAddInp" class="ds-count" placeholder="手动添加考纲词…" style="flex:1"><button class="ghost" id="lvAdd">' + icon('plus') + ' 添加</button></div>' +
    (words.length ? '<div class="side-actions"><button class="primary-big" id="lvDaily">' + icon('calendar') + ' 每日自测（' + words.length + '）</button></div>' : '');
}
function renderOtherTab(others) {
  if (!others.length) return '<div class="book-hint">暂无词组/金句错题 — 默写词组或金句答错的会记在这里</div>';
  const rows = others.map(it =>
    '<div class="mb-wrap" data-key="' + esc(it.en) + '">' +
    '<div class="mb-acts"><button class="mb-act mb-act-del" title="移除">' + icon('trash-2') + ' 移除</button></div>' +
    '<div class="mb-row"><b>' + esc(it.en) + '</b><span class="zh">' + esc(stripPos(it.zh)) + '</span><span class="learn-meta">错' + it.n + '</span></div>' +
    '</div>').join('');
  return '<div class="mb-list">' + rows + '</div>';
}
// 左滑操作: 拉出约1/4停住露按钮, 完全拉过去=移除
function bindSwipeActions(container) {
  container.querySelectorAll('.mb-wrap').forEach(wrap => {
    const row = wrap.querySelector('.mb-row');
    if (!row) return;
    let sx = 0, dx = 0, dragging = false, moved = false;
    const closeAll = () => container.querySelectorAll('.mb-wrap.open').forEach(w => { if (w !== wrap) { w.classList.remove('open'); w.querySelector('.mb-row').style.transform = ''; } });
    row.addEventListener('pointerdown', e => { sx = e.clientX; dx = 0; moved = false; dragging = false; closeAll(); });
    row.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse' && e.buttons === 0) return;
      dx = e.clientX - sx;
      if (dx < -4) dragging = true;
      if (dragging) { moved = true; row.style.transition = 'none'; row.style.transform = 'translateX(' + Math.max(dx, -210) + 'px)'; }
    });
    row.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false; row.style.transition = '';
      if (dx <= -150) { wrap.classList.add('removing'); setTimeout(() => removeRow(wrap), 180); }
      else if (dx <= -40) { wrap.classList.add('open'); row.style.transform = 'translateX(-160px)'; }
      else row.style.transform = '';
    });
    row.addEventListener('click', e => { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } });
    const delBtn = wrap.querySelector('.mb-act-del');
    if (delBtn) delBtn.addEventListener('click', () => removeRow(wrap));
    const pinBtn = wrap.querySelector('.mb-act-pin');
    if (pinBtn) pinBtn.addEventListener('click', () => {
      const r = memRec(wrap.dataset.key);
      memSetPin(wrap.dataset.key, !(r && r.pin));
      showLearningView();
    });
    const badge = row.querySelector('.mem-badge');
    if (badge && !badge.classList.contains('noact')) badge.addEventListener('click', e => { e.stopPropagation(); cycleMem(wrap.dataset.key); });
  });
}
function removeRow(wrap) {
  const key = wrap.dataset.key;
  if (mbTab === 'word') memDePool(key);
  else otherErrRemove(key);
  showLearningView();
}
async function manualAddWord() {
  const inp = document.getElementById('lvAddInp');
  const w = (inp.value || '').trim();
  if (!w) return;
  try {
    const r = await fetch('/api/word-meanings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ words: [w] }) });
    const j = await r.json();
    const meaning = (j.map || {})[kw(w)];
    if (!meaning) { showStatus('词书中没有这个词（暂只支持考纲词手动添加）', true); return; }
    memConfirmWord(w, meaning);
    inp.value = '';
    showLearningView();
    showStatus('✅ 已加入错题本：' + w);
  } catch (err) { showStatus('添加失败: ' + err.message, true); }
}
function memBadgeText(word) {
  const st = memState(word);
  return st === 'master' ? icon('circle-check') : st === 'learning' ? icon('bookmark') : icon('plus');
}
function cycleMem(word) {
  const st = memState(word);
  if (st === 'new') memSetState(word, 'learning');        // ➕ 灰加号 → 🔶 加入错题本(明天自测)
  else if (st === 'learning') memSetState(word, 'master'); // 🔶 → ✅ 已掌握
  else memSetState(word, 'clear');                          // ✅ → ➕ 清除记录(回到灰加号, 可重新标)
  // 刷新当前视图
  if (document.getElementById('bookView').classList.contains('hidden')) showLearningView();
  else loadLetter(lastQuery.letter, lastQuery.q);
}
function groupByLetter(items) {
  const g = {};
  for (const it of items) {
    const m = String(it.word).match(/[a-zA-Z]/);
    const k = m ? m[0].toUpperCase() : '#';
    (g[k] = g[k] || []).push(it);
  }
  return g;
}

// ==================== 默写 v7 ====================
let distractPool = [];
const D = { pool: [], items: [], wrong: [], wrongSet: new Set(), round: 1, idx: 0, correct: 0, answered: false, firstCount: 0, mode: 'list', qdir: 'zh2en', judging: false };
function shuffleArr(x) { for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; }
const normSent = s => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
function maskWord(sentence, word) {
  const str = String(sentence || ''), w = String(word || '').trim();
  if (!w) return str;
  const escW = w.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const re = new RegExp('(^|[^A-Za-z])' + escW + '($|[^A-Za-z])', 'i');
  if (re.test(str)) return str.replace(re, '$1____$2');
  const stem = w.replace(/(ies|es|s|ied|ed|ing|d)$/i, '');
  if (stem && stem.length > 3) { const re2 = new RegExp('(^|[^A-Za-z])' + stem + '[a-z]*($|[^A-Za-z])', 'i'); if (re2.test(str)) return str.replace(re2, '$1____$2'); }
  return str;
}
// 题干清洗: 去掉中文释义前的词性缩写 (n./v./a./ad./vt. 等)
function stripPos(zh) {
  return String(zh || '').replace(/^\s*(?:[a-z]+\.&?[a-z]*\.?)+\s*/i, '').replace(/^\s*(?:vt|vi|n|v|a|ad|adv|prep|conj|art|pron|num|int|aux|pl|adj)\.\s*/i, '');
}
function judgeEn(answer, target) {
  const n = s => String(s).trim().toLowerCase().replace(/[\u2019']/g, "'").replace(/\s+/g, ' ');
  const strip = w => w.replace(/(ies$|es$|s$|ied$|ed$|ing$|d$)/, '');
  const a = n(answer), t = n(target);
  if (!a) return false;
  return a === t || a === strip(t) || strip(a) === t || strip(a) === strip(t);
}

function openDictateSetup() {
  if (!lastData) { showStatus('请先生成一份背诵清单', true); return; }
  $('#dictateSetup').classList.remove('hidden');
  $('#dictateRun').classList.add('hidden');
  $('#dictateResult').classList.add('hidden');
  $('#dictateOverlay').classList.remove('hidden');
  document.body.classList.add('dl-lock');
  $('#dpageTitle').textContent = '默写';
}
function closeDictate() { $('#dictateOverlay').classList.add('hidden'); document.body.classList.remove('dl-lock'); D.judging = false; $('#dictateSubmit').disabled = false; }

function buildPool() {
  const d = lastData, pool = [];
  const push = (type, en, zh, extra) => { const e = String(en || '').trim(), z = String(zh || '').trim(); if (e && z) pool.push({ type, en: e, zh: z, ...extra }); };
  if ($('#dsWord').checked) (d.vocabulary || []).forEach(w => push('word', w.word, w.meaning_zh, { example: w.example || '' }));
  if ($('#dsPhrase').checked) {
    (d.phrases || []).forEach(p => push('phrase', p.phrase, p.meaning_zh, { example: p.example || '' }));
    (d.collocations || []).forEach(c => push('phrase', c.collocation, c.meaning_zh, { example: c.example || '' }));
  }
  if ($('#dsSentence').checked) (d.golden_sentences || []).forEach(s => push('sentence', s.sentence, s.translation, { reason: s.reason || '' }));
  return pool;
}
function startDictate() {
  const pool = buildPool();
  if (!pool.length) { showStatus('所选板块没有可默写内容（金句需含中文翻译）', true); return; }
  const ratioBtn = document.querySelector('.q-btn.on');
  let ratio = ratioBtn ? Number(ratioBtn.dataset.q) : 1;
  const nInput = $('#dsCount').value.trim();
  let picked = pool;
  if (nInput) { const n = parseInt(nInput, 10); if (n > 0 && n < pool.length) picked = shuffleArr([...pool]).slice(0, n); }
  else if (ratio < 1) picked = shuffleArr([...pool]).slice(0, Math.max(1, Math.ceil(pool.length * ratio)));
  else picked = shuffleArr([...pool]);
  D.pool = picked; D.firstCount = picked.length; D.mode = 'list';
  $('#dictateSetup').classList.add('hidden');
  $('#dictateResult').classList.add('hidden');
  $('#dictateRun').classList.remove('hidden');
  startRound(1);
}
// 每日自测: 掌握中词汇, 错误多优先, ≤30
async function runDaily() {
  const words = dailyCandidates(30, true);
  if (!words.length) { showStatus('📅 今日无到期词汇，全部掌握中词都未到期——保持复习节奏即可'); return; }
  const all = dailyCandidates(9999);
  const masterN = words.length - all.length;
  showStatus('📅 今日待复习 ' + all.length + ' 个掌握中词汇' + (masterN > 0 ? ' + ' + masterN + ' 个到期已掌握词抽查' : '') + '，本次 ' + words.length + ' 题');
  $('#dictateSetup').classList.add('hidden');
  $('#dictateResult').classList.add('hidden');
  $('#dictateRun').classList.remove('hidden');
  $('#dictateOverlay').classList.remove('hidden');
  document.body.classList.add('dl-lock');
  $('#dpageTitle').textContent = '每日自测';
  $('#roundInfo').innerHTML = icon('calendar') + ' 每日自测 · 错误多者优先';
  $('#dictateProgress').textContent = '加载词义…';
  try {
    const r = await fetch('/api/word-meanings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ words }) });
    const j = await r.json();
    const map = j.map || {};
    const pool = shuffleArr(words.filter(w => map[kw(w)]).map(w => ({ type: 'word', en: w, zh: map[kw(w)] })));
    if (!pool.length) { showStatus('这些词暂无词书释义，无法出题', true); closeDictate(); return; }
    D.pool = pool; D.firstCount = pool.length; D.mode = 'daily';
    startRound(1);
  } catch (err) { showStatus('❌ ' + err.message, true); closeDictate(); }
}
function startRound(round) {
  D.round = round; D.idx = 0; D.correct = 0; D.answered = false;
  D.items = round === 1 ? [...D.pool] : shuffleArr([...D.wrong]);
  D.wrong = [];
  if (D.mode === 'daily') $('#roundInfo').innerHTML = icon('calendar') + ' ' + (round === 1 ? '每日自测' : '每日自测 · 第 ' + round + ' 轮纠错');
  else $('#roundInfo').textContent = round === 1 ? '' : '第 ' + round + ' 轮 · 复习错题';
  $('#dictateTitle').textContent = (D.mode === 'daily' ? '每日自测' : '默写') + (round > 1 ? '（第 ' + round + ' 轮）' : '');
  if (!D.items.length) return finishAll();
  showCard();
}
function fmtType(t) { return t === 'word' ? '单词' : t === 'phrase' ? '词组' : '金句'; }
function showCard() {
  const it = D.items[D.idx];
  D.answered = false; D.judging = false;
  // 题型: 单词随机双向; 词组/金句恒中译英
  D.qdir = (it.type === 'word') ? (Math.random() < 0.5 ? 'zh2en' : 'en2zh') : 'zh2en';
  $('#dictateProgress').textContent = D.idx + 1 + ' / ' + D.items.length + '  ' + fmtType(it.type) + ' · ' + (D.qdir === 'zh2en' ? '中译英' : '英译中');
  const inp = $('#dictateInput');
  inp.value = ''; inp.style.display = 'block';
  inp.placeholder = D.qdir === 'zh2en' ? (it.type === 'sentence' ? '默写完整英文句子…' : '输入英文…') : '写出中文意思（AI 容错批改）…';
  $('#dictateFeedback').classList.add('hidden');
  $('#dictateSkip').classList.remove('hidden');
  $('#dictateSubmit').classList.remove('hidden');
  $('#dictateSubmit').disabled = false;
  $('#dictateNext').classList.add('hidden');
  if (D.qdir === 'zh2en') {
    $('#dictatePrompt').innerHTML = '<span class="prompt-zh">' + esc(stripPos(it.zh)) + '</span><div class="prompt-meta">' + fmtType(it.type) + ' · 看中文写英文</div>';
    $('#dictateExample').textContent = it.example ? ('提示：' + maskWord(it.example, it.en)) : (it.type === 'sentence' ? '（默写完整英文句子）' : '');
  } else {
    $('#dictatePrompt').innerHTML = '<span class="prompt-en">' + esc(it.en) + '</span><div class="prompt-meta">单词 · 写出中文意思</div>';
    $('#dictateExample').textContent = it.example ? ('原文语境：' + it.example) : '';
  }
  inp.focus();
}
function submitAnswer() {
  if (D.answered || D.judging) return;
  const it = D.items[D.idx];
  const answer = $('#dictateInput').value.trim();
  if (!answer) return;
  if (D.qdir === 'en2zh') { // 英译中: 模型容错批改
    D.judging = true;
    $('#dictateFeedback').classList.remove('hidden');
    $('#dictateFeedback').innerHTML = '<span class="judging">' + icon('hourglass') + ' AI 批改中…</span>';
    $('#dictateSubmit').disabled = true;
    fetch('/api/judge-zh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ en: it.en, standard: it.zh, answer }) })
      .then(r => r.json()).then(j => {
        $('#dictateSubmit').disabled = false;
        D.answered = true; D.judging = false;
        const fb = $('#dictateFeedback');
        const ok = j.ok === true;
        if (ok) { D.correct++; memTouch(it.en, 'right'); fb.innerHTML = '<span class="ok">' + icon('circle-check') + ' 正确' + (j.note ? '（' + esc(j.note) + '）' : '') + '</span>'; }
        else { D.wrong.push(it); D.wrongSet.add(it.en); memTouch(it.en, 'wrong'); fb.innerHTML = '<span class="no">' + icon('x-circle') + ' 参考答案：<b>' + esc(stripPos(it.zh)) + '</b>' + (j.note ? '<div class="ctx-note">' + esc(j.note) + '</div>' : '') + '</span>'; }
        $('#dictateSkip').classList.add('hidden');
        $('#dictateSubmit').classList.add('hidden');
        $('#dictateNext').classList.remove('hidden');
      }).catch(() => {
        $('#dictateSubmit').disabled = false;
        D.judging = false;
        $('#dictateFeedback').innerHTML = '<span class="no">批改失败，请重试</span>';
      });
    return;
  }
  D.answered = true;
  const fb = $('#dictateFeedback');
  fb.classList.remove('hidden');
  $('#dictateInput').style.display = 'none';
  $('#dictateSkip').classList.add('hidden');
  $('#dictateSubmit').classList.add('hidden');
  $('#dictateNext').classList.remove('hidden');
  let ok = false;
  if (it.type === 'sentence') ok = normSent(answer) === normSent(it.en);
  else ok = judgeEn(answer, it.en);
  if (ok) { D.correct++; if (it.type === 'word') memTouch(it.en, 'right'); fb.innerHTML = '<span class="ok">' + icon('circle-check') + ' 正确</span>'; }
  else {
    D.wrong.push(it); D.wrongSet.add(it.en);
    if (it.type === 'word') memTouch(it.en, 'wrong'); else otherErrAdd(it);
    fb.innerHTML = '<span class="no">' + icon('x-circle') + ' 正确答案：<b>' + esc(it.en) + '</b>' + (it.zh ? ' — ' + esc(stripPos(it.zh)) : '') + '</span>';
  }
}
function skipItem() {
  if (D.answered || D.judging) return;
  D.answered = true;
  const it = D.items[D.idx];
  D.wrong.push(it); D.wrongSet.add(it.en);
  if (it.type === 'word') memTouch(it.en, 'wrong'); else otherErrAdd(it);
  const fb = $('#dictateFeedback');
  fb.classList.remove('hidden');
  $('#dictateInput').style.display = 'none';
  $('#dictateSkip').classList.add('hidden');
  $('#dictateSubmit').classList.add('hidden');
  fb.innerHTML = '<span class="no">答案：<b>' + esc(it.en) + '</b> — ' + esc(it.zh) + '</span>';
  $('#dictateNext').classList.remove('hidden');
}
function nextItem() {
  if (D.judging) return;
  D.idx++;
  if (D.idx >= D.items.length) {
    if (D.wrong.length) { startRound(D.round + 1); return; }
    finishAll(); return;
  }
  showCard();
}
function finishAll() {
  const rounds = D.round;
  const once = Math.max(0, D.firstCount - D.wrongSet.size);
  $('#dictateRun').classList.add('hidden');
  const box = $('#dictateResult');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="dictate-score">' + icon('party-popper') + ' 全部通过！</div>' +
    '<div class="dictate-summary">' + (D.mode === 'daily' ? icon('calendar') + ' 今日自测' : '本次默写') + '：共 ' + D.firstCount + ' 题 · ' + rounds + ' 轮完成（' + once + ' 个一次通过，' + D.wrongSet.size + ' 个纠错后掌握）</div>' +
    '<div class="dictate-actions"><button class="ghost" id="againBtn">再来一次</button><button class="primary" id="doneBtn">完成</button></div>';
  $('#againBtn').onclick = () => {
    box.classList.add('hidden');
    if (D.mode === 'daily') runDaily();
    else { $('#dictateSetup').classList.remove('hidden'); }
  };
  $('#doneBtn').onclick = closeDictate;
}

// ==================== 事件 ====================
$('#candBody').addEventListener('click', e => {
  const b = e.target.closest('.jbtn');
  if (b) { const tr = b.closest('.cand-row'); if (tr) setCand(Number(tr.dataset.i), Number(b.dataset.v)); }
});
$('#foldBody').addEventListener('click', e => {
  const b = e.target.closest('.jbtn');
  if (b) { const tr = b.closest('.cand-row'); if (tr) setCand(Number(tr.dataset.i), Number(b.dataset.v)); }
});
$('#foldToggle').addEventListener('click', () => { foldOpen = !foldOpen; renderCandidates(); });
$('#candConfirm').addEventListener('click', confirmList);
$('#extToggle').addEventListener('change', e => { showExt = e.target.checked; renderCandidates(); });


// ===== 识别模式开关 (视觉/纯OCR) =====
function setModeBtn(m) {
  const b = $('#modeBtn'); if (!b) return;
  b.innerHTML = icon(m === 'ocr' ? 'type' : 'eye') + ' ' + (m === 'ocr' ? '纯OCR' : '视觉');
  b.title = m === 'ocr' ? '当前: 纯OCR(不碰视觉模型) — 点击切回视觉' : '当前: 视觉优先+OCR兜底 — 点击切纯OCR';
}
$('#modeBtn').addEventListener('click', async () => {
  const next = window._esMode === 'ocr' ? 'vision' : 'ocr';
  try {
    const r = await fetch('/api/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: next }) });
    const j = await r.json();
    if (j.ok) { window._esMode = j.mode; setModeBtn(j.mode); showStatus(j.mode === 'ocr' ? '纯 OCR 模式：识别不经过视觉模型' : '视觉模式：视觉优先 + OCR 兜底'); }
    else showStatus('切换失败', true);
  } catch (e) { showStatus('切换失败: ' + e.message, true); }
});
fetch('/api/mode').then(r => r.json()).then(j => { if (j.ok) { window._esMode = j.mode; setModeBtn(j.mode); } }).catch(() => {});
$('#sideClose').addEventListener('click', () => setSide(false));
$('#bookBack').addEventListener('click', () => {
  $('#bookView').classList.add('hidden');
  $('#bookList').classList.remove('hidden');
});
$('#bookSearch').addEventListener('keydown', e => {
  if (e.key === 'Enter' && $('#bookSearch').value.trim()) loadLetter('', $('#bookSearch').value.trim());
});
$('#bookGroups').addEventListener('click', e => {
  const b = e.target.closest('.mem-badge');
  if (b) cycleMem(b.dataset.w);
});

$('#copyBtn').addEventListener('click', () => {
  if (!lastData) return;
  const d = lastData, lines = [];
  if (d.vocabulary?.length) { lines.push('【生词】'); d.vocabulary.forEach(w => lines.push(`${w.word} ${w.phonetic || ''} ${w.pos || ''} ${w.meaning_zh || ''} [${w.cefr ? (w.cefr.min === w.cefr.max ? w.cefr.min : w.cefr.min + '-' + w.cefr.max) : '表外'}][${w.scope || ''}]`)); lines.push(''); }
  if ((d.phrases?.length) || (d.collocations?.length)) {
    lines.push('【词组】');
    (d.phrases || []).forEach(p => lines.push(`${p.phrase} — ${p.meaning_zh || ''}`));
    (d.collocations || []).forEach(c => lines.push(`${c.collocation} — ${c.meaning_zh || ''}`));
    lines.push('');
  }
  if (d.golden_sentences?.length) { lines.push('【作文金句】'); d.golden_sentences.forEach(st => lines.push(`"${st.sentence}"`)); lines.push(''); }
  if (d.grammar?.length) { lines.push('【语法】'); d.grammar.forEach(g => lines.push(`${g.point}：${g.explanation || ''}`)); }
  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    const b = $('#copyBtn'); b.innerHTML = icon('circle-check') + ' 已复制'; setTimeout(() => b.textContent = '复制为文本', 1500);
  });
});


$('#dpageBack').addEventListener('click', () => { closeDictate(); showStatus(''); });
$('#dictateCta').addEventListener('click', openDictateSetup);
$('#setupClose').addEventListener('click', closeDictate);
$('#dictateStart').addEventListener('click', startDictate);
$('#dictateQuit').addEventListener('click', () => { closeDictate(); showStatus(''); });
$('#dictateSkip').addEventListener('click', skipItem);
$('#dictateSubmit').addEventListener('click', submitAnswer);
$('#dictateNext').addEventListener('click', nextItem);
$('#dictateInput').addEventListener('keydown', e => { if (e.key === 'Enter') { if (!D.answered) submitAnswer(); else nextItem(); } });
document.querySelectorAll('.q-btn').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.q-btn').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  $('#dsCount').value = '';
}));
$('#dsCount').addEventListener('input', () => document.querySelectorAll('.q-btn').forEach(x => x.classList.remove('on')));

const fileInput = $('#fileInput');
$('#imgBtn').addEventListener('click', () => { fileInput.dataset.kind = 'img'; fileInput.accept = '.png,.jpg,.jpeg,.webp,.bmp'; fileInput.click(); });
$('#docBtn').addEventListener('click', () => { fileInput.dataset.kind = 'doc'; fileInput.accept = '.pdf,.docx,.txt,.png,.jpg,.jpeg,.webp,.bmp'; fileInput.click(); });
fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  if (!files.length) return;
  const hint = $('#fileHint');
  hint.classList.remove('hidden');
  for (const f of files) {
    if (f.size > 25 * 1024 * 1024) { hint.innerHTML = icon('alert-triangle') + ' ' + esc(`${f.name}: 超过 25MB（太大），请压缩或用较小图片`); continue; }
    hint.innerHTML = icon('hourglass') + ' ' + esc(`识别 ${f.name}…`);
    const b64 = await new Promise((ok, no) => { const rd = new FileReader(); rd.onload = () => ok(String(rd.result).split(',')[1]); rd.onerror = no; rd.readAsDataURL(f); });
    try {
      const r = await fetch('/api/file-text', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: f.name, data: b64 })
      });
      const j = await r.json();
      if (!j.ok) { hint.innerHTML = icon('x-circle') + ' ' + esc(`${f.name}: ${j.error || '识别失败'}`); continue; }
      if (!j.text || !j.text.trim()) { hint.innerHTML = icon('alert-triangle') + ' ' + esc(`${f.name}: 未识别到文字`); continue; }
      textInput.value = (textInput.value.trim() ? textInput.value.trim() + '\n\n' : '') + j.text.trim();
      hint.innerHTML = icon('circle-check') + ' ' + esc(`${f.name} 已识别 (${j.text.length} 字${j.engine === 'vision' ? '，智能视觉' : ''})，可编辑后生成清单`);
    } catch (e) { hint.innerHTML = icon('x-circle') + ' ' + esc(`${f.name}: ${e.message}`); }
  }
});

btn.addEventListener('click', extract);
textInput.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') extract(); });

// ===== 即聊即学 (Chat) =====
const CHAT_KEY = 'es_chat_v1';
const CHATERR_KEY = 'es_chat_errs_v1';
const GOLD_KEY = 'es_golden_v1';
// ===== 多会话隔离 (记录按会话; 错题本/金句/生词全局共享) =====
const SESS_KEY = 'es_sessions_v1';
function chats() { try { return JSON.parse(localStorage.getItem(SESS_KEY) || '[]'); } catch (e) { return []; } }
function saveChats(l) { localStorage.setItem(SESS_KEY, JSON.stringify(l)); }
let curChatId = null;
function curC() { return chats().find(x => x.id === curChatId) || null; }
function ensureChatSessions() {
  let l = chats();
  if (!l.length) {
    let old = []; try { old = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]'); } catch (e) {}
    l = old.length ? [{ id: Date.now(), title: '之前的聊天', msgs: old.slice(-40), ts: Date.now() }] : [{ id: Date.now(), title: '新的聊天', msgs: [], ts: Date.now() }];
    saveChats(l);
  }
  if (!curC()) curChatId = l[0].id;
}
function chatMsgs() { const c = curC(); return c ? c.msgs : []; }
function saveChat(list) {
  const l = chats();
  const c = l.find(x => x.id === curChatId);
  if (!c) return;
  c.msgs = list.slice(-120);
  const fus = c.msgs.filter(m => m.role === 'user');
  if (fus.length === 1 && !c.auto) { c.title = String(fus[0].content || '').slice(0, 16) || c.title; }
  saveChats(l);
}
function chatErrs() { try { return JSON.parse(localStorage.getItem(CHATERR_KEY) || '[]'); } catch (e) { return []; } }
function saveChatErrs(l) { localStorage.setItem(CHATERR_KEY, JSON.stringify(l.slice(-150))); }
function goldList() { try { return JSON.parse(localStorage.getItem(GOLD_KEY) || '[]'); } catch (e) { return []; } }
function saveGold(l) { localStorage.setItem(GOLD_KEY, JSON.stringify(l.slice(-150))); }
function chatTagAdd(tag) {
  const l = chatErrs(); const hit = l.find(x => x.k === '@tag:' + tag);
  if (hit) hit.n = (hit.n || 1) + 1; else l.unshift({ k: '@tag:' + tag, tag, n: 1, last: Date.now() });
  saveChatErrs(l);
}
function chatErrAdd(item) {
  const l = chatErrs();
  const hit = l.find(x => x.from === item.from && x.to === item.to);
  if (hit) { hit.n = (hit.n || 1) + 1; hit.last = Date.now(); hit.why = item.why || hit.why; }
  else l.unshift({ ...item, n: 1, last: Date.now() });
  saveChatErrs(l);
  if (item.tag) chatTagAdd(item.tag);
}
function goldAdd(sentence, zh, source) {
  const l = goldList();
  if (l.find(x => x.s === sentence)) return false;
  l.unshift({ s: sentence, zh: zh || '', src: source || 'chat', ts: Date.now() });
  saveGold(l); return true;
}
let chatBusy = false;
const chatBody = () => document.getElementById('chatBody');
function chatScrollBottom() { const b = chatBody(); b.scrollTop = b.scrollHeight; }
function chatBubbleUser(msg, idx) {
  const div = document.createElement('div');
  div.className = 'cmsg user';
  div.innerHTML = '<div class="cbub cbub-user">' + esc(msg) + '</div>' +
    '<div class="cfix-zone" data-idx="' + idx + '"></div>';
  return div;
}
function chatBubbleAI(msg, idx, hardWords) {
  const div = document.createElement('div');
  div.className = 'cmsg ai';
  let bodyHtml = esc(msg);
  if (hardWords && hardWords.length) {
    // 按词边界包 span (只包难词第一次出现)
    for (const hw of hardWords) {
      const re = new RegExp('\\b' + hw.w.replace(/[.*+?^${}()|[\]\\]/g, m => '\\' + m) + '\\b');
      if (re.test(bodyHtml)) bodyHtml = bodyHtml.replace(re, '<span class="chard" data-w="' + esc(hw.w) + '" data-l="' + esc(hw.level || '') + '" data-z="' + esc(hw.zh || '') + '">' + hw.w + '</span>');
    }
  }
  div.innerHTML = '<div class="cbub cbub-ai">' + bodyHtml + '</div>' +
    '<div class="cactions" data-idx="' + idx + '">' +
    '<button class="cact" data-a="translate">' + icon('type') + '翻译</button>' +
    '<button class="cact" data-a="explain">' + icon('book-open') + '语法</button>' +
    '<button class="cact" data-a="gold">' + icon('bookmark') + '收藏金句</button></div>' +
    '<div class="cutil-zone" data-idx="' + idx + '"></div>';
  return div;
}
function chatThinkRow() {
  const div = document.createElement('div');
  div.className = 'cmsg ai cthink';
  div.innerHTML = '<div class="cbub cbub-ai">' + icon('hourglass') + ' thinking<span class="cdots"><i>.</i><i>.</i><i>.</i></span></div>';
  return div;
}
function renderChat() {
  const b = chatBody(); if (!b) return;
  renderChatTabs();
  b.innerHTML = '';
  const list = chatMsgs();
  if (!list.length) {
    b.innerHTML = '<div class="chat-start"><div class="cs-title">' + icon('sparkles') + ' 不用先开口 — 选个话题，AI 会先说话：</div>' +
      '<div class="cs-topics">' +
      '<button class="cs-chip" data-tp="daily">聊日常</button>' +
      '<button class="cs-chip" data-tp="mood">聊心情</button>' +
      '<button class="cs-chip" data-tp="deep">聊点idea</button>' +
      '<button class="cs-chip cs-ai" data-tp="ai">让 AI 挑话题</button></div>' +
      '<div class="cs-hint">也可以直接打字，你说的每句话都会被悄悄检查语法，气泡下方看讲解。聊顺了之后，AI 会慢慢带你聊更有想法的话题。</div></div>';
    return;
  }
  list.forEach((m, i) => {
    if (m.role === 'user') {
      const el = chatBubbleUser(m.content, i);
      const zone = el.querySelector('.cfix-zone');
      (m.corrections || []).forEach(c => zone.appendChild(corrCard(c)));
      b.appendChild(el);
    } else {
      const aiEl = chatBubbleAI(m.content, i, m.hardWords);
      if (m.opener) { const tg = document.createElement('div'); tg.className = 'opener-tag'; tg.textContent = '\u5f00\u573a\u8bdd\u9898 \u00b7 ' + m.opener; aiEl.appendChild(tg); }
      b.appendChild(aiEl);
    }
  });
  chatScrollBottom();
}
function corrCard(c) {
  const el = document.createElement('div');
  el.className = 'corr-card';
  el.innerHTML = '<div class="corr-line"><s>' + esc(c.from) + '</s> → <b>' + esc(c.to) + '</b> <span class="corr-cat">' + esc(c.cat || '') + '</span></div>' +
    (c.why ? '<div class="corr-why">' + icon('lightbulb') + ' ' + esc(c.why) + '</div>' : '') +
    '<div class="corr-btns"><button class="cact corr-upg">' + icon('rocket') + '更地道的说法</button><span class="corr-save-zone"><button class="cact corr-save">' + icon('bookmark') + '收入错题本</button></span></div>' +
    '<div class="corr-upg-zone"></div>';
  el.querySelector('.corr-upg').addEventListener('click', async ev => {
    const btn = ev.currentTarget, zone = el.querySelector('.corr-upg-zone');
    if (zone.dataset.done) { zone.classList.toggle('hidden'); return; }
    btn.innerHTML = icon('hourglass') + '改写中…';
    try {
      const j = await (await fetch('/api/util', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'upgrade', text: c.to, grade: $('#gradeSelect').value || null }) })).json();
      if (!j.ok) throw new Error(j.error || '失败');
      zone.dataset.done = '1';
      zone.innerHTML = '<div class="upg-sentence">' + esc(j.upgraded) + '</div>' +
        (j.why ? '<div class="upg-why">' + esc(j.why) + '</div>' : '') +
        (j.note ? '<div class="upg-note">' + icon('lightbulb') + ' ' + esc(j.note) + '</div>' : '');
      const sz = el.querySelector('.corr-save-zone');
      if (sz && !sz.dataset.added) {
        sz.innerHTML = '<button class="cact gold-upg">' + icon('star') + '收藏这句</button>';
        sz.querySelector('.gold-upg').addEventListener('click', async ev2 => {
          let zh = '';
          try { zh = (await (await fetch('/api/util', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'translate', text: j.upgraded }) })).json()).result || ''; } catch (e) {}
          goldAdd(j.upgraded, zh, '地道改写');
          ev2.currentTarget.outerHTML = '<span class="gold-ok">' + icon('circle-check') + '已收藏</span>';
        });
      }
    } catch (e) { btn.innerHTML = icon('alert-triangle') + '改写失败，重试'; }
  });
  const saveBtn = el.querySelector('.corr-save');
  if (saveBtn) saveBtn.addEventListener('click', () => {
    chatErrAdd({ ...c, auto: false });
    saveBtn.outerHTML = '<span class="gold-ok">' + icon('circle-check') + '已收入</span>';
  });
  return el;
}
function startChat(topic) {
  const inp = document.getElementById('chatInput');
  const tip = document.createElement('div'); tip.className = 'cmsg ai';
  tip.innerHTML = '<div class="cbub cbub-ai">' + icon('hourglass') + ' AI \u51c6\u5907\u4e2d\u2026</div>';
  chatBody().appendChild(tip); chatScrollBottom(); inp.disabled = true;
  fetch('/api/chat/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grade: document.getElementById('gradeSelect').value || null, topic, persona: getPersona() }) })
    .then(r => r.json()).then(j => {
      tip.remove(); inp.disabled = false;
      if (!j.ok) throw new Error(j.error || '\u5f00\u573a\u5931\u8d25');
      const l = chats();
      const c = l.find(x => x.id === curChatId);
      if (c) { c.auto = true; c.msgs = c.msgs.concat([{ role: 'assistant', content: j.reply, ts: Date.now(), hardWords: j.hardWords || [], opener: j.topicTitle || '' }]).slice(-120); }
      saveChats(l); renderChat(); inp.focus();
    }).catch(e => { tip.remove(); inp.disabled = false; showStatus(icon('x-circle') + ' \u5f00\u573a\u5931\u8d25: ' + esc(e.message), true); });
}
function newChatSession() {
  const l = chats();
  l.unshift({ id: Date.now(), title: '\u65b0\u7684\u804a\u5929 ' + (l.length + 1), msgs: [], ts: Date.now() });
  saveChats(l.slice(0, 12)); curChatId = l[0].id; renderChat();
}
function renderChatTabs() {
  const bar = document.getElementById('chatTabs'); if (!bar) return;
  const l = chats();
  if (!curC() && l.length) curChatId = l[0].id;
  bar.innerHTML = '<button class="ctab ct-new">' + icon('plus') + ' \u65b0\u4f1a\u8bdd</button>' +
    l.map(x => '<span class="ctab' + (x.id === curChatId ? ' on' : '') + '" data-id="' + x.id + '" title="\u4f1a\u8bdd\u8bb0\u5fc6\u4e92\u4e0d\u76f8\u901a">' + esc(x.title) + '<i class="ctab-x" data-del="' + x.id + '">\u00d7</i></span>').join('');
  bar.querySelector('.ct-new').addEventListener('click', newChatSession);
  bar.querySelectorAll('.ctab[data-id]').forEach(el => el.addEventListener('click', e => {
    if (e.target.dataset.del) {
      const keep = l.filter(x => x.id !== +e.target.dataset.del);
      saveChats(keep);
      if (!keep.find(x => x.id === curChatId)) curChatId = keep.length ? keep[0].id : null;
      if (!curChatId) newChatSession(); else renderChat();
      return;
    }
    curChatId = +el.dataset.id; renderChat();
  }));
}
async function sendChat() {
  const inp = document.getElementById('chatInput');
  const text = inp.value.trim();
  if (!text || chatBusy) return;
  inp.value = '';
  chatBusy = true;
  const sendBtn = document.getElementById('chatSend');
  sendBtn.disabled = true;
  const list = chatMsgs();
  const hist = list.slice(-10).map(m => ({ role: m.role, content: m.content }));
  list.push({ role: 'user', content: text, ts: Date.now() });
  saveChat(list); renderChat();
  const think = chatThinkRow();
  chatBody().appendChild(think); chatScrollBottom();
  try {
    const j = await (await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, grade: $('#gradeSelect').value || null, history: hist, persona: getPersona() }) })).json();
    think.remove();
    if (!j.ok) throw new Error(j.error || '请求失败');
    const l2 = chatMsgs();
    const mine = l2[l2.length - 1];
    if (mine && mine.role === 'user') { mine.corrections = j.corrections || []; }
    // 纠错自动进对话错题本
    (j.corrections || []).forEach(c => chatErrAdd({ ...c, tag: c.tag || '', auto: true }));
    l2.push({ role: 'assistant', content: j.reply, ts: Date.now(), hardWords: j.hardWords || [] });
    saveChat(l2); renderChat();
  } catch (e) {
    think.remove();
    const err = document.createElement('div');
    err.className = 'chat-err';
    err.innerHTML = icon('x-circle') + ' ' + esc(e.message) + ' <button class="cact chat-retry">重试</button>';
    err.querySelector('.chat-retry').addEventListener('click', () => { err.remove(); chatBusy = false; document.getElementById('chatInput').value = text; document.getElementById('chatInput').focus(); });
    chatBody().appendChild(err); chatScrollBottom();
    const l3 = chatMsgs();
    if (l3.length && l3[l3.length - 1].role === 'user' && !l3[l3.length - 1].corrections) l3.pop();
    saveChat(l3);
  } finally {
    chatBusy = false; sendBtn.disabled = false;
    document.getElementById('chatInput').focus();
  }
}
// ---- 对话错题本 / 金句面板 ----
let cbTab = 'errs';
function openChatBooks() {
  document.querySelectorAll('.mode-tabs .mtab').forEach(b => b.classList.toggle('on', b.dataset.m === 'chat'));
  essayMode = false;
  document.getElementById('essayPanel').classList.add('hidden');
  document.querySelector('.chat-wrap').classList.remove('hidden');
  const panel = document.getElementById('chatBooks');
  panel.classList.remove('hidden');
  renderCbTabs(); renderCbList();
}
function renderCbTabs() {
  const errs = chatErrs(), gold = goldList();
  const nErr = errs.filter(x => !String(x.k || '').startsWith('@tag:')).length;
  const tags = errs.filter(x => String(x.k || '').startsWith('@tag:'));
  document.getElementById('cbTabs').innerHTML =
    '<button class="mb-tab' + (cbTab === 'errs' ? ' on' : '') + '" data-t="errs">' + icon('book-marked') + '纠错本 ' + nErr + '</button>' +
    '<button class="mb-tab' + (cbTab === 'tags' ? ' on' : '') + '" data-t="tags">' + icon('sparkles') + '话题 ' + tags.length + '</button>' +
    '<button class="mb-tab' + (cbTab === 'gold' ? ' on' : '') + '" data-t="gold">' + icon('bookmark') + '金句 ' + gold.length + '</button>';
  document.querySelectorAll('#cbTabs .mb-tab').forEach(b => b.addEventListener('click', () => { cbTab = b.dataset.t; renderCbTabs(); renderCbList(); }));
}
function renderCbList() {
  const box = document.getElementById('cbList');
  if (cbTab === 'errs') {
    const errs = chatErrs().filter(x => !String(x.k || '').startsWith('@tag:'));
    box.innerHTML = errs.length ? '' : '<div class="mb-empty">还没有对话纠错 — 和 AI 聊几句，错误会自动收进来</div>';
    errs.forEach((x, i) => {
      const row = document.createElement('div');
      row.className = 'cerr-row';
      row.innerHTML = '<div class="corr-line"><s>' + esc(x.from) + '</s> → <b>' + esc(x.to) + '</b> <span class="corr-cat">' + esc(x.cat || '') + '</span>' + (x.tag ? '<span class="corr-tag">' + esc(x.tag) + '</span>' : '') + (x.n > 1 ? '<span class="corr-n">×' + x.n + '</span>' : '') + '</div>' +
        (x.why ? '<div class="corr-why">' + icon('lightbulb') + ' ' + esc(x.why) + '</div>' : '') +
        '<div class="cerr-btns"><button class="cact" data-a="del">' + icon('trash-2') + '移除</button></div>';
      row.querySelector('[data-a=del]').addEventListener('click', () => {
        const l = chatErrs().filter(y => !(y.from === x.from && y.to === x.to));
        saveChatErrs(l); renderCbList(); renderCbTabs();
      });
      box.appendChild(row);
    });
  } else if (cbTab === 'tags') {
    const tags = chatErrs().filter(x => String(x.k || '').startsWith('@tag:')).sort((a, b) => (b.n || 1) - (a.n || 1) || (b.last || 0) - (a.last || 0));
    box.innerHTML = tags.length ? '<div class="tag-cloud">' + tags.map(t => '<span class="tag-chip">' + esc(t.tag) + '<i>' + (t.n || 1) + '</i></span>').join('') + '</div><div class="mb-hint">AI 根据聊天内容自动归类的话题分布 — 数字越多说明这类错误你越常犯</div>' : '<div class="mb-empty">暂无话题分类</div>';
  } else {
    const gold = goldList();
    box.innerHTML = gold.length ? '' : '<div class="mb-empty">收藏 AI 的金句或地道改写，攒成自己的句子库</div>';
    gold.forEach(x => {
      const row = document.createElement('div');
      row.className = 'gold-row';
      row.innerHTML = '<div class="gold-s">' + esc(x.s) + '</div>' +
        (x.zh ? '<div class="gold-zh">' + esc(x.zh) + '</div>' : '') +
        '<div class="gold-meta">' + esc(x.src === 'ai' ? 'AI 原句' : (x.src || '')) + '</div>' +
        '<button class="cact gold-del">' + icon('trash-2') + '移除</button>';
      row.querySelector('.gold-del').addEventListener('click', () => { saveGold(goldList().filter(y => y.s !== x.s)); renderCbList(); renderCbTabs(); });
      box.appendChild(row);
    });
  }
}
// ---- 难词点标弹层 ----
function chatPopShow(anchor, w, level, zh) {
  const pop = document.getElementById('chatPop');
  const m = memRec(w);
  pop.innerHTML = '<div class="cp-head"><b>' + esc(w) + '</b>' + (level ? '<span class="cp-lv">' + esc(level) + '</span>' : '') + '</div>' +
    (zh ? '<div class="cp-zh">' + esc(zh) + '</div>' : '') +
    '<div class="cp-btns"><button class="cact" data-a="mark">' + icon('plus') + '标为生词</button>' + (m ? '<span class="cp-state">' + (m.master ? '已在错题本(掌握)' : '已在错题本' + (m.due ? ' · ' + m.due : '')) + '</span>' : '') + '</div>';
  const r = anchor.getBoundingClientRect();
  const wrap = document.querySelector('.chat-wrap').getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left - wrap.left, wrap.width - 240)) + 'px';
  pop.style.top = (r.top - wrap.top - 8) + 'px';
  pop.classList.remove('hidden');
  pop.querySelector('[data-a=mark]').addEventListener('click', () => {
    memConfirmWord(w, zh || '');
    pop.classList.add('hidden');
    showStatus(icon('circle-check') + ' ' + esc(w) + ' 已进错题本，排入复习计划');
  });
}
// ---- 打开/关闭 ----
function openChat() {
  ensureChatSessions();
  setView('chat');
  setChatMode('chat');
  document.getElementById('chatOverlay').classList.remove('hidden');
  document.body.classList.add('dictate-open');
  renderChat();
  document.getElementById('chatInput').focus();
}
function closeChat() {
  setChatMode('chat');
  goHome();
  document.getElementById('chatOverlay').classList.add('hidden');
  document.body.classList.remove('dictate-open');
  document.getElementById('chatBooks').classList.add('hidden');
  document.getElementById('chatPop').classList.add('hidden');
}
// ---- 事件绑定 ----
$('#homeBackBtn').addEventListener('click', goHome);
$('#chatBody').addEventListener('click', e => { const chip = e.target.closest('.cs-chip'); if (chip && !chatBusy) startChat(chip.dataset.tp); });
$('#chatClose').addEventListener('click', closeChat);
$('#chatSend').addEventListener('click', sendChat);
$('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !e.shiftKey)) { e.preventDefault(); sendChat(); } });
$('#chatClear').addEventListener('click', () => { if (confirm('清空当前会话的聊天记录？错题本与金句不会丢。')) { const l = chats(); const c = l.find(x => x.id === curChatId); if (c) { c.msgs = []; c.auto = false; } saveChats(l); renderChat(); } });

$('#cbBack').addEventListener('click', () => document.getElementById('chatBooks').classList.add('hidden'));
chatBody().addEventListener('click', e => {
  const hw = e.target.closest('.chard');
  if (hw) { chatPopShow(hw, hw.dataset.w, hw.dataset.l, hw.dataset.z); return; }
  const act = e.target.closest('.cact');
  if (!act || !act.dataset.a) return;
  const idx = +act.closest('[data-idx]').dataset.idx;
  const msg = chatMsgs()[idx];
  if (!msg) return;
  const zone = document.querySelector('.cutil-zone[data-idx="' + idx + '"]');
  if (act.dataset.a === 'gold') {
    goldAdd(msg.content, '', 'AI 原句');
    act.outerHTML = '<span class="gold-ok">' + icon('circle-check') + '已收藏金句</span>';
    return;
  }
  if (zone.dataset.open === act.dataset.a) { zone.classList.add('hidden'); zone.dataset.open = ''; return; }
  zone.dataset.open = act.dataset.a;
  zone.classList.remove('hidden');
  zone.innerHTML = '<div class="cutil-load">' + icon('hourglass') + ' AI 处理中…</div>';
  fetch('/api/util', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: act.dataset.a, text: msg.content, grade: $('#gradeSelect').value || null }) })
    .then(r => r.json()).then(j => {
      if (!j.ok) throw new Error(j.error || '失败');
      zone.innerHTML = act.dataset.a === 'translate'
        ? '<div class="cutil-zh">' + esc(j.result) + '</div>'
        : '<pre class="cutil-explain">' + esc(j.result) + '</pre>';
    }).catch(err => { zone.innerHTML = '<div class="chat-err">' + icon('x-circle') + ' ' + esc(err.message) + '</div>'; zone.dataset.open = ''; });
});
document.getElementById('chatBody').addEventListener('scroll', () => document.getElementById('chatPop').classList.add('hidden'));


// ===== 作文模式 (即聊即学·作文; 主攻语言与表达) =====
const ESSAYS_KEY = 'es_essays_v1';
const EERR_KEY = 'es_essay_errs_v1';
const E_NOTE = '本区主攻语言与表达打磨 — 立意与思想深度不在 AI 能力范围内，点评仅点到为止。';
function essays() { try { return JSON.parse(localStorage.getItem(ESSAYS_KEY) || '[]'); } catch (e) { return []; } }
function saveEssays(l) { localStorage.setItem(ESSAYS_KEY, JSON.stringify(l.slice(-60))); }
function essayErrs() { try { return JSON.parse(localStorage.getItem(EERR_KEY) || '[]'); } catch (e) { return []; } }
function saveEssayErrs(l) { localStorage.setItem(EERR_KEY, JSON.stringify(l.slice(-200))); }
let essayMode = false, eDraft = { topic: '', text: '', assistKind: '' };
function setChatMode(m) {
  essayMode = (m === 'essay');
  document.querySelectorAll('.mode-tabs .mtab').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  document.querySelector('.chat-wrap').classList.toggle('hidden', m !== 'chat');
  document.getElementById('essayPanel').classList.toggle('hidden', m !== 'essay');
  document.getElementById('chatBooks').classList.add('hidden');
  if (m === 'essay') renderEssayPanel();
  if (m === 'archive') renderArchive();
  if (m === 'bank') renderEBank();
}
// ---- 面板 ----
function renderEssayPanel() {
  const P = document.getElementById('essayPanel');
  const words = String(eDraft.text || '').trim() ? String(eDraft.text).trim().split(/\s+/).length : 0;
  P.innerHTML =
    '<div class="dpage-bar e-bar"><button class="ghost" id="eBack">← 返回</button><span class="chat-title">即聊即学 · 作文（主攻语言）</span><button class="ghost" id="eArch">作文集</button><button class="ghost" id="eBankB">作文错题本</button></div>' +
    '<div class="e-note">' + icon('alert-triangle') + ' ' + E_NOTE + '</div>' +
    '<div class="e-form">' +
    '<input id="eTopic" class="e-topic" placeholder="请复制完整作文题目，也可以不填直接打磨作文语言" value="' + esc(eDraft.topic) + '">' +
    '<div class="e-topic-hint">' + icon('lightbulb') + ' 只想要语言打磨？题目留空也能改 — 填了题目，批改会额外核对审题与要点是否齐全</div>' +
    '<textarea id="eText" class="e-text" placeholder="把你的作文粘贴到这里（暂不支持手拍照图片，请打字或粘贴）。还没动笔？只填题目，点下面的求助按钮找灵感或要范文。">' + esc(eDraft.text) + '</textarea>' +
    '<div class="e-meta"><span id="eCount">' + words + ' 词' + (words > 350 ? ' · <b class="e-warn">' + icon('alert-triangle') + '偏长，450 词以上将被截断</b>' : '') + '</span><span class="e-cap">上限约 450 词</span></div>' +
    '<div class="e-asks">' +
    '题目没头绪？先问 AI：<button class="cact e-ask" data-k="explain">题目看不懂</button>' +
    '<button class="cact e-ask" data-k="ideas">要灵感/提纲</button>' +
    '<button class="cact e-ask" data-k="sample">要一篇范文对照</button>' +
    '</div>' +
    '<div id="eAssist" class="e-assist hidden"></div>' +
    '<button id="eGo" class="primary-big">' + icon('rocket') + '开始批改（语言·表达·成文）</button>' +
    '</div>' +
    '<div id="eResult" class="e-result hidden"></div>';
  P.querySelector('#eTopic').addEventListener('input', e => eDraft.topic = e.target.value);
  const ta = P.querySelector('#eText');
  ta.addEventListener('input', () => {
    eDraft.text = ta.value;
    const w = ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0;
    P.querySelector('#eCount').innerHTML = w + ' 词' + (w > 350 ? ' · <b class="e-warn">' + icon('alert-triangle') + '偏长，450 词以上将被截断</b>' : '');
  });
  P.querySelectorAll('.e-ask').forEach(b => b.addEventListener('click', () => essayAssist(b.dataset.k)));
  P.querySelector('#eGo').addEventListener('click', essayProofread);
  P.querySelector('#eBack').addEventListener('click', () => setChatMode('chat'));
  P.querySelector('#eArch').addEventListener('click', () => setChatMode('archive'));
  P.querySelector('#eBankB').addEventListener('click', () => setChatMode('bank'));
}
function essayAssist(kind) {
  const P = document.getElementById('essayPanel');
  const box = P.querySelector('#eAssist');
  const topic = eDraft.topic.trim();
  if (!topic) { showStatus(icon('alert-triangle') + ' 先在题目栏写上题目', true); return; }
  const titles = { explain: '题目解析', ideas: '灵感与提纲', sample: '范文对照' };
  box.classList.remove('hidden');
  box.innerHTML = '<div class="e-assist-head">' + icon(titles[kind] ? 'lightbulb' : 'sparkles') + ' ' + titles[kind] + ' <span class="e-assist-load">' + icon('hourglass') + ' AI 思考中…</span></div><div class="e-assist-body"></div>';
  fetch('/api/essay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'assist', kind, topic, grade: document.getElementById('gradeSelect').value || null }) })
    .then(r => r.json()).then(j => {
      if (!j.ok) throw new Error(j.error || '失败');
      let bodyHtml;
      if (kind === 'sample') {
        const sp = j.result.split(/最值得学的两个表达：/);
        const essay = (sp[0] || '').trim();
        const notes = (sp[1] || '').trim();
        bodyHtml = '<div class="e-sample">' + esc(essay) + '</div>' +
          (notes ? '<div class="e-sample-tip">最值得学的两个表达：' + esc(notes) + '</div>' : '');
      } else {
        bodyHtml = '<pre class="e-assist-pre">' + esc(j.result) + '</pre>';
      }
      box.querySelector('.e-assist-load').remove();
      box.querySelector('.e-assist-body').innerHTML = bodyHtml;
    }).catch(e => { box.querySelector('.e-assist-load').outerHTML = '<span class="chat-err">' + icon('x-circle') + ' ' + esc(e.message) + '</span>'; });
}
function essayProofread() {
  const t = (eDraft.text || '').trim();
  if (!t) { showStatus(icon('alert-triangle') + ' 把作文粘贴进来再批改；只有题目时先点上面的求助按钮', true); return; }
  const P = document.getElementById('essayPanel');
  const R = P.querySelector('#eResult');
  const go = P.querySelector('#eGo');
  go.disabled = true;
  R.classList.remove('hidden');
  R.innerHTML = '<div class="e-steps">' +
    '<div class="e-step" id="es1">' + icon('hourglass') + ' 第一步 · 逐句挑错…</div>' +
    '<div class="e-step dim" id="es2">第二步 · 润色成文</div>' +
    '<div class="e-step dim" id="es3">第三步 · 轻量点评</div></div>';
  fetch('/api/essay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'proofread', text: t, topic: eDraft.topic.trim(), grade: document.getElementById('gradeSelect').value || null }) })
    .then(r => r.json()).then(j => {
      go.disabled = false;
      if (!j.ok) throw new Error(j.error || '批改失败');
      renderEssayResult(j);
    }).catch(e => { go.disabled = false; R.innerHTML = '<div class="chat-err">' + icon('x-circle') + ' ' + esc(e.message) + '，可重试</div>'; });
}
function renderEssayResult(j) {
  const R = document.querySelector('#eResult');
  const es1 = document.getElementById('es1'); if (es1) { es1.innerHTML = icon('circle-check') + ' 挑出 ' + j.errors.length + ' 处语言问题'; es1.classList.remove('dim'); }
  // 自动入作文错题本 + 对话生词通道
  j.errors.forEach(x => {
    const l = essayErrs();
    const hit = l.find(y => y.en === x.en && y.fix === x.fix);
    if (hit) { hit.n = (hit.n || 1) + 1; hit.last = Date.now(); hit.why = x.why || hit.why; }
    else l.unshift({ en: x.en, fix: x.fix, cat: x.cat, why: x.why, n: 1, last: Date.now(), topic: eDraft.topic || '' });
    saveEssayErrs(l);
  });
  // 归档
  const rec = { id: Date.now(), topic: eDraft.topic || '(无题目)', origin: (eDraft.text || '').slice(0, 4500), polished: j.polished.slice(0, 4500), errors: j.errors, notes: j.notes, ts: Date.now(), nErr: j.errors.length };
  const l = essays(); l.unshift(rec); saveEssays(l);
  // 结果页
  R.innerHTML =
    '<div class="e-tabs"><button class="mb-tab on" data-e="polished">' + icon('sparkles') + ' 润色后成文</button>' +
    '<button class="mb-tab" data-e="diff">' + icon('pen-line') + ' 对照与错点</button>' +
    '<button class="mb-tab" data-e="notes">' + icon('book-open') + ' 点评与归档</button></div>' +
    '<div id="ePane" class="e-pane"></div>';
  const pane = R.querySelector('#ePane');
  const show = k => {
    R.querySelectorAll('.mb-tab').forEach(b => b.classList.toggle('on', b.dataset.e === k));
    if (k === 'polished') {
      pane.innerHTML = '<div class="e-pol">' + esc(j.polished) + '</div>' +
        (j.truncated ? '<div class="e-warn">' + icon('alert-triangle') + ' 原文过长已被截断批改，建议分段练习</div>' : '') +
        '<div class="e-pol-btns"><button class="cact" id="eCopy">' + icon('copy') + ' 复制成文</button><button class="cact" id="eGold">' + icon('bookmark') + ' 收藏为金句</button><button class="cact" id="eAgain">再改一篇</button></div>';
      document.getElementById('eCopy').addEventListener('click', ev => navigator.clipboard.writeText(j.polished).then(() => { ev.target.textContent = '已复制'; }));
      document.getElementById('eGold').addEventListener('click', ev => {
        // 收藏最有亮点的 3 句
        const sents = j.polished.split(/(?<=[.!?])\s+/).filter(x => x.split(/\s+/).length > 6).sort((a, b) => b.length - a.length).slice(0, 3);
        sents.forEach(sn => goldAdd(sn.trim(), '', '作文成文'));
        ev.target.textContent = '已收藏 ' + sents.length + ' 句进金句';
      });
      document.getElementById('eAgain').addEventListener('click', () => { eDraft = { topic: '', text: '', assistKind: '' }; renderEssayPanel(); document.querySelector('.mode-tabs .mtab[data-m=essay]').classList.add('on'); });
    } else if (k === 'diff') {
      pane.innerHTML = j.errors.length ? j.errors.map((x, i) =>
        '<div class="cerr-row"><div class="corr-line"><s>' + esc(x.en) + '</s> → <b>' + esc(x.fix) + '</b> <span class="corr-cat">' + esc(x.cat) + '</span></div>' +
        (x.why ? '<div class="corr-why">' + icon('lightbulb') + ' ' + esc(x.why) + '</div>' : '') + '</div>').join('')
        + '<div class="mb-hint">以上已自动收入「作文错题本」。原文与成文可切到「对照与错点」上下滚动比对。</div>'
        : '<div class="mb-empty">这篇几乎挑不出语言错误 — 很强！</div>';
    } else {
      pane.innerHTML =
        '<div class="e-notebox"><b>' + icon('sparkles') + ' 亮点</b><div>' + esc(j.notes.highlights || '（未标出）') + '</div></div>' +
        '<div class="e-notebox"><b>' + icon('book-open') + ' 结构（点到为止）</b><div>' + esc(j.notes.structure || '—') + '</div></div>' +
        '<div class="e-notebox"><b>' + icon('lightbulb') + ' 内容（点到为止）</b><div>' + esc(j.notes.content || '—') + '</div></div>' +
        '<div class="e-notebox e-lite">' + E_NOTE + ' <button class="cact" id="eOpenArch">' + icon('library') + ' 看我的作文集</button></div>';
      document.getElementById('eOpenArch').addEventListener('click', () => setChatMode('archive'));
    }
  };
  R.querySelectorAll('.mb-tab').forEach(b => b.addEventListener('click', () => show(b.dataset.e)));
  show('polished');
}
// ---- 作文集 ----
function renderArchive() {
  const bk = document.getElementById('chatBooks');
  bk.classList.remove('hidden');
  const l = essays();
  const trend = l.slice(0, 10).reverse().map(x => x.nErr);
  bk.innerHTML = '<div class="dpage-bar"><button class="ghost" id="abBack">← 返回</button><span class="chat-title">' + icon('library') + ' 作文集 · ' + l.length + ' 篇</span></div>' +
    (trend.length > 1 ? '<div class="e-trend">错误数走势：' + trend.join(' → ') + (trend[trend.length - 1] <= trend[0] ? ' ' + icon('circle-check') + ' 在变少' : ' ' + icon('alert-triangle') + ' 在变多，正常波动') + '</div>' : '') +
    '<div class="mb-list">' + (l.length ? '' : '<div class="mb-empty">还没批改过作文 — 去「作文」页签交第一篇</div>') + '</div>';
  const list = bk.querySelector('.mb-list');
  l.forEach(x => {
    const row = document.createElement('div');
    row.className = 'ea-row';
    row.innerHTML = '<div class="ea-head"><b>' + esc(x.topic) + '</b><span class="ea-date">' + new Date(x.ts).toLocaleDateString() + ' · ' + x.nErr + ' 处语言问题</span></div>' +
      '<div class="ea-preview">' + esc(String(x.origin).slice(0, 90)) + '…</div>' +
      '<div class="ea-btns"><button class="cact" data-a="view">查看</button><button class="cact" data-a="del">' + icon('trash-2') + '删除</button></div>';
    row.querySelector('[data-a=view]').addEventListener('click', () => essayDetail(x));
    row.querySelector('[data-a=del]').addEventListener('click', () => { saveEssays(essays().filter(y => y.id !== x.id)); renderArchive(); });
    list.appendChild(row);
  });
  bk.querySelector('#abBack').addEventListener('click', () => setChatMode(essayMode ? 'essay' : 'chat'));
}
function essayDetail(x) {
  const bk = document.getElementById('chatBooks');
  bk.innerHTML = '<div class="dpage-bar"><button class="ghost" id="abBack">← 作文集</button><span class="chat-title">' + esc(x.topic) + '</span></div>' +
    '<div class="mb-list"><div class="e-tabs"><button class="mb-tab on" data-e="o">原文</button><button class="mb-tab" data-e="p">成文</button><button class="mb-tab" data-e="err">错点 ' + x.errors.length + '</button></div><div id="abPane" class="e-pane"></div></div>';
  const pane = bk.querySelector('#abPane');
  bk.querySelectorAll('.mb-tab').forEach(b => b.addEventListener('click', () => {
    bk.querySelectorAll('.mb-tab').forEach(y => y.classList.toggle('on', y === b));
    if (b.dataset.e === 'o') pane.innerHTML = '<pre class="e-assist-pre">' + esc(x.origin) + '</pre>';
    else if (b.dataset.e === 'p') pane.innerHTML = '<div class="e-pol">' + esc(x.polished) + '</div>';
    else pane.innerHTML = x.errors.map(er => '<div class="cerr-row"><div class="corr-line"><s>' + esc(er.en) + '</s> → <b>' + esc(er.fix) + '</b> <span class="corr-cat">' + esc(er.cat) + '</span></div>' + (er.why ? '<div class="corr-why">' + esc(er.why) + '</div>' : '') + '</div>').join('') || '<div class="mb-empty">无</div>';
  }));
  pane.innerHTML = '<pre class="e-assist-pre">' + esc(x.origin) + '</pre>';
  bk.querySelector('#abBack').addEventListener('click', () => renderArchive());
}
// ---- 作文错题本 ----
function renderEBank() {
  const bk = document.getElementById('chatBooks');
  bk.classList.remove('hidden');
  const errs = essayErrs().slice().sort((a, b) => (b.n || 1) - (a.n || 1) || (b.last || 0) - (a.last || 0));
  const byCat = {};
  errs.forEach(x => { byCat[x.cat || '其他'] = (byCat[x.cat || '其他'] || 0) + (x.n || 1); });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  bk.innerHTML = '<div class="dpage-bar"><button class="ghost" id="ebBack">← 返回</button><span class="chat-title">' + icon('book-marked') + ' 作文错题本 · ' + errs.length + ' 条</span></div>' +
    '<div class="mb-list">' +
    (cats.length ? '<div class="tag-cloud">' + cats.map(c => '<span class="tag-chip">' + esc(c[0]) + '<i>' + c[1] + '</i></span>').join('') + '</div><div class="mb-hint">AI 归类的主要语言病灶 — 数字大 = 反复犯，下次写之前扫一眼</div>' : '<div class="mb-empty">还没有作文错题</div>') +
    errs.map((x, i) => '<div class="cerr-row"><div class="corr-line"><s>' + esc(x.en) + '</s> → <b>' + esc(x.fix) + '</b> <span class="corr-cat">' + esc(x.cat) + '</span>' + (x.n > 1 ? '<span class="corr-n">×' + x.n + '</span>' : '') + '</div>' +
      (x.why ? '<div class="corr-why">' + icon('lightbulb') + ' ' + esc(x.why) + '</div>' : '') +
      '<div class="corr-why ea-topic">出自：' + esc(x.topic || '—') + '</div>' +
      '<button class="cact" data-i="' + i + '">' + icon('trash-2') + '移除</button></div>').join('') +
    '</div>';
  bk.querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', () => {
    const l = essayErrs().slice().sort((a, bb) => (bb.n || 1) - (a.n || 1) || (bb.last || 0) - (a.last || 0));
    l.splice(+b.dataset.i, 1); saveEssayErrs(l); renderEBank();
  }));
  bk.querySelector('#ebBack').addEventListener('click', () => setChatMode(essayMode ? 'essay' : 'chat'));
}
// ---- 模式页签绑定 + 原「对话错题本」按钮改为打开聊天侧面板(保留) ----
document.querySelectorAll('.mode-tabs .mtab').forEach(b => b.addEventListener('click', () => setChatMode(b.dataset.m)));
const _oldClose = closeChat.toString();

// ===== 作文模式 end =====


// ===== 首页壳 (上日历+待办 / 下三模块) =====
const HOME_KEY = ['es','home_todos','v1'].join('_');
function todos() { try { return JSON.parse(localStorage.getItem(HOME_KEY) || '[]'); } catch (e) { return []; } }
function saveTodos(l) { localStorage.setItem(HOME_KEY, JSON.stringify(l.slice(0, 60))); }
let viewPick = 'home';
function goHome() { setView('home'); renderHome(); }
function setView(v) {
  viewPick = v;
  const study = v === 'study';
  document.getElementById('studyView').classList.toggle('hidden', !study);
  document.getElementById('homeView').classList.toggle('hidden', v !== 'home');

  if (v !== 'chat') {
    const ov = document.getElementById('chatOverlay');
    if (ov && !ov.classList.contains('hidden')) {
      ov.classList.add('hidden');
      document.body.classList.remove('dictate-open');
      document.getElementById('chatBooks').classList.add('hidden');
      document.getElementById('chatPop').classList.add('hidden');
      setChatMode('chat');
    }
  }
}
function homeCal7() {
  const today = todayStr();
  const days = [];
  for (let i = 0; i < 7; i++) days.push({ d: addDays(today, i), n: 0 });
  const m = getMem();
  for (const k in m) {
    const r = m[k];
    if (!r || !r.seen || r.master || !r.due) continue;
    const idx = r.due <= today ? 0 : days.findIndex(d => d.d === r.due);
    if (idx >= 0) days[idx].n++;
  }
  return days;
}
function renderHome() {
  const box = document.getElementById('homeView'); if (!box) return;
  if (box.dataset.init !== '1') {
    box.innerHTML =
      '<div class="hm-hero"><span class="hm-brand">' + icon('sparkles') + ' AI 英语学习舱</span><span class="hm-date" id="hmDate"></span></div>' +
      '<div class="hm-grid">' +
        '<div class="hm-cal card-h">' +
          '<div class="hm-cal-head"><span class="hm-cal-sub">' + icon('calendar') + ' 未来 7 天复习安排</span><span class="hm-grade-wrap">' + icon('book-open') + ' 年级 <select id="gradeSelect" class="hm-grade" title="决定 AI 用词难度与生词筛选线"><option value="">自动</option><option value="小学">小学</option><option value="初中">初中</option><option value="高一">高一</option><option value="高二">高二</option><option value="高三">高三</option><option value="大学">大学</option></select></span><button id="homeDailyBtn" class="hm-daily">' + icon('pen-line') + ' 每日自测</button></div>' +
          '<div class="hm-cal-week" id="hmWeek"></div>' +
          '<div class="hm-line" id="hmErrLine"></div>' +
          '<div class="hm-line" id="hmChatLine"></div>' +
          '<div class="hm-todo"><div class="hm-todo-head">' + icon('list-todo') + ' 我的待办</div>' +
            '<div class="hm-todo-add"><input id="hmTodoDate" type="date"><input id="hmTodoInp" placeholder="加一条待办（可选日期），回车确认" autocomplete="off"><button id="hmTodoAdd" class="cact">添加</button></div>' +
            '<div id="hmTodoList"></div></div>' +
        '</div>' +
        '<div class="hm-mods">' +
          '<div class="hm-card hm-shoot" id="hmGoShoot"><div class="hm-ic">' + icon('camera') + '</div><div class="hm-t"><b>即拍即学</b><span>拍照/文档 → 提词自评 → 背诵默写</span></div>' + icon('chevron-right') + '</div>' +
          '<div class="hm-card hm-chat" id="hmGoChat"><div class="hm-ic">' + icon('message-circle') + '</div><div class="hm-t"><b>即聊即学</b><span>AI 语伴聊天纠错 · 作文批改（含作文集）</span></div>' + icon('chevron-right') + '</div>' +
          '<div class="hm-card hm-read" id="hmGoRead"><div class="hm-ic">' + icon('book-open') + '</div><div class="hm-t"><b>即读即学</b><span>粘贴/图片 → 按水平生成英文 → 提炼背诵 · 理解出题</span></div>' + icon('chevron-right') + '</div>' +
        '</div>' +
      '</div>';
    box.dataset.init = '1';
    box.querySelector('#hmGoShoot').addEventListener('click', () => setView('study'));
    box.querySelector('#hmGoChat').addEventListener('click', openChat);
    box.querySelector('#hmGoRead').addEventListener('click', openRead);
    box.querySelector('#hmTodoAdd').addEventListener('click', homeAddTodo);
    box.querySelector('#homeDailyBtn').addEventListener('click', runDaily);
    try { const g = localStorage.getItem('***'); if (g) box.querySelector('#gradeSelect').value = g; } catch (e) {}
    box.querySelector('#gradeSelect').addEventListener('change', e => { localStorage.setItem('es_grade', e.target.value); showStatus(icon('circle-check') + ' 年级已设为 ' + (e.target.value || '自动') + ' — AI 用词与生词线随之调整'); });
    box.querySelector('#hmTodoInp').addEventListener('keydown', e => { if (e.key === 'Enter') homeAddTodo(); });
  }
  const d = new Date();
  box.querySelector('#hmDate').innerHTML = (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · 周' + ['日','一','二','三','四','五','六'][d.getDay()];
  const wk = ['日', '一', '二', '三', '四', '五', '六'];
  const todoByDay = {};
  todos().forEach(t => { if (!t.done) { const k = t.d || todayStr(); todoByDay[k] = (todoByDay[k] || 0) + 1; } });
  box.querySelector('#hmWeek').innerHTML = homeCal7().map((x, i) => {
    const dd = new Date(x.d + 'T00:00:00');
    const tn = todoByDay[x.d] || 0;
    return '<div class="hm-day' + (i === 0 ? ' today' : '') + '" data-d="' + x.d + '" title="点这天加待办"><span>' + wk[dd.getDay()] + '</span><b>' + dd.getDate() + '</b><i class="hm-dot' + (x.n ? ' on' : '') + '" title="' + x.n + ' 个词"></i><em>' + (x.n || '') + '</em>' + (tn ? '<u class="hm-td" title="' + tn + ' 条待办">' + tn + '</u>' : '') + '</div>';
  }).join('');
  box.querySelectorAll('.hm-day[data-d]').forEach(el => el.addEventListener('click', () => {
    const inp = document.getElementById('hmTodoDate'); if (inp) inp.value = el.dataset.d;
    const ti = document.getElementById('hmTodoInp'); if (ti) { ti.focus(); ti.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }));
  const mw = mistakeWords().length, ow = getOtherErrs().length;
  box.querySelector('#hmErrLine').innerHTML = icon('book-marked') + ' 错题本：<b>' + mw + '</b> 词 · <b>' + ow + '</b> 词组金句';
  let sessN = 0; try { sessN = chats().length; } catch (e) {}
  box.querySelector('#hmChatLine').innerHTML = icon('message-circle') + ' 聊天会话：<b>' + sessN + '</b> 个 · 批改与范文在「即聊即学」里';
  renderTodos();
}
function renderTodos() {
  const list = document.getElementById('hmTodoList'); if (!list) return;
  const today = todayStr();
  const l = todos().slice().sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    return String(a.d || today) < String(b.d || today) ? -1 : String(a.d || today) > String(b.d || today) ? 1 : (b.id - a.id);
  });
  list.innerHTML = l.length ? '' : '<div class="hm-todo-empty">暂无待办 — 点上方日历格可选日期添加</div>';
  let lastDay = null;
  l.forEach(t => {
    const d = t.d || today;
    if (d !== lastDay) {
      lastDay = d;
      const hd = document.createElement('div');
      hd.className = 'hm-todo-day' + (d === today ? ' now' : (d < today ? ' past' : ''));
      const dd = new Date(d + 'T00:00:00');
      hd.textContent = d === today ? '今天' : (d === addDays(today, 1) ? '明天' : (dd.getMonth() + 1) + '月' + dd.getDate() + '日 周' + ['日','一','二','三','四','五','六'][dd.getDay()]);
      list.appendChild(hd);
    }
    const row = document.createElement('div');
    row.className = 'hm-todo-row' + (t.done ? ' done' : '');
    row.innerHTML = '<input type="checkbox"' + (t.done ? ' checked' : '') + '><span>' + esc(t.text) + '</span><i class="hm-todo-x" title="删除">×</i>';
    row.querySelector('input').addEventListener('change', e => { const a = todos(); const it = a.find(x => x.id === t.id); if (it) it.done = e.target.checked; saveTodos(a); renderTodos(); renderHome(); });
    row.querySelector('.hm-todo-x').addEventListener('click', () => { saveTodos(todos().filter(x => x.id !== t.id)); renderTodos(); renderHome(); });
    list.appendChild(row);
  });
}
function homeAddTodo() {
  const inp = document.getElementById('hmTodoInp');
  const v = (inp.value || '').trim();
  if (!v) return;
  inp.value = '';
  const dv = (document.getElementById('hmTodoDate') || {}).value || todayStr();
  const a = todos(); a.unshift({ id: Date.now(), text: v.slice(0, 80), done: false, d: dv }); saveTodos(a); renderTodos(); renderHome();
}
goHome();
// 首页保鲜: 停留期间每分钟与切回页面时自动重算 (数据全本地, 零请求)
function hmAutoTick() { if (viewPick === 'home' && !document.hidden) renderHome(); }
setInterval(hmAutoTick, 60000);
document.addEventListener('visibilitychange', hmAutoTick);
window.addEventListener('focus', hmAutoTick);


// ===== 猫窝 (聚合收纳: 词书/错题本/对话错题本/作文集/作文错题本) =====
function nestData() {
  const errN = Object.values(getMem()).filter(r => r.seen && !r.master).length;
  let chatN = 0, sessN = 0;
  try { chatN = chatErrs().filter(x => !String(x.k || '').startsWith('@tag:')).length; sessN = chats().length; } catch (e) {}
  let esN = 0, ebN = 0;
  try { esN = essays().length; ebN = essayErrs().length; } catch (e) {}
  return [
    { ic: 'library', t: '词书库', s: '即拍 · 考纲/CEFR 词表翻看', n: 0, go: async () => { setView('study'); openSide(); } },
    { ic: 'book-marked', t: '背诵错题本', s: '即拍 · 单词词组金句 + 复习排程', n: errN, go: async () => { setView('study'); await openSide(); showLearningView(); } },
    { ic: 'message-circle', t: '对话错题本', s: '即聊 · 纠错/话题/金句', n: chatN, go: async () => { openChat(); openChatBooks(); } },
    { ic: 'pen-line', t: '作文集', s: '即聊 · 历篇批改回放', n: esN, go: async () => { openChat(); setChatMode('archive'); } },
    { ic: 'book-open', t: '作文错题本', s: '即聊 · 语言病灶分类', n: ebN, go: async () => { openChat(); setChatMode('bank'); } }
  ];
}
function openNest() {
  const pop = document.getElementById('nestPop');
  const l = nestData();
  pop.innerHTML = '<div class="np-head">' + icon('cat') + ' 猫窝 · 学习收纳</div>' +
    l.map((x, i) => '<div class="np-row" data-i="' + i + '">' + icon(x.ic) + '<div class="np-t"><b>' + esc(x.t) + '</b><span>' + esc(x.s) + '</span></div>' + (x.n ? '<em>' + x.n + '</em>' : '') + '<i class="np-go">' + icon('chevron-right') + '</i></div>').join('');
  pop.querySelectorAll('.np-row').forEach(r => r.addEventListener('click', () => { closeNest(); l[+r.dataset.i].go(); }));
  pop.classList.remove('hidden');
}
function closeNest() { document.getElementById('nestPop').classList.add('hidden'); }
$('#nestBtn').addEventListener('click', e => { e.stopPropagation(); const pop = document.getElementById('nestPop'); if (pop.classList.contains('hidden')) openNest(); else closeNest(); });
document.addEventListener('click', e => { const pop = document.getElementById('nestPop'); if (!pop.classList.contains('hidden') && !pop.contains(e.target) && e.target.id !== 'nestBtn') closeNest(); });

// ===== 即读即学 (Read) =====
const RD_LV = { A1: 'A1 入门', A2: 'A2 基础', B1: 'B1 进阶', B2: 'B2 流利', C1: 'C1 高级' };
const rd = { text: '', out: '', level: '', shotBusy: false };
function rdGradeLevel() {
  const g = (document.getElementById('gradeSelect') || {}).value || localStorage.getItem('es_grade') || '';
  return { 小学: 'A1', 初中: 'A2', 高一: 'B1', 高二: 'B2', 高三: 'B2', 大学: 'C1' }[g] || 'B1';
}
function openRead() {
  document.getElementById('readOverlay').classList.remove('hidden');
  document.body.classList.add('dictate-open');
  renderRead();
}
function closeRead() {
  document.getElementById('readOverlay').classList.add('hidden');
  document.body.classList.remove('dictate-open');
}
function rdBusy(on, msg) {
  const b = document.getElementById('readBody');
  let el = b.querySelector('.rd-busy');
  if (on) { if (!el) { el = document.createElement('div'); el.className = 'rd-busy'; b.appendChild(el); } el.innerHTML = icon('hourglass') + ' ' + esc(msg); el.querySelector('.licon').style.animation = 'lic-spin 1.2s linear infinite'; }
  else if (el) el.remove();
}
function renderRead() {
  const b = document.getElementById('readBody');
  const lv = rd.level || rdGradeLevel();
  b.innerHTML =
    '<div class="rd-tabs"><button class="mb-tab on">' + icon('languages') + ' 读什么学什么</button></div>' +
    '<textarea id="rdText" class="rd-input" placeholder="粘贴中文或英文素材… 中文会按你的水平译成英文，英文则按水平改写调整难度">' + esc(rd.text) + '</textarea>' +
    '<div class="rd-row"><span class="rd-lv">' + icon('sparkles') + ' 理解难度 <select id="rdLv">' + Object.entries(RD_LV).map(x => '<option value="' + x[0] + '"' + (x[0] === lv ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select><span class="rd-hint" style="margin:0">默认随年级</span></span></div>' +
    '<div class="rd-row">' +
    '<button class="rd-btn primary" id="rdGo">' + icon('languages') + '生成英文文本</button>' +
    '<button class="rd-btn" id="rdExtract"' + (rd.out ? '' : ' disabled') + '>' + icon('sparkles') + '一键提炼背诵清单</button>' +
    '<button class="rd-btn" id="rdQuiz"' + (rd.out ? '' : ' disabled') + '>' + icon('file-question') + '一键生成理解题</button>' +
    '</div>' +
    (rd.out ? '<div class="rd-out" id="rdOut"></div>' : '') +
    '<div id="rdZone"></div>';
  b.querySelector('#rdText').addEventListener('input', e => { rd.text = e.target.value; });
  b.querySelector('#rdLv').addEventListener('change', e => { rd.level = e.target.value; });
  b.querySelector('#rdGo').addEventListener('click', rdTranslate);
  b.querySelector('#rdExtract').addEventListener('click', rdExtract);
  b.querySelector('#rdQuiz').addEventListener('click', rdQuiz);
  if (rd.out) { const o = b.querySelector('#rdOut'); o.innerHTML = rdRenderHard(rd.out); bindHardWords(o); }
}
function rdRenderHard(text) {
  // 超纲词虚线标注 (本地词书, 与即拍同一套判定)
  try {
    const hw = chatHardWords(text, (document.getElementById('gradeSelect') || {}).value || null);
    let html = esc(text);
    for (const x of hw) {
      const re = new RegExp('\\b' + x.w.replace(/[^A-Za-z']/g, '') + '\\b');
      if (re.test(html)) html = html.replace(re, '<span class="chard" data-w="' + esc(x.w.toLowerCase()) + '" data-l="' + esc(x.level || '') + '" data-z="' + esc(x.zh || '') + '">' + x.w + '</span>');
    }
    return html;
  } catch (e) { return esc(text); }
}
function bindHardWords(root) {
  root.querySelectorAll('.chard').forEach(el => el.addEventListener('click', () => rdPopShow(el, el.dataset.w, el.dataset.l, el.dataset.z)));
}
function rdPopShow(anchor, w, level, zh) {
  let pop = document.getElementById('rdPop');
  if (!pop) { pop = document.createElement('div'); pop.id = 'rdPop'; pop.className = 'chat-pop'; document.querySelector('.read-shell').appendChild(pop); }
  const m = memRec(w);
  pop.innerHTML = '<div class="cp-head"><b>' + esc(w) + '</b>' + (level ? '<span class="cp-lv">' + esc(level) + '</span>' : '') + '</div>' +
    (zh ? '<div class="cp-zh">' + esc(zh) + '</div>' : '') +
    '<div class="cp-btns"><button class="cact" data-a="mark">' + icon('plus') + '标为生词</button>' + (m ? '<span class="cp-state">' + (m.master ? '已在错题本(掌握)' : '已在错题本' + (m.due ? ' · ' + m.due : '')) + '</span>' : '') + '</div>';
  pop.dataset.keep = '1';
  const r = anchor.getBoundingClientRect();
  const wrap = document.querySelector('.read-shell').getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left - wrap.left, wrap.width - 240)) + 'px';
  pop.style.top = (r.top - wrap.top - 8) + 'px';
  pop.classList.remove('hidden');
  pop.querySelector('[data-a=mark]').addEventListener('click', () => {
    memConfirmWord(w, zh || '');
    pop.classList.add('hidden');
    rdToast('已加入错题本，排入复习计划');
  });
}
document.addEventListener('click', e => {
  const pop = document.getElementById('rdPop');
  if (pop && !pop.classList.contains('hidden') && !pop.contains(e.target) && !e.target.closest('.chard')) pop.classList.add('hidden');
});
async function rdTranslate() {
  const t = (rd.text || '').trim();
  if (!t) { rdToast('先粘贴或识别一些内容'); return; }
  rdBusy(true, 'AI 按 ' + rd.level + ' 水平生成英文…');
  try {
    const j = await (await fetch('/api/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'translate', text: t, level: rd.level || rdGradeLevel() }) })).json();
    if (!j.ok) throw new Error(j.error || '失败');
    rd.out = j.result; rd.level = j.level;
    renderRead();
    rdToast('已生成 ' + j.level + ' 级英文 · ' + j.timeMs + 'ms');
  } catch (e) { rdToast('生成失败: ' + e.message); }
  rdBusy(false);
}
async function rdExtract() {
  if (!rd.out) return;
  setView('study');
  textInput.value = rd.out;
  showStatus(icon('hourglass') + ' 从即读文本提炼中…');
  extract();
}
async function rdQuiz() {
  if (!rd.out) return;
  const zone = document.getElementById('rdZone');
  zone.innerHTML = '<div class="rd-busy">' + icon('hourglass') + ' AI 出题中…</div>';
  try {
    const j = await (await fetch('/api/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'quiz', text: rd.out }) })).json();
    if (!j.ok) throw new Error(j.error || '失败');
    if (!j.questions.length) { zone.innerHTML = '<div class="rd-hint">这次没出成题，再点一次试试</div>'; return; }
    zone.innerHTML = '<h3 style="margin:14px 0 8px">' + icon('file-question') + ' 理解检测</h3>';
    j.questions.forEach((q, qi) => {
      const card = document.createElement('div');
      card.className = 'rd-q';
      card.innerHTML = '<b>' + (qi + 1) + '. ' + esc(q.q) + '</b>' +
        q.options.map((o, oi) => '<span class="rd-opt" data-q="' + qi + '" data-o="' + oi + '">' + 'ABCD'[oi] + '. ' + esc(o) + '</span>').join('') +
        '<div class="rd-why">' + icon('lightbulb') + ' ' + esc(q.why || '解析见原文关键句') + '</div>';
      card.querySelectorAll('.rd-opt').forEach(op => op.addEventListener('click', () => {
        if (card.dataset.done) return;
        card.dataset.done = '1';
        const oi = +op.dataset.o;
        op.classList.add(oi === q.answer ? 'right' : 'wrong');
        card.querySelectorAll('.rd-opt')[q.answer].classList.add('right');
        card.querySelector('.rd-why').classList.add('show');
      }));
      zone.appendChild(card);
    });
  } catch (e) { zone.innerHTML = '<div class="rd-hint">出题失败: ' + esc(e.message) + '</div>'; }
}
function rdToast(msg) {
  let el = document.getElementById('rdToast');
  if (!el) { el = document.createElement('div'); el.id = 'rdToast'; el.className = 'rd-toast'; document.querySelector('.read-shell').appendChild(el); }
  el.innerHTML = icon('circle-check') + ' ' + esc(msg);
  el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2600);
}
// 截屏 / 图片 / 文档
$('#readImg').addEventListener('click', () => document.getElementById('readFile').click());
$('#readFile').addEventListener('change', async () => {
  const f = document.getElementById('readFile').files[0];
  if (!f) return;
  document.getElementById('readFile').value = '';
  const b64 = await new Promise((ok, no) => { const rd2 = new FileReader(); rd2.onload = () => ok(String(rd2.result).split(',')[1]); rd2.onerror = no; rd2.readAsDataURL(f); });
  rdToast('');
  const el = document.getElementById('rdToast');
  el.innerHTML = icon('hourglass') + ' 解析 ' + esc(f.name) + ' …'; el.classList.add('show');
  try {
    const j = await (await fetch('/api/file-text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name, data: b64 }) })).json();
    if (!j.text || !j.text.trim()) throw new Error('未识别到文字');
    rd.text = (rd.text ? rd.text + String.fromCharCode(10) : '') + j.text.trim();
    renderRead();
    el.innerHTML = icon('circle-check') + ' 已导入 ' + j.text.trim().length + ' 字';
    clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2400);
  } catch (e) { el.innerHTML = icon('x-circle') + ' ' + esc(e.message); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 3000); }
});
$('#readClose').addEventListener('click', () => { closeRead(); goHome(); });
// ===== 全局化: 积累本/词书 不绑定视图 (后声明覆盖旧函数) =====
function openAcc(mode) {
  var bk = document.getElementById('chatBooks');
  bk.classList.remove('hidden');
  document.getElementById('accOverlay').classList.remove('hidden');
  if (mode === 'archive') renderArchive();
  else if (mode === 'bank') renderEBank();
  else { renderCbTabs(); renderCbList(); }
}
function closeAcc() { document.getElementById('accOverlay').classList.add('hidden'); }
function openChatBooks() { openAcc('cb'); }
var _oldSetChatMode = setChatMode;
setChatMode = function (m) {
  if (m === 'archive') { openAcc('archive'); return; }
  if (m === 'bank') { openAcc('bank'); return; }
  _oldSetChatMode(m);
};
function nestData() {
  const errN = Object.values(getMem()).filter(r => r.seen && !r.master).length;
  let chatN = 0;
  try { chatN = chatErrs().filter(x => !String(x.k || '').startsWith('@tag:')).length; } catch (e) {}
  let esN = 0, ebN = 0;
  try { esN = essays().length; ebN = essayErrs().length; } catch (e) {}
  return [
    { ic: 'library', t: '词书库', s: '考纲/CEFR 词表翻看 · 任何页面可开', n: 0, go: () => { openSide(); } },
    { ic: 'book-marked', t: '背诵错题本', s: '单词词组金句 + 复习排程', n: errN, go: async () => { await openSide(); showLearningView(); } },
    { ic: 'message-circle', t: '对话错题本', s: '聊天纠错 / 话题 / 金句', n: chatN, go: () => openAcc('cb') },
    { ic: 'pen-line', t: '作文集', s: '历篇批改回放', n: esN, go: () => openAcc('archive') },
    { ic: 'book-open', t: '作文错题本', s: '语言病灶分类', n: ebN, go: () => openAcc('bank') }
  ];
}
$('#chatBooksBtn').addEventListener('click', () => openAcc('cb'));
// 捕获阶段抢先接管积累本浮层的返回按钮 (阻止旧内联绑定的切视图语义)
document.addEventListener('click', e => {
  const b = e.target && e.target.closest ? e.target.closest('#cbBack, #abBack, #ebBack') : null;
  if (!b) return;
  e.stopPropagation();
  const txt = String(b.textContent || '');
  if (b.id === 'abBack' && txt.indexOf('作文集') >= 0) { renderArchive(); return; }
  closeAcc();
}, true);

// ===== 人设 (native / cat) =====
function getPersona() { try { return localStorage.getItem('es_persona') || 'native'; } catch (e) { return 'native'; } }
function renderPersonaBtn() {
  var bar = document.querySelector('.chat-wrap .dpage-bar'); if (!bar) return;
  var b = document.getElementById('personaBtn');
  if (!b) {
    b = document.createElement('button');
    b.id = 'personaBtn'; b.className = 'ghost persona-btn';
    b.addEventListener('click', () => {
      var next = getPersona() === 'cat' ? 'native' : 'cat';
      localStorage.setItem('es_persona', next);
      renderPersonaBtn();
      showStatus(icon('circle-check') + (next === 'cat' ? '猫猫语伴已上线 miao~ 下一条消息生效' : '已切回英语语伴'));
    });
    bar.insertBefore(b, document.getElementById('chatBooksBtn') || null);
  }
  var cat = getPersona() === 'cat';
  b.innerHTML = icon('cat') + (cat ? '猫猫语伴 · 生效中，点击切回语伴' : '猫猫语伴 · 点击切换');
}
renderPersonaBtn();
