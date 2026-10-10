// A1 前端 · 右栏实时态势（挂载 #live-feed / #vitals-mini）——多根渲染
import { defineComponent, computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { store } from '../store.js';
import { hhmm, roleMeta, roleName } from '../roles.js';
import { api } from '../api.js';
import { refreshAgg, invalidateAgg, normTok } from '../vitals-agg.js';

// 本窗口预算可编辑上限（防超模型 ~1M 窗口：留余量给系统前缀/工具/输出）
const BUDGET_MAX = 900000;

const TYPE_ICON = {
  task: '/assets/type-task.svg', reply: '/assets/type-reply.svg', notify: '/assets/type-notify.svg',
  handoff: '/assets/ui-archive.svg', compacted: '/assets/ui-archive.svg',
  reflect: '/assets/icon-mirror.svg', 'turn-done': '/assets/ui-play.svg', schedule: '/assets/ui-play.svg',
  evolve: '/assets/icon-forge.svg', evolution: '/assets/icon-forge.svg', queued: '/assets/ui-list.svg',
  'mailbox-message': '/assets/type-notify.svg',
};

// 事件类型中文映射（副文本用；禁止再出现英文类型名/裸会话 id）
const TYPE_LABEL = {
  task: '任务', reply: '回复', notify: '通知', handoff: '世代交接',
  compacted: '世代交接', reflect: '自我反思', 'turn-done': '回合完成',
  schedule: '定时调度', evolve: '进化', evolution: '进化', queued: '排队', report: '报告',
  'mailbox-message': '雷影消息',
  'sessions-changed': '会话变更',
};
// v6.21：雷影消息（mailbox-message）自身的 type 字段 → 中文（复用/新增）
const MBOX_TYPE_LABEL = { task: '任务', reply: '回复', notify: '通知', ack: '确认', message: '消息' };
// v6.21：不进涟漪流的事件（纯进度/看门狗，非"事件"；turn-progress 每工具调用都 emit，会刷屏）
// v6.43：并入 llm-status —— 模型可用性信号，只驱动"模型服务不可用"横幅；不进涟漪流（否则无中文映射→刷"事件"空白卡）
const NOISE_TYPES = new Set(['turn-progress', 'turn-watchdog', 'llm-status', 'agent-busy', 'mailbox-consumed', 'mailbox-replied']);   // v6.49：状态信号类不入涟漪流（防「事件」空白卡刷屏）

// v6.41（主人要求）：事件类型「含义说明」——一句话人话；用于 meta 行 title 悬停 + 底部图例。
//   约定：只出现中文标签，绝不出现英文类型名 / 裸会话 id。
const TYPE_DESC = {
  'turn-done': '某会话完成了一轮模型调用，附本次 token 用量与缓存命中率',
  'reflect': '某会话完成了一次自我反思，可能沉淀了新的记忆或技能',
  'mailbox-message': '雷影与主我（或雷影之间）往来的一条消息：任务 / 回复 / 通知 / 确认',
  'compacted': '上下文写满触发世代交接：旧回合归档、窗口重建',
  'schedule': '心跳 / 定时任务被触发或创建',
  'evolve': '提出并应用了一次自我进化提案',
  'evolution': '提出并应用了一次自我进化提案',
  'sessions-changed': '会话被新建或删除（主我 / 雷影实例）',
};
// 图例条目（固定顺序，只收录涟漪流里真实会出现的类型）
const LEGEND = ['turn-done', 'reflect', 'mailbox-message', 'compacted', 'schedule', 'evolve', 'sessions-changed'];

// v6.1.2：token 数字简写（1900→1.9k；512→512；275402368→275.4M）
function kfmt(n) {
  n = Number(n) || 0;
  if (n >= 1e6) { const m = n / 1e6; return (m >= 10 ? String(Math.round(m)) : Number(m.toFixed(1)) + '') + 'M'; }
  if (n >= 1000) { const k = n / 1000; return (k >= 10 ? String(Math.round(k)) : Number(k.toFixed(1)) + '') + 'k'; }
  return String(n);
}
// v6.1.2：涟漪事件 token 摘要（无 usage 的事件返回空串，不显示该段）
// v6.20：符号体系统一（与右栏「运行指标」一致）——
//   ↑输入(prompt 总量) · ✔缓存命中 · ✘未命中 · ↓输出 · 命中率 x%
function usageStr(e) {
  const u = (e && e.data && e.data.usage) || null;
  if (!u) return '';
  const parts = [];
  const pt = (u.promptTokens != null) ? u.promptTokens : ((u.hitTokens || 0) + (u.missTokens || 0));
  if (pt) parts.push('↑' + kfmt(pt) + ' 输入');
  if (u.hitTokens != null) parts.push('✔' + kfmt(u.hitTokens));
  if (u.missTokens != null) parts.push('✘' + kfmt(u.missTokens));
  if (u.outputTokens != null) parts.push('↓' + kfmt(u.outputTokens) + ' 输出');
  if (u.cacheHitRate != null) parts.push('命中率 ' + Math.round(u.cacheHitRate * 100) + '%');
  return parts.length ? parts.join(' · ') : '';
}
// v6.1.3：回合耗时（<60s 显 Ns，≥60s 显 Nm；无 durationMs 返回空串）
function durStr(e) {
  const u = (e && e.data && e.data.usage) || null;
  const ms = u && u.durationMs;
  if (!(ms > 0)) return '';
  const s = Math.round(ms / 1000);
  return ' · ' + (s < 60 ? s + 's' : Math.round(s / 60) + 'm');
}

export const LiveFeed = defineComponent({
  name: 'LiveFeed',
  setup() {
    // v6.5：过滤 final compacted（摘要填完阶段）——一次交接只保留非 final 那条，防重复条（含历史回放双保险）
    // v6.53：涟漪流含雷影——来源按事件自带 role 标注（未知→徽记灰、不崩），顶部可按角色过滤（选项动态，禁硬编码）
    function roleKey(e) {
      // v6.53：mailbox-message 的 data 是 from/to（无 role）——出站归「主我」，入站按 from 雷影
      const d = (e && e.data) || {};
      if (e && e.type === 'mailbox-message') return (d.outbound || d.from === 'main') ? 'main' : (d.from || (e && e.inst) || 'main');
      // v1 主体可辨：d.role → e.inst(聚合来源实例 role) → d.from → 'main'
      return d.role || (e && e.inst) || d.from || 'main';
    }
    function shortRole(r) { return roleMeta(r).short; }
    const filter = ref('all');
    const roles = computed(() => {
      const set = new Set();
      for (const e of (store.events || [])) if (e) set.add(roleKey(e));
      return [...set].sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : String(a).localeCompare(String(b))));
    });
    // v6.53：无专属文案的事件（text 回退「事件」）不入流 —— 彻底杜绝"空白卡"（与"禁英文类型名/裸 id"约定一致）
    function hasText(e) { const t = text(e); return !!t && t !== '事件'; }
    const rawList = computed(() => (store.events || [])
      .filter((e) => e && !NOISE_TYPES.has(e.type) && hasText(e))                     // v6.21/v6.53：噪声 + 无文案 → 不入流
      .filter((e) => !(e && e.type === 'compacted' && e.data && e.data.final))
      .filter((e) => filter.value === 'all' || roleKey(e) === filter.value)
      .slice(0, 60));
    // v1 防刷屏：同 (roleKey, sessionId) 的**连续** turn-done 折叠为一条；边界=夹入其他类型事件 或 间隔 > 120s
    const TURN_MERGE_WINDOW = 120000;
    function foldTurns(items) {
      const out = [];
      for (const e of items) {
        const sid = (e && e.data && e.data.sessionId) || '';
        const rk = roleKey(e);
        const last = out[out.length - 1];
        if (e && e.type === 'turn-done' && last && last.__fold && last.__rk === rk && last.__sid === sid
            && (last._lastAt - (e.at || 0)) <= TURN_MERGE_WINDOW) {
          last.__count += 1;   // at 保持组首(最新)时间 → 文案显示「最近 HH:MM」
          continue;
        }
        if (e && e.type === 'turn-done') {
          out.push({ __fold: true, type: 'turn-done', __rk: rk, __sid: sid, __count: 1, at: e.at, _lastAt: e.at || 0, data: { sessionId: sid } });
          continue;
        }
        out.push(e);
      }
      return out;
    }
    const foldedList = computed(() => foldTurns(rawList.value));
    const list = ref([]);
    let _raf = 0;
    watch(foldedList, (v) => {   // v6.53：rAF 节流——高频事件下避免每次 store 变更都整体重渲染列表
      if (typeof requestAnimationFrame !== 'function') { list.value = v; return; }
      if (_raf) return;
      _raf = requestAnimationFrame(() => { _raf = 0; list.value = foldedList.value; });
    }, { immediate: true });
    onUnmounted(() => { if (_raf) cancelAnimationFrame(_raf); });
    function icon(t) { return TYPE_ICON[t] || '/assets/ui-list.svg'; }
    // 会话短名：去掉 s- 前缀取前 8 位
    function short(sid) { return sid ? String(sid).replace(/^s-/, '').slice(0, 8) : ''; }
    // v6.1.4：会话可读标题（优先 store.sessions 的 title；缺会话/未加载则退化短 id；都空则 '—'）
    //   只读映射，零引擎改动；store.sessions 未加载完也绝不报错（后续响应式自动补渲染）。
    function sessionTitle(sid) {
      if (!sid) return '—';
      try {
        const s = (store.sessions || []).find((x) => x && x.id === sid);
        const t = s && typeof s.title === 'string' ? s.title.trim() : '';
        if (t) return t.length > 24 ? t.slice(0, 24) + '…' : t;
      } catch { /* 列表未就绪 → 退化 */ }
      return short(sid) || '—';
    }
    // v1：turn-done 专用标题——有标题用标题；无标题降级「会话 <短id>」（与既有"无裸 id/无英文"约定一致）
    function turnTitle(sid) {
      if (!sid) return '会话';
      try {
        const s = (store.sessions || []).find((x) => x && x.id === sid);
        const t = s && typeof s.title === 'string' ? s.title.trim() : '';
        if (t) return t.length > 24 ? t.slice(0, 24) + '…' : t;
      } catch { /* 列表未就绪 → 退化 */ }
      return '会话 ' + (short(sid) || '—');
    }
    // 事件 → 人话文案（绝不再回退裸 sessionId）
    function text(e) {
      const d = e.data || {};
      // v1：折叠条目（同角色同会话连续 turn-done）→ 「雷影·X『会话』完成 N 轮 · 最近 HH:MM」
      if (e.__fold) {
        const who = roleName(e.__rk || 'main');
        const ttl = d.sessionId ? turnTitle(d.sessionId) : '会话';
        const n = e.__count || 1;
        return who + '『' + ttl + '』完成 ' + (n > 1 ? (n + ' 轮') : '一轮') + ' · 最近 ' + (hhmm(e.at) || '—');
      }
      switch (e.type) {
        case 'turn-done': return roleName(roleKey(e)) + '『' + turnTitle(d.sessionId) + '』完成一轮';
        case 'reflect': {
          let s = '『' + sessionTitle(d.sessionId) + '』完成一次反思';
          const r = d.result || {};
          const cnt = (v) => (Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0));
          const m = cnt(r.memories), sf = cnt(r.self), sk = cnt(r.skills);
          if (m || sf || sk) s += ' · 记忆' + m + '/自我' + sf + '/技能' + sk;
          // v6.20：补 1–2 个具体名称（result.memories 里是名称字符串），让"反思了什么"一眼可见
          const names = (Array.isArray(r.memories) ? r.memories : [])
            .map((x) => (typeof x === 'string' ? x : (x && (x.name || x.title)) || ''))
            .filter((x) => x).slice(0, 2)
            .map((x) => (x.length > 18 ? x.slice(0, 18) + '…' : x));
          if (names.length) s += '（' + names.join('、') + (m > 2 ? ' 等' : '') + '）';
          return s;
        }
        case 'compacted': {
          // v6.5：不显示 '?'。gen 缺失→「世代交接」；dropped 缺失→省略括号。
          const t = '『' + sessionTitle(d.sessionId) + '』' + (d.gen ? ('第 ' + d.gen + ' 代交接') : '世代交接');
          // v6.20：补 kept/total（保留 X/Y 条），与归档条数并列
          const extra = [];
          if (d.dropped != null) extra.push('归档 ' + d.dropped + ' 条');
          if (d.kept != null && d.total != null) extra.push('保留 ' + d.kept + '/' + d.total);
          return extra.length ? (t + '（' + extra.join(' · ') + '）') : t;
        }
        case 'evolution': {
          // v6.20：引擎 broadcast 的进化事件 { id, status, target, title }
          const ti = d.title ? String(d.title).slice(0, 28) + (String(d.title).length > 28 ? '…' : '') : '';
          let s = '进化' + (ti ? ('：' + ti) : '');
          if (d.target) s += '（' + d.target + '）';
          if (d.status && d.status !== 'approved') s += ' · ' + d.status;
          return s;
        }
        case 'mailbox-message': {
          // v6.21：{ sessionId, from, to, type, msgId, preview, full, ts, outbound } → 人话
          // v6.53：出站（主我→雷影）显示「主我 → 雷影·X：摘要」；入站保持「『雷影·X』发来 …」
          const kind = MBOX_TYPE_LABEL[d.type] || '消息';
          const body = String(d.preview || d.full || '').replace(/\s+/g, ' ').trim();
          const cut = body.length > 40 ? body.slice(0, 40) + '…' : body;
          const fromName = roleName(d.from || 'main');
          const toName = d.to ? roleName(d.to) : '';
          if ((d.outbound || d.from === 'main') && toName) return fromName + ' → ' + toName + '：' + kind + (cut ? (' ' + cut) : '');
          return '『' + fromName + '』发来 ' + kind + (cut ? ('：' + cut) : '');
        }
        case 'schedule': return d.message || ('定时任务 ' + (d.status || ''));
        case 'queued': return '排队中（第 ' + (d.position || '?') + ' 位）';
        case 'sessions-changed': {
          // v6.53：会话增删（聚合端点常见）；字段缺失也不空白
          const act = d.action === 'delete' ? '已删除' : (d.action === 'create' ? '已新建' : '有变更');
          const ttl = d.title ? ('『' + String(d.title).slice(0, 24) + '』') : (d.sessionId ? ('『' + sessionTitle(d.sessionId) + '』') : '');
          return (ttl ? ttl + ' ' : '') + '会话' + act;
        }
        default: return d.title || d.message || d.topic || TYPE_LABEL[e.type] || '事件';
      }
    }
    // v6.21：未知类型一律回退「事件」——绝不回退成原始英文类型名（既有约定：禁止英文类型名/裸会话 id）
    function label(t) { return TYPE_LABEL[t] || '事件'; }
    // v6.41：事件类型含义（未收录 → 空串，不产生空 title）
    function desc(t) { return TYPE_DESC[t] || ''; }
    const type = (e) => (e.type === 'compacted' ? 'handoff' : (['reflect', 'evolution', 'evolve'].includes(e.type) ? 'evolve' : (['task', 'reply', 'notify'].includes(e.type) ? e.type : 'notify')));
    return { list, filter, roles, roleKey, shortRole, roleMeta, icon, text, label, desc, LEGEND, hhmm, type, kfmt, usageStr, durStr, sessionTitle };
  },
  template: `
    <div v-if="roles.length > 1" class="ripple-filter">
      <button type="button" class="ripple-chip" :class="{ 'is-on': filter === 'all' }" @click="filter = 'all'">全部</button>
      <button v-for="r in roles" :key="r" type="button" class="ripple-chip" :class="{ 'is-on': filter === r }" :data-role="r" :style="roleMeta(r).color ? { '--rc': roleMeta(r).color } : {}" @click="filter = r">{{ shortRole(r) }}</button>
    </div>
    <div v-for="(e, i) in list" :key="i" class="ripple-item" :data-type="type(e)" :data-role="roleKey(e)">
      <span class="icon icon--sm ripple-item__icon" :style="{ '--i': 'url(' + icon(e.type) + ')' }"></span>
      <div>
        <div class="ripple-item__text"><span class="ripple-item__src" :data-role="roleKey(e)" :style="roleMeta(roleKey(e)).color ? { color: roleMeta(roleKey(e)).color } : {}">{{ shortRole(roleKey(e)) }}</span>{{ text(e) }}</div>
        <div v-if="usageStr(e)" class="ripple-item__usage">{{ usageStr(e) }}</div>
        <div class="ripple-item__meta" :title="label(e.type) + (desc(e.type) ? ' —— ' + desc(e.type) : '')">{{ hhmm(e.at) }} · {{ label(e.type) }}{{ durStr(e) }}</div>
      </div>
    </div>
    <details v-if="list.length" class="ripple-legend">
      <summary>事件说明（把鼠标停在任一条目的时间/类型上也可查看）</summary>
      <ul>
        <li v-for="t in LEGEND" :key="t"><b>{{ label(t) }}</b>：{{ desc(t) }}</li>
      </ul>
    </details>
    <div v-if="!list.length" class="dim" style="font-size:12px;padding:6px;">暂无事件（SSE 实时汇聚）</div>
  `,
});

