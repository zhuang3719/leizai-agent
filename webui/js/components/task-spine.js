// A1 前端 · 通讯任务脊 TaskSpine（P2b-3 · 雷影·美工）
// 依据：按既定设计（通讯流程可视化规格 L2）
//   聊天窗线程侧竖轴：每 task 一节点（六态）→ 展开任务卡（from→to·type·标识短码·耗时·字数·lastError）
//   汇总条「在办 task N · 已回 M · 逾期 X」；点"↗"→ 通讯中心定位（下钻）。
// 数据源：GET /api/mailbox/flow（纯读无副作用）· 轮询 4s 兜底 + SSE（mailbox-message/consumed/replied）即时刷。
// 可访问性：六态除颜色外**带形状/图标冗余(○◉✓△✗⊘)**，色盲可辨；prefers-reduced-motion 降级。
// 红线（P-5）：每个可视化元素都对应可核对的字段/计数（见 tsp__detail 逐项标注）。
import { defineComponent, ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { api } from '../api.js';
import { store } from '../store.js';
import { roleMeta, roleName, guessSessionRole, hhmm } from '../roles.js';
import { onServerEvent } from '../sse.js';

// 六态：色 + 形状双编码（形状作为色盲冗余，M21 断言 [data-state][data-shape]）
const STATE = {
  sent:      { cn: '已发送', glyph: '○', shape: 'circle',   color: '#6B7280' },
  delivered: { cn: '已投递', glyph: '◎', shape: 'ring',     color: '#9CA3AF' },
  working:   { cn: '处理中', glyph: '◉', shape: 'pulse',    color: '#22D3EE' },
  replied:   { cn: '已回执', glyph: '✓', shape: 'check',    color: '#22C55E' },
  overdue:   { cn: '已逾期', glyph: '△', shape: 'triangle', color: '#F59E0B' },
  failed:    { cn: '失败',   glyph: '✗', shape: 'cross',    color: '#EF4444' },
  cancelled: { cn: '已取消', glyph: '⊘', shape: 'slash',    color: '#6B7280' },
};
const TYPE_CN = { task: '派活', reply: '回执', result: '应答', notice: '通知', notify: '通知', ack: '确认' };

function stateOf(e) {
  const s = e && e.status;
  if (s === 'failed') return 'failed';
  if (s === 'stale') return 'overdue';
  if (s === 'cancelled') return 'cancelled';
  if (s === 'processing') return 'working';
  if (s === 'done') return 'replied';
  return e && e.delivered ? 'delivered' : 'sent';
}

export const TaskSpine = defineComponent({
  name: 'TaskSpine',
  setup() {
    const entries = ref([]);
    const available = ref(true);
    const openId = ref(null);
    let _timer = null, _debounce = null;

    const session = computed(() => (store.sessions || []).find((s) => s.id === store.currentId) || null);
    const role = computed(() => (session.value ? guessSessionRole(session.value) : 'main'));

    async function load() {
      if (!store.currentId) { entries.value = []; available.value = true; return; }
      try {
        const r = await api.mailboxFlow({ limit: 100 });   // v6.45：300→100（降载；页面仅展示前 120 条相关项）
        if (!r || r.available === false) { available.value = false; entries.value = []; return; }
        available.value = true;
        const ro = role.value;
        // 本会话相关 = 收发双方任一方为该会话角色（现有数据投影，P1 无 session 维度字段）
        const rel = (r.entries || []).filter((e) => e && (e.from_id === ro || e.to_id === ro));
        entries.value = rel.slice(0, 120);
      } catch { available.value = false; }
    }
    function refresh() { try { load(); } catch { } }
    function debounced() { if (_debounce) clearTimeout(_debounce); _debounce = setTimeout(refresh, 700); }

    // task 节点 + 启发式配对回执（reply/result：from=task.to_id → to=task.from_id 且 ts 更晚，唯一配对）
    const tasks = computed(() => {
      const all = entries.value || [];
      const ts = all.filter((e) => e.type === 'task').slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const rps = all.filter((e) => e.type === 'reply' || e.type === 'result').slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const used = new Set();
      const out = ts.map((t) => {
        let reply = null;
        for (const rp of rps) {
          if (used.has(rp.id)) continue;
          if (rp.from_id === t.to_id && rp.to_id === t.from_id && (rp.ts || 0) >= (t.ts || 0)) { reply = rp; used.add(rp.id); break; }
        }
        const base = stateOf(t);
        const state = (!['failed', 'overdue', 'cancelled'].includes(base) && reply) ? 'replied' : base;
        return {
          id: t.id, from: t.from_id, to: t.to_id, ts: t.ts,
          state, status: t.status, delivered: t.delivered, wake: t.wake_intent,
          preview: t.preview || '', topic: t.topic || '',
          dur: reply ? Math.max(0, Math.round((reply.ts - t.ts) / 1000)) : null,
          lastError: base === 'failed' ? '投递/处理失败' : (base === 'overdue' ? '超期未回' : ''),
        };
      });
      return out.slice().reverse();   // 新节点在上
    });

    const counts = computed(() => {
      const r = { inFlight: 0, replied: 0, overdue: 0, failed: 0 };
      for (const t of tasks.value) {
        if (t.state === 'replied') r.replied += 1;
        else if (t.state === 'overdue') r.overdue += 1;
        else if (t.state === 'failed') r.failed += 1;
        else if (t.state !== 'cancelled') r.inFlight += 1;
      }
      return r;
    });

    const nm = (r) => roleName(r);
    const shapeOf = (st) => (STATE[st] || STATE.sent).shape;
    const cnOf = (st) => (STATE[st] || STATE.sent).cn;
    const glyphOf = (st) => (STATE[st] || STATE.sent).glyph;
    const typeCn = (t) => TYPE_CN[t] || t || '消息';

    // 任务卡数字依据（P-5）：标识短码 / 耗时(s) / 字数（预览，≥120 表示被截断）/ 投递 / lastError
    function shortId(id) { const s = String(id || ''); const i = s.lastIndexOf('-'); return (i >= 0 ? s.slice(i + 1) : s).slice(0, 8); }
    function chars(t) { const n = (t.preview || '').length; return n >= 120 ? '≥120' : String(n); }

    function locate(id) {
      try { window.dispatchEvent(new CustomEvent('leizai-open-berth', { detail: 'dock' })); } catch { }
      setTimeout(() => { try { window.__leizaiLocateMail && window.__leizaiLocateMail(id); } catch { } }, 60);
    }

    // 收起侧栏：交给 app.js（唯一控制方，切换 .workspace.is-spine-open / .col-spine.is-open）
    function close() { try { window.dispatchEvent(new CustomEvent('leizai-spine-close')); } catch { } }

    // 点面板外部 → 收起（与 rail 切换按钮互斥：点按钮不触发外面收起，避免"关了又开"）
    function onDocClick(ev) {
      const t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest('#rail-spine-toggle')) return;
      if (t.closest('#col-spine')) return;
      const ws = document.querySelector('.workspace');
      const c = document.getElementById('col-spine');
      const isOpen = (ws && ws.classList.contains('is-spine-open')) || (c && c.classList.contains('is-open'));
      if (isOpen) close();
    }

    watch(() => store.currentId, () => { openId.value = null; refresh(); });
    onMounted(() => {
      refresh();
      _timer = setInterval(() => { try { if (typeof document !== 'undefined' && document.hidden) return; refresh(); } catch { } }, 10000);   // v6.45：4s→10s（实时由 SSE mailbox-* 事件驱动，轮询仅兜底）
      onServerEvent('mailbox-message', debounced);
      onServerEvent('mailbox-consumed', debounced);
      onServerEvent('mailbox-replied', debounced);
      document.addEventListener('click', onDocClick);
    });
    onUnmounted(() => {
      if (_timer) clearInterval(_timer); if (_debounce) clearTimeout(_debounce);
      document.removeEventListener('click', onDocClick);
    });

    return { entries, available, openId, tasks, counts, nm, typeCn, shortId, chars, locate, close,
             shapeOf, cnOf, glyphOf, hhmm, STATE, reduced: computed(() => !!store.reducedMotion) };
  },
  template: `
    <div class="tsp" :data-reduced-motion="reduced ? '1' : '0'">
      <section class="tsp__panel" role="region" aria-label="通讯任务脊">
        <div class="tsp__head">
          <span class="tsp__title">通讯任务脊</span>
          <span class="tsp__sum" title="本会话 task 聚合（task-only，不含 reply/notice）">
            在办 task {{ counts.inFlight }} · 已回 {{ counts.replied }} · 逾期 {{ counts.overdue }}
          </span>
          <button type="button" class="tsp__x" @click="close" aria-label="收起任务脊">×</button>
        </div>

        <div v-if="!available" class="tsp__empty">暂无数据（信箱未就绪）</div>
        <div v-else-if="!tasks.length" class="tsp__empty">暂无通讯任务</div>
        <ul v-else class="tsp__axis">
          <li v-for="t in tasks" :key="t.id" class="tsp__item" :class="'is-' + t.state">
            <div class="tsp__row">
              <span class="tsp__node" :class="'st-' + t.state" :data-state="t.state" :data-shape="shapeOf(t.state)"
                    :title="cnOf(t.state)"><span class="tsp__shape" aria-hidden="true">{{ glyphOf(t.state) }}</span></span>
              <button type="button" class="tsp__card" @click="openId = (openId === t.id ? null : t.id)"
                      :aria-expanded="openId === t.id ? 'true' : 'false'">
                <span class="tsp__c1"><b>{{ nm(t.from) }}</b><span class="tsp__arrow" aria-hidden="true">→</span>{{ nm(t.to) }}</span>
                <span class="tsp__c2"><em class="tsp__st">{{ cnOf(t.state) }}</em> · {{ hhmm(t.ts) }}</span>
              </button>
              <button type="button" class="tsp__jump" @click="locate(t.id)" title="在通讯中心定位" aria-label="在通讯中心定位">↗</button>
            </div>

            <dl v-if="openId === t.id" class="tsp__detail">
              <div><dt>流向</dt><dd>{{ t.from }} → {{ t.to }}</dd></div>
              <div><dt>类型</dt><dd>{{ typeCn('task') }}</dd></div>
              <div><dt>标识</dt><dd class="mono" :title="t.id">{{ shortId(t.id) }}</dd></div>
              <div><dt>耗时</dt><dd>{{ t.dur == null ? '—' : (t.dur + 's') }}</dd></div>
              <div><dt>字数</dt><dd>{{ chars(t) }}</dd></div>
              <div><dt>投递</dt><dd>{{ t.delivered ? '已投递' : '未投递' }}</dd></div>
              <div v-if="t.lastError"><dt>异常</dt><dd class="tsp__err">{{ t.lastError }}</dd></div>
              <div class="tsp__prev"><dt>摘要</dt><dd>{{ t.preview || t.topic || '（无）' }}</dd></div>
            </dl>
          </li>
        </ul>
      </section>
    </div>
  `,
});
