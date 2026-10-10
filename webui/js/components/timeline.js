// A1 前端 · 信箱时间线项（多根输出；调用方 host 应已带 .timeline 容器 class）
// 契约：.timeline-item[data-type=task|reply|notify][.is-unread]
//   > .timeline-item__head(.chip.role-* / .chip / .timeline-item__time) + .timeline-item__text
import { defineComponent } from 'vue';

export const Timeline = defineComponent({
  name: 'Timeline',
  props: { items: { type: Array, default: () => [] } },
  template: `
    <div v-for="(it, i) in items" :key="it.id != null ? it.id : i"
         :class="['timeline-item', { 'is-unread': it.unread }]"
         :data-type="it.type || 'notify'">
      <div class="timeline-item__head">
        <span v-if="it.role || it.from" class="chip" :class="'role-' + (it.role || 'main')">{{ it.role || it.from }}</span>
        <span class="chip">{{ it.type || 'notify' }}</span>
        <span class="timeline-item__time">{{ it.time }}</span>
      </div>
      <div class="timeline-item__text">{{ it.text }}</div>
    </div>
    <div v-if="!items.length" class="empty"><div class="empty__text">暂无消息</div></div>
  `,
});
