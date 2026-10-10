'use strict';
// 雷仔 · 项目文件总库"名册"（共享 SQLite 库）
//
// 目的：把非文本产物总库目录名从"会话 id"升级为"项目名"，并以**共享名册 DB 为唯一事实源**；
//   4 实例（主我 + 三雷影）共用同一物理库（同 agents_shared.db 模式），目录名全局唯一。
//
// 硬约束：
//  1) 任何异常（Node 无 node:sqlite / 库文件打不开 / SQL 失败）**一律优雅回退**，绝不抛错拖垮引擎；
//  2) 打开失败时 available() 返回 false，调用方据此走旧行为（目录名 = 会话 id）；
//  3) 名册库只做"会话 → 目录名"的映射，**不参与读产物**（总库只写不读，兼容风险极低）。
const fs = require('node:fs');
const path = require('node:path');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { /* 旧 Node 无内置 sqlite → 全局回退 */ }

let db = null;
let inited = false;
let _dbFile = null;

function cfg() { try { return require('./config').load(); } catch { return {}; } }

/** 名册库路径：LEIZAI_PROJECTS_DB（测试隔离钩子） > config.projectRegistryDb > <dataDir>/projects_shared.db */
function dbPath() {
  if (process.env.LEIZAI_PROJECTS_DB) return process.env.LEIZAI_PROJECTS_DB;
  const c = cfg();
  if (c && c.projectRegistryDb) return String(c.projectRegistryDb);
  let base = null;
  try { base = require('./config').DATA_DIR; } catch { }
  if (!base) base = path.join(process.cwd(), 'data');
  return path.join(base, 'projects_shared.db');
}

function available() { return inited && !!db; }

function ensureSchema() {
  db.exec(`CREATE TABLE IF NOT EXISTS projects (
    session_id TEXT PRIMARY KEY,
    role       TEXT,
    name       TEXT,
    folder     TEXT UNIQUE,
    created_at TEXT,
    updated_at TEXT
  );`);
}

/** 初始化（幂等）。任何异常都不抛；失败后 available()==false，调用方回退旧行为。 */
function init() {
  if (db) return db;
  if (!DatabaseSync) { console.error('[projectRegistry] 当前 Node 无 node:sqlite，已回退旧目录名'); return null; }
  try {
    _dbFile = dbPath();
    try { fs.mkdirSync(path.dirname(_dbFile), { recursive: true }); } catch { }
    db = new DatabaseSync(_dbFile);
    db.exec('PRAGMA busy_timeout = 5000;');
    try { db.exec('PRAGMA journal_mode = WAL;'); } catch (e) { /* WAL 失败不影响功能 */ }
    ensureSchema();
    inited = true;
  } catch (e) {
    console.error('[projectRegistry] 打开失败，回退旧目录名:', e && e.message);
    try { db = null; } catch { }
    inited = false;
  }
  return db;
}

/** 文件名净化：去 Windows 非法字符与控制字符→`_`；去首尾空格与结尾点；截断 60 字符；空则用 fallback。 */
function sanitize(name, fallbackId) {
  let s = String(name == null ? '' : name);
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[. ]+$/, '');            // Windows 不允许结尾点/空格
  if (s.length > 60) s = s.slice(0, 60).replace(/[. ]+$/, '');
  if (!s) s = sanitize(fallbackId == null ? 'session' : String(fallbackId), 'session');
  return s;
}

/** 目录名候选优先级：非空 project > 非空 title(≠"新会话") > 会话 id。 */
function pickName(sessionId, opts = {}) {
  const p = String((opts && opts.project) || '').trim();
  if (p) return p;
  const t = String((opts && opts.title) || '').trim();
  if (t && t !== '新会话') return t;
  return String(sessionId);
}

function nowIso() { return new Date().toISOString(); }

function rowOf(sessionId) {
  try {
    const st = db.prepare('SELECT session_id, role, name, folder, created_at, updated_at FROM projects WHERE session_id = ?');
    return st.get(String(sessionId)) || null;
  } catch { return null; }
}

function folderTaken(folder, sessionId) {
  try {
    const st = db.prepare('SELECT session_id FROM projects WHERE folder = ? AND session_id <> ?');
    return !!st.get(String(folder), String(sessionId));
  } catch { return false; }
}

