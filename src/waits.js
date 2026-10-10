'use strict';
// 雷仔 · 等待↔唤醒根治 v1 · waits 表（单一事实源）
// 定案：按既定设计（等待唤醒根治）。
//
// 唯一不变量（可证伪）：凡"将等待"（等跨会话回执 / 等外部异步事件）必须登记到本表；
//   每条等待终态 ∈ {matched, expired, cancelled} 三态之一。
//   可证伪判据（巡检 SQL）：SELECT COUNT(*) FROM waits WHERE state='waiting' AND deadline<now 恒 = 0 → pendingOverdue()。
//   >0 即违规 → 由 sweepExpired 兜底（唤醒 waiter 并置 expired）。
//
// 设计要点：
//   - 表落**共享库 agents_shared.db**（跨实例可见）；路由只读本表（cid → waiter_session），废调用方手写目标 role/session。
//   - registerWait：**先落库再等待**（防崩溃丢登记）；deadline **缺省强制 TTL 15min**、clamp[60s, 24h]；同 cid 幂等；waiter session 校验。
//   - completeWait / cancelWait：终态（matched / cancelled），单调不可逆。
//   - sweepExpired：**leader-only**（防多实例重复唤醒），复用 mailbox.notifySession 唤醒 waiter。
//   - 可注入（单测隔离）：init({ db, hooks:{ now, sessionExists, notify, isLeader } })；DB 路径可经 LEIZAI_WAITS_DB / LEIZAI_AGENT_DB 覆盖。
// 纪律：本模块任何函数**绝不抛**（全部 try/catch 兜底），绝不因 waits 故障阻断主链路。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// —— 缺省强制 TTL / clamp 边界（[定案三.1] 禁靠 LLM 手填 deadline）——
const DEFAULT_TTL_MS = 15 * 60 * 1000;      // 缺省 15min
const MIN_TTL_MS = 60 * 1000;               // 下限 60s
const MAX_TTL_MS = 24 * 60 * 60 * 1000;     // 上限 24h
const TERMINAL = ['matched', 'expired', 'cancelled'];
const STATE_WAITING = 'waiting';

const DDL = `
CREATE TABLE IF NOT EXISTS waits(
  wait_id        TEXT PRIMARY KEY,
  waiter_session TEXT NOT NULL,
  peer           TEXT,
  kind           TEXT,
  cid            TEXT,
  reply_to       TEXT,
  deadline       INTEGER NOT NULL,
  state          TEXT NOT NULL DEFAULT 'waiting',
  notified_at    INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_waits_cid_waiting ON waits(cid) WHERE state='waiting' AND cid IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_waits_state_deadline ON waits(state, deadline);
CREATE INDEX IF NOT EXISTS ix_waits_waiter ON waits(waiter_session, state);
`;

let _db = null;
let _ownDb = false;
let _hooks = {};
let _timer = null;
let _timerAt = null;

function _cfg() { try { return require('./config').load(); } catch { return {}; } }
function enabled() { try { const c = _cfg(); return !(c.waits && c.waits.enabled === false); } catch { return true; } }
function now() { return (typeof _hooks.now === 'function') ? _hooks.now() : Date.now(); }
function selfRole() { const c = _cfg(); return (c.agent && c.agent.role) ? String(c.agent.role) : null; }

/** 共享库路径（与 mailbox.dbPath 同源：测试钩子 env 优先；默认 config.agentSharedDb / dataDir/agents_shared.db）。 */
function dbFile() {
  if (process.env.LEIZAI_WAITS_DB) return process.env.LEIZAI_WAITS_DB;
  if (process.env.LEIZAI_AGENT_DB) return process.env.LEIZAI_AGENT_DB;
  const c = _cfg();
  if (c.agentSharedDb) return String(c.agentSharedDb);
  return path.join(String(c.dataDir || path.join(__dirname, '..', 'data')), 'agents_shared.db');
}

