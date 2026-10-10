'use strict';
// 雷仔 · 会话归档存储层（SQLite 主路径 + JSONL 回退）
//
// 设计（对齐"一个对话=一个项目"的领土模型）：
//  - 每会话归档 = 全量追加的"旧回合领土"，模型经 recall_context 按关键词召回；
//  - SQLite（node:sqlite，Node ≥23.4 内置，零依赖）承担存储/分页/裁剪/世代字段，
//    替代原"手搓行偏移索引 + 128MB 缓存"方案（约 200 行自研索引代码）；
//  - node:sqlite 不可用时回退到原 JSONL append-only 实现（行为完全一致）；
//  - 结构化字段：gen（世代号）、seq（会话内序号）、tool_calls/tool_call_id（工具调用参数）、
//    full（巨文全文标记）、kind（flow=流水 / doc=交接文档；doc 永不参与裁剪）；
//  - 裁剪分级：flow 条目超 archiveMaxEntries 时从最旧淘汰（重要决策在记忆/进度文件双保险）；
//  - 首次启动自动导入旧 data/archives/*.jsonl（按 size+mtime 标记，幂等，不删旧文件）。
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');

const DEFAULT_DIR = path.join(DATA_DIR, 'archives');
const DB_FILE = 'leizai_archive.db';

let ARCHIVE_DIR = DEFAULT_DIR;
let mode = 'jsonl';        // 'sqlite' | 'jsonl'
let db = null;             // DatabaseSync
let inited = false;

// P2b-16（2026-09-22 性能）：本会话容量的**轻量估算**，替代"每次 save 都全表 SUM"。
//   sessionId → { bytes, added, seeded }：
//     bytes  = 上次真实 SUM 的字节数（播种/精算时更新）
//     added  = 自上次精算以来新增的字节数（save 时累加 content+bi 长度）
//     seeded = 是否做过至少一次真实 SUM（false=冷启动未播种，需先精算一次）
//   仅用于"跳过"判定；**trim 决策始终基于真实 SUM**（精算后才删），故估算偏差不影响正确性。
const _sizeEst = new Map();

// —— JSONL 回退路径的状态（与原 memory.js 实现等价） ——
const _archiveCounts = new Map();   // sessionId → { n, size }
const _archLineIdx = new Map();     // sessionId → { size, mtimeMs, byteOffsets, charStarts, rawStr|null }
const _ARCH_RAW_CACHE_MAX = 128 * 1024 * 1024;
const ARCHIVE_SEARCH_FULL_MAX = 4000;   // 召回命中条目的全文截断上限（防单条巨文撑爆上下文）

// ———————— 初始化 ————————

