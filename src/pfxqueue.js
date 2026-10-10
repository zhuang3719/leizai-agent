'use strict';
// 雷仔 · 统一前缀写入队列（P1 · 2026-10-02）
//
// 目标（方案 v2-final）：把所有"会击穿前缀的语义型写入"收进**一个实例级队列**，
//   由唯一决策点在「某会话即将发请求且窗口小」时**一次性落地** → N 个改动只付 1 次缓存重建。
//
// 设计要点：
//  - 队列存 branch.db 新表 pfx_op（实例级）；`CREATE TABLE IF NOT EXISTS` + WAL + 每批一次事务。
//  - pfxWrite(): **同步·只入队·绝不写盘**（唯一写入口）；失败（PfxDBError）→ 返回 {queued:false,degraded:true}，
//    由调用方降级同步直写（本模块只写 pfx-degraded.flag 并告警）。
//  - plan(items): **纯函数**（不碰 DB），合并/去重/排序，确定性。
//  - apply(plan): async，逐项"先写后标"、幂等（二次 apply 零写）。
//  - 审计：pfx-done 时登记目标指纹（pfx_attest）；auditBypass() 比对当前 hash vs 已登记，检出绕过直写。
//  - 可注入（单测）：init({db, now, fs, paths, clock, log, writers})。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR, load: loadConfig } = require('./config');

// —— 唯一权威：前缀来源清单（PREFIX_SOURCES，2026-10-02 定案）——
// 所有"会击穿稳定前缀"的改动源都登记在此；TARGETS / AUDIT_TARGETS / 护栏路径 / PREFIX_WRITE_TOOLS 全部由此派生。
// 红线：本模块顶层不 require('./tools')（仅懒引），避免循环依赖；classifyChange 为唯一命中判定函数。
const PREFIX_SOURCES = [
  { id: 'system.md',       kind: 'file',         guard: true, audit: true,  resolve: () => path.join(DATA_DIR, 'prompts', 'system.md') },
  { id: 'harness',         kind: 'file',         guard: true, audit: true,  resolve: () => require('./prompt').HARNESS_PATH },
  { id: 'skill',           kind: 'dir',          guard: true, audit: true,  resolve: () => require('./skills').SKILL_DIR },
  { id: 'plugin',          kind: 'dir',          guard: true, audit: true,  resolve: () => path.join(__dirname, 'plugins') },
  { id: 'prompt.js',       kind: 'file',         guard: true, audit: true,  needsRestart: true, resolve: () => path.join(__dirname, 'prompt.js') },
  { id: 'tools.js',        kind: 'file',         guard: true, audit: true,  needsRestart: true, resolve: () => path.join(__dirname, 'tools.js') },
  { id: 'config.identity', kind: 'configSubset', guard: true, audit: true,  needsRestart: true, resolve: () => { const c = require('./config'); return (c.configPath ? c.configPath() : c.CONFIG_PATH); } },
  { id: 'evolution',       kind: 'op',           guard: true, audit: false, resolve: () => null },
];
const PREFIX_SOURCE_BY_ID = new Map(PREFIX_SOURCES.map((s) => [s.id, s]));
/** 进 identityOverlay（稳定前缀）的 config.agent 字段（字段级特例，非整文件）。 */
const IDENTITY_KEYS = ['name', 'role', 'domain', 'isMain'];
// 代码/配置层前缀源（命中→需重启生效）——由 PREFIX_SOURCES 派生（防再漂移）。
const RESTART_IDS = PREFIX_SOURCES.filter((x) => x.needsRestart).map((x) => x.id);
// 前缀目标白名单（进 system 前缀的类别）—— 由 PREFIX_SOURCES 派生（唯一权威）
const TARGETS = new Set(PREFIX_SOURCES.map((s) => s.id));
// 落地排序优先序（越小越先写；保证确定性）
const TARGET_ORDER = { 'system.md': 0, harness: 0, 'prompt.js': 0, 'tools.js': 0, 'config.identity': 0, evolution: 1, skill: 2, plugin: 3 };
const MERGEABLE_OP = new Set(['save', 'skillUpdate']);
// 止空转（2026-10-03）：某项连续落盘失败达此阈值 → plan 不再纳入自动重试（仍留 pending，供主我可见/处理）。
const MAX_FLUSH_ATTEMPTS = 3;

class PfxDBError extends Error {
  constructor(msg) { super(msg); this.name = 'PfxDBError'; }
}

const DDL = `
CREATE TABLE IF NOT EXISTS pfx_op(
  id           TEXT PRIMARY KEY,
  kind         TEXT DEFAULT 'content',
  target       TEXT,
  op           TEXT,
  name         TEXT,
  payload      TEXT,
  dedup_key    TEXT,
  content_hash TEXT,
  status       TEXT DEFAULT 'pending',
  attempts     INT  DEFAULT 0,
  last_err     TEXT,
  urgent       INT  DEFAULT 0,
  src_session  TEXT,
  src_turn     INT,
  created_at   INT,
  updated_at   INT,
  applied_at   INT,
  origin_session TEXT,
  origin_cid    TEXT,
  notified_at   INT);
CREATE INDEX IF NOT EXISTS idx_pfx_status ON pfx_op(status);
CREATE INDEX IF NOT EXISTS idx_pfx_dedup  ON pfx_op(dedup_key);
CREATE TABLE IF NOT EXISTS pfx_attest(
  path TEXT PRIMARY KEY,
  hash TEXT,
  ts   INT);
`;

let _ctx = null;
let _db = null;
let _ownDb = false;
let _inited = false;
let _degraded = false;
let _pfxDue = false;
let _lastFlushAt = 0;
// D（2026-10-02）：apply 重入守卫（内存 flag；跨进程无效，多实例各自守卫即可，不追求全局）。
let _applying = false;

function _sha1(x) { return crypto.createHash('sha1').update(String(x == null ? '' : x), 'utf8').digest('hex'); }
function _now() { return _ctx && _ctx.now ? _ctx.now() : Date.now(); }
function _log(m) { try { (_ctx && _ctx.log ? _ctx.log : console.log)(m); } catch { } }
function _fs() { return (_ctx && _ctx.fs) || fs; }

/** 队列总开关：config.pfxQueue.enabled（默认 true；关闭则一切走原直写路径=回滚）。 */
function enabled() {
  try { const c = loadConfig(); return !(c && c.pfxQueue && c.pfxQueue.enabled === false); } catch { return true; }
}
function failSafeMode() {
  try { const c = loadConfig(); return (c && c.pfxQueue && c.pfxQueue.failSafe) || 'direct'; } catch { return 'direct'; }
}
function isDegraded() { return _degraded; }

