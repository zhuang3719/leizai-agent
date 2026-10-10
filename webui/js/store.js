// A1 前端 · 全局响应式状态（T-C1）
import { reactive } from 'vue';

function ls(key, def) { try { const v = localStorage.getItem(key); return v === null ? def : v; } catch { return def; } }
function lsSet(key, v) { try { localStorage.setItem(key, v); } catch { } }

export const store = reactive({
  // 范式 P-1：双模式（全景 nexus ↔ 经典 classic），记忆用户偏好
  mode: ls('leizai.mode', 'nexus'),
  // 范式 P-2：低动态（系统 prefers-reduced-motion）
  reducedMotion: false,
  connected: false,
  env: (typeof window !== 'undefined' && window.__LEIZAI_ENV__) || {},

  lastSession: null,
  sessions: [],
  currentId: null,
  running: {},                 // sessionId -> bool
  messages: {},                // sessionId -> Message[]
  inbound: {},                 // sessionId -> 入站雷影消息（SSE 实时）[{from,type,preview,full,msgId,ts}]
  streams: {},                 // sessionId -> { content, reasoning, tools: [] }

  agents: [],
  mailbox: { roles: [], totalUnread: 0, available: true },
  self: { summary: '', snapshot: null },
  stats: null,
  sessionStats: null,          // 当前会话级指标（右栏"运行指标"用）
  sessionAgg: null,            // P1 聚合指标 {total,items,history}（右栏"运行指标"聚合态；未就绪=null）
  // 实时态势曲线（每回合一点，按 sessionId 分组，滚动窗口见 TURN_HISTORY_CAP）
  //   点结构 {at, hit(0~1 命中率), cost(miss+out token), miss, out, dur}
  historyBySession: {},
  balance: null,               // 账户余额（顶栏用）{isAvailable,currency,balance,...}
  // Pro 有效档位（单一权威，由 app.js 从 /api/pro/status.effective 派生写入；core.js 限额条判据用）
  pro: { effective: null, activated: false, reason: '', isDev: false, loaded: false, at: 0 },
  health: null,
  daemon: null,
  // 任务B：模型服务可用性（{ok, reason, reasonText, at, failStreak}；null=尚未探活）
  llm: null,

  defaultBudget: 0,            // v1：全局默认预算（config.contextBudget；顶栏「预算」显示此值，非本会话生效值）
  nexus: { budget: 0, used: 0, activity: 'idle', nodes: [], ripples: [], rings: [] },
  events: [],                  // 涟漪流（最近事件）
  toast: null,

  // v6.1.5：世代交接 / 后台回合「可见性」状态（前端由 SSE 事件推导，非引擎状态；带 TTL 兜底防卡死）
  bgRunning: {},               // sessionId -> true：后台回合（心跳/雷影唤醒）进行中的乐观标记
  handoffBusy: {},             // sessionId -> { gen, at }：非 final compacted 起，turn-done 清

  // 卡死根治（v6.6）：排队位置 + 回合进度（前端推导，带 TTL 兜底）
  queuedPos: {},               // sessionId -> position（排队中"前面还有 N 条"）
  turnProgress: {},            // sessionId -> { step, tool, iter, at }（正在调用 <tool> 第 N 步）

  // P2b-3（美工）L1 状态精确化：本回合入站批次（由 SSE mailbox-message 累积，turn-done 清）
  //   sessionId -> { byType: { reply: { roles:{role:true}, n }, task:{...} }, at }
  bgBatch: {},
  // P2b-3（美工）：非当前会话收到「新应答/回执」→ 会话列表打小点（进入会话即清）
  resultUnread: {},            // sessionId -> count

  // 界面状态
  view: 'nexus',               // 当前舱：nexus/core/dock/mirror/forge/console
  sessionQuery: '',            // 会话搜索
  mailboxCurrent: null,        // 当前查看的信箱 { role, entries, available }
  gen: {},                     // sessionId -> 当前世代号
  modal: null,                 // { title, html }
  palette: { open: false, query: '', items: [], idx: 0 },
  history: [],                 // 命中率/成本 迷你曲线
  classic: {},                 // 每舱经典子视图开关（P-7）：berth -> bool
});

export function setMode(m) { store.mode = m; lsSet('leizai.mode', m); }
export function setReducedMotion(v) { store.reducedMotion = v; }
// 统一「是否工作中」判定：动效看 busy、角标看 unread（收敛散落 5+ 处，改一处全站生效）
export function roleBusy(role) { const r = ((store.mailbox && store.mailbox.roles) || []).find((x) => x.role === role); return !!(r && r.busy); }

