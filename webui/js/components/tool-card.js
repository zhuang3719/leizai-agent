// A1 前端 · 工具调用折叠卡（T-C4）——对齐美工契约 .tool-card__*
import { defineComponent, ref, computed } from 'vue';

export const ToolCard = defineComponent({
  name: 'ToolCard',
  // v8.7：live=false（回合已结束/已停止）时非终态一律渲染为 done，杜绝停止后残留 running 态。
  props: { tool: { type: Object, required: true }, live: { type: Boolean, default: false } },
  setup(props) {
    const open = ref(true);
    const argsText = computed(() => {
      const a = props.tool.args;
      if (a == null) return '';
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a, null, 2); } catch { return String(a); }
    });
    const isErr = computed(() => props.tool.outcome === 'error');
    const isTerminal = computed(() => ['done', 'ok', 'error', 'aborted', 'cancelled', 'canceled'].includes(props.tool.outcome));
    const dotCls = computed(() => isErr.value ? 'dot-error' : (isTerminal.value ? 'dot-online' : (props.live ? 'dot-busy' : 'dot-online')));
    const summary = computed(() => props.tool.summary || (typeof props.tool.args === 'object' ? (props.tool.args && (props.tool.args.command || props.tool.args.path || props.tool.args.query)) : '') || '');
    return { open, argsText, isErr, dotCls, summary };
  },
  template: `
    <div :class="['tool-card', { 'is-err': isErr, 'is-open': open }]" :data-tool="tool.name">
      <div class="tool-card__head" @click="open = !open">
        <span :class="['dot', dotCls]"></span>
        <span class="tool-card__name">{{ tool.name }}</span>
        <span class="tool-card__summary ellipsis">{{ summary }}</span>
        <span class="icon icon--sm tool-card__chev" style="--i:url(/assets/ui-chevron.svg)"></span>
      </div>
      <div class="tool-card__body">
        <pre v-if="argsText" class="tool-term">{{ argsText }}</pre>
        <div v-if="tool.summary" class="tool-card__summary" style="padding:6px 0 0;">{{ tool.summary }}</div>
      </div>
    </div>
  `,
});
