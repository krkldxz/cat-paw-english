// 英语背诵工具 - 本地后端 v1
// 零依赖 Node: 静态托管 + /api/extract (文本 → gemma4 五板块提取)
// 启动: node server.js  →  http://127.0.0.1:8804
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8804;
const MODEL = 'gemma4-e2b-q4';
// 推理引擎: 优先 llama.cpp 内置引擎(自包含), 备用 Ollama
const ENGINE_PORT = 8080; // llama-server 端口
const LLAMA_URL = `http://127.0.0.1:${ENGINE_PORT}`;
const OLLAMA_URL = 'http://127.0.0.1:11434/api/chat';
const ROOT = __dirname;

// ===== 上海考纲词书已按版权要求移除: 不再内置、不再加载 (需要时用「添加词书」自行导入自有词书) =====
const BOOK = null;

function buildBookIndex(book) {
  const info = {}; // lowerWord -> 词书条目
  if (!book) return { info: {}, phraseKeys: new Set() };
  for (const it of book.words || []) {
    const w = String(it.word || '').trim();
    if (!w) continue;
    const lower = w.toLowerCase();
    const main = lower.replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
    if (main && !info[main]) info[main] = it;
    if (!info[lower]) info[lower] = it;
    const inners = lower.match(/\(([^)]+)\)/g) || [];
    for (const m of inners) {
      const t = m.slice(1, -1).toLowerCase().trim();
      if (t && !t.includes(' ') && !info[t]) info[t] = it;
    }
  }
  const phraseKeys = new Set();
  for (const p of book.phrases || []) {
    const s = String(p.phrase || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
    if (s) phraseKeys.add(s);
    phraseKeys.add(String(p.phrase || '').toLowerCase().trim());
  }
  return { info, phraseKeys };
}

const BOOK_INDEX = buildBookIndex(BOOK);
const normPhrase = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();

// ===== CEFR 分级词书 (第二套标准) =====
let CEFR = null;
try {
  CEFR = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'data', '词书-CEFR.json'), 'utf8'));
  console.log(`[CEFR] ${CEFR.name} | ${CEFR.word_count} 词头`);
} catch (e) {
  console.log('[CEFR] 加载失败:', e.message);
}
const CEFR_INDEX = {};
if (CEFR) for (const w of CEFR.words) CEFR_INDEX[String(w.word || '').toLowerCase()] = w;
// ===== 四六级词书 (moread 词表 + ECDICT 聚合: 音标/释义/词性/词频) =====
function loadCet(file) {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'data', file), 'utf8'));
    const index = {};
    for (const w of b.words || []) { const k = String(w.word || '').toLowerCase(); if (k) index[k] = w; }
    console.log('[词书] ' + b.name + ' | ' + b.word_count + ' 词 (释义命中 ' + (b.join_hit || '?') + ')');
    return { book: b, index };
  } catch (e) { console.log('[词书] ' + file + ' 加载失败:', e.message); return null; }
}
const CET4 = loadCet('词书-CET4.json');
const CET6 = loadCet('词书-CET6.json');
const CET_BOOKS = { cet4: CET4, cet6: CET6 };

// ===== 词书注册表 (通用): 内置词书 + 用户导入(data/books/*.json) + 主词书切换 =====
const DATA_DIR = path.join(ROOT, '..', 'data');
const USER_BOOK_DIR = path.join(DATA_DIR, 'books');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) || {}; } catch (e) { return {}; }
}
function writeSettings(patchObj) {
  const next = Object.assign({}, readSettings(), patchObj || {});
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 1), 'utf8');
  return next;
}
const BOOKS = new Map(); // id -> 记录
let PRIMARY_ID = '';
function slugId(s) {
  const t = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return t || '';
}
function inferKind(book, fallback) {
  if (book && book.kind) return book.kind;
  const w = ((book && book.words) || [])[0];
  if (w && (w.minLevel || w.entries)) return 'cefr';
  if (book && (book.phrases || []).length) return 'kaogang';
  return fallback || 'list';
}
function registerBook(id, book, kind, origin, file, short) {
  const idx = buildBookIndex(book);
  const words = book.words || [];
  const first = words[0] || null;
  const k = kind || inferKind(book, 'list');
  const rec = {
    id: id, name: book.name || id, kind: k, origin: origin, file: file || "",
    wordCount: book.word_count || words.length,
    phraseCount: book.phrase_count || (book.phrases || []).length,
    leveled: !!(first && (first.minLevel || first.entries)),
    short: short || (k === 'cefr' ? 'CEFR' : (book.name || id)),
    source: book.source || '', license: book.license || '',
    book: book, index: idx
  };
  BOOKS.set(id, rec);
  return rec;
}
const BUILTIN_BOOKS = [
  { id: 'cefr', file: '词书-CEFR.json', kind: 'cefr', short: 'CEFR' },
  { id: 'cet4', file: '词书-CET4.json', kind: 'cet', short: 'CET4' },
  { id: 'cet6', file: '词书-CET6.json', kind: 'cet', short: 'CET6' }
];
function loadAllBooks() {
  BOOKS.clear();
  for (const b of BUILTIN_BOOKS) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, b.file), 'utf8'));
      const rec = registerBook(b.id, j, b.kind, 'builtin', b.file, b.short);
      console.log('[词书] ' + b.id + ' | ' + rec.name + ' | ' + rec.wordCount + ' 词');
    } catch (e) { console.log('[词书] ' + b.file + ' 未随仓库分发(可选词书, 非错误)'); }
  }
  // 自动发现 data/词书-*.json (不在内置清单里的, 如 词书-高考.json / 词书-中考.json)
  const builtinFiles = new Set(BUILTIN_BOOKS.map(b => b.file));
  const LVL_SHORT = { GK: "高考", ZK: "中考", CET4: "CET4", CET6: "CET6", CEFR: "CEFR" };
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!/^词书-.+\.json$/.test(f) || builtinFiles.has(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
        const id = slugId(j.id || j.level || j.name || f);
        if (!id || BOOKS.has(id)) { console.log("[词书] 跳过(无 id 或冲突): " + f); continue; }
        const rec = registerBook(id, j, inferKind(j, "list"), "builtin", f, LVL_SHORT[String(j.level || "").toUpperCase()]);
        console.log("[词书] 发现 | " + id + " | " + rec.name + " | " + rec.wordCount + " 词");
      } catch (e) { console.log("[词书] " + f + " 解析失败:", e.message); }
    }
  } catch (e) { console.log("[词书] data 目录扫描失败:", e.message); }

  try {
    if (!fs.existsSync(USER_BOOK_DIR)) fs.mkdirSync(USER_BOOK_DIR, { recursive: true });
    for (const f of fs.readdirSync(USER_BOOK_DIR)) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(USER_BOOK_DIR, f), 'utf8'));
        const id = slugId(j.id || j.name || f);
        if (!id) continue;
        if (BOOKS.has(id)) { console.log('[词书] 用户词书 id 冲突, 跳过:', f); continue; }
        const rec = registerBook(id, j, inferKind(j, 'list'), 'user', 'books/' + f);
        console.log('[词书] 用户导入 | ' + id + ' | ' + rec.name + ' | ' + rec.wordCount + ' 词');
      } catch (e) { console.log('[词书] 用户词书解析失败:', f, e.message); }
    }
  } catch (e) { console.log('[词书] 用户词书目录读取失败:', e.message); }
  const st = readSettings();
  const want = (st.primaryBook && BOOKS.has(st.primaryBook)) ? st.primaryBook : (BOOKS.has('gk') ? 'gk' : (BOOKS.keys().next().value || ''));
  PRIMARY_ID = want;
  const p = BOOKS.get(PRIMARY_ID);
  if (p) console.log('[词书] 主词书 = ' + PRIMARY_ID + ' (' + p.name + ')');
}
function primaryIndex() { const p = BOOKS.get(PRIMARY_ID); return p ? p.index : BOOK_INDEX; }
function bookBrief(rec) {
  return { id: rec.id, name: rec.name, wordCount: rec.wordCount, phraseCount: rec.phraseCount,
    kind: rec.kind, primary: rec.id === PRIMARY_ID, removable: rec.origin === "user",
    source: rec.source || "", license: rec.license || "" };
}

// 通用词表扫描 (音标/释义型词书; 算法同原 scanCet)
function scanList(text, rec) {
  const tokens = (String(text || '').toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || []);
  const idx = (rec.index && rec.index.info) || {};
  const found = new Map();
  for (const t of tokens) {
    if (STOP.has(t) || t.length < 2) continue;
    const cands = [t];
    if (t.endsWith('ies')) cands.push(t.slice(0, -3) + 'y');
    if (t.endsWith('es')) cands.push(t.slice(0, -2));
    if (t.endsWith('s')) cands.push(t.slice(0, -1));
    if (t.endsWith('ied')) cands.push(t.slice(0, -3) + 'y');
    if (t.endsWith('ed')) cands.push(t.slice(0, -2), t.slice(0, -1));
    if (t.endsWith('ing')) cands.push(t.slice(0, -3), t.slice(0, -3) + 'e');
    for (const cand of cands) {
      const hit = idx[cand];
      if (!hit) continue;
      const key = String(hit.word).toLowerCase().trim();
      const rec2 = found.get(key) || { word: String(hit.word).trim(), cefr: null, count: 0,
        meaning: String(hit.meaning || '').replace(/\n/g, '；'), phonetic: hit.phonetic || '', pos: hit.pos || '' };
      rec2.count++;
      found.set(key, rec2);
      break;
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count);
}

// 通用分级扫描 (带 A1-C2 级别的词书; 算法同原 scanCefr)
function scanLeveled(text, rec, grade) {
  const tokens = (String(text || '').toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || []);
  const keep = KEEP_LINE[grade] || 'B1';
  const nKeep = LVL_N[keep];
  const idx = (rec.index && rec.index.info) || {};
  const out = new Map();
  for (const t of tokens) {
    if (STOP.has(t) || t.length < 2) continue;
    const cands = [t];
    if (t.endsWith('ies')) cands.push(t.slice(0, -3) + 'y');
    if (t.endsWith('es')) cands.push(t.slice(0, -2));
    if (t.endsWith('s')) cands.push(t.slice(0, -1));
    if (t.endsWith('ied')) cands.push(t.slice(0, -3) + 'y');
    if (t.endsWith('ed')) cands.push(t.slice(0, -2), t.slice(0, -1));
    if (t.endsWith('ing')) cands.push(t.slice(0, -3), t.slice(0, -3) + 'e');
    for (const cand of cands) {
      const hit = idx[cand];
      if (!hit) continue;
      const key = String(hit.word).toLowerCase().replace(/\(.*?\)/g, '').trim();
      if (primaryIndex().info[key] || primaryIndex().info[cand]) break; // 已在主词书 → 交给主词书层
      if (!hit.maxLevel || LVL_N[hit.maxLevel] < nKeep) break; // 只排除确定入门词
      const rec2 = out.get(key) || { word: String(hit.word).trim(), count: 0, meaning: hit.meaning || "",
        cefr: { min: hit.minLevel, max: hit.maxLevel } };
      rec2.count++;
      out.set(key, rec2);
      break;
    }
  }
  return [...out.values()].sort((a, b) => b.count - a.count);
}

// 纯文本词表解析: 每行 一个词 / 词+制表符+释义 / 词 多个空格 释义 / 词:释义
function parseTextWordList(text) {
  const words = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z][A-Za-z'\u2019\- ]{0,40}?)(?:\t+|\s{2,}|[\s:：,，|]+)(.+)$/);
    let w = m ? m[1] : line;
    let mean = m ? m[2] : "";
    w = String(w).trim();
    if (!/^[A-Za-z]/.test(w)) continue;
    words.push({ word: w, meaning: String(mean || "").trim() });
  }
  return words;
}

