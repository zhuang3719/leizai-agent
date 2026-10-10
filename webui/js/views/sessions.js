// A1 前端 · 会话列表（挂载 #session-list）——多根渲染（不重复 host 的 .session-list）
import { defineComponent, computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api.js';
import { store, toast, clearResultUnread } from '../store.js';
import { guessSessionRole, roleMeta, roleName, relTime, roleVar } from '../roles.js';
import { roleStatus } from '../agent-status.js';
import { onServerEvent } from '../sse.js';

export const SessionList = defineComponent({
  name: 'SessionList',
  setup() {
    const loading = ref(true);
    // v6.1.5：运行指示纳入"后台回合"（心跳/雷影唤醒）与"交接中"（引擎列表不返回真实 running，由 SSE 推导）
    function running(s) { return !!store.running[s.id] || !!store.bgRunning[s.id] || !!store.handoffBusy[s.id]; }
    // P2b-3（美工）L1：状态精确化——用本回合入站批次（store.bgBatch）显「处理 N 条回执（role…）」，
    //   角色按字典序（英文 role），批次缺失则回退原三态文字（向后兼容，不臆造）。
    const TYPE_CN = { reply: '回执', task: '派单', result: '应答', notify: '通知', ack: '确认' };
    function batchText(id, k) {
      const b = store.bgBatch && store.bgBatch[id];
      if (!b || !b.byType) return '';
      const t = (k === 'reply' || k === 'task') ? k : (b.byType.reply ? 'reply' : (b.byType.task ? 'task' : ''));
      const g = t && b.byType[t];
      if (!g || !g.n) return '';
      const roles = Object.keys(g.roles || {}).sort();   // 字典序：designer<programmer<researcher<tester<writer
      return '处理 ' + g.n + ' 条' + (TYPE_CN[t] || '消息') + (roles.length ? ('（' + roles.join('/') + '）') : '');
    }
    function runningTitle(s) {
      if (store.running[s.id]) return '运行中';
      const hb = store.handoffBusy[s.id];
      if (hb) return hb.gen ? ('第 ' + hb.gen + ' 代交接中') : '交接中';
      const k = store.bgRunning[s.id] && store.bgRunning[s.id].kind;
      const prec = batchText(s.id, k);                    // P2b-3：优先精确化文案
      if (prec) return prec;
      return k === 'reply' ? '处理回执中' : k === 'task' ? '处理派单中' : '后台任务中';
    }
    async function load() {
      try { const list = await api.sessions(); store.sessions = Array.isArray(list) ? list : []; }
      catch (e) { toast('会话加载失败: ' + e.message, 'err'); }
      finally { loading.value = false; }
    }
    onMounted(load);
    window.__leizaiReloadSessions = load;

    const list = computed(() => {
      const kw = (store.sessionQuery || '').trim();
      let l = (store.sessions || []).filter((s) => !s.trashedAt);
      if (kw) l = l.filter((s) => ((s.title || '') + s.id).toLowerCase().includes(kw.toLowerCase()));
      // v6.54b：按「最近工作」排序（最近活跃在前）——正在跑/后台/交接中的排最前，其余按最近活动时间降序。
      l = l.slice().sort((a, b) => (activityAt(b) - activityAt(a)) || String(b.id).localeCompare(String(a.id)));
      return l.slice(0, 300);
    });
    // 最近活动时间：运行中视为最大（排最前）；否则取 updatedAt（缺失回退 createdAt）。
    function activityAt(s) {
      if (!s) return 0;
      if (store.running[s.id] || store.bgRunning[s.id] || store.handoffBusy[s.id]) return Number.MAX_SAFE_INTEGER;
      const t = s.updatedAt || s.createdAt;
      return (typeof t === 'number' ? t : Date.parse(t)) || 0;
    }
    function pick(s) {
      clearResultUnread(s.id);                            // P2b-3：进入会话 → 清"新结果未看"小点
      store.view = 'core';
      // F1：切换会话即派发拉取事件（由 app.js 的 openSession 统一加载消息），不再只设 currentId
      window.dispatchEvent(new CustomEvent('leizai-open-session', { detail: { id: s.id } }));
      window.dispatchEvent(new CustomEvent('leizai-open-berth', { detail: 'core' }));
    }
    function meta(s) { return roleMeta(guessSessionRole(s)); }
    // v6.40（主人要求）：有雷影(agents 含非 main 角色) → 显示「雷仔⚡ + 雷影」组合；纯主我 → null 回退单头像⚡雷仔
    // v6.41（主人反馈回归修复）：恢复「品字形」堆叠 —— 按**实际渲染枚数 N**（含「+N」那枚）选 avatars--tri--n{N}
    //   N=2 并列微交叠 / N=3 品字(上1下2) / N=4 交错(上2下2) / N=5(4头像+N) 上2下3；均 19px、容器高 30px 不撑行、不溢出左边界
    // v6.42（主人增强）：忙碌的雷影优先排进「可见的 3 枚」里——main 固定首位，余 2 位优先给 busy 雷影，
    //   再用非忙碌按 agents 原序补齐；busy 各自保持 agents 原序（稳定排序，不无端跳动）。extra 仍=总雷影数−展示雷影数。
    function group(s) {
      const all = (s && Array.isArray(s.agents)) ? s.agents.filter((r) => r) : [];
      const nonMain = all.filter((r) => r !== 'main');
      if (!nonMain.length) return null;                        // 纯主我 → 单头像回退
      const map = (s && s.id) ? busyRoles.value[s.id] : null;  // 读取 ref → 忙碌/最近工作变化触发重排（依赖链：渲染期读取）
      // v6.55（主人要求）：主我头像与雷影【同一规则】按「最近工作」降序排序，不再固定首位。
      //   时间源：雷影取本会话 links.lastTs（最近一次往来）；主我取本会话 updatedAt（缺失回退 createdAt）。
      //   links 尚未到达（map=null）时雷影 ts=0 → 主我默认排前（优雅回退，不臆造）。
      const tsOf = (r) => {
        if (r === 'main') { const t = s.updatedAt || s.createdAt; return (typeof t === 'number' ? t : Date.parse(t)) || 0; }
        const lk = map && map[r];
        return (lk && lk.lastTs) || 0;
      };
      const ordered = all.slice().sort((a, b) => tsOf(b) - tsOf(a));   // 稳定排序：时间相同保持 agents 原序
      const shown = ordered.slice(0, 3);                       // 展示最多 3 枚（含主我，主我照样参与排序）
      const extra = all.length - shown.length;                 // 其余参与者并入「+N」
      const n = Math.min(shown.length + (extra ? 1 : 0), 5);   // 含「+N」枚的实际渲染数（品字 N）
      return {
        // v6.54：每枚参与者头像带四态；busy 一律「会话级」判定（只有正在跑的本会话才动）
        // v6.56：恢复【品字叠放】（.avatars--tri），间距已放松。
        shown: shown.map((r) => ({ role: r, ...roleMeta(r), name: roleName(r), state: avState(s, r) })),
        extra,
        n,
        cls: 'avatars avatars--tri avatars--tri--n' + n,
      };
    }
    function badge(s) { return s.unread || 0; }
    // —— v6.41（主人增强）：雷影「单独」工作态 ——
    //   数据源 GET /api/sessions/:id/links（api.sessionLinks → { links:[{role,name,busy,...}] }）。
    //   策略：仅对「本行含雷影」的会话拉；单会话节流 12s、单轮最多 8 条，随 15s 节拍刷新，杜绝狂拉。
    //   链接不可得/对端离线 → 静默保持现状（不清空、不报错、不闪烁）。
    const busyRoles = ref({});          // sessionId -> { role: { busy, lastTs } }（busy=会话级忙碌；lastTs=最近工作时刻，供头像排序）
    const _linkAt = {};                 // sessionId -> 上次拉取时间戳（节流）
    let _linksTimer = null;
    async function pollLinks(force, onlyIds) {
      try {
        if (typeof document !== 'undefined' && document.hidden) return;   // 页面隐藏跳过，省资源
        const now = Date.now();
        const idset = (onlyIds && onlyIds.length) ? new Set(onlyIds) : null;
        const todo = list.value
          .filter((s) => group(s) && (idset ? idset.has(s.id) : (force || (now - (_linkAt[s.id] || 0)) > 12000)))
          .slice(0, idset ? 8 : (force ? 3 : 8));   // 事件驱动：带明确 sessionId 时只刷该会话（≤8）；否则刷最前 3 条
        // v6.54b：并发拉取、**各自到达即更新**（不 Promise.all 等最慢的一条，避免慢会话拖住整批刷新）
        todo.forEach(async (s) => {
          _linkAt[s.id] = now;                 // 先记时间戳，防并发重复拉
          let map = null;
          try {
            const r = await api.sessionLinks(s.id);
            const links = (r && Array.isArray(r.links)) ? r.links : [];
            map = {};
            for (const lk of links) { if (lk && lk.role) map[lk.role] = { busy: !!lk.busy, lastTs: Number(lk.lastTs) || 0 }; }   // F1：改用权威 lk.busy(=computeBusy)，弃 busyRaw(=outboundPending>0 僵尸判据)
          } catch { map = null; }              // 不可得 → 保持现状
          if (map) busyRoles.value = { ...busyRoles.value, [s.id]: map };
        });
      } catch { /* noop：轮询失败绝不影响列表渲染 */ }
    }
    function busyOf(sid, role) { const m = busyRoles.value[sid]; return !!(m && m[role] && m[role].busy); }
    // v6.54：四态 → 悬停文案后缀
    function stateText(st) { return st === 'busy' ? ' · 工作中' : st === 'offline' ? ' · 离线' : st === 'restarting' ? ' · 重启中' : ''; }
    // v6.54 fix：会话条目头像四态——busy 必须「会话级」（主我看该会话是否在跑；雷影看本会话 links），
    //   绝不用全局 main busy / 全局 role busy 驱动所有会话（否则一处聊天、全部头像一起转）。
    //   restarting/offline 为实例级（与具体会话无关），保留全局判定。
    function avState(s, role) {
      const busy = (role === 'main') ? running(s) : busyOf(s.id, role);
      if (busy) return 'busy';
      const g = roleStatus(role);
      return g === 'busy' ? 'idle' : g;
    }
        // v6.54b：与主区同源同实时——SSE 状态信号到达即强制刷新 links，消除"仅 15s 轮询"导致的状态滞后。
    //   （主区 chip 早已由 window.__leizaiReloadSessionAgents / agent-busy 事件驱动刷新；此处补齐列表侧。）
    // refs=front-busy-sync（2026-10-10）：**收窄键修正**——弃用 ev.sessionId（=雷影侧 peer session id，与列表 s.id 不同源
    //   → 旧逻辑 idset.has(s.id) 永空转，只能靠 15s 轮询）。改按事件 role 命中「含该 role 的可见会话」；
    //   main 与雷影同一口径（不再有 main 特例）；role 缺失 → 刷可见集合兜底。
    let _busyTimer = null;
    let _busyAll = false;
    const _busyIds = new Set();
    function scheduleBusyRefresh(ev) {
      const role = (ev && ev.role) ? String(ev.role) : '';
      if (!role) _busyAll = true;
      for (const s of list.value) {
        if (!group(s)) continue;                                   // 仅含雷影的会话行才有链接头像
        if (role && !(Array.isArray(s.agents) && s.agents.includes(role))) continue;
        _busyIds.add(s.id);
      }
      if (_busyTimer) return;
      _busyTimer = setTimeout(() => {
        _busyTimer = null;
        const ids = [..._busyIds]; const all = _busyAll;
        _busyIds.clear(); _busyAll = false;
        try { if (ids.length) pollLinks(false, ids); else if (all) pollLinks(true); } catch { }
      }, 120);
    }
    onMounted(() => {
      pollLinks();
      _linksTimer = setInterval(pollLinks, 15000);
      onServerEvent('agent-busy', scheduleBusyRefresh);
      onServerEvent('turn-done', scheduleBusyRefresh);
      onServerEvent('mailbox-message', scheduleBusyRefresh);
    });
    onUnmounted(() => {
      if (_linksTimer) { clearInterval(_linksTimer); _linksTimer = null; }
      if (_busyTimer) { clearTimeout(_busyTimer); _busyTimer = null; }
    });

    // —— v6.23：会话改名 / 删除（软删到回收站）/ 回收站恢复 ——
    const trashOpen = ref(false);
    const editingId = ref(null);
    const editTitle = ref('');
    const trashed = computed(() => (store.sessions || []).filter((s) => s.trashedAt));

    function startEdit(s) { editingId.value = s.id; editTitle.value = s.title || s.id || ''; }
    function cancelEdit() { editingId.value = null; editTitle.value = ''; }
    function focusEdit(id, el) {   // 函数式 ref：仅首次聚焦+全选，防每次输入重渲染时重复全选
      if (!el || editingId.value !== id || el.dataset.focused === '1') return;
      el.dataset.focused = '1'; el.focus(); if (el.select) el.select();
    }
    async function commitEdit(s) {
      const id = s.id;
      const title = (editTitle.value || '').trim().slice(0, 40);
      if (!title || title === (s.title || s.id)) { cancelEdit(); return; }
      cancelEdit();
      const prev = s.title; s.title = title;                 // 乐观更新
      try { await api.sessionRename(id, title); window.__leizaiReloadSessions && window.__leizaiReloadSessions(); }
      catch (e) { s.title = prev; toast('改名失败: ' + e.message, 'err'); }
    }
    // v6.31：删除防误触——「再点一次确认」轻交互（首次点击进入确认态，3s 内再点才执行；移开/超时还原）
    const confirmingId = ref(null);
    let _confirmTimer = null;
    function clearConfirm() {
      if (_confirmTimer) { clearTimeout(_confirmTimer); _confirmTimer = null; }
      confirmingId.value = null;
    }
    function armDelete(s) {
      if (confirmingId.value === s.id) { clearConfirm(); remove(s); return; }   // 二次点击 → 执行
      clearConfirm();
      confirmingId.value = s.id;                                               // 首次点击 → 进入确认态
      _confirmTimer = setTimeout(() => { confirmingId.value = null; _confirmTimer = null; }, 3000);
    }
    async function remove(s) {
      // v6.31：确认由 armDelete 的「再点一次」轻交互负责，此处不再用原生 confirm
      try {
        await api.sessionTrash(s.id);
        const arr = store.sessions || [];
        const i = arr.findIndex((x) => x.id === s.id);
        if (i >= 0) arr.splice(i, 1);                        // 移出当前列表（改为回收站项）
        if (store.currentId === s.id) { store.currentId = null; window.dispatchEvent(new CustomEvent('leizai-open-berth', { detail: 'nexus' })); }
        toast('已移入回收站', 'info');
      } catch (e) { toast('删除失败: ' + e.message, 'err'); }
    }
    async function restore(s) {
      try { await api.sessionRestore(s.id); toast('已恢复', 'info'); window.__leizaiReloadSessions && window.__leizaiReloadSessions(); }
      catch (e) { toast('恢复失败: ' + e.message, 'err'); }
    }
    // A1 回收站「彻底删除」——不可逆，且连带删除 projects/<id> 项目文档。
    // 与 armDelete 的 confirmingId **完全解耦**：独立 purgingId / 独立 3s 计时器，互不串味。
    const purgingId = ref(null);
    let _purgeTimer = null;
    function clearPurge() {
      if (_purgeTimer) { clearTimeout(_purgeTimer); _purgeTimer = null; }
      purgingId.value = null;
    }
    function armPurge(s) {
      if (purgingId.value === s.id) { clearPurge(); purge(s); return; }   // 二次点击 → 执行（不可逆）
      clearPurge();
      purgingId.value = s.id;                                            // 首次点击 → 进入确认态
      _purgeTimer = setTimeout(() => { purgingId.value = null; _purgeTimer = null; }, 3000);
    }
    async function purge(s) {
      clearPurge();
      try {
        await api.sessionDelete(s.id);                       // DELETE /api/sessions/:id（不可逆 + 连带删项目文档）
        const arr = store.sessions || [];
        const i = arr.findIndex((x) => x.id === s.id);
        if (i >= 0) arr.splice(i, 1);                        // 移出回收站列表
        if (store.currentId === s.id) { store.currentId = null; window.dispatchEvent(new CustomEvent('leizai-open-berth', { detail: 'nexus' })); }
        toast('已彻底删除（含项目文档）', 'info');
      } catch (e) { toast('彻底删除失败: ' + e.message, 'err'); }
    }
    return { list, loading, pick, meta, group, badge, running, runningTitle, relTime, busyOf, roleStatus, stateText, avState, roleVar,
             trashOpen, trashed, editingId, editTitle, startEdit, cancelEdit, focusEdit, commitEdit, remove, restore,
             confirmingId, armDelete, clearConfirm,
             purgingId, armPurge, clearPurge, purge,
             resultUnread: computed(() => store.resultUnread),
             currentId: computed(() => store.currentId) };
  },
  template: `
    <div v-if="loading" class="skeleton" style="height:44px;margin:6px;"></div>
    <template v-else>
      <div v-for="s in list" :key="s.id"
           :class="['session-item', meta(s).cls, { 'is-active': s.id === currentId, 'is-running': running(s) }]"
           role="option" :data-session-id="s.id" @click="pick(s)">
        <span v-if="group(s)" :class="group(s).cls">
          <span v-for="(m, i) in group(s).shown" :key="i" class="avatar avatar--mini"
                :class="[m.cls, m.role === 'main' ? 'is-main' : '', 'is-' + m.state]" :style="roleVar(m.role)"
                :title="m.name + stateText(m.state)"><span class="role-icon" :style="{ '--icon': 'url(' + m.icon + ')' }"></span></span>
          <span v-if="group(s).extra" class="avatar avatar--mini avatar--more" :title="'另有 ' + group(s).extra + ' 个雷影'"><span class="avatar-glyph">+{{ group(s).extra }}</span></span>
        </span>
        <span v-else class="avatar" :class="[meta(s).cls, 'is-' + avState(s, 'main')]"><span class="role-icon" :style="{ '--icon': 'url(' + meta(s).icon + ')' }"></span></span>
        <span v-if="running(s)" class="session-item__run" :title="runningTitle(s)"></span>
        <div class="session-item__body">
          <div class="session-item__title">
            <span v-if="resultUnread[s.id]" class="session-item__nr" aria-label="有新回执未看" title="有新回执/应答未看"></span>
            <input v-if="editingId === s.id" class="session-item__edit" :value="editTitle"
                   :ref="el => focusEdit(s.id, el)"
                   @input="editTitle = $event.target.value"
                   @keydown.enter.prevent="commitEdit(s)"
                   @keydown.esc.prevent="cancelEdit()"
                   @blur="commitEdit(s)" @click.stop>
            <template v-else>{{ s.title || s.id }}</template>
          </div>
          <div class="session-item__time">{{ relTime(s.updatedAt || s.createdAt) }}</div>
        </div>
        <span v-if="badge(s)" class="badge">{{ badge(s) }}</span>
        <span class="session-item__ops" @mouseleave="clearConfirm()">
          <button type="button" class="session-op" title="重命名" aria-label="重命名" @click.stop="startEdit(s)">
            <svg class="session-op__ico" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14 6l4 4"/></svg>
          </button>
          <button type="button" class="session-op session-op--del"
                  :class="{ 'is-confirming': confirmingId === s.id }"
                  :title="confirmingId === s.id ? '再次点击确认删除（3 秒内）' : '删除'"
                  aria-label="删除" @click.stop="armDelete(s)">
            <span v-if="confirmingId === s.id" class="session-op__confirm">确认</span>
            <svg v-else class="session-op__ico" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M6.5 7l1 12.5h9L17.5 7"/><path d="M10 4.5h4"/><path d="M10 11v5M14 11v5"/></svg>
          </button>
        </span>
      </div>
      <div v-if="!list.length" class="empty"><div class="empty__text">无会话</div></div>
      <div v-if="trashed.length" class="session-trash">
        <button type="button" class="session-trash__head" @click="trashOpen = !trashOpen">
          <span>回收站 ({{ trashed.length }})</span>
          <span class="session-trash__caret">{{ trashOpen ? '▾' : '▸' }}</span>
        </button>
        <template v-if="trashOpen">
          <div v-for="s in trashed" :key="s.id" class="session-item session-item--trashed">
            <span class="avatar"><span class="avatar-glyph">♻</span></span>
            <div class="session-item__body">
              <div class="session-item__title">{{ s.title || s.id }}</div>
              <div class="session-item__time">{{ relTime(s.updatedAt || s.createdAt) }}</div>
            </div>
            <div class="session-item__ops">
              <button type="button" class="session-op session-op--restore" title="恢复会话" @click.stop="restore(s)">恢复</button>
              <button type="button" class="session-op session-op--restore" :class="{ 'is-confirming': purgingId === s.id }"
                      :style="purgingId === s.id ? { color: '#fff', background: 'var(--err)', borderColor: 'var(--err)' } : { color: 'var(--err)' }"
                      :title="purgingId === s.id ? '再点一次确认彻底删除（不可恢复，且会删除该项目全部文档）' : '彻底删除（不可恢复，且会连带删除该项目全部文档）'"
                      :aria-label="purgingId === s.id ? '确认彻底删除' : '彻底删除'"
                      @click.stop="purgingId === s.id ? purge(s) : armPurge(s)"
                      @mouseleave="purgingId === s.id && clearPurge()"
                      @blur="purgingId === s.id && clearPurge()">{{ purgingId === s.id ? '确认删' : '彻底删' }}</button>
            </div>
          </div>
        </template>
      </div>
    </template>
  `,
});
