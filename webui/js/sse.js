// A1 前端 · SSE（T-C1）：对话流（POST /api/chat）+ 全局事件总线（GET /api/events）
// 严格按 sessionId 分发：后台回合（心跳/派活）事件只更态势/角标，不污染当前对话。
import { api } from './api.js';
import { store, ensureMessages, ensureStream, clearStream, pushEvent, pushInbound, clearInbound, toast,
  setBgRunning, clearBgRunning, setHandoffBusy, clearHandoffBusy,
  setQueuedPos, clearQueuedPos, setTurnProgress, clearTurnProgress, finalizeSessionTools,
  setBgBatchItem, clearBgBatch, markResultUnread, pushTurnPoint } from './store.js';
import { maybeRefreshAgg } from './vitals-agg.js';
// 任务B：模型不可用 → 常驻横幅（单向依赖：sse.js → llm-status.js，无环）
import { handleLlmStatus, showLlmUnavailable } from './llm-status.js';
// A1 桌面通知闭环：壳原生通知桥 + 角色中文名（未聚焦/非当前会话/urgent 时弹托盘气泡）
import { bridge } from './bridge.js';
import { roleMeta, roleName } from './roles.js';

// —— 全局事件总线 ——
let _es = null;
let _everOpened = false;   // v3.2：是否曾成功连接过（用于区分"首次连接"与"断线重连"）
const _handlers = {};   // event -> [fn]
// v6.52（正文重复修复）：本连接**自身发起**的回合（chat()）——其正文由 HTTP 流 handleFrame 独占写 st；
//   引擎 P2 后无条件广播 turn-stream（供无本地流的内部回合/其他连接实时上屏），若本连接也消费 → 双写同段正文（累积重复）。
const _localStreams = new Set();
export function onServerEvent(name, fn) { (_handlers[name] || (_handlers[name] = [])).push(fn); }

