// A1 前端 · 顶栏态势（挂载 #vitals / #vital-model）——多根渲染（不重复 host class）
import { defineComponent, computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { store } from '../store.js';

function pct(used, budget) { return budget > 0 ? Math.min(100, Math.round(used / budget * 100)) : 0; }
// 预算值格式化：≥10000 用「万」单位（150000→15W；15000→1.5W；9000→9000）
function fmtBudget(v) {
  const n = Number(v) || 0;
  if (n >= 10000) {
    const w = n / 10000;
    return (Number.isInteger(w) ? String(w) : w.toFixed(1).replace(/\.0$/, '')) + 'W';
  }
  return String(n);
}

export const VitalsBar = defineComponent({
  name: 'VitalsBar',
  setup() {
    const summary = ref({ totalUnread: 0 });
    onMounted(async () => { try { summary.value = await api.mailboxSummary(); } catch { } });
    // v6.17：顶栏成本改读「今日 0 点起 · 全家四实例合计」审计结果（/api/cost/today，引擎侧 60s 缓存）
    const todayCost = ref(null);
    async function loadCost() { try { todayCost.value = await api.costToday(); } catch { todayCost.value = null; } }
    onMounted(loadCost);
    const costTimer = setInterval(loadCost, 60000);   // 与 ModelBadge 30s 轮询同风格（轻量本地端点）
    if (costTimer && typeof costTimer.unref === 'function') costTimer.unref();
    // v6.19：自省指标簇（源＝自省舱 Mirror · /api/growth 的 latest），60s 轮询，风格同 todayCost
    const growth = ref(null);
    async function loadGrowth() { try { growth.value = await api.growth(); } catch { growth.value = null; } }
    onMounted(loadGrowth);
    const growthTimer = setInterval(loadGrowth, 60000);
    if (growthTimer && typeof growthTimer.unref === 'function') growthTimer.unref();
    const MIRROR_ITEMS = [
      { key: 'memories',      label: '认知', cls: 'vc-item--self',  tip: '自我认知记忆（self:*）条数（主我）',
        d: 'M12 3.5l2.3 6.2L20.5 12l-6.2 2.3L12 20.5l-2.3-6.2L3.5 12l6.2-2.3z' },
      { key: 'totalMemories', label: '记忆', cls: 'vc-item--mem',   tip: '长期记忆总条数（主我全部命名空间，不含雷影）',
        d: 'M4 7.5L12 3.5l8 4-8 4zM4 12l8 4 8-4M4 16.5l8 4 8-4' },
      { key: 'skills',        label: '技能', cls: 'vc-item--skill', tip: '已掌握技能数（主我，skills 包）',
        d: 'M14.5 3.5l6 6-2.5 2.5-6-6zM11 8.5L3.5 16v4.5H8L15.5 13' },
      { key: 'evoVersions',   label: '进化', cls: 'vc-item--evo',   tip: '进化版本数（主我，含已批准提案）',
        d: 'M4 17.5l6-6 3.5 3.5L20 8M15.5 8H20v4.5' },
      { key: 'sessions',      label: '会话', cls: 'vc-item--sess',  tip: '会话（项目）总数（主我）',
        d: 'M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9.5l-5 4z' },
    ];
    const mirrorItems = computed(() => {
      const l = (growth.value && growth.value.latest) || null;
      return MIRROR_ITEMS.map((it) => {
        const n = l ? l[it.key] : null;
        return { key: it.key, label: it.label, cls: it.cls, tip: it.tip, d: it.d, num: n == null ? '—' : String(n) };
      });
    });
    const s = computed(() => store.stats || {});
    const budgetVal = computed(() => fmtBudget(store.defaultBudget || 0));   // v1：顶栏显示「全局默认预算」(config.contextBudget)，非本会话生效值
    const hit = computed(() => (s.value.cacheHitRate != null ? Math.round(s.value.cacheHitRate * 100) : 0));
    // 今日全家审计成本；取不到 → 回落显示原「本次运行累计」
    const todayOk = computed(() => !!(todayCost.value && todayCost.value.ok && todayCost.value.total && (todayCost.value.total.costRmbAll != null || todayCost.value.total.costRmb != null)));
    const cost = computed(() => {
      if (todayOk.value) { const _t = todayCost.value.total; return Number(_t.costRmbAll != null ? _t.costRmbAll : _t.costRmb).toFixed(3); }
      return (s.value.costRmb != null ? Number(s.value.costRmb).toFixed(3) : '0.000');
    });
    // v6.18：成本悬停改为「今日消耗」下拉卡片（自绘 popover；不再用原生 title，避免与全局 TooltipHost 双提示）
    const ROLE_LABEL = { '主我': 'main', '程序员': 'programmer', '美工': 'designer', '文案': 'writer', '测试': 'tester', '研究员': 'researcher', '销售': 'sales', '剪辑师': 'editor' };
    function fmtClock(iso) {
      const d = iso ? new Date(iso) : null;
      if (!d || isNaN(d.getTime())) return '';
      const p = (n) => String(n).padStart(2, '0');
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    const costMeta = computed(() => {
      if (!todayOk.value) return null;
      const d = todayCost.value, t = d.total || {};
      return {
        day: d.day || '',
        total: Number(t.costRmbAll != null ? t.costRmbAll : (t.costRmb || 0)).toFixed(3),
        hitRate: t.hitRate != null ? Math.round(t.hitRate * 100) : null,
        time: fmtClock(d.generatedAt),
      };
    });
    const costRows = computed(() => {
      if (!todayOk.value) return [];
      const inst = todayCost.value.instances || {};
      const rows = Object.keys(inst).map((key) => {
        const v = inst[key] || {};
        const name = String(key).split('(')[0].trim();
        return {
          key, name,
          role: ROLE_LABEL[name] || '',
          cost: Number(v.costRmbAll != null ? v.costRmbAll : (v.costRmb || 0)),
          turns: Number(v.turns || 0),
          hitRate: v.hitRate != null ? Math.round(v.hitRate * 100) : null,
        };
      }).sort((a, b) => b.cost - a.cost);
      const max = rows.reduce((m, r) => Math.max(m, r.cost), 0);
      rows.forEach((r) => { r.pct = (max > 0 && r.cost > 0) ? Math.max(4, Math.round(r.cost / max * 100)) : 0; });
      return rows;
    });
    // hover 展开/收起：90ms 悬停意图开 + 140ms 延迟收（防抖动）
    // v6.20：卡片改为 <Teleport to="body"> + position:fixed（脱离 .titlebar__mid 的 overflow 裁剪），
    //        坐标由触发元素 rect 现算（右对齐 + 视口内夹取），不影响上轮"窗口控件不被顶出"。
    const COST_POP_W = 272;
    const costOpen = ref(false);
    const costPos = ref({ left: 0, top: 0 });
    let costOpenT = null, costCloseT = null;
    function openCost(ev) {
      clearTimeout(costCloseT); clearTimeout(costOpenT);
      try {
        const el = (ev && ev.currentTarget) || document.getElementById('vital-cost');
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth || 1024, gap = 8, pad = 8;
        let left = Math.round(r.right - COST_POP_W);
        left = Math.max(pad, Math.min(left, Math.max(pad, vw - COST_POP_W - pad)));
        costPos.value = { left, top: Math.round(r.bottom + gap) };
      } catch { costPos.value = { left: 8, top: 48 }; }
      costOpenT = setTimeout(() => { costOpen.value = true; }, 90);
    }
    function closeCost() { clearTimeout(costOpenT); clearTimeout(costCloseT); costCloseT = setTimeout(() => { costOpen.value = false; }, 140); }
    // 余额不可用兜底（顶栏勿空白）：非 DeepSeek 提供商时 /api/balance 返回
    //   {isAvailable:false,error:'余额仅 DeepSeek 提供方支持'} —— 明确提示「不支持余额」；
    //   DeepSeek 正常显示与查询失败显示 '—' 均不变。兼容后端未来加显式 unsupported 标记。
    const balanceUnsupported = computed(() => {
      const b = store.balance;
      if (!b) return false;
      if (b.unsupported === true) return true;
      return b.isAvailable === false && /余额仅 DeepSeek 提供方支持/.test(String(b.error || ''));
    });
    const balanceCls = computed(() => {
      const b = store.balance;
      if (!b || b.isAvailable === false || b.balance == null || isNaN(b.balance)) return '';
      const v = Number(b.balance);
      return v < 5 ? 'is-critical' : (v < 20 ? 'is-low' : '');
    });

    const balance = computed(() => {
      if (balanceUnsupported.value) return '—';   // 不支持态值位=与未加载/失败同款「—」；说明见 title 悬停
      const b = store.balance;
      if (!b || b.isAvailable === false || b.balance == null || isNaN(b.balance)) return '—';
      return '¥' + Number(b.balance).toFixed(2);
    });
    const backendOk = computed(() => !!(store.health && store.health.ok));
    const port = computed(() => (store.env && store.env.port) || 3458);
    // v6.11 修复：store.mailbox 存在时以它为准（totalUnread=0 也必须生效）；
    // 旧写法用 `||` 链，0 被当 falsy → 回落到只在 onMounted 取过一次的 summary（陈旧）→ 角标永久卡住。
    const unread = computed(() => {
      const m = store.mailbox;
      if (m && m.totalUnread != null) return m.totalUnread;
      return summary.value.totalUnread || 0;
    });
    function notify() { window.dispatchEvent(new CustomEvent('leizai-open-berth', { detail: 'dock' })); }
    return { mirrorItems, budgetVal, hit, cost, costMeta, costRows, costOpen, costPos, openCost, closeCost, balanceCls, balanceUnsupported, balance, backendOk, port, unread, notify };
  },
  template: `
    <div class="vitals-cluster vitals-cluster--mirror" id="vitals-mirror" aria-label="自省指标">
      <span class="vc-title" title="自省 Mirror · 仅主我（不含雷影） · 累计统计（每 60s 刷新）">
        <span class="icon vc-title__icon" style="--i:url(/assets/icon-mirror.svg)"></span>
        <span class="vc-title__text">自省</span>
      </span>
      <span v-for="it in mirrorItems" :key="it.key" class="vc-item" :class="it.cls" :title="it.tip">
        <svg class="vc-item__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="it.d"/></svg>
        <span class="vc-item__label">{{ it.label }}</span>
        <span class="vc-item__num">{{ it.num }}</span>
      </span>
    </div>
    <div class="vital vital--ring" id="vital-budget-ring" title="全局默认预算"><span class="dim">预算</span><span class="vital__value">{{ budgetVal }}</span></div>
    <div class="vital" id="vital-hit" title="引擎自启动以来累计（本次运行），重启清零"><span class="dim">命中</span><span class="vital__value">{{ hit }}%</span></div>
    <div class="vital vital--cost" id="vital-cost" tabindex="0" aria-haspopup="dialog" :aria-expanded="costOpen ? 'true' : 'false'" @mouseenter="openCost" @mouseleave="closeCost" @focus="openCost" @blur="closeCost"><span class="dim">成本</span><span class="vital__value">¥{{ cost }}</span></div>
    <Teleport to="body">
      <div v-if="costOpen" class="cost-pop is-open" :style="{ left: costPos.left + 'px', top: costPos.top + 'px' }" role="dialog" aria-label="今日消耗" @mouseenter="openCost" @mouseleave="closeCost">
        <template v-if="costMeta">
          <div class="cost-pop__head">
            <span class="cost-pop__title">今日消耗</span>
            <span class="cost-pop__day">{{ costMeta.day }} · 当天 0 点起</span>
          </div>
          <div class="cost-pop__totalbox">
            <span class="cost-pop__totallabel">全家合计</span>
            <span class="cost-pop__total">¥{{ costMeta.total }}</span>
          </div>
          <div class="cost-pop__rows">
            <div v-for="r in costRows" :key="r.key" class="cost-pop__row" :class="r.role ? ('role-' + r.role) : ''">
              <span class="cost-pop__meta">
                <span class="cost-pop__name">{{ r.name }}</span>
                <span class="cost-pop__sub">{{ r.turns }} 回合<span v-if="r.hitRate != null"> · 命中 {{ r.hitRate }}%</span></span>
              </span>
              <span class="cost-pop__track"><span class="cost-pop__fill" :style="{ width: r.pct + '%' }"></span></span>
              <span class="cost-pop__amt">¥{{ r.cost.toFixed(3) }}</span>
            </div>
          </div>
          <div class="cost-pop__foot">
            <span>命中率 {{ costMeta.hitRate != null ? costMeta.hitRate + '%' : '—' }}</span>
            <span>{{ costMeta.time }} 刷新</span>
          </div>
        </template>
        <div v-else class="cost-pop__empty">今日暂无数据<span class="cost-pop__empty-hint">当前显示：本次运行累计（自启动以来）</span></div>
      </div>
    </Teleport>
    <div class="vital" id="vital-balance" :class="balanceCls" :title="balanceUnsupported ? '该提供商不支持余额（余额查询仅 DeepSeek 提供方支持）' : '账户余额'"><span class="dim">余额</span><span class="vital__value">{{ balance }}</span></div>
    <div class="vital" id="vital-backend"><span class="dot" :class="backendOk ? 'dot-online' : 'dot-error'"></span><span class="vital__value">后端 {{ port }}</span></div>
    <button class="vital" id="vital-notify" title="调度中心收件箱" @click="notify">
      <span class="icon icon--sm" style="--i:url(/assets/type-notify.svg)"></span>
      <span v-if="unread" class="badge badge--pulse">{{ unread > 99 ? '99+' : unread }}</span>
    </button>
    <!-- 档位指示器（雷影·美工）：紧邻「调度中心收件箱」右侧；内容/交互由 app.js initVitalTier() 驱动（静态节点，Vue 不接管其子内容） -->
    <button type="button" class="vital vital--tier" id="vital-tier" hidden></button>
    <!-- 官网按钮（雷影·美工）：排在档位指示器右侧；非产品化 nag，dev/产品均显示。点击由 app.js openOfficialSite() 走桥 openExternal -->
    <button type="button" class="vital vital--site" id="vital-site" title="打开官网 leizai.cc">
      <svg class="vs-ico" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3.2 12h17.6"/><path d="M12 3c2.5 2.9 2.5 15.1 0 18M12 3c-2.5 2.9-2.5 15.1 0 18"/></svg>
      <span class="vs-label">官网</span>
    </button>
  `,
});

export const ModelBadge = defineComponent({
  name: 'ModelBadge',
  setup() {
    // v6.16：改读 /api/config 的 model / reasoningEffort（此前读不存在的 lastTurn.model → 恒回落 deepseek·low）
    const cfg = ref(null);
    async function load() { try { cfg.value = await api.config(); } catch { } }
    onMounted(load);
    window.__leizaiReloadModel = load;
    const timer = setInterval(load, 30000);   // 配置变更后 30s 内同步（轻量本地端点）
    if (timer && typeof timer.unref === 'function') timer.unref();
    const text = computed(() => {
      const c = cfg.value || {};
      return (c.model || 'deepseek') + ' · 推理 ' + (c.reasoningEffort || 'low');
    });
    return { text };
  },
  template: `<span>{{ text }}</span>`,
});