/** 在 base 基础上做唯一化：占用了就追加 -2/-3… */
function uniqueFolder(base, sessionId) {
  let f = base, i = 1;
  while (folderTaken(f, sessionId)) { i += 1; f = `${base}-${i}`; if (i > 999) break; }
  return f;
}

/**
 * 解析/登记会话的目录名。已有行→直接返回其 folder；无行→按名生成唯一 folder 并插入。
 * DB 不可用/异常 → 返回 sanitize(name||sessionId)（仍可算出目录，绝不崩）。
 */
function resolveFolder(sessionId, opts = {}) {
  const sid = String(sessionId);
  const name = String((opts && (opts.name || pickName(sid, opts))) || sid);
  if (!init()) return sanitize(name, sid);
  try {
    const row = rowOf(sid);
    if (row && row.folder) return row.folder;
    const folder = uniqueFolder(sanitize(name, sid), sid);
    const ts = nowIso();
    try {
      const st = db.prepare('INSERT INTO projects (session_id, role, name, folder, created_at, updated_at) VALUES (?,?,?,?,?,?)');
      st.run(sid, String((opts && opts.role) || ''), name, folder, ts, ts);
    } catch {
      // 并发下可能被别人先插入：重查一次；仍无则回退纯名（不抛）
      const again = rowOf(sid);
      if (again && again.folder) return again.folder;
    }
    return folder;
  } catch { return sanitize(name, sid); }
}

/**
 * 改名：更新 name 并重算唯一 folder。
 * @returns {{sessionId:string, oldFolder:string|null, newFolder:string, changed:boolean}}
 */
function rename(sessionId, opts = {}) {
  const sid = String(sessionId);
  const name = String((opts && (opts.name || pickName(sid, opts))) || sid);
  if (!init()) {
    const f = sanitize(name, sid);
    return { sessionId: sid, oldFolder: f, newFolder: f, changed: false };
  }
  try {
    const row = rowOf(sid);
    if (!row) {
      const f = resolveFolder(sid, Object.assign({}, opts, { name }));
      return { sessionId: sid, oldFolder: f, newFolder: f, changed: false };
    }
    const oldFolder = row.folder || null;
    const newFolder = uniqueFolder(sanitize(name, sid), sid);
    const ts = nowIso();
    try {
      const st = db.prepare('UPDATE projects SET name = ?, folder = ?, role = ?, updated_at = ? WHERE session_id = ?');
      st.run(name, newFolder, String((opts && opts.role) || row.role || ''), ts, sid);
    } catch { return { sessionId: sid, oldFolder, newFolder: oldFolder || newFolder, changed: false }; }
    return { sessionId: sid, oldFolder, newFolder, changed: oldFolder !== newFolder };
  } catch {
    const f = sanitize(name, sid);
    return { sessionId: sid, oldFolder: f, newFolder: f, changed: false };
  }
}

/** 列出全部行（供迁移/对账）。失败返回 []。 */
function listAll() {
  if (!init()) return [];
  try {
    const st = db.prepare('SELECT session_id, role, name, folder, created_at, updated_at FROM projects ORDER BY created_at');
    return st.all() || [];
  } catch { return []; }
}

/** 删除一行（会话彻底删除时调用）。失败静默。 */
function remove(sessionId) {
  if (!init()) return false;
  try { db.prepare('DELETE FROM projects WHERE session_id = ?').run(String(sessionId)); return true; } catch { return false; }
}

/** 显式指定 folder 写入（迁移脚本用）。失败静默返回 false。 */
function upsert(sessionId, { role, name, folder } = {}) {
  if (!init()) return false;
  try {
    const ts = nowIso();
    const f = folder || sanitize(name, sessionId);
    try {
      db.prepare('INSERT INTO projects (session_id, role, name, folder, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run(String(sessionId), String(role || ''), String(name || ''), String(f), ts, ts);
    } catch {
      db.prepare('UPDATE projects SET role = ?, name = ?, folder = ?, updated_at = ? WHERE session_id = ?')
        .run(String(role || ''), String(name || ''), String(f), ts, String(sessionId));
    }
    return true;
  } catch { return false; }
}

module.exports = {
  init, available, sanitize, pickName, resolveFolder, rename, listAll, remove, upsert, dbPath,
  _reset() { try { if (db) db.close(); } catch { } db = null; inited = false; },
};