export function startGlobalEvents() {
  if (_es) return;
  try {
    _es = new EventSource('/api/events');
    // v3.2 根治：SSE 断线重连后**自动补拉**（此前只置 connected=false，重连不回补 → 断连窗口及此后的
    //   雷影回执/助手回复永久不上屏，刷新才见）。判据：onopen 时先前 connected===false（首次连接不补拉，boot 已拉过）。
    _es.onopen = () => {
      // _everOpened：首次连接不算"重连"（boot 已拉过历史），避免无谓重复补拉
      const reconnected = _everOpened && store.connected === false;
      _everOpened = true;
      store.connected = true;
      if (reconnected) { try { resyncAfterReconnect(); } catch { } }
    };
    _es.onerror = () => { store.connected = false; };
    // v6.20：补 'evolution'（引擎 server.js broadcast 已有该事件，此前监听数组漏了 → 涟漪流看不到进化）
const names = ['reflect', 'turn-done', 'schedule', 'compacted', 'evolution', 'mailbox-message', 'turn-progress', 'turn-watchdog', 'llm-status', 'agent-busy', 'mailbox-consumed', 'mailbox-replied', 'ask-user', 'turn-stream'];
    for (const n of names) {
      _es.addEventListener(n, (e) => {
        let d = null; try { d = JSON.parse(e.data); } catch { }
        // v6.5：一次世代交接会广播两条 compacted（A:非final带dropped；B:final仅摘要填完）。
        //   feed 只渲染非 final 的一条（见 feed.js 过滤/文案），final 仅为文档原位更新，不入态势流 → 消除重复条。
        // v6.21：turn-progress / turn-watchdog 是"进度/看门狗"信号（前者每工具调用都 emit），
        //   只驱动进度条与卡死处理，**不进涟漪流**（否则刷屏 + 显示英文类型名）。
        // v6.43：llm-status 是"模型可用性"信号（每次 LLM 调用都 emit），只驱动横幅、不是事件 → 同样不入涟漪流
        // v6.49：agent-busy / mailbox-consumed / mailbox-replied 是「状态信号」（驱动忙闲动效/角标/任务脊点亮），
        //   非「事件」→ 不进涟漪流 store.events（它们仍由 _handlers 正常分发，消费方不受影响）。
        // v6.50：ask-user 是「询问信号」（驱动 composer 上方询问卡片），非涟漪流「事件」→ 不入 store.events
        // v6.51：turn-stream 是「实时流信号」（内部回合的正文/推理增量），非涟漪流「事件」→ 不入 store.events
        if (!['turn-progress', 'turn-watchdog', 'llm-status', 'agent-busy', 'mailbox-consumed', 'mailbox-replied', 'ask-user', 'turn-stream'].includes(n)) pushEvent({ type: n, data: d, at: d && d.at });   // v6.53c：透传服务端 at
        if (n === 'compacted') applyCompacted(d || {});
        // v6.51：内部回合（弹窗答案/回执唤醒）正文实时上屏——引擎走全局事件 turn-stream（前端发起回合仍走 handleFrame，不受影响）。
        if (n === 'turn-stream') {
          const sid = d && d.sessionId;
          // v6.52：本连接发起的回合（_localStreams 登记）忽略该广播——其正文已由 handleFrame 写入，避免双写重复。
          if (sid && d && !_localStreams.has(sid)) {
            const st = ensureStream(sid);
            if (d.kind === 'reasoning') st.reasoning += (d.delta || '');
            else st.content += (d.delta || '');
            // 内部回合无 start 事件 → 借流信号续命"后台处理中…"（与 turn-progress 同策略）
            if (!store.running[sid]) setBgRunning(sid, (store.bgRunning[sid] && store.bgRunning[sid].kind) || 'bg');
          }
        }
        // v6.23：turn-done 必须同时清 store.running[sid] —— 否则残留 true 会让 reloadSessionOnTurnDone 的守卫
        //   永久跳过刷新（"达上限+续跑"期间用户又发了消息 → 本窗口 running=true → 回合结束后当前窗口永不刷新，
        //   必须切会话才看到"达到上限"那条）。注意：**不清 queuedPos**（排队指示由后续 start 事件清）。
        if (n === 'turn-done') {
          const sid = d && d.sessionId;
          clearBgRunning(sid); clearHandoffBusy(sid);
          if (sid) { store.running[sid] = false; finalizeSessionTools(sid, 'error'); clearTurnProgress(sid); clearBgBatch(sid); clearStream(sid); }   // v6.51：补清实时流（内部回合内容已由 reloadSessionOnTurnDone 落历史，防残留）；v8.7：清流前先把"运行中"工具收敛为终态，防停止后 spinner 不收
          pushTurnPoint(sid, d && d.usage);   // 实时态势曲线：每回合追加一点（任意会话，按 sid 分组）
          try { maybeRefreshAgg(sid); } catch { /* P1 聚合刷新失败不影响主流程 */ }
          reloadSessionOnTurnDone(sid);
        }
        // v6.6 卡死根治：进度事件（前台走 handleFrame；此处兜底后台回合）
        // v6.23：进度事件 = 该会话"确实还在处理"的活证据 → 续命"后台处理中…"（bgRunning 有 150s TTL，
        //   长回合/续跑链会过期导致窗口看起来空闲 → 这里每次进度都重新计时）。
        if (n === 'turn-progress') {
          const sid = d && d.sessionId;
          if (sid) { setTurnProgress(sid, d); if (!store.running[sid]) setBgRunning(sid, (store.bgRunning[sid] && store.bgRunning[sid].kind) || 'bg'); }
        }
        if (n === 'turn-watchdog') {
          const sid = d && d.sessionId;
          if (sid) { store.running[sid] = false; clearQueuedPos(sid); clearTurnProgress(sid); }   // 清 running（防卡死）
          if (!sid || sid === store.currentId) {
            const sec = Math.round((((d && d.elapsedMs) || 180000)) / 1000);
            toast('回合已超时中止（无进展 ' + sec + ' 秒）', 'err');
          }
        }
        if (n === 'mailbox-message') { onMailboxMessage(d || {}); onMailboxAwakeHint(d || {}); }
        // 任务B：模型服务可用性（每次 LLM 调用成功/失败）→ 横幅显示/隐藏
        if (n === 'llm-status') handleLlmStatus(d || {});
        for (const fn of (_handlers[n] || [])) { try { fn(d); } catch { } }
      });
    }
    // 会话列表变更（外部 API create/trash/restore/delete/patch）：通知已注册的刷新回调
    _es.addEventListener('sessions-changed', (e) => {
      let d = null; try { d = JSON.parse(e.data); } catch { }
      for (const fn of (_handlers['sessions-changed'] || [])) { try { fn(d); } catch { } }
    });
    _es.addEventListener('error', () => { /* EventSource 自动重连 */ });
  } catch (e) { /* 环境不支持 */ }
}

