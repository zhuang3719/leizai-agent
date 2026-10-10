// A1 前端 · 自省舱 6 个 pane（挂载 #pane-profile/evolution/memory/skills/growth/archive）
import { defineComponent, ref, computed, onMounted, watch } from 'vue';
import { api } from '../api.js';
import { store } from '../store.js';
import { renderMarkdown } from '../markdown.js';

export const PaneProfile = defineComponent({
  name: 'PaneProfile',
  setup() {
    const self = ref({ summary: '', snapshot: null });
    const loading = ref(true);
    async function load() { try { self.value = await api.self(); store.self = self.value; } catch { } finally { loading.value = false; } }
    onMounted(load);
    window.__leizaiReloadSelf = load;
    const html = computed(() => renderMarkdown(self.value.summary || '（暂无画像）'));
    return { self, loading, html, refresh: load };
  },
  template: `
    <div class="card-list">
      <div class="card"><div class="card__head"><span class="card__title is-acc">自我画像</span>
        <button class="btn btn--ghost btn--sm" style="margin-left:auto;" @click="refresh">刷新</button></div>
        <div class="md" style="max-height:60vh;overflow:auto;" v-html="html"></div>
        <div v-if="loading" class="skeleton" style="height:60px;margin-top:8px;"></div>
      </div>
    </div>
  `,
});

export const PaneEvolution = defineComponent({
  name: 'PaneEvolution',
  setup() {
    const list = ref([]); const filter = ref('all');
    onMounted(async () => { try { list.value = await api.evolution() || []; } catch { } });
    const view = computed(() => filter.value === 'all' ? list.value : list.value.filter((e) => e.status === filter.value));
    return { view, filter };
  },
  template: `
    <div>
      <div class="subtabs" style="margin-bottom:10px;">
        <button v-for="f in ['all','applied','pending','rejected']" :key="f" :class="['subtab',{ 'is-active': filter===f }]" @click="filter=f">{{ f }}</button>
      </div>
      <div class="card-list">
        <div class="card" v-for="e in view.slice(0,60)" :key="e.id">
          <div class="card__head">
            <span class="chip chip--acc">{{ e.target }}</span>
            <span class="card__title">{{ e.title }}</span>
            <span class="chip" style="margin-left:auto;">{{ e.status }}</span>
          </div>
          <div class="card__sub">{{ e.rationale }}</div>
        </div>
        <div v-if="!view.length" class="empty"><div class="empty__text">暂无提案</div></div>
      </div>
    </div>
  `,
});

export const PaneMemory = defineComponent({
  name: 'PaneMemory',
  setup() {
    const list = ref([]); const q = ref('');
    onMounted(async () => { try { list.value = await api.memory() || []; } catch { } });
    const view = computed(() => {
      const kw = q.value.trim().toLowerCase();
      return kw ? list.value.filter((m) => ((m.title || m.name || '') + (m.preview || '')).toLowerCase().includes(kw)) : list.value;
    });
    return { q, view };
  },
  template: `
    <div>
      <div class="search-box" style="margin:0 0 12px;">
        <span class="icon icon--sm" style="--i:url(/assets/ui-search.svg)"></span>
        <input v-model="q" placeholder="搜索记忆…">
      </div>
      <div class="card-list">
        <div class="card" v-for="m in view.slice(0,120)" :key="m.name">
          <div class="card__title">{{ m.title || m.name }}</div>
          <div class="card__sub">{{ m.preview }}</div>
        </div>
        <div v-if="!view.length" class="empty"><div class="empty__text">无匹配记忆</div></div>
      </div>
    </div>
  `,
});

export const PaneSkills = defineComponent({
  name: 'PaneSkills',
  setup() {
    const list = ref([]);
    onMounted(async () => { try { list.value = await api.get('/api/skills') || []; } catch { } });
    return { list };
  },
  template: `
    <div class="card-grid">
      <div class="card card--hover" v-for="s in list" :key="s.name">
        <div class="card__title">{{ s.title || s.name }}</div>
        <div class="card__sub">{{ s.preview }}</div>
      </div>
      <div v-if="!list.length" class="empty"><div class="empty__text">暂无技能</div></div>
    </div>
  `,
});