/** 初始化（可重复调用以重定向，供测试隔离）。opts.db 注入内存/临时库（单测）。 */
function init(opts = {}) {
  if (opts.hooks) _hooks = Object.assign({}, _hooks, opts.hooks);
  if (opts.db) { _db = opts.db; _ownDb = false; }
  else if (!_db) {
    const sqlite = require('node:sqlite');
    const f = dbFile();
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch { }
    _db = new sqlite.DatabaseSync(String(f));
    _ownDb = true;
    try { _db.exec('PRAGMA busy_timeout = 5000;'); } catch { }
  }
  _db.exec(DDL);
  return _db;
}
function ensure() { return _db || init(); }
function setHooks(h) { _hooks = Object.assign({}, _hooks, h || {}); }
function close() { try { if (_ownDb && _db) _db.close(); } catch { } _db = null; _timer = null; _timerAt = null; }

/** leader 判定（sweep 单点执行）：默认=主引擎（config.agent.isMain）。 */
function isLeader() {
  if (typeof _hooks.isLeader === 'function') return !!_hooks.isLeader();
  const c = _cfg();
  return !!(c.agent && c.agent.isMain);
}
/** waiter session 校验：默认走 runtime.sessionExists；无法判定时放行（不因校验缺失拒登记）。 */
function sessionExists(sid) {
  if (typeof _hooks.sessionExists === 'function') return !!_hooks.sessionExists(sid);
  try { return !!require('./runtime').sessionExists(sid); } catch { return true; }
}
/** 唤醒 waiter：默认走 mailbox.notifySession（落库+投递/唤醒）。 */
function doNotify(sid, content, toRole) {
  if (typeof _hooks.notify === 'function') { try { _hooks.notify(sid, content, toRole); return true; } catch { return false; } }
  try {
    const mb = require('./mailbox');
    if (mb.available && mb.available()) {
      // 跨实例（refs=wait-wake-rootcause）：waiter 属他实例时，复用 deliver() 按其 role 的 base_url 投递唤醒；同实例不传 toRole（维持现状）。
      const _tr = (toRole && String(toRole) !== String(selfRole() || '')) ? String(toRole) : null;
      mb.notifySession(sid, String(content), selfRole() || 'main', _tr ? { toRole: _tr } : undefined);
      return true;
    }
  } catch { }
  return false;
}

function newId() { return 'w-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex'); }

/** deadline 归一：缺省 → base+TTL；显式 → clamp[base+60s, base+24h]。返回毫秒时间戳。 */
function clampDeadline(deadline, base) {
  const floor = base + MIN_TTL_MS, ceil = base + MAX_TTL_MS;
  let d = Number(deadline);
  if (!Number.isFinite(d) || d <= 0) d = base + DEFAULT_TTL_MS;
  else if (d < floor) d = floor;
  else if (d > ceil) d = ceil;
  return Math.round(d);
}

/**
 * 登记一条等待（先落库再等待）。
 * @param {{waiterSession:string, peer?:string, kind?:string, cid?:string, replyTo?:string, deadline?:number}} opts
 * @returns {{added:boolean, waitId?:string, deadline?:number, reason?:string}}
 */
function registerWait(opts = {}) {
  try {
    if (!enabled()) return { added: false, reason: 'disabled' };
    const db = ensure();
    const base = now();
    const waiterSession = String(opts.waiterSession || '').trim();
    if (!waiterSession) return { added: false, reason: 'no-waiter' };
    if (!sessionExists(waiterSession)) return { added: false, reason: 'no-session' };
    const cid = (opts.cid != null && String(opts.cid).trim()) ? String(opts.cid).trim() : null;
    // 同 cid 幂等：已有 waiting 行 → 直接复用，不重复登记。
    if (cid) {
      const ex = db.prepare(`SELECT wait_id, deadline FROM waits WHERE cid=? AND state='waiting' LIMIT 1`).get(cid);
      if (ex) return { added: false, reason: 'exists', waitId: String(ex.wait_id), deadline: Number(ex.deadline) };
    }
    const deadline = clampDeadline(opts.deadline, base);
    const waitId = newId();
    db.prepare(`INSERT INTO waits(wait_id,waiter_session,peer,kind,cid,reply_to,deadline,state,notified_at,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,'waiting',NULL,?,?)`)
      .run(waitId, waiterSession,
        opts.peer != null ? String(opts.peer) : null,
        opts.kind != null ? String(opts.kind) : null,
        cid,
        opts.replyTo != null ? String(opts.replyTo) : null,
        deadline, base, base);
    scheduleSweep();
    return { added: true, waitId, deadline };
  } catch (e) { return { added: false, reason: 'error', error: e.message }; }
}