export function toast(msg, kind) {
  store.toast = { msg, kind: kind || 'info', at: Date.now() };
  setTimeout(() => { if (store.toast && Date.now() - store.toast.at >= 2400) store.toast = null; }, 2600);
}

// —— 会话/消息便捷操作 ——
export function setSessions(list) { store.sessions = Array.isArray(list) ? list : []; }
export function ensureMessages(id) { if (!store.messages[id]) store.messages[id] = []; return store.messages[id]; }
export function pushMessage(id, msg) { ensureMessages(id).push(msg); }
export function ensureStream(id) {
  if (!store.streams[id]) store.streams[id] = { content: '', reasoning: '', tools: [], open: true };
  return store.streams[id];
}
export function clearStream(id) { store.streams[id] = { content: '', reasoning: '', tools: [], open: true }; return store.streams[id]; }

// —— v8.7：回合结束/中止时「收敛运行中工具卡为终态」（防手动停止后工具卡 spinner 不收） ——
// 判据：tool.outcome ∈ 终态集合 = 已结束；缺失或中间态 = 仍在运行。
const TOOL_TERMINAL = { done: 1, ok: 1, error: 1, aborted: 1, cancelled: 1, canceled: 1 };
export function isTerminalTool(t) { return !!(t && TOOL_TERMINAL[t.outcome]); }
/** 把一组工具里所有「非终态」的收敛为终态，返回收敛条数（幂等）。 */
export function finalizeTools(list, outcome = 'error') {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const t of list) { if (t && !isTerminalTool(t)) { t.outcome = outcome; n += 1; } }
  return n;
}
/** 收敛某会话实时流里所有「运行中」工具（turn-done / 停止 / 流中止时调用）。 */
export function finalizeSessionTools(id, outcome = 'error') {
  const st = id && store.streams && store.streams[id];
  return st ? finalizeTools(st.tools, outcome) : 0;
}

export function ensureInbound(id) { if (!store.inbound[id]) store.inbound[id] = []; return store.inbound[id]; }
export function pushInbound(id, item) {
  const a = ensureInbound(id);
  // 去重：同一 msgId 不重复入列（SSE 重连/重投时防重复气泡；重复则以最新内容替换）
  if (item && item.msgId != null) {
    const i = a.findIndex((x) => x && x.msgId != null && String(x.msgId) === String(item.msgId));
    if (i >= 0) { a[i] = item; return a; }
  }
  a.push(item); if (a.length > 200) a.splice(0, a.length - 200); return a;
}
// v6.1.1：按 msgId 移除单条实时气泡（落库去重用）
export function removeInbound(id, msgId) {
  const a = store.inbound[id]; if (!a || !a.length) return a || [];
  store.inbound[id] = a.filter((it) => !(it && it.msgId != null && String(it.msgId) === String(msgId)));
  return store.inbound[id];
}
// v6.1.1：清空某会话的实时气泡（会话重载/切换时调用，防"永久驻留聊天底部"与内存累积）
export function clearInbound(id) { if (id && store.inbound[id]) store.inbound[id] = []; return store.inbound[id] || []; }

export function pushEvent(ev) {
  store.events.unshift(Object.assign({}, ev, { at: (ev && ev.at) || Date.now() }));   // v6.53c：保留事件自带的服务端 at（不再被客户端时间覆盖），与历史/聚合同源 → 去重键生效
  if (store.events.length > 200) store.events.length = 200;
}

// —— 实时态势曲线：按会话累积「每回合一点」的时序数据（数据源 turn-done.usage）——
export const TURN_HISTORY_CAP = 30;   // 滚动窗口：保留最近 30 点
/** 把一条 turn-done.usage 归一化为曲线点（无效输入返回 null）。 */
export function normalizeTurnUsage(usage, at) {
  if (!usage || typeof usage !== 'object') return null;
  const miss = Number(usage.missTokens) || 0;
  const out = Number(usage.outputTokens) || 0;
  return {
    at: at || Date.now(),
    hit: Math.max(0, Math.min(1, Number(usage.cacheHitRate) || 0)),   // 0~1
    cost: miss + out,                                                 // 实际计费 token
    miss, out,
    dur: Number(usage.durationMs) || 0,
  };
}
/** 追加一个回合点（赋值数组触发 Vue 响应式）；同会话滚动保留最近 CAP 点。 */
export function pushTurnPoint(sid, usage, at) {
  if (!sid) return;
  const pt = normalizeTurnUsage(usage, at);
  if (!pt) return;
  const arr = (store.historyBySession[sid] || []).slice();
  arr.push(pt);
  while (arr.length > TURN_HISTORY_CAP) arr.shift();
  store.historyBySession[sid] = arr;
}
/** 整批设置（回填用）；自动裁剪到最近 CAP 点。 */
export function setTurnHistory(sid, arr) {
  if (!sid) return;
  store.historyBySession[sid] = Array.isArray(arr) ? arr.slice(-TURN_HISTORY_CAP) : [];
}

