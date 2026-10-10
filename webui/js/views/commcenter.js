// A1 前端 · 通讯中心（通讯 v6 阶段3）——挂载 #comm-center
// 概览卡（未读/在途/逾期/死信）+ 全部往来流水 + 逾期&死信区（带重投）。
// 数据契约：store.mailbox.roles / GET /api/mailbox?role= ；新增 GET /api/mailbox/queue?status= ；POST /api/mailbox/retry。
// 端点缺失时必须优雅降级显示"暂无数据"，绝不崩坏。
import { defineComponent, ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { api } from '../api.js';
import { store, toast, roleBusy } from '../store.js';
import { roleMeta, roleName, relTime, roleVar } from '../roles.js';

const TYPE_LABEL = { task: '派活', reply: '回执', result: '应答', notify: '通知', ack: '确认' };

export const CommCenter = defineComponent({
  name: 'CommCenter',
  setup() {
    const loading = ref(false);
    const stream = ref([]);            // 全部往来流水（合并各角色待回列表 + 全量 flow，去重 + 时间倒序）
    const streamAvailable = ref(true); // 信箱端点是否可用
    const hitId = ref('');             // P2b-3：任务脊下钻高亮的目标 message id
    const dead = ref([]);              // 逾期(stale) + 死信(failed)
    const queueAvailable = ref(true);  // 队列端点是否可用
    const queueLoading = ref(false);
    const retrying = ref({});          // id -> bool
    const undelivered = ref(null);     // 未送达(delivered0) 条数；null=未知
    const undeliveredAvail = ref(true);// 未送达端点是否可用

    const roles = computed(() => (store.mailbox && store.mailbox.roles) || []);
    const unread = computed(() => (store.mailbox && store.mailbox.totalUnread) ||
      roles.value.reduce((s, r) => s + (r.unread || 0), 0));
    const busy = computed(() => roles.value.filter((r) => roleBusy(r.role)).length);
    const stale = computed(() => dead.value.filter((d) => d.status === 'stale').length);
    const failed = computed(() => dead.value.filter((d) => d.status === 'failed').length);

    const dir = (e) => ((e && e.from_id === 'main') ? 'out' : 'in');
    const typeLabel = (t) => TYPE_LABEL[t] || (t || '消息');

    async function loadStream() {
      const rs = roles.value;
      if (store.mailbox && store.mailbox.available === false) { stream.value = []; streamAvailable.value = false; return; }
      const acc = [];
      let anyOk = false;
      await Promise.all(rs.map(async (r) => {
        try {
          const m = await api.mailbox(r.role, undefined, 60);
          if (m && m.available === false) return;
          anyOk = true;
          for (const e of (m.entries || [])) acc.push(e);
        } catch { /* 单角色失败忽略，不阻断整体 */ }
      }));
      // P2b-3（美工）：并入全量流水 flow（含已闭环）——使"全部往来流水"名副其实，并支持任务脊下钻定位。
      try {
        const f = await api.mailboxFlow({ limit: 200 });
        if (f && f.available !== false) {
          anyOk = true;
          for (const e of (f.entries || [])) acc.push(Object.assign({}, e, { content: e.preview || '' }));
        }
      } catch { /* flow 端点未就绪 → 仅用信箱列表，优雅降级 */ }
      const seen = new Set();
      stream.value = acc
        .filter((e) => { const k = e.id || ((e.ts || 0) + '|' + (e.topic || '')); if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, 200);
      streamAvailable.value = anyOk || !rs.length;
    }

    async function loadQueue() {
      queueLoading.value = true;
      const acc = [];
      let ok = false;
      for (const st of ['stale', 'failed']) {
        try {
          const q = await api.mailboxQueue(st, 100);
          ok = true;
          const items = (q && (q.items || q.entries)) || [];
          for (const it of items) acc.push(Object.assign({}, it, { status: it.status || st }));
        } catch { /* 端点未就绪 → 保持 ok=false */ }
      }
      const seen = new Set();
      dead.value = acc
        .filter((it) => { const k = it.id || ((it.ts || 0) + '|' + (it.preview || '')); if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
      queueAvailable.value = ok;
      queueLoading.value = false;
    }

    // 未送达(delivered0)：端点不可用/available:false 时置 — 并标记不可用，绝不崩坏
    async function loadUndelivered() {
      try {
        const q = await api.mailboxQueue('delivered0', 100);
        if (q && q.available === false) { undeliveredAvail.value = false; undelivered.value = null; return; }
        undeliveredAvail.value = true;
        undelivered.value = (typeof q.count === 'number')
          ? q.count
          : ((q.items || q.entries || []).length || 0);
      } catch { undeliveredAvail.value = false; undelivered.value = null; }
    }

    async function refresh() {
      loading.value = true;
      await Promise.all([loadStream(), loadQueue(), loadUndelivered()]);
      loading.value = false;
    }

    async function retry(item) {
      if (!item || !item.id) return;
      retrying.value[item.id] = true;
      try {
        await api.mailboxRetry(item.id);
        toast('已重投 ' + item.id, 'ok');
        await Promise.all([loadQueue(), loadStream()]);
      } catch (e) {
        toast('重投失败: ' + (e && e.message ? e.message : e), 'err');
      } finally { retrying.value[item.id] = false; }
    }

    // 角色列表异步到达后补拉一次（boot 时 CommCenter 可能先于 mailboxSummary 挂载）
    watch(() => roles.value.length, (n) => { if (n && !stream.value.length) loadStream(); });
    onMounted(refresh);
    window.__leizaiReloadComm = refresh;

    // P2b-3（美工）：任务脊 → 通讯中心定位（下钻锚点 = message id，M23）。行不存在时先刷新再定位。
    function locate(id) {
      if (!id) return;
      hitId.value = id;
      const esc = (window.CSS && CSS.escape) ? CSS.escape(String(id)) : String(id).replace(/["\\]/g, '\\$&');
      const scrollTo = () => {
        try {
          const row = document.querySelector('li.comm-row[data-mid="' + esc + '"]');
          if (row && row.scrollIntoView) { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); return true; }
        } catch { }
        return false;
      };
      nextTick(() => { if (!scrollTo()) { try { refresh().then(() => nextTick(scrollTo)); } catch { } } });
      setTimeout(() => { if (hitId.value === id) hitId.value = ''; }, 4000);
    }
    window.__leizaiLocateMail = locate;
    onUnmounted(() => { try { if (window.__leizaiLocateMail === locate) window.__leizaiLocateMail = null; } catch { } });

    return { loading, stream, streamAvailable, dead, queueAvailable, queueLoading, retrying,
             undelivered, undeliveredAvail, hitId,
             unread, busy, stale, failed, roles, dir, typeLabel, refresh, retry, relTime, roleMeta, roleName, roleVar };
  },
  template: `
    <div class="comm">
      <div class="comm__head">
        <h3 class="card__sub">通讯中心 <span v-if="undeliveredAvail && undelivered > 0" class="comm-head-badge" title="有未送达派单">{{ undelivered }}</span></h3>
        <button class="btn btn--ghost btn--sm" @click="refresh" :disabled="loading" title="刷新">
          <span class="icon icon--sm" style="--i:url(/assets/ui-refresh.svg)"></span>
          <span style="margin-left:4px;">{{ loading ? '刷新中…' : '刷新' }}</span>
        </button>
      </div>

      <!-- 概览卡 -->
      <div class="comm-overview">
        <div class="comm-stat comm-stat--unread">
          <div class="comm-stat__num">{{ unread }}</div>
          <div class="comm-stat__label">总未读</div>
        </div>
        <div class="comm-stat comm-stat--busy">
          <div class="comm-stat__num">{{ busy }}</div>
          <div class="comm-stat__label">在途</div>
        </div>
        <div class="comm-stat comm-stat--stale">
          <div class="comm-stat__num">{{ queueAvailable ? stale : '—' }}</div>
          <div class="comm-stat__label">逾期</div>
        </div>
        <div class="comm-stat comm-stat--undelivered">
          <div class="comm-stat__num">{{ undeliveredAvail ? undelivered : '—' }}</div>
          <div class="comm-stat__label">未送达</div>
        </div>
        <div class="comm-stat comm-stat--failed">
          <div class="comm-stat__num">{{ queueAvailable ? failed : '—' }}</div>
          <div class="comm-stat__label">死信</div>
        </div>
      </div>

      <!-- 逾期 / 死信 -->
      <div class="comm-block">
        <div class="comm-block__title">逾期 / 死信 <span class="dim2" style="font-weight:400;">（{{ queueAvailable ? dead.length : '不可用' }}）</span></div>
        <div v-if="!queueAvailable" class="empty comm-empty"><div class="empty__text">暂无数据（队列端点未就绪）</div></div>
        <div v-else-if="queueLoading && !dead.length" class="skeleton" style="height:44px;"></div>
        <div v-else-if="!dead.length" class="empty comm-empty"><div class="empty__text">无逾期 / 死信 ✓</div></div>
        <ul v-else class="comm-dead">
          <li v-for="it in dead" :key="it.id || (it.ts + (it.preview || ''))" class="comm-dead__item" :class="'is-' + (it.status || 'stale')">
            <span class="comm-dead__st">{{ it.status === 'failed' ? '死信' : '逾期' }}</span>
            <span class="comm-dead__body">
              <span class="comm-dead__meta">
                <b>{{ roleName(it.from) }}</b>
                <span class="dim2">→</span>
                <b>{{ roleName(it.to) }}</b>
                <span v-if="it.type" class="comm-badge" :class="'comm-badge--' + it.type">{{ it.type }}</span>
                <span v-if="it.attempts" class="dim2">· 尝试 {{ it.attempts }}</span>
                <span class="comm-time">{{ relTime(it.ts) }}</span>
              </span>
              <span class="comm-dead__prev ellipsis">{{ it.preview || it.topic || it.content || '' }}</span>
            </span>
            <button class="btn btn--sm btn--primary comm-retry" :disabled="retrying[it.id]" @click="retry(it)">
              {{ retrying[it.id] ? '重投中…' : '重投' }}
            </button>
          </li>
        </ul>
      </div>

      <!-- 全部往来流水 -->
      <div class="comm-block">
        <div class="comm-block__title">全部往来流水 <span class="dim2" style="font-weight:400;">（{{ stream.length }}）</span></div>
        <div v-if="loading && !stream.length" class="skeleton" style="height:110px;"></div>
        <div v-else-if="!streamAvailable" class="empty comm-empty"><div class="empty__text">暂无数据（信箱未就绪）</div></div>
        <div v-else-if="!stream.length" class="empty comm-empty"><div class="empty__text">暂无往来消息</div></div>
        <ul v-else class="comm-stream">
          <li v-for="e in stream" :key="e.id || (e.ts + (e.topic || ''))" class="comm-row" :data-mid="e.id"
              :class="[dir(e) === 'out' ? 'is-out' : 'is-in', roleMeta(e.from_id).cls, { 'is-hit': hitId && hitId === e.id }]">
            <span class="comm-row__dir" :class="dir(e) === 'out' ? 'is-out' : 'is-in'">{{ dir(e) === 'out' ? '→' : '←' }}</span>
            <span class="avatar comm-row__avatar" :class="roleMeta(e.from_id).cls" :style="roleVar(e.from_id)"><span class="role-icon" :style="{ '--icon': 'url(' + roleMeta(e.from_id).icon + ')' }"></span></span>
            <span class="comm-row__main">
              <span class="comm-row__meta">
                <b class="comm-row__who">{{ roleName(e.from_id) }}</b>
                <span class="dim2">→ {{ roleName(e.to_id) }}</span>
                <span class="comm-badge" :class="'comm-badge--' + (e.type || 'notify')">{{ typeLabel(e.type) }}</span>
                <span v-if="e.priority === 'urgent'" class="comm-badge comm-badge--urgent">紧急</span>
              </span>
              <span class="comm-row__text ellipsis">{{ e.topic || e.content || '' }}</span>
            </span>
            <span class="comm-time">{{ relTime(e.ts) }}</span>
          </li>
        </ul>
      </div>
    </div>
  `,
});