// 从 PDF 词汇手册导入词书: 接收 base64 → 临时文件 → scripts/book_from_pdf.py → 复用 importBook
async function importBookFromPdf(payload) {
  if (!PY_RESOLVED) throw new Error('本机未找到 Python, PDF 解析不可用 (可改用 JSON 词书或纯文本词表)');
  const b64 = String(payload.pdfBase64 || '').replace(/^data:application\/pdf;base64,/, '');
  if (!b64) throw new Error('缺少 PDF 内容');
  const tmpDir = path.join(ROOT, '..', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const stamp = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const pdfPath = path.join(tmpDir, 'book_' + stamp + '.pdf');
  const outPath = path.join(tmpDir, 'book_' + stamp + '.json');
  fs.writeFileSync(pdfPath, Buffer.from(b64, 'base64'));
  try {
    const { execFile } = require('child_process');
    const script = path.join(__dirname, '..', 'scripts', 'book_from_pdf.py');
    await new Promise((ok, no) => {
      execFile(PY_RESOLVED, [script, pdfPath, '--max', '20000', '--out', outPath], { timeout: 240000, maxBuffer: 1 << 26 },
        (err, so, se) => err ? no(new Error('解析失败: ' + String(se || err.message).slice(0, 200))) : ok());
    });
    if (!fs.existsSync(outPath)) throw new Error('解析未产出结果');
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    if (parsed.type === 'scan') throw new Error('这是扫描版 PDF(没有文字层), 无法直接解析 —— 请改用「拍照」逐页识别, 或换文字版 PDF');
    if (parsed.type !== 'ok' || !(parsed.words || []).length) throw new Error('没从 PDF 里解析出词条: ' + (parsed.reason || '未知原因'));
    const name = String(payload.name || '').trim() || String(payload.filename || 'PDF 词书').replace(/\.pdf$/i, '');
    const r = importBook({
      name: name, words: parsed.words,
      source: 'PDF 导入: ' + String(payload.filename || ''), license: '用户自备',
    });
    const st = parsed.stats || {};
    console.log('[词书] PDF 导入 | ' + r.name + ' | ' + r.wordCount + ' 词 (页数 ' + st.pages + ', 来源 ' + st.used + ')');
    r.pdfStats = st;
    return r;
  } finally {
    try { fs.unlinkSync(pdfPath); } catch (e) {}
    try { fs.unlinkSync(outPath); } catch (e) {}
  }
}
// 添加词书: 支持 JSON 词书 / 纯文本词表, 写入 data/books/<id>.json
function importBook(payload) {
  const name = String(payload.name || '').trim() || '导入词书';
  let words = [], phrases = [], book = null;
  const content = payload.content;
  if (payload.json && typeof payload.json === "object") book = payload.json;
  else if (Array.isArray(payload.words)) words = payload.words;
  else if (typeof content === "string") {
    const t = content.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try { book = JSON.parse(t); } catch (e) { throw new Error("JSON 解析失败: " + e.message); }
    } else words = parseTextWordList(t);
  } else if (content && typeof content === "object") book = content;
  if (book) {
    if (Array.isArray(book)) words = book;
    else { words = book.words || []; phrases = book.phrases || []; }
  }
  const norm = [];
  const seenW = new Set();
  for (const w of words) {
    let word = "", mean = "", extra = null;
    if (typeof w === "string") { word = w.trim(); }
    else if (w && typeof w === "object") {
      word = String(w.word || w.headword || "").trim();
      mean = String(w.meaning || w.meaning_zh || w.translation || "").trim();
      extra = w;
    }
    if (!word || !/^[A-Za-z]/.test(word)) continue;
    const k = word.toLowerCase();
    if (seenW.has(k)) continue;
    seenW.add(k);
    if (extra) norm.push(Object.assign({}, extra, { word: word, meaning: mean }));
    else norm.push({ word: word, meaning: mean });
  }
  if (!norm.length) throw new Error("没解析到单词（JSON 需 words 数组；纯文本每行一个词，可用制表符/多个空格/冒号分隔释义）");
  if (norm.length > 20000) throw new Error("词书过大（上限 20000 词）: " + norm.length);
  const id = slugId(payload.id || name);
  if (!id) throw new Error("无法生成词书 id，请用含字母数字的名称");
  if (BUILTIN_BOOKS.some(b => b.id === id)) throw new Error("id 与内置词书冲突，请改名: " + id);
  const rec = {
    id: id, name: name, kind: "list", level: payload.level || "CUSTOM",
    source: payload.source || "用户导入", license: payload.license || "用户自备",
    imported_at: new Date().toISOString(),
    word_count: norm.length, phrase_count: (phrases || []).length,
    words: norm, phrases: phrases || []
  };
  if (!fs.existsSync(USER_BOOK_DIR)) fs.mkdirSync(USER_BOOK_DIR, { recursive: true });
  fs.writeFileSync(path.join(USER_BOOK_DIR, id + ".json"), JSON.stringify(rec), "utf8");
  return registerBook(id, rec, "list", "user", "books/" + id + ".json");
}
loadAllBooks();
const LVL_N = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };
// 保留线(宁多勿少): 只排除"学生一定会"的入门词(低于年级一档以上)
// 高一保 A2+ / 高二高三保 B1+ / 大学保 B2+ / 初中以下几乎不筛; 熟词僻义与表外词不受此限
const KEEP_LINE = { 小学: 'A1', 初中: 'A1', 高一: 'A2', 高二: 'B1', 高三: 'B1', 大学: 'B2' };

// 单词筛选: 考纲词书(归属) + CEFR(保留线) 双标准; 词组/句子不筛
function annotate(data, grade) {
  if (!data) return data;
  const keep = KEEP_LINE[grade] || null;
  const nKeep = keep ? LVL_N[keep] : null;
  const info = primaryIndex().info;
  const out = [];
  for (const v of data.vocabulary || []) {
    const w = String(v.word || '').trim().toLowerCase();
    const w2 = w.replace(/\s+.*$/, '');
    // ① 考纲归属
    const hit = info[w] || info[w2];
    if (hit) { v.scope = '考纲'; if (!v.book_meaning && hit.meaning) v.book_meaning = hit.meaning; }
    else v.scope = '拓展';
    // ② CEFR 级别 (表外词视为超表高级, 不筛)
    const c = CEFR_INDEX[w] || CEFR_INDEX[w2];
    v.cefr = c ? { min: c.minLevel, max: c.maxLevel } : null;
    // ③ 保留线: 仅当整词最高级都低于保留线才排除(入门词); 熟词僻义保留
    if (nKeep && c) {
      if (LVL_N[c.maxLevel] < nKeep) continue; // 一定会的入门词 → 排除
      if (LVL_N[c.minLevel] < nKeep && LVL_N[c.maxLevel] >= nKeep) v.tag = '熟词僻义';
    }
    out.push(v);
  }
  return { ...data, vocabulary: out };
}