// v6.44：雷影忙碌态变更 → 即时刷新本会话雷影栏 chip（去掉 4s 轮询延迟）
onServerEvent('agent-busy', () => { if (window.__leizaiReloadSessionAgents) window.__leizaiReloadSessionAgents(); if (window.__leizaiReloadAgents) window.__leizaiReloadAgents(); });

// 会话级预算同步：仅当事件属于当前会话时刷新进度条（避免把别会话用量画到当前条上）
function syncBudgetIfCurrent(sid, stats) {
  try {
    if (!stats) return;
    if (sid && sid !== store.currentId) return;
    if (window.__leizaiSyncBudget) window.__leizaiSyncBudget(stats);
    else store.stats = store.stats;   // 钩子未就绪时保持原行为（无副作用）
  } catch { }
}

// —— 后台回合（心跳/派活）内容推送 ——
// 引擎每轮结束 broadcast('turn-done',{sessionId})，但此前前端只把它 pushEvent 进态势流，
// 不刷新 store.messages → 心跳内容已落库却不出现在聊天区（主人误判"心跳没用"）。
// 这里：turn-done 属于【当前会话】且该会话【未在跑】时，重载消息（300ms 防抖，避免与 chat() 结束的重载重复）。
// 是否自动滚动/给出"有新内容"提示，交由 core.js 的判断（不打断主人上滚阅读）。
let _tdReloadTimer = null;
/** v6.23：回合结束时"是否应刷新当前窗口"的判据（导出以便单测）。
 *  仅当"当前会话 + 本窗口正在流式输出自己的回合（无排队等待）"时跳过（避免冲掉实时流）；
 *  仅排队等待（queuedPos>0，尚无流内容）→ 必须刷新，否则后台回合结束时当前窗口永不更新
 *  （旧版缺陷：running 残留 true → 守卫永久跳过 → 须切会话才看到"达到上限"那条）。 */
export function shouldReloadOnTurnDone(sid) {
  if (!sid || sid !== store.currentId) return false;
  const queued = !!(store.queuedPos && store.queuedPos[sid]);
  return !(store.running[sid] && !queued);
}
// v6.x 修法D（历史=权威 + 时间护栏）：回合结束/重连/handoff 重建后统一清理实时入站气泡。
//   旧逻辑只在"历史里找到对应 _inbound 标记"时才清 → 标记会因两处丢失而永远清不掉（孤儿气泡永久驻留底部）：
//     ① 忙时到达只入内存队列 _pendingInbound（重启即丢）→ 标记永不写历史；
//     ② 世代交接重建窗口 → 旧窗口的 _inbound 标记被归档 → 当前历史查不到。
//   新逻辑：**以历史快照为权威** —— 重拉历史后，凡 ts ≤ 快照时刻的实时气泡一律清除（不再要求"必须找到标记"）；
//   仅保留 ts > 快照时刻 的气泡（时间护栏，防误清重拉期间刚到的新气泡）。锚点集合只用于诊断日志。
function reconcileInbound(sid, messages, snapshotAt) {
  const live = (store.inbound && store.inbound[sid]) || [];
  if (!live.length) return;
  const snap = Number(snapshotAt) || Date.now();
  const ids = new Set();
  for (const m of messages || []) {
    const ib = m && m._inbound;
    if (!ib) continue;
    if (ib.msgId != null) ids.add('id:' + String(ib.msgId));
    ids.add('k:' + [ib.from, ib.ts].join('|'));
  }
  let cleared = 0, anchored = 0;
  store.inbound[sid] = live.filter((it) => {
    if (!it) return false;
    const ts = Number(it.ts) || 0;
    if (ts > snap) return true;               // 时间护栏：快照之后到达的新气泡 → 保留
    const hit = (it.msgId != null && ids.has('id:' + String(it.msgId)))
      || ids.has('k:' + [it.from, it.ts].join('|'));
    if (hit) anchored++; else cleared++;
    return false;                             // 快照时刻之前的实时气泡 → 历史已成权威，一律清除
  });
  try { if (cleared || anchored) console.debug(`[inbound] reconcile ${sid}: 清除实时气泡 ${cleared} 个（其中历史有锚点 ${anchored}），保留(快照后新到) ${(store.inbound[sid] || []).length} 个`); } catch { }
}

