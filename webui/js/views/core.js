// A1 前端 · 核心舱（挂载 #msg-stream / #thread-tabs；#composer 命令式绑定）——多根渲染
import { defineComponent, computed, nextTick, watch, ref, onMounted, onUnmounted, Teleport } from 'vue';
import { store, toast, ensureMessages, ensureStream, finalizeSessionTools } from '../store.js';
import { api } from '../api.js';
import { roleMeta, ROLE_META, roleName, roleVar } from '../roles.js';
import { statusOf, roleInfo } from '../agent-status.js';
import { chat } from '../sse.js';
import { openImageLightbox } from '../image-lightbox.js';
import { Bubble, textOf, isProLimitText } from '../components/bubble.js';
import { ToolCard } from '../components/tool-card.js';
import { ToolGroup } from '../components/tool-group.js';
import { ThinkCard } from '../components/think-card.js';
import { HandoffCard } from '../components/handoff-card.js';
import { GenDivider } from '../components/gen-divider.js';
import { InboundBubble } from '../components/inbound-bubble.js';

export const MessageStream = defineComponent({
  name: 'MessageStream',
  components: { Bubble, ToolCard, ToolGroup, ThinkCard, HandoffCard, GenDivider, InboundBubble, Teleport },
  setup() {
    const sid = computed(() => store.currentId);
    const all = computed(() => (sid.value ? ensureMessages(sid.value) : []));
    const handoffMsg = computed(() => all.value.find((m) => m && m._compaction) || null);
    const handoffText = computed(() => (handoffMsg.value ? (typeof handoffMsg.value.content === 'string' ? handoffMsg.value.content.replace(/^\s*\[上下文摘要\]\s*/, '') : '') : ''));
    // v6.51：区分「零文档引导句」与「真实完整交接文档」——前者只渲染一行紧凑提示（不再套折叠卡片）。
    //   引导句特征：含 "已自动交接" 或 "project action=tree"，且为一行短句（真实文档为数千字，必被长度护栏排除）。
    const handoffGuide = computed(() => {
      const t = handoffText.value;
      return !!t && t.length < 300 && /已自动交接|project action=tree/.test(t);
    });
    const handoff = computed(() => (handoffGuide.value ? '' : handoffText.value));
    // 渲染列表：用户消息 + 有文本的 assistant；剔除 role='tool' 工具结果与空文本 assistant。
    // 每个"带 toolCalls 的 assistant 轮次"聚合为一个折叠 ToolGroup（与 live 流体验一致）。
    const HISTORY_TOOL_OUT_CAP = 8000;   // 单行详情全文上限（超出截断，避免超大 DOM）
    function resultSummary(toolMsg, cap = 200) {
      const c = (toolMsg && typeof toolMsg.content === 'string') ? toolMsg.content : '';
      const first = c.split('\n').find((s) => s.trim()) || '';
      const s = first.trim();
      return s.length > cap ? s.slice(0, cap) + '…' : s;
    }
    function buildTools(calls, byCall) {
      return calls.map((tc) => {
        const tm = byCall.get(tc && tc.id);
        const raw = (tm && typeof tm.content === 'string') ? tm.content : '';
        const head = raw.split('\n').find((s) => s.trim()) || '';
        const isErr = /^\s*(\[?工具错误|\[?Error|error:|工具报错)/i.test(head);
        return {
          name: (tc && tc.name) || 'tool',
          args: tc && tc.arguments,
          outcome: isErr ? 'error' : 'done',
          summary: resultSummary(tm, 200),
          out: raw.length > HISTORY_TOOL_OUT_CAP ? raw.slice(0, HISTORY_TOOL_OUT_CAP) + '\n…（结果过长，已截断）' : raw,
        };
      });
    }
    // 同一"轮次"（两条 user 消息之间 / 以 _divider 为界）内的所有 toolCalls 汇成一个 ToolGroup，
    // 置于该轮第一个工具步骤位置；文本气泡仍逐个渲染。
    const view = computed(() => {
      const arr = all.value || [];
      const byCall = new Map();
      for (const m of arr) { if (m && m.role === 'tool' && m.toolCallId != null) byCall.set(m.toolCallId, m); }
      const out = [];
      let curCalls = null;   // 本轮聚合的 toolCalls 数组（null = 本轮尚未出现工具步骤）
      const flush = () => { if (curCalls && curCalls.length) curCalls.item.tools = buildTools(curCalls, byCall); curCalls = null; };
      for (const m of arr) {
        if (!m) continue;
        if (m._hidden) continue;   // 引擎自动块被剥空 → 不渲染（不改 store.messages 计数）
        if (m._compaction) continue;
        if (m._divider) { flush(); out.push({ kind: 'divider', m }); continue; }
        if (m.role === 'tool') continue;
        if (m.role === 'user') { flush(); out.push(m._inbound ? { kind: 'inbound', m } : { kind: 'bubble', m }); continue; }   // 轮次边界（_inbound=雷影入站标记）
        if (m.role === 'assistant') {
          const text = (typeof m.content === 'string') ? m.content : '';
          const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
          if (text.trim()) out.push({ kind: 'bubble', m });
          if (calls.length) {
            if (!curCalls) { curCalls = []; curCalls.item = { kind: 'tools', tools: [] }; out.push(curCalls.item); }
            for (const c of calls) curCalls.push(c);
          }
          continue;   // 空文本且无 toolCalls 的 assistant 不渲染（无空气泡）
        }
        out.push({ kind: 'bubble', m });   // 其它
      }
      flush();
      return out;
    });
    const msgs = computed(() => view.value.filter((it) => it.kind === 'bubble').map((it) => it.m));
    const inboundLive = computed(() => (sid.value ? (store.inbound[sid.value] || []) : []));
    const stream = computed(() => (sid.value ? ensureStream(sid.value) : null));
    const running = computed(() => !!(sid.value && store.running[sid.value]));
    // v6.1.5：交接中 / 后台回合（心跳/雷影唤醒）可见性
    const handoffBusy = computed(() => (sid.value ? (store.handoffBusy[sid.value] || null) : null));
    const bgRunning = computed(() => !!(sid.value && store.bgRunning[sid.value]));
    // v6.6 卡死根治：排队位置 + 回合进度 + 处理中耗时
    const queuedPos = computed(() => (sid.value ? (store.queuedPos[sid.value] || 0) : 0));
    const turnProgress = computed(() => (sid.value ? (store.turnProgress[sid.value] || null) : null));
    // v6.23：后台处理中的"活证据"——只要有回合进度事件（含续跑轮心跳），窗口就显示处理中，
    //   不受 bgRunning 150s TTL 过期影响（长回合/续跑链期间窗口不再看似空闲）。
    const bgActivity = computed(() => !!(sid.value && !running.value && (store.bgRunning[sid.value] || store.turnProgress[sid.value])));
    const bgKind = computed(() => { const b = sid.value && store.bgRunning[sid.value]; return (b && b.kind) || 'bg'; });
    // v6.53：kind 仅 'task'（唤醒类）/'bg'/'handoff'；'reply' 分支已废（reply 不再置忙，见 sse.js onMailboxAwakeHint）
    const bgBase = computed(() => bgKind.value === 'task' ? '后台核心 · 派单能量注入中'
      : '后台核心 · 能量流转中');
    // v2：后台文案附耗时（中文格式）
    const bgText = computed(() => bgBase.value + ' · ' + fmtDur(bgDur.value));

    const elapsed = ref(0);          // 前台已跑秒数
    const nowTs = ref(Date.now());   // v2：通用时钟（驱动后台/交接耗时，每秒刷新）
    let _tick = null;
    // v2：前台起点归零（仅 running 转真时）
    watch(running, (r) => { if (r) elapsed.value = 0; }, { immediate: true });
    // v2：任一形态活跃（前台 running / 后台 bgActivity / 交接 handoffBusy）即每秒 tick —— 使后台与交接耗时也实时走动
    function _ensureTick() {
      const active = running.value || bgActivity.value || handoffBusy.value;
      if (active && !_tick) {
        _tick = setInterval(() => { nowTs.value = Date.now(); if (running.value) elapsed.value += 1; }, 1000);
      } else if (!active && _tick) {
        clearInterval(_tick); _tick = null;
      }
    }
    watch([running, bgActivity, handoffBusy], _ensureTick, { immediate: true });
    onUnmounted(() => { if (_tick) clearInterval(_tick); });
    const GENERATE_WARN_SEC = 120;   // 超 120s 文案转警示
    // v2.1：统一冒号计时 m:ss（<60s 亦写 0:45；无中文单位）——三形态共用
    function fmtDur(sec) {
      sec = Math.max(0, Math.floor(sec || 0));
      const m = Math.floor(sec / 60), s = sec % 60;
      return m + ':' + String(s).padStart(2, '0');
    }
    // 后台/交接耗时（从各自 at 起算，随 nowTs 每秒更新）
    const bgDur = computed(() => { const b = sid.value && store.bgRunning[sid.value]; return b && b.at ? Math.floor((nowTs.value - b.at) / 1000) : 0; });
    const handoffDur = computed(() => { const h = handoffBusy.value; return (h && h.at) ? Math.floor((nowTs.value - h.at) / 1000) : 0; });
    // 运行中提示文案（能量核心风；优先级：queued 排队 > 充能计时；handoffBusy 由更高优先 div 承接）
    // 始终含【耗时】（中文格式）；有 turnProgress 时附【工具名 + 第 N 步】。
    const runningHint = computed(() => {
      if (queuedPos.value > 0) return { text: '能量序列排队中 · 前方 ' + queuedPos.value + ' 条', warn: false, queued: true };
      const s = elapsed.value || 0;
      const warn = s >= GENERATE_WARN_SEC;
      const tp = turnProgress.value;
      const tool = (tp && tp.tool) ? tp.tool : '';
      const step = (tp && tp.step) ? tp.step : 0;
      let text = (warn ? '核心高负荷共振 · ' : '核心充能中 · ') + fmtDur(s);
      if (tool) text += ' · 调用 ' + tool + (step ? (' · 第 ' + step + ' 步') : '');
      // v3.1（2026-10-06·B方案）：running 场景把思考流(reasoning)最新片段**前置**（▸前缀，防行尾被ellipsis截断）；无 reasoning 不加 ▸、保持原样。
      const _rz = (stream.value && stream.value.reasoning) ? String(stream.value.reasoning).replace(/\s+/g, ' ').trim() : '';
      if (_rz) text = '▸' + _rz.slice(-40) + ' · ' + text;
      return { text, warn, queued: false };
    });
    const empty = computed(() => !view.value.length && !(stream.value && (stream.value.reasoning || stream.value.tools.length || stream.value.content)) && !handoffBusy.value && !bgActivity.value);
    // v6.61：无当前会话（首启）→ 空态给"新建会话"入口，避免误示"说点什么吧"。
    const noSession = computed(() => !sid.value);
    function newSession() { try { const b = document.getElementById('btn-new-session'); if (b) b.click(); } catch { } }
    const hasLive = computed(() => running.value || !!(stream.value && (stream.value.reasoning || stream.value.tools.length || stream.value.content)));

    // —— v3 雷电分级：按「工作量」给 闪电量 + 颜色 分档（step 为主指标，耗时为辅/兜底）——
    //   L0 轻 · step 0–2 · 青   · 1 道闪电
    //   L1 中 · step 3–6 · 蓝白 · 2 道
    //   L2 高 · step 7–11· 紫   · 3 道
    //   L3 超载· step ≥12 或 耗时告警 · 白炽 · 4 道
    function boltLevel(step, sec, warnSec) {
      const warn = sec >= (warnSec || GENERATE_WARN_SEC);
      if (warn || step >= 12) return { lv: 3, n: 4 };
      if (step >= 7) return { lv: 2, n: 3 };
      if (step >= 3) return { lv: 1, n: 2 };
      return { lv: 0, n: 1 };
    }
    const _step = computed(() => { const tp = turnProgress.value; return (tp && tp.step) ? tp.step : 0; });
    const runBolt = computed(() => boltLevel(_step.value, elapsed.value));
    const bgBolt = computed(() => boltLevel(_step.value, bgDur.value, 180));
    const handoffBolt = computed(() => boltLevel(0, handoffDur.value, 30));

    // —— 滚动"贴底"意图模型（v6.44 修复）——
    //   原则：**只有"用户手势导致的离开底部"才算离开**；程序化滚动（平滑动画）不得影响 stick。
    //   修复①：toBottom(true) 平滑滚动期间会持续触发 scroll → 旧 onScroll 中途 nearBottom()=false → 误置 atBottom=false，
    //          导致"本在底部却弹提示且不滚"。现用 programmatic 保护窗口（scrollend 优先，超时兜底）屏蔽全程判定。
    //   修复②：新增 MutationObserver + 图片 load + ResizeObserver，兜住异步增高（markdown/图片/工具卡展开）。
    const atBottom = ref(true);
    const showNewTip = ref(false);
    let stick = true;                 // 跟随意图：true=要贴底；仅用户手势上滚置 false
    let scrollEl = null;
    let _progTimer = null;            // 程序化滚动保护窗口
    let _rafPending = false;
    let _ro = null, _mo = null;
    function _el() { return scrollEl || document.getElementById('msg-stream'); }
    function _markProgrammatic(ms) {
      if (_progTimer) clearTimeout(_progTimer);
      _progTimer = setTimeout(() => { _progTimer = null; }, ms || 300);
    }
    function _clearProgrammatic() { if (_progTimer) { clearTimeout(_progTimer); _progTimer = null; } }
    function nearBottom() {
      const el = _el();
      if (!el) return true;
      return (el.scrollHeight - el.scrollTop - el.clientHeight) < 80;
    }
    function toBottom(smooth) {
      const el = _el();
      if (!el) return;
      stick = true;                                   // 显式贴底 = 恢复跟随意图
      atBottom.value = true; showNewTip.value = false;
      _markProgrammatic(smooth && !store.reducedMotion ? 600 : 140);
      if (smooth && !store.reducedMotion) { try { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); } catch { el.scrollTop = el.scrollHeight; } }
      else el.scrollTop = el.scrollHeight;
      // 自校正：平滑动画可能欠滚/被异步增高打断 → 连续两帧各贴一次（stick 中途被用户取消则不再强制）
      requestAnimationFrame(() => {
        if (!stick) return;
        const e2 = _el(); if (e2) e2.scrollTop = e2.scrollHeight;
        requestAnimationFrame(() => { if (!stick) return; const e3 = _el(); if (e3) e3.scrollTop = e3.scrollHeight; });
      });
    }
    // 静默贴底（异步增高兜底）：不改变 stick，不触发额外保护窗口过大
    function _stickNow() {
      if (!stick) return;
      const el = _el(); if (!el) return;
      el.scrollTop = el.scrollHeight;
      atBottom.value = true; showNewTip.value = false;
    }
    function _scheduleStick() {                       // rAF 连续两帧校正，兜异步布局/字体/图片
      if (!stick) return;
      if (_rafPending) return;
      _rafPending = true;
      requestAnimationFrame(() => { _stickNow(); requestAnimationFrame(() => { _rafPending = false; _stickNow(); }); });
    }
    function onScroll() {
      if (_progTimer) return;                        // 程序化滚动窗口内不判定（防污染 stick/atBottom）
      const nb = nearBottom();
      atBottom.value = nb;
      if (nb) { stick = true; showNewTip.value = false; }
      else stick = false;                            // 仅"真·用户离开底部"才取消跟随
    }
    // 用户手势：立即作废程序化保护（用户意图优先，例如平滑滚动中自己上滚）
    function _onUserGesture() { _clearProgrammatic(); }
    // 注意：用缓存的 stick 意图（而非实时 nearBottom()）——内容增长会先抬高 scrollHeight，实时重算会把"原本在底部"误判为不在底部。
    function autoScrollOrTip() { if (stick || nearBottom()) toBottom(true); else showNewTip.value = true; }
    onMounted(() => {
      scrollEl = document.getElementById('msg-stream');
      if (!scrollEl) return;
      scrollEl.addEventListener('scroll', onScroll, { passive: true });
      scrollEl.addEventListener('wheel', _onUserGesture, { passive: true });
      scrollEl.addEventListener('touchmove', _onUserGesture, { passive: true });
      scrollEl.addEventListener('keydown', _onUserGesture);
      scrollEl.addEventListener('load', () => _scheduleStick(), true);   // 图片异步加载撑高
      try { scrollEl.addEventListener('scrollend', _clearProgrammatic); } catch { /* 老内核无 scrollend → 超时兜底已覆盖 */ }
      if (typeof ResizeObserver !== 'undefined') { _ro = new ResizeObserver(() => _scheduleStick()); try { _ro.observe(scrollEl); } catch { /*noop*/ } }
      if (typeof MutationObserver !== 'undefined') {
        _mo = new MutationObserver(() => _scheduleStick());
        try { _mo.observe(scrollEl, { childList: true, subtree: true, characterData: true }); } catch { /*noop*/ }
      }
    });
    onUnmounted(() => {
      if (scrollEl) {
        scrollEl.removeEventListener('scroll', onScroll);
        scrollEl.removeEventListener('wheel', _onUserGesture);
        scrollEl.removeEventListener('touchmove', _onUserGesture);
        scrollEl.removeEventListener('keydown', _onUserGesture);
      }
      if (_ro) { try { _ro.disconnect(); } catch { /*noop*/ } _ro = null; }
      if (_mo) { try { _mo.disconnect(); } catch { /*noop*/ } _mo = null; }
      _clearProgrammatic();
    });
    watch(() => [all.value.length, inboundLive.value.length, stream.value && (stream.value.content || '').length, stream.value && stream.value.tools.length], () => nextTick(autoScrollOrTip));
    watch(sid, () => { stick = true; atBottom.value = true; showNewTip.value = false; nextTick(() => toBottom(false)); });

    // v8.6：文字流光带（overlay ::after 用 data-txt 复制文本，随电流线同相位扫过）
    const handoffTxt = computed(() => { const h = handoffBusy.value; return h ? ('第 ' + h.gen + ' 代 · 核心转生中 · ' + fmtDur(handoffDur.value) + '（自动交接，系统继续工作）') : ''; });
    const bgTxtFull = computed(() => { const tp = turnProgress.value; return bgText.value + ((tp && tp.tool) ? (' · 调用 ' + tp.tool) : ''); });

    return { view, msgs, handoff, handoffGuide, stream, running, empty, noSession, newSession, hasLive, showNewTip, toBottom, inboundLive, handoffBusy, handoffDur, bgRunning, bgActivity, bgText, bgTxtFull, handoffTxt, turnProgress, runningHint, queuedPos, fmtDur, runBolt, bgBolt, handoffBolt, gen: computed(() => store.gen[sid.value] || '') };
  },
  template: `
    <HandoffCard v-if="handoff" :text="handoff" :gen="gen" />
    <GenDivider v-else-if="handoffGuide" text="🗂 本代已自动交接 · 请读树" />
    <template v-for="(it, i) in view" :key="i">
      <GenDivider v-if="it.kind === 'divider'" :text="it.m.content" />
      <ToolGroup v-else-if="it.kind === 'tools'" :tools="it.tools" />
      <InboundBubble v-else-if="it.kind === 'inbound'" :data="{ from: it.m._inbound && it.m._inbound.from, type: it.m._inbound && it.m._inbound.type, preview: it.m.content, full: '', ts: it.m._inbound && it.m._inbound.ts }" />
      <Bubble v-else :msg="it.m" />
    </template>
    <InboundBubble v-for="(ib, k) in inboundLive" :key="'ib'+k" :data="ib" />
    <div v-if="hasLive" class="live">
      <ThinkCard v-if="stream && stream.reasoning" :text="stream.reasoning" :live="running" />
      <ToolGroup v-if="stream && stream.tools.length" :tools="stream.tools" :live="running" />
      <Bubble v-if="stream && stream.content" :msg="{ role: 'assistant', content: stream.content }" :streaming="running" />
    </div>
    <!-- 状态提示条：Teleport 到 #live-status（#msg-stream 之外、#composer 上方）→ 消息流滚动时位置不动（AC1） -->
    <Teleport to="#live-status">
      <div v-if="handoffBusy" class="live-hint handoff-busy" :data-lv="handoffBolt.lv" :data-bolts="handoffBolt.n" data-kind="handoff-busy" role="status" aria-live="polite">
        <span class="live-hint__txt" :data-txt="handoffTxt">{{ handoffTxt }}</span>
      </div>
      <div v-else-if="bgActivity" class="live-hint bg-running" :data-lv="bgBolt.lv" :data-bolts="bgBolt.n" data-kind="bg-running" role="status" aria-live="polite">
        <span class="live-hint__txt" :data-txt="bgTxtFull">{{ bgTxtFull }}</span>
      </div>
      <div v-else-if="running" class="live-hint" :class="['live-hint--lv'+runBolt.lv, { 'live-hint--warn': runningHint.warn, 'live-hint--queued': runningHint.queued }]" :data-lv="runBolt.lv" :data-bolts="runBolt.n" role="status" aria-live="polite">
        <span class="live-hint__txt" :data-txt="runningHint.text">{{ runningHint.text }}</span>
      </div>
    </Teleport>
    <div v-if="empty && noSession" class="empty"><div class="empty__text">尚未选择会话，请先新建会话。<button type="button" class="btn btn--ghost btn--sm" @click="newSession">新建会话</button></div></div>
    <div v-else-if="empty" class="empty"><div class="empty__text">这个会话还没有消息，说点什么吧。</div></div>
    <button v-if="showNewTip" class="btn btn--sm new-content-tip" @click="toBottom(true)">↓ 有新内容</button>
  `,
});

// 单个雷影 chip：watch 自身 data-state，变化时一次性加 .agent-chip--pulse-in（400ms 后移除）
// —— 美工 §8 契约：入场脉冲类名 agent-chip--pulse-in；幂等；降级由 CSS 自行 animation:none。
const AgentChip = defineComponent({
  name: 'AgentChip',
  props: { link: { type: Object, required: true }, active: { type: Boolean, default: false } },
  emits: ['pick'],
  setup(props, { emit }) {
    const el = ref(null);
    const meta = computed(() => roleMeta(props.link.role));
    // v6.48：显示名统一以「前端角色注册表」为准（雷影·X）；注册表无此角色时回退后端名，避免出现裸 role 串
    const label = computed(() => roleName(props.link.role, props.link.name));
    // unread 优先于 busy（有新回执时提示未读优先于工作态）
    const state = computed(() => {
      const info = roleInfo(props.link.role);
      // v6.49：与会话列表同源 —— busy 取 link.busy（后端 computeBusy 结果）。
      // 旧用 busyRaw(=outboundPending>0) 会因"僵尸 outbound"永久假忙；peer_session_id 为 NOT NULL，computeBusy 不会漏判。
      // 若界面确需"有在途/待回"提示，请用独立的 unread/pending 标记，不驱动 busy。
      return statusOf({ busy: !!props.link.busy, restarting: info.restarting, online: info.online, lastSeen: info.lastSeen });
    });
    let timer = null;
    watch(state, () => {
      const node = el.value; if (!node) return;
      node.classList.remove('agent-chip--pulse-in');
      void node.offsetWidth;                       // 强制回流，确保重加类能重启动画
      node.classList.add('agent-chip--pulse-in');
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { try { node.classList.remove('agent-chip--pulse-in'); } catch { } }, 420);
    });
    onUnmounted(() => { if (timer) clearTimeout(timer); });
    return { el, meta, state, label, roleVar };
  },
  template: `
    <button ref="el" class="agent-chip" :class="[meta.cls, { 'is-active': active, 'is-unread': link.unread > 0 }]"
            :style="roleVar(link.role)"
            :data-role="link.role" :data-state="state" @click="emit('pick', link)">
      <span class="avatar"><span class="role-icon" :style="{ '--icon': 'url(' + meta.icon + ')' }"></span><span class="agent-chip__dot"></span></span>
      <span class="agent-chip__name">{{ label }}</span>
      <span v-if="link.unread" class="badge badge--pulse">{{ link.unread }}</span>
    </button>
  `,
});

