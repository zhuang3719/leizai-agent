// A1 前端 · 命令面板结果列表（挂载 #palette-list）——多根渲染（不重复 host 的 .palette__list）
// 输入 #palette-input 与点击/键盘导航由 app.js 接线（事件委派）
import { defineComponent, computed } from 'vue';
import { store } from '../store.js';

export const PaletteList = defineComponent({
  name: 'PaletteList',
  setup() {
    const items = computed(() => store.palette.items || []);
    const idx = computed(() => store.palette.idx || 0);
    function hover(i) { store.palette.idx = i; }
    return { items, idx, hover };
  },
  template: `
    <template v-for="(it, i) in items" :key="i">
      <div :class="['palette__opt', { 'is-active': i === idx }]" :data-idx="i" @mouseenter="hover(i)">
        <span v-if="it.icon" class="icon icon--sm" :style="{ '--i': 'url(' + it.icon + ')' }"></span>
        <span>{{ it.label }}</span>
        <span v-if="it.kbd" class="kbd">{{ it.kbd }}</span>
        <span v-else-if="it.desc" class="dim" style="margin-left:auto;font-size:11px;">{{ it.desc }}</span>
      </div>
    </template>
    <div v-if="!items.length" class="empty"><div class="empty__text">无匹配</div></div>
  `,
});
