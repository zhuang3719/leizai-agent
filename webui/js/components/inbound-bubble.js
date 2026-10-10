// A1 前端 · 入站雷影消息气泡（v6.1）——左侧头像 + 类型徽标 + 角色色边 + 预览/展开全文
// 零 token：头像/徽标用现成 assets/*.svg，正文只在前端渲染（不进 LLM 上下文）。
import { defineComponent, ref, computed } from 'vue';
import { roleMeta, roleName, hhmm, roleVar } from '../roles.js';

const TYPE_META = {
  reply:  { label: '回执', cls: 'type-reply' },
  task:   { label: '派活', cls: 'type-task' },
  notify: { label: '通知', cls: 'type-notify' },
  ack:    { label: '确认', cls: 'type-reply' },
};

export const InboundBubble = defineComponent({
  name: 'InboundBubble',
  props: { data: { type: Object, required: true } },
  setup(props) {
    const expanded = ref(false);
    const meta = computed(() => roleMeta(props.data.from));
    const fromName = computed(() => roleName(props.data.from, props.data.fromName));
    const tinfo = computed(() => TYPE_META[props.data.type] || { label: '消息', cls: 'type-notify' });
    const full = computed(() => String(props.data.full || ''));
    const preview = computed(() => String(props.data.preview || props.data.full || ''));
    const expandable = computed(() => full.value.length > preview.value.length);
    const body = computed(() => (expanded.value ? full.value : preview.value));
    return { expanded, meta, tinfo, expandable, body, hhmm, fromName, roleVar };
  },
  template: `
    <div class="inbound-bubble" :class="[meta.cls]" :style="roleVar(data.from)" :data-role="data.from" :data-type="data.type">
      <div class="inbound-bubble__avatar avatar" :title="fromName"><span class="role-icon" :style="{ '--icon': 'url(' + meta.icon + ')' }" role="img" :aria-label="meta.name"></span></div>
      <div class="inbound-bubble__main">
        <div class="inbound-bubble__head">
          <span class="inbound-bubble__name">{{ fromName }}</span>
          <span class="inbound-bubble__type chip" :class="meta.cls">
            <span class="role-icon role-icon--sm" :style="{ '--icon': 'url(/assets/' + tinfo.cls + '.svg)' }" aria-hidden="true"></span><span>{{ tinfo.label }}</span>
          </span>
          <span class="inbound-bubble__time dim">{{ hhmm(data.ts) }}</span>
        </div>
        <div class="inbound-bubble__body">{{ body }}</div>
        <button v-if="expandable" class="inbound-bubble__more" @click="expanded = !expanded">{{ expanded ? '收起' : '展开全文' }}</button>
      </div>
    </div>
  `,
});