// —— v3.2：断线重连补拉（根治"重启后消息不上屏"）——
//  ① 涟漪事件：重拉 /api/events/history 全量 → 与 store.events 按 `at|type` 去重合并（已存在的绝不重复 push）。
//  ② 当前会话：重拉会话消息（历史=权威）→ 覆盖 store.messages[sid] + reconcileInbound（仅清"历史上已有标记"的
//     实时气泡，忙时未落库的保留 —— 复用 v3.1 修法A，不回归入站气泡功能）。
//  ③ 未读信箱/未送达角标：经本地事件 'reconnect' 通知 app.js（refreshMailbox/refreshUndelivered），避免循环依赖。
//  **补拉失败静默**（绝不影响 SSE 主链路）；仅在"先前已断开"时触发，首次连接不重复拉（boot 已拉）。
export async function resyncAfterReconnect() {
  // ① 事件历史合并去重
  try {
    if (typeof window !== 'undefined' && typeof window.__leizaiResyncEvents === 'function') {
      await window.__leizaiResyncEvents();   // app.js 的 loadEventHistory（复用其去重逻辑，节流）
    } else {
      const h = await api.eventsHistory(500);
      if (h && Array.isArray(h.items) && h.items.length) {
        const seen = new Set(store.events.map((e) => (e && e.at) + '|' + (e && e.type)));
        const merged = store.events.slice();
        for (const it of h.items) {
          const k = (it && it.at) + '|' + (it && it.type);
          if (!seen.has(k)) { merged.push(it); seen.add(k); }
        }
        store.events = merged.slice(0, 200);
      }
    }
  } catch { }
  // ② 当前会话消息补拉（历史权威；断连窗口内的回执/助手回复就在这里）
  try {
    const sid = store.currentId;
    if (sid) {
      const snapAt = Date.now();   // 历史快照时刻（时间护栏基准：晚于此刻的实时气泡不清）
      const s = await api.session(sid);
      if (s && Array.isArray(s.messages)) {
        store.messages[sid] = s.messages.map(normalizeMsg);
        reconcileInbound(sid, s.messages, snapAt);
        if (s.stats) syncBudgetIfCurrent(sid, s.stats);
      }
    }
  } catch { }
  // ③ 通知宿主刷新未读信箱/未送达角标与会话列表
  try { for (const fn of (_handlers['reconnect'] || [])) { try { fn({}); } catch { } } } catch { }
}

function reloadSessionOnTurnDone(sid) {
  if (!shouldReloadOnTurnDone(sid)) return;
  if (_tdReloadTimer) clearTimeout(_tdReloadTimer);
  _tdReloadTimer = setTimeout(async () => {
    _tdReloadTimer = null;
    if (!shouldReloadOnTurnDone(sid)) return;   // 防抖窗口内状态可能已变
    try {
      const snapAt = Date.now();
      const s = await api.session(sid);
      if (s && Array.isArray(s.messages)) {
        store.messages[sid] = s.messages.map(normalizeMsg);
        reconcileInbound(sid, s.messages, snapAt);   // 历史已成权威：清空实时气泡，防"永久驻留底部"与历史标记重复
        if (s.stats) syncBudgetIfCurrent(sid, s.stats);
      }
    } catch { }
  }, 300);
}