// 考纲词书机械扫描: 确定性比对全文单词 vs 词书, 不依赖模型记忆
const STOP = new Set(('the a an of and to in is are was were be been for on with at by as it its this that these those we you he she they i not no but or from up down out off over under into than so if then when while our your their his her my me us them him can could will would shall should may might must do does did have has had there here what which who whom whose why how all any some each every both other such only own same too very just also more most much many about after before between during through against because although though since until once don ve ll re m').split(' '));
function scanBook(text, grade) {
  const tokens = (String(text || '').toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || []);
  const keep = KEEP_LINE[grade] || null;
  const nKeep = keep ? LVL_N[keep] : null;
  const info = primaryIndex().info;
  const found = new Map();
  for (const t of tokens) {
    if (STOP.has(t) || t.length < 2) continue;
    const cands = [t];
    if (t.endsWith('ies')) cands.push(t.slice(0, -3) + 'y');
    if (t.endsWith('es')) cands.push(t.slice(0, -2));
    if (t.endsWith('s')) cands.push(t.slice(0, -1));
    if (t.endsWith('ied')) cands.push(t.slice(0, -3) + 'y');
    if (t.endsWith('ed')) cands.push(t.slice(0, -2), t.slice(0, -1));
    if (t.endsWith('ing')) cands.push(t.slice(0, -3), t.slice(0, -3) + 'e');
    for (const cand of cands) {
      const hit = info[cand];
      if (!hit) continue;
      const key = String(hit.word).toLowerCase().replace(/\(.*?\)/g, '').trim();
      const c = CEFR_INDEX[key] || CEFR_INDEX[cand];
      const lvl = c ? { min: c.minLevel, max: c.maxLevel } : null;
      if (nKeep && lvl && LVL_N[lvl.max] < nKeep) break; // 只排除确定入门词, 数量不设限
      const rec = found.get(key) || { word: String(hit.word).trim(), cefr: lvl, count: 0, meaning: hit.meaning || '' };
      rec.count++;
      found.set(key, rec);
      break;
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count);
}

// CEFR 词书扫描: 文中出现且 CEFR ≥ 保留线、不在考纲书的词 (作为分级候选; 无中文释义)
function scanCefr(text, grade) {
  const tokens = (String(text || '').toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || []);
  const keep = KEEP_LINE[grade] || 'B1';
  const nKeep = LVL_N[keep];
  const out = new Map();
  for (const t of tokens) {
    if (STOP.has(t) || t.length < 2) continue;
    const cands = [t];
    if (t.endsWith('ies')) cands.push(t.slice(0, -3) + 'y');
    if (t.endsWith('es')) cands.push(t.slice(0, -2));
    if (t.endsWith('s')) cands.push(t.slice(0, -1));
    if (t.endsWith('ied')) cands.push(t.slice(0, -3) + 'y');
    if (t.endsWith('ed')) cands.push(t.slice(0, -2), t.slice(0, -1));
    if (t.endsWith('ing')) cands.push(t.slice(0, -3), t.slice(0, -3) + 'e');
    for (const cand of cands) {
      const hit = CEFR_INDEX[cand];
      if (!hit) continue;
      const key = String(hit.word).toLowerCase().replace(/\(.*?\)/g, '').trim();
      if (primaryIndex().info[key] || primaryIndex().info[cand]) break; // 已在考纲书 → 交给考纲层
      if (LVL_N[hit.maxLevel] < nKeep) break; // 只排除确定入门词
      const rec = out.get(key) || { word: String(hit.word).trim(), cefr: { min: hit.minLevel, max: hit.maxLevel }, meaning: hit.meaning || '', count: 0 };
      rec.count++;
      out.set(key, rec);
      break;
    }
  }
  return [...out.values()].sort((a, b) => b.count - a.count);
}

// 硬性候选条件: 主用法达年级线(min≥keep) 或 有超年级一档的义项(max≥keep+1, 熟词僻义场景); 表外词默认收
function passKeep(c, nKeep) {
  if (!nKeep) return true;      // 无年级(自动): 不设限
  if (!c || !c.minLevel || !c.maxLevel) return true; // 级别表外 → 收
  const nMin = LVL_N[c.minLevel], nMax = LVL_N[c.maxLevel];
  return nMin >= nKeep || nMax >= nKeep + 1;
}

// 自评候选: 考纲词全量(词书扫描) + 模型提取的拓展词; 每条带语境句, 释义由学生选择后揭示
const kwS = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
function splitSent(text) { return String(text || '').split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean); }
const IRREG = {
  'become': ['became', 'become'],
  'break': ['broke', 'broken'],
  'bring': ['brought', 'brought'],
  'build': ['built', 'built'],
  'buy': ['bought', 'bought'],
  'catch': ['caught', 'caught'],
  'come': ['came', 'come'],
  'get': ['got', 'got'],
  'give': ['gave', 'given'],
  'go': ['went', 'gone'],
  'make': ['made', 'made'],
  'begin': ['began', 'begun'],
  'choose': ['chose', 'chosen'],
  'feed': ['fed', 'fed'],
  'find': ['found', 'found'],
  'arise': ['arose', 'arisen'],
  'awake': ['awoke', 'awoken'],
  'bear': ['bore', 'borne'],
  'beat': ['beat', 'beaten'],
  'bend': ['bent', 'bent'],
  'bet': ['bet', 'bet'],
  'bid': ['bade', 'bidden'],
  'bind': ['bound', 'bound'],
  'bite': ['bit', 'bitten'],
  'bleed': ['bled', 'bled'],
  'blow': ['blew', 'blown'],
  'breed': ['bred', 'bred'],
  'broadcast': ['broadcast', 'broadcast'],
  'burst': ['burst', 'burst'],
  'cast': ['cast', 'cast'],
  'cling': ['clung', 'clung'],
  'cost': ['cost', 'cost'],
  'creep': ['crept', 'crept'],
  'cut': ['cut', 'cut'],
  'deal': ['dealt', 'dealt'],
  'dig': ['dug', 'dug'],
  'dive': ['dove', 'dived'],
  'draw': ['drew', 'drawn'],
  'dream': ['dreamt', 'dreamt'],
  'drink': ['drank', 'drunk'],
  'drive': ['drove', 'driven'],
  'dwell': ['dwelt', 'dwelt'],
  'eat': ['ate', 'eaten'],
  'fall': ['fell', 'fallen'],
  'feed': ['fed', 'fed'],
  'fight': ['fought', 'fought'],
  'flee': ['fled', 'fled'],
  'fling': ['flung', 'flung'],
  'fly': ['flew', 'flown'],
  'forbid': ['forbade', 'forbidden'],
  'forget': ['forgot', 'forgotten'],
  'forgive': ['forgave', 'forgiven'],
  'forsake': ['forsook', 'forsaken'],
  'freeze': ['froze', 'frozen'],
  'grind': ['ground', 'ground'],
  'grow': ['grew', 'grown'],
  'hang': ['hung', 'hung'],
  'hear': ['heard', 'heard'],
  'hide': ['hid', 'hidden'],
  'hit': ['hit', 'hit'],
  'hold': ['held', 'held'],
  'hurt': ['hurt', 'hurt'],
  'keep': ['kept', 'kept'],
  'kneel': ['knelt', 'knelt'],
  'knit': ['knit', 'knit'],
  'lay': ['laid', 'laid'],
  'lead': ['led', 'led'],
  'lean': ['leant', 'leant'],
  'leap': ['leapt', 'leapt'],
  'learn': ['learnt', 'learnt'],
  'lend': ['lent', 'lent'],
  'let': ['let', 'let'],
  'lie': ['lay', 'lain'],
  'light': ['lit', 'lit'],
  'lose': ['lost', 'lost'],
  'mean': ['meant', 'meant'],
  'mistake': ['mistook', 'mistaken'],
  'overcome': ['overcame', 'overcome'],
  'pay': ['paid', 'paid'],
  'prove': ['proved', 'proven'],
  'put': ['put', 'put'],
  'quit': ['quit', 'quit'],
  'read': ['read', 'read'],
  'rid': ['rid', 'rid'],
  'ride': ['rode', 'ridden'],
  'ring': ['rang', 'rung'],
  'rise': ['rose', 'risen'],
  'run': ['ran', 'run'],
  'say': ['said', 'said'],
  'see': ['saw', 'seen'],
  'seek': ['sought', 'sought'],
  'sell': ['sold', 'sold'],
  'send': ['sent', 'sent'],
  'set': ['set', 'set'],
  'shake': ['shook', 'shaken'],
  'shine': ['shone', 'shone'],
  'shoot': ['shot', 'shot'],
  'show': ['showed', 'shown'],
  'shrink': ['shrank', 'shrunk'],
  'shut': ['shut', 'shut'],
  'sing': ['sang', 'sung'],
  'sink': ['sank', 'sunk'],
  'sit': ['sat', 'sat'],
  'sleep': ['slept', 'slept'],
  'slide': ['slid', 'slid'],
  'smell': ['smelt', 'smelt'],
  'sow': ['sowed', 'sown'],
  'speak': ['spoke', 'spoken'],
  'speed': ['sped', 'sped'],
  'spell': ['spelt', 'spelt'],
  'spend': ['spent', 'spent'],
  'spill': ['spilt', 'spilt'],
  'spin': ['spun', 'spun'],
  'spit': ['spat', 'spat'],
  'split': ['split', 'split'],
  'spoil': ['spoilt', 'spoilt'],
  'spread': ['spread', 'spread'],
  'spring': ['sprang', 'sprung'],
  'stand': ['stood', 'stood'],
  'steal': ['stole', 'stolen'],
  'stick': ['stuck', 'stuck'],
  'sting': ['stung', 'stung'],
  'stink': ['stank', 'stunk'],
  'stride': ['strode', 'stridden'],
  'strike': ['struck', 'struck'],
  'strive': ['strove', 'striven'],
  'swear': ['swore', 'sworn'],
  'sweep': ['swept', 'swept'],
  'swell': ['swelled', 'swollen'],
  'swim': ['swam', 'swum'],
  'swing': ['swung', 'swung'],
  'take': ['took', 'taken'],
  'teach': ['taught', 'taught'],
  'tear': ['tore', 'torn'],
  'tell': ['told', 'told'],
  'think': ['thought', 'thought'],
  'throw': ['threw', 'thrown'],
  'thrust': ['thrust', 'thrust'],
  'tread': ['trod', 'trodden'],
  'understand': ['understood', 'understood'],
  'upset': ['upset', 'upset'],
  'wake': ['woke', 'woken'],
  'wear': ['wore', 'worn'],
  'weave': ['wove', 'woven'],
  'weep': ['wept', 'wept'],
  'win': ['won', 'won'],
  'wind': ['wound', 'wound'],
  'withdraw': ['withdrew', 'withdrawn'],
  'withhold': ['withheld', 'withheld'],
  'withstand': ['withstood', 'withstood'],
  'wring': ['wrung', 'wrung'],
  'write': ['wrote', 'written']
};
const ING_EXTRA = {
  'run': 'running',
  'swim': 'swimming',
  'begin': 'beginning',
  'sit': 'sitting',
  'cut': 'cutting',
  'put': 'putting',
  'set': 'setting',
  'hit': 'hitting',
  'shut': 'shutting',
  'get': 'getting',
  'forget': 'forgetting',
  'dig': 'digging',
  'win': 'winning',
  'spin': 'spinning',
  'sing': 'singing',
  'hang': 'hanging',
  'ring': 'ringing',
  'bring': 'bringing',
  'make': 'making',
  'take': 'taking',
  'write': 'writing',
  'drive': 'driving',
  'ride': 'riding',
  'rise': 'rising',
  'hide': 'hiding',
  'bite': 'biting',
  'give': 'giving',
  'live': 'living',
  'shake': 'shaking',
  'wake': 'waking',
  'strike': 'striking',
  'lie': 'lying',
  'die': 'dying',
  'tie': 'tying',
  'see': 'seeing',
  'agree': 'agreeing'
};
function findSent(sents, word) {
  const w = kwS(word);
  if (!w) return '';
  const forms = [w, w + 's', w + 'es', w + 'ed', w + 'd', w + 'ing', w.replace(/y$/, 'ies'), w.replace(/y$/, 'ied'), (ING_EXTRA[w] || ''), ...((IRREG[w] || []).filter(f => !f.startsWith(w)))];
  for (const s of sents) {
    const low = s.toLowerCase();
    if (forms.some(f => f.length > 2 && low.includes(f))) {
      return s.length > 150 ? s.slice(0, 150) + '…' : s;
    }
  }
  return '';
}
// 四六级词书机械扫描 (词形归并同 scanBook; 无 CEFR 级别)
function scanCet(text, which) {
  const cb = CET_BOOKS[which];
  if (!cb) return [];
  const tokens = (String(text || '').toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || []);
  const found = new Map();
  for (const t of tokens) {
    if (STOP.has(t) || t.length < 2) continue;
    const cands = [t];
    if (t.endsWith('ies')) cands.push(t.slice(0, -3) + 'y');
    if (t.endsWith('es')) cands.push(t.slice(0, -2));
    if (t.endsWith('s')) cands.push(t.slice(0, -1));
    if (t.endsWith('ied')) cands.push(t.slice(0, -3) + 'y');
    if (t.endsWith('ed')) cands.push(t.slice(0, -2), t.slice(0, -1));
    if (t.endsWith('ing')) cands.push(t.slice(0, -3), t.slice(0, -3) + 'e');
    for (const cand of cands) {
      const hit = cb.index[cand];
      if (!hit) continue;
      const key = String(hit.word).toLowerCase().trim();
      const rec = found.get(key) || { word: String(hit.word).trim(), cefr: null, count: 0, meaning: String(hit.meaning || '').replace(/\n/g, '；'), phonetic: hit.phonetic || '', pos: hit.pos || '' };
      rec.count++;
      found.set(key, rec);
      break;
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count);
}
function buildCandidates(text, data, grade, books) {
  const active = Array.isArray(books) && books.length ? books : ['sh'];
  const sents = splitSent(text);
  const modelMap = new Map();
  for (const v of (data && data.vocabulary) || []) modelMap.set(kwS(v.word), v);
  const ctxMap = new Map();
  for (const listName of ['phrases', 'collocations']) {
    for (const it of ((data && data[listName]) || [])) {
      const ph = String(it.phrase || it.collocation || '');
      const words = ph.toLowerCase().split(/[^a-z']+/).filter(Boolean);
      for (const w of words) {
        if (w.length > 1 && it.meaning_zh && !ctxMap.has(w)) ctxMap.set(w, { meaning: it.meaning_zh, source: ph });
      }
    }
  }
  const out = [];
  const seen = new Set();
  const stemOf = w => {
    let s = kwS(w);
    if (s.endsWith('ies') && s.length > 4) return s.slice(0, -3) + 'y';
    if (s.endsWith('ing') && s.length > 5) return s.slice(0, -3);
    if (s.endsWith('ed') && s.length > 4) return s.slice(0, -2);
    if (s.endsWith('s') && s.length > 3 && !s.endsWith('ss')) return s.slice(0, -1);
    return s;
  };
  const aiOf = key => modelMap.get(key) || modelMap.get(stemOf(key));
  // ① 勾选词书逐本扫描 (主词书 → 考纲层; 其余 → 副词书层)
  for (const id of active) {
    const bk = BOOKS.get(id);
    if (!bk) continue;
    const isPrimary = (id === PRIMARY_ID);
    const list = bk.leveled ? scanLeveled(text, bk, grade) : (isPrimary ? scanBook(text, grade) : scanList(text, bk));
    const scopeName = isPrimary ? '考纲' : (bk.short || bk.name);
    for (const s of list) {
      const key = kwS(s.word);
      const nk = stemOf(key);
      if (seen.has(nk)) continue;
      seen.add(nk);
      const ai = aiOf(key);
      const ctx = ctxMap.get(key);
      out.push({
        word: String(s.word).trim(), scope: scopeName, cefr: s.cefr || null,
        meaning: (ai && ai.meaning_zh) || s.meaning || '',
        phonetic: (ai && ai.phonetic) || s.phonetic || '', pos: (ai && ai.pos) || s.pos || '',
        ctxMeaning: ctx ? ctx.meaning : '', ctxSource: ctx ? ctx.source : '',
        sentence: findSent(sents, s.word) || (ai && ai.example) || ''
      });
    }
  }
  // ③ 模型提取的拓展词 (不在任何勾选书)
  for (const v of (data && data.vocabulary) || []) {
    if (v.scope !== '拓展') continue;
    const nk = stemOf(v.word);
    if (seen.has(nk)) continue;
    seen.add(nk);
    const ctx = ctxMap.get(nk) || ctxMap.get(kwS(v.word));
    out.push({
      word: String(v.word).trim(), scope: '拓展', cefr: v.cefr || null,
      meaning: v.meaning_zh || '', phonetic: v.phonetic || '', pos: v.pos || '',
      ctxMeaning: ctx ? ctx.meaning : '', ctxSource: ctx ? ctx.source : '',
      sentence: findSent(sents, v.word) || v.example || ''
    });
  }
  return out;
}

// v2 prompt: 年级感知(动态注入 CEFR 门槛), 加生词过滤规则 + 板块去重规则
function buildSystemPrompt(grade) {
  const keep = grade ? (KEEP_LINE[grade] || '') : '';
  const gradeLine = grade && keep
    ? `目标学习者: ${grade}学生。生词提取宁多勿少: 除最入门的小学基础词(${keep} 以下)外, 有学习价值的词都列, 包括可能已认识但重要的考纲词和中级词; 由后续规则再做精细筛选。`
    : '生词提取宁多勿少: 有学习价值的词都列, 但排除最基础的入门词(如 the/a/is/have/go/live/work/time/spend 这类小学词汇)。';
  return `你是专业的英语学习助手。用户会给你一段英语文本，请从中提取学习内容并严格按以下 JSON 结构输出，不要输出任何其他文字：
{
  "vocabulary": [{"word": "单词原形", "phonetic": "音标", "pos": "词性", "meaning_zh": "中文释义", "difficulty": "初中|高中|四六级|考研", "example": "简短例句"}],
  "phrases": [{"phrase": "词组", "meaning_zh": "中文释义", "example": "例句"}],
  "golden_sentences": [{"sentence": "值得背诵的句子", "translation": "该句的中文翻译", "reason": "为什么值得背"}],
  "collocations": [{"collocation": "搭配", "meaning_zh": "中文释义", "example": "例句"}],
  "grammar": [{"point": "语法点", "explanation": "简要讲解", "example": "文中例子"}]
}
规则：
1. ${gradeLine} 排除人名地名。单词用原形。给出词性和中文释义。
2. screen time 这类固定复合词短语应归入 phrases 而不是 vocabulary。
3. difficulty 按中国大陆教育体系分层。
4. phrases 与 collocations 不要重复：动词短语(如 set limits on)放 phrases；名词性搭配(如 outdoor activities)放 collocations。
5. 词组和句子大胆提取, 觉得好就收。
6. 金句选择约束: 句子不宜过长(超30词慎收), 语法点不要太偏怪; 优先选包含本段生词/搭配/地道表达的句子; 若文本是带题号/空格的练习题, 用还原后的完整句子, 不要带题号和括号提示词。
6. meaning_zh 务必贴近文中实际含义: 若词在文中有专名/引申/特殊用法(如 Spartan Beast 的 beast 指赛事级别), 释义要说明文中义, 不要只给词典基础义。
7. 输入文本可能来自 OCR, 存在词间粘连(如 parentingeoined=parenting+coined、flawedwhether=flawed+whether)或词被空格截断: 提取单词/词组时按英语语义先还原拆分, 不要照抄粘连串, 也不要编造原文没有的词。
8. 所有字段必须存在，没有内容就用空数组。
9. 只输出 JSON`;
}

// 优先 llama-server (OpenAI 兼容), 不可用则回退 Ollama
async function llamaChat(messages, opts) {
  try {
    const r = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma', messages, stream: false, temperature: (opts && opts.temperature != null) ? opts.temperature : 0.2, max_tokens: (opts && opts.maxTokens) || 2000, chat_template_kwargs: { enable_thinking: false } })
    });
    if (!r.ok) throw new Error('llama-server HTTP ' + r.status);
    const d = await r.json();
    return d.choices?.[0]?.message?.content || '';
  } catch (e) {
    throw new Error('llama-server 不可用(' + e.message + '), 请先启动引擎或检查 8080 端口');
  }
}

async function ollamaChat(messages) {
  const r = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, stream: false, format: 'json', options: { temperature: 0.2 } })
  });
  if (!r.ok) throw new Error('Ollama HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  return d.message.content;
}