/** 完成（matched）：收到对应 result / 外部完成事件 → 终态。按 cid 或 waitId 关单。 */
function completeWait(opts = {}) {
  try {
    if (!enabled()) return { done: false, reason: 'disabled' };
    const db = ensure();
    const cid = (opts.cid != null && String(opts.cid).trim()) ? String(opts.cid).trim() : null;
    const waitId = (opts.waitId != null && String(opts.waitId).trim()) ? String(opts.waitId).trim() : null;
    if (!cid && !waitId) return { done: false, reason: 'no-key' };
    const row = cid
      ? db.prepare(`SELECT wait_id FROM waits WHERE cid=? AND state='waiting' LIMIT 1`).get(cid)
      : db.prepare(`SELECT wait_id FROM waits WHERE wait_id=? AND state='waiting' LIMIT 1`).get(waitId);
    if (!row) return { done: false, reason: 'no-pending' };
    const t = now();
    const ch = db.prepare(`UPDATE waits SET state='matched', updated_at=? WHERE wait_id=? AND state='waiting'`).run(t, String(row.wait_id));
    return { done: Number(ch.changes) === 1, waitId: String(row.wait_id) };
  } catch (e) { return { done: false, reason: 'error', error: e.message }; }
}

/** 取消（cancelled）：人工出口——误登记/主动放弃 → 终态。 */
function cancelWait(opts = {}) {
  try {
    const db = ensure();
    const cid = (opts.cid != null && String(opts.cid).trim()) ? String(opts.cid).trim() : null;
    const waitId = (opts.waitId != null && String(opts.waitId).trim()) ? String(opts.waitId).trim() : null;
    if (!cid && !waitId) return { cancelled: false, reason: 'no-key' };
    const t = now();
    const ch = cid
      ? db.prepare(`UPDATE waits SET state='cancelled', updated_at=? WHERE cid=? AND state='waiting'`).run(t, cid)
      : db.prepare(`UPDATE waits SET state='cancelled', updated_at=? WHERE wait_id=? AND state='waiting'`).run(t, waitId);
    return { cancelled: Number(ch.changes) > 0, changes: Number(ch.changes) };
  } catch (e) { return { cancelled: false, reason: 'error', error: e.message }; }
}

/**
 * 结果投递路由（按 cid 反查 waiter）：唤醒路由只读本表，废调用方手写 role/session。
 * @returns {{waitId,waiterSession,replyTo,peer,kind,deadline,state}|null}
 */
function routeForCid(cid) {
  try {
    if (cid == null || !String(cid).trim()) return null;
    const db = ensure(); const c = String(cid).trim();
    let row = db.prepare(`SELECT wait_id,waiter_session,reply_to,peer,kind,deadline,state FROM waits WHERE cid=? AND state='waiting' ORDER BY created_at DESC LIMIT 1`).get(c);
    if (!row) row = db.prepare(`SELECT wait_id,waiter_session,reply_to,peer,kind,deadline,state FROM waits WHERE cid=? ORDER BY created_at DESC LIMIT 1`).get(c);
    if (!row) return null;
    return {
      waitId: String(row.wait_id), waiterSession: String(row.waiter_session),
      replyTo: row.reply_to ? String(row.reply_to) : null, peer: row.peer ? String(row.peer) : null,
      kind: row.kind ? String(row.kind) : null, deadline: Number(row.deadline), state: String(row.state),
    };
  } catch { return null; }
}

/** 巡检判据：state='waiting' AND deadline<now 的条数（唯一不变量要求恒=0）。 */
function pendingOverdue(opts = {}) {
  try {
    const db = ensure(); const t = (opts.now != null) ? Number(opts.now) : now();
    const r = db.prepare(`SELECT COUNT(*) AS n FROM waits WHERE state='waiting' AND deadline < ?`).get(t);
    return Number(r && r.n) || 0;
  } catch { return -1; }
}