function archiveFile(sessionId) {
  return path.join(ARCHIVE_DIR, String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_') + '.jsonl');
}

/**
 * 初始化存储层（可重复调用以重定向目录，供测试隔离）。
 * @param {object} opts { dir?, force?: 'sqlite'|'jsonl' }  默认 data/archives
 * @returns {string} 生效模式
 */
function init(opts = {}) {
  if (opts && opts.dir) ARCHIVE_DIR = opts.dir;
  // E-3b（2026-10-03）：数据目录不可用（ENOTDIR/EACCES/EPERM…）不得抛未捕获异常 → 明确中文报错后优雅退出。
  try {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  } catch (e) {
    const _m = String((e && e.message) || e).split('\n')[0];
    const _reason = (e && e.code && !_m.includes(e.code)) ? e.code + ': ' + _m : _m;
    const _msg = `[雷仔] 数据目录不可用，无法启动：\n  路径：${ARCHIVE_DIR}\n  原因：${_reason}\n  请检查 LEIZAI_DATA_DIR / 数据目录配置或目录权限（其父级可能是一个文件）。`;
    try { process.stderr.write(_msg + '\n'); } catch { try { console.error(_msg); } catch { } }
    process.exit(1);
  }
  let target = 'jsonl';
  if (!(opts && opts.force)) {
    try {
      const sqlite = require('node:sqlite');
      const tmp = new sqlite.DatabaseSync(':memory:');
      tmp.close();
      target = 'sqlite';
    } catch (e) {
      target = 'jsonl';
    }
  }
  if (target === 'sqlite') {
    try {
      const sqlite = require('node:sqlite');
      if (db) { try { db.close(); } catch { } }
      db = new sqlite.DatabaseSync(path.join(ARCHIVE_DIR, DB_FILE));
      db.exec('PRAGMA journal_mode=WAL;');
      db.exec('PRAGMA synchronous=NORMAL;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS archive (
          session_id  TEXT    NOT NULL,
          seq         INTEGER NOT NULL,
          gen         INTEGER NOT NULL DEFAULT 0,
          role        TEXT    NOT NULL,
          ts          INTEGER NOT NULL,
          content     TEXT    NOT NULL,
          tool_calls  TEXT,
          tool_call_id TEXT,
          full        INTEGER NOT NULL DEFAULT 0,
          kind        TEXT    NOT NULL DEFAULT 'flow',
          PRIMARY KEY (session_id, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_archive_sid_kind_seq ON archive(session_id, kind, seq);
        CREATE TABLE IF NOT EXISTS archive_meta (
          session_id      TEXT PRIMARY KEY,
          gen             INTEGER NOT NULL DEFAULT 0,
          imported_size   INTEGER NOT NULL DEFAULT 0,
          imported_mtime  INTEGER NOT NULL DEFAULT 0
        );
      `);
      mode = 'sqlite';
      _hasBiCol = null; _hasFts = null;
      // 必须先把 inited 置位再迁移：save()→ensureInit() 会读 inited，
      // 若迁移期间为 false → 递归 init()→migrateJsonl()→save()…（曾实测死循环至 OOM）
      inited = true;
      migrateJsonl();
    } catch (e) {
      console.log(`[archive] SQLite 初始化失败，回退 JSONL: ${e.message}`);
      if (db) { try { db.close(); } catch { } db = null; }
      mode = 'jsonl';
    }
  } else {
    mode = 'jsonl';
  }
  inited = true;
  return mode;
}

function ensureInit() {
  if (!inited) init();
  return mode;
}

// ———————— 世代号（每次深收纳换代 +1，持久化于 meta 表/文件） ————————

function nextGen(sessionId) {
  if (ensureInit() === 'sqlite' && db) {
    db.prepare('UPDATE archive_meta SET gen = gen + 1 WHERE session_id = ?').run(sessionId);
    if (db.prepare('SELECT changes() AS c').get().c === 0) {
      db.prepare('INSERT INTO archive_meta (session_id, gen) VALUES (?, 1)').run(sessionId);
    }
    return db.prepare('SELECT gen FROM archive_meta WHERE session_id = ?').get(sessionId).gen;
  }
  // JSONL 回退：无 meta 文件时以 0 起始（世代号仅在 SQLite 模式全功能；回退不阻断主流程）
  return 0;
}

// ———————— 写入 ————————

/**
 * 追加归档条目。
 * @param {string} sessionId
 * @param {Array} messages  [{role, content, toolCalls?, toolCallId?, _full?}]
 * @param {object} opts { gen?, kind?: 'flow'|'doc' }
 * @returns {number} 写入条数
 */
function save(sessionId, messages, opts = {}) {
  const entries = (messages || []).filter((m) => m && m.content !== undefined && m.content !== null);
  if (!entries.length) return 0;
  const gen = opts.gen !== undefined ? opts.gen : currentGen(sessionId);
  const kind = opts.kind === 'doc' ? 'doc' : 'flow';
  ensureInit();
  if (mode === 'sqlite' && db) {
    const ts = Date.now();
    let seq = nextSeq(sessionId);
    try {
      const hasBi = hasBiColumn();
      const sqlIns = hasBi
        ? 'INSERT INTO archive (session_id, seq, gen, role, ts, content, tool_calls, tool_call_id, full, kind, bi) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        : 'INSERT INTO archive (session_id, seq, gen, role, ts, content, tool_calls, tool_call_id, full, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
      // 预计算 bi（应用层算 bigram；trigger 只 copy 列，禁调 JS 函数）
      const rowList = entries.map((m) => {
        const row = [sessionId, seq++, gen, String(m.role || 'assistant'), m.ts || ts, String(m.content ?? ''),
          m.toolCalls && m.toolCalls.length ? JSON.stringify(m.toolCalls) : null,
          m.toolCallId || null,
          m._full ? 1 : 0, kind];
        if (hasBi) row.push(biText(String(m.content ?? '')));
        return row;
      });
      db.exec('BEGIN');
      // 注：逐行 prepare（不用长命 StatementSync）——node:sqlite 下长命语句在 GC 压力（如算 bi 的大字符串分配）后
      // 可能被提前 finalize → "statement has been finalized"（实测复现）；用完即弃最稳。
      for (const row of rowList) db.prepare(sqlIns).run(...row);
      db.exec('COMMIT');
      // P2b-16：累加"自上次精算以来的新增字节"（content 长度 + bi 长度），供 enforceCapacity 估算门使用。
      try {
        let _added = 0;
        for (const row of rowList) {
          _added += String(row[5] || '').length;
          if (hasBi) _added += String(row[10] || '').length;
        }
        _bumpEst(sessionId, _added);
      } catch { }
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { }
      throw e;
    }
    enforceCapacity(sessionId);
    return entries.length;
  }
  return jsonlSave(sessionId, entries, gen, kind);
}

function currentGen(sessionId) {
  if (mode === 'sqlite' && db) {
    const r = db.prepare('SELECT gen FROM archive_meta WHERE session_id = ?').get(sessionId);
    return r ? r.gen : 0;
  }
  return 0;
}

function nextSeq(sessionId) {
  const r = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM archive WHERE session_id = ?').get(sessionId);
  return r.s;
}

/** 分级裁剪：flow 条目超上限时从最旧淘汰；doc 条目永不裁剪。（archiveMaxEntries=0 → 不限条数） */
function trimFlow(sessionId) {
  const raw = Number(require('./config').load().archiveMaxEntries);
  const cap = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  if (cap <= 0) return;   // 0/非法 = 不限条数（方案C：取消硬性条数上限）
  const row = db.prepare(`SELECT COUNT(*) AS n FROM archive WHERE session_id = ? AND kind = 'flow'`).get(sessionId);
  if (!row || row.n <= cap) return;
  const cutoff = db.prepare(`SELECT seq FROM archive WHERE session_id = ? AND kind = 'flow' ORDER BY seq DESC LIMIT 1 OFFSET ?`)
    .get(sessionId, cap - 1);
  if (!cutoff) return;
  db.prepare(`DELETE FROM archive WHERE session_id = ? AND kind = 'flow' AND seq < ?`).run(sessionId, cutoff.seq);
}

/** P2b-16 附带修复：字节求和表达式按是否存在 bi 列自适应 —— 原实现无条件 `length(bi)`，
 *  在**未跑 bi 迁移脚本**的新库上会抛错 → catch → 静默返回 0（容量护栏对这类库完全失效）。
 *  生产库已有 bi 列，行为不变；新库/测试库从"恒 0"变为正确值。 */
function _sizeSumExpr() {
  return hasBiColumn()
    ? 'COALESCE(SUM(length(content)),0) + COALESCE(SUM(length(bi)),0)'
    : 'COALESCE(SUM(length(content)),0)';
}

/** 各会话 flow 占用（MB）降序前 N：{maxMB, top:[{sessionId,mb}]}。供容量护栏与前端展示。 */
function maxSessionFlowMB(topN = 5) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return { maxMB: 0, top: [] };
    const rows = db.prepare(`SELECT session_id AS sid, ${_sizeSumExpr()} AS b
      FROM archive WHERE kind = 'flow' GROUP BY session_id ORDER BY b DESC LIMIT ?`).all(Math.max(1, Number(topN) || 5));
    const top = rows.map((r) => ({ sessionId: String(r.sid), mb: Math.round(((r.b || 0) / 1048576) * 100) / 100 }));
    return { maxMB: top.length ? top[0].mb : 0, top };
  } catch { return { maxMB: 0, top: [] }; }
}

/** 归档库当前文件大小（MB）——诊断用（容量兜底已改为按"单会话"计量，见 sessionSizeMB）。 */
function dbSizeMB() {
  try { return fs.statSync(path.join(ARCHIVE_DIR, DB_FILE)).size / 1024 / 1024; } catch { return 0; }
}

/** 单个会话 **flow 占用** 估算（MB）：SUM(length(content)+length(bi)) WHERE kind='flow' / 1MB。
 *  只计 flow——doc 永不删，就不该计入触发计量（否则 doc 超 cap 的会话会"永远判超限"、每回合把 flow 删空）。
 *  同时使 avg（字节/flow 行）不被 doc 拉偏。 */
function sessionSizeMB(sessionId) {
  try {
    const r = db.prepare(`SELECT ${_sizeSumExpr()} AS b FROM archive WHERE session_id = ? AND kind = 'flow'`).get(sessionId);
    return ((r && r.b) || 0) / 1024 / 1024;
  } catch { return 0; }
}

/** P2b-16：累加本会话"自上次精算以来新增字节"（估算用；不影响真实数据）。 */
function _bumpEst(sessionId, bytes) {
  if (!sessionId || !(bytes > 0)) return;
  let st = _sizeEst.get(sessionId);
  if (!st) { st = { bytes: 0, added: 0, seeded: false }; _sizeEst.set(sessionId, st); }
  st.added += bytes;
}

/** P2b-16：读本会话估算状态（供测试/诊断；只读）。 */
function sizeEstimate(sessionId) {
  const st = _sizeEst.get(sessionId);
  return st ? { bytes: st.bytes, added: st.added, seeded: st.seeded, estBytes: st.bytes + st.added } : { bytes: 0, added: 0, seeded: false, estBytes: 0 };
}

/** 容量兜底（方案C·单会话版）：条数上限（原 trimFlow 逻辑）+ **本会话**容量上限
 *  （本会话占用 > cap → 删本会话最旧 flow 回 80% 低水位 + incremental_vacuum）。
 *  - **恒只删本会话 flow**（kind='flow'）；**doc 永不删、其他会话绝不触碰**。
 *  - archiveMaxSizeMB = **单会话**容量上限（每会话独立；0=不限制）；计量**只计 flow**（doc 不计入）。
 *  - 开关 archiveCapacityGuard=false → 完全回退（不裁剪）。
 *  - P2b-16（性能）：加**估算门**——常态（est < cap×0.9）直接 return，不做全表 SUM（原每次 save 638ms）；
 *    仅"冷启动未播种"或"逼近上限"才真实精算，**trim 决策始终基于真实 SUM**。 */
function enforceCapacity(sessionId) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return;
    if (!sessionId) return;
    let cfg; try { cfg = require('./config').load(); } catch { cfg = {}; }
    if (cfg.archiveCapacityGuard === false) return;
    // ① 条数上限（保留原 trimFlow 逻辑；0=不限）
    trimFlow(sessionId);
    // ② 本会话容量上限
    const capMB = Number(cfg.archiveMaxSizeMB);
    if (!(capMB > 0)) return;
    // 安全下限防误删：cap 低于 archiveMinSizeMB（默认 50MB）→ 只警告、不删（除非显式 archiveAllowTinyCap===true）
    const minMB = Number.isFinite(Number(cfg.archiveMinSizeMB)) ? Number(cfg.archiveMinSizeMB) : 50;
    if (minMB > 0 && capMB < minMB && cfg.archiveAllowTinyCap !== true) {
      console.log(`[归档容量] archiveMaxSizeMB=${capMB} < 安全下限${minMB}，跳过清理（防误删）`);
      return;
    }
    // ③ 估算门（P2b-16）：常态直接跳过全表 SUM
    const capBytes = capMB * 1024 * 1024;
    let st = _sizeEst.get(sessionId);
    let realBytes;
    if (!st || !st.seeded) {
      realBytes = sessionSizeMB(sessionId) * 1048576;      // 冷启动：播种一次真实 SUM
      _sizeEst.set(sessionId, { bytes: realBytes, added: 0, seeded: true });
      st = _sizeEst.get(sessionId);
    } else if (st.bytes + st.added >= capBytes * 0.9) {
      realBytes = sessionSizeMB(sessionId) * 1048576;      // 逼近上限：精算
      st.bytes = realBytes; st.added = 0;
    } else {
      return;                                             // 快路径：估算远低于上限 → 不查询、不裁剪
    }
    const sizeMB = realBytes / 1048576;
    if (!(sizeMB > capMB)) return;
    const cnt = (db.prepare(`SELECT COUNT(*) AS n FROM archive WHERE session_id = ? AND kind = 'flow'`).get(sessionId) || {}).n || 0;
    if (!cnt) return;
    const avg = (sizeMB * 1024 * 1024) / cnt;                // 本会话 avg 字节/flow 行（只计 flow）
    const targetMB = capMB * 0.8;                            // 80% 低水位
    const needBytes = (sizeMB - targetMB) * 1024 * 1024;
    const k = Math.max(1, Math.ceil((needBytes / avg) * 1.25));   // 保守放大 1.25
    // 恒只删本会话最旧的 k 条 flow（k 超量时即删完该会话全部 flow）
    let deleted = 0, delBytes = 0;
    const hasBi2 = hasBiColumn();
    const selRows = db.prepare(`SELECT seq${hasBi2 ? ', length(content) + COALESCE(length(bi), 0)' : ', length(content)'} AS b FROM archive WHERE session_id = ? AND kind = 'flow' ORDER BY seq ASC LIMIT ?`).all(sessionId, k);
    const del = db.prepare(`DELETE FROM archive WHERE session_id = ? AND kind = 'flow' AND seq = ?`);
    for (const r of selRows) { try { const n = del.run(sessionId, r.seq).changes || 0; deleted += n; if (n) delBytes += Number(r.b) || 0; } catch { } }
    // P2b-16：同步估算（减去已删字节，保留 added=0）→ 避免删除后估算偏高导致连续精算
    try { st.bytes = Math.max(0, (st.bytes || 0) - delBytes); st.added = 0; } catch { }
    if (deleted > 0) {
      try { db.exec('PRAGMA incremental_vacuum;'); } catch { /* 未开 INCREMENTAL → 跳过，留待定期 VACUUM */ }
      console.log(`[归档容量] 会话 ${sessionId} 超限 ${sizeMB.toFixed(2)}MB>${capMB}MB，删 ${deleted} 条 flow（avg≈${Math.round(avg)}B）`);
    }
  } catch (e) {
    console.log(`[归档容量] 失败（不影响写入）：${e.message}`);
  }
}

// ———————— 检索 / 读取 / 计数 ————————

/**
 * 关键词检索（与旧实现同语义：分词 + 命中比例打分 + 完整原文召回，最多 limit 条）。
 * @returns {Array<{role, snippet, score, ts, content}>}
 */
function search(sessionId, query, limit = 5, opts = {}) {
  ensureInit();
  const words = String(query || '').split(/[\s,，。、;；]+/).filter(Boolean);
  if (!words.length) return [];
  // v3.1 C⁺：默认只查"对话层"（role!='tool'）；opts.include='tool' 仅证据层 / 'all' 全层。
  let kindFilter = '';
  try {
    const cfg = require('./config').load();
    if (cfg.archiveKindFilter !== false && opts.include !== 'tool' && opts.include !== 'all') kindFilter = " AND role != 'tool'";
  } catch { }
  if (mode === 'sqlite' && db) {
    let rows = [];
    // A 层：FTS5(bigram) 粗筛（开关开且 archive_fts 存在时）——
    // JOIN archive 强制 session_id 隔离（真隔离，非"先出候选后过滤"）；查询串同法 bigram。
    try {
      const cfgA = require('./config').load();
      if (cfgA.archiveFts !== false && hasFtsTable()) {
        const gs = biQuery(query);
        if (gs.length) {
          const match = gs.map((g) => `"${String(g).replace(/"/g, '""')}"`).join(' OR ');
          rows = db.prepare(`SELECT a.seq, a.role, a.ts, a.content FROM archive_fts f
            JOIN archive a ON a.rowid = f.rowid
            WHERE a.session_id = ?${kindFilter.replace(/\brole\b/g, 'a.role')} AND archive_fts MATCH ?
            ORDER BY rank LIMIT 200`).all(sessionId, match);
        }
      }
    } catch (e) {
      console.log(`[archive] FTS5 检索失败，回退 LIKE: ${e.message}`);
      rows = [];
    }
    if (!rows.length) {
      // 回退：LIKE 粗筛（任一词命中；转义 %/_；CJK 无大小写，ASCII 大小写不敏感由 lower 保证）
      const esc = (s) => s.replace(/([%_\\])/g, '\\$1');
      const stmt = db.prepare(`SELECT seq, role, ts, content FROM archive WHERE session_id = ?${kindFilter} AND content LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT 200`);
      for (const w of words) {
        const lw = w.toLowerCase();
        for (const r of stmt.all(sessionId, `%${esc(lw)}%`)) rows.push(r);
      }
    }
    if (!rows.length) return [];
    return scoreRows(rows, words, limit);
  }
  return jsonlSearch(sessionId, words, limit, opts);
}

