'use strict';
// 雷仔 · HTTP 服务器（零依赖：node:http + SSE；网页版已弃用，仅桌面客户端使用）
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, DATA_DIR, load: loadConfig, save: saveConfig } = require('./config');
const runtime = require('./runtime');
const branch = require('./branch');
const evolution = require('./evolution');
const memory = require('./memory');
const archiveStore = require('./archiveStore');
const subagent = require('./subagent');
const mailbox = require('./mailbox');
const scheduler = require('./scheduler');
const repl = require('./repl');
const deepseek = require('./deepseek');
const versionchain = require('./versionchain');
const growth = require('./growth');
const selftrain = require('./selftrain');
const selftrain_task = require('./selftrain_task');
// 全局上下文预算硬上限（与 runtime.js 的 CONTEXT_BUDGET_MAX 对齐，取值必须=900000）：防绕过前端直调 API 传超大值。
const CONTEXT_BUDGET_MAX = 900000;
const selfmodel = require('./selfmodel');
const srcdrift = require('./srcdrift');

// —— 实例主从判定（唯一权威）——
// 主我 / 产品单实例（config 无 agent 块 = 顶层引擎 / 无父雷影）**视为 main**；
// 仅显式 `agent.isMain === false` 的实例（雷影）为从。
// 修复 2026-10-04：产品版 config 的 agent 块为空 → 旧式 `!!(cfg.agent && cfg.agent.isMain)`
//   判 false → "创建雷影"被 403"仅主实例"挡死（应触达 agents-admin 的 pro_required 门禁）。
function isMainInstance(cfg) { return !(cfg && cfg.agent && cfg.agent.isMain === false); }

// —— 守护进程模式（--daemon）：独立后台运行，客户端关闭窗口后继续存活，可 attach/detach ——
const DAEMON = process.argv.includes('--daemon');
const DAEMON_PID = path.join(DATA_DIR, 'daemon.pid');

// —— 日志文件镜像（logs/leizai.log），便于用户报障 ——
const LOG_DIR = path.join(ROOT, 'logs');
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logStream = fs.createWriteStream(path.join(LOG_DIR, 'leizai.log'), { flags: 'a' });
  // 本地时间戳（含时区偏移 +0800）：方便按本地时段直观切分成本/性能
  const ts = () => {
    const d = new Date();
    const p = (n, l) => String(n).padStart(l || 2, '0');
    const offMin = -d.getTimezoneOffset();
    const offSign = offMin >= 0 ? '+' : '-';
    const offAbs = Math.abs(offMin);
    const off = offSign + p(Math.floor(offAbs / 60)) + p(offAbs % 60);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${off}`;
  };
  const mirror = (level, args) => {
    const line = `[${ts()}] [${level}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
    if (level === 'ERR') process.stderr.write(line + '\n'); else process.stdout.write(line + '\n');
    logStream.write(line + '\n');
  };
  console.log = (...a) => mirror('INFO', a);
  console.error = (...a) => mirror('ERR', a);
} catch { /* 日志失败不阻塞启动 */ }

// —— 事件广播 ——
const hub = new Set();
let _balanceCache = { at: 0, data: null };   // 账户余额 60s 缓存
let _todayCostCache = { at: 0, data: null };
let _llmHealthCache = { at: 0, data: null };   // 任务B：模型服务探活 30s 缓存

// v6.1.2：涟漪事件流持久化（环形最近 500 条 → data/events.json），关掉客户端重开仍在。
// 仅持久化前端涟漪流关心的事件类型（与 store.events 对齐）；写文件失败绝不影响主流程。
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const EVENTS_RING_MAX = 500;
const PERSIST_EVENT_TYPES = new Set(['reflect', 'turn-done', 'schedule', 'compacted', 'mailbox-message',
  'evolution']);   // 与 AGG_EVENT_WHITELIST 对齐（turn-done 额外保留：前端曲线回填用）；高频/前端不渲染类不再持久化，省 ring
let _eventsRing = null;
function loadEventsRing() {
  if (_eventsRing) return _eventsRing;
  try { const a = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); _eventsRing = Array.isArray(a) ? a : []; }
  catch { _eventsRing = []; }
  return _eventsRing;
}
function slimPersistData(event, data) {
  // mailbox-message 带完整正文（可较长）→ 落盘只留 preview，避免事件文件膨胀
  try {
    if (event === 'mailbox-message' && data && typeof data === 'object') {
      const { full, ...rest } = data;
      return rest;
    }
  } catch { }
  return data;
}
function persistEvent(event, data, at) {
  try {
    if (!PERSIST_EVENT_TYPES.has(event)) return;
    const ring = loadEventsRing();
    ring.push({ type: event, data: slimPersistData(event, data), at: (at != null ? at : Date.now()) });
    if (ring.length > EVENTS_RING_MAX) ring.splice(0, ring.length - EVENTS_RING_MAX);
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(ring), 'utf8');
  } catch { /* 落盘失败不得影响主流程 */ }
}

// ── P1（运行指标聚合）：GET /api/sessions/:id/stats?aggregate=1 ──
//   关联权威=session_links（mailbox.listLinks）：从 :id 出发递归闭包（visited 去重防双向循环，单一权威）。
//   本实例直读 sessionStats；跨实例 GET {peer_base_url}/api/sessions/{peerSessionId}/stats（800ms 超时 + allSettled + 失败降级 online:false + 404 死会话过滤）。
//   口径：只累加**原始 token**（hit/miss/out）；cost 一律以**主引擎 cfg 统一计价**（不累加对端 cost，防各实例价/汇率漂移）；hitRate 加权 = Σhit/(Σhit+Σmiss)；usedTokens/contextBudget 窗口语义**不求和**。
const _aggStatsCache = new Map();        // sid -> { at, data }
const AGG_CACHE_MS = 60 * 1000;
const AGG_PEER_TIMEOUT_MS = 800;

async function _aggHttpJson(url, timeoutMs) {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => { try { ctl.abort(); } catch { } }, timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      let j = null; try { j = await r.json(); } catch { j = null; }
      return { ok: r.ok, status: r.status, json: j };
    } finally { clearTimeout(to); }
  } catch (e) { return { ok: false, status: 0, error: String((e && e.message) || e) }; }
}

/** 从 rootSid 出发，按 session_links 递归收集关联会话闭包（visited 去重防双向循环）。 */
function _aggCollectClosure(rootSid) {
  const root = String(rootSid);
  const visited = new Set();
  const nodeMap = new Map();   // sessionId -> {sessionId, role, baseUrl, local}
  const q = [root];
  while (q.length) {
    const cur = String(q.shift());
    if (!cur || visited.has(cur)) continue;
    visited.add(cur);
    if (!nodeMap.has(cur)) nodeMap.set(cur, { sessionId: cur, role: '', baseUrl: null, local: (cur === root) });
    let links = [];
    try { links = mailbox.listLinks(cur) || []; } catch { links = []; }
    for (const lk of links) {
      const pid = lk && lk.peer_session_id ? String(lk.peer_session_id) : '';
      if (!pid) continue;
      if (!nodeMap.has(pid)) nodeMap.set(pid, { sessionId: pid, role: (lk.peer_role || ''), baseUrl: (lk.peer_base_url || null), local: (pid === root) });
      if (!visited.has(pid)) q.push(pid);
    }
  }
  if (nodeMap.has(root)) { const n = nodeMap.get(root); n.local = true; try { n.role = mailbox.selfRole(); } catch { } }
  return [...nodeMap.values()];
}

function _aggFetchStats(node) {
  if (node.local) {
    try { const s = runtime.getSession(node.sessionId); return Promise.resolve({ online: true, stats: runtime.sessionStats(s) }); }
    catch { return Promise.resolve({ online: false, stats: null }); }
  }
  const base = String(node.baseUrl || '').replace(/\/+$/, '');
  if (!base) return Promise.resolve({ online: false, stats: null });
  const u = base + '/api/sessions/' + encodeURIComponent(node.sessionId) + '/stats';
  return _aggHttpJson(u, AGG_PEER_TIMEOUT_MS).then((r) => {
    if (r && r.status === 404) return { online: false, dead: true, stats: null };   // 死会话 → 过滤
    if (r && r.ok && r.json) return { online: true, stats: r.json };
    return { online: false, stats: null };
  }).catch(() => ({ online: false, stats: null }));
}

function _aggFetchEventsCore(node) {
  if (node.local) { try { return Promise.resolve({ online: true, items: loadEventsRing() || [] }); } catch { return Promise.resolve({ online: true, items: [] }); } }
  const base = String(node.baseUrl || '').replace(/\/+$/, '');
  if (!base) return Promise.resolve({ online: false, items: [] });
  const u = base + '/api/events/history?limit=500';
  return _aggHttpJson(u, AGG_PEER_TIMEOUT_MS).then((r) => (r && r.ok && r.json && Array.isArray(r.json.items)) ? { online: true, items: r.json.items } : { online: false, items: [] }).catch(() => ({ online: false, items: [] }));
}
function _aggFetchEvents(node) { return _aggFetchEventsCore(node).then((r) => (r && r.items) || []); }

/** 聚合本会话 + 其关联（递归）雷影会话的运行指标。 */
async function aggregateSessionStats(rootSid) {
  const nodes = _aggCollectClosure(rootSid);
  const settled = await Promise.allSettled(nodes.map(async (n) => {
    const [st, ev] = await Promise.all([_aggFetchStats(n), _aggFetchEvents(n)]);
    return { node: n, stats: st.stats, online: !!st.online, dead: !!st.dead, evItems: ev || [] };
  }));
  const items = [];
  const pts = [];
  let tHit = 0, tMiss = 0, tOut = 0, tCalls = 0;
  for (const r of settled) {
    if (!r || r.status !== 'fulfilled') continue;
    const { node, stats, online, dead, evItems } = r.value;
    if (dead) continue;                       // 死会话(404) 过滤
    const hit = Number(stats && stats.hitTokens) || 0;
    const miss = Number(stats && stats.missTokens) || 0;
    const out = Number(stats && stats.outputTokens) || 0;
    const calls = Number(stats && stats.calls) || 0;
    const c = runtime.costFromTokens({ hit, miss, out });
    items.push({ role: node.role, sessionId: node.sessionId, used: hit + miss + out, hit, miss, out, cost: c.costRmb, calls, online: !!online });
    if (online) { tHit += hit; tMiss += miss; tOut += out; tCalls += calls; }
    try {
      for (const it of (evItems || [])) {
        if (it && it.type === 'turn-done' && it.data && String(it.data.sessionId) === String(node.sessionId)) {
          const u = it.data.usage || {};
          pts.push({ at: Number(it.at) || 0, hit: Number(u.hitTokens) || 0, miss: Number(u.missTokens) || 0, out: Number(u.outputTokens) || 0 });
        }
      }
    } catch { }
  }
  const totalCost = runtime.costFromTokens({ hit: tHit, miss: tMiss, out: tOut });
  pts.sort((a, b) => a.at - b.at);
  const history = pts.slice(-500).map((p) => ({ at: p.at, hit: p.hit, miss: p.miss, out: p.out, cost: runtime.costFromTokens({ hit: p.hit, miss: p.miss, out: p.out }).costRmb }));
  items.sort((a, b) => (b.hit + b.miss + b.out) - (a.hit + a.miss + a.out));
  return {
    aggregate: true,
    total: { used: tHit + tMiss + tOut, hit: tHit, miss: tMiss, out: tOut, costRmb: totalCost.costRmb, calls: tCalls, hitRate: (tHit + tMiss) ? tHit / (tHit + tMiss) : 0 },
    items,
    history,
  };
}

// ── 涟漪流聚合：GET /api/events/aggregate?sessionId=:id&limit=N ──
//   复用闭包(_aggCollectClosure)/对端 history(_aggFetchEventsCore)；仅保留**跨会话边界/生命周期类**事件，
//   排除高频内部事件(turn-done/turn-progress/llm-status/turn-stream…)。仅保留 data.sessionId∈闭包 的事件。
//   去重：事件无 id → 合成唯一键 = inst|at|type|sessionId|role|sig(data 摘要)。
const AGG_EVENT_WHITELIST = new Set([
  // 权威 = **前端确实会显示**的类型（feed.js TYPE_LABEL/ text() 有中文映射，且不在 NOISE_TYPES）。
  //   原则：后端只拉前端会渲染的，杜绝"引擎拉来、前端滤掉/空白卡"。改动任一端须两端同步。
  'mailbox-message',    // 雷影消息（派活/回执/result/ack）— feed.js text() 有案
  'turn-done',          // 回合完成（含关联雷影会话）— 涟漪流核心（设计v1 §三.2 放宽；仍受 sid∈closure 过滤）
  'compacted',          // 世代交接 — 有案
  'schedule',           // 心跳/定时 — 有案
  'reflect',            // 自我反思 — 有案
  'evolution',          // 进化 — 有案
]);
const _aggEventsCache = new Map();   // key=sid|limit -> { at, data }

/** 事件去重签名：优先稳定字段，退化为 data 摘要。 */
function _aggEventSig(e) {
  try { const d = (e && e.data) || {}; return String(d.id || d.msgId || d.cid || d.content || d.title || d.text || '').slice(0, 80); } catch { return ''; }
}

