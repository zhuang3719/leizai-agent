// A1 前端 · 思考块（T-C4）——对齐美工契约 .think-card__*
import { defineComponent, ref } from 'vue';

export const ThinkCard = defineComponent({
  name: 'ThinkCard',
  props: { text: { type: String, default: '' }, live: { type: Boolean, default: false } },
  setup() { return { open: ref(false) }; },
  template: `
    <div :class="['think-card', { 'is-open': open }]" data-kind="think">
      <div class="think-card__head" @click="open = !open">💭 思考{{ live ? '中…' : '' }}（点击{{ open ? '收起' : '展开' }}）</div>
      <div class="think-card__body">{{ text }}</div>
    </div>
  `,
});
