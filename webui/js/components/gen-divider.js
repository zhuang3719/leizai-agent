// A1 前端 · 世代分隔条（T-C5①，O-6）——按美工 class 契约重建
// 契约：.gen-divider[data-gen]
import { defineComponent } from 'vue';

export const GenDivider = defineComponent({
  name: 'GenDivider',
  // v6.36：渲染以 content 为唯一真相源（sse.js 已把正确文案拼进 content）——
  // 原因：原 :gen 读取不存在的 it.m.gen → 落到占位默认值，渲染出问号
  props: {
    text: { type: String, default: '' },
  },
  computed: {
    // data-gen 供 CSS/调试用：从文本提取代数（如「第 52 代」→ 52），无则空
    gen() { const m = /第\s*(\d+)\s*代/.exec(this.text || ''); return m ? m[1] : ''; },
    label() { return this.text || '世代交接'; },   // 兜底也不出现问号（v6.45：去掉 emoji，模板另插 logo 图形）
  },
  template: `
    <div class="gen-divider" :data-gen="gen"><img class="gen-divider__logo" src="./assets/logo.svg" alt="" aria-hidden="true">{{ label }}</div>
  `,
});