// —— v6.1.5：世代交接 / 后台回合「可见性」辅助（前端推导 + TTL 兜底）——
// 说明：引擎未提供"回合开始/后台回合"事件，这里由 SSE（mailbox-message / compacted）推导，
//       并以 turn-done 为唯一正常清除信号；TTL 仅作事件缺失（崩溃/断连）时的兜底，防状态卡死。
const _bgTimers = {};
const _hsTimers = {};
export function setBgRunning(id, kind, ttlMs = 150000) {
  if (!id) return;
  try { clearTimeout(_bgTimers[id]); } catch { }
  // v6.52：补 at（起始时间戳，供 live-hint 显示后台耗时）；续命（重复调用）保留原起点，不重置。
  const prev = store.bgRunning[id];
  store.bgRunning[id] = { kind: kind || 'bg', at: (prev && prev.at) || Date.now() };
  _bgTimers[id] = setTimeout(() => { try { delete store.bgRunning[id]; } catch { } }, ttlMs);
}
export function clearBgRunning(id) {
  if (!id) return;
  try { clearTimeout(_bgTimers[id]); } catch { }
  try { delete store.bgRunning[id]; } catch { }
}
export function setHandoffBusy(id, gen, ttlMs = 150000) {
  if (!id) return;
  try { clearTimeout(_hsTimers[id]); } catch { }
  store.handoffBusy[id] = { gen: (gen == null || gen === '') ? '?' : gen, at: Date.now() };
  _hsTimers[id] = setTimeout(() => { try { delete store.handoffBusy[id]; } catch { } }, ttlMs);
}
export function clearHandoffBusy(id) {
  if (!id) return;
  try { clearTimeout(_hsTimers[id]); } catch { }
  try { delete store.handoffBusy[id]; } catch { }
}

// —— P2b-3（美工）L1：本回合入站批次累积 / 清除 ——
// 数据源：SSE mailbox-message（每条入站消息 {type, from}）；清除：turn-done。
export function setBgBatchItem(id, item) {
  if (!id || !item) return;
  const t = item.type || 'task';
  const b = store.bgBatch[id] || { byType: {}, at: 0 };
  const g = b.byType[t] || { roles: {}, n: 0 };
  g.n += 1;
  if (item.from) g.roles[item.from] = true;
  b.byType[t] = g; b.at = Date.now();
  store.bgBatch[id] = { byType: b.byType, at: b.at };
}
export function clearBgBatch(id) {
  if (!id) return;
  try { delete store.bgBatch[id]; } catch { }
}
// —— P2b-3（美工）：新应答/回执未看标记 ——
export function markResultUnread(id) {
  if (!id) return;
  store.resultUnread[id] = (store.resultUnread[id] || 0) + 1;
}
export function clearResultUnread(id) {
  if (!id) return;
  try { delete store.resultUnread[id]; } catch { }
}

// —— v6.6 卡死根治：排队位置 / 回合进度辅助（带 TTL 兜底，防事件缺失时状态卡死）——
const _qpTimers = {};
const _tpTimers = {};
// 排队位置：>0 有效；<=0 视为出队（清除）。TTL 150s 兜底（与 bgRunning/handoffBusy 同口径）。
export function setQueuedPos(id, pos) {
  if (!id) return;
  const p = Number(pos);
  if (!p || p <= 0) { clearQueuedPos(id); return; }
  try { clearTimeout(_qpTimers[id]); } catch { }
  store.queuedPos[id] = p;
  _qpTimers[id] = setTimeout(() => { try { delete store.queuedPos[id]; } catch { } }, 150000);
}
export function clearQueuedPos(id) {
  if (!id) return;
  try { clearTimeout(_qpTimers[id]); } catch { }
  try { delete store.queuedPos[id]; } catch { }
}
// 回合进度：正在调用的工具与步数（turn-progress 事件）；TTL 150s。
export function setTurnProgress(id, data) {
  if (!id) return;
  try { clearTimeout(_tpTimers[id]); } catch { }
  store.turnProgress[id] = {
    step: (data && data.step) || 0,
    tool: (data && data.tool) || '',
    iter: (data && data.iter) || 0,
    at: Date.now(),
  };
  _tpTimers[id] = setTimeout(() => { try { delete store.turnProgress[id]; } catch { } }, 150000);
}
export function clearTurnProgress(id) {
  if (!id) return;
  try { clearTimeout(_tpTimers[id]); } catch { }
  try { delete store.turnProgress[id]; } catch { }
}