export const SessionAgents = defineComponent({
  name: 'SessionAgents',
  components: { AgentChip },
  setup() {
    const links = ref([]);
    const loading = ref(true);
    const row = ref(null);          // .agent-chips 行（测量溢出）
    const wrap = ref(null);         // .agent-chips-wrap（hover 区 + popover 锚）
    const hidden = ref(0);          // 被隐藏的雷影数（>0 → 显示 +N 角标）
    const fitCount = ref(0);        // 行内实际放得下的数量（展开层取 slice(fitCount) = 未显示的剩余）
    const popOpen = ref(false);
    let _ro = null, _raf = 0, _closeT = null;

    const load = async () => {
      const id = store.currentId;
      if (!id) { links.value = []; loading.value = false; return; }
      try { const r = await api.sessionLinks(id); links.value = (r && Array.isArray(r.links)) ? r.links : []; }
      catch { links.value = []; }
      finally { loading.value = false; }
      nextTick(measure);
    };

    // 溢出测量：统一用 getBoundingClientRect（同一视口参照系），严格「完整可见」才计入 →
    // 任何宽度下不会出现「半个 chip」。角标常驻（.is-off 隐藏）以便实量其宽（数字位数不影响：CSS 有 min-width）。
    function measure() {
      const el = row.value;
      if (!el) { hidden.value = 0; fitCount.value = 0; return; }
      const chips = el.querySelectorAll('.agent-chip');
      if (!chips.length) { hidden.value = 0; fitCount.value = 0; return; }
      // 先判「是否真的溢出」：行容器随内容收缩时 clientWidth≈内容宽，不能仅靠边界比较（会误报）
      const overflowing = el.scrollWidth > el.clientWidth + 1;
      if (!overflowing) {
        chips.forEach((c) => c.classList.remove('agent-chip--hidden'));
        hidden.value = 0; fitCount.value = chips.length; return;
      }

      const cs = getComputedStyle(el);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      const rowR = el.getBoundingClientRect();
      const leftEdge = rowR.left + padL;                 // 内容区左界
      const rightEdge = rowR.right - padR;               // 内容区右界
      // 实量角标宽（角标 position:absolute 不参与布局，故可直接量）；未渲染时用安全上限
      const moreEl = wrap.value ? wrap.value.querySelector('.agent-chips__more') : null;
      const badgeW = moreEl ? Math.ceil(moreEl.getBoundingClientRect().width) : 48;
      const FIT_LIMIT = rightEdge - badgeW - 6;          // 为角标留位 + 6px 余量（角标数字位数变化时不致压到最后可见 chip）

      let fit = 0;
      for (let i = 0; i < chips.length; i++) {
        const cr = chips[i].getBoundingClientRect();     // 同一视口参照系，与 row 边界可比
        if (cr.left >= leftEdge - 1 && cr.right <= FIT_LIMIT) fit = i + 1;   // 严格：完整落在可视区且不碰角标
        else break;
      }
      if (fit >= chips.length) fit = Math.max(0, chips.length - 1);   // 溢出时至少隐 1（保证角标）
      hidden.value = chips.length - fit;
      fitCount.value = fit;                            // 行内可见数（剩余 = links.slice(fitCount)）
      // 物理隐藏溢出 chip（visibility 不改布局 → 测量稳定；跨界「半个 chip」彻底消失）
      chips.forEach((c, i) => c.classList.toggle('agent-chip--hidden', i >= fit));
    }
    function scheduleMeasure() {
      if (_raf) cancelAnimationFrame(_raf);
      _raf = requestAnimationFrame(() => { _raf = 0; measure(); });
    }
    function onEnter() { if (hidden.value > 0) { if (_closeT) { clearTimeout(_closeT); _closeT = null; } popOpen.value = true; } }
    function onLeave() { if (_closeT) clearTimeout(_closeT); _closeT = setTimeout(() => { popOpen.value = false; }, 120); }
    function togglePop() { if (hidden.value > 0) popOpen.value = !popOpen.value; }
    function onKey(e) { if (e.key === 'Escape') { popOpen.value = false; } }

    let timer = null;
    onMounted(() => {
      load();
      window.__leizaiReloadSessionAgents = load;   // 独立名：避免与 dock.js AgentWall 的 __leizaiReloadAgents 冲突
      timer = setInterval(load, 10000);   // v6.45：4s→10s（与 15s stats 轮询并存，不冲突）
      nextTick(measure);
      try { _ro = new ResizeObserver(scheduleMeasure); if (wrap.value) _ro.observe(wrap.value); } catch { }
      window.addEventListener('resize', scheduleMeasure);
      document.addEventListener('keydown', onKey);
      if (document.fonts && document.fonts.ready) { try { document.fonts.ready.then(scheduleMeasure); } catch { } }
    });
    onUnmounted(() => {
      if (timer) clearInterval(timer);
      if (_closeT) clearTimeout(_closeT);
      if (_raf) cancelAnimationFrame(_raf);
      if (_ro) { try { _ro.disconnect(); } catch { } }
      window.removeEventListener('resize', scheduleMeasure);
      document.removeEventListener('keydown', onKey);
    });
    watch(() => store.currentId, () => load());
    watch(links, () => nextTick(scheduleMeasure));
    // 展开层内容 = 未被显示的剩余雷影（像原列表从下方「接着展开」，非独立卡片）
    const overflowLinks = computed(() => links.value.slice(Math.max(0, fitCount.value)));
    const isActive = (l) => !!(store.mailboxCurrent && store.mailboxCurrent.role === l.role);
    function pick(l) {
      popOpen.value = false;
      window.dispatchEvent(new CustomEvent('leizai-open-berth', { detail: 'dock' }));
      if (window.__leizaiLoadMail) window.__leizaiLoadMail(l.role);
    }
    return { links, loading, isActive, pick, row, wrap, hidden, popOpen, overflowLinks, onEnter, onLeave, togglePop, onKey };
  },
  template: `
    <div class="agent-chips-wrap" ref="wrap" @mouseenter="onEnter" @mouseleave="onLeave">
      <div class="agent-chips" ref="row">
        <AgentChip v-for="l in links" :key="l.role" :link="l" :active="isActive(l)" @pick="pick" />
        <span v-if="!links.length && !loading" class="agent-chips__empty">本会话暂无雷影往来</span>
      </div>
      <button type="button" class="agent-chips__more" :class="{ 'is-off': hidden === 0 }"
              :aria-expanded="popOpen ? 'true' : 'false'" aria-haspopup="true"
              :aria-hidden="hidden === 0 ? 'true' : 'false'" :tabindex="hidden === 0 ? -1 : 0"
              :aria-label="'还有 ' + hidden + ' 个雷影，展开查看全部'"
              @click="togglePop" @focus="popOpen = true">
        +{{ hidden }}<span class="agent-chips__more-caret" aria-hidden="true">▾</span>
      </button>
      <div v-if="popOpen && hidden > 0" class="agent-pop" role="menu" aria-label="未显示的雷影">
        <AgentChip v-for="l in overflowLinks" :key="'p-' + l.role" :link="l" :active="isActive(l)" @pick="pick" />
      </div>
    </div>
  `,
});