/** 聚合 主会话 + 关联(递归闭包)雷影会话 的涟漪事件（跨会话边界/生命周期类）。 */
async function aggregateEvents(rootSid, limit) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 200));
  const nodes = _aggCollectClosure(rootSid);
  const closureSet = new Set(nodes.map((n) => String(n.sessionId)));
  const settled = await Promise.allSettled(nodes.map((n) => _aggFetchEventsCore(n)));
  const seen = new Set();
  const items = [];
  let anyFail = false;
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    const n = nodes[i];
    const ok = (r.status === 'fulfilled') && r.value && r.value.online;
    if (!ok) { if (!n.local) anyFail = true; continue; }
    const list = (r.value && r.value.items) || [];
    const inst = n.local ? (() => { try { return mailbox.selfRole(); } catch { return ''; } })() : (n.role || '');
    for (const e of list) {
      if (!e || !AGG_EVENT_WHITELIST.has(e.type)) continue;
      const d = e.data || {};
      const sid = (d.sessionId != null) ? String(d.sessionId) : '';
      // 有归属→必须 ∈ 闭包；实例级(无 sessionId，如 evolution/schedule)→保留（数据只取自闭包内实例，无泄漏）
      if (sid && !closureSet.has(sid)) continue;
      const at = Number(e.at) || 0;
      const role = (d.role != null) ? String(d.role) : '';
      const key = `${inst}|${at}|${e.type}|${sid}|${role}|${_aggEventSig(e)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ type: e.type, data: d, at, inst });
    }
  }
  items.sort((a, b) => a.at - b.at);
  return { items: items.slice(-lim), online: true, partial: anyFail };
}

function broadcast(event, data) {
  // v6.53c：注入**服务端 at** 为事件时间戳（实时/历史/聚合三通路同源）→ 前端 `at|type` 去重键方可生效（治涟漪重复条）。
  const at = Date.now();
  const payloadData = (data && typeof data === 'object' && !Array.isArray(data)) ? Object.assign({}, data, { at }) : data;
  persistEvent(event, payloadData, at);   // v6.1.2：先落盘（持久化），再实时广播；失败静默
  const payload = `event: ${event}\ndata: ${JSON.stringify(payloadData)}\n\n`;
  for (const res of hub) {
    try { res.write(payload); } catch { hub.delete(res); }
  }
}
runtime.runtime.on('reflect', (d) => broadcast('reflect', d));
runtime.runtime.on('turn-done', (d) => broadcast('turn-done', d));
runtime.runtime.on('schedule', (d) => broadcast('schedule', d));
// 上下文压缩/自动归档事件：客户端据此重建聊天窗口，把已归档的旧气泡移出窗外
runtime.runtime.on('compacted', (d) => broadcast('compacted', d));
// v6.6：看门狗命中 / 工具进度 → 全局广播（内部信箱唤醒回合无 per-request evt，也能上屏）
runtime.runtime.on('turn-watchdog', (d) => broadcast('turn-watchdog', d));
runtime.runtime.on('turn-progress', (d) => broadcast('turn-progress', d));
// 任务B：模型服务可用性状态（每次 LLM 调用成功/失败）→ 全局广播，前端据此显示/隐藏常驻横幅
runtime.runtime.on('llm-status', (d) => broadcast('llm-status', d));
runtime.runtime.on('agent-busy', (d) => broadcast('agent-busy', d));
// P2b-2：信箱消费/回复事件（mailbox.js → _hooks.emit）→ 前端涟漪流"上屏点亮"。
//   纯 SSE 广播，**绝不触发唤醒**（不调 runChat/wakeMailbox）——防自激（M26）。
runtime.runtime.on('mailbox-consumed', (d) => broadcast('mailbox-consumed', d));
runtime.runtime.on('mailbox-replied', (d) => broadcast('mailbox-replied', d));
// v6.53-out：主我出站派活回响（mailbox._echoOutbound → _hooks.emit → 到此）→ 涟漪流/气泡（纯 SSE，不触发唤醒）
runtime.runtime.on('mailbox-message', (d) => broadcast('mailbox-message', d));
// 询问选项框（Ask Box）：主我调 ask_user → runtime.emit('ask-user') → SSE 广播（仅主实例有 UI）。
runtime.runtime.on('ask-user', (d) => broadcast('ask-user', d));
runtime.runtime.on('turn-stream', (d) => broadcast('turn-stream', d));   // 内部回合正文实时上屏：runtime 节流 emit → SSE 广播（前端写入 store.streams[sid]）
// 任务·会话列表刷新延迟：回合起始 touch 事件 → 广播 sessions-changed（前端已有处理器，列表即时刷新时间/条数）
runtime.runtime.on('session-activity', (d) => broadcast('sessions-changed', { id: d && d.sessionId, action: 'activity' }));

function sse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  // G1 长回合保活：SSE 注释行（客户端忽略，零协议变更）——每 15s 写一次，
  // 防任何空闲读超时（客户端 C# ReadWriteTimeout / mailbox httpPostJson 300s）在长工具/长回合期间误判断连。
  try {
    if (!res._sseHb) {
      res._sseHb = setInterval(() => { try { res.write(': ping\n\n'); } catch { } }, 15000);
      if (res._sseHb.unref) res._sseHb.unref();
      const _stopHb = () => { try { if (res._sseHb) { clearInterval(res._sseHb); res._sseHb = null; } } catch { } };
      res.on('close', _stopHb);
      res.on('finish', _stopHb);
    }
  } catch { }
}

function sseEvent(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* 客户端已断开 */ }
}

// —— 单会话串行发送队列（v3 连发安全：同会话消息按到达顺序执行，每条消息独立 SSE 流；
//    排队中不报"正在运行"，客户端连发体验 = 逐条消化；重启丢失排队（内存队列，回落为客户端重发）——
const chatQueues = new Map();   // sessionId → { items, pumping }
let chatMsgSeq = 0;             // 批A（A2）：user 消息稳定 id 计数（turn_id 幂等键用）
const sleepQ = (ms) => new Promise((r) => setTimeout(r, ms));

function pumpQueue(sessionId) {
  const q = chatQueues.get(sessionId);
  if (!q || q.pumping) return;
  q.pumping = true;
  (async () => {
    try {
      while (q.items.length > 0) {
        const item = q.items[0];
        if (item.state !== 'queued') { q.items.shift(); item.state = 'done'; try { item.resolveDone(); } catch { } continue; }
        item.state = 'running';
        let ran = false, attempt = 0;
        while (!ran && attempt < 600) {   // 等待系统任务（自治目标/心跳）让出会话，最长 ~10 分钟
          attempt++;
          try {
            await runtime.runChat(item.sessionId, item.message, { evt: item.evt, forceReflect: item.forceReflect, images: item.images, attachments: item.attachments, origin: 'user', userMsgId: item.msgId, internalMailbox: !!item.internalMailbox, engine: !!item.engine, mentionTargets: item.mentionTargets });   // P2：可见性统一走 sessionId turn-stream，不再需要 mirrorStream 分支
            ran = true;
          } catch (e) {
            if (String((e && e.message) || '').includes('正在运行') && attempt < 600) { await sleepQ(1000); continue; }
            item.errorRaised = true;
            try { item.evt.error && item.evt.error({ message: (e && e.message) || '运行失败' }); } catch { }
            break;
          }
        }
        q.items.shift();
        item.state = 'done';
        try { item.resolveDone(); } catch { }
      }
    } finally {
      q.pumping = false;
      if (q.items.length > 0) pumpQueue(sessionId);   // 竞争保险（close 移除后可能漏泵）
    }
  })();
}

// —— 停止（v6.22：停止按钮必须真正中止回合，不依赖"浏览器断开连接"这一间接链路）——
/** 彻底停止某会话的当前回合：
 *  ① abort 运行中的 controller（runChat 内部据此结束流/工具）；
 *  ② 清空该会话队列中所有 queued 项并 resolveDone（其 SSE 处理链随即发 stop 并 end，UI 立即可继续发新消息）；
 *  ③ 运行态收尾由 runChat 的 finally 完成（running=false / busy=null / 时间戳清零）。
 *  返回 { stopped: 是否中止了运行中回合, cleared: 清掉的排队条数 }。不误伤其他会话。 */
function stopSessionTurn(sessionId) {
  if (!sessionId) return { stopped: false, cleared: 0 };
  let stopped = false;
  try { stopped = !!runtime.stopRun(sessionId); } catch { }
  let cleared = 0, preserved = 0;   // v6.48（P1）：preserved=被保留的信箱唤醒排队项
  const q = chatQueues.get(sessionId);
  if (q) {
    // 注意：运行中的项此刻仍位于 q.items[0]（pumpQueue 跑完才 shift），**不得**移除它。
    // v6.48（P1）：只清**交互式**排队项；信箱唤醒项（x-leizai-wake:1 / internalMailbox）**保留**在队列，
    //   待当前回合中止后由 pumpQueue 继续执行 —— 治 P0 实测的"stop 清队列 → 唤醒静默丢失 → 回执没反应"。
    for (const it of q.items.slice()) {
      if (it.state !== 'queued') continue;
      if (it.wake || it.internalMailbox) { preserved++; continue; }
      const idx = q.items.indexOf(it);
      if (idx >= 0) q.items.splice(idx, 1);
      it.state = 'done';
      cleared++;
      try { it.resolveDone(); } catch { }
    }
  }
  console.log(`[停止] session=${sessionId} stopped=${stopped} queuedCleared=${cleared} wakePreserved=${preserved}`);
  return { stopped, cleared };
}

// —— 工具 ——
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// —— P0.2(C)：HTTP 端点统一 Pro 门禁通道（单一入口，不进 tools.js 前缀源）——
// 判定下沉闭源私模：gate.checkPro → pro/leizai-pro.exe 的 pro.check（独立进程 RPC，非本进程直调）；
// 异常/超时/私模缺失一律 deny（fail-safe-lite）。开发版（mode!=='enforce'）放行 → dev 回归不受影响。
async function gateAllow(cap, res, ctx) {
  let g;
  try { g = await require('./pro/gate').checkPro(cap, Object.assign({ source: 'http' }, ctx || {})); }
  catch (e) { g = { allow: false, tier: 'lite', reason: 'gate-unavailable(fail-safe-lite)', quota: null }; }
  if (!g || g.allow !== true) {
    sendJson(res, 403, { error: 'pro_required', cap, tier: (g && g.tier) || 'lite', reason: (g && g.reason) || 'gate-unavailable', quota: (g && g.quota) || null });
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) { const e = new Error('body 过大'); e.status = 400; reject(e); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { const e = new Error('JSON 解析失败'); e.status = 400; reject(e); }
    });
    req.on('error', reject);
  });
}

// —— 静态托管（新客户端 A1 · T-A1）——
// 仅服务 webui/dist 下的静态资源；不碰任何 /api/* 分支。
const WEBUI_DIST = path.join(ROOT, 'webui', 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

// —— 文件附件上传（v6.56）：raw octet-stream → DATA_DIR/uploads/<sid>/<uuid>__<safeName> ——
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const UPLOAD_MAX_FILE = 25 * 1024 * 1024;        // 单文件默认上限 25MB（图片/文档等）
const UPLOAD_MAX_FILE_BIG = 200 * 1024 * 1024;   // 视频/压缩包放宽到 200MB
const UPLOAD_MAX_SESSION = 1024 * 1024 * 1024;   // 每会话累计上限 1GB
const UPLOAD_EXT_BIG = new Set(['mp4','mov','avi','mkv','webm','flv','wmv','m4v','mpg','mpeg','zip','rar','7z','tar','gz','bz2','xz','tgz']);
const UPLOAD_MIME_BIG_RE = /^video\/|^application\/(zip|x-rar|7z-compressed|x-tar|gzip|x-gzip)$/;
function isBigUploadType(name, mime) {
  const ext = String(path.extname(String(name || ''))).replace(/^\./, '').toLowerCase();
  if (UPLOAD_EXT_BIG.has(ext)) return true;
  return UPLOAD_MIME_BIG_RE.test(String(mime || '').toLowerCase());
}
function uploadMaxBytes(name, mime) { return isBigUploadType(name, mime) ? UPLOAD_MAX_FILE_BIG : UPLOAD_MAX_FILE; }
function safeUploadName(n) {
  let s = String(n || '').split(/[\\/]/).pop() || 'file';                 // 只取 basename（防路径穿越）
  s = s.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '_').slice(0, 150);
  return s || 'file';
}
function uploadDirForSession(sid) {
  return path.join(UPLOADS_DIR, String(sid || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || '_');
}
function uploadDirSize(dir) {
  let total = 0;
  try { for (const f of fs.readdirSync(dir)) { try { total += fs.statSync(path.join(dir, f)).size; } catch { } } } catch { }
  return total;
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return sendJson(res, 400, { error: 'bad path' }); }
  if (rel === '/' || rel === '') rel = '/index.html';
  // 防路径穿越：resolve 后必须以静态根为前缀
  const target = path.resolve(WEBUI_DIST, '.' + rel);
  if (target !== WEBUI_DIST && !target.startsWith(WEBUI_DIST + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'not found' });   // 不回落 index.html
    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"';
    // 文本/代码类型 → no-cache（每次向服务器校验，改动后无需硬刷新）；其余静态资源保持可缓存。
    const isTextCode = ['.html', '.js', '.mjs', '.css', '.json', '.map'].includes(ext);
    // v6.52：媒体（视频/音频）→ no-cache + ETag（**严禁 no-store**：no-store 让浏览器一个字节不留 →
    //   每次开片头重下整段 = 加载期黑屏；no-cache 未换片走 304 用本地副本，秒开）。
    const isMedia = ['.mp4', '.webm', '.m4v', '.mov', '.mp3', '.wav', '.ogg'].includes(ext);
    const cacheControl = (isTextCode || isMedia) ? 'no-cache' : 'public, max-age=300';
    // 条件请求：ETag 未变 → 304（无 body，省流量）。
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'etag': etag, 'cache-control': 'no-cache' });
      return res.end();
    }
    // v6.52：Range → 206 Partial Content（视频拖动/分段；部分播放器只认 206）
    const range = req.headers['range'];
    if (range && /^bytes=/.test(String(range))) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m) {
        let start = m[1] === '' ? null : parseInt(m[1], 10);
        let end = m[2] === '' ? null : parseInt(m[2], 10);
        if (start === null && end !== null) { start = Math.max(0, st.size - end); end = st.size - 1; }
        if (start !== null && end === null) end = st.size - 1;
        if (start !== null && end !== null && start <= end && start < st.size) {
          end = Math.min(end, st.size - 1);
          res.writeHead(206, {
            'content-type': type,
            'content-length': end - start + 1,
            'content-range': 'bytes ' + start + '-' + end + '/' + st.size,
            'accept-ranges': 'bytes',
            'cache-control': cacheControl,
            'etag': etag,
            'last-modified': st.mtime.toUTCString(),
          });
          const rs = fs.createReadStream(target, { start: start, end: end });
          rs.on('error', () => { try { res.end(); } catch { } });
          rs.pipe(res);
          return;
        }
        res.writeHead(416, { 'content-range': 'bytes */' + st.size, 'cache-control': cacheControl });
        return res.end();
      }
    }
    const headers = { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes' };
    headers['cache-control'] = cacheControl;
    headers['etag'] = etag;
    headers['last-modified'] = st.mtime.toUTCString();
    res.writeHead(200, headers);
    const stream = fs.createReadStream(target);
    stream.on('error', () => { try { res.end(); } catch { } });
    stream.pipe(res);
  });
}

/** 历史末尾是否仍有未应答的 tool_calls（回合执行中：assistant 已下工具调用、结果尚未回填）。
 *  用于防止把 user 标记插进 assistant(tool_calls)→tool 之间，破坏 API 序列（DeepSeek 400）。 */
function hasPendingToolCalls(messages) {
  let pending = 0;
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'assistant') {
      const tcs = m.toolCalls || m.tool_calls || [];
      pending += tcs.length;
    } else if (m.role === 'tool') {
      if (pending > 0) pending -= 1;
    }
  }
  return pending > 0;
}

/** v6.x 修法B：忙时到达的入站标记入队（挂会话对象 s._pendingInbound），回合收尾时由
 *  runtime.flushPendingInbound 补写入 s.messages。幂等键：有 msgId 用 msgId，否则 from|ts|content。 */
/** v6.x 修法B：历史或延迟队列中是否已存在同一入站标记（幂等判据：有 msgId 用 msgId，否则 from+ts）。 */
function hasInboundMarker(s, msgId, from, ts) {
  try {
    const hit = (o) => o && (
      (msgId != null && o.msgId != null && String(o.msgId) === String(msgId)) ||
      (msgId == null && o.from === from && o.ts === ts)
    );
    if ((s.messages || []).some((m) => m && m._inbound && hit(m._inbound))) return true;
    if ((s._pendingInbound || []).some((x) => checkKey(x, msgId, from, ts))) return true;
    return false;
  } catch { return false; }
}
function checkKey(x, msgId, from, ts) {
  return !!x && ((msgId != null && x.msgId != null && String(x.msgId) === String(msgId)) || (msgId == null && x.from === from && x.ts === ts));
}

function queuePendingInbound(s, item) {
  try {
    if (!s._pendingInbound) s._pendingInbound = [];
    const key = item.msgId != null ? `id:${item.msgId}` : `k:${item.from}|${item.ts}|${item.content}`;
    if (s._pendingInbound.some((x) => x && x._key === key)) return false;
    s._pendingInbound.push({ ...item, _key: key });
    // D3-②：入队后立即落盘 —— 使 _pendingInbound 跨主引擎重启存活（否则忙时标记只在内存，重启即丢 → 前端气泡成孤儿）
    try { runtime.saveSession(s); } catch { }
    // v6.32（liveness）：入队即驱动——主动 schedule 一次排空/唤醒，不再只等"回合收尾"（防永久滞留）。
    try { runtime.schedulePendingDrain(s.id); } catch { }
    return true;
  } catch { return false; }
}

// —— 路由 ——
async function route(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  const p = (prefix) => pathname.startsWith(prefix);
  const is = (x) => pathname === x;

  if (is('/api/health')) {
    // 加法：补身份字段（不改 name 产品名语义）。agent 块缺失 → 字段给 null，不报错。
    let _role = null, _agentName = null;
    try { const _a = (loadConfig().agent) || {}; _role = _a.role || null; _agentName = _a.name || null; } catch { }
    // 防漂移自检（路线B）：src 与主基线的差异（异常安全，绝不阻断 health）
    let _drift = null;
    try { _drift = srcdrift.getDrift(loadConfig()); } catch (e) { _drift = { enabled: true, error: String((e && e.message) || e) }; }
    return sendJson(res, 200, { ok: true, name: '雷仔', role: _role, agentName: _agentName, srcDrift: _drift, ts: Date.now() });
  }
  if (is('/api/daemon')) return sendJson(res, 200, { daemon: DAEMON, running: true, pid: process.pid, status: 'active' });
  // —— Pro 激活链路（P-产品部署 步①，供客户端调；绝不 throw）——
  if (is('/api/pro/status')) {
    let st; try { st = require('./pro/activate').status(); } catch (e) { st = { activated: false, tier: 'lite', error: String((e && e.message) || e) }; }
    let gate; try { gate = require('./pro/gate').getState(); } catch { gate = PRO_STATE; }
    // 派生「有效档位」effective = gate 值（单一权威，供 UI 读；不改门禁逻辑/DEFAULTS）。
    const effective = {
      tier: (gate && gate.tier) || st.tier || 'lite',
      reason: (gate && gate.reason) || st.reason || '',
      enabled: !!(gate && gate.enabled),
    };
    // 阶段4：暴露 maxRoles/activeRoles 供前端显示「雷影：已用 X / 上限 Y」（-1=不限；null=未知）
    let activeRoles = 0; try { activeRoles = require('./pro/activate').countActiveRoles(); } catch { activeRoles = 0; }
    // 签名 token 无 maxRoles（Lite/未激活）→ 回退「权威配额」：与创建门禁（agents-admin）同源
    // = gate.check('multi-agent').quota.maxRoles（LITE_QUOTA，Lite=1）。仅取值/回退，不改门禁逻辑；
    // gate.check 同步、绝不 throw、不触发私模 RPC。null 语义=未知（前端不得显示为"不限"）。
    let maxRoles = (st && st.maxRoles !== undefined && st.maxRoles !== null && Number.isFinite(Number(st.maxRoles))) ? Number(st.maxRoles) : null;
    if (maxRoles === null) {
      try {
        const _g = require('./pro/gate');
        const _cp = (_g && typeof _g.check === 'function') ? _g.check('multi-agent') : null;
        const _qm = (_cp && _cp.quota) ? _cp.quota.maxRoles : null;
        if (_qm !== undefined && _qm !== null && Number.isFinite(Number(_qm))) maxRoles = Number(_qm);
      } catch { /* 保持 null（未知） */ }
    }
    // P6：暴露到期/试用信息供 UI（不改判据）
    const expVal = (st && st.exp !== undefined && st.exp !== null) ? Number(st.exp) : ((st && st.expiresAt !== undefined && st.expiresAt !== null) ? Number(st.expiresAt) : null);
    const expiresAt = expVal;
    const trial = !!(st && st.trial === true);
    return sendJson(res, 200, { ...st, maxRoles, activeRoles, expiresAt, exp: expVal, trial, gate, effective });
  }
  if (is('/api/pro/activate') && method === 'POST') {
    const body = await readBody(req);
    let r; try { r = await require('./pro/activate').activate(loadConfig(), body || {}); }
    catch (e) { r = { ok: false, error: 'activate_error:' + String((e && e.message) || e) }; }
    try { await require('./pro/gate').refreshAsync(loadConfig()); } catch { } // P0：激活后即时重判档位并【等待私模握手完成】——不 await 则响应先于握手，门禁恒 pending，须重启才恢复
    if (r && r.ok) { try { require('./pro/heartbeat').start(loadConfig()); } catch { } } // P1-5(c) 激活后启动心跳
    // P2：激活成功后即时执行配额核对 → 恢复因到期/降档被停用的雷影（幂等、失败不抛；dev/Lite 下 quota.enforce 内建 no-op）。
    // 触发点权威清单（避免散落）：引擎启动 server.js(enforce 'boot') / 心跳 pro/heartbeat.js(enforce 'heartbeat') / 此处(enforce 'activate')。
    if (r && r.ok) { try { Promise.resolve(require('./pro/quota').enforce('activate')).catch(() => { }); } catch { } }
    return sendJson(res, (r && r.status && !r.ok) ? r.status : 200, r);
  }
  // ⑨ 解绑本机（设置→设备/换机）：调 license-server `/deactivate` 释放本机名额 → 清本地 token（回 Lite）。
  // 幂等（无 token=已解绑）；失败不误清；错误码原样透传（如 deactivate_limit_reached）。供前端"解绑本机"调用。
  if (is('/api/pro/deactivate') && method === 'POST') {
    let r; try { r = await require('./pro/activate').deactivate(loadConfig()); }
    catch (e) { r = { ok: false, error: 'deactivate_error:' + String((e && e.message) || e) }; }
    if (r && r.ok) {
      try { await require('./pro/gate').refreshAsync(loadConfig()); } catch { }   // 解绑后即时重判档位（回 Lite）
      try { Promise.resolve(require('./pro/quota').enforce('deactivate')).catch(() => { }); } catch { }   // 停用超额雷影
    }
    return sendJson(res, (r && !r.ok && r.status) ? r.status : (r && r.ok ? 200 : 502), r);
  }
  // —— 数据目录（可选 / 明示 / 迁移）——
  if (method === 'GET' && is('/api/paths')) {
    try { return sendJson(res, 200, Object.assign({ ok: true }, require('./paths').info())); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  }
  if (method === 'POST' && is('/api/paths/open')) {
    const dir = require('./paths').root();
    try { require('node:child_process').spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref(); } catch { }
    return sendJson(res, 200, { ok: true, dir });
  }
  if (method === 'POST' && is('/api/paths/set')) {
    const body = await readBody(req);
    let r; try { r = require('./paths').setDataDir(body && body.dir, !!(body && body.migrate)); }
    catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    return sendJson(res, r && r.ok ? 200 : 400, r);
  }
  if (method === 'POST' && is('/api/paths/reset')) {
    try { require('./paths').clearOverride(); } catch { }
    return sendJson(res, 200, { ok: true, needRestart: true });
  }
  if (is('/api/shutdown') && method === 'POST') {
    // 优雅关闭（客户端"停止后台"用）
    try { sendJson(res, 200, { ok: true, msg: '正在关闭后台服务' }); } catch { }
    setTimeout(() => process.exit(0), 60);
    return;
  }
  if (is('/api/events')) { sse(res); hub.add(res); req.on('close', () => hub.delete(res)); return; }

  // v6.1.2：涟漪事件历史（持久化，倒序，客户端启动时加载 → 重开不清零）
  if (method === 'GET' && is('/api/events/history')) {
    const ring = loadEventsRing();
    const lim = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 1), 1000);
    const items = ring.slice(-lim).reverse();
    return sendJson(res, 200, { ok: true, count: ring.length, items });
  }

  // 涟漪流聚合：主会话 + 关联(递归闭包)雷影会话的事件（跨会话边界/生命周期类，去高频内部事件）
  if (method === 'GET' && is('/api/events/aggregate')) {
    const _s = url.searchParams.get('sessionId') || '';
    if (!_s) return sendJson(res, 400, { error: '缺少 sessionId' });
    const _lm = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
    const _k = _s + '|' + _lm;
    const _refresh = url.searchParams.get('refresh') === '1';
    const _hit = _aggEventsCache.get(_k);
    if (!_refresh && _hit && (Date.now() - _hit.at) < AGG_CACHE_MS) return sendJson(res, 200, Object.assign({ cached: true }, _hit.data));
    try {
      const _data = await aggregateEvents(_s, _lm);
      _aggEventsCache.set(_k, { at: Date.now(), data: _data });
      if (_aggEventsCache.size > 64) { const _k0 = _aggEventsCache.keys().next().value; _aggEventsCache.delete(_k0); }
      return sendJson(res, 200, _data);
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  // 配置
  // 归档容量使用量（供前端显示"当前最大会话占用 XX MB"）
  if (method === 'GET' && p('/api/archive/usage')) {
    try { return sendJson(res, 200, archiveStore.maxSessionFlowMB()); }
    catch (e) { return sendJson(res, 200, { maxMB: 0, top: [], error: e.message }); }
  }
  if (method === 'GET' && p('/api/config')) {
    const cfg = loadConfig();
    const _mask = (k) => (k ? String(k).slice(0, 6) + '********' : '');
    const _safeKeys = {};
    if (cfg.apiKeys && typeof cfg.apiKeys === 'object') {
      for (const [kk, vv] of Object.entries(cfg.apiKeys)) _safeKeys[kk] = _mask(vv);
    }
    return sendJson(res, 200, { ...cfg, apiKey: _mask(cfg.apiKey), apiKeys: _safeKeys });
  }
  if (method === 'PUT' && p('/api/config')) {
    const body = await readBody(req);
    // 类型校验：坏配置会让整个服务静默失效，这里直接拒绝并给出原因
    const asBool = (k) => (body[k] === undefined || typeof body[k] === 'boolean');
    const asStr = (k) => (body[k] === undefined || typeof body[k] === 'string');
    const bad = [];
    if (!asBool('fullAccess')) bad.push('fullAccess 必须是 true/false');
    if (!asBool('evolutionAutoApply')) bad.push('evolutionAutoApply 必须是 true/false');
    if (!asBool('reflectionEnabled')) bad.push('reflectionEnabled 必须是 true/false');
    if (!asBool('reflectionAuto')) bad.push('reflectionAuto 必须是 true/false');
    if (!asBool('immutableGenome')) bad.push('immutableGenome 必须是 true/false');
    if (!asBool('roleDispatchEnabled')) bad.push('roleDispatchEnabled 必须是 true/false');
    if (!asBool('daemonMode')) bad.push('daemonMode 必须是 true/false');
    if (body.temperature !== undefined && (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 2)) bad.push('temperature 必须是 0~2 的数字');
    if (body.port !== undefined && (typeof body.port !== 'number' || body.port < 1 || body.port > 65535)) bad.push('port 必须是 1~65535 的数字');
    if (body.reasoningEffort !== undefined && !['off', 'low', 'medium', 'high', 'max'].includes(body.reasoningEffort)) bad.push('reasoningEffort 必须是 off/low/medium/high/max 之一');
    if (body.thinkingFormat !== undefined && !['deepseek', 'none', 'anthropic'].includes(body.thinkingFormat)) bad.push('thinkingFormat 必须是 deepseek/none/anthropic 之一');
    for (const k of ['model', 'baseURL', 'workdir', 'pythonPath', 'provider', 'evolutionGate']) if (!asStr(k)) bad.push(`${k} 必须是字符串`);
    for (const k of ['allowedPaths', 'protectedPaths', 'protectedCommands']) {
      if (body[k] !== undefined && !Array.isArray(body[k])) bad.push(`${k} 必须是字符串数组`);
      else if (Array.isArray(body[k]) && body[k].some((x) => typeof x !== 'string')) bad.push(`${k} 的每一项必须是字符串`);
    }
    if (body.mcpServers !== undefined) {
      if (!Array.isArray(body.mcpServers)) bad.push('mcpServers 必须是数组');
      else if (body.mcpServers.some((s) => !s || !s.name || !s.command)) bad.push('mcpServers 每项需含 name 与 command');
    }
    // 预算/上限类字段：类型与取值范围校验，否则会静默写坏导致超窗/失效
    for (const k of ['maxTokens', 'goalMaxRounds', 'subAgentMaxTurns', 'iterationCap', 'commandTimeoutMs', 'commandOutputCap', 'replTimeoutMs', 'skillTimeoutMs', 'webFetchMaxBytes']) {
      if (body[k] !== undefined && (!Number.isInteger(body[k]) || body[k] < 1)) bad.push(`${k} 必须是 ≥1 的整数`);
    }
    // 全局 contextBudget：后端硬 clamp [1000, 900000]（防绕过前端直调 API）；>上限→900000，<1000→1000，四舍五入；非法/空→不写。
    if (body.contextBudget !== undefined) {
      if (typeof body.contextBudget === 'number' && isFinite(body.contextBudget)) {
        body.contextBudget = Math.min(CONTEXT_BUDGET_MAX, Math.max(1000, Math.round(body.contextBudget)));
      } else if (body.contextBudget === null || body.contextBudget === '') {
        delete body.contextBudget;   // 非法/空 → 不写（保留原值）
      } else {
        bad.push('contextBudget 必须是数字');
      }
    }
    if (body.archiveMaxEntries !== undefined && (!Number.isInteger(body.archiveMaxEntries) || body.archiveMaxEntries < 0)) bad.push('archiveMaxEntries 必须是 ≥0 的整数（0=不限条数）');
    if (body.archiveMaxSizeMB !== undefined && (!Number.isInteger(body.archiveMaxSizeMB) || body.archiveMaxSizeMB < 0)) bad.push('archiveMaxSizeMB 必须是 ≥0 的整数（0=不限制）');
    for (const k of ['accountBalance', 'usdRate']) {
      if (body[k] !== undefined && (typeof body[k] !== 'number' || body[k] < 0)) bad.push(`${k} 必须是非负数字`);
    }
    if (bad.length) return sendJson(res, 400, { error: bad.join('；') });
    // —— 归档上限"防误删"护栏：设置页调小 archiveMaxSizeMB 会实时生效，若小于当前某会话占用将立即删数据 ——
    //    除非显式带 confirmArchivePrune=true（确认标记，绝不写入 config），否则先返回 409 让前端二次确认。
    if (body.archiveMaxSizeMB !== undefined && Number.isInteger(body.archiveMaxSizeMB) && body.archiveMaxSizeMB > 0
      && body.confirmArchivePrune !== true) {
      let maxMB = 0, top = [];
      try { const u = archiveStore.maxSessionFlowMB(); maxMB = u.maxMB; top = u.top; } catch { }
      if (body.archiveMaxSizeMB < maxMB) {
        return sendJson(res, 409, { error: '该上限会立即清理超出部分数据', needConfirm: true, maxSessionMB: maxMB, affected: top });
      }
    }
    // confirmArchivePrune 是前端确认标记，只用于放行护栏，**绝不写入 config.json**
    if (body.confirmArchivePrune !== undefined) delete body.confirmArchivePrune;
    const cur = loadConfig();
    const next = { ...cur, ...body };
    // —— 身份字段变更审计（不阻断）：agent.{name,role,domain,isMain} 进 prompt.js identityOverlay→稳定前缀 ——
    try {
      const _sig = (o) => { const a = (o && o.agent) || {}; return [a.name || '', a.role || '', a.domain || '', !!a.isMain].join('|'); };
      if (_sig(cur) !== _sig(next)) console.log(`[config] agent 身份字段变更：${_sig(cur)} → ${_sig(next)}（来自 ${(req.socket && req.socket.remoteAddress) || '?'}）`);
    } catch { /* 审计失败不阻断写入 */ }
    // —— 多 provider 分存 key（自由切换不覆盖）——
    // 关键：next = {...cur,...body} 时 body.apiKeys 会整体覆盖 cur.apiKeys（丢弃其它 provider）。
    // 因此以「原配置 cur.apiKeys 为底」开始合并，再并入本次提交的 key，保证其它 provider 不丢。
    next.apiKeys = { ...(cur.apiKeys || {}) };
    // 1) 前端提交 apiKeys 字典（含当前 provider 的 key）：并入，保留其它 provider
    if (body.apiKeys && typeof body.apiKeys === 'object' && !Array.isArray(body.apiKeys)) {
      for (const [prov, k] of Object.entries(body.apiKeys)) {
        if (typeof k !== 'string' || !k.trim()) continue;
        // ★防"掩码回写"（2026-09-24 事故）：GET /api/config 返回的是掩码（sk-xxx********），
        //   前端整体回存会把掩码当真 key 写入 → 401。与下方 keepMask 同判据：含 '*' 或过短 → 视为掩码，跳过不写。
        if (k.includes('*') || k.trim().length < 10) continue;
        next.apiKeys[prov] = k.trim();
      }
    }
    // 2) 兼容旧逻辑：仅当本次请求真的提交了单一 apiKey 字段（body.apiKey 非空/非掩码/非继承自旧配置）才写入当前 provider 名下。
    //    注意必须判断 body.apiKey（用户本次新填）而非 next.apiKey（可能从旧配置继承，会误当成新填覆盖其它 provider）。
    const keepMask = body.apiKey && (String(body.apiKey).includes('*') || String(body.apiKey).length < 10);
    if (body.apiKey && !keepMask && String(body.apiKey).trim()) {
      next.apiKeys[next.provider || 'deepseek'] = String(body.apiKey).trim();
    }
    // 3) 主 key 字段回退为当前 provider 的 key（若 apiKeys 里有），保证旧代码读 apiKey 也能取到当前 provider 的 key
    if (next.provider && next.apiKeys && next.apiKeys[next.provider]) {
      next.apiKey = next.apiKeys[next.provider];
    }
    try { saveConfig(next); }
    catch (e) {
      // 配置写入防呆：mojibake/非 UTF-8 → config.js save() 抛错，这里转 400（不写盘）
      if (e && e.rejected) return sendJson(res, 400, { error: String(e.message || e), rejected: true });
      throw e;
    }
    if (typeof next.port === 'number' && next.port !== cur.port) {
      // 提示重启
      return sendJson(res, 200, { ...next, apiKey: next.apiKey.slice(0, 6) + '********', restartRequired: true });
    }
    return sendJson(res, 200, { ...next, apiKey: next.apiKey.slice(0, 6) + '********' });
  }

  // 模型提供方列表（供设置界面切换 provider、展示各提供方默认模型目录）
  if (method === 'GET' && is('/api/providers')) {
    const providers = require('./providers');
    const list = providers.SUPPORTED.map((k) => {
      const p = providers.PROFILE[k];
      return { key: k, label: p.label, baseURL: p.baseURL, models: p.defaultModels, thinkingFormat: p.thinkingFormat };
    });
    return sendJson(res, 200, list);
  }

  // 会话
  if (method === 'GET' && is('/api/sessions')) {
    // 免费能力（按既定门禁规格）：本会话列表基础可用 → 不设门禁。
    // 「跨会话/跨实例翻旧账 / 全文检索 / 顺藤摸瓜」才 Pro → 落点在 project(tool) 的 search/overview/trace 等入口。
    let list = runtime.listSessions();
    const pj = url.searchParams.get('project');
    if (pj) list = list.filter((s) => s.project === pj);
    // 参与者字段（会话列表多头像）：仅 mailbox 可用时附带，异常则省略（前端回退）
    if (mailbox.available()) {
      try {
        const byMain = mailbox.sessionParticipants();   // v6.x（2026-10-02）：agents 改由持久历史聚合（agent_messages ∪ archive），一次查询、避免 N+1；只读、绝不动 session_links
        if (byMain) list = list.map((s) => {
          const set = byMain.get(String(s.id));
          const agents = ['main'].concat(set ? [...set].sort() : []);
          return { ...s, agents };
        });
      } catch { /* 组装失败：省略 agents，不阻塞列表 */ }
    }
    return sendJson(res, 200, list);
  }
  if (method === 'POST' && is('/api/sessions')) {
    const body = await readBody(req);
    const s = runtime.createSession();
    if (body && body.title) { s.title = String(body.title).slice(0, 40); runtime.saveSession(s); }
    if (body && typeof body.project === 'string') { s.project = String(body.project).slice(0, 40); runtime.saveSession(s); }
    // 项目文件总库：标题/项目设定后，登记名册并让目录名跟项目名走（失败静默，不影响创建）
    try { runtime.syncProjectFiles(s.id); } catch { }
    if (body && typeof body.workdir === 'string') { s.workdir = String(body.workdir).trim() || null; runtime.saveSession(s); }
    // 会话变更广播：外部（API/其他客户端）新建会话时通知已打开界面刷新列表
    broadcast('sessions-changed', { id: s.id, action: 'create' });
    return sendJson(res, 200, { id: s.id, title: s.title, project: s.project || '', workdir: s.workdir || null });
  }
  const mSession = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (mSession && method === 'GET') {
    let s;
    try { s = runtime.getSession(mSession[1]); } catch (e) { return sendJson(res, 404, { error: e.message }); }
    // 接口瘦身：用户消息里的 base64 图片只在 LLM 往返中存在意义，客户端历史回放只显示 [图片] 占位。
    // 剥离 image_url 段可让节点万级的会话 JSON 缩小几十倍 —— 切换会话不再传输/解析 MB 级 payload。
    return sendJson(res, 200, { id: s.id, title: s.title, project: s.project || '', workdir: s.workdir || null, contextBudget: s.contextBudget || null, model: s.model || null, reasoningEffort: s.reasoningEffort || null, lastCompact: s.lastCompact || null, archiveCount: memory.archiveCount(s.id), messages: stripImageParts(s.messages), stats: runtime.sessionStats(s) });
  }
  if (mSession && method === 'DELETE') {
    runtime.deleteSession(mSession[1]);
    broadcast('sessions-changed', { id: mSession[1], action: 'delete' });
    return sendJson(res, 200, { ok: true });
  }
  // 回收站：软删除到回收站 / 恢复（*彻底*删除仍用上面的 DELETE）
  const mTrash = pathname.match(/^\/api\/sessions\/([^/]+)\/(trash|restore)$/);
  if (mTrash && method === 'POST') {
    try {
      const r = mTrash[2] === 'trash' ? runtime.trashSession(mTrash[1]) : runtime.restoreSession(mTrash[1]);
      broadcast('sessions-changed', { id: mTrash[1], action: mTrash[2] });
      return sendJson(res, 200, r);
    } catch (e) { return sendJson(res, 404, { error: e.message }); }
  }
  if (mSession && method === 'PUT') {
    let body = {};
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    // 会话级 模型/推理等级 覆盖校验（2026-09-22）：非法值 → 400（不落库、不影响其它会话）
    if (body && 'reasoningEffort' in body && body.reasoningEffort !== null && body.reasoningEffort !== undefined
        && body.reasoningEffort !== '' && body.reasoningEffort !== 'default') {
      const _re = body.reasoningEffort;
      if (typeof _re !== 'string' || !['off', 'low', 'medium', 'high', 'max'].includes(_re.trim())) {
        return sendJson(res, 400, { error: 'reasoningEffort 非法（应为 off|low|medium|high|max 或 null）' });
      }
    }
    if (body && 'model' in body && body.model !== null && body.model !== undefined && typeof body.model !== 'string') {
      return sendJson(res, 400, { error: 'model 必须为字符串或 null' });
    }
    try {
      const r = runtime.patchSession(mSession[1], body);   // 内部已同步名册 + 物理目录 rename + 账本标题
      broadcast('sessions-changed', { id: mSession[1], action: 'patch' });
      return sendJson(res, 200, r);
    } catch (e) { return sendJson(res, 404, { error: e.message }); }
  }
  // 本会话关联雷影（只读）：显示"本会话用过的雷影"及其 busy(在办)/unread(新回执) 状态。
  // 信箱未初始化 → 返回空数组（不 500）；不存在/无关联会话 → 同样返回空数组（择一：不 404）。
  const mLinks = pathname.match(/^\/api\/sessions\/([^/]+)\/links$/);
  if (mLinks && method === 'GET') {
    if (!mailbox.available()) return sendJson(res, 200, { links: [] });
    try { return sendJson(res, 200, { links: mailbox.linksWithStatus(mLinks[1]) }); }
    catch (e) { return sendJson(res, 200, { links: [] }); }
  }
  // 会话的"静默归档"（上下文变长时被压缩移出的旧回合）：查看 + 一键清空
  // GET 支持分页：?offset=&limit=（归档浏览翻页；条目内容始终完整返回）
  const mArchive = pathname.match(/^\/api\/sessions\/([^/]+)\/archive$/);
  if (mArchive && method === 'GET') {
    if (!runtime.sessionExists(mArchive[1])) return sendJson(res, 404, { error: `会话不存在: ${mArchive[1]}` });
    const qoff = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    const qlim = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), 500);   // 单页 1..500 条
    const count = memory.archiveCount(mArchive[1]);
    const entries = memory.archiveRead(mArchive[1], qlim, qoff);
    return sendJson(res, 200, { sessionId: mArchive[1], count, offset: qoff, limit: qlim, hasMore: qoff + entries.length < count, entries });
  }
  if (mArchive && (method === 'DELETE' || method === 'POST')) {
    if (!runtime.sessionExists(mArchive[1])) return sendJson(res, 404, { error: `会话不存在: ${mArchive[1]}` });
    const n = memory.archiveClear(mArchive[1]);
    return sendJson(res, 200, { ok: true, cleared: n });
  }

  // 对话（SSE 流）——v3 后端串行队列：同会话连发不报错，按到达顺序排队执行；本条完成的信号经 item.done 保持连接
  if (method === 'POST' && is('/api/chat')) {
    const body = await readBody(req);
    const { sessionId, message, forceReflect, images, attachments } = body;
    // @ 会话（2026-10-02）：结构化目标会话 id 列表（不做文本解析）
    const mentionSessionIds = Array.isArray(body.mentionSessionIds) ? body.mentionSessionIds.map(String).filter(Boolean) : [];   // v6.56：attachments=[{name,path,size,mime}]
    if (!sessionId || !message) return sendJson(res, 400, { error: '需要 sessionId 和 message' });
    sse(res);
    let reasonBuf = '';
    let burnChars = 0, burnToks = 0;
    const evt = {
      queued: (d) => sseEvent(res, 'queued', d),
      start: (d) => sseEvent(res, 'start', d),
      reasoning: (d) => {
        burnChars = d.chars || burnChars; burnToks = d.tokens || burnToks;
        reasonBuf += d.text;
        if (reasonBuf.length > 80) { sseEvent(res, 'reasoning', { text: reasonBuf, chars: burnChars, tokens: burnToks }); reasonBuf = ''; }
      },
      delta: (d) => sseEvent(res, 'delta', d),
      reset: (d) => sseEvent(res, 'reset', d),   // 重复输出护栏：通知客户端清空当前气泡（重试前）
      tool: (d) => sseEvent(res, 'tool', d),
      tool_result: (d) => sseEvent(res, 'tool_result', d),
      compacted: (d) => sseEvent(res, 'compacted', d),
      // v6.6 卡死根治：看门狗命中 / 工具进度（新增 SSE 事件，不改既有协议）
      watchdog: (d) => sseEvent(res, 'turn-watchdog', d),
      progress: (d) => sseEvent(res, 'turn-progress', d),
      done: (d) => sseEvent(res, 'done', d),
      error: (d) => sseEvent(res, 'error', d),   // v5.7.2：透传运行错误，避免错误被静默吞掉
      mentionUnfulfilled: (d) => sseEvent(res, 'mention-unfulfilled', d),   // @会话 v2：@了目标但本回合未调用 send_to_session
    };
    // @ 会话（2026-10-02 / v2 2026-10-02 语义升级）：不再原样转发；改为把目标列表随 item 传入 runChat，
    //   由雷仔理解用户意图后调用 send_to_session 组织发送（见 runtime.runChat opts.mentionTargets）。
    // —— 入队（同会话串行；已有消息在处理/排队时先报位置，避免"正在运行中"报错打断连发） ——
    let q = chatQueues.get(sessionId);
    if (!q) { q = { items: [], pumping: false }; chatQueues.set(sessionId, q); }
    if (q.items.length > 0 || q.pumping) {
      try { sseEvent(res, 'queued', { position: q.items.length + 1 }); } catch { }
    }
    // refs=sys-marker（2026-10-10 返工）：x-leizai-wake 唯一来源=mailbox.deliver() 唤醒投递（mailbox.js:2276）
    //   ⇒ 本条 /api/chat 必为"引擎自动注入"；真实用户消息（UI/客户端）不带此头 → 单处判定，绝不误标用户消息。
    const _wakeInjected = req.headers['x-leizai-wake'] === '1';
    const item = {
      sessionId, message, forceReflect: !!forceReflect, images, attachments,
      evt, state: 'queued', errorRaised: false, resolveDone: null,
      mentionTargets: Array.isArray(mentionSessionIds) ? mentionSessionIds.slice() : [],   // @会话 v2：传 runChat 做注入（不原样转发）
      // v6.48（P1）：信箱唤醒项标志——stop/reaper 清队列时**不清**它，待当前回合中止后由 pumpQueue 继续执行。
      wake: _wakeInjected,
      // refs=sys-marker（2026-10-10 返工）：唤醒注入的 /api/chat 判为"引擎自动注入"→ 透传 runChat(engine) → 本轮 user 带 engine:true（前端「系统」）；真实用户消息/UI 无此头 → engine=false
      engine: _wakeInjected,
      msgId: `u-${Date.now().toString(36)}-${(++chatMsgSeq).toString(36)}`,   // 批A（A2）：稳定 user 消息 id（同条消息重试不变 → turn_id 幂等）
    };
    item.done = new Promise((resolve) => { item.resolveDone = resolve; });
    q.items.push(item);
    req.on('close', () => {
      if (req._finished) return;
      if (item.state === 'queued') {
        // 排队中客户端断开：只移除本条，不影响正在处理的其他消息
        const idx = q.items.indexOf(item);
        if (idx >= 0) q.items.splice(idx, 1);
        item.state = 'done';
        try { item.resolveDone(); } catch { }
        return;
      }
      if (item.state === 'running') {
        // G2 断连不误杀回合：信箱唤醒请求（x-leizai-wake:1）的发起方在长回合期间超时断开，
        // 不得据此 abort 本轮——让回合跑完，结果照常落库/经信箱回执。仅对交互式（用户客户端）断连保持原停止语义。
        if (req.headers['x-leizai-wake'] === '1') return;
        try { runtime.stopRun(sessionId); } catch { }
      }
    });
    pumpQueue(sessionId);
    await item.done;   // 连接保持到本条完成/出错/断开
    if (reasonBuf) sseEvent(res, 'reasoning', { text: reasonBuf, chars: burnChars, tokens: burnToks });
    if (!item.errorRaised) sseEvent(res, 'stop', {});
    req._finished = true;
    try { if (!res.writableEnded) res.end(); } catch { }
    return;
  }

  // 停止（v6.22：彻底停 —— 中止运行回合 + 清空该会话排队项）
  // —— 文件附件上传（v6.56）：body=raw application/octet-stream；headers x-file-name(URI 编码)/x-session-id ——
  if (method === 'POST' && is('/api/upload')) {
    const sid = String(req.headers['x-session-id'] || '').trim();
    if (!sid) return sendJson(res, 400, { ok: false, error: '缺少 x-session-id' });
    let rawName = String(req.headers['x-file-name'] || '');
    try { rawName = decodeURIComponent(rawName); } catch { }
    let mimeHint = String(req.headers['x-file-mime'] || '');
    try { mimeHint = decodeURIComponent(mimeHint); } catch { }
    const dir = uploadDirForSession(sid);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { }
    if (uploadDirSize(dir) >= UPLOAD_MAX_SESSION) return sendJson(res, 413, { ok: false, error: '本会话附件累计已达 1GB 上限' });
    const safeName = safeUploadName(rawName);
    const maxFile = uploadMaxBytes(safeName, mimeHint);   // v6.57：视频/压缩包 200MB，其它 25MB
    const crypto = require('node:crypto');
    const id = (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)));
    const dest = path.join(dir, id + '__' + safeName);
    let size = 0, settled = false, finishing = false;
    const ws = fs.createWriteStream(dest);
    const fail = (code, msg) => {
      if (settled) return; settled = true;
      try { ws.destroy(); } catch { }
      try { fs.unlinkSync(dest); } catch { }
      try { sendJson(res, code, { ok: false, error: msg }); } catch { }
    };
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > maxFile) {   // 流式超限即断：先回 413，待响应刷出后再断开入站流（防客户端收到 RST）
        settled = true;
        try { ws.destroy(); } catch { }
        try { fs.unlinkSync(dest); } catch { }
        try { sendJson(res, 413, { ok: false, error: (maxFile === UPLOAD_MAX_FILE_BIG ? '视频/压缩包单文件超过 200MB 上限' : '单文件超过 25MB 上限') }); } catch { }
        try { res.once('finish', () => { setTimeout(() => { try { req.destroy(); } catch { } }, 20); }); } catch { }
        return;
      }
      if (!ws.write(c)) { try { req.pause(); } catch { } }
    });
    ws.on('drain', () => { try { req.resume(); } catch { } });
    ws.on('error', () => fail(500, '写入失败'));
    req.on('end', () => {
      if (settled) return;
      if (size === 0) return fail(400, '空文件');
      finishing = true;   // 已进入正常收尾：后续 close 事件不得再当中途断开清理
      ws.end(() => {
        if (settled) return; settled = true;
        const mime = MIME[path.extname(safeName).toLowerCase()] || mimeHint || 'application/octet-stream';
        sendJson(res, 200, { ok: true, id, name: safeName, path: dest, size, mime });
      });
    });
    req.on('close', () => { try { if (!settled && !finishing) { settled = true; ws.destroy(); try { fs.unlinkSync(dest); } catch { } } } catch { } });   // 客户端中途断开 → 清理半成品
    return;
  }
  if (method === 'POST' && is('/api/stop')) {
    const body = await readBody(req);
    const r = stopSessionTurn(body.sessionId);
    return sendJson(res, 200, { stopped: r.stopped, cleared: r.cleared });
  }

  // 统计
  if (method === 'GET' && is('/api/stats')) {
    return sendJson(res, 200, runtime.globalStatsView());
  }

  // 成本审计：今日 0 点起 · 全家四实例合计（透传 workspace/tools/token_audit.py --json）
  // 只读日志聚合，60s 内存缓存；?refresh=1 强制刷新。失败 → { ok:false, error }（HTTP 200，前端据此回落）。
  if (method === 'GET' && is('/api/cost/today')) {
    const refresh = url.searchParams.get('refresh') === '1';
    const CACHE_MS = 60 * 1000;
    if (!refresh && _todayCostCache.data && (Date.now() - _todayCostCache.at) < CACHE_MS) {
      return sendJson(res, 200, _todayCostCache.data);
    }
    const { execFile } = require('node:child_process');
    const auditScript = path.join(ROOT, 'workspace', 'tools', 'token_audit.py');
    const out = await new Promise((resolve) => {
      try {
        execFile('python', [auditScript, '--json'],
          { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err) return resolve({ ok: false, error: String((err && err.message) || err || stderr || '审计脚本执行失败') });
            try {
              const j = JSON.parse(String(stdout || '').trim());
              resolve(Object.assign({ ok: true }, j));
            } catch (e) { resolve({ ok: false, error: '审计输出解析失败: ' + e.message }); }
          });
      } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); }
    });
    if (out.ok) _todayCostCache = { at: Date.now(), data: out };
    return sendJson(res, 200, out);
  }

  // 任务B：模型服务探活（GET /models，成本≈0，带 30s 内存缓存防轮询打爆）
  // 返回 { ok, reason, reasonText, latencyMs, retryable, cached, at }；探活失败不抛，HTTP 200 返回。
  if (method === 'GET' && is('/api/llm-health')) {
    const refresh = url.searchParams.get('refresh') === '1';
    const CACHE_MS = 30 * 1000;
    if (!refresh && _llmHealthCache.data && (Date.now() - _llmHealthCache.at) < CACHE_MS) {
      return sendJson(res, 200, Object.assign({ cached: true }, _llmHealthCache.data));
    }
    let r;
    try { r = await deepseek.probe(8000); } catch (e) { r = { ok: false, reason: 'unknown', reasonText: String((e && e.message) || e), latencyMs: 0, retryable: true }; }
    _llmHealthCache = { at: Date.now(), data: r };
    return sendJson(res, 200, Object.assign({ cached: false, at: _llmHealthCache.at }, r));
  }

  // 单会话轻量统计（右侧实时面板"当前对话"用；不返回消息体，避免轮询拉全量 JSON）
  const mSessStats = pathname.match(/^\/api\/sessions\/([^/]+)\/stats$/);
  if (mSessStats && method === 'GET') {
    const _sid = decodeURIComponent(mSessStats[1]);
    if (url.searchParams.get('aggregate') === '1') {
      const refresh = url.searchParams.get('refresh') === '1';
      const cached = _aggStatsCache.get(_sid);
      if (!refresh && cached && (Date.now() - cached.at) < AGG_CACHE_MS) {
        return sendJson(res, 200, Object.assign({ cached: true }, cached.data));
      }
      try {
        const data = await aggregateSessionStats(_sid);
        _aggStatsCache.set(_sid, { at: Date.now(), data });
        if (_aggStatsCache.size > 64) { const k0 = _aggStatsCache.keys().next().value; _aggStatsCache.delete(k0); }
        return sendJson(res, 200, data);
      } catch (e) { return sendJson(res, 500, { aggregate: true, error: e.message }); }
    }
    try {
      const s = runtime.getSession(_sid);
      return sendJson(res, 200, runtime.sessionStats(s));
    } catch (e) { return sendJson(res, 404, { error: e.message }); }
  }

  // B（2026-09-25）：会话树数据 API（前端泳道图数据源）。复用 branch.sessionTree（→fold），勿重写读取逻辑。
  const mSessTree = pathname.match(/^\/api\/sessions\/([^/]+)\/tree$/);
  if (mSessTree && method === 'GET') {
    try {
      const sid = decodeURIComponent(mSessTree[1]);
      const keepTurns = Math.max(20, Math.min(2000, parseInt(url.searchParams.get('keepTurns') || '200', 10) || 200));
      return sendJson(res, 200, branch.sessionTree(sid, keepTurns));
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  // 主动提前交接：不等预算满，立即归档重建窗口（急做击穿前缀操作前用，把缓存重建成本降到最低）
  const mHandoff = pathname.match(/^\/api\/sessions\/([^/]+)\/handoff$/);
  if (mHandoff && method === 'POST') {
    try {
      const body = await readBody(req);
      const s = runtime.getSession(mHandoff[1]);
      // T-A6（O-2）：refine 缺省沿用 config.handoffManualRefine（默认 false）→ false 行为同现状
      const refine = (body && body.refine !== undefined) ? !!body.refine : !!loadConfig().handoffManualRefine;
      const r = await runtime.forceHandoff(s, { refine });
      return sendJson(res, 200, { dropped: r.dropped, gen: r.gen, kept: r.kept, refine });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  // 账户余额（DeepSeek /user/balance，60s 缓存，避免高频打 API）
  if (method === 'GET' && is('/api/balance')) {
    const CACHE_MS = 60 * 1000;
    if (_balanceCache.data && (Date.now() - _balanceCache.at) < CACHE_MS) {
      return sendJson(res, 200, _balanceCache.data);
    }
    // 余额查询仅 DeepSeek（或指向 DeepSeek 的兼容网关）支持；其它提供方无该端点，直接返回不可用
    const cfgBal = loadConfig();
    const provBal = String(cfgBal.provider || 'deepseek');
    const baseBal = String(cfgBal.baseURL || '').toLowerCase();
    if (provBal !== 'deepseek' && !baseBal.includes('deepseek.com')) {
      return sendJson(res, 200, { isAvailable: false, error: '\u4F59\u989D\u4EC5 DeepSeek \u63D0\u4F9B\u65B9\u652F\u6301' });
    }
    try {
      const j = await deepseek.fetchBalance();
      const infos = (j && j.balance_infos) || [];
      const cny = infos.find((x) => x.currency === 'CNY');
      const usd = infos.find((x) => x.currency === 'USD');
      const pick = cny || usd;
      const data = {
        isAvailable: j ? !!j.is_available : false,
        currency: pick ? pick.currency : null,
        balance: pick ? parseFloat(pick.total_balance) : null,
        granted: pick ? parseFloat(pick.granted_balance) : null,
        toppedUp: pick ? parseFloat(pick.topped_up_balance) : null,
      };
      _balanceCache = { at: Date.now(), data };
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 200, { isAvailable: false, error: e.message });
    }
  }

  // 进化
  if (method === 'GET' && is('/api/evolution/feed')) { if (!await gateAllow('evolution', res, { path: pathname, method })) return; return sendJson(res, 200, evolution.feed()); }
  if (method === 'GET' && is('/api/evolution')) { if (!await gateAllow('evolution', res, { path: pathname, method })) return; return sendJson(res, 200, evolution.list().map(stripProposal)); }
  const mEvo = pathname.match(/^\/api\/evolution\/([^/]+)\/(approve|reject|rollback)$/);
  if (mEvo && method === 'POST') {
    try {
      const p = mEvo[2] === 'approve' ? await evolution.approve(mEvo[1]) : mEvo[2] === 'reject' ? evolution.reject(mEvo[1]) : evolution.rollback(mEvo[1]);
      broadcast('evolution', { id: p.id, status: p.status, target: p.target, title: p.title });
      return sendJson(res, 200, stripProposal(p));
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }

  // 记忆 / 技能
  if (p('/api/memory') || p('/api/skills')) {
    const kind = p('/api/memory') ? 'memory' : 'skill';
    const base = kind === 'memory' ? '/api/memory' : '/api/skills';
    if (method === 'GET' && pathname === base) return sendJson(res, 200, memory.list(kind));
    if (method === 'POST' && pathname === base) {
      const body = await readBody(req);
      if (!body.name || !body.content) return sendJson(res, 400, { error: '需要 name 和 content' });
      const file = memory.save(kind, body.name, body.content);
      if (kind === 'skill') { /* 技能目录变化 → 前缀变化，广播一次 */ }
      return sendJson(res, 200, { ok: true, file });
    }
    // 读取/删除统一走 POST body（避免中文名在 URL 查询串里的编码错乱导致空白）
    if (method === 'POST' && pathname === `${base}/read`) {
      const body = await readBody(req);
      return sendJson(res, 200, { name: body.name, content: memory.read(kind, body.name)?.content || '' });
    }
    if (method === 'POST' && pathname === `${base}/delete`) {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: memory.erase(kind, body.name) });
    }
    if (method === 'GET' && pathname === `${base}/read`) {
      const name = url.searchParams.get('name');
      return sendJson(res, 200, { name, content: memory.read(kind, name)?.content || '' });
    }
    if (method === 'DELETE' && pathname === base) {
      const name = url.searchParams.get('name');
      return sendJson(res, 200, { ok: memory.erase(kind, name) });
    }
  }

  // 成长仪表盘 + 项目视图（阶段3/4数据对外暴露，供前端界面沉浸展示）
  if (method === 'GET' && is('/api/growth')) {
    if (!await gateAllow('evolution', res, { path: pathname, method })) return;
    const d = growth.dashboard();
    return sendJson(res, 200, { latest: d.latest, historyCount: d.historyCount, first: d.first, last: d.last, conclusion: d.conclusion, rows: d.rows || [] });
  }
  if (method === 'POST' && is('/api/growth/record')) {
    if (!await gateAllow('evolution', res, { path: pathname, method })) return;
    const s = growth.record();
    return sendJson(res, 200, { ok: true, snapshot: s });
  }
  if (method === 'GET' && is('/api/projects')) {
    if (!await gateAllow('session-tree', res, { path: pathname, method })) return;
    return sendJson(res, 200, growth.projects());
  }
  const mProj = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (method === 'GET' && mProj) {
    if (!await gateAllow('session-tree', res, { path: pathname, method })) return;
    const detail = growth.projectDetail(mProj[1]);
    return detail === null ? sendJson(res, 404, { error: '项目不存在' }) : sendJson(res, 200, { id: mProj[1], content: detail });
  }
  if (method === 'GET' && is('/api/selftrain')) {
    if (!await gateAllow('selftrain', res, { path: pathname, method, mode: url.searchParams.get('mode') })) return;
    if (url.searchParams.get('mode') === 'boundary') return sendJson(res, 200, selftrain.analyzeBoundaries());
    if (url.searchParams.get('mode') === 'skill') return sendJson(res, 200, selftrain.auditSkills());
    if (url.searchParams.get('mode') === 'memory') return sendJson(res, 200, selftrain.auditMemories());
    if (url.searchParams.get('mode') === 'review') return sendJson(res, 200, selftrain.reviewMemories());
    if (url.searchParams.get('mode') === 'history') return sendJson(res, 200, { history: selftrain_task.readHistory() });
    return sendJson(res, 200, selftrain.tick());
  }

  // 子智能体
  if (method === 'GET' && is('/api/agents')) { if (!await gateAllow('multi-agent', res, { path: pathname, method })) return; return sendJson(res, 200, subagent.listAll()); }

  // 调度（心跳/定时）
  if (method === 'GET' && is('/api/schedules')) return sendJson(res, 200, scheduler.list());
  if (method === 'POST' && is('/api/schedules')) {
    const body = await readBody(req);
    if (!body.sessionId) return sendJson(res, 400, { error: '需要 sessionId' });
    if (!body.message) return sendJson(res, 400, { error: '需要 message' });
    let t;
    try {
      t = body.type === 'at' || body.at
        ? scheduler.createAt(body.sessionId, body.at, body.message, { repeats: !!body.repeats })
        : scheduler.createHeartbeat(body.sessionId, Number(body.intervalSec) || 3600, body.message);
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
    return sendJson(res, 200, t);
  }
  const mSched = pathname.match(/^\/api\/schedules\/([^/]+)\/(stop|delete)$/);
  if (mSched && method === 'POST') {
    const t = mSched[2] === 'stop' ? scheduler.stop(mSched[1]) : null;
    if (mSched[2] === 'delete') scheduler.remove(mSched[1]);
    if (!t && mSched[2] === 'stop') return sendJson(res, 404, { error: '调度不存在' });
    return sendJson(res, 200, { ok: true });
  }

  // —— 统一信箱（新客户端 A1 · T-A2/A3/A4）——
  const mailView = (m) => ({ id: m.id, from_id: m.from_id, to_id: m.to_id, type: m.type, topic: m.topic, content: m.content, ts: m.ts, status: m.status, read_at: m.read_at, replied_at: m.replied_at, to_session_id: m.to_session_id });
  if (method === 'GET' && is('/api/mailbox')) {
    const role = url.searchParams.get('role') || mailbox.selfRole() || '';
    const unreadOnly = url.searchParams.get('unread') === '1';
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 50));
    if (!mailbox.available()) return sendJson(res, 200, { role, count: 0, entries: [], available: false });
    let rows;
    try { rows = unreadOnly ? mailbox.fetchUnread(role, limit) : mailbox.listPending(role).slice(0, limit); }
    catch (e) { return sendJson(res, 500, { error: e.message }); }
    const entries = rows.map(mailView);
    return sendJson(res, 200, { role, count: entries.length, entries, available: true });
  }
  if (method === 'GET' && is('/api/mailbox/summary')) {
    if (!mailbox.available()) return sendJson(res, 200, { roles: [], totalUnread: 0, available: false });
    let agents;
    try { agents = mailbox.listAgents(); } catch { agents = []; }
    const roles = agents.map((a) => {
      // 未读用 read_at IS NULL 的真未读口径；lastTs 取该 role 待回复记录的最新时间（活跃度参考）
      let pendingRows = [];
      try { pendingRows = mailbox.listPending(a.role); } catch { }
      const lastTs = pendingRows.reduce((mx, r) => Math.max(mx, r.ts || 0), 0);
      const unreadCount = mailbox.countUnread ? mailbox.countUnread(a.role) : 0;
      // v6.54：补 lastSeen(自注册时间) / online(存活性探测) / restarting(重启中) —— 供前端头像四态
      return { role: a.role, name: a.name, isMain: !!a.is_main, domain: a.domain || '', baseUrl: a.base_url || '', unread: unreadCount, lastTs, busy: mailbox.computeBusy(a, null), lastSeen: Number(a.last_seen) || 0, online: mailbox.isAlive ? mailbox.isAlive(a) : true, restarting: mailbox.isRestarting ? mailbox.isRestarting(a) : false };
    });
    return sendJson(res, 200, { roles, totalUnread: roles.reduce((s2, r) => s2 + r.unread, 0) });
  }
  if (method === 'POST' && is('/api/mailbox/send')) {
    if (!await gateAllow('multi-agent', res, { path: pathname, method })) return;
    const body = await readBody(req);
    if (!body.toRole || !body.content) return sendJson(res, 400, { error: '需要 toRole 与 content' });
    if (!mailbox.available()) return sendJson(res, 503, { error: 'mailbox 未初始化' });
    try {
      const r = mailbox.sendToRole({
        fromRole: body.fromRole || mailbox.selfRole() || undefined,
        toRole: body.toRole, type: body.type || 'task', content: String(body.content),
        topic: body.topic, priority: body.priority, fromSessionId: body.fromSessionId || null,
        meta: body.meta, deadline: body.deadline, parentId: body.parentId,   // P2b-8：结构化头/deadline/父任务透传
      });
      return r.ok ? sendJson(res, 200, { ok: true, id: r.id, role: r.role })
                  : sendJson(res, 400, { error: r.error });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  // —— v6阶段3：信箱队列（逾期 stale / 死信 failed）——
  if (method === 'GET' && is('/api/mailbox/queue')) {
    if (!mailbox.available()) return sendJson(res, 200, { status: '', count: 0, entries: [], available: false });
    const status = url.searchParams.get('status') || 'failed';
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
    try { if (status === 'stale' && mailbox.sweepStale) mailbox.sweepStale({}); } catch { }   // 懒计算：读前顺带标记超时
    let rows = [];
    try { rows = mailbox.listQueue(status, limit); } catch { }
    const entries = rows.map((m) => ({ id: m.id, from: m.from_id, to: m.to_id, type: m.type, priority: m.priority, ts: m.ts, status: m.status, attempts: m.attempts, preview: String(m.content || '').slice(0, 120) }));
    return sendJson(res, 200, { status, count: entries.length, entries, available: true });
  }
  // —— P1：信箱全量流水（含已闭环）· 纯读无副作用（按既定信箱流水规格）——
  if (method === 'GET' && is('/api/mailbox/flow')) {
    if (!mailbox.available()) return sendJson(res, 200, { count: 0, entries: [], available: false });
    const since = Number(url.searchParams.get('since')) || 0;
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 200));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    let rows = [];
    try { rows = mailbox.listFlow({ since, from, to, limit, offset }); }
    catch (e) { return sendJson(res, 500, { error: e.message }); }
    const entries = rows.map((m) => ({
      id: m.id, from_id: m.from_id, to_id: m.to_id, type: m.type, ts: m.ts,
      status: m.status, wake_intent: m.wake_intent, delivered: m.delivered,
      preview: String(m.content || '').slice(0, 120), topic: m.topic,
    }));
    return sendJson(res, 200, { count: entries.length, entries, limit, offset, available: true });
  }
  // —— v6阶段3：重投一条死信 ——
  if (method === 'POST' && is('/api/mailbox/retry')) {
    const body = await readBody(req);
    if (!body.id) return sendJson(res, 400, { error: '需要 id' });
    if (!mailbox.available()) return sendJson(res, 503, { error: 'mailbox 未初始化' });
    try { const r = await mailbox.retry(String(body.id)); return r.ok ? sendJson(res, 200, r) : sendJson(res, 400, r); }
    catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  // —— v6.1：雷影入站消息"实时上屏"轻量事件（发端静默投递后 POST；本身不唤醒 LLM）——
  if (method === 'POST' && is('/api/mailbox/event')) {
    let body = {};
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const cfg = loadConfig();
    const sid = body.to_session_id ? String(body.to_session_id) : '';
    const from = String(body.from || '');
    const type = String(body.type || 'task');
    const full = String(body.full || body.preview || '');
    const msgId = body.msgId || null;
    // D3-①：入站时间戳只算一次，标记写入、延迟入队、SSE 广播共用同一 ts（消除毫秒级不匹配 → 前端误判孤儿）
    const evTs = Number(body.ts) || Date.now();
    const TYPE_LABEL = { reply: '回执', task: '派活', result: '应答', notify: '通知', ack: '确认' };
    const label = TYPE_LABEL[type] || '消息';
    // P2b-4 T1：修订（task rev>1）——接收方忙时置 pending_revision + 回合边界 abort，由回合收尾重注入最新版。
    let revAborted = false;
    if (type === 'task' && Number(body.rev) > 1 && sid && runtime.sessionExists(sid)) {
      try {
        const s0 = runtime.getSession(sid);
        if (s0 && s0.running) { const ra = runtime.abortTurnForRevision(sid, body.cid || null); revAborted = !!(ra && ra.aborted); }
      } catch { }
    }
    // ① 写极简标记入会话历史（token 策略 E：≤40 字，带 _inbound；完整正文绝不写入 messages）
    let markerWritten = false;
    if (sid && runtime.sessionExists(sid)) {
      try {
        const s = runtime.getSession(sid);
        const brief = full.replace(/\s+/g, ' ').slice(0, 18);
        const content = `[雷影${label}] ${from}: ${brief}…（共${full.length}字·详信箱）`.slice(0, 40);
        // 防破坏 wire（双保险）：写入 user 标记会破坏"assistant(tool_calls) → tool 结果"配对 → DeepSeek 400。
        //  ① running=true：会话正处于回合处理中，当前轮即"下一轮"，标记可省，且插入必破坏工具轮；
        //  ② 末尾仍有未应答 tool_calls：同上（兜底 running 判定漏网的时序缝隙）。
        // 两种情况都只走上屏（②），不写历史；完整正文在信箱库，可经 agent_inbox 读到。
        if (s.running === true || hasPendingToolCalls(s.messages)) {
          // v6.x 修法B：不写历史（防破坏工具轮配对），改为**入队延迟补标** ——
          //   回合真正收尾（wire 闭合、无未应答 tool_calls）时由 runtime.flushPendingInbound 落库，
          //   避免"仅上屏气泡→回合结束被前端清除→永久消失"。幂等：同 msgId 不重复入队。
          if (!hasInboundMarker(s, msgId, from, evTs)) {
            queuePendingInbound(s, { from, type, msgId, content, ts: evTs,
              // v6.48（打回重修）：带**写侧唤醒意图 + cid** —— 否则忙时排队项无 wake_intent → 收尾 isActionableType 只能按
              //   type 判 → reply 被判"回执类" → skip:no-actionable（tester U1/U2 FAIL）。带头后与 DB 行同源。
              wake_intent: body.wake_intent || body.notify_target || null,
              notify_target: body.notify_target || body.wake_intent || null,
              cid: body.cid || null });
            console.log(`[mailbox/event] 会话忙碌中，入站标记入队延迟补标：${sid} from=${from} type=${type} msgId=${msgId || '-'}（回合收尾 flush 后由 D4 补唤醒兜底）`);
          }
        } else if (hasInboundMarker(s, msgId, from, evTs)) {
          // 幂等（补标后重投/重复投递）：历史或延迟队列里已有同标记 → 不重复写
          console.log(`[mailbox/event] 已存在同标记，跳过写历史（幂等）：${sid}`);
        } else {
          s.messages.push(runtime.buildInboundMarker(from, type, msgId, content, evTs, body.wake_intent || body.notify_target || null));
          runtime.saveSession(s);
          markerWritten = true;
          broadcast('sessions-changed', { id: sid, action: 'patch' });
        }
      } catch (e) { /* 标记写入失败不影响上屏/唤醒 */ }
    }
    // ② 广播 SSE：前端实时上屏（带完整正文供预览/展开；不进 LLM 上下文）
    if (cfg.mailboxShowInbound !== false) {
      broadcast('mailbox-message', {
        sessionId: sid || null, from, type, msgId,
        preview: full.slice(0, 200), full, ts: evTs,
      });
    }
    // ③ 阶段2：空闲即唤醒——**仅动作类(task 等)**驱动新回合（v6.26 方案A：reply/ack/notify 只落库/上屏/起始注入，
    //    不驱动新回合，根治"未读续跑"放大）；可见性由 SSE 上屏（下方 ②）保住。开关 cfg.mailboxWakeOnlyActionable=false 回退。
    //    markerWritten=false（会话忙/末尾有未闭合工具轮）时保持不唤醒（防破坏工具轮配对）。
    let woke = false;
    if (markerWritten && cfg.mailboxInstantWake !== false) {
      let _wr = null;
      // v6.49：透传触发 msgId → 空闲路径与忙时路径共用同一注入管线（buildInboundPrefix/fetchInboundByIds，不按 read_at 过滤）
      try { const r = runtime.wakeMailbox(sid, msgId != null ? { injectMsgIds: [msgId] } : null); _wr = r; woke = !!(r && r.ok); } catch { }
      try { console.log(`[mailbox/event] 唤醒判定 sid=${sid} from=${from} type=${type} markerWritten=${markerWritten} -> ${woke ? 'WOKE' : 'skip:' + ((_wr && _wr.reason) || '?')}（v6.26：仅动作类唤醒；reply 仅上屏可见）`); } catch { }
    }
    return sendJson(res, 200, { ok: true, markerWritten, woke });
  }

  // —— P2b-4 T2 撤回：置 cid 终态 cancelled（共享库）；接收方在工具前停手检查点读到即停手 + 回 result(cancelled)。——
  //   POST /api/mailbox/cancel  body={cid}
  if (method === 'POST' && is('/api/mailbox/cancel')) {
    let body = {};
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const cid = String(body.cid || body.correlationId || '');
    if (!cid) return sendJson(res, 400, { error: '需要 cid' });
    const mb = require('./mailbox');
    const n = (mb.available && mb.available() && mb.cancelCid) ? mb.cancelCid(cid) : 0;
    return sendJson(res, 200, { ok: true, cid, cancelled: n });
  }

  // —— v6.x：雷影后台任务 busy 信号 + 收口唤醒（雷影 spawn detached 子进程跑长任务时，由子进程上报）——
  //   POST /api/agent/task-state  body={role, session_id, state:'busy'|'done', message?}
  //   busy → 写该 role 的 busy_session/busy_at（前端 AgentChip 头像即动效）；
  //   done → 清 busy + 向该会话注入"后台任务已完成"并走既有空闲唤醒（忙则仅排队，下回合未读注入读取）。
  //   安全：服务仅监听 127.0.0.1；且仅允许为**本实例自身 role** 上报（防跨角色伪造）。
  if (method === 'POST' && is('/api/agent/task-state')) {
    let body = {};
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const mb = require('./mailbox');
    if (!mb.available()) return sendJson(res, 503, { error: 'mailbox 未初始化' });
    const self = mb.selfRole();
    const role = String(body.role || '');
    const sid = String(body.session_id || '');
    const state = String(body.state || '');
    if (!self || role !== self) return sendJson(res, 403, { error: `role 必须是本实例角色 ${self || '(未配置)'}` });
    if (!sid) return sendJson(res, 400, { error: '需要 session_id' });
    if (state === 'busy') {
      try { mb.setAgentBusy(role, sid); } catch (e) { return sendJson(res, 500, { error: e.message }); }
      return sendJson(res, 200, { ok: true, state: 'busy', role, session_id: sid });
    }
    if (state === 'done') {
      try { mb.setAgentBusy(role, null); } catch { }
      // A（自环硬防）：目标会话正在本实例跑回合 → 视为"子系统通知自己"自环，
      //   清 busy 但**不注入、不唤醒**（否则同会话自我唤醒→自环续跑）。判据=该分支存在且可触发。
      try {
        const _selfLoopS = runtime.getSession ? runtime.getSession(sid) : null;
        if (_selfLoopS && _selfLoopS.running) {
          return sendJson(res, 200, { ok: true, state: 'done', role, session_id: sid, skipped: 'self-loop(session-running)' });
        }
      } catch { }
      // 定案（2026-10-08）：同 task(cid) 重复 done 只推一次（幂等护栏）。
      const _cid = String(body.cid || body.correlation_id || '');
      if (_cid && runtime.markDoneOnce && !runtime.markDoneOnce(_cid)) {
        return sendJson(res, 200, { ok: true, state: 'done', role, session_id: sid, duplicate: true });
      }
      const msg = String(body.message || '【后台任务已完成，请收结果】');
      let woke = false, reason = null, injected = false;
      try {
        // 仅当会话存在才注入 notify（fresh ts 必过 fetchUnreadForSession 的 stale 过滤），避免产生孤儿消息
        if (runtime.sessionExists(sid)) {
          // B①（2026-10-10）：不再直调底层纯落库 sendMessage —— 本处为**引擎内部·role 定向**通知（非 deliverToSession 的
          //   同角色会话间投递），故显式走内部落库 `_persistMessage`（下划线=内部用）；送达/唤醒由此处 runtime.wakeMailbox
          //   承担（含忙时重试/shortRecheck 语义），等价"落库 + 投递 + 唤醒"一体（投递步=wakeMailbox）。
          mb._persistMessage({ from: 'system', to: role, toSessionId: sid, type: 'notify', topic: '后台任务', content: msg, priority: 'high', wakeIntent: 'actionable' });
          injected = true;
        }
        const r = runtime.wakeMailbox(sid);
        woke = !!(r && r.ok); reason = r && r.reason;
        // P2b-15（2026-09-29）附带修：done 未唤醒（会话忙/压缩中/速率窗）时，**保底重排一次空闲复查**——
        //   此前仅依赖"正在跑的回合收尾"顺带排；若 done 到达时回合刚好已收尾/被压缩占据 → 通知挂起无提示。
        //   sweepIdleUnread 自带"空闲+有未读"守卫 → 幂等、无空转。
        if (!woke) {
          try { setTimeout(() => { try { runtime.sweepIdleUnread(sid); } catch { } }, 3000); } catch { }
          // 定案（2026-10-08）短回检：30s→60s 退避重试直至真唤醒（防忙/限流致搁浅），成功即停；仅状态变化才唤醒。
          try { runtime.scheduleShortRecheck(sid, _cid); } catch { }
        } else {
          try { runtime.cancelShortRecheck(sid); } catch { }
        }
      } catch (e) { return sendJson(res, 500, { error: e.message }); }
      return sendJson(res, 200, { ok: true, state: 'done', role, session_id: sid, injected, woke, reason });
    }
    return sendJson(res, 400, { error: "state 必须是 busy|done" });
  }


  // —— 信箱 busy 跨实例转发：各雷影实例本地 broadcast 前端收不到（SSE 只连主引擎），故由各实例 POST 到此，主引擎统一广播 ——
  //   POST /api/agent/busy-notify  body={role, busy, sessionId}
  if (method === 'POST' && is('/api/agent/busy-notify')) {
    let body = {};
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const mb2 = require('./mailbox');
    const role = String(body.role || '');
    const ag = mb2.getAgent ? mb2.getAgent(role) : null;
    if (!role || !ag || ag.is_main) return sendJson(res, 400, { error: '非法 role' });
    // 小增强（2026-09-29）：落库+广播**双向兜底**——此前只 broadcast，落库依赖雷影实例自写；
    //   若该 POST 丢失则 SSE 即时路径失效（前端只能靠 10s 轮询补）。此处由主引擎再写一次共享库（幂等：
    //   同一值重复写无害）；写库失败**不影响广播**（try/catch 包裹，广播照发）；响应契约不变（仍 {ok:true}）。
    try { if (mb2.setAgentBusy) mb2.setAgentBusy(role, body.busy ? (body.sessionId || null) : null, { noForward: true }); } catch (e) { try { console.warn('[busy-notify] 落库兜底失败(不影响广播):', e.message); } catch { } }
    broadcast('agent-busy', { role, busy: !!body.busy, sessionId: body.sessionId || null });
    return sendJson(res, 200, { ok: true });
  }

  // —— 创建/删除独立雷影（实例模型 B · 仅主实例可调）——
  {
    const cfgA = require('./config').load();
    const isMainA = isMainInstance(cfgA);
    if (method === 'GET' && is('/api/agents/roles')) {
      let roles = []; try { roles = require('./agents-admin').listRolePresets(); } catch { roles = []; }
      return sendJson(res, 200, { ok: true, roles });
    }
    if (method === 'GET' && is('/api/agents/instances')) {
      const aa = require('./agents-admin');
      return sendJson(res, 200, { ok: true, instances: aa.listInstances(), nextPort: await aa.nextPort(), count: aa.countInstances() });
    }
    if (method === 'GET' && is('/api/agents/reconcile')) {
      let r; try { r = await require('./agents-admin').reconcileInstances(); } catch (e) { r = { error: String((e && e.message) || e) }; }
      return sendJson(res, 200, { ok: !r.error, ...r });
    }
    // 案①（2026-10-08）：手动触发雷影代码随主程序更新（dryRun 可预演）；仅主实例
    if (method === 'POST' && is('/api/agents/sync-src')) {
      if (!isMainA) return sendJson(res, 403, { error: '仅主实例可同步雷影代码' });
      let body = {}; try { body = await readBody(req); } catch { }
      let r; try { r = await require('./agents-admin').syncAllAgentsSrc({ dryRun: !!(body && body.dryRun) }); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      return sendJson(res, r && r.ok ? 200 : 400, r);
    }
    if (method === 'POST' && is('/api/agents/create')) {
      if (!isMainA) return sendJson(res, 403, { error: '仅主实例可创建雷影' });
      let body = {}; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      let r; try { r = await require('./agents-admin').createAgent(body || {}); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      try { if (r && r.ok && !r.dryRun) broadcast('agents-changed', { role: r.role, created: true }); } catch { }
      return sendJson(res, r && r.ok ? 200 : 400, r);
    }
    // AI 补全（自定义角色）：调模型产 {domain,temperature} 建议，仅回填前端、绝不落库（失败降级）
    if (method === 'POST' && is('/api/agents/auto-profile')) {
      if (!isMainA) return sendJson(res, 403, { error: '仅主实例可用' });
      let body = {}; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      let r; try { r = await require('./agents-admin').autoProfile(body || {}); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      return sendJson(res, r && r.ok ? 200 : 400, r);
    }
    if (method === 'POST' && is('/api/agents/delete')) {
      if (!isMainA) return sendJson(res, 403, { error: '仅主实例可删除雷影' });
      let body = {}; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      let r; try { r = require('./agents-admin').deleteAgent(body || {}); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      try { if (r && r.ok && !r.dryRun) broadcast('agents-changed', { role: r.role, deleted: true }); } catch { }
      return sendJson(res, r && r.ok ? 200 : 400, r);
    }
    // —— AI 生成雷影专属图标（独立端点；创建不被拖累）——
    //   · 无 role（body 无/非法 role）= **创建前生成**：按 {name,domain} 产**内联** SVG，只回 {ok,icon}、**不落盘**（前端预览）
    //   · 有 role 且在名册 = 原行为：生成/复用并落盘 data/assets/icons/<role>.svg → 回 {ok,url}
    if (method === 'POST' && is('/api/agents/icon')) {
      if (!isMainA) return sendJson(res, 403, { error: '仅主实例可用' });
      let body = {}; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      const role = String((body && body.role) || '').trim();
      if (!/^[a-z0-9-]{1,40}$/.test(role)) {
        let r; try { r = await require('./agent-icons').generateInline({ name: (body && body.name) || '', domain: (body && body.domain) || '' }); }
        catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
        return sendJson(res, r && r.ok ? 200 : 400, r);
      }
      let a = null; try { a = require('./mailbox').getAgent(role); } catch { }
      if (!a) return sendJson(res, 404, { ok: false, error: 'role_not_found', role });   // role 必须在名册内（防路径穿越）
      let r; try { r = await require('./agent-icons').ensureIcon(role, { name: a.name, domain: a.domain, force: !!(body && body.force) }); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      return sendJson(res, r && r.ok ? 200 : 400, r);
    }
    if (method === 'GET' && is('/api/agents/icon')) {
      const _u = new URL(req.url, 'http://localhost');
      const role = String(_u.searchParams.get('role') || '').trim();
      const svg = require('./agent-icons').readIcon(role);
      if (!svg) return sendJson(res, 404, { ok: false, error: 'icon_not_found', role });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
      return res.end(svg);
    }
    // —— 雷影通用设置（一处改 → 写所有雷影 common/实例 config；独立实现，禁调 config.save()）——
    if (method === 'GET' && is('/api/agents/common-config')) {
      if (!isMainA) return sendJson(res, 403, { error: '仅主实例可读雷影通用配置' });
      let r; try { r = require('./agents-common-config').getCommonConfig(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      return sendJson(res, r && r.ok ? 200 : 500, r);
    }
    if (method === 'POST' && is('/api/agents/common-config')) {
      if (!isMainA) return sendJson(res, 403, { error: '仅主实例可设置雷影通用配置' });
      let body = {}; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      let r; try { r = require('./agents-common-config').saveCommonConfig(body || {}); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      try { if (r && r.ok) broadcast('agents-common-config-changed', { okCount: r.okCount, total: r.total }); } catch { }
      return sendJson(res, r && r.ok ? 200 : 400, r);
    }
  }

  // —— 注销/恢复雷影（仅主实例可调）——
  //   POST /api/agent/retire  body={role, confirm}   confirm 须 === role（二次确认）
  //   顺序：①先写库(enabled=0,retired_at=now) → ②停进程(按 base_url 端口) → ③清 dispatcher_session_id
  //   幂等、异常安全；不删行（可经 /api/agent/revive 恢复）。
  if (method === 'POST' && is('/api/agent/retire')) {
    let body = {};
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const cfg0 = require('./config').load();
    if (!isMainInstance(cfg0)) return sendJson(res, 403, { error: '仅主实例可注销雷影' });
    const mb = require('./mailbox');
    if (!mb.available()) return sendJson(res, 503, { error: 'mailbox 未初始化' });
    const role = String(body.role || '').trim();
    if (!role) return sendJson(res, 400, { error: '需要 role' });
    if (String(body.confirm || '') !== role) return sendJson(res, 400, { error: `二次确认失败：confirm 须等于 role（"${role}"）` });
    const r0 = mb.retireAgent(role);          // ① 先写库
    if (!r0.ok) return sendJson(res, 400, { error: r0.error });
    let killed = 0;
    try {                                      // ② 停进程（按 base_url 端口精确 kill）
      const port = (String(r0.base_url || '').match(/:(\d+)/) || [])[1];
      if (port) {
        const { spawnSync } = require('node:child_process');
        const net = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
        const pids = new Set();
        for (const line of String(net.stdout || '').split('\n')) {
          if (line.includes(`:${port} `) && /LISTENING/.test(line)) { const m = line.trim().split(/\s+/); if (m[m.length - 1]) pids.add(m[m.length - 1]); }
        }
        for (const pid of pids) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); killed++; } catch { } }
      }
    } catch { /* 停进程失败不阻断（库已置墓碑，防复活已生效） */ }
    try { mb.setDispatcher(role, null); } catch { }   // ③ 清 dispatcher_session_id
    try { broadcast('agents-changed', { role, retired: true }); } catch { }
    return sendJson(res, 200, { ok: true, role, retired: true, killed, base_url: r0.base_url || '' });
  }

  // —— 恢复雷影（清墓碑）：POST /api/agent/revive body={role}（仅主实例）——
  if (method === 'POST' && is('/api/agent/revive')) {
    let body = {};
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const cfg0 = require('./config').load();
    if (!isMainInstance(cfg0)) return sendJson(res, 403, { error: '仅主实例可恢复雷影' });
    const mb = require('./mailbox');
    if (!mb.available()) return sendJson(res, 503, { error: 'mailbox 未初始化' });
    const role = String(body.role || '').trim();
    if (!role) return sendJson(res, 400, { error: '需要 role' });
    const r0 = mb.reviveAgent(role);
    if (!r0.ok) return sendJson(res, 400, { error: r0.error });
    try { broadcast('agents-changed', { role, retired: false }); } catch { }
    return sendJson(res, 200, { ok: true, role, retired: false });
  }

  // —— P2b-2 信箱消费/回复事件跨实例转发：事件由各实例 mailbox.js 产生，非 main 实例本地 broadcast
  //    前端收不到（SSE 只连主引擎），故主动 POST 到此，主引擎统一广播。纯 SSE 上屏，**绝不触发唤醒**。
  //    POST /api/agent/mailbox-event  body={role, event, payload}
  if (method === 'POST' && is('/api/agent/mailbox-event')) {
    let body = {};
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const mb3 = require('./mailbox');
    const evName = String(body.event || '');
    const role = String(body.role || (body.payload && body.payload.role) || '');
    const ag = mb3.getAgent ? mb3.getAgent(role) : null;
    if (!role || !ag || ag.is_main) return sendJson(res, 400, { error: '非法 role' });
    if (evName !== 'mailbox-consumed' && evName !== 'mailbox-replied') return sendJson(res, 400, { error: '非法 event' });
    const data = (body.payload && typeof body.payload === 'object') ? body.payload : { role, ts: Date.now() };
    broadcast(evName, data);
    return sendJson(res, 200, { ok: true });
  }

  // —— 询问选项框（Ask Box）：回答端点 ——
  //   POST /api/ask/answer body={askId, kind:'option|skip|text', value?}
  //   行为：把回答拼成一条用户消息注入该 session（option→【选择】<label>；text→【补充】<value>）
  //   → 触发该会话新回合（复用 runChat）→ 标记该 ask 已答（从持久化移除）。契约：按既定交互规格（询问选项框）。
  //   kind='skip'：语义=暂不执行/保持现状/仅关闭弹窗 → 只移除+广播关闭，**不注入不跑回合**（2026-09-21 主人明令纠正）。
  if (method === 'POST' && is('/api/ask/answer')) {
    let body = {};
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const askId = String(body.askId || '');
    const kind = String(body.kind || '');
    if (!askId || !kind) return sendJson(res, 400, { error: '需要 askId 和 kind' });
    const asks = require('./asks');
    const ask = asks.getAsk(askId);
    if (!ask) return sendJson(res, 404, { ok: false, error: 'ask 不存在或已答', askId });
    // v1.1：combo 校验——options 必须是数组、text 必须是字符串；二者至少一个有值（由 compose 判定）。
    if (kind === 'combo') {
      if (body.options != null && !Array.isArray(body.options)) return sendJson(res, 400, { error: 'combo 的 options 必须是数组' });
      if (body.text != null && typeof body.text !== 'string') return sendJson(res, 400, { error: 'combo 的 text 必须是字符串' });
    }
    // combo：value=options 数组，extra=text；其余 kind：value=body.value。
    const text = asks.composeAnswer(ask, kind, kind === 'combo' ? (body.options || []) : body.value, kind === 'combo' ? (body.text || '') : undefined);
    if (!text) return sendJson(res, 400, { error: 'kind 非法（应为 option|skip|text|combo）或 combo 无有效内容' });
    // 标记已答（先移除，防重复提交）
    asks.removeAsk(askId);
    const sid = String(ask.sessionId || '');
    // kind='skip' 语义纠正（主人明令 2026-09-21）：跳过 = 暂不执行/保持现状/仅关闭弹窗，
    //   ≠"按判断或推荐继续"。故**不注入 s.messages、不触发回合**，只移除 ask 并广播关闭。
    if (kind === 'skip') {
      broadcast('ask-answered', { askId, sessionId: sid, kind: 'skip', dismissed: true });
      return sendJson(res, 200, { ok: true, askId, sessionId: sid, kind: 'skip', dismissed: true });
    }
    const s = sid ? runtime.getSession(sid) : null;
    if (!s) { broadcast('ask-answered', { askId, sessionId: sid, kind }); return sendJson(res, 404, { ok: false, error: '会话不存在', askId, sessionId: sid }); }
    // ① 注入该会话为一条用户消息（立刻落历史，保证"新增用户消息"确定可见）
    let injected = false;
    try {
      s.messages.push({ role: 'user', content: text, _ask: { askId, kind } });
      runtime.saveSession(s);
      broadcast('sessions-changed', { id: sid, action: 'patch' });
      injected = true;
    } catch (e) { /* 注入失败不阻塞回合触发 */ }
    // ② 触发新回合（空闲则起；忙则消息已入历史，下回合可见）。internalMailbox+空 content → 不重复 push。
    let woke = false, reason = null;
    try {
      if (s.running) {
        // 忙时不再只标 busy：复用 /api/chat 单会话串行队列，排一个 internalMailbox 专属回合。
        // 当前回合结束后 pumpQueue 自动续跑该空回合，消化已注入历史的答案 → 保证"答案终被处理"，
        // 不依赖外部新消息/收尾 sweep（答案非信箱消息，sweep 扫不到）。与普通消息行为一致。
        let q = chatQueues.get(sid);
        if (!q) { q = { items: [], pumping: false }; chatQueues.set(sid, q); }
        const item = {
          sessionId: sid, message: '', forceReflect: false, images: undefined,
          internalMailbox: true, evt: {}, state: 'queued', errorRaised: false, resolveDone: null,
          msgId: `ask-${askId}`,
        };
        item.done = new Promise((resolve) => { item.resolveDone = resolve; });
        q.items.push(item);
        pumpQueue(sid);
        reason = 'queued'; woke = true;
      }
      else { runtime.runChat(sid, '', { internalMailbox: true, origin: 'user' }).catch(() => { }); woke = true; }
    } catch (e) { reason = e.message; }
    broadcast('ask-answered', { askId, sessionId: sid, kind });
    return sendJson(res, 200, { ok: true, askId, sessionId: sid, kind, message: text, injected, woke, reason });
  }

  // —— 询问选项框：未答列表（供前端刷新恢复；无 sessionId 返回全部）——
  //   GET /api/ask/pending?sessionId=
  if (method === 'GET' && is('/api/ask/pending')) {
    const sid = url.searchParams.get('sessionId') || '';
    const asks = require('./asks');
    return sendJson(res, 200, { ok: true, asks: asks.listPending(sid) });
  }

  // —— 自我画像（新客户端 A1 · T-A5）——
  if (method === 'GET' && is('/api/self')) {
    const task = url.searchParams.get('task') || undefined;
    try { return sendJson(res, 200, { summary: selfmodel.summarizeSelf(task), snapshot: selfmodel.snapshot() }); }
    catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  // v6.x（2026-10-02）：自检端点——harness.md 指纹 + 最近一次已应用进化，供核对规则是否被静默改过；字段缺失优雅降级。
  if (method === 'GET' && is('/api/self/harness-integrity')) {
    let harnessMd5 = null;
    try { const { HARNESS_PATH } = require('./prompt'); harnessMd5 = require('node:crypto').createHash('md5').update(fs.readFileSync(HARNESS_PATH)).digest('hex'); } catch { }
    let lastEvolution = null;
    try {
      const _all = evolution.list() || [];
      const _last = _all.filter((p) => p && (p.status === 'applied' || p.status === 'auto-applied'))[0] || _all[0] || null;
      if (_last) lastEvolution = { version: _last.id || null, title: _last.title || null, ts: _last.ts || _last.appliedAt || null };
    } catch { }
    return sendJson(res, 200, { harnessMd5, lastEvolution });
  }

  // —— 静态托管（webui/dist，新客户端 A1 · T-A1）——
  if (method === 'GET') return serveStatic(req, res, pathname);

  sendJson(res, 404, { error: 'not found' });
}

function stripProposal(p) {
  const { oldContent, newContent, ...rest } = p;
  return { ...rest, oldContent: (oldContent || '').slice(0, 6000), newContent: (newContent || '').slice(0, 6000) };
}

/** 会话回放瘦身：只去掉 user 消息 content 数组里的 image_url 段（文本段完整保留，兼容客户端 ContentToText）。 */
function stripImageParts(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || m.role !== 'user' || !Array.isArray(m.content)) return m;
    const parts = [];
    for (const p of m.content) {
      if (p && typeof p === 'object' && p.type === 'image_url') continue;
      parts.push(p);
    }
    if (parts.length === m.content.length) return m;   // 无图片段 → 原样
    if (parts.length === 1 && parts[0] && parts[0].type === 'text') return { ...m, content: String(parts[0].text || '') };
    return { ...m, content: parts.length ? parts : m.content };
  });
}

// —— 启动 ——
// boot-guard：启动自检回滚（阶段1·第二层）。万一坏版本绕过影子写入落盘，启动时自检发现，
// 自动回退版本链里最近的好版本，保证"改错也永不无法启动"。
function bootGuard() {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(path.join(d, e.name)); }
      else if (e.name.endsWith('.js')) files.push(path.join(d, e.name));
    }
  };
  try { walk(path.join(ROOT, 'src')); } catch { }
  let failed = null;
  for (const f of files) {
    try {
      // 语法检查
      const { spawnSync } = require('node:child_process');
      const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) { failed = f; break; }
    } catch (e) { failed = f; break; }
  }
  if (failed) {
    console.error(`[boot-guard] 启动自检发现坏版本：${failed}`);
    // 尝试回退
    const ok = versionchain.rollback(failed);
    if (ok) {
      console.error('[boot-guard] 已回退到最近好版本，重新验证...');
      // 回退后重新检查一次
      const { spawnSync } = require('node:child_process');
      const r = spawnSync(process.execPath, ['--check', failed], { encoding: 'utf8', windowsHide: true });
      if (r.status === 0) { console.error('[boot-guard] 回退后验证通过，继续启动'); return; }
      console.error('[boot-guard] 回退后仍异常，无法自愈，退出');
      process.exit(1);
    } else {
      console.error('[boot-guard] 无版本链可回退，无法自愈，请手动恢复。退出');
      process.exit(1);
    }
  }
}
bootGuard();

const cfg = loadConfig();
fs.mkdirSync(cfg.workdir, { recursive: true });
// P2（2026-10-09）：旧版→新版升级迁移（仅产品/发布态 + 版本跳跃时；幂等、失败绝不阻断启动，dev 不触发）。
//   须在 gate.init / branch 使用之前完成（先补 branch.db 旧列，避免 init 因缺列中止）。
try { require('./upgrade').maybeRunOnBoot(cfg); } catch (e) { try { console.warn('[upgrade] 跳过（不阻断）：' + (e && e.message)); } catch { } }
// —— Pro 分档启动门（soft-gate）—— 见 src/pro/gate.js。绝不 throw；默认开发放行（不锁死功能）。
let PRO_STATE = { tier: 'pro', reason: 'pre-init' };
try { PRO_STATE = require('./pro/gate').init(cfg); } catch (e) { PRO_STATE = { tier: 'lite', reason: 'init-error(fail-safe-lite):' + (e && e.message || e) }; }
// P1-5（c）：启动周期授权心跳/续签（有 token 才启；失败不阻塞，离线窗口到点由 gate 降级）。
try { require('./pro/heartbeat').start(cfg); } catch { /* 心跳启动失败不阻塞引擎 */ }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // 启动竞态诊断：每个请求一行（含 SSE 长连，标记事件源）
  try { console.log(`[REQ] ${new Date().toISOString().slice(11, 23)} ${req.method} ${url.pathname}${url.pathname === '/api/events' ? ' (sse)' : ''}`); } catch { }
  route(req, res, url).catch((e) => {
    const code = e && e.status ? e.status : 500;
    if (!res.headersSent) sendJson(res, code, { error: e.message || 'internal error' });
    else { try { res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`); } catch { } try { res.end(); } catch { } }
  });
});