// —— v6.1：雷影入站消息"实时上屏" ——
// 引擎广播 mailbox-message（带完整正文供预览/展开；正文不进 LLM 上下文）。
// 当前会话 → 追加到 store.inbound 由组件渲染；非当前会话 → 仅刷新会话列表角标，不污染当前窗口。
function onMailboxMessage(d) {
  if (!d || !d.from) return;
  if (d.outbound || d.from === 'main') return;   // v6.53：出站（主我→雷影）只进涟漪流（pushEvent 已发），绝不复用入站气泡/角标/通知逻辑
  const sid = d.sessionId;
  const item = { from: d.from, type: d.type || 'task', preview: d.preview || d.full || '', full: d.full || d.preview || '', msgId: d.msgId || null, ts: d.ts || Date.now() };
  // P2b-3（美工）L1：累积本回合入站批次（无论是否当前会话），供会话列表"处理 N 条回执（role…）"精确化。
  setBgBatchItem(sid, { type: item.type, from: item.from });
  // P2b-3（美工）：非当前会话收到「应答/回执」→ 打"新结果未看"小点（进入该会话即清）。
  if ((item.type === 'reply' || item.type === 'result') && sid && sid !== store.currentId) markResultUnread(sid);
  if (sid && sid === store.currentId) {
    pushInbound(sid, item);
  } else {
    // 非当前会话：刷新会话列表 / 雷影角标（复用已有刷新回调，容错）
    try { if (window.__leizaiReloadSessionAgents) window.__leizaiReloadSessionAgents(); } catch { }
    try { if (window.__leizaiRefreshSessions) window.__leizaiRefreshSessions(); } catch { }
  }
  // A1 桌面通知闭环：不合适时机不打扰；不改动上面的上屏/角标逻辑
  maybeDesktopNotify(d);
}

// —— A1 桌面通知闭环（壳原生托盘气泡）——
// 触发：①消息不属于当前会话；②窗口未聚焦/隐藏；③priority==='urgent'（聚焦也通知）。
// 节流：同一 sessionId 3 秒内最多 1 条；bridge.available===false（普通浏览器）静默跳过（不引入 Web Notification）。
const NOTIFY_THROTTLE_MS = 3000;
const _notifyLastTs = new Map();   // sessionId -> 上次通知时间
function maybeDesktopNotify(d) {
  if (!d || !d.from) return;
  if (!bridge || bridge.available === false) return;   // 降级：非 WebView2，静默跳过
  const sid = d.sessionId || '';
  const urgent = d.priority === 'urgent';
  const notCurrent = !!sid && sid !== store.currentId;
  let unfocused = false;
  try { unfocused = (typeof document !== 'undefined') && (document.hidden === true || document.hasFocus() === false); } catch { }
  if (!urgent && !notCurrent && !unfocused) return;    // 当前会话 + 窗口聚焦 + 非紧急 → 不打扰
  const now = Date.now();
  if (now - (_notifyLastTs.get(sid) || 0) < NOTIFY_THROTTLE_MS) return;   // 3s 节流
  _notifyLastTs.set(sid, now);
  const meta = { name: roleName(d.from) };
  const TYPE_LABEL = { reply: '回执', task: '派活', notify: '通知', ack: '确认' };
  // v6.48：name 已是「雷影·X」全名（main=「主我」）→ 去掉硬编码前缀，避免「雷影·雷影·X」
  const title = `${meta.name} ${TYPE_LABEL[d.type] || '回执'}`;
  const raw = String(d.preview || d.full || d.text || d.content || '').replace(/\s+/g, ' ').trim();
  const body = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
  try { Promise.resolve(bridge.notify(title, body)).catch(() => { }); } catch { }
}