export const VitalsMini = defineComponent({
  name: 'VitalsMini',
  setup() {
    const s = computed(() => store.sessionStats || null);   // 会话级（降级数据源）
    const agg = computed(() => store.sessionAgg || null);   // P1 聚合（引擎 aggregate=1）
    const isAgg = computed(() => !!(agg.value && agg.value.total));
    const total = computed(() => (isAgg.value ? agg.value.total : null));
    const items = computed(() => (isAgg.value && Array.isArray(agg.value.items) ? agg.value.items : []));
    const partial = computed(() => !!(isAgg.value && agg.value.partial === true));
    const src = computed(() => total.value || s.value);      // 展示数据源：聚合优先，未就绪降级单会话
    const pts = computed(() => (store.history && store.history.length ? store.history : []));
    const has = computed(() => !!(s.value || total.value));
    // 命中率：聚合态直接用引擎加权值 total.hitRate，绝不平均各会话 rate；降级用会话 cacheHitRate
    const rateNum = computed(() => (total.value && total.value.hitRate != null
      ? total.value.hitRate
      : (s.value && s.value.cacheHitRate != null ? s.value.cacheHitRate : null)));
    const cost = computed(() => (has.value && src.value.costRmb != null ? Number(src.value.costRmb).toFixed(3) : '—'));
    const hitPct = computed(() => (rateNum.value != null ? (rateNum.value * 100).toFixed(0) : '—'));
    const calls = computed(() => (has.value && src.value.calls != null ? src.value.calls : '—'));
    const used = computed(() => (s.value ? kfmt(s.value.usedTokens) : '—'));        // 上下文用量=当前会话（不聚合）
    const budget = computed(() => (s.value ? kfmt(s.value.contextBudget) : '—'));
    const hitTok = computed(() => (has.value ? kfmt(normTok(src.value, 'hit')) : '—'));
    const missTok = computed(() => (has.value ? kfmt(normTok(src.value, 'miss')) : '—'));
    const outTok = computed(() => (has.value ? kfmt(normTok(src.value, 'out')) : '—'));
    /* —— 以下均为「展示用」派生值（纯视觉映射/格式化，不改任何取值与计算逻辑，不改数据字段） —— */
    const usedPct = computed(() => {
      const u = s.value ? Number(s.value.usedTokens) || 0 : 0;
      const b = s.value ? Number(s.value.contextBudget) || 0 : 0;
      return b > 0 ? Math.min(100, Math.round((u / b) * 100)) : 0;
    });
    const usedLevel = computed(() => (usedPct.value >= 85 ? 'err' : usedPct.value >= 60 ? 'warn' : 'ok'));
    // 迷你曲线坐标（viewBox 0 0 100 32）：聚合 history 优先（引擎按 ts 合并），否则回退本会话回合点
    const WINDOW_MS = 12 * 3600 * 1000;   // 展示窗口（防跨天拉伸）
    const BUCKETS = 40;                    // 与 spark 点数同量级
    const turns = computed(() => (store.currentId && store.historyBySession[store.currentId]) || []);
    function normPt(p) {
      const at = Number(p.at != null ? p.at : (p.ts != null ? p.ts : p.t)) || 0;
      // 注意：字段 hit 有两种含义——引擎聚合 history 的 hit=命中 token 数；本会话点(store normalizeTurnUsage)的 hit=命中率(0~1)
      const hitRaw = Number(p.hit != null ? p.hit : p.cacheHitRate) || 0;
      const miss = Number(p.miss != null ? p.miss : p.missTokens) || 0;
      const out = Number(p.out != null ? p.out : p.outputTokens) || 0;
      let hitTok = Number(p.hitTokens) || 0;
      let hitRate = null;
      if (hitTok > 0) { /* 已有 token 明细，直接用 */ }
      else if (hitRaw > 1) { hitTok = hitRaw; }                        // 引擎 history：hit 即命中 token 数
      else if (hitRaw > 0 && miss > 0) {                               // 本会话点：hit 是命中率 → 由率+未命中反推 token
        hitRate = hitRaw;
        hitTok = hitRate * miss / (1 - hitRate);
      } else if (hitRaw >= 0 && hitRaw <= 1) { hitRate = hitRaw; }
      const cost = Number(p.cost) || (miss + out);
      const rate = hitRate != null ? hitRate : ((hitTok + miss) > 0 ? hitTok / (hitTok + miss) : 0);
      return { at, hit: rate, hitRate, miss, out, hitTok, cost, dur: Number(p.dur != null ? p.dur : p.durationMs) || 0 };
    }
    // 按真实时间归并 + 等时桶：桶内 cost 求和、命中率桶内加权（hitTok/(hitTok+miss)）
    function bucketize(raw) {
      const pts = raw.slice().sort((a, b) => a.at - b.at);
      if (!pts.length) return [];
      const t1 = pts[pts.length - 1].at || 0;
      const t0 = Math.max(pts[0].at || 0, t1 - WINDOW_MS);
      const win = pts.filter((p) => (p.at || 0) >= t0);
      const span = Math.max(1, t1 - t0);
      const n = Math.min(BUCKETS, Math.max(1, win.length));
      const bs = [];
      for (let i = 0; i < n; i++) bs.push({ at: t0 + (i / n) * span, cost: 0, hitTok: 0, miss: 0, out: 0, n: 0 });   // 空桶 at 按桶位（x 严格单调，防回跳）
      for (const p of win) {
        const idx = Math.min(n - 1, Math.floor(((p.at || 0) - t0) / span * n));
        const b = bs[idx];
        b.cost += p.cost; b.hitTok += p.hitTok; b.miss += p.miss; b.out += p.out; b.n++;
        b.at = Math.max(b.at, p.at || 0);
      }
      return bs.filter((b) => b.n > 0).map((b) => ({   // 丢弃空桶：只画有数据的桶（曲线不回跳）
        at: b.at, cost: b.cost, miss: b.miss, out: b.out, n: b.n,
        hit: (b.hitTok + b.miss) > 0 ? b.hitTok / (b.hitTok + b.miss) : 0,
      }));
    }
    const curve = computed(() => {
      const a = agg.value;
      const raw = (a && Array.isArray(a.history) && a.history.length) ? a.history.map(normPt) : turns.value.map(normPt);
      return bucketize(raw);
    });
    const hasTurns = computed(() => curve.value.length > 0);
    const timeSpan = computed(() => {
      const c = curve.value;
      if (!c.length) return [0, 1];
      const t0 = c[0].at || 0, t1 = c[c.length - 1].at || t0;
      return [t0, Math.max(1, t1)];
    });
    function scaleSeries(key, fixedMax) {
      const c = curve.value, n = c.length;
      if (!n) return [];
      const [t0, t1] = timeSpan.value, span = Math.max(1, t1 - t0);
      let max = fixedMax;
      if (max == null) { max = 0; for (const it of c) max = Math.max(max, Number(it[key]) || 0); if (max <= 0) max = 1; }
      return c.map((it, i) => {
        const tx = t1 > t0 ? (((it.at || t0) - t0) / span) * 100 : (n === 1 ? 50 : (i / (n - 1)) * 100);
        const r = Math.max(0, Math.min(1, (Number(it[key]) || 0) / max));
        return { x: Math.round(tx * 100) / 100, y: Math.round((32 - r * 30 - 1) * 100) / 100 };
      });
    }
    const hitPts = computed(() => scaleSeries('hit', 1));
    const costPts = computed(() => scaleSeries('cost', null));
    const hitLine = computed(() => hitPts.value.map((q) => q.x + ',' + q.y).join(' '));
    const costLine = computed(() => costPts.value.map((q) => q.x + ',' + q.y).join(' '));
    const hitArea = computed(() => (hasTurns.value ? '0,32 ' + hitLine.value + ' 100,32' : ''));
    const dots = computed(() => hitPts.value.map((q, i) => {
      const t = curve.value[i] || {};
      const pct = Math.round((t.hit || 0) * 100);
      const dur = t.dur ? Math.round(t.dur / 1000) + 's' : '—';
      const title = '命中率 ' + pct + '% · 消耗 ¥' + fmtCost(t.cost) + ' · 耗时 ' + dur;
      return { x: q.x, y: q.y, title };
    }));
    // 桶命中区（悬停显 L2 拆分，x 按真实时间对齐）
    const hitRects = computed(() => {
      const c = curve.value, n = c.length;
      if (!n) return [];
      const [t0, t1] = timeSpan.value, span = Math.max(1, t1 - t0);
      const xs = c.map((p) => (((p.at || t0) - t0) / span) * 100);
      return c.map((p, i) => {
        const x = i === 0 ? 0 : (xs[i - 1] + xs[i]) / 2;
        const x2 = i === n - 1 ? 100 : (xs[i] + xs[i + 1]) / 2;
        return { x: Math.round(x * 100) / 100, w: Math.max(0.5, Math.round((x2 - x) * 100) / 100) };
      });
    });
    const sparkLine = computed(() => hitLine.value);
    const sparkArea = computed(() => hitArea.value);
    // —— 曲线视觉增强（纯渲染层：平滑折线/面积、悬停指示；不改任何数据/聚合）——
    function _smoothSegs(pts) {
      let d = '';
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
        const t = 0.2;
        const c1x = p1.x + (p2.x - p0.x) * t, c1y = p1.y + (p2.y - p0.y) * t;
        const c2x = p2.x - (p3.x - p1.x) * t, c2y = p2.y - (p3.y - p1.y) * t;
        d += ' C' + c1x.toFixed(2) + ',' + c1y.toFixed(2) + ' ' + c2x.toFixed(2) + ',' + c2y.toFixed(2) + ' ' + p2.x + ',' + p2.y;
      }
      return d;
    }
    function _smoothPath(pts) {
      if (!pts.length) return '';
      if (pts.length === 1) return 'M' + pts[0].x + ',' + pts[0].y;
      if (pts.length === 2) return 'M' + pts[0].x + ',' + pts[0].y + ' L' + pts[1].x + ',' + pts[1].y;
      return 'M' + pts[0].x + ',' + pts[0].y + _smoothSegs(pts);
    }
    const BASE_Y = 31;   // 与 scaleSeries 对齐（r=0 时 y=31）——基线
    const hitPath = computed(() => _smoothPath(hitPts.value));
    const costPath = computed(() => _smoothPath(costPts.value));
    const hitAreaPath = computed(() => {
      const p = hitPts.value;
      if (!p.length) return '';
      const last = p[p.length - 1];
      return 'M' + p[0].x + ',' + BASE_Y + ' L' + p[0].x + ',' + p[0].y + _smoothSegs(p) + ' L' + last.x + ',' + BASE_Y + ' Z';
    });
    const lowData = computed(() => hitPts.value.length < 3);   // 空态/少点优雅降级判据
    // 注：迷你曲线已改用上方 sparkLine/sparkArea 驱动的响应式 SVG，无需命令式重绘。
    /* —— 本会话预算编辑（v1）：PUT /api/sessions/:id { contextBudget }；null=跟随全局 —— */
    const budgetOpen = ref(false);
    const budgetInput = ref('');
    const budgetErr = ref('');
    const budgetConfirm = ref(false);          // true=待确认（新预算 < 已用）
    const pendingBudget = ref(null);
    const usedTokNum = computed(() => (has.value ? (Number(s.value.usedTokens) || 0) : 0));
    const confirmNew = computed(() => (pendingBudget.value == null ? '' : kfmt(pendingBudget.value)));
    function parseBudget(t) {
      const str = String(t == null ? '' : t).trim().toLowerCase().replace(/[\s,]/g, '');
      const m = str.match(/^(\d+(?:\.\d+)?)([km]?)$/);
      if (!m) return NaN;
      let v = parseFloat(m[1]);
      if (m[2] === 'k') v *= 1000; else if (m[2] === 'm') v *= 1000000;
      return Math.round(v);
    }
    function openBudget() {
      budgetErr.value = ''; budgetConfirm.value = false; pendingBudget.value = null;
      budgetInput.value = (has.value && s.value.contextBudget) ? String(s.value.contextBudget) : '';
      budgetOpen.value = true;
    }
    function closeBudget() { budgetOpen.value = false; budgetErr.value = ''; budgetConfirm.value = false; pendingBudget.value = null; }
    async function applyBudget(v) {
      const id = store.currentId; if (!id) return;
      try {
        await api.sessionSetBudget(id, v);
        try { const st = await api.sessionStats(id); if (st) { store.sessionStats = st; if (window.__leizaiSyncBudget) window.__leizaiSyncBudget(st); } } catch { }
        closeBudget();
      } catch (e) { budgetErr.value = '保存失败：' + ((e && e.message) || e); budgetConfirm.value = false; }
    }
    async function submitBudget() {
      const v = parseBudget(budgetInput.value);
      if (!Number.isFinite(v) || v <= 0) { budgetErr.value = '请输入正整数 token（可写 150k）'; return; }
      if (v > BUDGET_MAX) { budgetErr.value = '预算不能超过 900000（模型上限约 1M，留安全余量）'; return; }
      if (v < usedTokNum.value) { pendingBudget.value = v; budgetConfirm.value = true; return; }   // 低于已用 → 需确认
      await applyBudget(v);
    }
    async function confirmSave() { const v = pendingBudget.value; budgetConfirm.value = false; if (v != null) await applyBudget(v); }
    function cancelSave() { budgetConfirm.value = false; pendingBudget.value = null; }
    async function setGlobalBudget() { await applyBudget(null); }

    /* —— P1 聚合：悬停明细（L2 桶 / L1+L3 下拉）+ 自动刷新（15s 轮询 + turn-done） —— */
    const detailOpen = ref(false);
    const detailStyle = ref({});
    const detailSide = ref('left');
    const cardEl = ref(null);
    const hoverB = ref(-1);
    const tipPos = ref({ x: 0, y: 0 });
    const tipAbove = ref(true);
    const tipEl = ref(null);
    const cursorX = computed(() => (hoverB.value >= 0 && hitPts.value[hoverB.value] ? hitPts.value[hoverB.value].x : null));
    const sparkEl = ref(null);
    let _aggTimer = null;
    // 智能定位：优先浮在卡片【左侧】（右栏空间有限），左侧不足则落下方；限宽 + 夹在可视区内防溢出
    function placeDetail() {
      const el = cardEl.value;
      if (!el || typeof window === 'undefined') return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;
      const W = Math.max(300, Math.min(560, Math.round(r.width * 2.2)));
      let left = r.left - W - 10;      // 左侧漂浮
      let top = r.top;
      let side = 'left';
      if (left < 8) { left = r.left; top = r.bottom + 8; side = 'below'; }   // 左侧空间不足 → 下方
      left = Math.max(8, Math.min(left, Math.max(8, vw - W - 8)));
      top = Math.max(8, Math.min(top, Math.max(8, vh - 140)));
      detailStyle.value = { left: left + 'px', top: top + 'px', width: W + 'px' };
      detailSide.value = side;
    }
    function onWinChange() { if (detailOpen.value) placeDetail(); }
    function openDetail() { if (!has.value) return; placeDetail(); detailOpen.value = true; }
    function closeDetail() { detailOpen.value = false; }
    function onBucket(i, e) {
      hoverB.value = i;
      if (!e) return;
      const W = tipEl.value ? tipEl.value.offsetWidth : 132;   // 首帧未渲染则用估宽，后续鼠标移动自动修正
      const H = tipEl.value ? tipEl.value.offsetHeight : 56;
      const vw = window.innerWidth || 1280;
      let x = Math.max(8 + W / 2, Math.min(vw - 8 - W / 2, e.clientX));   // 水平夹在可视区内
      tipAbove.value = (e.clientY - H - 14) >= 8;                        // 上方空间足 → 浮光标上方；否则落下方
      tipPos.value = { x: Math.round(x), y: Math.round(e.clientY) };
    }
    function offBucket() { hoverB.value = -1; }
    const hoverInfo = computed(() => {
      const b = curve.value[hoverB.value];
      if (!b) return null;
      return { time: hhmm(b.at) || '—', cost: b.cost, hitPct: Math.round((b.hit || 0) * 100), n: b.n };
    });
    function shortId(it) { return String((it && (it.sessionId || it.id)) || '').slice(0, 8) || '无会话'; }
    function fmtCost(v) { return v != null ? Number(v).toFixed(3) : '—'; }
    // 明细行取值（字段归一化）：role→中文全名；成本兼容 costRmb|cost；命中率由 token 计算；调用次数
    function roleNameOf(it) { if (!it) return '—'; if (it.role) return roleName(it.role, it.name); return it.name || '—'; }
    function fmtCostOf(it) { if (!it) return '—'; const v = it.costRmb != null ? it.costRmb : it.cost; return v != null ? Number(v).toFixed(3) : '—'; }
    function hitRateOf(it) { const h = normTok(it, 'hit'), m = normTok(it, 'miss'); return (h + m) > 0 ? Math.round(h / (h + m) * 100) + '%' : '—'; }
    function callsOf(it) { return it && it.calls != null ? it.calls : '—'; }
    onMounted(() => {
      refreshAgg(store.currentId, { force: true });
      _aggTimer = setInterval(() => refreshAgg(store.currentId, { force: true }), 15000);   // 与 links 同频，新增/注销雷影自动适应
      window.addEventListener('scroll', onWinChange, true);
      window.addEventListener('resize', onWinChange);
    });
    onUnmounted(() => {
      if (_aggTimer) { clearInterval(_aggTimer); _aggTimer = null; }
      window.removeEventListener('scroll', onWinChange, true);
      window.removeEventListener('resize', onWinChange);
    });
    watch(() => store.currentId, (id) => { invalidateAgg(); store.sessionAgg = null; refreshAgg(id, { force: true }); });

    return { s, has, cost, hitPct, calls, used, budget, hitTok, missTok, outTok, usedPct, usedLevel, sparkLine, sparkArea,
             hasTurns, hitLine, costLine, hitArea, hitPath, costPath, hitAreaPath, lowData, cursorX, dots, isAgg, total, items, partial, hitRects, curve, kfmt,
             detailOpen, detailStyle, detailSide, cardEl, openDetail, closeDetail, hoverInfo, hoverB, onBucket, offBucket, tipPos, tipAbove, tipEl, sparkEl, shortId, fmtCost, normTok, roleNameOf, fmtCostOf, hitRateOf, callsOf,
             budgetOpen, budgetInput, budgetErr, budgetConfirm, confirmNew, openBudget, closeBudget, submitBudget, confirmSave, cancelSave, setGlobalBudget };
  },
  template: `
    <div class="card__head">
      <span class="card__title">运行指标</span>
    </div>
    <div v-if="has" ref="cardEl" class="vm-card" tabindex="0" @mouseenter="openDetail" @mouseleave="closeDetail" @focusin="openDetail" @focusout="closeDetail" @keydown.esc="closeDetail">
      <div class="vm-grid">
        <div class="vm-cell vm-cell--cost"><span class="vm-cell__label">成本</span><span class="vm-cell__value">¥{{ cost }}</span></div>
        <div class="vm-cell vm-cell--hit"><span class="vm-cell__label">命中率</span><span class="vm-cell__value">{{ hitPct }}<i class="vm-cell__unit">%</i></span></div>
        <div class="vm-cell vm-cell--calls" title="LLM API 调用次数（含工具轮，非回合数）"><span class="vm-cell__label">调用</span><span class="vm-cell__value">{{ calls }}</span></div>
      </div>
      <div class="vm-usage" :class="{ 'is-editing': budgetOpen }">
        <div class="vm-usage__head">
          <span class="vm-usage__label">上下文用量</span>
          <span class="vm-usage__num mono">{{ used }} / {{ budget }} · {{ usedPct }}%</span>
          <button type="button" class="vm-usage__edit" :aria-expanded="budgetOpen ? 'true' : 'false'"
                  title="修改本会话上下文预算" aria-label="修改本会话预算" @click="budgetOpen ? closeBudget() : openBudget()">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.3 1.9a1.6 1.6 0 0 1 2.3 2.3l-7.2 7.2-3 .7.7-3 7.2-7.2zM2 14h12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <div v-if="budgetOpen" class="vm-budget">
          <input class="vm-budget__input" v-model="budgetInput" type="text" inputmode="numeric"
                 placeholder="如 150000 或 150k（≤900000）" :class="{ 'is-err': !!budgetErr }"
                 @keydown.enter.prevent="submitBudget" @keydown.esc.prevent="closeBudget" />
          <button type="button" class="vm-budget__btn vm-budget__btn--ok" @click="submitBudget">保存</button>
          <button type="button" class="vm-budget__btn" @click="setGlobalBudget" title="清除本会话覆盖，跟随全局">跟随全局</button>
          <button type="button" class="vm-budget__btn vm-budget__btn--ghost" @click="closeBudget">取消</button>
          <div v-if="budgetErr" class="vm-budget__err">{{ budgetErr }}</div>
        </div>
        <div v-if="budgetConfirm" class="vm-budget__confirm">
          <span class="vm-budget__confirm-txt">新预算 <b>{{ confirmNew }}</b> 小于当前窗口已用 <b>{{ used }}</b>，保存后会立即触发世代交接/窗口重建。</span>
          <span class="vm-budget__confirm-act">
            <button type="button" class="vm-budget__btn vm-budget__btn--ok" @click="confirmSave">确认保存</button>
            <button type="button" class="vm-budget__btn vm-budget__btn--ghost" @click="cancelSave">取消</button>
          </span>
        </div>
        <div class="progress" :data-level="usedLevel"><div class="progress__fill" :style="{ width: usedPct + '%' }"></div></div>
      </div>
      <div class="vm-tokens">
        <span class="vm-tok vm-tok--hit" title="缓存命中 token（✔=命中）"><b>✔{{ hitTok }}</b><em>命中</em></span>
        <span class="vm-tok vm-tok--miss" title="缓存未命中 token（✘=未命中）"><b>✘{{ missTok }}</b><em>未命中</em></span>
        <span class="vm-tok vm-tok--out" title="模型输出 token（↓=输出）"><b>↓{{ outTok }}</b><em>输出</em></span>
      </div>
      <template v-if="hasTurns">
        <svg ref="sparkEl" class="vm-spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="vmSparkStroke" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" class="vm-spark-stop-a"/><stop offset="1" class="vm-spark-stop-b"/>
            </linearGradient>
            <linearGradient id="vmSparkFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" class="vm-spark-fill-a"/><stop offset="1" class="vm-spark-fill-b"/>
            </linearGradient>
          </defs>
          <g class="vm-spark__grid">
            <line x1="0" y1="1" x2="100" y2="1" vector-effect="non-scaling-stroke"/>
            <line x1="0" y1="16" x2="100" y2="16" vector-effect="non-scaling-stroke"/>
            <line class="vm-spark__base" x1="0" y1="31" x2="100" y2="31" vector-effect="non-scaling-stroke"/>
          </g>
          <path class="vm-spark__area" :d="hitAreaPath" fill="url(#vmSparkFill)" stroke="none"/>
          <path class="vm-spark__line vm-spark__line--cost" :d="costPath" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
          <path class="vm-spark__line vm-spark__line--hit" :d="hitPath" fill="none" stroke="url(#vmSparkStroke)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
          <line v-if="cursorX !== null" class="vm-spark__cursor" :x1="cursorX" :x2="cursorX" y1="0" y2="32" vector-effect="non-scaling-stroke"/>
          <circle v-for="(d,i) in dots" :key="i" class="vm-spark__dot" :class="{ 'is-on': hoverB === i, 'is-solo': lowData }" :cx="d.x" :cy="d.y" :r="lowData ? 2.4 : 1.6" vector-effect="non-scaling-stroke"><title>{{ d.title }}</title></circle>
          <rect v-for="(r,i) in hitRects" :key="'h'+i" class="vm-spark__hit" :class="{ 'is-on': hoverB === i }" :x="r.x" y="0" :width="r.w" height="32"
                @mouseenter="onBucket(i,$event)" @mousemove="onBucket(i,$event)" @mouseleave="offBucket"/>
        </svg>
        <div class="vm-spark-legend"><span><i class="lg-hit"></i>命中率</span><span><i class="lg-cost"></i>消耗</span></div>
      </template>
      <div v-else class="vm-spark__empty">暂无回合曲线数据</div>
      <div v-if="hoverInfo" ref="tipEl" class="vm-bktip" :data-above="tipAbove ? '1' : '0'" :style="{ left: tipPos.x + 'px', top: tipPos.y + 'px' }">
        <div class="vm-bktip__t mono">{{ hoverInfo.time }}</div>
        <div class="vm-bktip__r">消耗 <b>¥{{ fmtCost(hoverInfo.cost) }}</b> · 命中率 <b>{{ hoverInfo.hitPct }}%</b></div>
        <div class="vm-bktip__r dim">{{ hoverInfo.n }} 回合</div>
      </div>
      <div v-if="detailOpen" class="vm-detail" :data-side="detailSide" :style="detailStyle" role="dialog" aria-label="运行指标明细">
        <div class="vm-detail__l1">
          <span class="vm-detail__lb">{{ isAgg ? '本会话 + 全部雷影' : '当前会话' }}</span>
          <b class="mono">¥{{ cost }}</b>
          <span class="dim">{{ hitPct }}% 命中 · {{ calls }} 调用</span>
          <span v-if="partial" class="vm-detail__badge">部分聚合</span>
        </div>
        <div v-if="!isAgg" class="vm-detail__solo dim">聚合端点未就绪，暂显示单会话数据</div>
        <div v-else-if="items.length" class="vm-detail__tw">
          <table class="vm-detail__tbl">
            <thead><tr><th>会话</th><th>命中率</th><th>命中</th><th>未命中</th><th>输出</th><th title="LLM API 调用次数（含工具轮，非回合数）">调用</th><th>成本</th><th>状态</th></tr></thead>
            <tbody>
              <tr v-for="(it,i) in items" :key="it.sessionId || it.id || i">
                <td class="vm-detail__who"><b>{{ roleNameOf(it) }}</b><em class="mono">{{ shortId(it) }}</em></td>
                <td class="mono vm-detail__c-rate">{{ hitRateOf(it) }}</td>
                <td class="mono vm-detail__c-hit">{{ kfmt(normTok(it, 'hit')) }}</td>
                <td class="mono vm-detail__c-miss">{{ kfmt(normTok(it, 'miss')) }}</td>
                <td class="mono vm-detail__c-out">{{ kfmt(normTok(it, 'out')) }}</td>
                <td class="mono vm-detail__c-calls">{{ callsOf(it) }}</td>
                <td class="mono vm-detail__c-cost">¥{{ fmtCostOf(it) }}</td>
                <td :class="it.online === false ? 'vm-detail__c-status is-off' : 'vm-detail__c-status is-on'">{{ it.online === false ? '离线' : '在线' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="vm-detail__solo dim">暂无关联会话明细</div>
      </div>
    </div>
    <div v-else class="vm-empty">
      <div class="vm-skeleton" aria-hidden="true"><span class="vm-skel-cell"></span><span class="vm-skel-cell"></span><span class="vm-skel-cell"></span></div>
      <div class="vm-empty__row">
        <span class="vm-empty__icon icon icon--sm" style="--i:url(/assets/ui-list.svg)"></span>
        <div class="vm-empty__txts">
          <span class="vm-empty__text">暂无会话数据</span>
          <span class="vm-empty__hint">本会话产生模型调用后，这里显示成本 / 命中率 / token 明细</span>
        </div>
      </div>
    </div>
  `,
});
