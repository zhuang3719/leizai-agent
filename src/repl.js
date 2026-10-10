'use strict';
// 雷仔 · Python 持久 REPL 管理器（RLM 内核）
// 一个会话一个常驻 Python 进程（repl_host.py），跨工具调用保留变量/导入/状态；
// 进程退出/超时会自动重启。新增：跨服务器重启的「内核快照/恢复」——
//   运行中对有变更的会话周期性快照到 data/kernels/<session>.pickle（pickle，仅可序列化变量+模块名）；
//   新进程启动时若有快照则先 restore 再执行，从而让 REPL 状态在重启后延续（尽力而为）。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, load: loadConfig } = require('./config');

const HOST = path.join(__dirname, 'repl_host.py');
const PREFIX = '@LEIZAI@';
const KERNEL_DIR = path.join(DATA_DIR, 'kernels');
const procs = new Map(); // sessionId -> {proc, buf, seq, queue[], stderr, dirty}

function kernelFile(sessionId) {
  return path.join(KERNEL_DIR, String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_') + '.pickle');
}

function get(sessionId) {
  let st = procs.get(sessionId);
  if (st && st.proc.exitCode === null) return st;
  const cfg = loadConfig();
  const python = cfg.pythonPath || 'python';
  let proc;
  try {
    proc = spawn(python, ['-u', '-B', HOST], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    throw new Error(`Python 启动失败: ${e.message}（请安装 Python 或在设置中配置 pythonPath）`);
  }
  st = { proc, buf: '', seq: 0, queue: [], stderr: '', dirty: false };
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    st.buf += d;
    let idx;
    while ((idx = st.buf.indexOf('\n')) >= 0) {
      const line = st.buf.slice(0, idx);
      st.buf = st.buf.slice(idx + 1);
      handleLine(st, line);
    }
  });
  proc.stderr.on('data', (d) => { st.stderr = (st.stderr + d).slice(-4000); });
  proc.on('error', (e) => {
    failAll(st, `Python 无法启动: ${e.message}`);
    procs.delete(sessionId);
  });
  proc.on('exit', (code) => {
    const note = st.stderr ? '\n' + st.stderr.slice(-500) : '';
    failAll(st, `Python REPL 进程已退出（exit=${code}）${note}`);
    procs.delete(sessionId);
  });
  procs.set(sessionId, st);
  // 跨重启恢复：若存在上次快照，进程启动后先 restore 再执行（尽力而为，失败不阻塞）
  const snap = kernelFile(sessionId);
  if (fs.existsSync(snap)) {
    request(st, sessionId, { cmd: 'restore', path: snap }, 15000).catch(() => { });
  }
  return st;
}

function handleLine(st, line) {
  if (!line.startsWith(PREFIX)) return;
  let j;
  try { j = JSON.parse(line.slice(PREFIX.length)); } catch { return; }
  const i = st.queue.findIndex((q) => q.id === j.id);
  if (i < 0) return;
  const q = st.queue.splice(i, 1)[0];
  clearTimeout(q.timer);
  q.resolve(j);
}

function failAll(st, msg) {
  for (const q of st.queue) { clearTimeout(q.timer); q.resolve({ id: q.id, ok: false, stdout: '', stderr: '', error: msg }); }
  st.queue = [];
}

/** 统一请求通道：分配 id、入队、写 stdin、超时处理。 */
function request(st, sessionId, obj, timeoutMs) {
  return new Promise((resolve) => {
    const id = ++st.seq;
    const timer = setTimeout(() => {
      const i = st.queue.findIndex((q) => q.id === id);
      if (i >= 0) {
        st.queue.splice(i, 1);
        try { st.proc.kill(); } catch { }
        procs.delete(sessionId);
        resolve({ id, ok: false, stdout: '', stderr: '', error: `Python REPL 执行超时（${timeoutMs}ms），进程已重启，之前的状态丢失` });
      }
    }, timeoutMs);
    st.queue.push({ id, resolve, timer });
    try {
      st.proc.stdin.write(JSON.stringify({ ...obj, id }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      const i = st.queue.findIndex((q) => q.id === id);
      if (i >= 0) st.queue.splice(i, 1);
      resolve({ id, ok: false, stdout: '', stderr: '', error: `Python REPL 写入失败: ${e.message}` });
    }
  });
}

/**
 * 在会话的持久 REPL 中执行代码。
 * @returns Promise<{ok, stdout, stderr, error}>
 */
function evalCode(sessionId, code, { timeoutMs = 60000, reset = false } = {}) {
  if (reset) kill(sessionId);
  let st;
  try { st = get(sessionId); } catch (e) {
    return Promise.resolve({ ok: false, stdout: '', stderr: '', error: e.message });
  }
  return request(st, sessionId, { code }, timeoutMs).then((j) => {
    if (j.ok) st.dirty = true;   // 有变更 → 进入下一次周期快照
    return j;
  });
}

/** 把当前内核状态快照到磁盘（可序列化变量 + 模块名）。REPL 忙时跳过。 */
async function snapshot(sessionId) {
  const st = procs.get(sessionId);
  if (!st || st.proc.exitCode !== null) return { ok: false, error: '无活动 REPL' };
  if (st.queue.length) return { ok: false, error: 'REPL 忙，跳过快照' };
  const file = kernelFile(sessionId);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { }
  try {
    const j = await request(st, sessionId, { cmd: 'snapshot', path: file }, 15000);
    if (j.ok) st.dirty = false;
    return j;
  } catch (e) { return { ok: false, error: e.message }; }
}

// 周期快照：对「有变更且空闲」的会话落盘，使重启后能尽量恢复内核状态
const snapTimer = setInterval(() => {
  for (const sid of procs.keys()) {
    const st = procs.get(sid);
    if (st && st.dirty && st.queue.length === 0) snapshot(sid).catch(() => { });
  }
}, 4000);
if (snapTimer.unref) snapTimer.unref();

/** 立即落盘当前所有有变更会话（供显式调用/退出前调用，尽力而为）。 */
function snapshotAll() {
  for (const sid of procs.keys()) snapshot(sid).catch(() => { });
}

/** 删除会话/重置时调用：移除快照并结束进程（会话已不存在，不保留）。 */
function kill(sessionId) {
  const st = procs.get(sessionId);
  if (!st) return false;
  try { fs.unlinkSync(kernelFile(sessionId)); } catch { }
  try { st.proc.stdin.end(); } catch { }
  try { st.proc.kill(); } catch { }
  procs.delete(sessionId);
  return true;
}

/** 模拟崩溃/重启：结束进程但**不**删除快照，下次 get() 会从快照恢复状态。 */
function restart(sessionId) {
  const st = procs.get(sessionId);
  if (!st) return false;
  procs.delete(sessionId);
  try { st.proc.kill(); } catch { }
  return true;
}

/** 服务器关闭时调用：结束所有进程但保留快照（供下次重启恢复）。 */
function killAll() {
  for (const st of [...procs.values()]) {
    try { st.proc.stdin.end(); } catch { }
    try { st.proc.kill(); } catch { }
  }
  procs.clear();
}

module.exports = { evalCode, snapshot, snapshotAll, kill, killAll, restart, kernelFile };