export const PaneGrowth = defineComponent({
  name: 'PaneGrowth',
  setup() {
    const g = ref(null); const canvas = ref(null);
    async function load() {
      try { g.value = await api.growth(); } catch { }
      draw();
    }
    function draw() {
      const el = canvas.value; if (!el || !g.value || !g.value.latest) return;
      const l = g.value.latest;
      el.width = el.clientWidth || 400; el.height = 180;
      const ctx = el.getContext('2d'); ctx.clearRect(0, 0, el.width, el.height);
      const metrics = [['记忆', l.totalMemories], ['技能', l.skills], ['进化', l.evoVersions], ['会话', l.sessions]];
      const max = Math.max(1, ...metrics.map((m) => m[1] || 0));
      const bw = el.width / metrics.length;
      metrics.forEach((m, i) => {
        const h = (m[1] || 0) / max * (el.height - 40);
        ctx.fillStyle = '#00e5ff';
        ctx.fillRect(i * bw + bw * 0.2, el.height - 20 - h, bw * 0.6, h);
        ctx.fillStyle = '#8a93a6'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(m[0] + ' ' + (m[1] || 0), i * bw + bw / 2, el.height - 6);
      });
    }
    onMounted(load);
    return { g, canvas, load };
  },
  template: `
    <div class="card">
      <div class="card__head"><span class="card__title">成长曲线</span>
        <button class="btn btn--ghost btn--sm" style="margin-left:auto;" @click="load">刷新</button></div>
      <div class="card__sub" v-if="g && g.latest">记忆 {{ g.latest.totalMemories }} · 技能 {{ g.latest.skills }} · 进化 {{ g.latest.evoVersions }} · 会话 {{ g.latest.sessions }} · 命中 {{ (g.latest.cacheHitRate*100).toFixed(0) }}%</div>
      <canvas ref="canvas" style="width:100%;height:180px;margin-top:8px;"></canvas>
    </div>
  `,
});

export const PaneArchive = defineComponent({
  name: 'PaneArchive',
  setup() {
    const items = ref([]); const q = ref('');
    const total = ref(0); const offset = ref(0); const hasMore = ref(false); const loading = ref(false);
    const limit = 50;
    const sid = computed(() => store.currentId);
    // v6.16：按后端真实字段 {seq,role,ts,content} 渲染 + 分页(limit/offset/hasMore)
    async function load(reset) {
      if (!sid.value) { items.value = []; total.value = 0; hasMore.value = false; return; }
      if (reset) offset.value = 0;
      loading.value = true;
      try {
        const a = await api.archive(sid.value, limit, offset.value);
        const ents = Array.isArray(a) ? a : (a && a.entries) || [];
        items.value = ents;
        total.value = (a && typeof a.count === 'number') ? a.count : ents.length;
        hasMore.value = !!(a && a.hasMore);
      } catch { items.value = []; total.value = 0; hasMore.value = false; }
      finally { loading.value = false; }
    }
    function prev() { if (offset.value <= 0) return; offset.value = Math.max(0, offset.value - limit); load(false); }
    function next() { if (!hasMore.value) return; offset.value += limit; load(false); }
    onMounted(() => load(true));
    watch(() => store.currentId, () => load(true));   // 切换/选中会话后重载归档
    window.__leizaiReloadArchive = () => load(true);   // 供舱内子标签切换到"世代"时懒加载
    const page = computed(() => Math.floor(offset.value / limit) + 1);
    const pages = computed(() => Math.max(1, Math.ceil(total.value / limit)));
    const view = computed(() => { const kw = q.value.trim().toLowerCase(); return kw ? items.value.filter((e) => ((e.role || '') + (e.content || '')).toLowerCase().includes(kw)) : items.value; });
    function fmtTs(ts) { if (!ts) return ''; const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts)); return isNaN(d.getTime()) ? '' : d.toLocaleString(); }
    function summary(s) { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > 200 ? t.slice(0, 200) + '…' : t; }
    return { q, view, load, prev, next, hasMore, loading, total, page, pages, fmtTs, summary, hasSid: computed(() => !!sid.value) };
  },
  template: `
    <div>
      <div class="search-box" style="margin:0 0 12px;">
        <span class="icon icon--sm" style="--i:url(/assets/ui-search.svg)"></span>
        <input v-model="q" placeholder="检索当前页归档…">
      </div>
      <div class="card-list">
        <div class="card" v-for="(e, i) in view" :key="i">
          <div class="card__head">
            <span class="chip chip--acc">{{ e.role || '—' }}</span>
            <span class="card__sub" style="margin-left:auto;">{{ fmtTs(e.ts) }}</span>
          </div>
          <div class="card__sub">{{ summary(e.content) }}</div>
        </div>
        <div v-if="!view.length" class="empty"><div class="empty__text">{{ hasSid ? '本会话暂无归档' : '请先选择一个会话' }}</div></div>
      </div>
      <div v-if="hasSid" style="display:flex; align-items:center; gap:10px; margin-top:10px;">
        <button class="btn btn--ghost btn--sm" @click="prev" :disabled="page <= 1 || loading">上一页</button>
        <span class="dim" style="font-size:12px;">第 {{ page }} / {{ pages }} 页 · 共 {{ total }} 条</span>
        <button class="btn btn--ghost btn--sm" @click="next" :disabled="!hasMore || loading">下一页</button>
      </div>
    </div>
  `,
});