// v6.1.5：雷影消息到达 = 该会话**可能**被唤醒起一轮（引擎 event 端点对空闲会话 wakeMailbox）。
// v6.53（2026-09-29）：修「状态指示误导」——**只有会真正唤醒的类型**才置"后台处理中"。
//   按 v6.26/R13 设计：reply/ack/notify **不驱动唤醒**（主我不起回合、不回复，防回执乒乓），
//   故前端不得乐观标"处理中"（避免用户体感"在处理却无回复"）。
//   判定：type==='task' 或 负载含 wake_intent='actionable'（首个关单类可唤醒发起方）→ 置忙；
//   其余（reply/ack/notify，非 actionable）→ 不置忙（气泡照常由 onMailboxMessage 上屏）。
function onMailboxAwakeHint(d) {
  if (d && (d.outbound || d.from === 'main')) return;   // v6.53：出站派活不触发"后台处理中"（那是入站唤醒语义）
  const sid = d && d.sessionId;
  if (!sid || store.running[sid]) return;
  const actionable = d && (d.wake_intent === 'actionable' || d.wakeIntent === 'actionable');
  const wakes = (d && d.type === 'task') || actionable;
  if (!wakes) return;   // 非唤醒类（reply/ack/notify 等）：不进入"处理中"态
  setBgRunning(sid, 'task');
}

// —— compacted 分发（T-C5①，O-4/O-6）——
// 骨架版（无 final）：拉最新会话消息重建对话窗口（旧气泡移出），底部插「第 N 代交接」分隔条（图形由 gen-divider 插入）。
// final 版（final:true + summary）：仅原位替换顶部交接文档卡（不整窗重建、无闪烁）。
export async function applyCompacted(d) {
  const sid = d && d.sessionId;
  if (!sid) return;
  if (d.final && d.summary) {
    updateHandoffDoc(sid, d.summary);
    // M1 修补：本分支是「交接文档落定」事件（早返回），历史已成权威 → 同样清空实时入站气泡
    //（否则 final 分支跳过下方 L268 的清空，旧窗口气泡残留成孤儿）
    if (store.inbound) store.inbound[sid] = [];
    // 交接卡分支（早返回）也要同步预算——交接是"预算骤降"关键时机
    if (sid === store.currentId) { try { const s = await api.session(sid); if (s && s.stats) syncBudgetIfCurrent(sid, s.stats); } catch { } }
    return;
  }
  try {
    const snapAt = Date.now();
    const s = await api.session(sid);
    if (s && Array.isArray(s.messages)) {
      store.messages[sid] = s.messages.map(normalizeMsg);
      // D3-④：交接重建窗口 → 历史=权威，清空全部实时气泡（旧窗口 _inbound 标记已被归档，靠"必须找到标记"永远清不掉）
      if (store.inbound) store.inbound[sid] = [];
      reconcileInbound(sid, s.messages, snapAt);
      const gen = (d && d.gen) || (s.stats && s.stats.gen) || 0;   // v6.53c：代数单源——优先事件权威 gen，回退 stats.gen（均为归档 gen），不再用本地 compactions
      // v6.5：gen 拿不到(缺失/0)时降级为「世代交接」，不要显示 '?'（问号令用户困惑）
      const divText = gen ? ('第 ' + gen + ' 代交接') : '世代交接';   // v6.45：文案去 emoji（图形由 gen-divider 模板插入）；「第 N 代」正则提取不受影响
      const div = { role: '_divider', content: divText, _divider: true, at: d.at || Date.now() };
      store.messages[sid].push(div);
      // v6.1.5：非 final compacted = 本回合"正在做世代交接"→ 显示「第 N 代交接中…」直到 turn-done
      setHandoffBusy(sid, gen);
    }
    // 交接发生时用同一次返回的 stats 同步预算（仅当前会话）
    if (s && s.stats) syncBudgetIfCurrent(sid, s.stats);
  } catch { }
  if (d.final) updateHandoffDoc(sid, null);
}

function updateHandoffDoc(sid, summary) {
  const list = ensureMessages(sid);
  const i = list.findIndex((m) => m && m._compaction);
  // v6.51：引擎广播的 summary（HANDOFF_BRANCH_GUIDE）可能已含 '[上下文摘要] ' 前缀 → 拼接前先剥除，防双前缀。
  const clean = String(summary || '').replace(/^\s*\[上下文摘要\]\s*/, '');
  if (i >= 0 && summary) { list[i] = Object.assign({}, list[i], { content: '[上下文摘要] ' + clean, _compaction: true }); return; }
  if (summary) list.unshift({ role: 'assistant', content: '[上下文摘要] ' + clean, _compaction: true });
}