// 关键提速：关闭 Nagle（socket.setNoDelay）。Node 默认启用 Nagle 算法，SSE 的每个小事件帧
// （reasoning/delta 逐 token 回传）会因 40ms delayed-ACK 合并延迟而"攒批"发出，
// 造成流式首字迟迟不出、逐字显示一顿一顿。这里对全部连接关掉，事件即写即发。
server.on('connection', (socket) => {
  try { socket.setNoDelay(true); } catch { }
});

// P0（2026-10-03）：首启播种 prompts（幂等）——config 已加载、listen 前，保证任何读 prompts 前已就绪。
try { require('./prompt').ensurePrompts(); } catch (e) { try { console.warn('[启动] 播种 prompts 失败（不阻断）：' + (e && e.message)); } catch { } }

server.listen(cfg.port, cfg.host, () => {
  console.log('┌─────────────────────────────────────────────┐');
  console.log('│  ⚡ 雷仔 · 自我进化型智能体 已启动           │');
  console.log(`│  桌面客户端: LeiZai.exe                        │`);
  console.log(`│  模型: ${cfg.model} · 缓存自动优化已开启 · 最大权限模式 ${cfg.fullAccess ? 'ON' : 'OFF'}`);
  console.log(`│  模式: ${DAEMON ? '守护进程(--daemon)' : '前台'}`);
  console.log(`│  Pro 档位(启动瞬态): ${PRO_STATE.tier}（${PRO_STATE.reason}）`);
  console.log('└─────────────────────────────────────────────┘');
  // 防漂移自检（路线B）：主实例启动时生成 src 基线；各实例启动即比对一次并打印。
  try {
    if (isMainInstance(cfg)) {
      const _b = srcdrift.generateBaseline(cfg);
      console.log(`[srcdrift] 基线已生成：${_b.count} 文件 → ${srcdrift.baselinePath(cfg)}`);
    }
    const _d = srcdrift.getDrift(cfg);
    console.log(`[srcdrift] 自检：modified=${_d.modified ? _d.modified.length : '-'} missing=${_d.missing ? _d.missing.length : '-'} extra=${_d.extra ? _d.extra.length : '-'}${_d.error ? ' error=' + _d.error : ''}`);
    // 防漂移告警：启动自检发现漂移非空 → 写一条 WARN（可检索留痕；列表截断）。不自愈、不拒启。
    const _nDrift = (_d.missing ? _d.missing.length : 0) + (_d.extra ? _d.extra.length : 0) + (_d.modified ? _d.modified.length : 0);
    if (_d.enabled && _nDrift > 0) {
      const _role = (cfg.agent && cfg.agent.role) || 'main';
      const _clip = (a) => { const x = a || []; return '[' + x.slice(0, 20).join(',') + (x.length > 20 ? ` …(+共${x.length})` : '') + ']'; };
      console.warn(`[srcdrift][WARN] 实例 ${_role} src 漂移：modified=${(_d.modified||[]).length} missing=${(_d.missing||[]).length} extra=${(_d.extra||[]).length} | modified=${_clip(_d.modified)} missing=${_clip(_d.missing)} extra=${_clip(_d.extra)}`);
    }
  } catch (e) { console.error('[srcdrift] 初始化失败:', e.message); }
  if (DAEMON) {
    try {
      fs.mkdirSync(path.dirname(DAEMON_PID), { recursive: true });
      fs.writeFileSync(DAEMON_PID, String(process.pid), 'utf8');
    } catch { }
  }
  // —— 统一信箱：启动自注册（主引擎传 isMain → 由它设一次 WAL 并建表）——
  try {
    // P2a（ADR §2.0）：向 mailbox 注入引擎能力 hook，切断 mailbox → runtime 反向依赖（M35 单向）。
    try {
      mailbox.setHooks({
        emit: (name, payload) => { try { runtime.runtime.emit(name, payload); } catch { } },
        sessionExists: (id) => runtime.sessionExists(id),
        sweepEmptyPeerSessions: (opts) => runtime.sweepEmptyPeerSessions(opts),
      });
    } catch { }
    const _isMainInst = isMainInstance(cfg);
    mailbox.init({ isMain: _isMainInst });
    // 名册 data_dir 口径=实例根目录（non-main 传 <root>/data 时由 registerAgent 归一为 <root>）
    // P0（雷影 no-key 根因）：主我注册**不依赖 cfg.agent**——产品 config 可能无 agent 块（config.js DEFAULTS agent:null），
    //   旧式 `if (cfg.agent && ...)` 会致 main 不入 agents 表 → 雷影 _mainDataDir(config.js) 返 null → 继承链断。
    //   改为：isMainInstance(cfg) 即注册 role='main'（name/baseUrl 缺省兜底）。雷影仍走 cfg.agent。
    const _regAg = (cfg.agent && cfg.agent.role)
      ? cfg.agent
      : (_isMainInst
        ? { role: 'main', name: (cfg.agent && cfg.agent.name) || '雷仔·主我', domain: (cfg.agent && cfg.agent.domain) || '统筹', baseUrl: (cfg.agent && cfg.agent.baseUrl) || `http://127.0.0.1:${cfg.port}`, isMain: true }
        : null);
    if (_regAg && mailbox.available()) mailbox.registerAgent(_regAg, cfg.dataDir);
    // v6.9：启动即清除**自身 role** 的 busy 残留。若上一进程在"收尾途中"被重启，新进程不会重放
    // 回合 finally 的置空（runtime.js L866/L1212），agents.busy_session 会残留 → 前端雷影 chip 误显示
    // "工作中"（只能靠 30min TTL 慢慢自愈）。新进程启动时什么都没跑，理应空闲。
    // 只清自身 role（多实例共享同一 agents 表，绝不动他人）；幂等、异常安全、不阻塞启动。
    try {
      if (mailbox.available()) {
        const _selfRole = mailbox.selfRole();
        if (_selfRole) mailbox.setAgentBusy(_selfRole, null);
      }
    } catch (e) { console.error('[mailbox] 清除自身 busy 残留失败:', e.message); }
    if (mailbox.available()) console.log(`[mailbox] 已就绪（role=${(cfg.agent && cfg.agent.role) || '未配置'}，db=${mailbox.dbPath()}）`);
    // v6阶段3：周期标记超时 task → status='stale'（unref 不阻止进程退出；throttle 由 sweepStale 内部 60s 兜）
    if (mailbox.available() && mailbox.sweepStale) {
      const _t = setInterval(() => { try { mailbox.sweepStale({}); } catch { } }, 5 * 60 * 1000);
      if (_t.unref) _t.unref();
    }
    // v6.50（定案 C）：周期静默收口"已展示但无回合可消费"的非动作类入站（reply/ack/notify）——
    //   空闲会话不再残留未读（read 语义=已展示）；不起回合、不发唤醒。minAge 保证 SSE 上屏先于标读。
    if (mailbox.available() && runtime.sweepIdleSilentReads) {
      const _tsr = Number(cfg.mailboxSilentReadSweepMs);
      const _iv2 = Number.isFinite(_tsr) && _tsr >= 5000 ? _tsr : 30000;
      const _t2 = setInterval(() => { try { runtime.sweepIdleSilentReads(); } catch { } }, _iv2);
      if (_t2.unref) _t2.unref();
    }
    // v6.8-B：投递失败自动重投（周期；unref）。开关 mailboxAutoRedeliver（默认 true）。
    // ★仅主引擎执行（四实例共享同一 DB；非主实例执行会造成同一条消息被并发重复投递）。
    if (mailbox.available() && mailbox.redeliverPending && isMainInstance(cfg) && cfg.mailboxAutoRedeliver !== false) {
      const iv = Number(cfg.mailboxRedeliverIntervalMs);
      const _ri = setInterval(() => { try { Promise.resolve(mailbox.redeliverPending({})).catch(() => { }); } catch { } },
        Number.isFinite(iv) && iv > 0 ? iv : 60000);
      if (_ri.unref) _ri.unref();
    }
    // GAP-1/GAP-2（P2b-7 批）：deadline 过期扫描 + retention 冷表归档（周期；unref）。
    // ★仅主引擎执行（共享库，多实例并发会重复归档/误标）。
    if (mailbox.available() && isMainInstance(cfg)) {
      if (mailbox.sweepExpired || mailbox.sweepAwaitingClose) {
        const _te = setInterval(() => {
          try { if (mailbox.sweepExpired) mailbox.sweepExpired({}); } catch { }
          try { if (mailbox.sweepAwaitingClose) mailbox.sweepAwaitingClose({}); } catch { }   // P0(c)：复用同一周期，不新增定时器
        }, 5 * 60 * 1000);
        if (_te.unref) _te.unref();
      }
      if (mailbox.sweepRetention && cfg.mailboxRetentionEnabled !== false) {
        const _tr = setInterval(() => { try { mailbox.sweepRetention({}); } catch { } }, 6 * 60 * 60 * 1000);
        if (_tr.unref) _tr.unref();
        setTimeout(() => { try { mailbox.sweepRetention({}); } catch { } }, 30000);   // 启动 30s 后先跑一次
      }
    }
    // v6.8-A：启动后自动恢复雷影（延迟 ~5s，异步不阻塞启动；开关 mailboxAutoReviveAgents 默认 true）。
    // 恢复逻辑封装在 mailbox.reviveAgents()（可单测；内部串行探活+ensureAgentUp，每步 sleep 2s，整体 ≤60s）。
    // ★仅主引擎执行：否则某雷影宕机时，其余多个实例会同时各 spawn 一个 → 重复实例（惊群在"多进程"层面绕过了进程内 30s 防惊群）。
    if (mailbox.available() && mailbox.reviveAgents && isMainInstance(cfg) && cfg.mailboxAutoReviveAgents !== false) {
      // 案①（2026-10-08）：先做「雷影代码随主程序更新」（仅主实例 + release；dev 自动跳过），再复活，防抢拉起。
      setTimeout(() => {
        const _sync = (() => { try { return Promise.resolve(require('./agents-admin').syncAllAgentsSrc({})); } catch { return Promise.resolve(null); } })();
        _sync.then((r) => { try { if (r && r.count) console.log('[srcsync] 雷影代码同步：' + JSON.stringify(r.results)); } catch { } })
          .catch(() => { })
          .then(() => { try { return Promise.resolve(mailbox.reviveAgents({})); } catch { } })
          .catch(() => { })   // ★防 revive 异常短路后续 boot 配额核对（降档须生效）
          .then(() => { try { Promise.resolve(require('./pro/quota').enforce('boot')).catch((e) => { try { console.log('[quota] enforce(boot) rejected: ' + (e && e.message)); } catch { } }); } catch (e) { try { console.log('[quota] enforce(boot) throw: ' + (e && e.message)); } catch { } } })
          .catch(() => { });
      }, 5000);
    } else if (mailbox.available() && isMainInstance(cfg) && cfg.mailboxAutoReviveAgents === false) {
      // ★开关关闭自动复活时，boot 配额核对照常执行（降档/到期须生效，不依赖复活链）
      setTimeout(() => { try { Promise.resolve(require('./pro/quota').enforce('boot')).catch((e) => { try { console.log('[quota] enforce(boot) rejected: ' + (e && e.message)); } catch { } }); } catch (e) { try { console.log('[quota] enforce(boot) throw: ' + (e && e.message)); } catch { } } }, 5000);
    }
  } catch (e) { console.error('[mailbox] 初始化失败:', e.message); }   // 失败不得阻塞引擎启动
  // v5.7：主实例确保"调度会话"存在（承载所有雷影→main 消息）
  try {
    if (isMainInstance(cfg) && mailbox.available() && cfg.mailboxDispatcherForMain !== false) {
      const _dispRole = (cfg.agent && cfg.agent.role) || 'main';   // 产品版无 agent 块 → 兜底 'main'（防读 undefined.role 抛错）
      let disp = mailbox.getDispatcher(_dispRole);
      if (!disp || !runtime.sessionExists(disp)) {
        const s = runtime.createSession();
        s.title = '⚡ 调度中心'; s.project = 'dispatcher'; runtime.saveSession(s);
        mailbox.setDispatcher(_dispRole, s.id);
        disp = s.id;
      }
      console.log(`[mailbox] 调度会话就绪：${disp}`);
    }
  } catch (e) { console.error('[mailbox] 调度会话初始化失败:', e.message); }
  scheduler.resumeAll();
  // D3-③：启动兜底补标 —— 上一进程崩溃/重启时残留的 _pendingInbound 会话，若未运行则尽快 flush 落库
  try { const _sw = runtime.sweepPendingInbound(); if (_sw && _sw.sessions) console.log(`[inbound] 启动补标 sweep：会话 ${_sw.sessions} 个，补写 ${_sw.flushed} 条`); } catch { }
  // v6.47：唤醒丢失兜底——启动即扫"有未起回合处理的动作类入站" → 补唤醒（治主我 busy 时回执静默丢失）。
  try { setTimeout(() => { try { const _lw = runtime.sweepLostInboundWakes({ minAgeMs: 0 }); if (_lw && _lw.woke) console.log(`[mailbox-sweep] 启动唤醒丢失兜底：检查 ${_lw.checked}，补唤醒 ${_lw.woke}`); } catch { } }, 8000); } catch { }
  // v6.47：周期兜底（默认 90s；开关 mailboxLostWakeSweep=false 关）。
  try { if ((loadConfig().mailboxLostWakeSweep) !== false) { const _ls = setInterval(() => { try { runtime.sweepLostInboundWakes({}); } catch { } }, 90000); if (_ls && typeof _ls.unref === 'function') _ls.unref(); } } catch { }
  // v6.53：知情类回执「空闲兜底唤醒」周期扫描（默认 30s；开关 mailboxStaleInboundWake=false 关；阈值 mailboxStaleInboundWakeMs 默认 90s）。
  //   治：reply/ack/notify 无 cid → 既不驱动回合也不进未读续跑 → 主我空闲时永久漏收（实测 m-muo8el3o）。
  try { if ((loadConfig().mailboxStaleInboundWake) !== false) { const _ss = setInterval(() => { try { runtime.sweepStaleSilentInboundWakes({}); } catch { } }, 30000); if (_ss && typeof _ss.unref === 'function') _ss.unref(); } } catch { }
  // B②（2026-10-10）：已投递未消费兜底（delivered=1 且 injected_at IS NULL）——默认 30s 扫一次（unref）。
  try { const _du = setInterval(() => { try { runtime.sweepDeliveredUninjectedWakes({}); } catch { } }, 30000); if (_du && typeof _du.unref === 'function') _du.unref(); } catch { }
  // P6（refs=mailbox-structural）：注入租约超时回收孤儿——默认 90s 扫一次（unref）。
  //   对"已注入(processing)且注入时间超 staleTaskMs 且未回复"的行 reset 回 inbox，再由下一轮 drain 重扫。
  try { const _lz = setInterval(() => { try { const _mb = require('./mailbox'); if (_mb.sweepInjectedLeases) { const _n = _mb.sweepInjectedLeases({}); if (_n) console.log(`[mailbox] 注入租约超时释放 ${_n} 条回 inbox`); } } catch { } }, 90000); if (_lz && typeof _lz.unref === 'function') _lz.unref(); } catch { }
  // reflectStaging 兜底（v6.x 2026-10-02 修订）：**默认不再在启动期 drain** —— 服务端 prompt cache 不随进程重启清除，
  //   "启动"≠"无缓存小窗"；此刻写前缀会触发完整缓存重建（成本∝窗口长度），开发期频繁重启即每次白烧。
  //   改由 runChat「会话进小窗」时机顺带 drain（runtime.js，成本最低点）。此处仅保留可回滚开关 reflectDrainOnStartup（默认 false）。
  try { if (loadConfig().reflectDrainOnStartup === true) setTimeout(() => { try { Promise.resolve(runtime.drainReflectPendingAll({})).then((s) => { if (s && (s.done || s.failed)) console.log(`[reflect-drain] 启动兜底：会话 ${s.sessions} done=${s.done} failed=${s.failed} skipped=${s.skipped}`); }).catch(() => { }); } catch { } }, 2000); } catch { }
  // 周期兜底（flag-then-lazy-drain）：默认 24h（reflectDrainDueIntervalMs；0=关）仅**置脏标记**，真正落地由下一次紧贴请求执行——不给大窗会话付账。
  // A（2026-10-02）：reflect-pending 存量**一次性迁移**（开关 reflectPendingMigrate，默认跑一次；幂等，仅成功落 flag）。异常不影响启动。
  try { Promise.resolve(runtime.migrateReflectPending({})).then((s) => { if (s && (s.done || s.failed)) console.log(`[reflect-migrate] 存量迁移：sessions=${s.sessions} done=${s.done} failed=${s.failed} skipped=${s.skipped}`); }).catch(() => { }); } catch { }
  try { const _iv = Number(loadConfig().reflectDrainDueIntervalMs); const _ms = Number.isFinite(_iv) ? _iv : 86400000; if (_ms > 0) { const _rd = setInterval(() => { try { require('./pfxqueue').markPfxDue(); } catch { } }, _ms); if (_rd && typeof _rd.unref === 'function') _rd.unref(); } } catch { }   // A：markReflectDrainDue 已废弃，仅保留 pfx-due 置脏
  // 自检（零前缀代价）：启动打印 harness.md 指纹 + 最近一次已应用进化，供主我核对"规则是否被静默改过"。
  try {
    let _hMd5 = 'n/a';
    try { const { HARNESS_PATH } = require('./prompt'); _hMd5 = require('node:crypto').createHash('md5').update(fs.readFileSync(HARNESS_PATH)).digest('hex'); } catch { }
    let _ev = null;
    try { _ev = (evolution.list() || []).filter((p) => p && (p.status === 'applied' || p.status === 'auto-applied'))[0] || (evolution.list() || [])[0] || null; } catch { }
    console.log(`[self-integrity] harness.md md5=${_hMd5} lastEvo=${_ev ? (_ev.id || '-') : 'n/a'} title=${_ev ? (_ev.title || '-') : 'n/a'}`);
  } catch { }
  // P1 审计（2026-10-02）：启动核验前缀产物指纹，检出绕过 pfxWrite 的直写（开关 pfxQueue.auditBypass；异常绝不影响启动）。
  try { require('./pfxqueue').runAudit('startup'); } catch { }
  // Y-step1（2026-10-02）：一次性迁移器——支干 kind='prefix' → pfx_op(kind='intent')（开关 pfxQueue.intentMigrate；异常绝不影响启动；失败不落 flag → 下次重试）。
  try { const _mi = require('./pfxqueue').migrateReflectIntents(); if (_mi.already) console.log('[pfx-intent] already=true'); else console.log(`[pfx-intent] migrated open=${_mi.open} done=${_mi.done} inserted=${_mi.inserted} skipped=${_mi.skipped} sessions=${_mi.sessions}${_mi.disabled ? ' disabled=true' : ''}${_mi.error ? ' error=' + _mi.error : ''}`); } catch { }
  // 重启收尾机制（2026-10-02）：启动完成扫描 RESTART_IDS 登记"待重启"（低频；幂等）。
  try { const _rr = require('./pfxqueue').registerRestartNeeded(); const _ri = (_rr||[]).filter((x)=>x.inserted).length; if (_ri) console.log(`[pfx-restart] 待重启登记：新增 ${_ri} 条 / 扫描 ${(_rr||[]).length}`); } catch { }
  try { selftrain_task.start(); } catch { }   // 引擎级自训练飞轮：独立于任何对话窗口，后台自动转
  try { runtime.purgeTrash(); } catch { }   // 启动时自动清除超期(>30天)的回收站会话
  // P1：账本决定 → 支干 幂等种子迁移（开关 branchSeedFromLedger，默认 off → 不扫盘不写库）
  try { const _sd = runtime.seedBranchFromLedgerIfEnabled(); if (_sd && _sd.inserted) console.log(`[branch] 账本决定种子迁入：${_sd.sessions} 个会话 / ${_sd.inserted} 条`); } catch { }
});

server.on('error', (e) => {
  console.error('启动失败:', e.message);
  process.exit(1);
});

// 退出时释放所有 Python REPL / MCP 子进程，并清理守护进程记录
process.on('exit', () => { try { repl.killAll(); } catch { } try { require('./mcp').closeAll(); } catch { } try { if (fs.existsSync(DAEMON_PID)) fs.unlinkSync(DAEMON_PID); } catch { } try { const _mb = require('./mailbox'); if (_mb.available && _mb.available()) _mb.clearBusy(_mb.selfRole()); } catch { } });   // v6.31：进程退出清 busy（防重启间隙前端误显示"忙"）
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