/** 原始条目（含 gen/kind/seq，调试与"归档查看"细分层用）；默认新到旧。 */
function rows(sessionId, limit = 200, offset = 0) {
  ensureInit();
  const off = Math.max(0, offset);
  const lim = Math.max(1, limit);
  if (mode === 'sqlite' && db) {
    return db.prepare(`SELECT seq, gen, role, ts, content, kind, full, tool_call_id FROM archive
      WHERE session_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?`).all(sessionId, lim, off)
      .map((r) => ({ ...r, content: String(r.content || '') }));
  }
  // JSONL 回退：从文件反向读（近似，size 受限 512 条窗口）
  const all = jsonlRead(sessionId, Math.max(lim + off, 500), 0);
  return all.slice(Math.max(0, all.length - off - lim), Math.max(0, all.length - off)).reverse()
    .map((r, i) => ({ seq: i, gen: 0, role: r.role, ts: r.ts, content: r.content, kind: 'flow', full: 0, tool_call_id: null }));
}

/** v3.1 C⁺：bigram 打分的 gramsOf 来源 —— 惰性 require('./memory')（避免与 memory→archiveStore 的循环依赖），
 *  失败则用本地等价实现兜底（行为一致：归一化相邻二字片 + ≥3 字符 ASCII/数字词）。 */
