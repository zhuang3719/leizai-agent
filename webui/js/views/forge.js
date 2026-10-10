// A1 前端 · 任务坊（挂载 #goals-list / #schedules-list / #subagents-list）——多根渲染（host 已是 .card-list）
import { defineComponent, ref, onMounted } from 'vue';
import { api } from '../api.js';
import { toast } from '../store.js';
import { relTime } from '../roles.js';

// 自治目标（#goals-list）——后端 /api/goals 已删除（2026-09-12 移除自治目标功能），改静态提示，不再请求
export const GoalsList = defineComponent({
  name: 'GoalsList',
  setup() {
    return {};
  },
  template: `
    <div class="empty"><div class="empty__text">自治目标功能已移除</div></div>
  `,
});

// 心跳/定时（#schedules-list）
export const SchedulesList = defineComponent({
  name: 'SchedulesList',
  setup() {
    const list = ref([]);
    async function load() { try { list.value = await api.schedules() || []; } catch { } }
    onMounted(load);
    function kind(s) { return s.intervalSec ? ('每 ' + s.intervalSec + 's') : (s.at || '定时'); }
    async function stop(s) { try { await api.post('/api/schedules/' + s.id + '/stop'); toast('已停止', 'ok'); load(); } catch (e) { toast('停止失败: ' + e.message, 'err'); } }
    return { list, kind, stop };
  },
  template: `
    <div class="card" v-for="s in list" :key="s.id">
      <div class="card__head">
        <span class="icon icon--sm" style="--i:url(/assets/ui-play.svg)"></span>
        <span class="card__title mono">{{ kind(s) }}</span>
        <button class="btn btn--ghost btn--sm" style="margin-left:auto;" @click="stop(s)">停止</button>
      </div>
      <div class="card__sub">{{ (s.message || '').slice(0, 80) }}</div>
    </div>
    <div v-if="!list.length" class="empty"><div class="empty__text">暂无心跳/定时</div></div>
  `,
});

// 子智能体历史（#subagents-list）
export const SubagentsList = defineComponent({
  name: 'SubagentsList',
  setup() {
    const list = ref([]);
    onMounted(async () => { try { list.value = await api.agents() || []; } catch { } });
    return { list, relTime };
  },
  template: `
    <div class="card" v-for="a in list.slice(0,50)" :key="a.id">
      <div class="card__head">
        <span class="dot dot-online"></span>
        <span class="card__title">{{ a.role || '子智能体' }}</span>
        <span class="card__sub" style="margin-left:auto;">{{ relTime(a.ts) }}</span>
      </div>
      <div class="card__sub">{{ (a.task || '').slice(0, 90) }}</div>
    </div>
    <div v-if="!list.length" class="empty"><div class="empty__text">暂无子智能体记录</div></div>
  `,
});