// ── Composer 命令式初始化（#composer 不挂载；复用美工已提供的 #composer-stop / #composer-popup）──
export function initComposer() {
  const root = document.getElementById('composer');
  if (!root) return;
  const input = document.getElementById('composer-input');
  const sendBtn = document.getElementById('btn-send');
  const stopBtn = document.getElementById('composer-stop');
  const popup = document.getElementById('composer-popup');
  if (!input) return;

  let cur = null, popMode = null, popItems = [], popIdx = 0;
  let pendingMention = null;   // @ 会话（2026-10-02）：当前待通知的目标会话 {id,label}
  // v6.60：统一附件（图片 + 任意文件）——取代早期"仅粘贴图片"的 pendingImages
  // 结构：{ id, name, size, type, kind:'image'|'file', status:'pending'|'uploading'|'done'|'failed', dataUrl?, path? }
  const MAX_IMAGES = 4, MAX_FILES = 10;
  const MAX_BYTES = 25 * 1024 * 1024;              // 单文件上限：普通文件（含图片）
  const MAX_BYTES_BIG = 200 * 1024 * 1024;         // 单文件上限：视频 / 压缩包
  const MAX_SESSION_BYTES = 1024 * 1024 * 1024;    // 会话累计上限：1GB（前端提示，真正拦截以引擎为准）
  const BIG_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg',
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz']);
  const lowerExt = (name) => { const m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; };
  const maxBytesFor = (name) => (BIG_EXTS.has(lowerExt(name)) ? MAX_BYTES_BIG : MAX_BYTES);
  const mbText = (n) => (n / 1024 / 1024) + 'MB';
  const pendingAttachments = [];
  let attSeq = 0;
  const kindOf = (t) => (/^image\//.test(t || '') ? 'image' : 'file');
  const countKind = (k) => pendingAttachments.filter((a) => a.kind === k).length;
  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function extOf(name) { const m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toUpperCase().slice(0, 4) : 'FILE'; }
  const escAttr = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 附件条容器：动态插入到 .composer__field 之前（不依赖 index.html 改动）
  let thumbs = document.getElementById('composer-attach');
  if (!thumbs) {
    thumbs = document.createElement('div');
    thumbs.id = 'composer-attach'; thumbs.className = 'composer__attach';
    thumbs.hidden = true;
    const field = root.querySelector('.composer__field');
    if (field && field.parentNode) field.parentNode.insertBefore(thumbs, field); else root.appendChild(thumbs);
  }
  // @ 会话：通知目标 chip 条（复用附件 chip 样式；单目标；× 可取消）
  let mentionBar = document.getElementById('composer-mention');
  if (!mentionBar) {
    mentionBar = document.createElement('div');
    mentionBar.id = 'composer-mention'; mentionBar.className = 'composer__attach';
    mentionBar.hidden = true;
    const mf = root.querySelector('.composer__field');
    if (mf && mf.parentNode) mf.parentNode.insertBefore(mentionBar, mf); else root.appendChild(mentionBar);
  }
  function renderMention() {
    if (!mentionBar) return;
    if (!pendingMention) { mentionBar.hidden = true; mentionBar.innerHTML = ''; return; }
    mentionBar.hidden = false;
    mentionBar.innerHTML = '<span class="attach attach--file" data-mention="' + escAttr(pendingMention.id) + '" title="通知目标 ' + escAttr(pendingMention.label) + '">'
      + '<span class="attach__ico" aria-hidden="true">@</span>'
      + '<span class="attach__meta"><span class="attach__name">' + escAttr(pendingMention.label) + '</span><span class="attach__size">通知目标</span></span>'
      + '<button type="button" class="attach__x" data-mention-x="1" title="取消通知" aria-label="取消通知">×</button></span>';
  }
  if (mentionBar) mentionBar.addEventListener('click', (e) => {
    if (e.target.closest('[data-mention-x]')) { e.preventDefault(); e.stopPropagation(); pendingMention = null; renderMention(); }
  });
  // ── Pro 升级引导（雷影·美工）：输入区顶部「Lite 限额」提示条 ──
  //   触发：当前会话中出现后端 gate 的 Pro 限额文案（与气泡内联按钮同判据）→ 显示；点击「升级 Pro」跳控制台 Pro 面板。
  let limitBar = document.getElementById('composer-pro-limit');
  if (!limitBar) {
    limitBar = document.createElement('div');
    limitBar.id = 'composer-pro-limit'; limitBar.className = 'composer__pro-limit'; limitBar.hidden = true;
    limitBar.innerHTML = '<span class="cpl__ic" aria-hidden="true">⚠</span>'
      + '<span class="cpl__txt">已达 Lite 档上限，升级 Pro 后不限</span>'
      + '<button type="button" class="cpl__btn">升级 Pro</button>';
    const anchor = thumbs || root.querySelector('.composer__field');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(limitBar, anchor);
    else root.insertBefore(limitBar, root.firstChild);
    limitBar.querySelector('.cpl__btn').addEventListener('click', () => { if (window.__leizaiOpenPro) window.__leizaiOpenPro(); });
  }
  // 事件驱动（替代原 800ms 扫全量历史 regex）：仅「有效档位=lite 且后端真拦截（最新一条消息含限额文案）」才显示；
  // dev/pro（effective.tier!=='lite'）→ 永不显。判据不依赖全量历史文本，旧报错残留不再常显。
  function refreshProLimit() {
    if (!limitBar) return;
    try {
      const eff = (store.pro && store.pro.effective) || null;
      const tier = (eff && eff.tier) || 'lite';
      if (tier !== 'lite') { limitBar.hidden = true; return; }
      const sid = store.currentId;
      const msgs = (sid && store.messages[sid]) || [];
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      const hit = !!(last && isProLimitText(textOf(last)));
      limitBar.hidden = !hit;
    } catch { limitBar.hidden = true; }
  }
  refreshProLimit();
  try {
    watch(() => (store.pro && store.pro.effective && store.pro.effective.tier) || 'lite', refreshProLimit);
    watch(() => {
      const sid = store.currentId; const m = (sid && store.messages[sid]) || [];
      return m.length + '|' + (m.length ? (m[m.length - 1].id || m[m.length - 1].ts || '') : '');
    }, refreshProLimit);
  } catch { }

  function renderAttachments() {
    if (!thumbs) return;
    if (!pendingAttachments.length) { thumbs.hidden = true; thumbs.innerHTML = ''; return; }
    thumbs.hidden = false;
    thumbs.innerHTML = pendingAttachments.map((a) => {
      const x = '<button type="button" class="attach__x" data-id="' + a.id + '" title="移除" aria-label="移除">×</button>';
      if (a.kind === 'image') {
        return '<span class="attach attach--img" data-id="' + a.id + '" data-status="' + a.status + '" title="' + escAttr(a.name) + '">'
          + (a.dataUrl ? '<img src="' + a.dataUrl + '" alt="' + escAttr(a.name) + '" draggable="false">' : '')
          + '<span class="attach__ov" aria-hidden="true"></span>' + x + '</span>';
      }
      const sub = a.status === 'failed' ? '上传失败' : (a.status === 'uploading' ? '上传中…' : fmtSize(a.size));
      return '<span class="attach attach--file" data-id="' + a.id + '" data-status="' + a.status + '" title="' + escAttr(a.name) + '">'
        + '<span class="attach__ico" aria-hidden="true">' + escAttr(extOf(a.name)) + '</span>'
        + '<span class="attach__meta"><span class="attach__name">' + escAttr(a.name) + '</span><span class="attach__size">' + sub + '</span></span>'
        + x + '</span>';
    }).join('');
  }
  if (thumbs) thumbs.addEventListener('click', (e) => {
    const btn = e.target.closest('.attach__x');
    if (btn) {                       // 优先：× 删除
      e.preventDefault(); e.stopPropagation();
      const i = pendingAttachments.findIndex((a) => a.id === btn.dataset.id);
      if (i >= 0) { pendingAttachments.splice(i, 1); renderAttachments(); }
      return;
    }
    const im = e.target.closest('.attach--img img');
    if (im) { e.preventDefault(); openImageLightbox(im.getAttribute('src')); }   // 点缩略图看大图
  });

  // ── 附件添加：回形针 / 双击输入区 / 拖拽（三入口）────────────────────
  const fileInput = document.getElementById('composer-file');
  const clipBtn = document.getElementById('composer-clip');
  if (clipBtn) clipBtn.addEventListener('click', () => { if (fileInput) fileInput.click(); });
  if (fileInput) fileInput.addEventListener('change', () => { addAttachments(fileInput.files); fileInput.value = ''; });

  function uploadFile(item) {                       // 非图片 → POST /api/upload（raw body）→ 取 path
    item.status = 'uploading'; renderAttachments();
    fetch('/api/upload', {
      method: 'POST',
      headers: { 'x-file-name': encodeURIComponent(item.name), 'x-session-id': store.currentId || '' },
      body: item.file,
    }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((j) => {
        item.path = (j && j.path) || '';
        if (j && j.size != null) item.size = j.size;
        if (j && j.mime) item.type = j.mime;
        item.status = item.path ? 'done' : 'failed';
        if (!item.path) toast('上传失败：' + item.name, 'err');
        renderAttachments();
      })
      .catch(() => { item.status = 'failed'; renderAttachments(); toast('上传失败：' + item.name, 'err'); });
  }
  function addAttachments(list) {
    const files = Array.from(list || []);
    if (!files.length) return;
    for (const f of files) {
      const kind = kindOf(f.type);
      const cap = maxBytesFor(f.name);
      if (f.size > cap) { toast('单文件超上限 ' + mbText(cap) + '：' + f.name, 'err'); continue; }
      const used = pendingAttachments.reduce((s, a) => s + (a.size || 0), 0);
      if (used + f.size > MAX_SESSION_BYTES) { toast('会话附件累计超上限 1GB，请先发送或移除部分附件', 'err'); continue; }
      if (kind === 'image' && countKind('image') >= MAX_IMAGES) { toast('最多 ' + MAX_IMAGES + ' 张图片', 'info'); continue; }
      if (kind === 'file' && countKind('file') >= MAX_FILES) { toast('最多 ' + MAX_FILES + ' 个文件', 'info'); continue; }
      const item = { id: 'a' + (++attSeq), name: f.name || '未命名', size: f.size, type: f.type || '', kind: kind, status: 'pending', dataUrl: null, path: null, file: f };
      pendingAttachments.push(item);
      if (kind === 'image') {
        const reader = new FileReader();
        reader.onload = () => { item.dataUrl = reader.result; item.status = 'done'; renderAttachments(); };
        reader.onerror = () => { item.status = 'failed'; renderAttachments(); };
        reader.readAsDataURL(f);
      } else {
        uploadFile(item);
      }
    }
    renderAttachments();
  }
  // 双击输入区 → 文件选择（落在 textarea 正文且已选中文字时不触发，避免抢选词/复制）
  const fieldEl = root.querySelector('.composer__field');
  if (fieldEl) fieldEl.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    if (e.target === input) { const s = window.getSelection(); if (s && String(s).length) return; }
    e.preventDefault();
    if (fileInput) fileInput.click();
  });
  // 拖拽：整窗遮罩 + 松手即添加（dragleave 用计数防抖）
  const dropMask = document.getElementById('drop-mask');
  let dragDepth = 0;
  const hasFiles = (e) => { const dt = e.dataTransfer; if (!dt) return false; return Array.from(dt.types || []).indexOf('Files') >= 0; };
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth++;
    if (dropMask) { dropMask.hidden = false; dropMask.classList.add('is-active'); }
  });
  window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth && dropMask) { dropMask.classList.remove('is-active'); dropMask.hidden = true; }
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0;
    if (dropMask) { dropMask.classList.remove('is-active'); dropMask.hidden = true; }
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addAttachments(e.dataTransfer.files);
  });

  function refreshStop() {
    const r = !!(store.currentId && store.running[store.currentId]);
    if (stopBtn) stopBtn.hidden = !r;
    if (sendBtn) sendBtn.hidden = r;
  }
  function renderPopup() {
    if (!popup) return;
    if (!popItems.length) { popup.hidden = true; popup.classList.remove('is-open'); return; }
    let html = '', lastGroup = null;
    popItems.forEach((it, i) => {
      if (it.group && it.group !== lastGroup) { html += '<div class="popup__group">' + it.group + '</div>'; lastGroup = it.group; }
      html += '<div class="popup__item' + (i === popIdx ? ' is-active' : '') + '" data-idx="' + i + '">' +
        (it.icon ? '<span class="icon icon--sm" style="--i:url(' + it.icon + ')"></span>' : '') +
        '<span class="mono">' + it.label + '</span><span class="dim">' + (it.desc || '') + '</span></div>';
    });
    popup.innerHTML = html; popup.hidden = false; popup.classList.add('is-open');
    const act = popup.querySelector('.popup__item.is-active'); if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
  }
  function updatePopup() {
    const v = input.value;
    const a = v.match(/(^|\s)@([^\s@]*)$/);
    if (a) {
      popMode = 'mention'; const kw = a[2].toLowerCase();
      const list = (store.sessions || []).filter((x) => x && x.id && x.id !== store.currentId && !x.trashedAt);   // 仅本实例其他会话
      const cnt = {}; list.forEach((x) => { const t = String(x.title || '').trim(); cnt[t] = (cnt[t] || 0) + 1; });
      popItems = list.filter((x) => (String(x.title || '') + ' ' + x.id).toLowerCase().includes(kw)).map((x) => {
        const tail = String(x.id).slice(-6);
        let t = String(x.title || '').trim();
        if (!t) t = '会话' + tail; else if (cnt[t] > 1) t = t + '·' + tail;   // 空/重名 → 回退 id 尾号
        return { id: x.id, label: '@' + t, group: '会话', icon: '/assets/icon-dock.svg', desc: tail };
      });
    } else { popMode = null; popItems = []; }
    popIdx = 0; renderPopup();
  }
  function applyPopup() {
    const it = popItems[popIdx]; if (!it) return false;
    input.value = input.value.replace(/(^|\s)@[^\s@]*$/, '$1' + it.label + ' ');
    if (it.id) { pendingMention = { id: it.id, label: it.label }; renderMention(); }
    if (popup) { popup.hidden = true; popup.classList.remove('is-open'); }
    input.focus(); return true;
  }
  function doSend() {
    const text = input.value.trim();
    const items = pendingAttachments.slice();
    const imgs = items.filter((a) => a.kind === 'image' && a.dataUrl && a.status !== 'failed').map((a) => a.dataUrl);
    const atts = items.filter((a) => a.kind === 'file' && a.status === 'done' && a.path)
      .map((a) => ({ name: a.name, path: a.path, size: a.size, mime: a.type }));
    // v6.60：有文 / 有图 / 有附件 任一即可发送
    if (!text && !imgs.length && !atts.length) return;   // 空输入：静默（保持原行为）
    // v6.61：无当前会话 → 明确提示 + 一键新建（原先与空输入合并静默 return，致首次使用"发送无反应"卡死）
    if (!store.currentId) {
      toast('尚未选择会话，请先新建会话', 'err');
      try { const _b = document.getElementById('btn-new-session'); if (_b) _b.click(); } catch { }
      return;
    }
    if (store.running[store.currentId]) { toast('本会话正在生成，请稍候', 'info'); return; }
    if (items.some((a) => a.kind === 'file' && a.status === 'uploading')) { toast('有附件仍在上传，请稍候', 'info'); return; }
    // 本地乐观插入：图片走 image_url（与后端 runtime.js 一致）；纯附件仅文字兜底（回放以服务端为准）
    let content = text;
    if (imgs.length) {
      content = [];
      if (text) content.push({ type: 'text', text });
      imgs.forEach((u) => content.push({ type: 'image_url', image_url: { url: u } }));
    } else if (atts.length && !text) {
      content = '[附件] ' + atts.map((a) => a.name).join('、');
    }
    ensureMessages(store.currentId).push({ role: 'user', content });
    pendingAttachments.length = 0; renderAttachments();
    input.value = ''; input.style.height = 'auto';
    const _mentionIds = (pendingMention && pendingMention.id && pendingMention.id !== store.currentId) ? [pendingMention.id] : [];
    cur = chat(store.currentId, text || (imgs.length ? '[图片]' : (atts.length ? '[附件]' : '')), { images: imgs, attachments: atts, mentionSessionIds: _mentionIds });
    pendingMention = null; renderMention();
    refreshStop();
  }

  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; updatePopup(); });
  // v6.23/v6.60：粘贴 —— 图片与任意文件都收（仅拦截含文件项的粘贴；纯文本保持浏览器默认行为）
  input.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
    }
    if (!files.length) return;            // 纯文本 → 不拦截
    e.preventDefault();
    addAttachments(files);
  });
  input.addEventListener('keydown', (e) => {
    if (popup && !popup.hidden && popItems.length) {
      if (e.key === 'ArrowDown') { popIdx = (popIdx + 1) % popItems.length; renderPopup(); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { popIdx = (popIdx - 1 + popItems.length) % popItems.length; renderPopup(); e.preventDefault(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && popMode)) { if (applyPopup()) { e.preventDefault(); return; } }
      if (e.key === 'Escape') { popup.hidden = true; popup.classList.remove('is-open'); e.preventDefault(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); }
  });
  if (popup) popup.addEventListener('click', (e) => { const it = e.target.closest('.popup__item'); if (it) { popIdx = +it.dataset.idx; applyPopup(); } });
  if (sendBtn) sendBtn.addEventListener('click', doSend);
  if (stopBtn) stopBtn.addEventListener('click', () => {
    const sid = store.currentId;
    // v6.22：① 后端显式停止（真正中止该会话当前回合：abort + 清排队项），与"是否本视图发起"无关；
    //        ② cur.stop() 仍保留：中止浏览器端 fetch（兜底 + 立即结束本视图流）。
    if (sid) { try { const p = api.stop(sid); if (p && p.catch) p.catch(() => { }); } catch { } }
    if (cur && cur.stop) cur.stop();
    // v8.7：停止立即收敛本会话"运行中"工具为终态 —— 不等 turn-done（引擎兜底回收路径不发 turn-done 时会残留）
    try { finalizeSessionTools(sid, 'error'); } catch { }
    toast('已请求停止', 'info');
    refreshStop();
  });

  setInterval(refreshStop, 400); refreshStop();
}