function _gramsFallback(x) {
  const t = String(x || '').toLowerCase().replace(/[\s\u3000]+/g, '').replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '');
  const out = [];
  for (let i = 0; i + 1 < t.length; i++) {
    const a = t[i], b = t[i + 1];
    if (a >= '0' && a <= '9' && b >= '0' && b <= '9') continue;
    out.push(a + b);
  }
  for (const tk of (String(x || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])) out.push(tk);
  return out;
}
let _gramsFn = null;
function gramsFn() {
  if (_gramsFn) return _gramsFn;
  try { const g = require('./memory').gramsOf; if (typeof g === 'function') { _gramsFn = g; return g; } } catch { }
  _gramsFn = _gramsFallback; return _gramsFn;
}
const GRAM_SCAN_MAX = 20000;   // 打分只扫正文前 N 字符（防超长条目拖慢；position/snippet 语义不变）

// —— A（批2·P1）：FTS5(bigram) 检索层支撑 ——
/** bi 固化列文本：应用层算 bigram，trigger 只 copy 列（SQLite trigger 禁调 JS 函数）。 */
function biText(content) {
  const src = String(content == null ? '' : content);
  const scan = src.length > GRAM_SCAN_MAX ? src.slice(0, GRAM_SCAN_MAX) : src;
  try { return gramsFn()(scan).join(' '); } catch { return _gramsFallback(scan).join(' '); }
}
/** 查询串同法 bigram 切分（去重、取前 64 片，防 MATCH 表达式过长）。 */
function biQuery(query) {
  const q = String(query == null ? '' : query);
  let g = [];
  try { g = gramsFn()(q); } catch { g = _gramsFallback(q); }
  return [...new Set(g)].slice(0, 64);
}
let _hasBiCol = null, _hasFts = null;
/** archive 表是否已加 bi 列（迁移后为 true；未迁移则跳过写入，保持兼容）。 */
function hasBiColumn() {
  if (_hasBiCol !== null) return _hasBiCol;
  try { _hasBiCol = db.prepare('PRAGMA table_info(archive)').all().some((r) => r.name === 'bi'); }
  catch { _hasBiCol = false; }
  return _hasBiCol;
}
/** FTS5 虚拟表 archive_fts 是否存在（迁移脚本创建；未迁移则自动回退 LIKE）。 */
function hasFtsTable() {
  if (_hasFts !== null) return _hasFts;
  try { _hasFts = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='archive_fts'").get(); }
  catch { _hasFts = false; }
  return _hasFts;
}

function scoreRows(rows, words, limit) {
  const seen = new Set();
  const hits = [];
  const cfg = (() => { try { return require('./config').load(); } catch { return {}; } })();
  const useBigram = cfg.archiveBigramScore !== false;
  const G = gramsFn();
  const qStr = String(words.join('') || '');
  const qGrams = useBigram ? new Set(G(words.join(' '))) : null;
  for (const r of rows) {
    if (seen.has(r.seq)) continue;
    seen.add(r.seq);
    const content = String(r.content || '');
    const lowerC = content.toLowerCase();
    let hitCount = 0, firstIdx = -1;
    for (const w of words) {
      const ii = lowerC.indexOf(w.toLowerCase());
      if (ii >= 0) { hitCount++; if (firstIdx < 0 || ii < firstIdx) firstIdx = ii; }
    }
    if (hitCount === 0) continue;
    const wordRatio = hitCount / words.length;
    let score = wordRatio;
    // bigram 相似度 + 整串短语加成（v3.1 C⁺；关掉即退回旧式 wordRatio）
    if (useBigram && qGrams && qGrams.size) {
      const scan = content.length > GRAM_SCAN_MAX ? content.slice(0, GRAM_SCAN_MAX) : content;
      const gs = new Set(G(scan));
      let gh = 0; for (const g of qGrams) if (gs.has(g)) gh++;
      const gramRatio = gh / qGrams.size;
      score = 0.65 * gramRatio + 0.35 * wordRatio;
      if (qStr && lowerC.includes(qStr.toLowerCase())) score += 0.25;   // 短语整串命中加成
    }
    const pos = firstIdx >= 0 ? firstIdx : 0;
    const snippet = content.slice(Math.max(0, pos - 60), pos + 240).replace(/\s+/g, ' ').trim();
    const full = content.length > ARCHIVE_SEARCH_FULL_MAX
      ? content.slice(0, ARCHIVE_SEARCH_FULL_MAX) + `\n…[已截断，全文见归档 ${content.length} 字符]`
      : content;
    hits.push({ role: r.role, snippet, score: Math.round(score * 100) / 100, ts: r.ts || Date.now(), content: full });
  }
  return hits.sort((a, b) => (b.score - a.score) || (b.snippet.length - a.snippet.length)).slice(0, limit);
}

/** 分页读取（seq 升序 = 写入顺序，与旧 JSONL 语义一致）。 */
function readPage(sessionId, limit = 500, offset = 0) {
  ensureInit();
  const off = Math.max(0, offset);
  const lim = Math.max(1, limit);
  if (mode === 'sqlite' && db) {
    const rows = db.prepare(`SELECT seq, role, ts, content FROM archive
      WHERE session_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?`).all(sessionId, lim, off);
    return rows.map((r) => ({ ts: r.ts || Date.now(), role: r.role, content: String(r.content || '') }));
  }
  return jsonlRead(sessionId, lim, off);
}

/** D1/A 层：全部有归档的会话 id（scope='all' 跨会话检索用）。 */
function listSessionIds() {
  ensureInit();
  if (mode === 'sqlite' && db) {
    try { return db.prepare('SELECT DISTINCT session_id AS sid FROM archive').all().map((r) => String(r.sid)); }
    catch { return []; }
  }
  try { return fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, '')); }
  catch { return []; }
}