// —— A 组「引擎自动追加块」前端剥离（净化渲染；不改模型输入/持久化/计数）——
//   成对块：完整匹配任意位置；独立块：仅剥「文末连续」块（块须以行首/文首开头，防误伤用户正文句中提及）。
const A_PAIRED_STRIP = [
  /【相关自我认知】[\s\S]*?【\/相关自我认知】/g,
  /【领域分流】[\s\S]*?【\/领域分流】/g,
];
const A_TAIL_STRIP = /(?:^|\n{2,})(?:\*\*)?(?:⛔\s*|⚠️\s*)?【(?:调度员守则|本代已自动交接|强制前置任务|待补前缀未完成|待补前缀操作)[\s\S]*$/;

/** 剥离 A 组注入块。返回 { text, changed }（不修改入参）。 */
export function stripEngineBlocks(text) {
  let t = String(text == null ? '' : text);
  const before = t;
  let prev;
  do { prev = t; for (const re of A_PAIRED_STRIP) t = t.replace(re, ''); } while (t !== prev);   // 成对块循环剥
  do { prev = t; t = t.replace(A_TAIL_STRIP, ''); } while (t !== prev);                          // 独立尾块循环剥
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: t, changed: t !== before };
}

// 会话首条 _compaction 消息 → 交接文档卡（T-C5②，O-4）
export function normalizeMsg(m) {
  if (!m) return m;
  const c = typeof m.content === 'string' ? m.content : '';
  const patch = {};
  // 先算 _compaction（用原文，不因剥离而误判）
  patch._compaction = !!m._compaction || /^\s*\[上下文摘要\]/.test(c);
  if (typeof m.content === 'string') {
    const r = stripEngineBlocks(m.content);
    if (r.changed) {
      patch._raw = m.content; patch.content = r.text;
      if (!r.text && !patch._compaction) patch._hidden = true;   // 剥空 → 不渲染该气泡
    }
  } else if (Array.isArray(m.content)) {
    let changedAny = false;
    const parts = m.content.map((p) => {
      if (p && p.type === 'text') { const r = stripEngineBlocks(p.text); if (r.changed) changedAny = true; return Object.assign({}, p, { text: r.text }); }
      return p;
    });
    if (changedAny) {
      const kept = parts.filter((p) => !(p && p.type === 'text' && !String(p.text || '').trim()));   // 只清空 text 段，保留 image
      const hasText = kept.some((p) => p && p.type === 'text' && String(p.text || '').trim());
      const hasImg = kept.some((p) => p && p.type === 'image_url');
      patch._raw = m.content; patch.content = kept;
      if (!hasText && !hasImg) patch._hidden = true;
    }
  }
  return Object.assign({}, m, patch);
}

// —— 对话流（POST /api/chat，流式）——
// 返回 { stop() }。按 sessionId 隔离：切会话不中断（流继续写回对应 sessionId 的 streams）。
export function chat(sessionId, message, opts) {
  opts = opts || {};
  const ac = new AbortController();
  const st = clearStream(sessionId);
  store.running[sessionId] = true;
  _localStreams.add(sessionId);   // v6.52：登记本连接本地流（turn-stream 据此跳过，防双写）

  (async () => {
    let resp;
    try {
      resp = await fetch('/api/chat', {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message, forceReflect: !!opts.forceReflect, images: opts.images, attachments: opts.attachments, mentionSessionIds: opts.mentionSessionIds }),
      });
    } catch (e) {
      store.running[sessionId] = false;
      if (e.name !== 'AbortError' && !opts.quiet) toast('连接失败: ' + e.message, 'err');
      return;
    }
    if (!resp.ok || !resp.body) {
      store.running[sessionId] = false;
      try { const t = await resp.text(); if (!opts.quiet) toast('对话失败: ' + t.slice(0, 160), 'err'); } catch { }
      return;
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          handleFrame(frame, sessionId, st);
        }
      }
    } catch (e) { if (e.name !== 'AbortError' && !opts.quiet) toast('流中断: ' + e.message, 'err'); }
    // finally：清 running，并清排队/进度（回合真正结束）
    finally { store.running[sessionId] = false; finalizeSessionTools(sessionId, 'error'); clearQueuedPos(sessionId); clearTurnProgress(sessionId); _localStreams.delete(sessionId); }   // v8.7：流结束/被中止 → 先把残留"运行中"工具收敛为终态（停止后 spinner 不收）
    // 流结束：向服务端要最终消息（含工具结果落盘），刷新本会话
    try {
      const snapAt = Date.now();
      const s = await api.session(sessionId);
      if (s && Array.isArray(s.messages)) {
        store.messages[sessionId] = s.messages.map(normalizeMsg);
        // reload 成功后清空实时流：否则 live 气泡（stream.content）与落库 messages 同时渲染 = 同一条回复显示两次。
        // 放在成功分支内：reload 失败则保留流内容作兜底，避免回复消失。
        clearStream(sessionId);
        reconcileInbound(sessionId, s.messages, snapAt);   // 同步清实时入站气泡（历史=权威，防重复/残留/孤儿）
      }
      if (s && s.stats) syncBudgetIfCurrent(sessionId, s.stats);   // 回合结束：同步会话预算并重绘（替换原 no-op）
    } catch { }
  })();

  return { stop() { try { ac.abort(); } catch { } } };
}