/** 初始化（可重复调用以重定向，供测试隔离）。可注入 db/now/fs/paths/clock/log/writers。 */
function init(opts = {}) {
  _ctx = {
    now: opts.now || (() => Date.now()),
    fs: opts.fs || fs,
    paths: Object.assign({ flagPath: path.join(DATA_DIR, 'pfx-degraded.flag'), auditLog: path.join(DATA_DIR, 'pfx-audit.log'), dueFlag: path.join(DATA_DIR, 'pfx-due.flag'), intentMigratedFlag: path.join(DATA_DIR, 'pfx-intent-migrated.flag') }, opts.paths || {}),
    log: opts.log || ((m) => { try { console.log(m); } catch { } }),
    clock: opts.clock || { setTimeout, setInterval, clearInterval },
    writers: opts.writers || null,
    auditBypass: (opts.auditBypass != null ? !!opts.auditBypass : null),   // 单测注入覆盖（null=按 config）
    pathOverrides: opts.pathOverrides || null,   // C：单测注入（target→路径），生产不设
  };
  if (opts.db) { _db = opts.db; _ownDb = false; }
  else {
    const branch = require('./branch');
    const file = (opts.paths && opts.paths.dbFile) || branch.dbFile();
    const sqlite = require('node:sqlite');
    _db = new sqlite.DatabaseSync(String(file));
    _ownDb = true;
  }
  try { _db.exec('PRAGMA journal_mode=WAL;'); } catch { }
  try { _db.exec('PRAGMA busy_timeout=5000;'); } catch { }
  _db.exec(DDL);
  // Y-step1（2026-10-02）：已在线的表补 kind 列（幂等：PRAGMA 判存，已存在则跳过）。
  try {
    const _cols = new Set(_db.prepare('PRAGMA table_info(pfx_op)').all().map((r) => String(r.name)));
    if (!_cols.has('kind')) _db.exec("ALTER TABLE pfx_op ADD COLUMN kind TEXT DEFAULT 'content'");
    // 记录层收口（2026-10-02）：旁路/需重启记录所需列（幂等 ALTER）
    if (!_cols.has('origin')) _db.exec('ALTER TABLE pfx_op ADD COLUMN origin TEXT');
    if (!_cols.has('needs_restart')) _db.exec('ALTER TABLE pfx_op ADD COLUMN needs_restart INT DEFAULT 0');
    if (!_cols.has('path')) _db.exec('ALTER TABLE pfx_op ADD COLUMN path TEXT');
    // origin 回执（2026-10-10）：登记"发起方会话/cid"，供 intent 完成时自动回执（修复回执搁浅）。幂等 ALTER。
    if (!_cols.has('origin_session')) _db.exec('ALTER TABLE pfx_op ADD COLUMN origin_session TEXT');
    if (!_cols.has('origin_cid')) _db.exec('ALTER TABLE pfx_op ADD COLUMN origin_cid TEXT');
    if (!_cols.has('notified_at')) _db.exec('ALTER TABLE pfx_op ADD COLUMN notified_at INT');
    _db.exec("CREATE INDEX IF NOT EXISTS idx_pfx_kind_status ON pfx_op(kind,status);");
    // 幂等：仅对新增 kind(bypass/restart) 建部分唯一索引（不与既有 content/intent 的多样 dedup_key 冲突）→ INSERT OR IGNORE 生效
    try { _db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_pfx_dedup_bypass ON pfx_op(dedup_key) WHERE kind IN ('bypass','restart') AND dedup_key IS NOT NULL"); } catch { }
  } catch { }
  _inited = true; _degraded = false;
  try { _pfxDue = _fs().existsSync(_pfxDueFlagPath()); } catch { }
  return true;
}
function _ensure() {
  if (!_inited) { try { init({}); } catch (e) { throw new PfxDBError('init-failed: ' + (e && e.message || e)); } }
  if (!_db) throw new PfxDBError('no-db');
  return _db;
}
function close() { if (_db && _ownDb) { try { _db.close(); } catch { } } _db = null; _inited = false; }

// ==================== 入队 ====================
function _dedupKeyFor(op) {
  const t = String(op.target || '');
  const name = String(op.name || '');
  if (op.dedupKey) return String(op.dedupKey);
  if (t === 'skill') return `skill|${name}`;
  if (t === 'plugin') return 'plugin|reload';
  if (t === 'evolution' || t === 'harness' || t === 'system.md')
    { const _p = op.patch != null ? JSON.stringify(op.patch) : ''; return `evolution|${_sha1([String(op.evoTarget || ''), String(op.title || op.name || ''), String(op.content || ''), _p].join('|'))}`; }   // 内容哈希 → 相同内容幂等、不同内容各自一条且按 ts 保序
  return `${t}|${name}`;
}
function _payloadFor(op) {
  const t = String(op.target || '');
  if (t === 'skill')
    return { segments: [{ op: op.op === 'skillUpdate' ? 'skillUpdate' : 'save', content: String(op.content == null ? '' : op.content), description: op.description, code: op.code }] };
  if (t === 'evolution' || t === 'harness' || t === 'system.md')
    return { title: op.title || op.name, rationale: op.rationale, patch: op.patch, content: op.content, evoTarget: op.evoTarget || (t === 'evolution' ? (op.evoTarget || 'harness') : t) };
  if (t === 'plugin') return { action: 'reload' };
  return { content: String(op.content == null ? '' : op.content) };
}

/** 入队一条前缀操作。同 dedupKey 且 pending：内容全同→skip；skill 类不同内容→合并(拼接)。返回 {id,dedupKey,dedup}。 */
function enqueue(op) {
  if (_applying) console.warn('[pfx-queue] re-entrant enqueue during apply');   // D：只告警，绝不拒绝/throw
  const db = _ensure();
  const now = _now();
  const target = String(op.target || '');
  const dedupKey = _dedupKeyFor(op);
  const payload = _payloadFor(op);
  const contentHash = _sha1(JSON.stringify(payload));
  // batchA-② 窄边界"已落地不重复"（2026-10-02）：同 dedupKey 且已 done 且同 session+同 turn → 静默 skip（重放/重试）。
  if (!op.force) {
    try {
      const _d = db.prepare("SELECT id FROM pfx_op WHERE dedup_key=? AND status='done' AND src_session=? AND src_turn=? LIMIT 1").get(dedupKey, String(op.srcSession || ''), Number(op.srcTurn || 0));
      if (_d) return { id: _d.id, dedupKey, dedup: 'skip' };
    } catch { }
    let _wider = false; try { const _c = loadConfig(); _wider = !!(_c && _c.pfxQueue && _c.pfxQueue.dedupAgainstDone); } catch { }
    if (_wider) {
      try {
        const _d2 = db.prepare("SELECT id FROM pfx_op WHERE dedup_key=? AND status='done' AND content_hash=? LIMIT 1").get(dedupKey, contentHash);
        if (_d2) return { id: _d2.id, dedupKey, dedup: 'skip' };
      } catch { }
    }
  }
  let existing = null;
  try { existing = db.prepare("SELECT * FROM pfx_op WHERE dedup_key=? AND status='pending' ORDER BY created_at ASC LIMIT 1").get(dedupKey); } catch { }
  if (existing && target === 'skill' && MERGEABLE_OP.has(String(op.op || 'save'))) {
    if (existing.content_hash === contentHash) return { id: existing.id, dedupKey, dedup: 'skip' };
    let p; try { p = JSON.parse(existing.payload); } catch { p = { segments: [] }; }
    if (!p.segments) p.segments = [];
    p.segments.push(...payload.segments);
    db.prepare('UPDATE pfx_op SET payload=?, content_hash=?, updated_at=? WHERE id=?').run(JSON.stringify(p), contentHash, now, existing.id);
    markPfxDue();   // A（2026-10-02）：真正入队（合并）成功 → 置脏，使下次 maybeFlush 命中 due 分支（不受节流）
    return { id: existing.id, dedupKey, dedup: 'merged' };
  }
  const id = 'p_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  db.prepare(`INSERT INTO pfx_op(id,kind,target,op,name,payload,dedup_key,content_hash,status,attempts,urgent,src_session,src_turn,created_at,updated_at,applied_at)
              VALUES(?,?,?,?,?,?,?,?,'pending',0,?,?,?,?,?,NULL)`)
    .run(id, String(op.kind || 'content'), target, String(op.op || 'save'), String(op.name || ''), JSON.stringify(payload), dedupKey, contentHash,
      op.urgent ? 1 : 0, String(op.srcSession || ''), Number(op.srcTurn || 0) || 0, now, now);
  markPfxDue();   // A（2026-10-02）：真正入队（新增）成功 → 置脏，使下次 maybeFlush 命中 due 分支（不受节流）
  return { id, dedupKey, dedup: 'new' };
}

/** 对外：唯一写入口。**同步·只入队·绝不写盘**。db 不可用 →{queued:false,degraded:true}（调用方降级直写）。 */
function pfxWrite(target, content, opts = {}) {
  if (_applying) console.warn('[pfx-queue] re-entrant enqueue during apply');   // D：只告警，绝不拒绝/throw
  if (!TARGETS.has(String(target))) return { queued: false, error: 'bad-target' };
  if (!enabled()) return { queued: false, error: 'disabled' };
  try {
    const r = enqueue(Object.assign({}, opts, { target, content }));
    return { queued: true, id: r.id, dedupKey: r.dedupKey, dedup: r.dedup };
  } catch (e) {
    _markDegraded(e);
    return { queued: false, degraded: true, error: String(e && e.message || e) };
  }
}
function _markDegraded(e) {
  _degraded = true;
  const msg = `[pfx-queue] DEGRADED (${e && e.message || e}) → 降级同步直写；flag=${_ctx && _ctx.paths ? _ctx.paths.flagPath : '?'}`;
  _log(msg);
  try { _fs().writeFileSync(_ctx.paths.flagPath, JSON.stringify({ at: _now(), err: String(e && e.message || e) }), 'utf8'); } catch { }
}

// ==================== plan（纯函数，不碰 DB） ====================
/** 输入 pending 行集 → 输出有序待写集。确定性：①按 dedup_key 分组 ②组内 content_hash 全同→去重 ③skill 组拼接 segments ④evolution 各自独立 ⑤按(target优先序,minTs)排序。 */
function plan(items) {
  const rows = Array.isArray(items) ? items.slice() : [];
  const groups = new Map();
  for (const r of rows) {
    if (String(r.status || 'pending') !== 'pending') continue;
    if (String(r.kind || 'content') !== 'content') continue;   // Y-step1：intent 不进 plan/apply（防"空写"）
    if (Number(r.attempts || 0) >= MAX_FLUSH_ATTEMPTS) continue;   // 止空转（2026-10-03）：连续失败达阈值 → 不再自动重试（保持 pending 可见）
    const k = String(r.dedup_key || r.id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [, list] of groups) {
    list.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    const target = String(list[0].target || '');
    const seen = new Set();
    const kept = [];
    for (const r of list) {
      const h = String(r.content_hash || '');
      if (h && seen.has(h)) continue;   // 组内完全相同 → 幂等丢弃
      seen.add(h); kept.push(r);
    }
    if (!kept.length) continue;
    const ts = Math.min(...kept.map((r) => r.created_at || 0));
    const urgent = kept.some((r) => r.urgent);
    if (target === 'skill') {
      const segs = []; const keys = [];
      for (const r of kept) {
        keys.push(r.id);
        let p; try { p = JSON.parse(r.payload); } catch { p = { segments: [] }; }
        if (p.segments) segs.push(...p.segments);
        else segs.push({ op: 'save', content: String(p.content || '') });
      }
      out.push({ target, op: 'save', name: String(kept[0].name || ''), payload: { segments: segs }, keys, urgent, ts });
    } else {
      for (const r of kept) {
        let p; try { p = JSON.parse(r.payload); } catch { p = {}; }
        out.push({ target, op: String(r.op || 'save'), name: String(r.name || ''), payload: p, keys: [r.id], urgent: !!r.urgent, ts: r.created_at || 0 });
      }
    }
  }
  const ord = (t) => (TARGET_ORDER[t] != null ? TARGET_ORDER[t] : 9);
  out.sort((a, b) => (ord(a.target) - ord(b.target)) || ((a.ts || 0) - (b.ts || 0)) || (a.keys.join() < b.keys.join() ? -1 : a.keys.join() > b.keys.join() ? 1 : 0));
  return out;
}

// ==================== apply（先写后标·幂等） ====================
function _writers() {
  if (_ctx && _ctx.writers) return _ctx.writers;
  return {
    skill: (item) => {
      const memory = require('./memory');
      const segs = (item.payload && item.payload.segments) || [];
      const saves = segs.filter((s) => s.op !== 'skillUpdate');
      const updates = segs.filter((s) => s.op === 'skillUpdate');
      for (const s of updates) memory.improveSkillDirect(item.name, s.content);
      if (saves.length) {
        const content = saves.map((s) => String(s.content || '')).join('\n\n');
        memory.saveDirect('skill', item.name, content, { description: saves[0].description, code: saves[0].code });
      }
      return true;
    },
    evolution: (item) => {
      const evolution = require('./evolution');
      const p = item.payload || {};
      const target = p.evoTarget === 'harness' ? 'harness' : (p.evoTarget || 'system.md');
      const pr = evolution.propose({ target, title: p.title || item.name, rationale: p.rationale, patch: p.patch, content: p.content });
      let c = {}; try { c = loadConfig(); } catch { }
      if (c.evolutionAutoApply) return evolution.approve(pr.id, { auto: true });
      return pr;
    },
    plugin: () => { const tools = require('./tools'); if (tools.reloadPlugins) tools.reloadPlugins(); return true; },
  };
}
async function _writeItem(item, writers) {
  const t = String(item.target);
  if (t === 'skill') return await writers.skill(item);
  if (t === 'evolution' || t === 'harness' || t === 'system.md') return await writers.evolution(item);
  if (t === 'plugin') return await writers.plugin(item);
  throw new Error('unsupported target: ' + t);
}

async function apply(planArr) {
  _applying = true;
  try {
    const db = _ensure();
    const res = { done: 0, skipped: 0, failed: 0, results: [] };
    const writers = _writers();
    const sel = db.prepare('SELECT status FROM pfx_op WHERE id=?');
    const updDone = db.prepare("UPDATE pfx_op SET status='done', applied_at=?, updated_at=? WHERE id=?");
    const updFail = db.prepare('UPDATE pfx_op SET attempts=attempts+1, last_err=?, updated_at=? WHERE id=?');
    // 3fix-1（2026-10-03）：先逐条执行写副作用（文件写不可回滚），收集本批结果，再单事务原子标 done。
    const batch = [];
    for (const item of (planArr || [])) {
      const keys = item.keys || [];
      let allDone = keys.length > 0;
      for (const k of keys) {
        let row; try { row = sel.get(k); } catch { }
        if (!row || row.status !== 'done') { allDone = false; break; }
      }
      if (allDone) { res.skipped++; res.results.push({ keys, ok: true, skipped: true }); continue; }
      let ok = false, err = '';
      try { await _writeItem(item, writers); ok = true; } catch (e) { ok = false; err = String(e && e.message || e); }
      batch.push({ item, keys, ok, err });
    }
    // 整批单事务（与 runtime.js:3105 "一批一事务" 对齐 · 3fix-1）：事务只开一次 → 全成功则标 done 并提交；
    //   任一失败 → 回滚且本批不标任何 done（部分落盘不留 done 痕迹，保持原子）。二次 apply 对已 done 项零写（幂等）。
    const now = _now();
    const allOk = batch.length > 0 && batch.every((x) => x.ok);
    let txnOk = true;
    if (batch.length) {
      try {
        db.exec('BEGIN');
        if (allOk) { for (const x of batch) { for (const k of x.keys) updDone.run(now, now, k); } db.exec('COMMIT'); }
        else { db.exec('ROLLBACK'); }
      } catch { txnOk = false; try { db.exec('ROLLBACK'); } catch { } }
    }
    const committed = allOk && txnOk;   // 仅"全成功且事务提交"才算真落盘（任一失败→本批零 done）
    for (const x of batch) {
      const okItem = x.ok && committed;
      if (okItem) { try { _attestItem(x.item); } catch { } res.done++; res.results.push({ keys: x.keys, ok: true }); }
      else {
        // 失败记账放事务外（不被 ROLLBACK 吞掉 → 保留止空转 attempts 语义）。txn 失败时 err 用回滚原因。
        const errMsg = x.err || 'txn-rollback';
        try { for (const k of x.keys) updFail.run(errMsg, now, k); } catch { }
        res.failed++; res.results.push({ keys: x.keys, ok: false, err: errMsg });
      }
    }
    return res;
  } finally { _applying = false; }
}

// ==================== P2：落地择时（脏标记 + maybeFlush） ====================
function _pfxDueFlagPath() { return (_ctx && _ctx.paths && _ctx.paths.dueFlag) || path.join(DATA_DIR, 'pfx-due.flag'); }
/** 只置脏标记（内存 + 落盘），绝不 flush、绝不主动发请求。 */
function markPfxDue() { _pfxDue = true; try { _fs().writeFileSync(_pfxDueFlagPath(), String(_now()), 'utf8'); } catch { } return true; }
function clearPfxDue() { _pfxDue = false; try { _fs().rmSync(_pfxDueFlagPath(), { force: true }); } catch { } }
function isPfxDue() { if (_pfxDue) return true; try { return _fs().existsSync(_pfxDueFlagPath()); } catch { return false; } }
function _throttleMs() { try { const c = loadConfig(); const v = Number(c && c.pfxQueue && c.pfxQueue.throttleMs); return Number.isFinite(v) ? v : 600000; } catch { return 600000; } }

/** 唯一决策点的落地判定：仅"小窗 + (脏标记 or 过节流)"时 flushNow；全 try，失败不阻塞本轮。 */
async function maybeFlush(opts = {}) {
  try {
    const min = Number(opts.minTokens) || 0;
    const hist = Number(opts.hist);
    if (min && Number.isFinite(hist) && hist >= min) return { flushed: false, reason: 'large-window' };
    const due = isPfxDue();
    if (!due && (Date.now() - _lastFlushAt) < _throttleMs()) return { flushed: false, reason: 'throttled' };
    let items; try { items = _loadPending(); } catch (e) { return { flushed: false, error: String(e && e.message || e) }; }
    if (!items.length) { if (due) clearPfxDue(); return { flushed: false, reason: 'empty' }; }
    const res = await apply(plan(items));
    _lastFlushAt = Date.now();
    if (due) clearPfxDue();                 // 成功且脏标记置位 → 清脏标记
    return Object.assign({ flushed: true }, res);
  } catch (e) { return { flushed: false, error: String(e && e.message || e) }; }
}

// ==================== 审计（P1：登记 + 比对） ====================
function _targetFilePath(target, name) {
  try {
    if (_ctx && _ctx.pathOverrides && _ctx.pathOverrides[target]) return _ctx.pathOverrides[target];   // 单测注入覆盖（生产不设）
    const s = PREFIX_SOURCE_BY_ID.get(String(target));   // 唯一权威派生（2026-10-02）
    if (!s) return null;
    return s.resolve();
  } catch { }
  return null;
}
function _hashPath(p) {
  const F = _fs();
  try {
    if (!p || !F.existsSync(p)) return null;
    const st = F.statSync(p);
    if (st.isDirectory()) {
      const files = F.readdirSync(p).sort();
      let acc = '';
      for (const f of files) { try { acc += f + ':' + _sha1(F.readFileSync(path.join(p, f))) + ';'; } catch { } }
      return _sha1(acc);
    }
    return _sha1(F.readFileSync(p));
  } catch { return null; }
}
/** C（2026-10-02）：config.json 仅取"进前缀的身份字段"子集 hash（非整文件，避免无关字段误报）。 */
function _hashConfigIdentity() {
  try {
    const cc = require('./config');
    const cp = (cc.configPath ? cc.configPath() : cc.CONFIG_PATH);
    let c = {}; try { c = JSON.parse(_fs().readFileSync(cp, 'utf8')); } catch { c = {}; }   // C：直接读文件（不经 loadConfig 缓存）→ 能检出外部直写
    const a = (c && c.agent) || {};
    const sub = { name: a.name || '', role: a.role || '', domain: a.domain || '', isMain: !!a.isMain, baseUrl: a.baseUrl || '' };
    return _sha1(JSON.stringify(sub));
  } catch { return null; }
}
/** C（2026-10-02）：统一指纹入口——文件/目录 hash，或 config 身份字段子集 hash。 */
function _fingerprint(target, name) {
  try { if (target === 'config.identity') return _hashConfigIdentity(); return _hashPath(_targetFilePath(target, name)); } catch { return null; }
}
function _attestItem(item) {
  // F3（2026-10-02）：evolution 队列项实际写的是 harness/system.md（见 _writers.evolution）——
  //   必须按其"真实目标"刷新基线，否则合法落盘后 auditBypass 仍拿旧基线比 → 误报为直写。
  const t = String(item.target || '');
  const ev = (item.payload && item.payload.evoTarget) || '';
  const reals = (t === 'evolution' || t === 'harness' || t === 'system.md')
    ? [(ev === 'harness' ? 'harness' : (ev || (t === 'evolution' ? 'system.md' : t)))]
    : [t];
  const db = _ensure();
  for (const tg of reals) {
    const p = _targetFilePath(tg, item.name); if (!p) continue;
    const h = _fingerprint(tg, null); if (h == null) continue;
    try { db.prepare('INSERT OR REPLACE INTO pfx_attest(path,hash,ts) VALUES(?,?,?)').run(p, h, _now()); } catch { }
  }
}
/** Y-step1（2026-10-02）：一次性迁移器——本实例 branch.db 全表 kind='prefix' 折叠出 open/done 集，复制入 pfx_op(kind='intent')。
 *  只复制、不删源支干（源保留只读）；幂等（dedup_key='intent|'+sha1(normPrefixKey)）。开关 pfxQueue.intentMigrate（默认跑一次）。 */
function migrateReflectIntents() {
  const stat = { open: 0, done: 0, inserted: 0, skipped: 0, sessions: 0 };
  try {
    const c = loadConfig();
    if (c && c.pfxQueue && c.pfxQueue.intentMigrate === false) return Object.assign(stat, { disabled: true });
    const flag = (_ctx && _ctx.paths && _ctx.paths.intentMigratedFlag) || path.join(DATA_DIR, 'pfx-intent-migrated.flag');
    if (_fs().existsSync(flag)) return Object.assign(stat, { already: true });
    const branch = require('./branch');
    const norm = (x) => (branch.normPrefixKey ? branch.normPrefixKey(x) : String(x || ''));
    const db = _ensure();
    let rows = [];
    try { rows = db.prepare("SELECT session_id, kind, payload FROM branch_event WHERE kind IN ('prefix','prefix-done') ORDER BY ts ASC").all(); } catch { rows = []; }
    const openByKey = new Map(); const doneKeys = new Set();
    for (const r of rows) {
      const k = norm(r.payload); if (!k) continue;
      if (r.kind === 'prefix') { if (!openByKey.has(k)) openByKey.set(k, { raw: String(r.payload || ''), session: String(r.session_id || '') }); }
      else doneKeys.add(k);
    }
    const known = new Set(); try { known = new Set(db.prepare('SELECT dedup_key FROM pfx_op').all().map((r) => String(r.dedup_key))); } catch { }
    const migrateDone = !(c && c.pfxQueue && c.pfxQueue.intentMigrateDone === false);
    const now = _now();
    const ins = db.prepare(`INSERT INTO pfx_op(id,kind,target,op,name,payload,dedup_key,content_hash,status,attempts,urgent,src_session,src_turn,created_at,updated_at,applied_at)
                            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const sessions = new Set();
    const mkId = () => 'i_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    for (const [k, v] of openByKey) {
      const dk = 'intent|' + _sha1(k);
      if (known.has(dk)) { stat.skipped++; continue; }
      const isDone = doneKeys.has(k);
      if (isDone && !migrateDone) { stat.skipped++; continue; }
      const payload = JSON.stringify(isDone ? { norm: k } : { raw: v.raw, norm: k });
      const st = isDone ? 'done' : 'pending';
      ins.run(mkId(), 'intent', 'intent', 'intent', '', payload, dk, _sha1(payload), st, 0, 0, v.session, 0, now, now, isDone ? now : null);
      stat.inserted++;
      if (isDone) stat.done++; else { stat.open++; sessions.add(v.session); }
    }
    stat.sessions = sessions.size;
    try { _fs().writeFileSync(flag, String(now), 'utf8'); } catch { }
  } catch (e) { return Object.assign(stat, { error: String(e && e.message || e) }); }
  return stat;
}

