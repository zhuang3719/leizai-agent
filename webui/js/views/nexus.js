// A1 前端 · 中枢 Nexus 招牌组件（挂载 #orbit / #gen-rings / #nexus-cards）——多根渲染
// 池心脉冲环 #core-pulse 不挂载：由 app.js 命令式更新属性（保留美工 SVG）
import { defineComponent, computed } from 'vue';
import { store, toast, roleBusy } from '../store.js';
import { roleMeta, roleName, roleVar } from '../roles.js';

// —— 环流 OrbitView（挂载 #orbit；host 已是 .orbit 定位容器，组件只输出 SVG + 节点）——
export const OrbitView = defineComponent({
  name: 'OrbitView',
  setup() {
    const nodes = computed(() => (store.mailbox && store.mailbox.roles) || []);
    const R = 150;
    function pos(i, n) {
      const a = (-Math.PI / 2) + (i * 2 * Math.PI / Math.max(1, n));
      return { x: Math.round(Math.cos(a) * R), y: Math.round(Math.sin(a) * R) };
    }
    const placed = computed(() => {
      const n = nodes.value.length;
      return nodes.value.map((r, i) => {
        const p = pos(i, n);
        const m = roleMeta(r.role);
        const style = { '--x': p.x + 'px', '--y': p.y + 'px' };
        Object.assign(style, roleVar(r.role));   // 预置/自定义统一补 --role（预置=token 引用，自定义=哈希色）
        return { ...r, m, x: p.x, y: p.y, style, state: roleBusy(r.role) ? 'busy' : 'online' };
      });
    });
    function openRole(r) { toast(roleName(r.role, r.name) + ' · 未读 ' + (r.unread || 0) + (r.baseUrl ? ' · ' + r.baseUrl : ''), 'info'); }
    return { placed, openRole };
  },
  template: `
    <svg class="orbit-edges" id="orbit-edges" viewBox="0 0 420 420" aria-hidden="true">
      <line v-for="(n, i) in placed" :key="'e'+i" class="orbit-edge"
            x1="210" y1="210" :x2="210 + n.x" :y2="210 + n.y" :data-state="n.state"/>
    </svg>
    <button v-for="(n, i) in placed" :key="n.role" type="button"
            :class="['orbit-node', n.m.cls]" :data-role="n.role" :data-state="n.state"
            :style="n.style"
            :title="n.m.name + (n.baseUrl ? ' · ' + n.baseUrl : '') + ' · 未读 ' + (n.unread||0)"
            @click="openRole(n)">
      <span class="role-icon orbit-node__ico" :style="{ '--icon': 'url(' + n.m.icon + ')' }"></span>
      <span v-if="n.unread" class="orbit-node__pid">{{ n.unread }} 未读</span>
      <span class="orbit-node__label" :title="n.m.name">{{ n.m.short || n.m.name }}</span>
    </button>
  `,
});

// —— 世代年轮 GenRings（挂载 #gen-rings；host 已是 .gen-rings）——
export const GenRings = defineComponent({
  name: 'GenRings',
  setup() {
    const lanes = computed(() => (store.nexus.rings || []).slice(0, 10));
    return { lanes };
  },
  template: `
    <div class="gen-lane" v-for="l in lanes" :key="l.id" :data-session-id="l.id">
      <span class="gen-lane__name">{{ l.title }}</span>
      <div class="gen-track">
        <div class="gen-seg" v-for="(seg, i) in l.segs" :key="i"
             :data-depth="seg.depth" :data-current="seg.current ? '1' : null"
             :title="'第 ' + seg.gen + ' 代 · 归档 ' + seg.count + ' 条'">
          <span class="gen-seg__mark"></span>
        </div>
      </div>
      <span class="gen-lane__count">{{ l.total }} 条</span>
    </div>
    <div v-if="!lanes.length" class="dim" style="padding:8px;">暂无会话世代</div>
  `,
});

// —— 平铺卡片墙 NexusCards（挂载 #nexus-cards；host 已是 .nexus-cards）——
export const NexusCards = defineComponent({
  name: 'NexusCards',
  setup() {
    const s = computed(() => store.stats || {});
    const names = computed(() => (store.mailbox.roles || []).map((r) => roleName(r.role, r.name)).join(' '));
    const online = computed(() => (store.mailbox.roles || []).filter((r) => !roleBusy(r.role)).length);
    const busy = computed(() => (store.mailbox.roles || []).filter((r) => roleBusy(r.role)).length);
    return { s, names, online, busy, today: computed(() => store.events.length), unread: computed(() => store.mailbox.totalUnread || 0), sessions: computed(() => (store.sessions || []).length) };
  },
  template: `
    <div class="card"><div class="card__title">池心</div><div class="card__sub">命中 {{ s.cacheHitRate!=null?(s.cacheHitRate*100).toFixed(0):'—' }}% · 成本 ¥{{ s.costRmb!=null?s.costRmb.toFixed(3):'0.000' }}</div></div>
    <div class="card"><div class="card__title">环流</div><div class="card__sub">{{ names || '—' }}（{{ online }} 空闲 · {{ busy }} 工作中）</div></div>
    <div class="card"><div class="card__title">涟漪</div><div class="card__sub">本次事件 {{ today }} · 未读 {{ unread }}</div></div>
    <div class="card"><div class="card__title">年轮</div><div class="card__sub">活跃会话 {{ sessions }}</div></div>
  `,
});