function handleFrame(frame, sid, st) {
  let ev = null, data = null;
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) ev = line.slice(6).trim();
    else if (line.startsWith('data:')) { const raw = line.slice(5).trim(); try { data = JSON.parse(raw); } catch { data = { text: raw }; } }
  }
  if (!ev) return;
  switch (ev) {
    case 'queued': pushEvent({ type: 'queued', data }); setQueuedPos(sid, data && data.position); break;
    // v6.23: start = 引擎确认本轮已开始执行 → 恢复 running。
    //   排队等待期间 running 可能已被全局 turn-done 清掉，不清回来会导致
    //   '自己的回合正在流式输出却显示未在运行'（停止按钮失效 / 无生成计时）。
    case 'start': st.started = true; store.running[sid] = true; clearQueuedPos(sid); break;
    case 'reasoning': st.reasoning += (data && data.text) || ''; break;
    case 'delta': st.content += (data && data.text) || ''; break;
    case 'reset': st.content = ''; st.reasoning = ''; st.tools = []; break;
    case 'tool':
      st.tools.push({ index: data.index, name: data.name, args: data.args, result: null, open: false });
      break;
    case 'tool_result': {
      const t = st.tools[st.tools.length - 1];
      if (t) { t.outcome = data.outcome; t.summary = data.summary; }
      break;
    }
    case 'compacted': applyCompacted(data); break;
    case 'done': st.done = data; clearTurnProgress(sid); break;
    case 'turn-progress': setTurnProgress(sid, data || {}); break;
    case 'turn-watchdog': {
      store.running[sid] = false;
      clearQueuedPos(sid); clearTurnProgress(sid);
      const sec = Math.round((((data && data.elapsedMs) || 180000)) / 1000);
      toast('回合已超时中止（无进展 ' + sec + ' 秒）', 'err');
      break;
    }
    case 'mention-unfulfilled': {
      const _tg = (data && Array.isArray(data.targets)) ? data.targets.join('、') : '';
      toast('未转达：' + (_tg ? ('会话 ' + _tg + ' ') : '') + '未收到——请重试或让我再发', 'err');
      break;
    }
    case 'error': {
      const msg = (data && data.message) || '未知';
      // 任务B：模型服务不可用 → 常驻横幅 + 气泡内写明原因（不再只闪一个 toast）
      if (data && data.llmUnavailable) {
        try { showLlmUnavailable(data); } catch { }
        const why = data.llmReasonText || data.llmReason || msg;
        const note = '⚠ 模型服务不可用：' + why + (data.needsUserAction ? '（请按上述提示处理后重新发送）' : '（可点顶部横幅「重试」）');
        st.content = (st.content ? st.content.replace(/\s+$/, '') + '\n\n' : '') + note;
        store.running[sid] = false;
      } else {
        toast('运行错误: ' + msg, 'err');
      }
      break;
    }
  }
}