// 语境补全: 候选词缺释义/缺语境句时, 让模型按文章语境一次补齐 (不依赖变形表)
async function fillContextMeanings(cands, text) {
  const need = cands.filter(c => (!c.meaning || !c.sentence) && /^[A-Za-z]/.test(c.word)).slice(0, 25);
  if (!need.length) return;
  const words = need.map(c => c.word);
  const sys = '你是英语老师。对每个单词: ①按文中语境给中文释义(有专名/引申/特殊用法要体现) ②从文章里原样找出包含该词(或其变体)的那句话。只输出 JSON 对象 {"单词": {"m": "中文释义", "s": "原文句子"}}, 不要其他文字。';
  const user = '文章：\n' + String(text || '').slice(0, 3500) + '\n\n请处理：' + words.join('、');
  try {
    const r = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma', stream: false, max_tokens: 3500, temperature: 0.1,
        chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] })
    });
    if (!r.ok) return;
    const d = await r.json();
    let content = (d.choices?.[0]?.message?.content || '').trim().replace(/```json/gi, '').replace(/```/g, '').trim();
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return;
    const map = JSON.parse(m[0]);
    for (const c of cands) {
      const item = map[c.word] || map[String(c.word).toLowerCase()];
      if (!item) continue;
      if (!c.meaning && item.m) c.meaning = String(item.m).slice(0, 60);
      if (!c.sentence && item.s) c.sentence = String(item.s).slice(0, 200);
    }
  } catch (e) { console.log('[fill] 语境补全失败:', e.message.slice(0, 60)); }
}

const OCR_PROMPT = '你是 OCR 引擎。提取图片中的全部英文文本: ①若图片为多栏排版, 按从左到右、每栏从上到下的完整阅读顺序输出全部内容, 不要跳栏 ②保持段落与换行 ③不要翻译、不要解释、不要添加任何内容, 只输出识别到的原文。';

// 乱码检测: 字母数字占比过低 / 无空格长串 / 过短 → 判定失败
function isGarbled(t) {
  const s = String(t || '').trim();
  if (s.length < 8) return true;
  const alnum = (s.match(/[A-Za-z0-9]/g) || []).length;
  if (alnum / s.length < 0.6) return true;
  const words = s.split(/\s+/);
  const longNoSpace = words.some(w => w.length > 40);
  return longNoSpace;
}

// 图片 → 文本 (内嵌 gemma4 多模态, 需引擎带 mmproj 启动); 乱码自动降采样重试一次
async function ocrImage(fpath, ext) {
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext] || 'image/png';
  const b64 = fs.readFileSync(fpath).toString('base64');
  const call = async temp => {
    const r = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemma', stream: false, max_tokens: 4000, temperature: temp,
        chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: 'user', content: [{ type: 'text', text: OCR_PROMPT }, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] }]
      })
    });
    if (!r.ok) throw new Error('视觉识别 HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const d = await r.json();
    return (d.choices?.[0]?.message?.content || '').trim();
  };
  let out = await call(0.1);
  if (isGarbled(out)) {
    console.log('[ocr] 首轮输出异常, 自动重试(temp=0)');
    out = await call(0);
  }
  return out;
}

async function extractFromText(text, grade, opts) {
  const messages = [
    { role: 'system', content: buildSystemPrompt(grade) },
    { role: 'user', content: '以下是课文文本：\n' + text }
  ];
  // 尝试内置引擎, 失败自动回退 Ollama
  try {
    return await llamaChat(messages, { maxTokens: (opts && opts.maxTokens) || 4500, temperature: 0.1 });
  } catch (e) {
    console.log('[engine] llama-server 失败, 回退 Ollama:', e.message);
    return await ollamaChat(messages);
  }
}

// 长文分段提取+合并 (单段超 2200 字符自动切块, 每块 ≤2000)
function splitText(text) {
  const MAX = 2000;
  if (text.length <= MAX + 200) return [text];
  const paras = String(text).split(/\n+/);
  const chunks = []; let cur = '';
  for (const p of paras) {
    if ((cur + '\n' + p).length > MAX && cur) { chunks.push(cur); cur = p; }
    else cur = cur ? cur + '\n' + p : p;
    if (cur.length > MAX) { chunks.push(cur); cur = ''; }
  }
  if (cur) chunks.push(cur);
  return chunks;
}
// 模型输出可能被 max_tokens 截断 / 夹带说明文字 → 逐级修复后再解析
function parseModelJson(content) {
  const clean = s => String(s || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const tryParse = s => { try { return JSON.parse(s); } catch (e) { return null; } };
  let t = clean(content);
  let r = tryParse(t);
  if (r) return r;
  const brace = t.indexOf('{');
  if (brace > 0) t = t.slice(brace);
  const end = t.lastIndexOf('}');
  if (end >= 0) { r = tryParse(t.slice(0, end + 1)); if (r) return r; }
  const scan = s => {
    const st = []; let inStr = false, esc = false, lastSafe = -1;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (esc) esc = false; else if (ch === String.fromCharCode(92)) esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{" || ch === "[") st.push(ch === "{" ? "}" : "]");
      else if (ch === "}" || ch === "]") { st.pop(); lastSafe = i; }
      else if (ch === "," && st.length) lastSafe = i;
    }
    return { st: st, inStr: inStr, lastSafe: lastSafe };
  };
  let head = t;
  for (let round = 0; round < 6; round++) {
    const info = scan(head);
    if (info.lastSafe < 0) break;
    const cutAt = head.slice(0, info.lastSafe + 1).replace(/,\s*$/, "");
    const info2 = scan(cutAt);
    const fixed = cutAt + (info2.inStr ? '"' : "") + info2.st.slice().reverse().join("");
    r = tryParse(fixed);
    if (r) return r;
    const idx = cutAt.lastIndexOf("},");
    if (idx < 0) break;
    head = cutAt.slice(0, idx + 1);
  }
  return null;
}
async function extractData(text, grade) {
  const chunks = splitText(text);
  if (chunks.length === 1) {
    let content = await extractFromText(text, grade);
    let d = parseModelJson(content);
    if (!d) {
      console.log('[extract] JSON 解析失败(输出可能被截断), 提高 token 预算重试一次...');
      content = await extractFromText(text, grade, { maxTokens: 6000 });
      d = parseModelJson(content);
    }
    if (!d) throw new Error('模型输出无法解析为 JSON(已自动重试一次): ' + String(content).slice(0, 200));
    return d;
  }
  // 多块: 逐块提取后合并
  const merged = { vocabulary: [], phrases: [], golden_sentences: [], collocations: [], grammar: [] };
  const seenW = new Set(), seenP = new Set(), seenS = new Set(), seenC = new Set(), seenG = new Set();
  for (let i = 0; i < chunks.length; i++) {
    const content = await extractFromText(chunks[i], grade);
    let d;
    d = parseModelJson(content);
    if (!d) { console.log('[extract] 第 ' + (i + 1) + ' 块解析失败, 跳过该块'); continue; }
    for (const v of d.vocabulary || []) { const k = kwS(v.word); if (!seenW.has(k)) { seenW.add(k); merged.vocabulary.push(v); } }
    for (const p of d.phrases || []) { const k = kwS(p.phrase); if (!seenP.has(k)) { seenP.add(k); merged.phrases.push(p); } }
    for (const s of d.golden_sentences || []) { const k = kwS(s.sentence); if (!seenS.has(k)) { seenS.add(k); merged.golden_sentences.push(s); } }
    for (const c of d.collocations || []) { const k = kwS(c.collocation); if (!seenC.has(k)) { seenC.add(k); merged.collocations.push(c); } }
    for (const g of d.grammar || []) { const k = kwS(g.point); if (!seenG.has(k)) { seenG.add(k); merged.grammar.push(g); } }
  }
  return merged;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

// ===== OCR 快路径 (常驻 worker, 首次启动加载模型后每图 ~1-2s) =====
// 2026-09-08 00:58: 用户试完 v4 后切回 规则版(v5 多引擎+补全 = rapid_ocr.rules.py)
// 临时切 v4: OCR_PY 改 winauto-venv + rapid_ocr.v4.py 覆盖 rapid_ocr.py
// ===== 可移植: 本机 python 探测 (打包版无 python 时 OCR/文档解析自动降级, 视觉模型不受影响) =====
function findPy() {
  if (process.platform === 'darwin') {
    const rtDir = path.join(__dirname, '..', 'runtime');
    const macDir = path.join(rtDir, 'python-mac-' + (process.arch === 'arm64' ? 'arm64' : 'x64'));
    const tgz = macDir + '.tar.gz';
    if (!fs.existsSync(macDir) && fs.existsSync(tgz)) {
      // 首次运行: 展开内嵌 Mac OCR 引擎 (发布包内为 tar.gz, 保住符号链接)
      try {
        require('child_process').execFileSync('tar', ['-xzf', tgz, '-C', rtDir], { stdio: 'ignore', timeout: 180000 });
        fs.unlinkSync(tgz);
        console.log('[可移植] Mac OCR 引擎已展开'); 
      } catch (e) { console.log('[可移植] OCR 引擎展开失败:', e.message); }
    }
    const macPy = path.join(macDir, 'bin', 'python3');
    if (fs.existsSync(macPy)) { console.log('[可移植] 使用内嵌 mac Python: RapidOCR 引擎在线'); return macPy; }
  }
  const bundled = path.join(__dirname, '..', 'runtime', 'python', 'python.exe');
  if (fs.existsSync(bundled)) {
    process.env.PADDLE_PDX_CACHE_HOME = path.join(__dirname, '..', 'runtime', 'python', '.paddlex');
    console.log('[可移植] 使用内嵌 Python: 照片OCR/文档解析全功能在线');
    return bundled;
  }
  if (process.env.ES_PYTHON && fs.existsSync(process.env.ES_PYTHON)) return process.env.ES_PYTHON;
  const cands = [
    // 便携约定: 不写死开发者用户名 (可用环境变量 ES_PYTHON 覆盖)
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'tools', 'paddle-venv', 'Scripts', 'python.exe'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe') : '',
    'C:\\Python312\\python.exe',
    'python3', 'python'
  ];
  const { execFileSync } = require('child_process');
  for (const c of cands) {
    if (!c) continue;
    if (c.includes('\\') && !fs.existsSync(c)) continue;
    if (!c.includes('\\')) { try { execFileSync(c, ['--version'], { timeout: 8000, stdio: 'ignore' }); return c; } catch (e) { continue; } }
    return c;
  }
  return null;
}
const PY_RESOLVED = findPy();
if (!PY_RESOLVED) console.log('[可移植] 未找到 python: 照片OCR/文档解析降级, 视觉模型链路不受影响');

const { spawn } = require('child_process');
const OCR_PY = PY_RESOLVED || 'python';
// v4(RapidOCR) 第二引擎: 照片乱码页并入其独有行; 打包版无 python 时自动跳过
const OCR_PY4 = PY_RESOLVED || 'python';
const OCR_SCRIPT = path.join(__dirname, '..', 'scripts', 'rapid_ocr.py');
// ===== 识别模式开关: vision(视觉优先+OCR兜底) / ocr(纯OCR, 不碰视觉模型) =====
let appMode = 'vision';
const MODE_FILE = path.join(__dirname, '..', 'data', 'app_mode.json');
try { const _m = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')); if (_m.mode === 'ocr' || _m.mode === 'vision') appMode = _m.mode; } catch (e) {}
function saveMode(m) { try { fs.writeFileSync(MODE_FILE, JSON.stringify({ mode: m })); } catch (e) {} }
let ocrProc = null, ocrBuf = '', ocrWaiters = [], ocrId = 0, ocrIdle = null;
const OCR_IDLE_MS = 5 * 60 * 1000; // 5 分钟空闲自动退出
function ocrKickIdle() {
  if (ocrIdle) clearTimeout(ocrIdle);
  ocrIdle = setTimeout(() => {
    if (ocrProc) { try { ocrProc.kill(); } catch (e) {} ocrProc = null; console.log('[ocr] worker 空闲 5 分钟已退出(省内存)'); }
    ocrIdle = null;
  }, OCR_IDLE_MS);
}
function ensureOcr() {
  if (ocrProc) { ocrKickIdle(); return; }
  ocrProc = spawn(OCR_PY, [OCR_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
  ocrProc.stdout.on('data', c => {
    ocrBuf += c.toString();
    let nl;
    while ((nl = ocrBuf.indexOf('\n')) >= 0) {
      const line = ocrBuf.slice(0, nl).trim(); ocrBuf = ocrBuf.slice(nl + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch (e) {}
      const w = ocrWaiters.shift();
      if (w) { clearTimeout(w.timer); w.resolve(msg); }
    }
  });
  ocrProc.on('exit', () => { ocrProc = null; for (const w of ocrWaiters) { clearTimeout(w.timer); w.resolve(null); } ocrWaiters = []; });
  ocrProc.on('error', () => { ocrProc = null; });
  ocrKickIdle();
}
// 图片预处理: EXIF转正 + 降采样(长边≤1400) + JPEG + 竖长图切半
// 返回 {main, halves} halves=上下半路径(竖长图时) 或 null
function prepImage(src) {
  return new Promise(resolve => {
    const out = src + '.norm.jpg';
    require('child_process').execFile(OCR_PY, [path.join(__dirname, '..', 'scripts', 'img_prep.py'), src, out], { timeout: 25000 }, (e, so) => {
      if (e) return resolve(null);
      const parts = String(so || '').trim().split(/\s+/);
      if (parts[0] !== 'PREP_OK') return resolve(null);
      return resolve({ main: out, halves: parts.slice(3) });
    });
  });
}
// 引擎是否可用 (视觉前置)
async function engineAlive() {
  try { const r = await fetch(`${LLAMA_URL}/health`, { signal: AbortSignal.timeout(2500) }); return r.ok; } catch (e) { return false; }
}
// 视觉分读: 依次读多图(半图)拼接; 失败返回 null
// 整行精确去重: 视觉半图拼接/复读产生的完全相同长行只保留第一条 (2026-09-07, 不伤正确率: 仅删逐字相同的行)
function dedupeLines(text) {
  // 2026-09-07 22:3x: 用户要求"允许重复、要全" → 不再做行去重(避免误删)。
  return String(text || '');
}

// 保守乱码行过滤: 只删明显碎片行(字符占比过低/无可读词), 不删任何疑似内容、不去重
function removeJunkLines(text) {
  return String(text || '').split('\n').map(ln => {
    const t = ln.trim();
    if (!t) return ln;
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    const alnum = (t.match(/[A-Za-z0-9]/g) || []).length;
    if (letters < 4 && t.length >= 2 && alnum / Math.max(1, t.length) < 0.45) return null; // 纯乱码碎片
    return ln;
  }).filter(x => x !== null).join('\n');
}

async function visionReadFiles(files) {
  const sys = '你是 OCR 引擎。逐字转录图中全部英文正文: 不许省略段落和句子, 保持原词序, 不要改写补全, 忽略纸背透字/页码, 忽略所有手写笔迹(下划线/波浪线/圈注/旁批等阅读痕迹), 只输出印刷正文。';
  const parts = [];
  for (const f of files) {
    try {
      const mime = f.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      const b64 = fs.readFileSync(f).toString('base64');
      const r = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gemma', stream: false, max_tokens: 3500, temperature: 0,
          chat_template_kwargs: { enable_thinking: false },
          messages: [{ role: 'user', content: [{ type: 'text', text: sys }, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] }] })
      });
      if (!r.ok) return null;
      const d = await r.json();
      const c = (d.choices?.[0]?.message?.content || '').trim();
      if (!c || isGarbled(c)) return null;
      parts.push(c);
    } catch (e) { return null; }
  }
  return parts.length ? parts.join('\n') : null;
}
// 轻量自检: 模型删除乱码行/重复段, 不改写 (2B 擅长删不擅长改)
async function cleanupVisionText(raw) {
  if (!raw || raw.length < 60) return raw;
  try {
    const sys = '你是文本清理器。输入是 OCR/视觉识别的英文文本, 可能含: ①完全重复的段落(同一段出现两次) ②乱码行(无意义字符串/倒序词) ③透字残句。请输出清理后的文本: 删除重复段落(保留第一次出现的)和乱码行, 其余内容原样保留, 不要改写任何单词, 不要翻译。';
    const r = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma', stream: false, max_tokens: 3000, temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: raw }] })
    });
    if (!r.ok) return raw;
    const d = await r.json();
    const c = (d.choices?.[0]?.message?.content || '').trim();
    return c.length > raw.length * 0.4 ? c : raw;
  } catch (e) { return raw; }
}