function count(sessionId) {
  ensureInit();
  if (mode === 'sqlite' && db) {
    const r = db.prepare('SELECT COUNT(*) AS n FROM archive WHERE session_id = ?').get(sessionId);
    return r ? r.n : 0;
  }
  return jsonlCount(sessionId);
}

function erase(sessionId) {
  ensureInit();
  if (mode === 'sqlite' && db) {
    db.prepare('DELETE FROM archive WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM archive_meta WHERE session_id = ?').run(sessionId);
    return true;
  }
  return jsonlErase(sessionId);
}

/** 清空并返回清掉的条数（与旧语义一致）。 */
function clear(sessionId) {
  const n = count(sessionId);
  erase(sessionId);
  return n;
}

/** 调试/兼容：把某会话归档导出为 JSONL（SQLite 模式下也可用）。 */
function exportJsonl(sessionId) {
  ensureInit();
  const f = archiveFile(sessionId);
  if (mode === 'sqlite' && db) {
    const rows = db.prepare(`SELECT gen, role, ts, content, kind, tool_call_id FROM archive
      WHERE session_id = ? ORDER BY seq ASC`).all(sessionId);
    const lines = rows.map((r) => JSON.stringify({ ts: r.ts, role: r.role, content: r.content, gen: r.gen, kind: r.kind, toolCallId: r.tool_call_id || undefined }));
    fs.writeFileSync(f, lines.join('\n') + '\n', 'utf8');
    return lines.length;
  }
  return 0;
}