/** 合法旁路申报（harness-sync-safe/手工运维）：登记当前指纹，避免被审计误报。 */
/** 唯一命中判定（纯函数）：给定改动路径/描述列表 → {prefix, reasons[]}。
 *  入参 items: Array<string|{path?, keys?}>；string 亦可为身份字段符号（如 'agent.name'/'name'）。
 *  命中：前缀来源 file/dir 精确匹配；或 config.json 且 keys 命中身份字段（IDENTITY_KEYS）。
 *  红线：只判不重置、不自动排重启（消费方=护栏，仅提示）。 */
function classifyChange(items) {
  const arr = Array.isArray(items) ? items : [items];
  const reasons = [];
  const idTok = (x) => { const m = /^(?:agent\.)?(name|role|domain|isMain)$/i.exec(String(x).trim()); return m ? m[1] : null; };
  const push = (id, extra) => { if (!reasons.some((r) => r.id === id)) reasons.push(Object.assign({ id }, extra || {})); };
  for (const it of arr) {
    if (it == null) continue;
    let p = null, keys = null;
    if (typeof it === 'object') { p = it.path; keys = Array.isArray(it.keys) ? it.keys : null; }
    else { const t = idTok(it); if (t) { push('config.identity', { key: t }); continue; } p = String(it); }
    if (!p) continue;
    let abs; try { abs = path.resolve(String(p)); } catch { continue; }
    const cfgPath = (() => { try { const c = require('./config'); return path.resolve(c.configPath ? c.configPath() : c.CONFIG_PATH); } catch { return null; } })();
    if (cfgPath && abs === cfgPath) { if (keys && keys.some((k) => IDENTITY_KEYS.includes(String(k)))) push('config.identity', { keys }); continue; }
    for (const src of PREFIX_SOURCES) {
      if (!src.guard || src.kind === 'configSubset' || src.kind === 'op') continue;
      let rp = null; try { rp = src.resolve(); } catch { }
      if (!rp) continue;
      rp = path.resolve(rp);
      const hit = (src.kind === 'dir') ? (abs === rp || abs.startsWith(rp + path.sep)) : (abs === rp);
      if (hit) push(src.id, { path: abs });
    }
  }
  return { prefix: reasons.length > 0, reasons };
}
/** 供护栏 run_command 用：由 PREFIX_SOURCES(file/dir) 生成"命中前缀路径"正则（精确到文件/目录；含 / 与 \\ 分隔容错）。 */
function prefixPathRegex() {
  try {
    const root = path.resolve(__dirname, '..');
    const frags = [];
    for (const src of PREFIX_SOURCES) {
      if (!src.guard || (src.kind !== 'file' && src.kind !== 'dir')) continue;
      let p = null; try { p = src.resolve(); } catch { }
      if (!p) continue;
      const rel = path.relative(root, path.resolve(p));
      if (!rel || rel.startsWith('..')) continue;
      frags.push(rel.split(/[\\/]/).map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]'));
    }
    if (!frags.length) return /$^/;
    return new RegExp('(' + frags.join('|') + ')', 'i');
  } catch { return /$^/; }
}
/** 记录层收口（2026-10-02）：凡命中 PREFIX_SOURCES 的前缀变更必有记录。
 *  覆盖旁路：write_file/edit_file/run_command/reload_plugins 命中前缀源。
 *  防环①：来源标记结构性隔离——origin==='pfx-apply'(队列内部落地) 直接 return；
 *         且只写 kind∈{bypass,restart}，绝不碰 content/intent（不与 apply 交互）。
 *  防环②：dedup_key 内容寻址 + 部分唯一索引 + INSERT OR IGNORE → 幂等。
 *  best-effort：失败不抛，但必留痕（⑥）。 */