// 图片 → {text, avg} | null(失败/超时)
// 超时 90s: v5 引擎冷启动(paddle 导入+模型加载)约 20-40s, 原 25s 会误杀 (2026-09-07)
function ocrFast(imgPath, timeoutMs = 90000) {
  return new Promise(resolve => {
    ensureOcr();
    if (!ocrProc) return resolve(null);
    const id = ++ocrId;
    const timer = setTimeout(() => {
      ocrWaiters = ocrWaiters.filter(w => w.id !== id);
      resolve(null);
      try { ocrProc.kill(); } catch (e) {}
      ocrProc = null;
    }, timeoutMs);
    ocrWaiters.push({ id, resolve, timer });
    ocrProc.stdin.write(JSON.stringify({ id, img: imgPath }) + '\n');
  });
}

// 视觉文本中首个选项行之前的正文段(选项页顶部 passage 续尾); 没有则返回 ''
function visionTopPassage(visionText) {
  const s = String(visionText || '').trim();
  if (!s) return '';
  const optRe = /^\s*\d{1,2}\.\s*[A-D]\./;
  const top = [];
  for (const ln of s.split('\n')) {
    const t = ln.trim();
    if (optRe.test(t)) break;          // 到选项行停
    if (t.length >= 12) top.push(t);   // 只要像正文的长行
  }
  if (top.length < 2) return '';
  return top.join('\n');
}

// 顶部条带回读: 照片/竖长页 OCR 常漏顶部正文(左侧残字+透印干扰并框) → 裁顶部条带单独视觉读, 补缺失行
function cropTop(src, dst, ratio) {
  return new Promise(resolve => {
    require('child_process').execFile(OCR_PY, [path.join(__dirname, '..', 'scripts', 'crop_top.py'), src, dst, String(ratio)], { timeout: 20000 }, e => resolve(!e));
  });
}
async function topStripRecovery(src, curText) {
  try {
    if (!(await engineAlive())) return null;
    const strip = src + '.topstrip.jpg';
    if (!(await cropTop(src, strip, 0.28))) return null;
    const vt = await visionReadFiles([strip]);
    if (!vt || !vt.trim()) return null;
    const optRe = /^\s*\d{1,2}\.\s*[A-D]\./;
    const flatCur = curText.replace(/\s+/g, ' ');
    const missing = [];
    for (const ln of vt.split('\n')) {
      const t = ln.trim();
      if (!t) continue;
      if (optRe.test(t)) break;
      if (t.length < 12) continue;
      const probe = t.slice(0, 30).replace(/\s+/g, ' ');
      if (!flatCur.includes(probe)) missing.push(t);
    }
    if (!missing.length) return null;
    return missing.join('\n') + '\n\n' + curText;
  } catch (e) { return null; }
}