// ———————— 旧 JSONL 自动导入（幂等：以 size+mtime 为标记） ————————

/** 旧 JSONL 自动导入（幂等：以 size+mtime 为标记；带重入保护，防 init 递归）。 */
let _migrating = false;
function migrateJsonl() {
  if (_migrating) return;
  _migrating = true;
  try {
    let files = [];
    try { files = fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.jsonl')); } catch { return; }
    for (const f of files) {
      const sessionId = f.slice(0, -'.jsonl'.length);
      let st;
      try { st = fs.statSync(path.join(ARCHIVE_DIR, f)); } catch { continue; }
      const meta = db.prepare('SELECT imported_size, imported_mtime FROM archive_meta WHERE session_id = ?').get(sessionId);
      if (meta && meta.imported_size === st.size && meta.imported_mtime === st.mtimeMs) continue;
      let raw = '';
      try { raw = fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8'); } catch { continue; }
      const entries = [];
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const m = JSON.parse(t);
          entries.push({ role: m.role || 'assistant', content: String(m.content ?? ''), ts: m.ts || st.mtimeMs });
        } catch { }
      }
      console.log(`[archive] 迁移 ${f}（${entries.length} 条）`);
      if (entries.length) {
        try { save(sessionId, entries, { gen: 0, kind: 'flow' }); } catch (e) { console.log(`[WARN] 归档导入失败 ${f}: ${e.message}`); }
      }
      db.prepare('INSERT INTO archive_meta (session_id, gen, imported_size, imported_mtime) VALUES (?, 0, ?, ?) ' +
        'ON CONFLICT(session_id) DO UPDATE SET imported_size = excluded.imported_size, imported_mtime = excluded.imported_mtime')
        .run(sessionId, st.size, st.mtimeMs);
    }
  } finally {
    _migrating = false;
  }
}