function recordChange(opts = {}) {
  try {
    if (_applying) return { recorded: false, reason: 'internal-apply' };   // 防环①（结构性隔离：apply 落地期间一律不记账）
    if (String(opts.origin || '') === 'pfx-apply') return { recorded: false, reason: 'internal-apply' };   // 防环①（来源标记双保险）
    if (!enabled()) return { recorded: false, reason: 'disabled' };
    const tool = String(opts.tool || '');
    const changed = Array.isArray(opts.changedPaths) ? opts.changedPaths.filter(Boolean).map(String) : [];
    // 命中判定：唯一权威 classifyChange；config 字段级由身份 keys 表达
    const items = changed.slice();
    if (opts.identityKeys && opts.identityKeys.length && opts.configPath) items.push({ path: String(opts.configPath), keys: opts.identityKeys.map(String) });
    const cls = classifyChange(items);
    if (!cls || !cls.prefix) return { recorded: false, reason: 'no-hit' };
    const db = _ensure();
    const now = _now();
    const ch = _sha1(String(opts.contentHash || '') + '|' + changed.join('\n'));
    const ins = db.prepare(`INSERT OR IGNORE INTO pfx_op(id,kind,target,op,name,payload,dedup_key,content_hash,status,origin,needs_restart,path,src_session,src_turn,created_at,updated_at,applied_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`);
    const recs = [];
    for (const r of cls.reasons) {
      const id = String(r.id || '');
      const src = PREFIX_SOURCE_BY_ID.get(id);
      const needsRestart = RESTART_IDS.includes(id) ? 1 : 0;
      let fpath = r.path || null;
      if (!fpath && src) { try { fpath = src.resolve() || null; } catch { } }
      const dedupKey = 'bypass|' + tool + '|' + id + '|' + _sha1(ch + '|' + String(fpath || ''));
      const status = needsRestart ? 'pending' : 'recorded';
      const payload = JSON.stringify({ tool, id, key: r.key || null, uncovered: !!opts.uncovered, reason: r });
      const pid = 'p_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      let changes = 0;
      try { changes = ins.run(pid, 'bypass', id, 'change', tool, payload, dedupKey, ch, status, String(opts.origin || ('tool:' + tool)), needsRestart, fpath, String(opts.srcSession || ''), Number(opts.srcTurn || 0) || 0, now, now).changes || 0; } catch { }
      recs.push({ id, target: id, path: fpath, needsRestart: !!needsRestart, dedupKey, inserted: changes > 0 });
    }
    return { recorded: true, records: recs };
  } catch (e) {
    try {
      const lp = (_ctx && _ctx.paths && _ctx.paths.recordDegradedLog) || path.join(DATA_DIR, 'pfx-record-degraded.log');
      _fs().appendFileSync(lp, JSON.stringify({ at: _now(), err: String(e && e.message || e), tool: String(opts.tool || '') }) + '\n', 'utf8');
    } catch { }
    return { recorded: false, degraded: true, error: String(e && e.message || e) };
  }
}
/** pendingRestart 视图：需重启生效、尚未收口的记录（G3 由部署显式 clear）。 */
function listPendingRestart() {
  try { return _ensure().prepare("SELECT id,kind,target,path,origin,src_session,created_at FROM pfx_op WHERE kind IN ('bypass','restart') AND needs_restart=1 AND status='pending' ORDER BY created_at ASC").all(); } catch { return []; }
}
/** 重启完成后由部署显式勾销（G3）；无参=清全部，或传 {dedupKeys:[...]}/{targets:[...]}。 */
function clearPendingRestart(opts = {}) {
  try {
    const db = _ensure(); const now = _now();
    if (Array.isArray(opts.dedupKeys) && opts.dedupKeys.length) {
      for (const k of opts.dedupKeys) db.prepare("UPDATE pfx_op SET status='done', applied_at=?, updated_at=? WHERE kind IN ('bypass','restart') AND needs_restart=1 AND status='pending' AND dedup_key=?").run(now, now, String(k));
    } else if (Array.isArray(opts.targets) && opts.targets.length) {
      for (const t of opts.targets) db.prepare("UPDATE pfx_op SET status='done', applied_at=?, updated_at=? WHERE kind IN ('bypass','restart') AND needs_restart=1 AND status='pending' AND target=?").run(now, now, String(t));
    } else {
      db.prepare("UPDATE pfx_op SET status='done', applied_at=?, updated_at=? WHERE kind IN ('bypass','restart') AND needs_restart=1 AND status='pending'").run(now, now);
    }
    // 重启收尾机制（2026-10-02）：勾销=已重启 → 同步刷新 RESTART_IDS 的 pfx_attest 基线；
    //   否则 auditBypass 仍拿旧基线比 → 同一 finding 反复告警 / registerRestartNeeded 复活（审计不收敛）。
    for (const t of RESTART_IDS) { try { attest(t); } catch { } }
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
/** 重启收尾机制（2026-10-02）：低频确定性登记——RESTART_IDS 中"当前 hash ≠ 基线 且 无同 target pending"
 *  → INSERT OR IGNORE 一条 kind='restart',needs_restart=1,status='pending'（dedup_key='restart|target|sha1(actualHash)'）。
 *  仅"启动完成 / handoff 收尾"调用（禁挂 pre-request 高频路径）。首见（无基线）→ 建基线不登记（与 auditBypass 口径一致）。 */
function registerRestartNeeded() {
  const out = [];
  try {
    const db = _ensure(); const now = _now();
    const ins = db.prepare(`INSERT OR IGNORE INTO pfx_op(id,kind,target,op,name,payload,dedup_key,content_hash,status,origin,needs_restart,path,src_session,src_turn,created_at,updated_at,applied_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`);
    const baseMap = new Map(db.prepare('SELECT path,hash FROM pfx_attest').all().map((r) => [String(r.path), String(r.hash)]));
    const pend = new Set(db.prepare("SELECT DISTINCT target FROM pfx_op WHERE status='pending'").all().map((r) => String(r.target)));
    for (const t of RESTART_IDS) {
      try {
        const p = _targetFilePath(t, null); if (!p) continue;
        const cur = _fingerprint(t, null); if (cur == null) continue;
        if (!baseMap.has(p)) { db.prepare('INSERT OR REPLACE INTO pfx_attest(path,hash,ts) VALUES(?,?,?)').run(p, cur, now); continue; }   // 首见建基线
        if (baseMap.get(p) === cur) continue;   // 无变化
        if (pend.has(t)) continue;              // 已有 pending → 不重复
        const dedupKey = 'restart|' + t + '|' + _sha1(cur);
        const id = 'p_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        const payload = JSON.stringify({ target: t, actualHash: cur, expectedHash: baseMap.get(p) });
        const inserted = (ins.run(id, 'restart', t, 'change', 'restartNeeded', payload, dedupKey, cur, 'pending', 'restart-scan', 1, p, '', 0, now, now).changes || 0);
        out.push({ target: t, path: p, dedupKey, inserted: inserted > 0 });
      } catch { }
    }
    return out;
  } catch { return out; }
}
function attest(target, name) {
  const p = _targetFilePath(target, name); if (!p) return false;
  const h = _fingerprint(target, name); if (h == null) return false;   // C：统一指纹（含 config.identity 子集）
  try { _ensure().prepare('INSERT OR REPLACE INTO pfx_attest(path,hash,ts) VALUES(?,?,?)').run(p, h, _now()); return true; } catch { return false; }
}
function auditOn() {
  if (_ctx && _ctx.auditBypass != null) return !!_ctx.auditBypass;   // 单测注入覆盖
  try { const c = loadConfig(); return !(c && c.pfxQueue && c.pfxQueue.auditBypass === false); } catch { return true; }
}
/** 启动/交接核验入口：开关开启才检查；发现绕过直写 → console 告警 + 写 DATA_DIR/pfx-audit.log 留痕。异常一律吞，绝不影响启动/回合。 */
function runAudit(tag) {
  if (!auditOn()) return [];
  let findings = [];
  try { findings = auditBypass(); } catch { return []; }
  if (!findings.length) return [];
  for (const x of findings) { try { console.warn(`[pfx-audit] tamper ${JSON.stringify(Object.assign({ tag }, x))}`); } catch { } }
  try {
    const lp = (_ctx && _ctx.paths && _ctx.paths.auditLog) || path.join(DATA_DIR, 'pfx-audit.log');
    _fs().appendFileSync(lp, JSON.stringify({ ts: _now(), tag, findings }) + '\n', 'utf8');
  } catch { }
  return findings;
}

// C（2026-10-02）指纹扩容：覆盖集（原 system.md/harness/skill + 新增 prompt.js/plugins/config.identity）。
//   ⚠️ 已知不可覆盖：技能脚本跑在**独立 Python 进程**，可直写任意前缀文件 → **拦不住**，只能靠本审计**事后检出**。
// 2026-10-02 治理：覆盖集由 PREFIX_SOURCES（唯一权威）派生（audit=true）——不再手抄，防口径漂移。
const AUDIT_TARGETS = PREFIX_SOURCES.filter((s) => s.audit).map((s) => s.id);
/** 审计：当前指纹 ∉ 已登记基线 → {path,target,expectedHash,actualHash,ts}（不看 pending；合法队列落盘已在 apply 后刷新基线）。
 *  首次见到未登记项 → **建立基线**（不报），之后变化才报。 */
function auditBypass() {
  const findings = [];
  let db; try { db = _ensure(); } catch { return findings; }
  let rows = []; try { rows = db.prepare('SELECT path,hash FROM pfx_attest').all(); } catch { }
  for (const t of AUDIT_TARGETS) {
    const p = _targetFilePath(t, null); if (!p) continue;
    const cur = _fingerprint(t, null); if (cur == null) continue;
    const rec = rows.find((r) => String(r.path) === p);
    // F3（2026-10-02）：不再"该 target 有 pending 就整体跳过"——那会让其直写永不检出（重排链空转）。
    //   合法队列落盘在 apply 后已由 _attestItem 刷新基线 → 此处 rec.hash === cur，自然不报；
    //   能走到下方"不等"分支 = 基线未刷新却已变化 = 绕过队列的直写，照报。
    if (!rec) { try { db.prepare('INSERT OR REPLACE INTO pfx_attest(path,hash,ts) VALUES(?,?,?)').run(p, cur, _now()); } catch { } continue; }   // C：首次建立基线
    if (String(rec.hash) !== cur) findings.push({ path: p, target: t, expectedHash: rec.hash, actualHash: cur, ts: _now() });
  }
  return findings;
}
// ==================== C：廉价快指纹（每小窗请求前；仅变化才触发全量 runAudit） ====================
let _lastQuickSig = null;
/** O(1) stat 签名（各覆盖项 mtime+size 拼接的 sha1）。目录用目录自身 stat（增删项才变）。 */
function quickFingerprint() {
  const F = _fs(); let acc = '';
  for (const t of AUDIT_TARGETS) {
    const p = _targetFilePath(t, null); if (!p) { acc += t + ':-;'; continue; }
    try { const st = F.statSync(p); acc += t + ':' + Math.round(st.mtimeMs) + ':' + st.size + ';'; } catch { acc += t + ':-;'; }
  }
  return _sha1(acc);
}
/** 快指纹变化 → 触发全量 runAudit；无变化 → 不做事（返回 []）。 */
function quickCheck(tag) {
  try {
    const sig = quickFingerprint();
    if (sig === _lastQuickSig) return [];
    _lastQuickSig = sig;
    return runAudit(tag || 'quick');
  } catch { return []; }
}

/** 失败可见（2026-10-03）：已尝试且失败的 pending 项（attempts>0）——供主我每轮提示"前缀落盘失败 N 条"。
 *  不新增表：直接读 attempts/last_err 现有列。达 MAX_FLUSH_ATTEMPTS 者仍在此清单（可见、待主我处理）。 */
function listFailed(limit = 5) {
  try { return _ensure().prepare("SELECT target,name,attempts,last_err,updated_at FROM pfx_op WHERE kind='content' AND status='pending' AND attempts>0 ORDER BY updated_at DESC LIMIT ?").all(Number(limit) || 5); }
  catch { return []; }
}

// ==================== 对外：flushNow / status ====================
function _loadPending(filter) {
  const db = _ensure();
  let rows = db.prepare("SELECT * FROM pfx_op WHERE status='pending' AND kind='content'").all();
  if (filter && filter.target) rows = rows.filter((r) => String(r.target) === String(filter.target));
  return rows;
}
async function flushNow(opts = {}) {
  try {
    const items = _loadPending(opts.filter);
    return await apply(plan(items));
  } catch (e) {
    return { done: 0, skipped: 0, failed: 0, error: String(e && e.message || e), results: [] };
  }
}
function status(filter = {}) {
  try {
    const db = _ensure();
    let rows = db.prepare('SELECT id,target,op,name,status,attempts,last_err,src_session,updated_at,applied_at FROM pfx_op').all();
    if (filter && filter.status) rows = rows.filter((r) => String(r.status) === String(filter.status));
    if (filter && filter.target) rows = rows.filter((r) => String(r.target) === String(filter.target));
    if (filter && filter.name) rows = rows.filter((r) => String(r.name) === String(filter.name));
    return rows;
  } catch { return []; }
}

/** Y-step2（2026-10-02）：意图文本提取（去 "- [ ] " 壳，兼容 done 壳）。 */
function intentText(payload) {
  let raw = '';
  try { const p = JSON.parse(String(payload == null ? '' : payload)); raw = (p && p.raw != null) ? String(p.raw) : String((p && p.norm) || ''); }
  catch { raw = String(payload == null ? '' : payload); }
  return raw.replace(/^\s*[-*]\s*\[[ xX✓✔]?\]\s*/, '').trim();
}
/** Y-step2 读路径：查 pfx_op(kind='intent')。filter:{status,sessionId}。异常/无表 → []。返回 [{id,text,session,status}]（已去壳滤空）。 */
function listIntents(filter = {}) {
  try {
    const db = _ensure();
    let rows = db.prepare("SELECT id,payload,status,src_session,dedup_key,updated_at FROM pfx_op WHERE kind='intent'").all();
    if (filter && filter.status) rows = rows.filter((r) => String(r.status) === String(filter.status));
    if (filter && filter.sessionId) rows = rows.filter((r) => String(r.src_session) === String(filter.sessionId));
    return rows.map((r) => ({ id: r.id, text: intentText(r.payload), session: String(r.src_session || ''), status: String(r.status || '') })).filter((r) => r.text);
  } catch { return []; }
}
/** Y-step2 交接渲染：仅 pending，按"本会话 / 其它会话"分组。开关 pfxQueue.pfxIntentEnabled===false → 返回 null（调用方回退旧路径）。 */
function intentsGrouped(sessionId) {
  let on = true;
  try { const c = loadConfig(); on = !(c && c.pfxQueue && c.pfxQueue.pfxIntentEnabled === false); } catch { }
  if (!on) return null;
  const sid = String(sessionId || '');
  const mine = [], others = [];
  for (const r of listIntents({ status: 'pending' })) { if (sid && r.session === sid) mine.push(r.text); else others.push(r.text); }
  return { mine, others };
}

/** Y-step3（2026-10-02）写入口：登记一条前缀意图（实例级表）。重复（归一化键相同且表内已存在）→ **不新增**。返回 {added,id,key,reason}。 */
function addIntent(opts = {}) {
  const out = { added: false, id: null, key: null, reason: '' };
  try {
    let text = '';
    if (opts.text != null) text = String(opts.text);
    else if (opts.payload != null && typeof opts.payload === 'object') text = intentText(JSON.stringify(opts.payload));
    else text = String(opts.payload == null ? '' : opts.payload);
    const clean = text.replace(/^\s*[-*]\s*\[[ xX✓✔]?\]\s*/, '').trim();
    if (!clean) { out.reason = 'empty'; return out; }
    const branch = require('./branch');
    const key = branch.normPrefixKey ? branch.normPrefixKey(clean) : clean;
    out.key = key;
    const dedupKey = 'intent|' + _sha1(key);
    const db = _ensure();
    let exist = null;
    try { exist = db.prepare('SELECT id,status FROM pfx_op WHERE kind=? AND dedup_key=?').get('intent', dedupKey); } catch { }
    if (exist) { out.id = exist.id; out.reason = 'exists'; return out; }
    const now = _now();
    const id = 'i_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const payload = JSON.stringify({ raw: clean, norm: key });
    db.prepare("INSERT INTO pfx_op(id,kind,target,op,name,payload,dedup_key,content_hash,status,attempts,urgent,src_session,src_turn,origin_session,origin_cid,created_at,updated_at,applied_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, 'intent', 'intent', 'intent', '', payload, dedupKey, _sha1(payload), 'pending', 0, 0, String(opts.srcSession || ''), Number(opts.srcTurn) || 0, String(opts.originSession || ''), String(opts.originCid || ''), now, now, null);
    out.added = true; out.id = id; out.reason = 'inserted';
    return out;
  } catch (e) { out.reason = 'error:' + String(e && e.message || e); return out; }
}
/** Y-step3（2026-10-02）勾销入口：按归一化键把表内 pending intent 置 status='done'+applied_at（**跨会话生效**）。幂等。 */
function doneIntent(opts = {}) {
  const out = { done: 0, key: null, reason: '' };
  try {
    const branch = require('./branch');
    let key = opts.key != null ? String(opts.key) : '';
    if (!key && opts.text != null) { const c = String(opts.text).replace(/^\s*[-*]\s*\[[ xX✓✔]?\]\s*/, '').trim(); key = branch.normPrefixKey ? branch.normPrefixKey(c) : c; }
    if (!key) { out.reason = 'empty'; return out; }
    out.key = key;
    const dedupKey = 'intent|' + _sha1(key);
    const db = _ensure();
    const now = _now();
    const r = db.prepare("UPDATE pfx_op SET status='done', applied_at=?, updated_at=?, src_session=COALESCE(NULLIF(src_session,''),?) WHERE kind='intent' AND dedup_key=? AND status='pending'")
      .run(now, now, String(opts.actorSession || ''), dedupKey);
    out.done = (r && r.changes) ? Number(r.changes) : 0;
    out.reason = out.done ? 'done' : 'no-pending';
    // 回执搁浅修复（2026-10-10）：勾销成功后回读该 intent 的 origin，供调用方自动回执发起方。
    if (out.done) {
      try {
        const row = db.prepare("SELECT origin_session, origin_cid, notified_at, payload FROM pfx_op WHERE kind='intent' AND dedup_key=? LIMIT 1").get(dedupKey);
        if (row) {
          out.originSession = String(row.origin_session || '');
          out.originCid = String(row.origin_cid || '');
          out.notifiedAt = (row.notified_at == null) ? null : Number(row.notified_at);
          out.text = intentText(row.payload);
        }
      } catch { }
    }
    return out;
  } catch (e) { out.reason = 'error:' + String(e && e.message || e); return out; }
}

/** 回执搁浅修复（2026-10-10）：标记某 intent 已回执发起方（幂等；notified_at 防重复回执）。 */
function markIntentNotified(opts = {}) {
  try {
    const branch = require('./branch');
    let key = opts.key != null ? String(opts.key) : '';
    if (!key && opts.text != null) { const c = String(opts.text).replace(/^\s*[-*]\s*\[[ xX✓✔]?\]\s*/, '').trim(); key = branch.normPrefixKey ? branch.normPrefixKey(c) : c; }
    if (!key) return { ok: false, reason: 'empty' };
    const db = _ensure();
    const dedupKey = 'intent|' + _sha1(key);
    const r = db.prepare("UPDATE pfx_op SET notified_at=? WHERE kind='intent' AND dedup_key=? AND notified_at IS NULL").run(_now(), dedupKey);
    return { ok: true, changed: (r && r.changes) ? Number(r.changes) : 0 };
  } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
}

module.exports = {
  PREFIX_SOURCES, PREFIX_SOURCE_BY_ID, IDENTITY_KEYS, RESTART_IDS, classifyChange, prefixPathRegex, recordChange, listPendingRestart, clearPendingRestart, registerRestartNeeded,
  PfxDBError, TARGETS, TARGET_ORDER,
  init, close, enabled, failSafeMode, isDegraded,
  pfxWrite, enqueue, plan, apply, flushNow, status, listFailed,
  intentText, listIntents, intentsGrouped,
  AUDIT_TARGETS, quickFingerprint, quickCheck,
  addIntent, doneIntent, markIntentNotified,
  attest, auditBypass, auditOn, runAudit, migrateReflectIntents,
  markPfxDue, clearPfxDue, isPfxDue, maybeFlush,
  _dedupKeyFor, _payloadFor, _hashPath, _targetFilePath,
};