/** 中央巡检：超期未终态 → 唤醒 waiter（notify）→ 置 expired。**leader-only**（防多实例重复唤醒）。 */
function sweepExpired(opts = {}) {
  try {
    if (!enabled()) return { skipped: true, reason: 'disabled', swept: 0 };
    if (!isLeader()) return { skipped: true, reason: 'not-leader', swept: 0 };
    const db = ensure(); const t = (opts.now != null) ? Number(opts.now) : now();
    const rows = db.prepare(`SELECT wait_id,waiter_session,peer,kind,cid,reply_to,deadline FROM waits WHERE state='waiting' AND deadline<=? ORDER BY deadline ASC`).all(t);
    let swept = 0;
    for (const r of rows) {
      // 先置终态（幂等：并发的另一 leader 抢到 changes=0 就不会重复唤醒）。
      const up = db.prepare(`UPDATE waits SET state='expired', notified_at=?, updated_at=? WHERE wait_id=? AND state='waiting'`).run(t, t, String(r.wait_id));
      if (Number(up.changes) !== 1) continue;
      swept++;
      if (opts.wake !== false) {
        const msg = `⏰ 等待超期兜底（waits）：cid=${r.cid || '(无)'}，peer=${r.peer || '—'}，kind=${r.kind || 'task'} 已超时未收到结果，已置 expired。若仍需结果请重新发起。`;
        // reply_to = 登记时的发起方 role（= waiter 所属实例）；非本实例 → 复用 mailbox 跨实例路径投递唤醒（refs=wait-wake-rootcause）。
        doNotify(String(r.waiter_session), msg, r.reply_to);
      }
    }
    return { skipped: false, swept };
  } catch (e) { return { skipped: false, swept: 0, error: e.message }; }
}

/** 统计（可选按 waiterSession）。 */
function stats(opts = {}) {
  try {
    const db = ensure();
    const out = { waiting: 0, matched: 0, expired: 0, cancelled: 0, overdue: pendingOverdue(opts) };
    const q = opts.waiterSession
      ? db.prepare(`SELECT state, COUNT(*) n FROM waits WHERE waiter_session=? GROUP BY state`).all(String(opts.waiterSession))
      : db.prepare(`SELECT state, COUNT(*) n FROM waits GROUP BY state`).all();
    for (const r of q) if (out[r.state] != null) out[r.state] = Number(r.n);
    return out;
  } catch (e) { return { error: e.message }; }
}

// ———————— durable 巡检：为最近一个 deadline 设定时器（重启由 scheduler.resumeAll → resume 重建）————————
function _nextDeadline() {
  try {
    const db = ensure();
    const r = db.prepare(`SELECT MIN(deadline) AS d FROM waits WHERE state='waiting'`).get();
    return (r && r.d) ? Number(r.d) : null;
  } catch { return null; }
}
function scheduleSweep() {
  try {
    if (!enabled() || !isLeader()) return;
    const d = _nextDeadline();
    if (d == null) { if (_timer) { clearTimeout(_timer); _timer = null; _timerAt = null; } return; }
    if (_timer && _timerAt != null && d >= _timerAt) return;   // 已有更早/等早的定时器 → 不重排
    if (_timer) { clearTimeout(_timer); _timer = null; _timerAt = null; }
    let ms = d - now(); if (ms < 0) ms = 0; if (ms > MAX_TTL_MS) ms = MAX_TTL_MS;
    _timerAt = d;
    _timer = setTimeout(() => { _timer = null; _timerAt = null; try { sweepExpired(); } catch { } scheduleSweep(); }, ms);
    if (_timer.unref) _timer.unref();
  } catch { }
}
/** 重启续跑：重建定时器并立即巡检一次。 */
function resume() { try { sweepExpired(); } catch { } scheduleSweep(); return stats({}); }

module.exports = {
  init, close, setHooks, dbFile, enabled,
  registerWait, completeWait, cancelWait, routeForCid, pendingOverdue, sweepExpired, stats, resume, scheduleSweep,
  isLeader, DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS, TERMINAL,
};