// ———————— JSONL 回退实现（与原 memory.js 行为等价） ————————

function jsonlSave(sessionId, entries, gen, kind) {
  try {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const lines = entries.map((m) => JSON.stringify({
      ts: m.ts || Date.now(), role: m.role, content: String(m.content ?? ''),
      ...(gen ? { gen } : {}),
      ...(kind !== 'flow' ? { kind } : {}),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    }));
    const f = archiveFile(sessionId);
    const prev = jsonlCount(sessionId);
    fs.appendFileSync(f, lines.join('\n') + '\n', 'utf8');
    const total = prev + lines.length;
    let size = 0; try { size = fs.statSync(f).size; } catch { }
    _archiveCounts.set(sessionId, { n: total, size });
    _archLineIdx.delete(sessionId);
    const capRaw = Number(require('./config').load().archiveMaxEntries);
    const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : 0;
    if (cap > 0 && total > cap) {
      // 回退路径无 kind 区分（历史行为）：全量按时间序裁剪
      const all = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      if (all.length > cap) {
        const keep = all.slice(all.length - cap);
        fs.writeFileSync(f, keep.join('\n') + '\n', 'utf8');
        let size2 = 0; try { size2 = fs.statSync(f).size; } catch { }
        _archiveCounts.set(sessionId, { n: keep.length, size: size2 });
        _archLineIdx.delete(sessionId);
      }
    }
    return lines.length;
  } catch (e) {
    console.log(`[WARN] 归档写入失败: ${e.message}`);
    return 0;
  }
}

function archLineOffsets(sessionId) {
  const f = archiveFile(sessionId);
  let st;
  try { st = fs.statSync(f); } catch { return null; }
  const cached = _archLineIdx.get(sessionId);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached;
  const byteOffsets = [], charStarts = [];
  let rawBytes = null;
  try {
    rawBytes = fs.readFileSync(f);
    const n = rawBytes.length;
    let off = 0;
    for (let i = 0; i < n; i++) {
      if (rawBytes[i] === 10) { byteOffsets.push(off); off = i + 1; }
    }
    if (off < n) byteOffsets.push(off);
  } catch { return cached; }
  let rawStr = null;
  if ((st.size || 0) <= _ARCH_RAW_CACHE_MAX) {
    rawStr = rawBytes.toString('utf8');
    let li = 0;
    for (let i = 0; i < rawStr.length; i++) {
      if (rawStr.charCodeAt(i) === 10) { charStarts.push(li); li = i + 1; }
    }
    if (li < rawStr.length) charStarts.push(li);
  }
  const idx = { size: st.size, mtimeMs: st.mtimeMs, byteOffsets, charStarts, rawStr };
  _archLineIdx.set(sessionId, idx);
  return idx;
}

