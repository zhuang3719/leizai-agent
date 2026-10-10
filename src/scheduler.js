'use strict';
// 雷仔 · 调度器（心跳 / 定时）
// 两类调度：
//   heartbeat —— 每隔 intervalSec 秒向指定会话注入一条消息并继续工作（长时任务的"脉搏"）；
//   at        —— 一次性（ISO 时间）或每天（HH:MM + repeats）触发。
// 全部持久化到 data/schedules/，服务器重启自动恢复（断线续跑）。
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, load: loadConfig } = require('./config');
const runtime = require('./runtime');

const DIR = path.join(DATA_DIR, 'schedules');
const store = new Map(); // id -> task
let timer = null;

function ensure() { fs.mkdirSync(DIR, { recursive: true }); }
function file(id) { return path.join(DIR, `${id}.json`); }

function save(t) {
  ensure();
  fs.writeFileSync(file(t.id), JSON.stringify({ ...t, loop: false }, null, 2), 'utf8');
}

function list() {
  ensure();
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
    .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
}

function load(id) {
  const f = file(id);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function base(sessionId, message) {
  return {
    id: `sched-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ts: new Date().toISOString(), createdAt: new Date().toISOString(),
    sessionId, message: String(message || '检查并继续当前工作').slice(0, 2000),
    status: 'active', lastRun: null, nextRun: null, loop: false,
  };
}

/** 心跳：每 intervalSec 秒注入一次。 */
function createHeartbeat(sessionId, intervalSec, message) {
  const t = base(sessionId, message);
  t.type = 'heartbeat';
  t.intervalSec = Math.max(5, intervalSec);
  t.nextRun = Date.now() + t.intervalSec * 1000;
  save(t);
  store.set(t.id, t);
  broadcast('schedule', { id: t.id, status: 'created', type: t.type, message: t.message });
  return t;
}

/** 定时：at 为 ISO 时间串（一次性）或 HH:MM（每天，需 repeats=true）。 */
function createAt(sessionId, at, message, { repeats = false } = {}) {
  const t = base(sessionId, message);
  t.type = 'at';
  t.repeats = !!repeats;
  t.at = String(at);
  const next = parseAt(t.at, t.repeats);
  if (!next) throw new Error(`时间格式无效: ${at}（请用 ISO 时间串或 HH:MM）`);
  t.nextRun = next;
  save(t);
  store.set(t.id, t);
  broadcast('schedule', { id: t.id, status: 'created', type: t.type, message: t.message });
  return t;
}

function parseAt(at, repeats) {
  if (/^\d{1,2}:\d{2}$/.test(at)) {
    const [h, m] = at.split(':').map(Number);
    if (h > 23 || m > 59) return null;
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (!repeats && d.getTime() <= Date.now()) return null;
    return d.getTime();
  }
  const ts = Date.parse(at);
  return isNaN(ts) ? null : ts;
}

function remove(id) {
  const t = load(id);
  if (!t) return false;
  try { fs.unlinkSync(file(id)); } catch { }
  store.delete(id);
  broadcast('schedule', { id, status: 'removed', type: t.type });
  return true;
}

function stop(id) {
  const t = load(id);
  if (!t) return null;
  t.status = 'stopped'; t.updatedAt = new Date().toISOString();
  try { fs.unlinkSync(file(id)); } catch { } // 停止即从列表移除（不再显示）
  store.delete(id);
  broadcast('schedule', { id, status: 'stopped', type: t.type });
  return t;
}

// ———————— 执行循环 ————————

/** 移除引用"不存在会话"的调度（孤儿调度，避免反复失败刷屏）。 */
function pruneOrphans() {
  for (const t of list()) {
    try { runtime.getSession(t.sessionId); } catch (e) { remove(t.id); }
  }
}

// 会话是否正忙（有回合在跑 / 收尾压缩中）——忙时心跳不消耗本轮，短退避待空闲补跳。
function isBusy(sessionId) {
  try {
    const s = runtime.getSession(sessionId);
    return !!(s && (s.running || s._compactBusy));
  } catch { return false; }
}
// 短退避：不超过 15s，也不超过本任务 interval，避免忙时高频空转。
function shortBackoff(t) {
  const sec = Math.max(1, Math.min(Number(t.intervalSec) || 15, 15));
  return Date.now() + sec * 1000;
}

async function runOne(t) {
  // 会话不存在 → 该调度成为孤儿（引用的会话已被删除/清理），移除而不是反复失败
  try { runtime.getSession(t.sessionId); } catch (e) {
    remove(t.id);
    console.log(`调度 ${t.id} 已移除（引用的会话不存在: ${t.sessionId}）`);
    return;
  }
  try {
    const msg = `[心跳${t.type === 'at' ? '·定时' : ''}] ${t.message}`;
    // 单回合迭代上限跟随全局 iterationCap（曾硬编码 8：定时/心跳任务在长任务中被 8 次截断，
    // 且在会话里表现为"单回合工具调用上限 8 次"；统一由 config.json 一处控制）
    await runtime.runChat(t.sessionId, msg, { maxIterations: Number(loadConfig().iterationCap) || 24, origin: t.type === 'at' ? 'timer' : 'heartbeat' });
  } catch (e) {
    // 会话正忙（与 tick 预检查的竞态窗口）：不丢弃——短退避重试，待空闲补跳。
    if (/正在运行中/.test(e.message || '')) {
      const cur = store.get(t.id);
      if (cur && cur.status === 'active') {
        cur.nextRun = shortBackoff(cur);
        save(cur);
        console.log(`调度 ${t.id} 会话忙，顺延重试（不丢弃）`);
        return;
      }
    }
    // 其它异常（会话不存在已在上方处理）：跳过本轮，不中止调度
    console.log(`调度 ${t.id} 触发失败（跳过本轮）: ${e.message}`);
  }
}

function tick() {
  const now = Date.now();
  for (const t of [...store.values()]) {
    if (t.status !== 'active' || t.loop) continue;
    if (!t.nextRun || t.nextRun > now) continue;
    // 忙时不消耗本轮：不前进 lastRun、不置 loop，仅短退避顺延待空闲补跳（修复"永久丢弃"）
    if (isBusy(t.sessionId)) {
      t.nextRun = shortBackoff(t);
      save(t);
      console.log(`调度 ${t.id} 会话忙，顺延 ${Math.round((t.nextRun - now) / 1000)}s（不丢弃）`);
      continue;
    }
    t.loop = true;
    t.lastRun = now;
    if (t.type === 'heartbeat') {
      t.nextRun = now + t.intervalSec * 1000;
    } else {
      t.nextRun = t.repeats ? nextDaily(t.at) : null;
      if (!t.nextRun && !t.repeats) t.status = 'done';
    }
    save(t);
    runOne(t).finally(() => {
      const cur = store.get(t.id);
      if (cur) { cur.loop = false; try { save(cur); } catch { } }
    });
  }
  // 属性访问修正：删除已结束的一次性任务标记
  for (const t of [...store.values()]) {
    if (t.status === 'done') store.delete(t.id);
  }
}

function nextDaily(at) {
  const d = new Date();
  const [h, m] = at.split(':').map(Number);
  d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function start() {
  if (timer) return;
  timer = setInterval(tick, 1000);
  if (timer.unref) timer.unref();
}

/** 服务器启动时恢复所有 active 调度，并清理引用不存在会话的孤儿调度。 */
function resumeAll() {
  pruneOrphans();
  for (const t of list()) {
    if (t.status === 'active') {
      const task = { ...t, loop: false };
      if (!task.nextRun) {
        task.nextRun = task.type === 'heartbeat' ? Date.now() + (task.intervalSec || 3600) * 1000 : nextDaily(task.at || '09:00');
      }
      store.set(task.id, task);
      save(task);
    }
  }
  start();
  // 等待↔唤醒根治 v1（refs=wait-wake-rootcause）：重启后按 waits.deadline 重建巡检定时器（durable 续跑，leader-only）。
  try { require('./waits').resume(); } catch { }
}

function broadcast(event, data) {
  try { runtime.runtime.emit('schedule', data); } catch { }
}

module.exports = { createHeartbeat, createAt, remove, stop, list, load, resumeAll, start, pruneOrphans };