// —— 会话树 · 泳道图（美工）：主轴时间线 + 每条分枝一条泳道；x 轴=轮次(turn_no) ——
//   大枝（如 361 事件）按「列分桶聚合」渲染，杜绝重叠糊成一团；支持 kind 筛选 / 悬停明细 / 点击下钻。
const TREE_KINDS = [
  { k: 'user', label: '用户', color: '#00E5FF', shape: 'dot' },
  { k: 'assistant', label: '回复', color: '#4DF3FF', shape: 'dot' },
  { k: 'turn', label: '轮次', color: '#5E6B87', shape: 'dot' },
  { k: 'decision', label: '决定', color: '#FFB020', shape: 'sq' },
  { k: 'note', label: '记录', color: '#93A2C0', shape: 'note' },
  { k: 'fruit', label: '成果', color: '#2BE088', shape: 'star' },
  { k: 'goal', label: '目标', color: '#FF7A3D', shape: 'goal' },
  { k: 'detail', label: '明细', color: '#7C4DFF', shape: 'dot' },
  { k: 'tool', label: '工具', color: '#7C4DFF', shape: 'dot' },
];
const TREE_KIND_MAP = TREE_KINDS.reduce((m, x) => (m[x.k] = x, m), {});
function tk(k) { return TREE_KIND_MAP[k] || { k: k, label: k || '其它', color: '#93A2C0', shape: 'dot' }; }