function archLineAt(offsets, pos) {
  let lo = 0, hi = offsets.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function jsonlCount(sessionId) {
  const f = archiveFile(sessionId);
  let size = -1;
  try { size = fs.existsSync(f) ? fs.statSync(f).size : -1; } catch { }
  const c = _archiveCounts.get(sessionId);
  if (c !== undefined && c.size === size) return c.n;
  const idx = archLineOffsets(sessionId);
  if (idx) { _archiveCounts.set(sessionId, { n: idx.byteOffsets.length, size: idx.size }); return idx.byteOffsets.length; }
  let n = 0;
  try {
    if (size >= 0) {
      const raw = fs.readFileSync(f, 'utf8');
      for (const line of raw.split('\n')) if (line.trim()) n++;
    }
  } catch { }
  _archiveCounts.set(sessionId, { n, size });
  return n;
}

function jsonlSearch(sessionId, words, limit, opts = {}) {
  let kindFilter = false;
  try {
    const cfg = require('./config').load();
    kindFilter = cfg.archiveKindFilter !== false && opts.include !== 'tool' && opts.include !== 'all';
  } catch { }
  const f = archiveFile(sessionId);
  if (!fs.existsSync(f)) return [];
  const idx = archLineOffsets(sessionId);
  if (!idx || !idx.byteOffsets.length) return [];
  let raw = idx.rawStr;
  let charStarts = idx.charStarts;
  if (!raw) {
    try { raw = fs.readFileSync(f, 'utf8'); } catch { return []; }
    charStarts = [];
    let li = 0;
    for (let i = 0; i < raw.length; i++) { if (raw.charCodeAt(i) === 10) { charStarts.push(li); li = i + 1; } }
    if (li < raw.length) charStarts.push(li);
  }
  if (!charStarts.length) return [];
  const lower = raw.toLowerCase();
  const cand = new Map();
  for (const w of words) {
    const lw = w.toLowerCase();
    let from = 0, p;
    while ((p = lower.indexOf(lw, from)) >= 0) {
      const li = archLineAt(charStarts, p);
      let e = cand.get(li);
      if (!e) { e = { words: new Set(), first: p }; cand.set(li, e); }
      e.words.add(w);
      if (p < e.first) e.first = p;
      from = p + Math.max(1, lw.length);
    }
  }
  const hits = [];
  for (const [li] of cand) {
    let m;
    try {
      const start = charStarts[li];
      const end = li + 1 < charStarts.length ? charStarts[li + 1] : raw.length;
      m = JSON.parse(raw.slice(start, end));
    } catch { continue; }
    if (kindFilter && m.role === 'tool') continue;   // v3.1 C⁺：JSONL 回退同样默认滤掉证据层
    const content = String(m.content || '');
    const lowerC = content.toLowerCase();
    let hitCount = 0, firstIdx = -1;
    for (const w of words) { const ii = lowerC.indexOf(w.toLowerCase()); if (ii >= 0) { hitCount++; if (firstIdx < 0 || ii < firstIdx) firstIdx = ii; } }
    if (hitCount === 0) continue;
    const score = hitCount / words.length;
    const pos = firstIdx >= 0 ? firstIdx : 0;
    const snippet = content.slice(Math.max(0, pos - 60), pos + 240).replace(/\s+/g, ' ').trim();
    const full = content.length > ARCHIVE_SEARCH_FULL_MAX
      ? content.slice(0, ARCHIVE_SEARCH_FULL_MAX) + `\n…[已截断，全文见归档 ${content.length} 字符]`
      : content;
    hits.push({ role: m.role, snippet, score: Math.round(score * 100) / 100, ts: m.ts || Date.now(), content: full });
  }
  return hits.sort((a, b) => (b.score - a.score) || (b.snippet.length - a.snippet.length)).slice(0, limit);
}

function jsonlRead(sessionId, limit, offset) {
  const f = archiveFile(sessionId);
  if (!fs.existsSync(f)) return [];
  const idx = archLineOffsets(sessionId);
  if (!idx || !idx.byteOffsets.length) return [];
  const n = idx.byteOffsets.length;
  const startI = Math.max(0, offset);
  if (startI >= n) return [];
  const endI = Math.min(startI + limit, n);
  const start = idx.byteOffsets[startI];
  let end = 0;
  try { end = endI < n ? idx.byteOffsets[endI] : fs.statSync(f).size; } catch { end = 0; }
  const out = [];
  let raw = '';
  try {
    const fd = fs.openSync(f, 'r');
    const len = Math.max(0, end - start);
    if (len > 0) {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      raw = buf.toString('utf8');
    }
    fs.closeSync(fd);
  } catch { return []; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    out.push({ ts: m.ts || Date.now(), role: m.role, content: String(m.content || '') });
    if (out.length >= limit) break;
  }
  return out;
}

function jsonlErase(sessionId) {
  const f = archiveFile(sessionId);
  try { if (fs.existsSync(f)) { fs.unlinkSync(f); _archiveCounts.delete(sessionId); _archLineIdx.delete(sessionId); return true; } } catch { }
  return false;
}

/** 旧接口兼容：行索引重建（SQLite 模式为空操作；JSONL 模式由 stat 失效自动重建）。 */
function rebuildIndex() { _archLineIdx.clear(); }

/** 关闭底层 DB（测试/热切换用；关闭后再次 init 可重新打开）。 */
function close() {
  if (db) { try { db.close(); } catch { } db = null; }
  inited = false;
  _hasBiCol = null; _hasFts = null;
}

/** 批量改写条目内容（清理/脱敏用）：fn(row) → 新内容（row 含 seq/role/content）；返回改写条数。JSONL 回退模式不支持（返回 0）。 */
function rewrite(sessionId, fn) {
  if (ensureInit() !== 'sqlite' || !db) return 0;
  const rows = db.prepare('SELECT seq, role, content FROM archive WHERE session_id = ?').all(sessionId);
  let n = 0;
  const upd = db.prepare('UPDATE archive SET content = ? WHERE session_id = ? AND seq = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const c = String(r.content || '');
      if (c.length < 256) continue;
      const out = fn(r);
      if (out !== c) { upd.run(out, sessionId, r.seq); n++; }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { }
    throw e;
  }
  return n;
}

module.exports = {
  init, mode: () => mode, ARCHIVE_DIR: () => ARCHIVE_DIR, close, rewrite,
  save, search, readPage, count, clear, erase, nextGen, currentGen, exportJsonl, rebuildIndex, rows,
  archiveFile, listSessionIds, dbSizeMB, sessionSizeMB, maxSessionFlowMB, enforceCapacity, sizeEstimate,
};
