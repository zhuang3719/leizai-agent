// A1 前端 · 控制台（挂载 #settings-nav / #settings-form）——多根渲染
import { defineComponent, ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { bridge } from '../bridge.js';

export const SettingsNav = defineComponent({
  name: 'SettingsNav',
  setup() {
    const cur = ref('model');
    function pick(p) { cur.value = p; window.dispatchEvent(new CustomEvent('leizai-settings-pane', { detail: p })); }
    // Pro 升级引导（雷影·美工）：外部（顶栏徽章/气泡按钮）跳转时同步左侧子页高亮
    window.addEventListener('leizai-settings-pane', (e) => { cur.value = e.detail; });
    return { cur, pick };
  },
  template: `
    <div class="set-nav__label">设置</div>
    <button class="set-nav__item" :class="{ 'is-active': cur==='model' }" data-pane="model" @click="pick('model')"><span class="set-nav__ico">🧠</span>大模型配置<span class="set-nav__chev">›</span></button>
    <button class="set-nav__item" :class="{ 'is-active': cur==='perm' }" data-pane="perm" @click="pick('perm')"><span class="set-nav__ico">🔑</span>权限<span class="set-nav__chev">›</span></button>
    <button class="set-nav__item" :class="{ 'is-active': cur==='backend' }" data-pane="backend" @click="pick('backend')"><span class="set-nav__ico">🗄️</span>后端与数据<span class="set-nav__chev">›</span></button>
    <button class="set-nav__item" :class="{ 'is-active': cur==='agents' }" data-pane="agents" @click="pick('agents')"><span class="set-nav__ico">🧩</span>雷影通用<span class="set-nav__chev">›</span></button>
    <button class="set-nav__item" :class="{ 'is-active': cur==='pro' }" data-pane="pro" @click="pick('pro')"><span class="set-nav__ico">💎</span>Pro 激活<span class="set-nav__chev">›</span></button>
    <button class="set-nav__item" :class="{ 'is-active': cur==='about' }" data-pane="about" @click="pick('about')"><span class="set-nav__ico">ℹ️</span>关于<span class="set-nav__chev">›</span></button>
  `,
});

export const SettingsForm = defineComponent({
  name: 'SettingsForm',
  setup() {
    const cfg = ref({}); const balance = ref(null); const pane = ref('model');
    // 余额文本兜底：非 DeepSeek 提供商（isAvailable:false + error『余额仅 DeepSeek 提供方支持』）→ 明确提示，修 null null/空白；DeepSeek 正常与查询失败显示不变。
    const balanceText = computed(() => {
      const b = balance.value;
      if (!b) return '—';
      if (b.balance != null && b.currency) return b.balance + ' ' + b.currency;
      if (b.unsupported === true || (b.isAvailable === false && /余额仅 DeepSeek 提供方支持/.test(String(b.error || '')))) return '不支持余额';
      return '—';
    });
    // 数据目录（可选/明示/迁移）
    const pathsInfo = ref(null); const ddEdit = ref(false); const ddPath = ref(''); const ddMigrate = ref(true); const ddBusy = ref(false); const ddWarn = ref('');
    // B：当前版本号（由桌面壳注入 window.__LEIZAI_APP_VER__；浏览器态为空 → 显示 —）
    const appVer = ref((typeof window !== 'undefined' && window.__LEIZAI_APP_VER__) ? String(window.__LEIZAI_APP_VER__) : '');
    // 手动检查更新（桌面客户端）：经 bridge → shell UpdateNotice.CheckNow；有/无更新均由客户端弹窗反馈
    const checking = ref(false);
    function checkUpdate() {
      if (checking.value) return;
      if (!bridge.available) { toast('检查更新仅桌面客户端可用', 'err'); return; }
      checking.value = true;
      bridge.checkUpdate()
        .catch((e) => toast('检查更新失败：' + ((e && e.message) || e), 'err'))
        .finally(() => { checking.value = false; });
    }
    // P0-3：Pro 激活入口（输入激活码 → /api/pro/activate → 显示档位/结果）
    const proState = ref(null); const licInput = ref(''); const activating = ref(false);
    async function loadPro() { try { proState.value = await api.get('/api/pro/status'); } catch (e) { proState.value = { error: e.message }; } }
    async function doActivate() {
      const key = String(licInput.value || '').trim();
      if (!key) { toast('请输入激活码', 'err'); return; }
      activating.value = true;
      try {
        const r = await api.post('/api/pro/activate', { licenseKey: key });
        if (r && r.ok) { toast('激活成功 · 档位 ' + (r.tier || 'pro'), 'ok'); licInput.value = ''; }
        else { toast('激活失败：' + ((r && r.error) || 'unknown'), 'err'); }
      } catch (e) { toast('激活失败：' + e.message, 'err'); }
      finally { activating.value = false; await loadPro(); }
    }
    // P0-4（美工）：解绑本机（设备与换机）—— POST /api/pro/deactivate，成功后本机回 Lite 并刷新档位
    const deactivating = ref(false);
    async function doDeactivate() {
      if (deactivating.value) return;
      if (!confirm('解绑后本机将回到免费版（Lite），需在新设备重新激活该授权。确认解绑本机？')) return;
      deactivating.value = true;
      try {
        const r = await api.post('/api/pro/deactivate', {});
        if (r && r.ok === false) { toast('解绑失败：' + ((r && r.error) || 'unknown'), 'err'); return; }
        toast('已解绑，本机已回到 Lite', 'ok');
        await loadPro();
        if (window.__leizaiReloadTier) { try { window.__leizaiReloadTier(); } catch { } }
      } catch (e) {
        const code = (e && e.data && e.data.error) || (e && e.message) || 'unknown';
        toast('解绑失败：' + code, 'err');
      } finally { deactivating.value = false; }
    }
    // v1：行内保存状态——选择类（开关/下拉）即时保存后闪「已保存 ✓」；输入类改动后显「未保存」
    const dirty = ref(false);
    const savedTip = ref(false);
    let _tipTimer = null;
    function markDirty() { dirty.value = true; savedTip.value = false; }
    function markSaved() { dirty.value = false; savedTip.value = true; if (_tipTimer) clearTimeout(_tipTimer); _tipTimer = setTimeout(() => { savedTip.value = false; }, 1600); }
    const budgetInput = ref(null);   // 预算输入框（模板 ref，供显式「保存」按钮取值）
    window.addEventListener('leizai-settings-pane', (e) => { pane.value = e.detail; if (e.detail === 'model') loadUsage(); if (e.detail === 'pro') loadPro(); });
    // —— 控制台·提供商表单（最小集）：提供商切换 / API Key / 模型 ——
    //   安全约定：key 只进不出——输入框永不从 cfg 回填；读到的明文 apiKeys 只转成"是否已设置"布尔后立即从内存抹除。
    const providers = ref([]);
    const curProvider = ref('');
    const autoSwitchTip = ref(false);   // 切换提供商后自动校正模型时，提示说明
    const curBaseURL = ref('');
    const keyVal = ref('');            // 仅存"用户本次新输入"，保存后即清空
    const keyPresence = ref({});       // provider -> 是否已配置 key（布尔，非明文）
    // —— 高级设置（本次补充）：温度 / 工作目录 / Python 路径 ——
    let loadedAdvanced = false;
    const curTemp = ref(0.3);
    const curWorkdir = ref('');
    const curPythonPath = ref('');
    const provObj = (k) => (providers.value || []).find((x) => x.key === k) || null;
    // Xiaomi MiMo 固定排到第 2 位（紧跟 DeepSeek）——纯前端顺序，不改后端
    function orderProviders(list) {
      const i = list.findIndex((p) => p.key === 'mimo');
      if (i <= 1) return list;
      const out = list.slice();
      const [mimo] = out.splice(i, 1);
      out.splice(1, 0, mimo);
      return out;
    }
    const keyPlaceholder = computed(() => keyPresence.value[curProvider.value] ? '已设置（留空保持）' : '请输入 API Key');
    // 模型候选：仅当前提供商模型（去重、保序、非空）——随提供商切换自动刷新；
    //   仅 provider='custom'（自定义端点、无内置模型）才并入全局 config.models 作候选，
    //   其余 provider 绝不并入全局清单（修：切到谁家都混进 deepseek-flash）。
    const modelOptions = computed(() => {
      const key = curProvider.value;
      const o = provObj(key);
      const own = (o && o.models) || [];
      const list = (key === 'custom') ? [...own, ...((cfg.value.models) || [])] : own;
      return [...new Set(list.filter(Boolean))];
    });
    function saveModel() { const m = String(cfg.value.model || '').trim(); if (!m) return; cfg.value.model = m; markDirty(); }   // 不再即时保存；由「保存设置」统一提交
    // 模型组合框（可自由输入 + 下拉候选）：弹层 Teleport 到 body + fixed，避免被面板 overflow 裁剪
    const modelOpen = ref(false);
    const modelHi = ref(-1);
    const modelCombo = ref(null);
    const modelPopupStyle = ref({});
    function onWinScroll() { modelOpen.value = false; window.removeEventListener('scroll', onWinScroll, true); }
    function closeModel() { modelOpen.value = false; window.removeEventListener('scroll', onWinScroll, true); }
    function closeModelSoon() { setTimeout(closeModel, 140); }
    function openModel() {
      const el = modelCombo.value;
      if (el && el.getBoundingClientRect) {
        const r = el.getBoundingClientRect();
        modelPopupStyle.value = { position: 'fixed', left: r.left + 'px', top: (r.bottom + 4) + 'px', width: r.width + 'px' };
      }
      modelOpen.value = true; modelHi.value = -1;
      window.addEventListener('scroll', onWinScroll, true);
    }
    function toggleModel() { if (modelOpen.value) closeModel(); else openModel(); }
    function pickModel(m) { if (!m) return; cfg.value.model = m; saveModel(); closeModel(); }
    function onModelKey(e) {
      const list = modelOptions.value, n = list.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!modelOpen.value) openModel(); else modelHi.value = n ? (modelHi.value + 1) % n : -1; }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (modelOpen.value && n) modelHi.value = (modelHi.value - 1 + n) % n; }
      else if (e.key === 'Enter') { e.preventDefault(); if (modelOpen.value && modelHi.value >= 0 && n) pickModel(list[modelHi.value]); else { saveModel(); modelOpen.value = false; } }
      else if (e.key === 'Escape') { modelOpen.value = false; }
    }
    function extractKeyPresence() {
      const pres = {};
      try {
        const ak = cfg.value && cfg.value.apiKeys;
        if (ak && typeof ak === 'object') for (const k of Object.keys(ak)) pres[k] = !!ak[k];
        if (cfg.value && cfg.value.provider) pres[cfg.value.provider] = pres[cfg.value.provider] || !!cfg.value.apiKey;
      } catch { }
      // 关键：立即从内存中的 cfg 抹掉明文 apiKeys / 掩码 apiKey，避免被渲染或整份回传
      try { if (cfg.value) { delete cfg.value.apiKeys; delete cfg.value.apiKey; } } catch { }
      keyPresence.value = pres;
    }
    async function load() {
      try { cfg.value = await api.config(); extractKeyPresence(); } catch { }
      if (!curProvider.value) curProvider.value = cfg.value.provider || 'deepseek';
      try { balance.value = await api.balance(); } catch { }
      try { providers.value = orderProviders((await api.providers()) || []); } catch { }
      try { pathsInfo.value = await api.get('/api/paths'); if (pathsInfo.value) ddPath.value = pathsInfo.value.dataDir || ''; } catch { }
      if (!curBaseURL.value) curBaseURL.value = cfg.value.baseURL || ((provObj(curProvider.value) || {}).baseURL || '');
      if (!loadedAdvanced) {                                   // 首次载入才回填，避免覆盖用户正在编辑的值
        curTemp.value = (cfg.value.temperature !== undefined && cfg.value.temperature !== null) ? cfg.value.temperature : 0.3;
        curWorkdir.value = cfg.value.workdir || '';
        curPythonPath.value = cfg.value.pythonPath || '';
        loadedAdvanced = true;
      }
    }
    onMounted(load);
    // 引导页保存 Key 后，刷新配置相关状态（含 keyPresence →「首次配置建议」随之隐藏）
    window.__leizaiSettingsReload = load;
    // —— 数据目录：打开 / 更改 / 恢复默认 ——
    function openDataDir() {
      api.post('/api/paths/open', {}).then(() => toast('已在资源管理器打开数据目录', 'ok')).catch((e) => toast('打开失败: ' + e.message, 'err'));
    }
    function beginDataDirEdit() { ddPath.value = (pathsInfo.value && pathsInfo.value.dataDir) || ''; ddWarn.value = ''; ddEdit.value = true; }
    async function applyDataDir() {
      const dir = (ddPath.value || '').trim();
      if (!dir) { toast('请输入目录', 'err'); return; }
      ddBusy.value = true;
      try {
        const r = await api.post('/api/paths/set', { dir, migrate: ddMigrate.value });
        const cs = r && r.copyStat;
        if (cs && cs.failed > 0) {
          // 迁移有文件未复制：不静默，明确告知失败项（可能被占用）
          const names = (cs.failedList || []).map((x) => String(x).split(/[\\/]/).pop()).filter(Boolean);
          const tail = names.length ? ('（' + names.slice(0, 5).join('、') + (names.length > 5 ? ' 等' : '') + '）') : '';
          ddWarn.value = `⚠ 有 ${cs.failed} 个文件未复制${tail}，可能正被占用；建议关闭雷仔后重试该操作，或手动复制上述文件。`;
          toast(`已设置，但 ${cs.failed} 个文件未复制${tail}；重启雷仔后生效`, 'err');
        } else {
          ddWarn.value = '';
          toast(r && r.needRestart ? '已设置，重启雷仔后生效' : '已设置', 'ok');
        }
        ddEdit.value = false; ddPath.value = r.dataDir || dir;
        try { pathsInfo.value = await api.get('/api/paths'); } catch { }
      } catch (e) { toast('设置失败: ' + e.message, 'err'); }
      finally { ddBusy.value = false; }
    }
    async function resetDataDir() {
      try {
        await api.post('/api/paths/reset', {});
        toast('已恢复默认数据目录，重启雷仔后生效', 'ok');
        try { pathsInfo.value = await api.get('/api/paths'); } catch { }
      } catch (e) { toast('恢复失败: ' + e.message, 'err'); }
    }
    // 切换提供商：带出该 provider 的模型候选 + 默认 baseURL + 清空 Key 输入
    function onProviderChange() {
      const o = provObj(curProvider.value);
      const nextBase = (o && o.baseURL) || '';
      const ms = (o && o.models) || [];
      const prevModel = cfg.value.model;
      // 切换提供商后：若当前模型不在该提供商候选内且候选非空 → 自动校正为候选首项（同一个字段 config.model）。
      const nextModel = (ms.length && !ms.includes(prevModel)) ? ms[0] : prevModel;
      // ★修复：仅当相对"已存 config"存在**实质变更**才即时保存并提示；未改任何值（切回原值/候选等价）时静默，
      //   避免"每切一次提供商就弹一次保存提示"。
      const eq = (a, b) => String(a == null ? '' : a) === String(b == null ? '' : b);
      const changed = !eq(curProvider.value, cfg.value.provider)
        || !eq(nextModel, prevModel)
        || !eq(nextBase, cfg.value.baseURL)
        || !eq(curWorkdir.value, cfg.value.workdir)
        || !eq(curPythonPath.value, cfg.value.pythonPath)
        || !eq(Number(curTemp.value), cfg.value.temperature);
      // 应用 UI 状态（不涉及保存）——选择类不再即时保存，统一由「保存设置」提交
      curBaseURL.value = nextBase;
      if (nextModel !== prevModel) cfg.value.model = nextModel;
      autoSwitchTip.value = nextModel !== prevModel;
      keyVal.value = '';
      if (changed) markDirty();   // 有实质变更才标「未保存」；不再自动保存
    }
    // 保存：**只提交本表单字段**（不回传整份 cfg，避免带上掩码串/其它 provider 明文 key）
    async function saveProvider() {
      const key = String(keyVal.value || '').trim();
      const provKey = curProvider.value;
      // ★未配 Key 不得报「已保存」：未填新 Key 且该 provider 无已存 Key → 拒绝保存并明确提示
      if (!key && !keyPresence.value[provKey]) {
        toast('该提供商未配置 API Key，请填写后再保存', 'err');
        return;
      }
      const patch = { provider: provKey, model: cfg.value.model, baseURL: curBaseURL.value,
        reasoningEffort: cfg.value.reasoningEffort,
        workdir: String(curWorkdir.value || ''), pythonPath: String(curPythonPath.value || '') };
      // 温度必须为 number（后端 typeof==='number' 校验，字符串会被拒）；非法/NaN 则不提交该字段
      const t = Number(curTemp.value);
      if (Number.isFinite(t) && t >= 0 && t <= 2) patch.temperature = t; else toast('温度需为 0~2 的数字，已跳过', 'info');
      if (key && !key.includes('*')) patch.apiKeys = { [provKey]: key };   // 仅"新填"才提交
      try {
        const r = await api.saveConfig(patch);
        Object.assign(cfg.value, { provider: patch.provider, model: patch.model, baseURL: patch.baseURL,
          workdir: patch.workdir, pythonPath: patch.pythonPath });
        if (patch.temperature !== undefined) cfg.value.temperature = patch.temperature;
        if (patch.apiKeys) keyPresence.value[provKey] = true;
        keyVal.value = '';                                   // 清掉明文
        toast('已保存', 'ok');
        markSaved();
        if (r && r.restartRequired) toast('需重启后端生效', 'info');
        await load();
      } catch (e) { toast('保存失败: ' + e.message, 'err'); }
    }
    async function save(patch) {
      try {
        await api.saveConfig(Object.assign({}, cfg.value, patch)); Object.assign(cfg.value, patch);
        if (patch && patch.contextBudget != null) store.defaultBudget = Number(patch.contextBudget) || 0;   // v1：改全局默认后顶栏「预算」即时跟随
        markSaved();
        toast('已保存', 'ok');
        // 改全局配置后，刷新输入框旁 scope 选择器的 _cfg 缓存（"跟随全局"值/候选列表同步更新）
        if (window.__leizaiScopeReload) { try { await window.__leizaiScopeReload(); } catch { } }
      }
      catch (e) { toast('保存失败: ' + e.message, 'err'); }
    }
    // 会话预算（全局默认）上限校验：与 feed.js 的 BUDGET_MAX 同值
    const BUDGET_MAX = 900000;
    async function saveBudget(v) {
      const val = +v;
      if (!Number.isFinite(val) || val < 1000) { toast('预算需为 ≥1000 的数字', 'err'); resetBudgetInput(); return; }
      if (val > BUDGET_MAX) { toast('预算不能超过 900000（模型上限约 1M，留安全余量）', 'err'); resetBudgetInput(); return; }
      await save({ contextBudget: val });
    }
    function resetBudgetInput() { const cur = cfg.value.contextBudget; const el = document.getElementById('cfg-budget-input'); if (el) el.value = (cur != null ? cur : ''); }
    function showOnboarding() { try { window.__leizaiShowOnboarding && window.__leizaiShowOnboarding(); } catch { } }
    // v1：完全访问权限（危险项）——二次确认
    function toggleFullAccess() {
      const next = !cfg.value.fullAccess;
      const msg = next
        ? '开启「完全访问权限」后，雷仔可读写本机任意路径、执行任意命令。确认开启？'
        : '关闭「完全访问权限」后，雷仔将无法读写本机任意路径。确认关闭？';
      if (!confirm(msg)) return;
      save({ fullAccess: next });
    }
    async function restartBackend() {
      if (!confirm('重启后端会中断所有正在进行的会话（约数秒）。确认重启？')) return;
      try { await api.post('/api/shutdown'); toast('后端已请求重启', 'info'); } catch (e) { toast(e.message, 'err'); }
    }
    // —— 归档容量：当前最大会话占用 + 防误删确认保存 ——
    const usageMax = ref(null);
    const capInput = ref(null);
    async function loadUsage() {
      try { const r = await api.archiveUsage(); usageMax.value = (r && r.maxMB != null) ? r.maxMB : null; }
      catch { usageMax.value = null; }
    }
    onMounted(loadUsage);
    async function saveArchiveCap(v) {
      const val = +v;
      try {
        await api.saveConfig(Object.assign({}, cfg.value, { archiveMaxSizeMB: val }));
        Object.assign(cfg.value, { archiveMaxSizeMB: val }); toast('已保存', 'ok'); loadUsage();
      } catch (e) {
        if (e.status === 409 && e.data && e.data.needConfirm) {
          const mb = e.data.maxSessionMB;
          if (!confirm(`此上限将立即清理超出部分数据（当前最大会话约 ${mb} MB）。继续保存？`)) { const cur = cfg.value.archiveMaxSizeMB; if (capInput.value) capInput.value.value = (cur != null ? cur : ''); return; }
          try {
            await api.saveConfig(Object.assign({}, cfg.value, { archiveMaxSizeMB: val, confirmArchivePrune: true }));
            Object.assign(cfg.value, { archiveMaxSizeMB: val }); toast('已保存（已确认清理）', 'ok'); loadUsage();
          } catch (e2) { toast('保存失败: ' + e2.message, 'err'); }
        } else toast('保存失败: ' + e.message, 'err');
      }
    }
    // —— 雷影通用设置（一处改 → 写所有雷影 common/instance config）——
    const ragents = ref([]); const raProviders = ref([]); const raBusy = ref(false); const raResults = ref(null); const rmainDefault = ref(null);
    const ra = ref({ provider: '', model: '', apiKey: '', reasoningEffort: '', contextBudget: '', reflectionEnabled: '', evolutionAutoApply: '' });
    const raModelOptions = computed(() => { const key = ra.value.provider || (rmainDefault.value && rmainDefault.value.provider) || ''; const o = (raProviders.value || []).find((x) => x.key === key); return (o && o.models) || []; });
    async function loadAgentsCommon() {
      try {
        const r = await api.agentsCommonConfig();
        ragents.value = (r && r.agents) || [];
        raProviders.value = (r && r.providers) || [];
        rmainDefault.value = (r && r.mainDefault) || null;
        const f = ragents.value[0];
        if (f && f.common) {
          ra.value.provider = f.common.provider || '';
          ra.value.model = f.common.model || '';
          ra.value.reasoningEffort = f.common.reasoningEffort || '';
          ra.value.reflectionEnabled = (f.common.reflectionEnabled === undefined) ? '' : String(!!f.common.reflectionEnabled);
          ra.value.evolutionAutoApply = (f.common.evolutionAutoApply === undefined) ? '' : String(!!f.common.evolutionAutoApply);
        }
        ra.value.contextBudget = (f && f.instance && f.instance.contextBudget != null) ? f.instance.contextBudget : '';
        ra.value.apiKey = '';
      } catch (e) { toast('读取雷影通用配置失败：' + e.message, 'err'); }
    }
    async function saveAgentsCommon() {
      const n = ragents.value.length;
      if (!n) { toast('未发现雷影实例', 'err'); return; }
      const names = ragents.value.map((a) => a.name || a.role).join('、');
      if (!confirm(`即将把设置写入全部 ${n} 个雷影：\n${names}\n\n影响：这些雷影自下一回合起使用新配置（API Key 仅在你实际填入新值时写入，留空=保持）。确定继续？`)) return;
      raBusy.value = true; raResults.value = null;
      try {
        const patch = {}; const unset = [];
        if (ra.value.provider) patch.provider = ra.value.provider; else unset.push('provider');
        if (ra.value.model) patch.model = ra.value.model; else unset.push('model');
        if (ra.value.reasoningEffort) patch.reasoningEffort = ra.value.reasoningEffort; else unset.push('reasoningEffort');
        if (ra.value.reflectionEnabled === 'true' || ra.value.reflectionEnabled === 'false') patch.reflectionEnabled = ra.value.reflectionEnabled === 'true'; else unset.push('reflectionEnabled');
        if (ra.value.evolutionAutoApply === 'true' || ra.value.evolutionAutoApply === 'false') patch.evolutionAutoApply = ra.value.evolutionAutoApply === 'true'; else unset.push('evolutionAutoApply');
        if (ra.value.apiKey && String(ra.value.apiKey).trim()) patch.apiKey = String(ra.value.apiKey).trim(); else unset.push('apiKey');
        const body = { patch };
        if (unset.length) body.unset = unset;
        if (ra.value.contextBudget !== '' && ra.value.contextBudget != null) body.contextBudget = +ra.value.contextBudget; else body.unset = (body.unset || []).concat('contextBudget');
        const r = await api.saveAgentsCommonConfig(body);
        raResults.value = (r && r.results) || [];
        if (r && r.ok) toast(`已写入 ${r.okCount}/${r.total} 个雷影`, 'ok');
        else toast('保存失败：' + ((r && r.error) || '未知错误'), 'err');
        ra.value.apiKey = '';
      } catch (e) { toast('保存失败：' + e.message, 'err'); }
      finally { raBusy.value = false; }
    }
    onMounted(loadAgentsCommon);
    return { cfg, balance, balanceText, pane, save, saveBudget, showOnboarding, saveArchiveCap, usageMax, capInput, restartBackend, toggleFullAccess, dirty, savedTip, markDirty, budgetInput, store, load, proState, licInput, activating, doActivate, deactivating, doDeactivate, loadPro,
             pathsInfo, ddEdit, ddPath, ddMigrate, ddBusy, ddWarn, openDataDir, beginDataDirEdit, applyDataDir, resetDataDir,
             providers, curProvider, autoSwitchTip, curBaseURL, keyVal, keyPresence, keyPlaceholder, modelOptions, saveModel, modelOpen, modelHi, modelCombo, modelPopupStyle, openModel, closeModelSoon, toggleModel, pickModel, onModelKey,
             curTemp, curWorkdir, curPythonPath, appVer, checking, checkUpdate,
             onProviderChange, saveProvider,
             ragents, raProviders, ra, raBusy, raResults, rmainDefault, raModelOptions, loadAgentsCommon, saveAgentsCommon };
  },
  template: `
    <div class="set-lead" v-if="!keyPresence[curProvider]">
      <span class="icon icon--sm" style="--i:url(/assets/ui-list.svg)"></span>
      <span>首次配置建议：在「大模型配置」里先用「连接凭据」填 <b>API Key</b>、再选<b>模型</b>。所有改动点「保存设置」后统一生效。</span>
    </div>
    <template v-if="pane==='model'">
      <section class="set-card">
        <div class="set-card__head">
          <span class="set-card__icon">🔌</span>
          <div class="set-card__titles"><span class="set-card__title">连接凭据</span><span class="set-card__desc">用哪个服务、配哪把钥匙</span></div>
          <span class="save-state is-ok" v-if="savedTip">已保存 ✓</span>
        </div>
        <div class="set-card__body">
        
          <div class="form-row"><div class="form-row__label">提供商</div>
            <div><select class="select" v-model="curProvider" @change="onProviderChange">
              <option v-for="p in providers" :key="p.key" :value="p.key">{{ p.label }}</option>
            </select>
            <div class="form-row__hint">切换提供商会重置接口地址与模型候选，且不回显已保存的 Key。</div>
            <div class="form-row__hint is-ok" v-if="autoSwitchTip">已按新提供商自动切换模型为「{{ cfg.model }}」，可在下方「模型」处查看或更改。</div></div></div>
          <div class="form-row"><div class="form-row__label">API Key</div>
            <div><input class="input" type="password" autocomplete="new-password" v-model="keyVal" :placeholder="keyPlaceholder" @input="markDirty">
              <div class="form-row__hint">留空 = 保持已保存的 Key；Key 只提交、永不回显。</div>
              <div class="form-row__hint is-err" v-if="!keyPresence[curProvider]">该提供商未配置 API Key，请填写后再保存。</div></div></div>
          <div class="form-row"><div class="form-row__label">接口地址</div>
            <div><input class="input mono" v-model="curBaseURL" placeholder="https://..." @input="markDirty">
              <div class="form-row__hint">调用该服务的接口地址，切换提供商会自动带出默认值。</div></div></div>
      
        </div>
      </section>
      <section class="set-card">
        <div class="set-card__head">
          <span class="set-card__icon">🧠</span>
          <div class="set-card__titles"><span class="set-card__title">模型与推理</span><span class="set-card__desc">决定用哪个模型、思考多深</span></div>
          <span class="save-state is-ok" v-if="savedTip">已保存 ✓</span>
        </div>
        <div class="set-card__body">
        
          <div class="form-row"><div class="form-row__label">模型</div>
            <div><div class="combo" ref="modelCombo">
                <input class="input combo__input" type="text" v-model="cfg.model" placeholder="选择或输入型号名"
                  @focus="openModel" @click="openModel" @input="modelHi = -1" @change="saveModel" @keydown="onModelKey" @blur="closeModelSoon">
                <button type="button" class="combo__btn" tabindex="-1" aria-label="展开候选" @mousedown.prevent @click="toggleModel">▾</button>
              </div>
              <div class="form-row__hint">当前使用的模型；候选随所选提供商变化，也可直接输入型号名。</div>
              <div class="form-row__hint is-err" v-if="!modelOptions.length">该提供商未内置模型，可直接输入型号名。</div>
              <Teleport to="body">
                <div v-if="modelOpen" class="combo-pop" :style="modelPopupStyle" @mousedown.prevent>
                  <div v-if="!modelOptions.length" class="combo-pop__empty">该提供商未内置模型，可直接输入型号名</div>
                  <div v-for="(m, i) in modelOptions" :key="m" class="combo-pop__item" :class="{ 'is-hi': i === modelHi }" @click="pickModel(m)">{{ m }}</div>
                </div>
              </Teleport>
            </div></div>
          <div class="form-row"><div class="form-row__label">推理级别</div>
            <div><select class="select" v-model="cfg.reasoningEffort" @change="markDirty">
              <option value="low">低（推荐 · 快且省）</option><option value="medium">中</option><option value="high">高</option><option value="max">最高</option></select>
              <div class="form-row__hint">越高越聪明、但更贵更慢。<span class="badge-reco">推荐：低</span></div></div></div>
      
        </div>
      </section>
      <section class="set-card">
        <div class="set-card__head">
          <span class="set-card__icon">🎛️</span>
          <div class="set-card__titles"><span class="set-card__title">生成参数</span><span class="set-card__desc">调用模型的方式</span></div>
        </div>
        <div class="set-card__body">
        
          <div class="form-row"><div class="form-row__label">温度</div>
            <div><input class="input" type="number" step="0.1" min="0" max="2" v-model="curTemp" @input="markDirty">
              <div class="form-row__hint">越低越稳、越高越发散。<span class="badge-reco">推荐：0.3 · 0~2</span></div></div></div>
      
        </div>
      </section>
      <section class="set-card">
        <div class="set-card__head">
          <span class="set-card__icon">📊</span>
          <div class="set-card__titles"><span class="set-card__title">预算</span><span class="set-card__desc">新建会话的默认上下文额度</span></div>
        </div>
        <div class="set-card__body">
        
          <div class="form-row"><div class="form-row__label">全局默认预算</div>
            <div><input ref="budgetInput" id="cfg-budget-input" class="input" type="number" min="1000" max="900000" :value="cfg.contextBudget" @input="markDirty" @keyup.enter="saveBudget(budgetInput && budgetInput.value)">
              <button class="btn btn--sm btn--primary" style="margin-left:8px;" @click="saveBudget(budgetInput && budgetInput.value)">保存</button>
              <span class="save-state" :class="dirty ? 'is-dirty' : (savedTip ? 'is-ok' : '')">{{ dirty ? '未保存' : (savedTip ? '已保存 ✓' : '') }}</span>
              <div class="form-row__hint">新建会话的默认额度（≤900000，约 90W）。<span class="badge-reco">推荐：10W（省）~ 20W（默认）；长链可到 50W+</span>；单个会话可另行覆盖。</div></div></div>
      
        </div>
      </section>
      <section class="set-card">
        <div class="set-card__head">
          <span class="set-card__icon">⚙️</span>
          <div class="set-card__titles"><span class="set-card__title">运行环境</span><span class="set-card__desc">文件与代码工具落在哪里</span></div>
        </div>
        <div class="set-card__body">
        
          <div class="form-row"><div class="form-row__label">工作目录</div>
            <div><input class="input mono" v-model="curWorkdir" placeholder="文件工具写入目录" @input="markDirty">
              <div class="form-row__hint">文件工具的读写根目录，例如 D:\myproj。</div></div></div>
          <div class="form-row"><div class="form-row__label">Python 路径</div>
            <div><input class="input mono" v-model="curPythonPath" placeholder="python" @input="markDirty">
              <div class="form-row__hint">代码内核所用的 Python，例如 python 或完整路径。</div></div></div>
      
        </div>
      </section>
      <section class="set-card">
        <div class="set-card__head">
          <span class="set-card__icon">💰</span>
          <div class="set-card__titles"><span class="set-card__title">余额</span><span class="set-card__desc">账户可用额度</span></div>
        </div>
        <div class="set-card__body">
        
          <div class="form-row"><div class="form-row__label">余额</div>
            <div><span class="mono console-balance" :class="balance && balance.balance!=null ? (Number(balance.balance)<5?'is-critical':(Number(balance.balance)<20?'is-low':'is-acc')) : 'is-acc'" style="font-size:18px;">{{ balanceText }}</span>
              <button class="btn btn--sm" style="margin-left:8px;" @click="load">刷新余额</button>
              <div class="form-row__hint">账户可用余额（取不到时显示 —，多为未配置或接口不支持）。</div></div></div>
      
        </div>
      </section>
      <div class="set-actionbar">
        <span class="set-actionbar__hint">改动后需保存生效 · 点【保存设置】提交（选择类不再即时保存）</span>
        <span class="set-actionbar__spacer"></span>
        <span class="save-state" :class="dirty ? 'is-dirty' : (savedTip ? 'is-ok' : '')">{{ dirty ? '未保存' : (savedTip ? '已保存 ✓' : '') }}</span>
        <button class="btn btn--sm btn--primary" @click="saveProvider">保存设置</button>
      </div>
    </template>
    <template v-else-if="pane==='perm'">
      <section class="set-card">
        <div class="set-card__head">
          <span class="set-card__icon">🔧</span>
          <div class="set-card__titles"><span class="set-card__title">能力开关</span><span class="set-card__desc">点选即生效</span></div>
          <span class="save-state is-ok" v-if="savedTip">已保存 ✓</span>
        </div>
        <div class="set-card__body">
        
          <div class="form-row"><div class="form-row__label">自动应用进化</div>
            <div><span class="switch" :class="{ 'is-on': cfg.evolutionAutoApply }" @click="save({ evolutionAutoApply: !cfg.evolutionAutoApply })"></span>
              <div class="form-row__hint">开启后，雷仔提出的进化提案将自动批准生效（可回滚）。<em class="dim">内部键 evolutionAutoApply</em></div></div></div>
          <div class="form-row"><div class="form-row__label">开启自我反思</div>
            <div><span class="switch" :class="{ 'is-on': cfg.reflectionEnabled }" @click="save({ reflectionEnabled: !cfg.reflectionEnabled })"></span>
              <div class="form-row__hint">任务结束后自动沉淀记忆与技能。<em class="dim">内部键 reflectionEnabled</em></div></div></div>
      
        </div>
      </section>
      <section class="set-card set-card--danger">
        <div class="set-card__head">
          <span class="set-card__icon">⚠️</span>
          <div class="set-card__titles"><span class="set-card__title">完全访问权限（危险）</span></div>
        </div>
        <div class="set-card__body">
        
          <div class="form-row"><div class="form-row__label">完全访问权限</div>
            <div><span class="switch is-danger" :class="{ 'is-on': cfg.fullAccess }" @click="toggleFullAccess"></span>
              <div class="form-row__hint is-err">开启后可读写任意路径、执行任意命令；切换前会二次确认。<em class="dim">内部键 fullAccess</em></div></div></div>
      
        </div>
      </section>
    </template>
    <template v-else-if="pane==='agents'">
      <section class="set-card">
        <div class="set-card__head">
          <span class="set-card__icon">🧩</span>
          <div class="set-card__titles"><span class="set-card__title">雷影通用设置</span><span class="set-card__desc">一处改 → 写入全部雷影；留空 = 跟随主引擎</span></div>
        </div>
        <div class="set-card__body">
          <div class="form-row"><div class="form-row__label">影响范围</div>
            <div><span class="form-row__hint" style="display:inline;">将写入以下 {{ ragents.length }} 个雷影：</span>
              <span class="mono">{{ ragents.map(a => a.name || a.role).join('、') || '（未发现）' }}</span>
              <div class="form-row__hint is-err">留空 = 该雷影跟随主引擎（删除其自身设置）；填写 = 覆盖为下面所填值。</div></div></div>
          <div class="form-row"><div class="form-row__label">提供商</div>
            <div><select class="select" v-model="ra.provider">
              <option value="">未设置（跟随主引擎{{ rmainDefault && rmainDefault.provider ? ('：'+rmainDefault.provider) : '' }}）</option>
              <option v-for="p in raProviders" :key="p.key" :value="p.key">{{ p.label }}</option>
            </select></div></div>
          <div class="form-row"><div class="form-row__label">模型</div>
            <div><select class="select" v-model="ra.model">
              <option value="">未设置（跟随主引擎{{ rmainDefault && rmainDefault.model ? ('：'+rmainDefault.model) : '' }}）</option>
              <option v-for="m in raModelOptions" :key="m" :value="m">{{ m }}</option>
              <option v-if="ra.model && raModelOptions.indexOf(ra.model) < 0" :value="ra.model">{{ ra.model }}（当前值）</option>
            </select>
            <div class="form-row__hint">候选随所选提供商变化，可反复切换。</div></div></div>
          <div class="form-row"><div class="form-row__label">API Key</div>
            <div><input class="input" type="password" autocomplete="new-password" v-model="ra.apiKey" placeholder="未设置（跟随主引擎）">
              <div class="form-row__hint">留空 = 各雷影跟随主引擎 Key；填写 = 覆盖全部雷影（掩码不回写）。</div></div></div>
          <div class="form-row"><div class="form-row__label">推理级别</div>
            <div><select class="select" v-model="ra.reasoningEffort">
              <option value="">未设置（跟随主引擎{{ rmainDefault && rmainDefault.reasoningEffort ? ('：'+rmainDefault.reasoningEffort) : '' }}）</option>
              <option value="off">关</option><option value="low">低（推荐）</option><option value="medium">中</option><option value="high">高</option><option value="max">最高</option></select></div></div>
          <div class="form-row"><div class="form-row__label">上下文预算</div>
            <div><input class="input" type="number" v-model="ra.contextBudget" :placeholder="'未设置（跟随主引擎'+(rmainDefault && rmainDefault.contextBudget != null ? ('：'+rmainDefault.contextBudget) : '')+'）'">
              <div class="form-row__hint">实例级：写入各雷影 config.json（非 common），范围 1000~900000。</div></div></div>
          <div class="form-row"><div class="form-row__label">自我反思</div>
            <div><select class="select" v-model="ra.reflectionEnabled">
              <option value="">未设置（跟随主引擎{{ rmainDefault && rmainDefault.reflectionEnabled != null ? ('：'+(rmainDefault.reflectionEnabled ? '开' : '关')) : '' }}）</option>
              <option value="true">开启</option><option value="false">关闭</option></select></div></div>
          <div class="form-row"><div class="form-row__label">自动应用进化</div>
            <div><select class="select" v-model="ra.evolutionAutoApply">
              <option value="">未设置（跟随主引擎{{ rmainDefault && rmainDefault.evolutionAutoApply != null ? ('：'+(rmainDefault.evolutionAutoApply ? '开' : '关')) : '' }}）</option>
              <option value="true">开启</option><option value="false">关闭</option></select></div></div>
          <div class="form-row"><div class="form-row__label"></div>
            <div><button class="btn btn--sm btn--primary" :disabled="raBusy" @click="saveAgentsCommon">{{ raBusy ? '保存中…' : '保存到全部雷影' }}</button>
              <div class="form-row__hint">保存前会二次确认；保存后逐条列出结果。</div></div></div>
          <div v-if="raResults && raResults.length" class="form-row"><div class="form-row__label">结果</div>
            <div><div v-for="r in raResults" :key="r.role" class="mono">— {{ r.name || r.role }}：{{ r.ok ? '✅ 已写入' : ('❌ ' + (r.error || '失败')) }}</div></div></div>
        </div>
      </section>
    </template>
    <template v-else-if="pane==='backend'">
      <section class="set-card">
        <div class="set-card__head">
          <span class="set-card__icon">🗄️</span>
          <div class="set-card__titles"><span class="set-card__title">数据目录</span><span class="set-card__desc">可变数据（配置/记忆/技能/工作区）存放位置</span></div>
        </div>
        <div class="set-card__body">
        
          <div class="form-row"><div class="form-row__label">当前数据目录</div>
            <div><span class="mono">{{ (pathsInfo && pathsInfo.dataDir) || (cfg.dataDir || '—') }}</span>
              <button class="btn btn--sm" style="margin-left:8px;" @click="openDataDir">打开目录</button>
              <button class="btn btn--sm" style="margin-left:6px;" v-if="!ddEdit" @click="beginDataDirEdit">更改…</button>
              <button class="btn btn--sm btn--ghost" style="margin-left:6px;" v-if="pathsInfo && pathsInfo.source==='pointer'" @click="resetDataDir">恢复默认</button>
              <div class="form-row__hint">来源：{{ pathsInfo ? pathsInfo.source : '—' }}（env / portable / pointer / default）；重装程序不影响此目录。</div>
              <div class="form-row__hint is-err" v-if="ddWarn">{{ ddWarn }}</div></div></div>
          <div class="form-row" v-if="ddEdit"><div class="form-row__label">新目录</div>
            <div><input class="input" v-model="ddPath" placeholder="如 D:\LeiZaiData" />
              <label style="margin-left:8px;white-space:nowrap;"><input type="checkbox" v-model="ddMigrate" /> 迁移现有数据</label>
              <button class="btn btn--sm btn--primary" style="margin-left:8px;" :disabled="ddBusy" @click="applyDataDir">{{ ddBusy ? '处理中…' : '确定' }}</button>
              <button class="btn btn--sm btn--ghost" style="margin-left:6px;" @click="ddEdit=false">取消</button>
              <div class="form-row__hint">更改后需<b>重启雷仔</b>生效；勾选"迁移"会把现有数据复制到新目录（原目录保留）。</div></div></div>
      
        </div>

      </section>
      <section class="set-card set-card--danger">
        <div class="set-card__head">
          <span class="set-card__icon">🛡️</span>
          <div class="set-card__titles"><span class="set-card__title">后端守护（危险）</span></div>
        </div>
        <div class="set-card__body">
        
          <div class="form-row"><div class="form-row__label">运行状态</div>
            <div><span class="dot" :class="store.health && store.health.ok ? 'dot-online' : 'dot-error'"></span>
              <span class="mono">PID {{ store.daemon ? store.daemon.pid : '—' }} · :{{ cfg.port || 3458 }}</span>
              <button class="btn btn--sm btn--danger" style="margin-left:8px;" @click="restartBackend">重启后端</button>
              <div class="form-row__hint is-err">重启会中断所有正在进行的会话（约数秒），点击后需二次确认。</div></div></div>
      
        </div>
      </section>
      <section class="set-card set-card--danger">
        <div class="set-card__head">
          <span class="set-card__icon">🗃️</span>
          <div class="set-card__titles"><span class="set-card__title">数据归档（危险）</span><span class="set-card__desc">超限会清理旧数据</span></div>
        </div>
        <div class="set-card__body">
        
          <div class="form-row"><div class="form-row__label">归档容量上限（单会话）</div>
            <div><input ref="capInput" class="input" type="number" placeholder="2048" :value="cfg.archiveMaxSizeMB" @input="markDirty" @keyup.enter="saveArchiveCap(capInput && capInput.value)">
              <button class="btn btn--sm btn--primary" style="margin-left:8px;" @click="saveArchiveCap(capInput && capInput.value)">保存</button>
              <span class="save-state" :class="dirty ? 'is-dirty' : (savedTip ? 'is-ok' : '')">{{ dirty ? '未保存' : (savedTip ? '已保存 ✓' : '') }}</span>
              <span class="form-row__hint" style="margin-left:6px;">MB</span>
              <div class="form-row__hint">每会话上限（如 2048 = 2GB）；超过后从该会话最旧流水开始清理；0 = 不限制。</div>
              <div class="form-row__hint" v-if="usageMax != null">当前最大会话占用约 {{ usageMax }} MB</div>
              <div class="form-row__hint is-err" v-if="+cfg.archiveMaxSizeMB > 0 && +cfg.archiveMaxSizeMB < 50">⚠ 低于 50MB 不会生效（安全下限），如 1 也不会清理。</div>
              <div class="form-row__hint is-err">调低并保存会立即清理超出的旧数据，需二次确认。</div></div></div>
      
        </div>
      </section>
    </template>
    <template v-else-if="pane==='pro'">
      <section class="set-card">
        <div class="set-card__head">
          <span class="set-card__icon">💎</span>
          <div class="set-card__titles"><span class="set-card__title">Pro 激活</span><span class="set-card__desc">输入激活码解锁 Pro 能力</span></div>
        </div>
        <div class="set-card__body">
        
          <div class="form-row"><div class="form-row__label">当前档位</div>
            <div>
              <span class="mono">{{ proState ? (proState.gate && proState.gate.tier || proState.tier || '—') : '读取中…' }}</span>
              <span class="form-row__hint" style="display:inline;margin-left:8px;" v-if="proState && proState.gate && proState.gate.reason">{{ proState.gate.reason }}</span>
              <div class="form-row__hint" v-if="proState && proState.exp">到期：{{ new Date(proState.exp).toLocaleString() }}</div>
              <div class="form-row__hint" v-if="proState && proState.activated">已激活 · {{ proState.lic || '' }}</div>
              <div class="form-row__hint is-err" v-if="proState && proState.error">{{ proState.error }}</div>
              <div class="form-row__hint" v-if="proState && proState.maxRoles !== undefined && proState.maxRoles !== null">雷影：已用 {{ proState.activeRoles || 0 }} / 上限 {{ proState.maxRoles < 0 ? '不限' : proState.maxRoles }}</div>
            </div></div>
          <div class="form-row"><div class="form-row__label">激活码</div>
            <div>
              <input class="input" v-model="licInput" placeholder="粘贴激活码（如 XXXX-XXXX-…）" @keyup.enter="doActivate" />
              <button class="btn btn--sm" style="margin-left:8px;" :disabled="activating" @click="doActivate">{{ activating ? '激活中…' : '激活' }}</button>
              <div class="form-row__hint">激活后按 Pro 档运行；Lite 档：有限记忆/技能、无自我进化、限多角色。</div>
            </div></div>
          <div class="form-row"><div class="form-row__label"></div>
            <div><button class="btn btn--ghost btn--sm" @click="loadPro">刷新状态</button></div></div>
      
        </div>
      </section>
      <section class="set-card">
        <div class="set-card__head">
          <span class="set-card__icon">🔄</span>
          <div class="set-card__titles"><span class="set-card__title">设备与换机</span><span class="set-card__desc">换机前请先在旧设备解绑</span></div>
        </div>
        <div class="set-card__body">
          <div class="form-row"><div class="form-row__label">本机授权</div>
            <div>
              <button class="btn btn--sm" :disabled="deactivating" @click="doDeactivate">{{ deactivating ? '解绑中…' : '解绑本机' }}</button>
              <div class="form-row__hint">解绑后本机回到免费版（Lite），可在新设备重新激活该授权。</div>
            </div></div>
        </div>
      </section>
    </template>
    <template v-else>
      <section class="set-card">
        <div class="set-card__head">
          <span class="set-card__icon">💡</span>
          <div class="set-card__titles"><span class="set-card__title">首次配置建议</span></div>
        </div>
        <div class="set-card__body">
        
          <div class="form-row"><div class="form-row__label">推荐顺序</div>
            <div><span class="form-row__hint" style="display:inline;">提供商 → API Key → 模型</span>
              <button class="btn btn--sm" style="margin-left:8px;" @click="showOnboarding">查看引导</button>
              <div class="form-row__hint">首次使用可从「查看引导」获得分步说明。</div></div></div>
      
        </div>
      </section>
      <section class="set-card">
        <div class="set-card__head">
          <span class="set-card__icon">ℹ️</span>
          <div class="set-card__titles"><span class="set-card__title">关于</span></div>
        </div>
        <div class="set-card__body">
        
          <div class="form-row"><div class="form-row__label">版本</div><div>{{ appVer ? ('v' + appVer) : '—' }}</div></div>
          <div class="form-row"><div class="form-row__label">更新</div><div><button class="btn btn--sm" @click="checkUpdate" :disabled="checking">{{ checking ? '检查中…' : '检查更新' }}</button><span class="form-row__hint" style="margin-left:10px;">由客户端检查，有更新会弹提示。</span></div></div>
          <div class="form-row"><div class="form-row__label">数据目录</div><div class="mono">{{ cfg.dataDir || '—' }}</div></div>
          <div class="form-row"><div class="form-row__label">工作目录</div><div class="mono">{{ cfg.workdir || '—' }}</div></div>
      
        </div>
      </section>
    </template>
  `,
});