// ===== 首尾非英文片段修复 (2026-09-07 用户: 只读"明显非英文排列"部分, 关注首尾) =====
function cropBand(src, dst, band, ratio) {
  return new Promise(resolve => {
    require('child_process').execFile(OCR_PY, [path.join(__dirname, '..', 'scripts', 'crop_band.py'), src, dst, band, String(ratio)], { timeout: 20000 }, e => resolve(!e));
  });
}
// 行是否"明显非英文排列": 短词占比高(像字母汤) 或 全是≤2字母碎片; 选项行/题干行永不判坏
function badishLine(t) {
  if (/^\s*\d{1,2}\.\s*[A-D]\./i.test(t) || /^\s*[A-D]\.\s*[A-Za-z]/i.test(t)) return false; // 选项行(题号+A./A.词首)不是乱码
  const toks = t.split(/\s+/).filter(Boolean);
  if (!toks.length) return false;
  const alpha = (t.match(/[A-Za-z]/g) || []).length;
  if (alpha < 4) return t.length >= 2;                       // 基本没字母的碎片
  if (toks.length === 1) return false;                        // 单长词不判(可能是标题/单词行)
  const short = toks.filter(x => x.length < 4 && /[A-Za-z]/.test(x)).length;
  const shortR = short / toks.length;
  const letters = t.replace(/[^A-Za-z]/g, '');
  const longRatio = (toks.filter(x => x.length >= 5 && /^[A-Za-z]+$/.test(x)).length) / toks.length;
  // 字母汤特征: 短词≥30% 且 长真词少; 或 平均词长过短
  const avgLen = toks.length ? letters.length / toks.length : 0;
  return (shortR >= 0.30 && longRatio < 0.5) || (toks.length >= 3 && avgLen < 3.0);
}
function countLeadBad(lines) {
  let n = 0;
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) { if (n) break; continue; }
    if (n >= 4) break;
    if (badishLine(t) && t.length >= 6) n++;
    else break;
  }
  return n;
}
function countTailBad(lines) {
  let n = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) { if (n) break; continue; }
    if (n >= 4) break;
    if (badishLine(t) && t.length >= 6) n++;
    else break;
  }
  return n;
}
// 返回: { headBad, tailBad, headN, tailN }
function headTailBad(text) {
  const lines = String(text || '').split('\n');
  return { lines, headN: countLeadBad(lines), tailN: countTailBad(lines) };
}
// v4 第二引擎并入: v5/v4 漏检区互补 (2026-09-08, 确定性, 只补不删)
function v4Supplement(src, text) {
  return new Promise(resolve => {
    require('child_process').execFile(OCR_PY4, [path.join(__dirname, '..', 'scripts', 'rapid_ocr.v4.py'), src], { encoding: 'utf8', timeout: 90000, maxBuffer: 20e6 }, (e, so) => {
      try {
        if (e) return resolve(null);
        const j = JSON.parse(String(so).trim());
        const v4t = (j.text || '').trim();
        if (!v4t) return resolve(null);
        const flatWords = new Set(String(text || '').toLowerCase().replace(/[^a-z']+/g, ' ').split(' ').filter(w => w.length >= 3));
        const add = [];
        for (const ln of v4t.split('\n')) {
          const t = ln.trim();
          if (!t) continue;
          const ws = t.toLowerCase().replace(/[^a-z']+/g, ' ').split(' ').filter(w => w.length >= 3);
          if (ws.length < 2) continue;
          const novel = ws.filter(w => !flatWords.has(w)).length;
          if (novel / ws.length >= 0.4) add.push(t);
        }
        resolve(add.length ? String(text || '') + '\n\n' + add.join('\n') : null);
      } catch (err) { resolve(null); }
    });
  });
}
// t3类照片专项: 主文本含乱码行时, gemma 视觉顶/底条带补词 (2026-09-08 00:2x, 只补不删)
async function visionStripSupplement(src, text) {
  try {
    if (!(await engineAlive())) return null;
    const flatWords = new Set(String(text || '').toLowerCase().replace(/[^a-z']+/g, ' ').split(' ').filter(w => w.length >= 3));
    const add = [];
    for (const [band, ratio] of [['top', 0.34], ['bottom', 0.32]]) {
      const crop = src + '.vs_' + band + '.jpg';
      if (!(await cropBand(src, crop, band, ratio))) continue;
      const vt = await visionReadFiles([crop]);
      if (!vt) continue;
      for (const ln of vt.split('\n')) {
        const t = ln.trim();
        if (!t) continue;
        const ws = t.toLowerCase().replace(/[^a-z']+/g, ' ').split(' ').filter(w => w.length >= 3);
        if (ws.length < 2) continue;
        const novel = ws.filter(w => !flatWords.has(w)).length;
        if (novel / ws.length >= 0.5) add.push(t);
      }
    }
    if (!add.length) return null;
    return String(text || '') + '\n\n' + add.join('\n');
  } catch (e) { return null; }
}
async function refineHeadTail(src, text) {
  try {
    if (!(await engineAlive())) return null;
    const { lines, headN, tailN } = headTailBad(text);
    if (!headN && !tailN) return null;
    let kept = lines.slice(0);
    let changed = false;
    // 头部坏行 → 视觉重读顶部条带, 替换
    if (headN) {
      const crop = src + '.rt_top.jpg';
      if (await cropBand(src, crop, 'top', Math.min(0.20, 0.07 + 0.04 * headN))) {
        const vt = await visionReadFiles([crop]);
        if (vt && vt.trim().length >= 40) {
          let start = -1, removed = 0;
          for (let i = 0; i < kept.length; i++) {
            if (!kept[i].trim()) continue;
            if (removed < headN && badishLine(kept[i].trim())) { if (start < 0) start = i; removed++; kept[i] = null; }
            else if (removed >= headN) break;
            else break;
          }
          kept = kept.filter(x => x !== null);
          kept.unshift(vt.trim());
          changed = true;
        }
      }
    }
    // 尾部坏行 → 视觉重读底部条带, 替换
    if (tailN) {
      const crop = src + '.rt_bot.jpg';
      if (await cropBand(src, crop, 'bottom', Math.min(0.16, 0.05 + 0.04 * tailN))) {
        const vt = await visionReadFiles([crop]);
        if (vt && vt.trim().length >= 40) {
          for (let i = kept.length - 1; i >= 0 && tailN > 0; i--) {
            if (!kept[i].trim()) continue;
            if (badishLine(kept[i].trim())) { kept[i] = null; }
            else break;
          }
          kept = kept.filter(x => x !== null);
          kept.push(vt.trim());
          changed = true;
        }
      }
    }
    return changed ? kept.join('\n').replace(/\n{3,}/g, '\n\n') : null;
  } catch (e) { return null; }
}
// 干扰义池: 从词书随机抽释义, 供英译中四选一当错误选项
function makeDistractors() {
  const pool = [];
  // 干扰义池: 从注册表里任意词书随机抽 (不再依赖上海考纲)
  const poolBooks = [...BOOKS.values()].filter(b => ((b.book || {}).words || []).length);
  for (let i = 0; i < 50 && poolBooks.length; i++) {
    const bk = poolBooks[Math.floor(Math.random() * poolBooks.length)];
    const ws = bk.book.words || [];
    const w = ws[Math.floor(Math.random() * ws.length)];
    if (w && w.meaning) pool.push(String(w.meaning).replace(/\n/g, '；').slice(0, 40));
  }
  if (CET4) {
    const ws = CET4.book.words || [];
    for (let i = 0; i < 30 && ws.length; i++) {
      const w = ws[Math.floor(Math.random() * ws.length)];
      if (w.meaning) pool.push(String(w.meaning).replace(/\n/g, '；').slice(0, 40));
    }
  }
  return [...new Set(pool)].slice(0, 50);
}

// 兜底: 任何未捕获异常都不应让本地服务整个死掉 (演示/比赛场景尤其致命)
process.on('uncaughtException', e => { console.error('[uncaught] 服务保持存活, 已记录:', (e && e.stack) || e); });
process.on('unhandledRejection', e => { console.error('[unhandledRejection] 已记录:', (e && e.stack) || e); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  // API: 文本提取
  if (url.pathname === '/api/extract' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 200000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { text, grade, books } = JSON.parse(body || '{}');
        if (!text || !text.trim()) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '文本为空' })); }
        const validBooks = Array.isArray(books) ? books.filter(b => BOOKS.has(b)).slice(0, 3) : [PRIMARY_ID];
        if (!validBooks.length) validBooks.push(PRIMARY_ID);
        const t0 = Date.now();
        const data = await extractData(text, grade);
        const annotated = annotate(data, grade);
        const payload = { ok: true, timeMs: Date.now() - t0, grade: grade || null, data: annotated };
        payload.candidates = buildCandidates(text, annotated, grade, validBooks); // 自评候选(勾选词书, 含语境)
        payload.books = validBooks;
        payload.distractors = makeDistractors(); // 四选一干扰项池
        await fillContextMeanings(payload.candidates, text); // 无释义候选按语境补义
        // 全部计算完成后再发响应头: 否则中途抛错会在 catch 里二次 writeHead → 进程崩溃
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      } catch (err) {
        console.error('[extract] 失败:', (err && err.stack) || err);
        if (res.headersSent) { try { res.destroy(); } catch (e2) {} return; }
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // API: 文件/图片 → 文本 (PDF/DOCX/TXT 解析; 图片走内嵌 gemma4 视觉)
  if (url.pathname === '/api/file-text' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 80e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const { name, data } = JSON.parse(body || '{}');
        if (!name || !data) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '缺少文件' })); }
        const ext = path.extname(name).toLowerCase();
        const tmpDir = path.join(ROOT, '..', 'tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        // ASCII 安全文件名(中文名会导致 OpenCV/llama 读图失败)
      const safeExt = path.extname(name).toLowerCase() || '.img';
      let fpath = path.join(tmpDir, 'up_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + safeExt);
        fs.writeFileSync(fpath, Buffer.from(data, 'base64'));
        const PY = PY_RESOLVED;
        if (!PY) throw new Error('此电脑未安装 Python, PDF/Word/照片OCR 功能不可用 (文本粘贴与视觉识别不受影响)');
        const SCRIPTS = path.join(__dirname, '..', 'scripts');
        const runPy = args => new Promise((ok, no) => {
          require('child_process').execFile(PY, args, { encoding: 'utf8', maxBuffer: 20e6, timeout: 120000 }, (e, so) => e ? no(new Error((so || e.message).slice(0, 300))) : ok(so));
        });
        let text = null, scan = false, scanEngine = 'ocr';
        const imgExts = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'];
        if (ext === '.pdf' || ext === '.docx' || ext === '.txt') {
          const out = await runPy([path.join(SCRIPTS, 'extract_text.py'), fpath]);
          const j = JSON.parse(out);
          if (j.type === 'scan') scan = true; else text = j.text;
        } else if (imgExts.includes(ext)) {
          const pp = await prepImage(fpath);
          const files = (pp && pp.halves && pp.halves.length) ? pp.halves : [pp ? pp.main : fpath];
          const ocrSrc = pp ? pp.main : fpath;
          if (appMode === 'vision' && await engineAlive()) {
            // 主路径: 视觉分读 (竖长图多段拼接, 抗透字/弯曲, 词准)
            let parts = await visionReadFiles(files);
            // 视觉过短(<150字: 小字密文读不清/截断征兆) → 试 OCR 更长输出
            if (parts && parts.trim().length < 150) {
              const ocrFallback = await ocrFast(ocrSrc);
              if (ocrFallback && ocrFallback.text && ocrFallback.text.trim().length > parts.trim().length * 3 && ocrFallback.text.trim().length >= 300) {
                parts = ocrFallback.text; scanEngine = 'ocr(vs-weak)';
              }
            }
            if (parts && parts.trim().length >= 20) {
              // 检测选项网格模式: 视觉对多区域版面弱, 触发 OCR 坐标版面重建
              const optLike = (parts.match(/(^|\n)\s*\d{1,2}\.\s*[A-D]\./g) || []).length;
              if (optLike >= 3) {
                const ocrR = await ocrFast(ocrSrc);
                if (ocrR && ocrR.options && ocrR.options.length >= 3) {
                  // rapid_ocr 已按版面排好(上方正文+选项+下方正文); 直接采用
                  // OCR 在照片顶部常漏正文(并框/漏检) → 视觉选项区上方正文补回; 仍缺则顶部条带单独回读 (2026-09-07)
                  text = ocrR.text || '';
                  scanEngine = 'ocr-layout';
                  const vt = visionTopPassage(parts);
                  if (vt && !text.includes(vt.slice(0, 24))) text = vt + '\n\n' + text;
                  const rec = await topStripRecovery(fpath, text);
                  if (rec) text = rec;
                } else { text = parts; scanEngine = 'vision'; }
              } else {
                // 纯正文页(无选项): 允许重复、优先保全 — 只做保守乱码行过滤(不删疑似内容/不去重)
                parts = removeJunkLines(parts);
                text = parts; scanEngine = 'vision';
                // 定版规则(2026-09-07 23:40): OCR(v5)恒为基底(确定性完整), 不跟视觉比长度掷骰子
                // 视觉文本仅当 OCR 明显更短/更弱时才保留(OCR<300 或 OCR 不到视觉 85% 且 <1500)
                const ocrFull = await ocrFast(ocrSrc);
                if (ocrFull && ocrFull.text && ocrFull.text.trim().length >= 300 &&
                    !(ocrFull.text.trim().length < text.trim().length * 0.85 && ocrFull.text.trim().length < 1500)) {
                  text = ocrFull.text; scanEngine = 'ocr(full-vs)';
                }
              }
            }
            else {
              const ocrR = await ocrFast(ocrSrc);
              if (ocrR && ocrR.text && ocrR.text.trim().length >= 20) { text = ocrR.text; scanEngine = 'ocr'; }
              else if (parts && parts.trim().length >= 8) { text = parts; scanEngine = 'vision(lowQ)'; }
              else if (ocrR && ocrR.text) { text = ocrR.text; scanEngine = 'ocr(lowQ)'; }
              else throw new Error('图片识别失败: OCR与视觉均无有效输出');
            }
          } else {
            // 引擎离线 → RapidOCR
            const ocrR = await ocrFast(ocrSrc);
            if (ocrR && ocrR.text && ocrR.text.trim().length >= 20) { text = ocrR.text; scanEngine = 'ocr'; }
            else if (ocrR && ocrR.text) { text = ocrR.text; scanEngine = 'ocr(lowQ)'; }
            else throw new Error('图片识别失败(引擎离线且OCR无输出)');
          }
        } else {
          res.writeHead(415, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: '不支持的格式: ' + ext }));
        }
        // 扫描版 PDF → 渲染成图逐页识别 (视觉分读主路径 + OCR 备用)
        if (scan) {
          const pageDir = path.join(tmpDir, 'pages-' + Date.now());
          await runPy([path.join(SCRIPTS, 'render_pdf.py'), fpath, pageDir, '10']);
          const dirFiles = fs.readdirSync(pageDir).sort();
          const chunks = [];
          const engOk = await engineAlive();
          for (const f of dirFiles) {
            const png = path.join(pageDir, f);
            if (engOk) {
              const pp = await prepImage(png);
              const files = (pp && pp.halves && pp.halves.length) ? pp.halves : [pp ? pp.main : png];
              const vt = await visionReadFiles(files);
              if (vt && vt.trim().length >= 20) {
                // 选项页检测: 视觉对选项网格弱, 用 OCR 版面重建
                const optLike = (vt.match(/(^|\n)\s*\d{1,2}\.\s*[A-D]\./g) || []).length;
                if (optLike >= 3) {
                  const ocrR = await ocrFast(png);
                  if (ocrR && ocrR.options && ocrR.options.length >= 3) {
                    chunks.push(ocrR.text || ''); // 版面序(上方正文+选项+下方正文)
                    continue;
                  }
                }
                chunks.push(vt); continue;
              }
            }
            const ocrR = await ocrFast(png);
            if (ocrR && ocrR.text && ocrR.text.trim().length >= 20) chunks.push(ocrR.text);
          }
          text = chunks.join('\n\n');
          if (chunks.length) scanEngine = 'vision';
        }
        // 首尾非英文片段修复: 先修 OCR 首尾坏区(避免误删后续补充行) (2026-09-07/08)
        if (appMode === 'vision' && text && text.trim().length >= 150) {
          const refined = await refineHeadTail(fpath, text);
          if (refined) { text = refined; scanEngine = String(scanEngine || '') + '+rt'; }
        }
        // t3类专项: 文本仍含乱码行(≥1) → 视觉顶/底条带 + v4 第二引擎补词(只补不删)
        if (appMode === 'vision' && text && text.trim().length >= 150) {
          const junkN = String(text).split('\n').filter(l => { const t = l.trim(); return t && t.length >= 6 && badishLine(t); }).length;
          if (junkN >= 1) {
            const vs = await visionStripSupplement(fpath, text);
            if (vs) text = vs;
            const v4s = await v4Supplement(fpath, text);
            if (v4s) text = v4s;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, text: text || '', scan, engine: scanEngine }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  // API: 批量查词义 (每日自测/记忆用; 考纲词书优先, CEFR 无静态义)
  if (url.pathname === '/api/word-meanings' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 50000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { words } = JSON.parse(body || '{}');
        const map = {};
        const missing = [];
        for (const w of (words || []).slice(0, 100)) {
          const low = String(w).toLowerCase().trim();
          const hit = BOOK_INDEX.info[low] || BOOK_INDEX.info[low.replace(/\s+.*$/, '')] || (CET4 && CET4.index[low]) || (CET6 && CET6.index[low]);
          if (hit) map[low] = String(hit.meaning || '').replace(/\n/g, '；');
          else missing.push(low);
        }
        // AI 补义: 词书未命中词(CEFR/识别词/手动加)批量补常用中文义, 保证每日自测能出题
        if (missing.length && await engineAlive()) {
          try {
            const sys = '你是词典。给每个英语单词最常用中文释义(1-2义项), 只输出 JSON {"单词":"释义"}。';
            const r = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: 'gemma', stream: false, max_tokens: 2000, temperature: 0.1,
                chat_template_kwargs: { enable_thinking: false },
                messages: [{ role: 'system', content: sys }, { role: 'user', content: missing.slice(0, 20).join('\n') }] })
            });
            if (r.ok) {
              const d = await r.json();
              let content = (d.choices?.[0]?.message?.content || '').trim().replace(/```json/gi, '').replace(/```/g, '').trim();
              const m = content.match(/\{[\s\S]*\}/);
              if (m) {
                const ai = JSON.parse(m[0]);
                for (const low of missing) { const v = ai[low] || ai[low.charAt(0).toUpperCase() + low.slice(1)]; if (v) map[low] = String(v).slice(0, 60); }
              }
            }
          } catch (e) { console.log('[wm] AI 补义失败:', e.message.slice(0, 60)); }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, map }));
      } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false })); }
    });
    return;
  }
  // API: 中文批改 (英译中容错判题: 学生写中文, 模型对照标准义判断)
  if (url.pathname === '/api/judge-zh' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { en, standard, answer } = JSON.parse(body || '{}');
        if (!en || !answer) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '参数不全' })); }
        const sys = '你是严格的英语默写批改老师。学生根据英文单词写出中文释义, 你判断学生的中文是否表达了该词的正确意思(允许同义词/近义表述/部分义项正确即算对, 明显错误或只写无关含义算错)。只输出 JSON {"ok": true或false, "note": "简短点评(可选)"}。';
        const user = `英文单词: ${en}\n标准释义: ${standard || '(无)'}\n学生答案: ${answer}`;
        const r = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gemma', stream: false, max_tokens: 300, temperature: 0.1,
            chat_template_kwargs: { enable_thinking: false },
            messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] })
        });
        if (!r.ok) { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '引擎不可用' })); }
        const d = await r.json();
        let content = (d.choices?.[0]?.message?.content || '').trim().replace(/```json/gi, '').replace(/```/g, '').trim();
        const m = content.match(/\{[\s\S]*\}/);
        if (!m) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, note: '' })); }
        const j = JSON.parse(m[0]);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: !!j.ok, note: j.note || '' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  // API: 健康检查
  if (url.pathname === '/api/mode' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, mode: appMode }));
  }
  if (url.pathname === '/api/mode' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const { mode } = JSON.parse(body || '{}');
        if (mode === 'ocr' || mode === 'vision') { appMode = mode; saveMode(mode); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode: appMode }));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false })); }
    });
    return;
  }
  if (url.pathname === '/api/health') {
    const health = { llama: false, ollama: false };
    try { const r = await fetch(`${LLAMA_URL}/health`, { signal: AbortSignal.timeout(3000) }); health.llama = r.ok; } catch (e) {}
    try { const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) }); if (r.ok) { const d = await r.json(); health.ollama = d.models.some(m => m.name.startsWith(MODEL)); } } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: health.llama || health.ollama,
      engine: health.llama ? 'llama.cpp(内置)' : (health.ollama ? 'ollama(回退)' : '无'),
      model: MODEL,
      primary: PRIMARY_ID,
      books: Object.fromEntries([...BOOKS.values()].map(b => [b.id, b.wordCount + '词' + (b.phraseCount ? '/' + b.phraseCount + '词组' : '')]))
    }));
    return;
  }
  // API: 词书列表 (可加 ?refresh=1 重扫 data/books)
  if (url.pathname === '/api/books') {
    if (url.searchParams.get('refresh')) loadAllBooks();
    const list = [...BOOKS.values()].map(bookBrief);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, primary: PRIMARY_ID, books: list }));
  }
  // API: 添加词书 (JSON 词书 / 纯文本词表)
  if (url.pathname === '/api/books/import' && req.method === 'POST') {
    let body = '';
    req.on("data", c => { body += c; if (body.length > 60000000) req.destroy(); }); // PDF(base64) 可较大
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const isPdf = (payload.pdfBase64 && String(payload.pdfBase64).length > 100) || /\.pdf$/i.test(String(payload.filename || ""));
        const r = isPdf ? await importBookFromPdf(payload) : importBook(payload);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, id: r.id, name: r.name, wordCount: r.wordCount, fromPdf: !!isPdf, pdfStats: r.pdfStats || null, books: [...BOOKS.values()].map(bookBrief) }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  // API: 切换主词书
  if (url.pathname === '/api/books/primary' && req.method === 'POST') {
    let body = '';
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const { id } = JSON.parse(body || "{}");
        if (!BOOKS.has(id)) throw new Error("词书不存在: " + id);
        writeSettings({ primaryBook: id });
        PRIMARY_ID = id;
        const p = BOOKS.get(id);
        console.log('[词书] 主词书切换 -> ' + id + ' (' + p.name + ')');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, primary: PRIMARY_ID }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  // API: 删除用户导入的词书 (内置词书不可删)
  if (url.pathname === '/api/books/delete' && req.method === 'POST') {
    let body = '';
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const { id } = JSON.parse(body || "{}");
        const rec = BOOKS.get(id);
        if (!rec) throw new Error("词书不存在: " + id);
        if (rec.origin !== "user") throw new Error("内置词书不可删除");
        const f = path.join(USER_BOOK_DIR, path.basename(rec.file));
        if (fs.existsSync(f)) fs.unlinkSync(f);
        loadAllBooks();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, primary: PRIMARY_ID, books: [...BOOKS.values()].map(bookBrief) }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  // API: 词书词条 (任意词书 id, ?q=搜索词&letter=A)
  if (url.pathname.startsWith('/api/book/') && req.method === 'GET') {
    const id = decodeURIComponent(url.pathname.slice('/api/book/'.length));
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();
    const letter = (url.searchParams.get('letter') || '').toUpperCase();
    const rec = BOOKS.get(id);
    if (!rec) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '词书不存在' }));
    }
    const TAG_CN = { zk: "中考", gk: "高考", cet4: "四级", cet6: "六级", ky: "考研", toefl: "托福", ielts: "雅思", gre: "GRE" };
    let items = (rec.book.words || []).map(w => {
      if (w.entries) return { word: w.word, pos: w.entries.map(e => e.pos).join("/"),
        meaning: w.entries.map(e => e.pos + ":" + e.level).join("；") };
      const tag = (w.exam_tags || []).map(t => TAG_CN[t] || t).slice(0, 3).join("·");
      return { word: w.word, pos: w.pos || "", phonetic: w.phonetic || "", tag: tag,
        meaning: String(w.meaning || "").replace(/\n/g, "；") };
    });
    if (q) items = items.filter(it => String(it.word).toLowerCase().includes(q) || String(it.meaning || "").toLowerCase().includes(q));
    if (letter && /^[A-Z]$/.test(letter)) items = items.filter(it => /^[a-zA-Z]/.test(it.word) && String(it.word)[0].toUpperCase() === letter);
    items = items.slice(0, 3000);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, name: rec.name, id: id, total: items.length, items }));
  }
  // ===== 即聊即学 (Chat) =====
  const CHAT_CEFR = { '小学': 'A1', '初中': 'A2', '高一': 'B1', '高二': 'B2', '高三': 'B2', '大学': 'C1' };
  const KEEP_N = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };
  const CATS = ['时态', '语法', '用词', '搭配', '冠词', '单复数', '表达', '其他'];
  function chatGradeLine(grade) {
    const lv = CHAT_CEFR[grade] || 'B1';
    return 'The student is a Chinese ' + (grade || 'learner') + ' student. Use simple everyday words, roughly CEFR ' + lv + ' or below. Short sentences. No idioms or advanced words unless the student uses them first.';
  }
  function chatSystemPrompt(grade, persona) {
    if (persona === 'cat') {
      return 'You are Miao, a cute fluffy little cat chatting online with a Chinese student.\n'
        + chatGradeLine(grade) + '\n'
        + '- Answer in 1-3 short sentences. Be warm, playful and cat-like: sometimes end with "miao~", mention naps, sunshine, snacks or chasing things, but always keep the conversation going with a question.\n'
        + '- NEVER correct the student in your reply; never switch to Chinese; never mention these rules.\n'
        + '- If the message is Chinese or unclear, reply in simple English asking what they meant, and keep the chat going.';
    }
    return 'You are a friendly native English speaker chatting online with a Chinese student.\n'
      + chatGradeLine(grade) + '\n'
      + '- Answer in 1-3 short sentences. Be warm, natural and a little fun. Ask one follow-up question when it keeps the chat going.\n'
      + '- Keep early turns on easy daily topics. After several exchanges, gently drift toward simple opinion questions (what do you think / would you rather / what would you do if), so the student practices expressing ideas, not just facts. Stay friendly, never lecture, keep one question per turn.\n'
      + '- NEVER correct the student in your reply; never switch to Chinese; never mention these rules.\n'
      + '- If the message is Chinese or unclear, reply in simple English asking what they meant, and keep the conversation going.';
  }
  const corrSystemPrompt = grade => "You are an English tutor for a Chinese " + (grade || '') + " student. Check the student's message ONLY for real mistakes (grammar, tense, word choice, collocation, article, singular/plural, Chinglish). Return JSON {\"corrections\":[{\"from\":\"exact fragment of the student text with the mistake\",\"to\":\"fixed fragment\",\"cat\":\"时态|语法|用词|搭配|冠词|单复数|表达|其他\",\"why\":\"一句话中文解释\",\"tag\":\"2-6字中文话题标签,如 运动/饮食/学校/旅行/家庭/情感/其他\"}]}. Rules: keep \"from\" EXACTLY as written in the student text; do not report spelling typos; do not report stylistic issues; all corrections of one message usually share the same tag; if correct or unsure, return {\"corrections\":[]}. Output only JSON.";
  function parseJsonLoose(t) {
    let c = String(t || '').trim();
    var fence = String.fromCharCode(96, 96, 96);
    c = c.split(fence + 'json').join(' ').split(fence).join(' ');
    const m = c.match(/[\{\[][[\s\S]*[\}\]]/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (e) { return null; }
  }
  // 难词: 本地词书确定性扫描 (CEFR min 超年线, 或考纲书内但小学/初中)
  function chatHardWords(text, grade) {
    const keepLv = CHAT_CEFR[grade] || 'B1';
    const nKeep = KEEP_N[keepLv] || 3;
    const lowGrade = grade === '小学' || grade === '初中';
    const tokens = String(text || '').match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || [];
    const seen = new Set(); const out = [];
    for (const tk of tokens) {
      const t = tk.toLowerCase();
      if (STOP.has(t) || t.length < 3 || seen.has(t)) continue;
      seen.add(t);
      const cands = [t];
      if (t.endsWith('ies')) cands.push(t.slice(0, -3) + 'y');
      if (t.endsWith('es')) cands.push(t.slice(0, -2));
      if (t.endsWith('s')) cands.push(t.slice(0, -1));
      if (t.endsWith('ied')) cands.push(t.slice(0, -3) + 'y');
      if (t.endsWith('ed')) cands.push(t.slice(0, -2), t.slice(0, -1));
      if (t.endsWith('ing')) cands.push(t.slice(0, -3), t.slice(0, -3) + 'e');
      let hitC = null, hitB = null;
      for (const cand of cands) { hitC = hitC || CEFR_INDEX[cand]; hitB = hitB || BOOK_INDEX.info[cand]; if (hitC) break; }
      if (!hitC && !hitB) continue;
      const hard = (hitC && LVL_N[hitC.minLevel] > nKeep) || (lowGrade && !!hitB);
      if (!hard) continue;
      out.push({ w: tk, level: hitC ? (hitC.maxLevel || hitC.minLevel) : '考纲', zh: hitB && hitB.meaning ? String(hitB.meaning).slice(0, 50) : '' });
      if (out.length >= 12) break;
    }
    return out;
  }
  async function chatAny(messages) {
    try { return await llamaChat(messages); }
    catch (e) { return await ollamaChat(messages); }
  }
  if (url.pathname === '/api/chat/open' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 50000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { grade, topic, persona } = JSON.parse(body || '{}');
        const TOPICS = {
          daily: 'Ask something light about their day: food, weekend plans, school life, weather.',
          mood: 'Gently ask how they are feeling today and why.',
          deep: 'Ask ONE simple opinion question a student can answer with a personal view (e.g. is it better to text or call? should students have part-time jobs?). Keep the wording very easy.',
          ai: 'Pick any fun light everyday topic you like (games, pets, music, movies, sports, snacks...) and ask about it.'
        };
        const catFlavor = persona === 'cat';
        const sys = (catFlavor ? 'You are Miao, a cute little cat meeting a Chinese student for the first time. ' : 'You are a friendly native English speaker starting a chat with a Chinese student. ') + chatGradeLine(grade) + ' Open with ONE short cheerful greeting and then ONE question. Maximum 2 short sentences total. Do not use Chinese. ' + (catFlavor ? 'Add a tiny cat touch, e.g. end with "miao~". ' : '') + (TOPICS[topic] || TOPICS.ai);
        const raw = await chatAny([{ role: 'system', content: sys }, { role: 'user', content: '(start the conversation now)' }]);
        const reply = String(raw || '').trim().slice(0, 600);
        if (!reply) throw new Error('引擎无输出');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, reply, topicTitle: { daily: '聊日常', mood: '聊心情', deep: '聊点idea', ai: 'AI 挑话题' }[topic] || 'AI 开场', hardWords: chatHardWords(reply, grade) }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 200000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { message, grade, history, persona } = JSON.parse(body || '{}');
        if (!message || !String(message).trim()) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '消息为空' })); }
        const msgs = Array.isArray(history) ? history.slice(-10).filter(h => h && h.role && h.content).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.content).slice(0, 1500) })) : [];
        const user = String(message).slice(0, 2000);
        const t0 = Date.now();
        const [replyRaw, corrRaw] = await Promise.all([
          chatAny([{ role: 'system', content: chatSystemPrompt(grade, persona) }, ...msgs, { role: 'user', content: user }]),
          chatAny([{ role: 'system', content: corrSystemPrompt(grade) }, { role: 'user', content: user }])
        ]);
        const reply = String(replyRaw || '').trim().slice(0, 1200);
        const cj = parseJsonLoose(corrRaw);
        let corrections = (cj && Array.isArray(cj.corrections) ? cj.corrections : []).filter(x => x && x.from && x.to && String(x.from).trim() !== String(x.to).trim()).slice(0, 6);
        for (const x of corrections) { x.cat = String(x.cat || '其他').slice(0, 8); x.why = String(x.why || '').slice(0, 140); x.tag = String(x.tag || '其他').replace(/[^一-龥A-Za-z]/g, '').slice(0, 8) || '其他'; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, reply, corrections, hardWords: chatHardWords(reply, grade), timeMs: Date.now() - t0 }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  // ===== 作文批改 (主攻语言与表达) =====
  const ESSAY_CAP = 4500;
  // 表达标注校验: 逐字必须出自正文, 不合格重试一次, 仍不合格则宁缺毋滥
  const normExpr = x => String(x || '').toLowerCase().replace(/[\u2018\u2019\']/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  async function verifyExpressions(essay) {
    const eNorm = normExpr(essay);
    for (let attempt = 0; attempt < 2; attempt++) {
      let raw2;
      try {
        raw2 = await chatAny([{ role: 'system', content: '你是英语老师。从学生范文中挑 2 个最值得背的表达(短语或从句, 4-12 词)。硬性规则: 英文必须逐字摘自原文, 不得改写; 中文对译必须准确反映该表达在文中的意思。输出恰好 2 行, 每行格式: 英文 — 中文。禁止其他文字。'+(attempt ? ' 注意: 上次你编造了原文没有的表达。这次先在心里确认每个英文片段能在原文中原样找到, 再输出。' : '') }, { role: 'user', content: essay }]);
      } catch (e) { return ''; }
      const lines = String(raw2 || '').split(/\r?\n/).map(x => x.trim()).filter(x => x && !/^[【】a-z#：:]*最值得/i.test(x));
      const good = [];
      for (const ln of lines) {
        const m = ln.split(/s*(?:—|–|-{1,2})s*/);
        if (m.length < 2) continue;
        const en = m[0].replace(/^[*•\s]+/, '').replace(/[.,;:；，。]+$/, '').trim();
        const zh = m.slice(1).join(' — ').trim();
        if (!en || !zh) continue;
        if (eNorm.includes(normExpr(en))) good.push(en + ' — ' + zh);
        if (good.length === 2) break;
      }
      if (good.length) return '\n\n最值得学的两个表达：\n' + good.join('\n');
    }
    return '';
  }
  if (url.pathname === '/api/essay' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 200000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { action, topic, text, kind, grade } = JSON.parse(body || '{}');
        const t = String(text || '').slice(0, ESSAY_CAP);
        const tp = String(topic || '').slice(0, 300);
        const t0 = Date.now();
        if (action === 'assist') {
          const ASS = {
            explain: '学生没读懂这个英语作文题目。用中文简短回答: 用中文简短回答: ①【要完成的任务】题目里向学生提出要求的那几句才算任务(特征: please do... / 你必须 / 内容须包括 / include 后面列的条目), 把每条用中文概括成一句\'学生要写什么\'(例: 任务1: 从两门课中选一门并说明理由)。题目中\'你是谁/发生了什么事/背景原因\'这些陈述句绝不是任务, 禁止列入, 列了就是出错。写完数一遍: 一般 2-3 条, 超过 4 条说明把背景当任务了, 回头重列。②体裁(书信/邮件/记叙文/议论文)+人称+主要时态。③最容易漏掉的那条任务或最易跑题的地方(1-2条)。不超过250字。' + String.fromCharCode(10) + '题目: ' + tp,
            ideas: '学生要写一篇英语作文, 题目如下。严格按此格式输出(中文): 第一部分【题目要求】先数清题目一共列了几条内容要求(常见2-3条, 数出几列几, 多一条都算错), 然后逐条用中文转述, 格式: 要求1:… 要求2:…。只列题目真正要求写的内容, 身份/背景/邮件格式说明不算要求, 禁止编造题目没有的条目。之后另起一行写体裁/人称/时态。第二部分【角度】给2个切入角度, 每个角度一句素材方向(具体到场景和细节)。第三部分【语块】每个角度3行, 每行格式必须是: 英语原文 — 中文对译, 英语必须是能直接抄进作文的名词短语/从句/句型。正确示例行: no algorithm can plan a surprise — 算法算不出意外的惊喜。错误示例(禁止): Emphasize the value of travel — 强调旅行价值 (这是指令不是语块)。不要写成文。' + String.fromCharCode(10) + '题目: ' + tp,
            sample: 'Write ONE short model essay (about 120-180 words) for the title below. It MUST contain one concrete scene with specific details (a place, a moment, an action, what was said or felt) - never a string of abstract statements; if the task asks for a narrative, tell an actual story with characters. Level: ' + (CHAT_CEFR[grade] || 'B1') + ', wording may be moderately advanced to demonstrate good expression. Keep language natural, not purple. This is an exam model answer: polished, well-mannered register throughout; at most one exclamation mark; no childish repetition or chat-style fragments. If the task is a letter/email/reply, you ARE the writer writing to the real recipient: open with Dear X, close with a proper sign-off, give the requested advice/reasons directly - NEVER write a story about someone reading or receiving the letter. Output ONLY the essay body, no title line, no notes, no Chinese.' + String.fromCharCode(10) + '题目: ' + tp,
          };
          if (!ASS[kind]) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'kind 无效' })); }
          if (!tp.trim()) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '先填写题目' })); }
          const isLetterTask = /letter|email|write (to|him|her|them)|reply|column|invit|apply/i.test(tp);
          const LETTER_SAMPLE = 'Write the ACTUAL letter/email itself as a Chinese senior-3 student answering the task below. First line must be the greeting (Dear ...). Middle: do the required jobs (advice/reasons/invitation...) directly and concretely, in 110-150 words. Last line: a proper sign-off (Best, Li Ming / Yours, Li Hua). NEVER write about reading a letter, never describe being a reader - you ARE the writer. This is a written EXAM model answer (Shanghai gaokao style), so keep the register polished and exam-appropriate: friendly tone when writing to a friend but well-mannered; use at most one exclamation mark in the whole letter; no babyish repetition like Please, please!; no slang contractions like wanna/gonna. Plain English, no markdown.' + String.fromCharCode(10) + String.fromCharCode(10) + 'Task: ';
          if (kind === 'sample' && isLetterTask) {
            const rawL = await chatAny([{ role: 'system', content: LETTER_SAMPLE }, { role: 'user', content: tp }]);
            let rl = String(rawL).trim().slice(0, 2500);
            if (!/^\s*(Dear|Hi|Hello)/im.test(rl)) {
              const rawL2 = await chatAny([{ role: 'system', content: LETTER_SAMPLE + ' (retry: your last answer was NOT a letter. Output the letter itself now.)' }, { role: 'user', content: tp }]);
              const rl2 = String(rawL2).trim().slice(0, 2500);
              if (/^\s*(Dear|Hi|Hello)/im.test(rl2)) rl = rl2;
            }
            rl += await verifyExpressions(rl);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ ok: true, result: rl, timeMs: Date.now() - t0 }));
          }
          const sys = kind === 'sample'
            ? 'You are a skilled English writer; your student is a Chinese ' + (grade || '') + ' learner. Follow the output format exactly. Plain text only, no markdown, no asterisks, no bold.'
            : '你是英语写作教练。中文回答, 列点, 别长篇大论。纯文本输出, 禁止使用 # 星号 反引号 等 markdown 符号, 用普通缩进和编号。';
          const raw = await chatAny([{ role: 'system', content: sys }, { role: 'user', content: ASS[kind] }]);
          let result = String(raw).trim().slice(0, 2500);
          if (kind === 'sample') result += await verifyExpressions(result);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: true, result, timeMs: Date.now() - t0 }));
        }
        if (action === 'proofread') {
          if (!t.trim()) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '作文为空' })); }
          const steps = [];
          const head = (tp ? '题目: ' + tp + String.fromCharCode(10) : '') + '作文:' + String.fromCharCode(10) + t;
          const e1 = await chatAny([{ role: 'system', content: 'You are an English teacher checking a Chinese student essay for LANGUAGE mistakes only (grammar, tense, article, singular/plural, spelling, punctuation, word choice, collocation, Chinglish). Do NOT comment on ideas or depth. Return JSON {"errors":[{"en":"exact fragment copied from the essay","fix":"corrected fragment","cat":"语法|拼写|标点|词汇|搭配|句式|表达","why":"简短中文解释"}]}. Max 12, most important first; few mistakes then few items. Output only JSON.' }, { role: 'user', content: head }]);
          const ej = parseJsonLoose(e1) || {};
          let errors = (Array.isArray(ej.errors) ? ej.errors : []).filter(x => x && x.en && x.fix && String(x.en).trim() !== String(x.fix).trim()).slice(0, 12);
          for (const x of errors) { x.cat = String(x.cat || '表达').slice(0, 6); x.why = String(x.why || '').slice(0, 120); }
          steps.push({ name: 'errors', n: errors.length });
          const e2 = await chatAny([{ role: 'system', content: 'Rewrite the student essay below so the LANGUAGE becomes more natural, vivid and impressive: better word choice, varied sentence patterns, idiomatic collocations. Wording may be moderately advanced - that is the point. Keep the ideas, structure and approximate length; do NOT invent new content or change the topic. Output ONLY the improved essay.' }, { role: 'user', content: head }]);
          const polished = String(e2 || '').trim().slice(0, 4500);
          steps.push({ name: 'polished', len: polished.length });
          const e3 = await chatAny([{ role: 'system', content: '用一个中文 JSON 点评学生英语作文(不要 markdown): {"structure":"1-2句结构提示,点到为止","content":"1-2句内容提示,只指最明显一处,不说教","highlights":"原文最值得表扬的1-2个表达,引号标出英文"}。本系统主攻语言打磨,结构内容只轻提。只输出 JSON。' }, { role: 'user', content: head }]);
          const nj = parseJsonLoose(e3) || {};
          const notes = { structure: String(nj.structure || '').slice(0, 200), content: String(nj.content || '').slice(0, 200), highlights: String(nj.highlights || '').slice(0, 200) };
          steps.push({ name: 'notes' });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: true, errors, polished, notes, steps, truncated: String(text || '').length > ESSAY_CAP, timeMs: Date.now() - t0 }));
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'action 无效' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === '/api/util' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 200000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { action, text, grade } = JSON.parse(body || '{}');
        const t = String(text || "").slice(0, 2500);
        if (!t.trim()) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '文本为空' })); }
        const SYSP = {
          translate: "Translate the user's English text into natural, faithful Chinese. Output ONLY the translation.",
          explain: "You are an English grammar teacher. Analyze the structure of the user's English sentence: break it into chunks (主语/谓语/宾语/定语/状语/补语/从句 etc.) with Chinese labels, then explain key grammar points in 1-3 short Chinese sentences. Plain text, short lines, no markdown.",
          upgrade: "The user gives an English sentence written by a Chinese " + (grade || '') + " student. Rewrite it as a MORE NATURAL, idiomatic English sentence a well-educated native speaker would say; wording may be moderately advanced (this is for learning). Keep the original meaning exactly. Return JSON {\"upgraded\":\"the improved sentence\",\"why\":\"两三句中文：改在哪里、原句哪里不够自然\",\"note\":\"一个关键用词或搭配的简短中文讲解\"}"
        };
        if (!SYSP[action]) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'action 无效' })); }
        const raw = await chatAny([{ role: 'system', content: SYSP[action] }, { role: 'user', content: t }]);
        let out = {};
        if (action === 'upgrade') {
          const j = parseJsonLoose(raw) || {};
          const up = String(j.upgraded || raw).trim().slice(0, 600);
          out = { ok: !!up, upgraded: up, why: String(j.why || '').slice(0, 300), note: String(j.note || '').slice(0, 300), hardWords: chatHardWords(up, grade) };
        } else {
          out = { ok: true, result: String(raw).trim().slice(0, 2000) };
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === '/api/word' && req.method === 'GET') {
    const w0 = (url.searchParams.get('w') || '').toLowerCase().trim();
    const c = CEFR_INDEX[w0];
    const bk = BOOK_INDEX.info[w0];
    const cet = (CET4 && CET4.index[w0]) || (CET6 && CET6.index[w0]);
    let zh = '';
    if (bk && bk.meaning) zh = String(bk.meaning).slice(0, 60);
    else if (cet && cet.meaning) zh = String(cet.meaning).replace(/\n/g, '；').slice(0, 60);
    else if (c && c.entries && c.entries[0]) zh = String((c.entries[0].pos || '') + ' ' + (c.entries[0].trans || c.entries[0].meaning || '')).trim().slice(0, 60);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, word: w0, level: c ? (c.maxLevel || c.minLevel) : null, zh, inBook: !!(bk || cet) }));
  }
  // ===== 即读即学 (Read) =====
  const READ_LEVELS = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5 };
  if (url.pathname === '/api/read' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 200000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { action, text, level } = JSON.parse(body || '{}');
        const t = String(text || '').trim().slice(0, 4000);
        if (!t) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '内容为空' })); }
        const t0 = Date.now();
        if (action === 'translate') {
          const lv = READ_LEVELS[level] ? level : 'B1';
          const sys = 'You are a professional translator. Translate the user text into natural fluent English matched to CEFR ' + lv + ' difficulty: use vocabulary and sentence structures a ' + lv + ' student can follow, without losing meaning or paragraph structure. If the input is already English, rewrite it to sit right at ' + lv + ' level. Output ONLY the English text.';
          const raw = await chatAny([{ role: 'system', content: sys }, { role: 'user', content: t }]);
          const out = String(raw).trim().slice(0, 6000);
          if (!out) throw new Error('翻译输出为空');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: true, result: out, level: lv, timeMs: Date.now() - t0 }));
        }
        if (action === 'quiz') {
          const sys = 'You are a reading test writer. Based ONLY on the English text, write 3-4 comprehension questions IN ENGLISH (detail/inference/main-idea mix). Return JSON {"questions":[{"q":"question","options":["A","B","C","D"],"answer":0,"why":"中文解析"}]}. answer = index of correct option (0-3). Distractors plausible, one correct answer only. Output only JSON.';
          const raw = await chatAny([{ role: 'system', content: sys }, { role: 'user', content: t.slice(0, 3000) }]);
          const j = parseJsonLoose(raw) || {};
          let qs = (Array.isArray(j.questions) ? j.questions : []).filter(x => x && x.q && Array.isArray(x.options) && x.options.length >= 3).slice(0, 4);
          for (const x of qs) { x.options = x.options.slice(0, 4).map(o => String(o).slice(0, 160)); x.answer = Math.max(0, Math.min(3, parseInt(x.answer, 10) || 0)); x.why = String(x.why || '').slice(0, 200); x.q = String(x.q).slice(0, 300); }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: true, questions: qs, timeMs: Date.now() - t0 }));
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'action 无效' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  // 静态文件
  let file = path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[english-study] http://127.0.0.1:${PORT} | model=${MODEL}`);
});