export const PaneTree = defineComponent({
  name: 'PaneTree',
  setup() {
    const data = ref(null); const loading = ref(false); const err = ref('');
    const sid = computed(() => store.currentId);
    const onKinds = ref([]);            // 空 = 全部显示
    const sel = ref(null);              // 下钻详情 { laneKey, laneTitle, turnFrom, turnTo, items:[...] }
    const COLS = 60;                    // 列数上限（分桶）——保证任何规模都不糊

    function kindAllowed(k) { return !onKinds.value.length || onKinds.value.indexOf(k) >= 0; }
    function toggleKind(k) { const i = onKinds.value.indexOf(k); if (i >= 0) onKinds.value.splice(i, 1); else onKinds.value.push(k); }

    async function load() {
      sel.value = null;
      if (!sid.value) { data.value = null; return; }
      loading.value = true; err.value = '';
      try { data.value = await api.sessionTree(sid.value, 200); }
      catch (e) { data.value = null; err.value = ((e && e.message) || '加载失败'); }
      finally { loading.value = false; }
    }
    onMounted(load);
    watch(() => store.currentId, () => load(true));
    window.__leizaiReloadTree = () => load();   // 供舱内子标签切换到"树"时懒加载

    // —— 布局：把各 lane 的节点按轮次分桶到 COLS 列 ——
    const lanes = computed(() => {
      const d = data.value; if (!d) return [];
      const raw = [];
      const main = (d.mainAxis || []).map((n) => Object.assign({}, n, { _main: true }));
      if (main.length) raw.push({ key: '__main__', title: '主轴', count: main.length, nodes: main, _main: true });
      for (const b of (d.branches || [])) raw.push({ key: b.topic_key || ('branch-' + raw.length), title: b.topic_key || '(未命名枝)', count: b.count || (b.nodes || []).length, nodes: b.nodes || [], _main: false, _b: b });
      // 全局轮次范围
      let tMin = Infinity, tMax = -Infinity;
      for (const L of raw) for (const n of L.nodes) { const t = Number(n.turn_no); if (isFinite(t)) { if (t < tMin) tMin = t; if (t > tMax) tMax = t; } }
      if (!isFinite(tMin)) { tMin = 0; tMax = 1; }
      if (tMax <= tMin) tMax = tMin + 1;
      const cols = Math.min(COLS, Math.max(1, tMax - tMin + 1));
      const put = (lane) => {
        const buckets = new Map();
        for (const n of lane.nodes) {
          const k = n.kind || 'turn';
          if (!kindAllowed(k)) continue;
          const t = Number(n.turn_no); const x = isFinite(t) ? Math.round(((t - tMin) / (tMax - tMin)) * (cols - 1)) : 0;
          let b = buckets.get(x); if (!b) { b = { col: x, count: 0, kinds: {}, items: [], turnFrom: t, turnTo: t }; buckets.set(x, b); }
          b.count++; b.kinds[k] = (b.kinds[k] || 0) + 1; b.items.push(n);
          if (isFinite(t)) { b.turnFrom = Math.min(b.turnFrom, t); b.turnTo = Math.max(b.turnTo, t); }
        }
        const arr = Array.from(buckets.values()).sort((a, c) => a.col - c.col);
        return arr.map((b) => {
          const ks = Object.keys(b.kinds).sort((a, c) => b.kinds[c] - b.kinds[a]);
          const dom = ks[0] || 'turn'; const meta = tk(dom);
          const size = Math.max(9, Math.min(20, 9 + Math.round(Math.log2(b.count + 1) * 3.4)));
          return {
            col: b.col, leftPct: cols <= 1 ? 50 : (b.col / (cols - 1)) * 100,
            count: b.count, size: size, color: meta.color, shape: meta.shape, dom: dom,
            kindsLabel: ks.map((x) => tk(x).label + '×' + b.kinds[x]).join(' · '),
            turnFrom: b.turnFrom, turnTo: b.turnTo, items: b.items.slice(0, 30),
          };
        });
      };
      return raw.map((L) => Object.assign({}, L, { marks: put(L) }));
    });
    const ticks = computed(() => {
      const d = data.value; if (!d) return [];
      let tMin = Infinity, tMax = -Infinity;
      for (const L of (d.mainAxis ? [{ nodes: d.mainAxis }] : []).concat(d.branches || [])) for (const n of (L.nodes || [])) { const t = Number(n.turn_no); if (isFinite(t)) { if (t < tMin) tMin = t; if (t > tMax) tMax = t; } }
      if (!isFinite(tMin)) return [];
      const n = 6, out = [];
      for (let i = 0; i < n; i++) { const t = Math.round(tMin + (tMax - tMin) * (i / (n - 1))); out.push({ t: t, pct: (i / (n - 1)) * 100 }); }
      return out;
    });
    const kindCounts = computed(() => {
      const c = {}; const d = data.value; if (!d) return c;
      const all = (d.mainAxis || []).concat(...(d.branches || []).map((b) => b.nodes || []));
      for (const n of all) { const k = n.kind || 'turn'; c[k] = (c[k] || 0) + 1; }
      return c;
    });
    const kindList = computed(() => TREE_KINDS.filter((x) => kindCounts.value[x.k] || onKinds.value.indexOf(x.k) >= 0)
      .concat(Object.keys(kindCounts.value).filter((k) => !TREE_KIND_MAP[k]).map((k) => tk(k))));

    function openDetail(lane, mark) {
      sel.value = { laneTitle: lane.title, laneKey: lane.key, turnFrom: mark.turnFrom, turnTo: mark.turnTo,
        items: mark.items.map((n) => ({ turn_no: n.turn_no, kind: n.kind || 'turn', title: n.title || n.topic_key || '' })) };
    }
    function closeDetail() { sel.value = null; }
    const hasSid = computed(() => !!sid.value);

    return { data, loading, err, lanes, ticks, sel, openDetail, closeDetail, onKinds, toggleKind, kindAllowed,
             kindList, kindCounts, tk, hasSid, COLS };
  },
  template: `
    <div class="tree-wrap">
      <div v-if="!hasSid" class="tree-empty">请先选择一个会话</div>
      <div v-else-if="loading" class="tree-loading">加载会话树…</div>
      <div v-else-if="err" class="tree-empty">会话树端点未就绪：{{ err }}</div>
      <div v-else-if="!data || (!(lanes && lanes.length))" class="tree-empty">本会话暂无枝干事件，先聊起来吧</div>
      <template v-else>
        <div class="tree-toolbar">
          <div class="tree-chips">
            <span v-for="kd in kindList" :key="kd.k" class="tree-chip" :class="{ 'is-on': kindAllowed(kd.k) }"
                  :style="'--k:' + kd.color" @click="toggleKind(kd.k)" :title="'按 ' + kd.label + ' 筛选'">
              <span class="tree-chip__dot" :class="kd.shape === 'sq' ? 'tree-chip__dot--sq' : (kd.shape === 'star' ? 'tree-chip__dot--star' : '')"></span>
              {{ kd.label }}<span class="tree-chip__n">{{ kindCounts[kd.k] || 0 }}</span>
            </span>
          </div>
          <div class="tree-legend">
            <span>共 {{ (lanes || []).length }} 条泳道</span>
            <span>点节点下钻 · 点枝名聚焦</span>
          </div>
        </div>

        <div class="tree-scroll">
          <div class="tree-canvas">
            <div class="tree-axis">
              <div class="tree-axis__spacer"></div>
              <div class="tree-axis__track">
                <span v-for="(t, i) in ticks" :key="i" class="tree-axis__tick" :style="'left:' + t.pct + '%'">{{ t.t }}</span>
              </div>
            </div>
            <div v-for="L in lanes" :key="L.key" class="tree-lane">
              <div class="tree-lane__head" :title="L.title">
                <span class="tree-lane__title" :class="{ 'is-main': L._main }">{{ L.title }}</span>
                <span class="tree-lane__meta">{{ L.count }} 事件</span>
              </div>
              <div class="tree-lane__track" :class="{ 'is-main': L._main }">
                <span v-for="(m, i) in L.marks" :key="i"
                      :class="['tree-node', 'tree-node--' + m.shape, { 'is-sel': sel && sel.laneKey === L.key && sel.turnFrom === m.turnFrom }]"
                      :style="'left:' + m.leftPct + '%;--k:' + m.color + ';width:' + m.size + 'px;height:' + m.size + 'px;'"
                      :title="'#' + m.turnFrom + (m.turnTo !== m.turnFrom ? '–' + m.turnTo : '') + ' · ' + m.kindsLabel"
                      @click="openDetail(L, m)">
                  <span v-if="m.count > 1" class="tree-node__n">{{ m.count }}</span>
                </span>
              </div>
            </div>
          </div>
        </div>

        <div v-if="sel" class="tree-detail">
          <div class="tree-detail__head">
            <span class="chip chip--acc">{{ sel.laneTitle }}</span>
            <span>轮次 #{{ sel.turnFrom }}<template v-if="sel.turnTo !== sel.turnFrom">–{{ sel.turnTo }}</template> · {{ sel.items.length }} 条</span>
            <button class="btn btn--ghost btn--sm tree-detail__close" @click="closeDetail">关闭</button>
          </div>
          <div v-for="(it, i) in sel.items" :key="i" class="tree-detail__item">
            <span class="tree-detail__turn">#{{ it.turn_no }}</span>
            <span class="chip" :style="'--role:' + tk(it.kind).color" :title="tk(it.kind).label">{{ tk(it.kind).label }}</span>
            <span class="tree-detail__title">{{ it.title || '（无标题）' }}</span>
          </div>
        </div>
      </template>
    </div>
  `,
});


