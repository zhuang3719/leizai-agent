// A1 前端 · 工具调用聚合组（一轮多个工具收进同一个框，默认折叠）
// 契约：.tool-group(+.is-open) > .tool-group__head(🔧 共 N 个工具调用 + 最近工具名/状态点 + chevron) + .tool-group__body
//       body 内每工具一行 .tool-line(+.is-open) > .tool-line__head + .tool-line__body(args/输出)
import { defineComponent, ref, computed } from 'vue';
import { isProLimitText } from './bubble.js';
import { store } from '../store.js';

// v8.7：live=true（本回合仍在跑）时"无终态=busy"；live=false（回合已结束/已停止）时
//   无终态一律渲染为 done —— 保证回合结束后 DOM 里不残留任何 running/loading 态（停止后 spinner 不收的兜底）。
const TERMINAL = { done: 1, ok: 1, error: 1, aborted: 1, cancelled: 1, canceled: 1 };
function toolState(tool, live) {
  if (!tool) return live ? 'busy' : 'done';
  if (tool.outcome === 'error') return 'error';
  if (TERMINAL[tool.outcome]) return 'done';
  return live ? 'busy' : 'done';
}
function dotClass(state) {
  return state === 'error' ? 'dot-error' : (state === 'done' ? 'dot-online' : 'dot-busy');
}
function toolSummary(tool) {
  if (!tool) return '';
  if (tool.summary) return tool.summary;
  const a = tool.args;
  if (a && typeof a === 'object') return a.command || a.path || a.query || '';
  return typeof a === 'string' ? a : '';
}
function argsText(tool) {
  const a = tool && tool.args;
  if (a == null) return '';
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a, null, 2); } catch { return String(a); }
}

export const ToolGroup = defineComponent({
  name: 'ToolGroup',
  // v8.7：live=true 表示该组属于"本回合实时流且回合仍在跑"；false/缺省 = 历史或回合已结束。
  props: { tools: { type: Array, default: () => [] }, live: { type: Boolean, default: false } },
  setup(props) {
    const open = ref(false);            // 组框默认折叠
    const openLines = ref({});          // 单行展开态（默认全收起）
    const count = computed(() => (props.tools || []).length);
    const last = computed(() => (count.value ? props.tools[count.value - 1] : null));
    // 详情输出：优先用完整结果 out（历史消息），无则回退 summary（live 流）
    const outText = (t) => (t && t.out != null && t.out !== '') ? t.out : (t ? (t.summary || '') : '');
    // Pro 升级引导（雷影·美工）：工具结果命中 Pro 限额文案 → 行内升级按钮（此组件才是工具的实际渲染处）
    // tier 门槛（同源 store.pro，口径同 bubble.js）：仅 lite 档才可能显示；非 lite（dev/pro/激活）一律 false，防后端已放行时误报
    const proTier = () => ((store.pro && store.pro.effective && store.pro.effective.tier) || 'lite');
    const proLimit = (t) => isProLimitText((t && (t.summary || '')) + ' ' + outText(t));
    const proExpired = (t) => /过期|expired/i.test((t && (t.summary || '')) + ' ' + outText(t));
    // create_agent 结构化门禁判据：**仅**按「工具名=create_agent + 结果 JSON.error ∈ 门禁码」判定，
    // 不做子串匹配（防读源码/搜索到该字符串就误显）。任意档位均可显示（Pro 配额满也需引导）。
    const _createGate = (t) => {
      if (!t || t.name !== 'create_agent') return false;
      let j = null; try { j = JSON.parse(outText(t)); } catch { j = null; }
      return !!(j && (j.error === 'pro_required' || j.error === 'role_limit_exceeded'));
    };
    const groupProLimit = computed(() => {
      const tools = props.tools || [];
      const liteText = proTier() === 'lite' && tools.some((t) => proLimit(t));   // Lite 档自然语言限额文案
      return liteText || tools.some((t) => _createGate(t));                      // create_agent 结构化门禁拒绝
    });
    const groupProExpired = computed(() => proTier() === 'lite' && (props.tools || []).some((t) => proExpired(t)));
    function openPro() { if (window.__leizaiOpenPro) window.__leizaiOpenPro(); }
    return {
      open, count, last,
      state: (t) => toolState(t, props.live), dot: dotClass, summary: toolSummary, argsText, outText,
      lineOpen: (i) => !!openLines.value[i],
      toggleLine: (i) => { openLines.value = Object.assign({}, openLines.value, { [i]: !openLines.value[i] }); },
      groupProLimit, groupProExpired, openPro,
    };
  },
  template: `
    <div :class="['tool-group', { 'is-open': open }]" :data-count="count">
      <div class="tool-group__head" @click="open = !open">
        <span class="icon icon--sm tool-group__icon" style="--i:url(/assets/ui-list.svg)"></span>
        <span class="tool-group__title">🔧 共 {{ count }} 个工具调用</span>
        <span v-if="last" class="tool-group__last">
          <span :class="['dot', dot(state(last))]"></span>
          <span class="tool-group__last-name ellipsis">{{ last.name }}</span>
        </span>
        <button v-if="groupProLimit" type="button" class="pro-cta pro-cta--sm" @click.stop="openPro"><span class="pro-cta__i" aria-hidden="true">⚡</span>{{ groupProExpired ? '续费 Pro' : '升级 Pro' }}</button>
        <span class="icon icon--sm tool-group__chev" style="--i:url(/assets/ui-chevron.svg)"></span>
      </div>
      <div v-if="open" class="tool-group__body">
        <div v-for="(t, i) in tools" :key="i"
             :class="['tool-line', { 'is-open': lineOpen(i), 'is-err': state(t) === 'error' }]"
             :data-tool="t.name">
          <div class="tool-line__head" @click.stop="toggleLine(i)">
            <span :class="['dot', dot(state(t))]"></span>
            <span class="tool-line__name">{{ t.name }}</span>
            <span class="tool-line__summary ellipsis">{{ summary(t) }}</span>
            <span class="icon icon--sm tool-line__chev" style="--i:url(/assets/ui-chevron.svg)"></span>
          </div>
          <div v-if="lineOpen(i)" class="tool-line__body">
            <pre v-if="argsText(t)" class="tool-term">{{ argsText(t) }}</pre>
            <pre v-if="outText(t)" class="tool-term tool-term--out">{{ outText(t) }}</pre>
          </div>
        </div>
      </div>
    </div>
  `,
});