// —— 会话树 · 树形可视化（雷影·美工 v2）：把"会话树"画成**一棵树** ——
//   根=本会话 · 主干=主轴 · 大枝=各 topic_key · 叶=各 branch.nodes（按 kind 上色/成形）
//   另含"果实簇"：决定 / 待办 / 待补前缀。支持 折叠/展开、kind 筛选、点击下钻；
//   大枝的叶按 kind **聚合**（防 2000+ 事件糊成一团）。保留原泳道图 PaneTree 作可选视图。
export const PaneTreeView = defineComponent({
  name: 'PaneTreeView',
  components: { PaneTree },
  setup() {
    const data = ref(null); const loading = ref(false); const err = ref('');
    const sid = computed(() => store.currentId);
    const onKinds = ref([]);              // 空 = 全部显示
    const expanded = ref({});             // { [branchKey]: true }
    const miscOpen = ref({});             // 果实簇展开态
    const sel = ref(null);                // 下钻详情 { title, items:[{turn_no,kind,title}] }
    const view = ref('tree');             // 'tree'（默认树形） | 'canal'（泳道图）
    const MAIN_COLS = 24;                 // 主干聚合列数

    function kindAllowed(k) { return !onKinds.value.length || onKinds.value.indexOf(k) >= 0; }
    function toggleKind(k) { const i = onKinds.value.indexOf(k); if (i >= 0) onKinds.value.splice(i, 1); else onKinds.value.push(k); }

    async function load() {
      sel.value = null; expanded.value = {}; miscOpen.value = {};
      if (!sid.value) { data.value = null; return; }
      loading.value = true; err.value = '';
      try { data.value = await api.sessionTree(sid.value, 200); }
      catch (e) { data.value = null; err.value = ((e && e.message) || '加载失败'); }
      finally { loading.value = false; }
    }
    onMounted(load);
    watch(() => store.currentId, () => load());
    window.__leizaiReloadTree = () => load();

    const kindCounts = computed(() => {
      const c = {}; const d = data.value; if (!d) return c;
      const all = (d.mainAxis || []).concat(...(d.branches || []).map((b) => b.nodes || []));
      for (const n of all) { const k = n.kind || 'turn'; c[k] = (c[k] || 0) + 1; }
      return c;
    });
    const kindList = computed(() => TREE_KINDS.filter((x) => kindCounts.value[x.k] || onKinds.value.indexOf(x.k) >= 0)
      .concat(Object.keys(kindCounts.value).filter((k) => !TREE_KIND_MAP[k]).map((k) => tk(k))));

    // 主干：主轴节点按轮次分桶聚合（最多 MAIN_COLS 个）——保证不糊
    const trunk = computed(() => {
      const d = data.value; if (!d) return [];
      const main = (d.mainAxis || []);
      const ts = main.map((n) => Number(n.turn_no)).filter(isFinite);
      if (!ts.length) return [];
      const tMin = Math.min.apply(null, ts), tMax = Math.max.apply(null, ts);
      const cols = Math.min(MAIN_COLS, Math.max(1, tMax - tMin + 1));
      const buckets = new Map();
      for (const n of main) {
        const k = n.kind || 'turn'; if (!kindAllowed(k)) continue;
        const t = Number(n.turn_no);
        const x = (isFinite(t) && tMax > tMin) ? Math.round(((t - tMin) / (tMax - tMin)) * (cols - 1)) : 0;
        let b = buckets.get(x); if (!b) { b = { x: x, count: 0, kinds: {}, items: [], turnFrom: t, turnTo: t }; buckets.set(x, b); }
        b.count++; b.kinds[k] = (b.kinds[k] || 0) + 1; b.items.push(n);
        if (isFinite(t)) { b.turnFrom = Math.min(b.turnFrom, t); b.turnTo = Math.max(b.turnTo, t); }
      }
      return Array.from(buckets.values()).sort((a, b) => a.x - b.x).map((b, i) => {
        const ks = Object.keys(b.kinds).sort((a, c) => b.kinds[c] - b.kinds[a]);
        const dom = ks[0] || 'turn';
        return { i: i, count: b.count, turnFrom: b.turnFrom, turnTo: b.turnTo, color: tk(dom).color,
                 side: i % 2 ? 'left' : 'right',
                 kindsLabel: ks.map((x) => tk(x).label + '×' + b.kinds[x]).join(' · '),
                 items: b.items.slice(0, 30) };
      });
    });

    // 大枝：每条 topic_key 一条枝；叶按 kind 聚合
    const branchRows = computed(() => {
      const d = data.value; if (!d) return [];
      const bs = (d.branches || []).slice().sort((a, b) => (a.turnFrom || 0) - (b.turnFrom || 0));
      return bs.map((b, i) => {
        const key = b.topic_key || ('branch-' + i);
        const nodes = (b.nodes || []);
        const map = {}; let shown = 0;
        for (const n of nodes) {
          const k = n.kind || 'turn'; if (!kindAllowed(k)) continue; shown++;
          if (!map[k]) map[k] = { kind: k, count: 0, items: [] };
          map[k].count++; if (map[k].items.length < 60) map[k].items.push(n);
        }
        // 后端 branch.nodes 多为 kind='turn'，真实 kind 分布在其 b.kinds 计数里 —— 合并，保证各 kind 都成"叶"
        // F1（2026-09-29）：非 turn 叶的真实条目来自 b.itemsByKind[k]（后端已提供）；turn 用 nodes 兜底。
        const km = b.kinds || {};
        const ibk = b.itemsByKind || {};
        for (const k of Object.keys(km)) {
          if (!kindAllowed(k)) continue;
          if (!map[k]) map[k] = { kind: k, count: 0, items: [] };
          map[k].count = Math.max(map[k].count, km[k]);
          if (Array.isArray(ibk[k]) && ibk[k].length) map[k].items = ibk[k].slice(0, 60);
        }
        const leaves = Object.keys(map).map((k) => Object.assign(map[k], { color: tk(k).color, label: tk(k).label, shape: tk(k).shape }))
          .sort((a, c) => c.count - a.count);
        const kept = nodes.filter((n) => kindAllowed(n.kind || 'turn')).slice(0, 200);
        return { key: key, title: key, count: b.count || nodes.length, turnFrom: b.turnFrom, turnTo: b.turnTo,
                 shown: shown, leaves: leaves, nodes: kept, side: i % 2 ? 'left' : 'right', expanded: !!expanded.value[key] };
      });
    });

    // 果实簇：决定 / 待办 / 待补前缀（保证"所有内容"都出现）
    const misc = computed(() => {
      const d = data.value; if (!d) return [];
      return [
        { key: 'decisions', title: '决定', icon: '◆', color: '#FFB020', items: d.decisions || [] },
        { key: 'todos', title: '待办', icon: '◇', color: '#00E5FF', items: d.todos || [] },
        { key: 'pendingPfx', title: '待补前缀', icon: '✚', color: '#FF7A3D', items: d.pendingPfx || [] },
      ].filter((x) => x.items.length);
    });

    function toggleBranch(key) { const e = Object.assign({}, expanded.value); e[key] = !e[key]; expanded.value = e; }
    function toggleMisc(key) { const e = Object.assign({}, miscOpen.value); e[key] = !e[key]; miscOpen.value = e; }
    function expandAll() { const e = {}; for (const r of branchRows.value) e[r.key] = true; expanded.value = e; }
    function collapseAll() { expanded.value = {}; }
    function text(it) { return typeof it === 'string' ? it : (it.title || it.topic_key || '（无标题）'); }
    function openItems(title, items, color) {
      sel.value = { title: title, color: color, items: (items || []).map((it) => (typeof it === 'string'
        ? { turn_no: null, kind: '', title: it }
        : { turn_no: it.turn_no, kind: it.kind || 'turn', title: it.title || it.topic_key || '' })) };
    }
    function openTrunk(m) { openItems('主干 · #' + m.turnFrom + (m.turnTo !== m.turnFrom ? '–' + m.turnTo : ''), m.items, m.color); }
    // 大枝：展开/收起 + 右栏联动（显示该枝全部 nodes）
    function openBranch(b) {
      toggleBranch(b.key);
      const items = (b.nodes && b.nodes.length) ? b.nodes : [];
      openItems(b.title + '（大枝）', items, '#00E5FF');
    }
    // 果实簇：展开/收起 + 右栏联动（决定 / 待办 / 待补前缀）
    function openFruit(m) {
      toggleMisc(m.key);
      openItems(m.title, m.items, m.color);
    }
    const hasSid = computed(() => !!sid.value);

    return { data, loading, err, sid, hasSid, view, onKinds, toggleKind, kindAllowed, kindCounts, kindList, tk,
             trunk, branchRows, misc, expanded, miscOpen, sel, toggleBranch, toggleMisc, expandAll, collapseAll,
             openItems, openTrunk, openBranch, openFruit, text, MAIN_COLS };
  },
  template: `
    <div class="tree-wrap">
      <div class="tree-toolbar">
        <div class="ttree-viewtoggle">
          <button class="btn btn--ghost btn--sm" :class="{ 'is-active': view === 'tree' }" @click="view = 'tree'" title="树形视图（默认）">树形</button>
          <button class="btn btn--ghost btn--sm" :class="{ 'is-active': view === 'canal' }" @click="view = 'canal'" title="泳道图视图">泳道</button>
        </div>
        <div class="tree-chips" style="flex:1 1 240px;">
          <span v-for="kd in kindList" :key="kd.k" class="tree-chip" :class="{ 'is-on': kindAllowed(kd.k) }"
                :style="'--k:' + kd.color" @click="toggleKind(kd.k)" :title="'按 ' + kd.label + ' 筛选'">
            <span class="tree-chip__dot" :class="kd.shape === 'sq' ? 'tree-chip__dot--sq' : (kd.shape === 'star' ? 'tree-chip__dot--star' : '')"></span>
            {{ kd.label }}<span class="tree-chip__n">{{ kindCounts[kd.k] || 0 }}</span>
          </span>
        </div>
      </div>

      <pane-tree v-if="view === 'canal'"></pane-tree>

      <template v-else>
        <div v-if="!hasSid" class="tree-empty">请先选择一个会话</div>
        <div v-else-if="loading" class="tree-loading">加载会话树…</div>
        <div v-else-if="err" class="tree-empty">会话树端点未就绪：{{ err }}</div>
        <div v-else-if="!data || (!(trunk && trunk.length) && !(branchRows && branchRows.length) && !(misc && misc.length))" class="tree-empty">本会话暂无枝干事件，先聊起来吧</div>
        <template v-else>
          <div class="tree-legend">
            <span>主干 <b style="color:var(--acc2)">{{ trunk.length }}</b> · 大枝 <b style="color:var(--acc2)">{{ branchRows.length }}</b></span>
            <span>点枝展开 · 点叶下钻 · 点果实簇看明细</span>
            <button class="btn btn--ghost btn--sm" @click="expandAll">展开全部</button>
            <button class="btn btn--ghost btn--sm" @click="collapseAll">折叠全部</button>
          </div>

          <div class="ttree-layout">
            <div class="tree-scroll ttree-scroll">
            <div class="ttree">
              <!-- 根 = 本会话 -->
              <div class="ttree__root">
                <span class="ttree__root-ico"></span>
                <span>本会话</span>
                <span class="ttree__root-sid mono">{{ (data && data.sessionId) || sid }}</span>
              </div>

              <!-- 主干 = 主轴（按 turn_no 顺序，节点沿树干分布） -->
              <div class="ttree__trunk">
                <div v-for="m in trunk" :key="m.i" class="ttree__mark" :class="'is-' + m.side"
                     :title="'#' + m.turnFrom + (m.turnTo !== m.turnFrom ? '–' + m.turnTo : '') + ' · ' + m.kindsLabel + '（点击下钻）'"
                     @click="openTrunk(m)">
                  <span class="ttree__dot" :style="'--k:' + m.color"></span>
                  <span class="ttree__mark-lab">#{{ m.turnFrom }}<template v-if="m.turnTo !== m.turnFrom">–{{ m.turnTo }}</template> · {{ m.count }}</span>
                </div>
              </div>

              <!-- 大枝 = 各 topic_key（左右交替，枝宽映射事件数） -->
              <div class="ttree__branches">
                <div v-for="b in branchRows" :key="b.key" class="ttree__branch" :class="['is-' + b.side, { 'is-open': b.expanded }]">
                  <div class="ttree__bwrap">
                    <div class="ttree__bnode" @click="openBranch(b)" :title="b.title + ' · ' + b.count + ' 事件'">
                      <span class="ttree__bcount">{{ b.count }}</span>
                      <span class="ttree__btitle">{{ b.title }}</span>
                      <span class="ttree__bmeta">#{{ b.turnFrom }}<template v-if="b.turnTo !== b.turnFrom">–{{ b.turnTo }}</template></span>
                      <span class="ttree__caret">{{ b.expanded ? '▾' : '▸' }}</span>
                    </div>
                    <div v-if="b.expanded" class="ttree__leaves">
                      <template v-if="b.leaves.length">
                        <span v-for="lv in b.leaves" :key="lv.kind" class="ttree__leaf" :style="'--k:' + lv.color"
                              @click="openItems(b.title + ' · ' + lv.label, lv.items, lv.color)"
                              :title="lv.label + ' ×' + lv.count + '（点击下钻）'">
                          <span class="ttree__leaf-dot" :class="'is-' + lv.shape"></span>{{ lv.label }}<b>{{ lv.count }}</b>
                        </span>
                      </template>
                      <span v-else class="ttree__leaf is-empty">该枝在当前筛选下无叶</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 果实簇：决定 / 待办 / 待补前缀 -->
              <div class="ttree__misc" v-if="misc && misc.length">
                <div v-for="m in misc" :key="m.key" class="ttree__fruit" :style="'--k:' + m.color" @click="openFruit(m)">
                  <div class="ttree__fruit-h">
                    <span class="ttree__fruit-ico">{{ m.icon }}</span>{{ m.title }}<b>{{ m.items.length }}</b>
                    <span class="ttree__caret">{{ miscOpen[m.key] ? '▾' : '▸' }}</span>
                  </div>
                  <div v-if="miscOpen[m.key]" class="ttree__fruit-list">
                    <div v-for="(it, i) in m.items.slice(0, 40)" :key="i" class="ttree__fruit-item">{{ text(it) }}</div>
                  </div>
                </div>
              </div>
            </div>
            </div>

            <!-- 右栏：明细面板（固定宽、始终可见、独立滚动；不再被长树顶到最底） -->
            <aside class="ttree-side">
              <div v-if="sel" class="tree-detail">
                <div class="tree-detail__head">
                  <span class="chip chip--acc">{{ sel.title }}</span>
                  <span>{{ sel.items.length }} 条</span>
                  <button class="btn btn--ghost btn--sm tree-detail__close" @click="sel = null">关闭</button>
                </div>
                <div v-for="(it, i) in sel.items" :key="i" class="tree-detail__item">
                  <span v-if="it.turn_no != null" class="tree-detail__turn">#{{ it.turn_no }}</span>
                  <span v-if="it.kind" class="chip" :style="'--role:' + tk(it.kind).color">{{ tk(it.kind).label }}</span>
                  <span class="tree-detail__title">{{ it.title || '（无标题）' }}</span>
                </div>
              </div>
              <div v-else class="tree-detail-placeholder">点选树上的叶 / 果实簇查看明细</div>
            </aside>
          </div>
        </template>
      </template>
    </div>
  `,
});
