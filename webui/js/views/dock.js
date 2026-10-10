// A1 前端 · 雷影舱（挂载 #agent-wall / #mail-timeline / #dispatch-panel）——多根渲染
import { defineComponent, computed, ref, reactive, onMounted } from 'vue';
import { api } from '../api.js';
import { store, toast, roleBusy } from '../store.js';
import { roleMeta, ROLE_META, roleName, setRoleNames, customColor, hhmm, roleVar } from '../roles.js';
import { Timeline } from '../components/timeline.js';

// 显示名统一为「雷影·X」（前端注册表为准）；注册表无此角色 → 回退后端名/role
function roleLabel(r) { return roleName(r.role, r.name); }

// 雷影卡片墙（挂载 #agent-wall；host 已是 .card-grid）
export const AgentWall = defineComponent({
  name: 'AgentWall',
  setup() {
    const selected = ref(null);
    async function load() {
      try { const s = await api.mailboxSummary(); store.mailbox = { roles: s.roles || [], totalUnread: s.totalUnread || 0 }; setRoleNames(s.roles); }
      catch { }
    }
    onMounted(load);
    window.__leizaiReloadAgents = load;
    function pick(r) {
      selected.value = r.role;
      window.dispatchEvent(new CustomEvent('leizai-mail-role', { detail: r.role }));
      window.__leizaiLoadMail && window.__leizaiLoadMail(r.role);
    }
    const roles = computed(() => store.mailbox.roles || []);
    // Pro 到期 → 雷影卡片「已停用」第五态（数据源：store.pro.proExpired，由 app.js initVitalTier 写入，单一权威）
    const proPaused = computed(() => !!(store.pro && store.pro.proExpired));
    const cardPaused = (r) => proPaused.value && !r.isMain;   // 主我不显示「已停用」
    function openPro() { try { if (window.__leizaiOpenPro) window.__leizaiOpenPro(); } catch { } }
    function meta(r) { return roleMeta(r.role); }
    // AI 专属图标（未知角色）：mask 渲染无法触发 onerror → 用隐藏 <img> 探针；失败则该角色回退通用图标
    const iconFallback = reactive({});                                                   // role -> true（已降级）
    function iconSrc(r) { return iconFallback[r.role] ? '/assets/role-generic.svg' : meta(r).icon; }
    function onIconError(r) { iconFallback[r.role] = true; }
    function cardStyle(r) { return roleVar(r.role); }   // 预置/自定义统一补 --role（单一入口）
    onMounted(() => { wireCreateEntry(); refreshQuota(); });
    // 删除（所有雷影卡片均可删）：仿 sessions.js armDelete —— 首次点击进入确认态、3s 内再点执行；移开/超时还原
    const confirmingRole = ref(null);
    let _delTimer = null;
    function clearDelConfirm() { if (_delTimer) { clearTimeout(_delTimer); _delTimer = null; } confirmingRole.value = null; }
    function armDelete(r) {
      if (confirmingRole.value === r.role) { clearDelConfirm(); removeAgent(r); return; }   // 二次点击 → 执行
      clearDelConfirm();
      confirmingRole.value = r.role;                                                        // 首次点击 → 确认态
      _delTimer = setTimeout(() => { confirmingRole.value = null; _delTimer = null; }, 3000);
    }
    async function removeAgent(r) {
      try {
        await api.agentsDelete(r.role);
        const arr = store.mailbox.roles || [];
        const i = arr.findIndex((x) => x && x.role === r.role);
        if (i >= 0) arr.splice(i, 1);
        if (selected.value === r.role) selected.value = null;
        toast('已删除雷影 ' + roleLabel(r), 'ok');
        load();                                                                             // 与后端对齐刷新
      } catch (e) {
        const code = String((e && e.data && e.data.error) || (e && e.message) || 'unknown').split(':')[0];
        toast('删除失败：' + _errText(code), 'err');
      }
    }
    // v6.48：显示名统一为「雷影·X」（前端注册表为准）；注册表无此角色 → 回退后端名/role
    return { roles, selected, pick, meta, label: roleLabel, roleBusy, quota, create: openCreateWizard,
             confirmingRole, armDelete, iconSrc, onIconError, cardStyle, iconFallback, cardPaused, openPro };
  },
  template: `
    <div v-for="r in roles" :key="r.role"
         :class="['card', 'card--hover', 'is-clickable', 'agent-card', meta(r).cls, { 'is-active': r.role === selected, 'is-paused': cardPaused(r) }]"
         :data-role="r.role" :style="cardStyle(r)" @click="pick(r)">
      <button type="button" class="cw-del" :class="{ 'is-confirming': confirmingRole === r.role }"
              :title="confirmingRole === r.role ? '再次点击确认删除（3 秒内）' : '删除雷影'"
              aria-label="删除雷影" @click.stop="armDelete(r)">
        <span v-if="confirmingRole === r.role" class="cw-del__confirm">确认删除</span>
        <svg v-else class="cw-del__ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M6.5 7l1 12.5h9L17.5 7"/><path d="M10 4.5h4"/><path d="M10 11v5M14 11v5"/></svg>
      </button>
      <div class="card__head">
        <span class="avatar"><span class="role-icon" :style="{ '--icon': 'url(' + iconSrc(r) + ')' }"></span></span>
        <div>
          <div class="card__title">{{ label(r) }}</div>
          <div v-if="!cardPaused(r)" class="agent-card__meta">
            <span class="dot" :class="roleBusy(r.role) ? 'dot-busy' : 'dot-online'"></span>
            <span class="mono">{{ (r.baseUrl || '').replace('http://127.0.0.1', ':') || '—' }}</span>
          </div>
          <div v-else class="agent-card__meta">
            <span class="dot dot-paused"></span>
            <span class="mono" style="color:var(--warn);">已停用</span>
          </div>
        </div>
        <span v-if="r.unread" class="badge" style="margin-left:auto;">{{ r.unread }}</span>
      </div>
      <div v-if="cardPaused(r)" class="agent-card__paused">
        <span class="acp__text">Pro 已到期，此雷影已暂停 · 续费后自动恢复</span>
        <button type="button" class="pro-cta pro-cta--sm" @click.stop="openPro">续费</button>
      </div>
      <div class="agent-card__domain"><span class="chip">{{ r.domain || r.role }}</span><span v-if="r.isMain" class="chip chip--acc">主我</span></div>
      <div class="card__sub" style="margin-top:8px;">{{ r.unread ? ('未读 ' + r.unread + ' 条') : '无未读' }}</div>
      <img v-if="!meta(r).cls && !iconFallback[r.role]" class="cw-ico-probe" :src="meta(r).icon" alt="" @error="onIconError(r)">
    </div>
    <div class="card card--hover is-clickable agent-card agent-card--add" @click="create" title="创建雷影"
         style="border-style:dashed;align-items:center;justify-content:center;min-height:96px;text-align:center;">
      <div class="card__title">＋ 创建雷影</div>
      <div class="card__sub">已用 {{ quota.used }} / 上限 {{ quota.limit === -1 ? '不限' : (quota.limit === null || quota.limit === undefined ? '未知' : quota.limit) }}</div>
    </div>
    <div v-if="!roles.length" class="empty" style="grid-column:1/-1;">
      <div class="empty__text">还没有雷影 —— 点击下方按钮新建一个</div>
      <button class="btn btn--primary btn--sm" @click="create">＋ 创建雷影</button>
    </div>
  `,
});

// 信箱时间线（挂载 #mail-timeline；host 已是 .timeline）
export const MailTimeline = defineComponent({
  name: 'MailTimeline',
  components: { Timeline },
  setup() {
    const role = ref('');
    async function loadMail(r) {
      role.value = r || role.value;
      try { const m = await api.mailbox(role.value); store.mailboxCurrent = { role: role.value, entries: m.entries || [], available: m.available !== false }; }
      catch { store.mailboxCurrent = { role: role.value, entries: [], available: false }; }
    }
    onMounted(() => { window.__leizaiLoadMail = loadMail; });
    window.addEventListener('leizai-mail-role', (e) => loadMail(e.detail));
    const items = computed(() => {
      const cur = store.mailboxCurrent || {};
      return (cur.entries || []).map((m) => ({
        id: m.id, type: m.type || 'notify', role: m.from_id || 'main',
        text: m.topic || m.content || '', time: hhmm(m.ts),
        // 只把"真正未读的 task"标红：reply/ack/notify 等本不需回执、或已有 read_at 的不标
        unread: !m.read_at && m.type === 'task',
      }));
    });
    const available = computed(() => !(store.mailboxCurrent && store.mailboxCurrent.available === false));
    return { items, available };
  },
  template: `
    <Timeline :items="items" />
    <div v-if="!available" class="dim" style="font-size:12px;margin-top:6px;">⚠ 信箱端点未就绪或未初始化</div>
  `,
});

// 派活面板（挂载 #dispatch-panel；host 已是 .card）
export const DispatchPanel = defineComponent({
  name: 'DispatchPanel',
  setup() {
    const toRole = ref('programmer');
    const type = ref('task');
    const text = ref('');
    const busy = ref(false);
    const roles = computed(() => (store.mailbox.roles || []).length ? store.mailbox.roles : [
      { role: 'programmer', name: '程序员' }, { role: 'designer', name: '美工' }, { role: 'writer', name: '文案' },
      { role: 'tester', name: '测试' }, { role: 'researcher', name: '研究员' }, { role: 'sales', name: '销售' },
      { role: 'editor', name: '剪辑师' },
    ]);
    async function send() {
      if (!text.value.trim()) { toast('请输入派活内容', 'err'); return; }
      busy.value = true;
      try {
        const r = await api.mailboxSend({ toRole: toRole.value, type: type.value, content: text.value.trim() });
        toast('已派发 → ' + toRole.value + (r.id ? ' (' + r.id + ')' : ''), 'ok');
        text.value = '';
      } catch (e) { toast('派发失败: ' + e.message, 'err'); }
      finally { busy.value = false; }
    }
    return { toRole, type, text, busy, roles, send, label: roleLabel };
  },
  template: `
    <div class="card__title" style="margin-bottom:8px;">派活</div>
    <div class="card-list">
      <select class="select" v-model="toRole" aria-label="目标雷影">
        <option v-for="r in roles" :key="r.role" :value="r.role">● {{ label(r) }}</option>
      </select>
      <select class="select" v-model="type" aria-label="消息类型">
        <option value="task">task</option><option value="reply">reply</option><option value="notify">notify</option>
      </select>
      <textarea class="input" v-model="text" rows="4" style="height:auto;padding:8px;min-width:0;width:100%;" placeholder="派活内容…"></textarea>
      <button class="btn btn--primary" :disabled="busy" @click="send">{{ busy ? '发送中…' : '发送' }}</button>
    </div>
  `,
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 · 创建雷影：舱头入口 + 已用/上限 + 创建向导（1 屏，≤3 步：选角 → 确认 → 完成）
// 数据源：GET /api/pro/status（maxRoles/activeRoles）；创建：POST /api/agents/create（服务端门禁）
// ═══════════════════════════════════════════════════════════════════════════
const quota = ref({ used: 0, limit: null, loaded: false });
// 角色表单一权威：后端 GET /api/agents/roles（name/domain 以后端为准）。
let _ROLES_CACHE = null;
async function loadRoles() {
  if (_ROLES_CACHE) return _ROLES_CACHE;
  try { const r = await api.agentsRoles(); _ROLES_CACHE = (r && r.roles) || (Array.isArray(r) ? r : []); }
  catch { _ROLES_CACHE = []; }
  return _ROLES_CACHE;
}

function _limitLabel(limit) { return limit === -1 ? '不限' : (limit === null || limit === undefined ? '未知' : String(limit)); }
function fmtQuota(q) { return '雷影：已用 ' + (q && q.used || 0) + ' / 上限 ' + _limitLabel(q && q.limit); }

async function refreshQuota() {
  try {
    const r = await api.proStatus();
    const used = Number(r && r.activeRoles) || 0;
    const limit = (r && r.maxRoles !== undefined && r.maxRoles !== null) ? Number(r.maxRoles) : null;
    quota.value = { used, limit, loaded: true };
  } catch { quota.value = { used: quota.value.used, limit: quota.value.limit, loaded: true }; }
  const el = document.getElementById('pro-roles-quota');
  if (el) el.textContent = fmtQuota(quota.value);
}

function _existingRoles() { return ((store.mailbox && store.mailbox.roles) || []).map(function (r) { return r.role; }); }


// 角色色单一权威：从 ROLE_META/roleVar 派生（预置=token 引用，色值仍由 base.css 定义；自定义=哈希色）。
// 不再维护第 4 份硬编码色表（原 ROLE_COLOR 已删，防新增预置角色时此处漏改 → 漂移）。
function _roleColor(role) { return roleMeta(role).color || customColor(role); }
function _roleIcon(role) { return (ROLE_META[role] && ROLE_META[role].icon) || '/assets/role-generic.svg'; }
function _roleGlyph(role, name) { const m = ROLE_META[role]; if (m) return m.glyph || '?'; return _stripPrefix(name || role).slice(0, 1) || '?'; }
function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function _stripPrefix(s) { return String(s || '').replace(/^雷影[·・]?/, '').trim(); }
function _iconSpan(icon, cls, style) { return '<span class="' + cls + '" style="--i:url(\'' + icon + '\')' + (style || '') + '"></span>'; }
function _closeWizard() { const ov = document.getElementById('create-agent-overlay'); if (ov) ov.remove(); }
function _errText(code) {
  const m = { pro_required: '需要 Pro 档位', role_limit_exceeded: '已达雷影数量上限', unknown_role: '角色不受支持', no_free_port: '无空闲端口', dir_exists: '目录已存在', template_missing: '模板目录缺失', preset_protected: '预置角色不可删除', not_found: '角色未找到', need_role: '缺少角色标识', archive_failed: '归档失败', name_exists: '该名称已存在，请换一个', already_exists: '该角色已存在', invalid_role_id: '标识不合法', invalid_domain: '领域说明不合法', domain_too_long: '领域说明过长' };
  return m[code] || (code || '未知错误');
}
function _kvRow(k, v) { return '<div class="cw-kv__r"><span class="cw-kv__k">' + k + '</span><span class="cw-kv__v">' + v + '</span></div>'; }

// ───────── 统一「档位提示」组件（美工·2026-10-09 收口）─────────
// 收口三处前置提示（创建雷影需 Pro / 已达数量上限 / 创建流程内无 Pro 权限）为同一组件：
//   · 同一套层叠：z-index=10000（高于创建向导 9999、低于 toast 10001）→ 恒在向导/弹层之上；
//   · 同一套样式：复用 .cw-win；CTA 统一走 window.__leizaiOpenPro；
//   · 红线：开发版（effective.tier=pro 且无到期，store.pro.isDev）绝不出现任何 Pro 提示。
function _isDevPro() { try { return !!(store.pro && store.pro.isDev); } catch { return false; } }
function _showTierNotice(opts) {
  opts = opts || {};
  if (_isDevPro()) return;                                  // ① 开发版不出提示
  var prev = document.getElementById('tier-notice');
  if (prev) prev.remove();                                  // 单例：重复触发即替换（不叠多份）
  var ov = document.createElement('div');
  ov.id = 'tier-notice';
  ov.setAttribute('data-variant', opts.variant || 'pro');
  ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;';
  var box = document.createElement('div');
  box.className = 'cw-win';
  box.innerHTML = '<div class="cw-win__head"><div class="cw-win__title">' + (opts.title || '') + '</div></div>'
    + '<div class="cw-win__body"><div class="cw-result__m">' + (opts.desc || '') + '</div></div>'
    + '<div class="cw-win__foot"><span class="cw-grow"></span>'
    + (opts.manage ? '<button class="btn btn--ghost" data-act="manage">管理雷影</button>' : '<button class="btn btn--ghost" data-act="close">关闭</button>')
    + '<button class="btn btn--primary" data-act="upgrade">' + (opts.upgradeLabel || '升级 Pro') + '</button></div>';
  ov.appendChild(box);
  ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
  var q = function (a) { return box.querySelector('[data-act="' + a + '"]'); };
  if (q('close')) q('close').addEventListener('click', function () { ov.remove(); });
  if (q('manage')) q('manage').addEventListener('click', function () { ov.remove(); _gotoManageAgents(); });
  q('upgrade').addEventListener('click', function () { ov.remove(); _openProPanel(); });
  document.body.appendChild(ov);
}
// 创建雷影需 Pro 档位（统一组件·pro 变体）
function _showProGateNotice() {
  _showTierNotice({ variant: 'pro', title: '创建雷影需 Pro 档位', desc: '雷影（独立智能体分身）为 Pro 功能，升级后即可创建。', upgradeLabel: '升级 Pro' });
}

// ——创建入口共用 CTA——
function _gotoManageAgents() {
  const w = document.getElementById('agent-wall');
  if (w && w.scrollIntoView) w.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function _openProPanel() { if (window.__leizaiOpenPro) window.__leizaiOpenPro(); }

// 已达雷影数量上限（统一组件·quota 变体）
function _showQuotaNotice(used, max) {
  _showTierNotice({ variant: 'quota', title: '已达雷影数量上限', desc: '已用 ' + (used || 0) + ' / 上限 ' + _limitLabel(max) + '。删除现有雷影或升级更高档位后可继续创建。', manage: true, upgradeLabel: '升级更高档位' });
}

// 失败归一：后端业务失败返 HTTP 4xx，但 body 已是结果对象（{ok:false,error,used,maxRoles}）。
// jsonReq 会 throw 且把 body 挂在 e.data → 此处还原成结果对象，交给 _preBlocked 走友好分支（非原始码）。
function _asResult(e) {
  const d = e && e.data;
  if (d && typeof d === 'object' && (d.error || d.ok === false)) return d;
  return { ok: false, error: (e && e.message) || String(e || 'unknown_error') };
}

// 创建操作环节（确认创建 dryRun 预检）失败时的友好提示：复用入口拦截卡，给出明确出路
function _preBlocked(pre, r) {
  const code = String((r && r.error) || '').split(':')[0];
  if (code === 'pro_required') {
    pre.innerHTML = _kvRow('状态', '创建雷影需 Pro 档位');
    _showProGateNotice();
  } else if (code === 'role_limit_exceeded') {
    const u = (r && r.used !== undefined && r.used !== null) ? r.used : quota.value.used;
    const m = (r && r.maxRoles !== undefined && r.maxRoles !== null) ? r.maxRoles : quota.value.limit;
    pre.innerHTML = _kvRow('状态', '已达雷影数量上限（已用 ' + (u || 0) + ' / 上限 ' + _limitLabel(m) + '）');
    _showQuotaNotice(u, m);
  } else {
    pre.innerHTML = _kvRow('不可创建', _errText(code));
  }
}

function openCreateWizard() {
  if (document.getElementById('create-agent-overlay')) return;
  // 入口不拦：Lite/达上限用户同样可打开向导浏览；门禁友好提示延后到「确认创建」环节（见 _preBlocked）。
  const ov = document.createElement('div');
  ov.id = 'create-agent-overlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.className = 'cw-win';
  ov.appendChild(box);
  ov.addEventListener('click', function (e) { if (e.target === ov) _closeWizard(); });
  document.body.appendChild(ov);
  _renderPick(box);
}

// 步骤1 · 选角色（卡片来自后端角色表）
async function _renderPick(box) {
  box.innerHTML = '<div class="cw-win__head"><div class="cw-win__title">创建雷影</div>'
    + '<div class="cw-win__quota chip chip--acc">' + fmtQuota(quota.value) + '</div></div>'
    + '<div class="cw-win__body"><div class="cw-rgrid" id="create-agent-list"><div class="cw-rcard__desc">加载角色…</div></div></div>'
    + '<div class="cw-win__foot"><span class="cw-grow"></span><button class="btn btn--ghost" id="create-agent-cancel">取消</button></div>';
  box.querySelector('#create-agent-cancel').addEventListener('click', function () { _closeWizard(); });
  const list = box.querySelector('#create-agent-list');
  const roles = await loadRoles();
  const existing = new Set(_existingRoles());
  list.innerHTML = roles.length ? '' : '<div class="cw-rcard__desc">角色表加载失败，可先试「＋ 自定义」。</div>';
  roles.forEach(function (c) {
    const done = existing.has(c.role);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'cw-rcard' + (done ? ' is-disabled' : '');
    item.setAttribute('data-role', c.role);
    item.style.setProperty('--role', _roleColor(c.role));
    item.innerHTML = '<div class="cw-rcard__top">' + _iconSpan(_roleIcon(c.role), 'cw-rcard__ico') + '</div>'
      + '<div class="cw-rcard__name">' + _esc(c.name || c.role) + '</div>'
      + '<div class="cw-rcard__desc">' + (done ? '已创建' : _esc(c.domain || '')) + '</div>';
    if (!done) item.addEventListener('click', function () { _confirmCreate(box, c); });
    list.appendChild(item);
  });
  // v2 · 自定义入口（网格末位）
  const cu = document.createElement('button');
  cu.type = 'button';
  cu.className = 'cw-rcard cw-rcard--custom';
  cu.id = 'create-agent-custom';
  cu.innerHTML = '<div class="cw-rcard__top">' + _iconSpan('/assets/role-generic.svg', 'cw-rcard__ico') + '<span class="cw-rcard__name">＋ 自定义</span></div>'
    + '<div class="cw-rcard__desc">填名称 + 领域说明，自动生成可用分身</div>';
  cu.addEventListener('click', function () { _renderCustomForm(box); });
  list.appendChild(cu);
}

// 步骤1.5 · 自定义表单（名称 + 领域必填；温度段控；✨ AI 完善；实时校验）
const _CW_TEMPS = [0.1, 0.3, 0.5, 0.7];
const _CUSTOM = { name: '', domain: '', temperature: 0.3, icon: '' };
function _nameErr(name) {
  const v = String(name || '').trim();
  if (!v) return '名称不能为空';
  if (v.length > 12) return '名称最长 12 字（当前 ' + v.length + '）';
  if (!/^[\u4e00-\u9fa5A-Za-z0-9 ]+$/.test(v)) return '仅支持中文 / 字母 / 数字 / 空格';
  const dup = (_ROLES_CACHE || []).some(function (r) { return _stripPrefix(r.name || '') === v || r.role === v; });
  return dup ? '该名称已存在，请换一个' : '';
}
function _domainErr(d) {
  const v = String(d || '').trim();
  if (!v) return '领域说明不能为空';
  if (v.length > 20) return '领域最长 20 字（当前 ' + v.length + '）';
  return '';
}
function _renderCustomForm(box) {
  box.innerHTML = '<div class="cw-win__head"><div class="cw-win__title">自定义角色</div>'
    + '<div class="cw-win__quota chip chip--acc">' + fmtQuota(quota.value) + '</div></div>'
    + '<div class="cw-win__body"><div class="cw-form">'
    + '<div class="cw-field" id="cw-f-name"><div class="cw-field__label">名称 <span class="req">*</span></div>'
    +   '<input class="cw-input" id="cw-name" maxlength="24" placeholder="如：数据分析师" value="' + _esc(_CUSTOM.name) + '">'
    +   '<div class="cw-hint">2–12 字 · 中文 / 字母 / 数字 / 空格</div></div>'
    + '<div class="cw-field" id="cw-f-domain"><div class="cw-field__label">领域说明 <span class="req">*</span></div>'
    +   '<input class="cw-input" id="cw-domain" maxlength="40" placeholder="如：数据清洗 / 指标分析 / 报表" value="' + _esc(_CUSTOM.domain) + '">'
    +   '<div class="cw-hint">一行短句 · ≤20 字</div></div>'
    + '<div class="cw-field" id="cw-f-icon"><div class="cw-field__label">专属图标 <span class="opt">可选 · AI 生成</span></div>'
    +   '<div class="cw-ico"><span class="cw-ico__box" id="cw-ico-box"><span class="role-icon"></span></span>'
    +     '<button class="btn btn--ghost btn--sm" id="cw-ico-gen" type="button">✨ 生成图标</button>'
    +     '<button class="btn btn--ghost btn--sm" id="cw-ico-adopt" type="button" hidden>采用</button>'
    +     '<button class="btn btn--ghost btn--sm" id="cw-ico-regen" type="button" hidden>重新生成</button>'
    +     '<span class="cw-hint" id="cw-ico-hint">未生成时用通用图标</span></div></div>'
    + '<div class="cw-field"><div class="cw-field__label">温度 <span class="opt">可选 · 默认 0.3</span></div>'
    +   '<div class="cw-seg" id="cw-temp">' + _CW_TEMPS.map(function (v) { return '<span class="cw-seg__opt' + (v === _CUSTOM.temperature ? ' is-on' : '') + '" data-v="' + v + '">' + v + '</span>'; }).join('') + '</div>'
    +   '<div class="cw-hint">越高越发散；领域任务建议 0.2–0.4</div></div>'
    + '</div></div>'
    + '<div class="cw-win__foot"><span class="cw-grow"></span><span class="cw-hint" id="cw-aihint"></span>'
    +   '<button class="btn btn--ghost" id="cw-ai">✨ AI 完善</button>'
    +   '<button class="btn btn--ghost" id="cw-back">返回</button>'
    +   '<button class="btn btn--primary" id="cw-next" disabled>下一步</button></div>';
  const nameEl = box.querySelector('#cw-name'), domEl = box.querySelector('#cw-domain');
  const fName = box.querySelector('#cw-f-name'), fDom = box.querySelector('#cw-f-domain'), next = box.querySelector('#cw-next');
  // —— 专属图标（AI 生成，可选；失败降级 generic，绝不阻塞创建）——
  const icoBox = box.querySelector('#cw-ico-box'), icoGen = box.querySelector('#cw-ico-gen');
  const icoRegen = box.querySelector('#cw-ico-regen'), icoAdopt = box.querySelector('#cw-ico-adopt'), icoHint = box.querySelector('#cw-ico-hint');
  icoBox.style.setProperty('--role', customColor('custom-' + (_stripPrefix(_CUSTOM.name) || 'x')));
  function icoSet(url) { icoUrl = url || ''; icoBox.style.setProperty('--icon', 'url(' + (icoUrl || '/assets/role-generic.svg') + ')'); }
  // 兼容后端返回 URL 或内联 SVG 串：SVG 串 → data URL
  function normIcon(v) { v = String(v == null ? '' : v).trim(); if (!v) return ''; return v.charAt(0) === '<' ? 'data:image/svg+xml;utf8,' + encodeURIComponent(v) : v; }
  let icoUrl = _CUSTOM.icon || '';
  icoSet(icoUrl);
  // mask 渲染不触发 onerror → 隐藏 <img> 探针；不可达则回退 generic
  const icoProbe = document.createElement('img');
  icoProbe.className = 'cw-ico-probe'; icoProbe.alt = '';
  icoProbe.addEventListener('error', function () { if (icoBox.classList.contains('is-generating')) return; icoSet('/assets/role-generic.svg'); icoHint.textContent = '图标不可用，已回退通用图标'; });
  box.appendChild(icoProbe);
  async function icoGenerate() {
    const nm = _stripPrefix(nameEl.value);
    if (!nm) { icoHint.textContent = '请先填写名称'; return; }
    icoBox.classList.remove('is-fail'); icoBox.classList.add('is-generating');
    icoGen.disabled = true; icoGen.hidden = true; icoRegen.hidden = true; icoAdopt.hidden = true;
    icoHint.textContent = '生成中…';
    let ok = false, url = '';
    try {
      const r = await Promise.race([
        api.agentsIcon({ name: nm, domain: (domEl.value || '').trim(), v: Date.now() }),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 8000); }),
      ]);
      const _iv = (r && r.ok !== false) ? (r.icon != null ? r.icon : (r.url || '')) : '';   // 后端可能回内联 icon 或 url
      if (_iv) { url = normIcon(_iv); ok = !!url; }
    } catch (e) { ok = false; }
    icoBox.classList.remove('is-generating');
    if (ok) {
      icoSet(url); icoProbe.src = url;
      icoGen.hidden = true; icoRegen.hidden = false; icoAdopt.hidden = false;
      icoHint.textContent = '已生成，可重新生成或直接下一步';
    } else {
      icoBox.classList.add('is-fail'); icoSet('/assets/role-generic.svg');
      icoGen.disabled = false; icoGen.hidden = false; icoRegen.hidden = true; icoAdopt.hidden = true;
      icoHint.textContent = '生成失败，已回退通用图标（不影响创建）';
    }
  }
  icoGen.addEventListener('click', icoGenerate);
  icoRegen.addEventListener('click', icoGenerate);
  icoAdopt.addEventListener('click', function () { _CUSTOM.icon = icoUrl; icoAdopt.hidden = true; icoHint.textContent = '已采用该图标'; });
  nameEl.addEventListener('input', function () { icoBox.style.setProperty('--role', customColor('custom-' + (_stripPrefix(nameEl.value) || 'x'))); });
  function setField(f, state, msg) {
    f.className = 'cw-field' + (state ? ' is-' + state : '');
    const h = f.querySelector('.cw-hint');
    h.className = 'cw-hint' + (state === 'err' ? ' cw-hint--err' : state === 'ok' ? ' cw-hint--ok' : '');
    h.textContent = msg;
  }
  function validate(touched) {
    _CUSTOM.name = nameEl.value; _CUSTOM.domain = domEl.value;
    const ne = _nameErr(nameEl.value), de = _domainErr(domEl.value);
    setField(fName, ne ? (touched ? 'err' : '') : 'ok', ne || '✓ 可用');
    setField(fDom, de ? (touched ? 'err' : '') : 'ok', de || '✓ 可用');
    next.disabled = !!(ne || de);
    return !(ne || de);
  }
  function setTemp(v) { _CUSTOM.temperature = v; box.querySelectorAll('#cw-temp .cw-seg__opt').forEach(function (x) { x.classList.toggle('is-on', Number(x.getAttribute('data-v')) === v); }); }
  nameEl.addEventListener('input', function () { validate(false); });
  nameEl.addEventListener('blur', function () { validate(true); });
  domEl.addEventListener('input', function () { validate(false); });
  box.querySelector('#cw-temp').addEventListener('click', function (e) { const o = e.target.closest('.cw-seg__opt'); if (o) setTemp(Number(o.getAttribute('data-v'))); });
  box.querySelector('#cw-ai').addEventListener('click', async function () {
    const nm = nameEl.value.trim(), hint = box.querySelector('#cw-aihint'), btn = box.querySelector('#cw-ai');
    if (!nm) { setField(fName, 'err', '请先填写名称，再用 AI 完善'); hint.textContent = ''; return; }
    btn.disabled = true; const old = btn.textContent; btn.textContent = '✨ 思考中…'; hint.className = 'cw-hint'; hint.textContent = '';
    try {
      const r = await api.agentsAutoProfile({ name: nm });
      if (r && r.ok !== false && r.domain) {
        domEl.value = r.domain; _CUSTOM.domain = r.domain;
        if (r.temperature != null && !isNaN(Number(r.temperature))) {
          const tv = _CW_TEMPS.reduce(function (a, b) { return Math.abs(b - Number(r.temperature)) < Math.abs(a - Number(r.temperature)) ? b : a; }, _CW_TEMPS[0]);
          setTemp(tv);
        }
        hint.className = 'cw-hint cw-hint--ok'; hint.textContent = '已按建议回填，可编辑';
        validate(false);
      } else { hint.textContent = '自动建议不可用，请手动填写'; }
    } catch (e) { hint.textContent = '自动建议不可用，请手动填写'; }
    finally { btn.disabled = false; btn.textContent = old; }
  });
  box.querySelector('#cw-back').addEventListener('click', function () { _renderPick(box); });
  next.addEventListener('click', function () { if (validate(true)) _confirmCustom(box); });
  validate(false);
}

// 步骤2（自定义）· 确认（dryRun 预检）
async function _confirmCustom(box) {
  const nm = _stripPrefix(_CUSTOM.name);
  const rolePreview = 'custom-' + nm;   // 仅供预览取色（真实 role 由后端生成）
  box.innerHTML = '<div class="cw-win__head"><div class="cw-win__title">确认创建</div></div>'
    + '<div class="cw-win__body">'
    + '<div class="cw-summary" style="--role:' + customColor(rolePreview) + '">' + _iconSpan('/assets/role-generic.svg', 'cw-summary__ico')
    + '<div><div class="cw-rcard__name">雷影·' + _esc(nm) + '</div><div class="cw-rcard__desc">' + _esc(_CUSTOM.domain) + '</div></div></div>'
    + '<div class="cw-kv" id="create-agent-pre">' + _kvRow('预检', '端口 / 门禁 / 名称…') + '</div></div>'
    + '<div class="cw-win__foot"><span class="cw-grow"></span><button class="btn btn--ghost" id="create-agent-back">返回</button><button class="btn btn--primary" id="create-agent-go" disabled>确认创建</button></div>';
  box.querySelector('#create-agent-back').addEventListener('click', function () { _renderCustomForm(box); });
  const pre = box.querySelector('#create-agent-pre'), go = box.querySelector('#create-agent-go');
  const payload = { name: nm, domain: _CUSTOM.domain.trim(), temperature: _CUSTOM.temperature };
  if (_CUSTOM.icon) payload.icon = _CUSTOM.icon;
  let info = null;
  try {
    const r = await api.agentsCreate(Object.assign({ dryRun: true }, payload));
    if (r && r.ok) {
      info = r;
      pre.innerHTML = _kvRow('实例', '独立数据域（不含主我数据）') + _kvRow('端口', ':' + r.port)
        + _kvRow('标识', _esc(r.role || '自动生成')) + _kvRow('温度', _CUSTOM.temperature) + _kvRow('创建后', '自动注册名册，可立即派单');
      go.disabled = false;
    } else { _preBlocked(pre, r); }
  } catch (e) { _preBlocked(pre, _asResult(e)); }
  go.addEventListener('click', function () { _doCreate(box, { role: (info && info.role), name: '雷影·' + nm }, info, payload); });
}

// 步骤2 · 确认（先 dryRun 预检显示将占端口）
async function _confirmCreate(box, c) {
  box.innerHTML = '<div class="cw-win__head"><div class="cw-win__title">确认创建</div></div>'
    + '<div class="cw-win__body">'
    + '<div class="cw-summary" style="--role:' + _roleColor(c.role) + '">' + _iconSpan(_roleIcon(c.role), 'cw-summary__ico')
    + '<div><div class="cw-rcard__name">' + (c.name || c.role) + '</div><div class="cw-rcard__desc">' + (c.domain || '') + '</div></div></div>'
    + '<div class="cw-kv" id="create-agent-pre">' + _kvRow('预检', '端口 / 门禁 / 角色…') + '</div>'
    + '</div>'
    + '<div class="cw-win__foot"><span class="cw-grow"></span><button class="btn btn--ghost" id="create-agent-back">返回</button><button class="btn btn--primary" id="create-agent-go" disabled>确认创建</button></div>';
  box.querySelector('#create-agent-back').addEventListener('click', function () { _renderPick(box); });
  const pre = box.querySelector('#create-agent-pre');
  const go = box.querySelector('#create-agent-go');
  let info = null;
  try {
    const r = await api.agentsCreate({ role: c.role, dryRun: true });
    if (r && r.ok) {
      info = r;
      pre.innerHTML = _kvRow('实例', '独立数据域（不含主我数据）') + _kvRow('端口', ':' + r.port)
        + _kvRow('配额', '本次 +1') + _kvRow('创建后', '自动注册名册，可立即派单');
      go.disabled = false;
    } else { _preBlocked(pre, r); }
  } catch (e) { _preBlocked(pre, _asResult(e)); }
  go.addEventListener('click', function () { _doCreate(box, c, info); });
}

// 步骤3 · 创建中 / 成功 / 失败 三态
const _CW_STEPS = ['准备骨架', '写入配置', '隔离拉起', '健康自检', '注册名册'];
async function _doCreate(box, c, info, payload) {
  box.innerHTML = '<div class="cw-win__head"><div class="cw-win__title">创建中…</div></div>'
    + '<div class="cw-win__body">'
    + '<div class="cw-steps" id="cw-steps">' + _CW_STEPS.map(function (t, i) { return '<div class="cw-step' + (i === 0 ? ' is-on' : '') + '" data-i="' + i + '"><span class="cw-step__n">' + (i + 1) + '</span>' + t + '</div>'; }).join('<span class="cw-steps__ln"></span>') + '</div>'
    + '<div class="cw-plist">' + _CW_STEPS.map(function (t, i) { return '<div class="cw-pitem' + (i === 0 ? ' is-active' : '') + '" data-i="' + i + '"><span class="cw-pitem__dot"></span>' + t + '</div>'; }).join('') + '</div>'
    + '<div class="cw-skel"></div></div>';
  let cur = 0;
  const timer = setInterval(function () {
    const steps = box.querySelectorAll('.cw-step'), items = box.querySelectorAll('.cw-pitem');
    if (!steps.length) return;
    steps[cur].classList.remove('is-on'); steps[cur].classList.add('is-done');
    if (items[cur]) { items[cur].classList.remove('is-active'); items[cur].classList.add('is-done'); }
    cur = Math.min(cur + 1, _CW_STEPS.length - 1);
    steps[cur].classList.add('is-on');
    if (items[cur]) items[cur].classList.add('is-active');
  }, 600);
  let r = null;
  try { r = await api.agentsCreate(payload || { role: c.role }); } catch (e) { r = _asResult(e); }   // 统一取回 body（含 used/maxRoles），与两处 dryRun 一致
  clearInterval(timer);
  if (r && r.ok) {
    if (window.__leizaiReloadAgents) window.__leizaiReloadAgents();
    refreshQuota();
    box.innerHTML = '<div class="cw-win__head"><div class="cw-win__title">完成</div></div>'
      + '<div class="cw-win__body"><div class="cw-result cw-result--ok" style="--role:' + _roleColor(r.role || c.role) + '"><div class="cw-result__big">✓</div>'
      + '<div class="cw-result__h">' + (r.name || c.name || c.role) + ' 已创建</div>'
      + '<div class="cw-result__m">端口 :' + r.port + ' · 已注册名册、状态在线，可立即派单</div></div></div>'
      + '<div class="cw-win__foot"><span class="cw-grow"></span><button class="btn btn--ghost" id="create-agent-close">去看雷影</button><button class="btn btn--primary" id="create-agent-talk">立即开始对话</button></div>';
    box.querySelector('#create-agent-close').addEventListener('click', function () { _closeWizard(); });
    box.querySelector('#create-agent-talk').addEventListener('click', function () {
      _closeWizard();
      window.dispatchEvent(new CustomEvent('leizai-mail-role', { detail: c.role }));
      if (window.__leizaiLoadMail) window.__leizaiLoadMail(c.role);
    });
    toast('已创建 ' + (r.name || c.name) + ' @ :' + r.port, 'ok');
  } else {
    const code = String((r && r.error) || 'unknown');
    if (code.split(':')[0] === 'pro_required') {
      // 无 Pro 权限：走统一「档位提示」组件（置顶于创建向导之上）
      _showProGateNotice();
    } else if (code.split(':')[0] === 'role_limit_exceeded') {
      const u = (r && r.used !== undefined && r.used !== null) ? r.used : quota.value.used;
      const m = (r && r.maxRoles !== undefined && r.maxRoles !== null) ? r.maxRoles : quota.value.limit;
      _showQuotaNotice(u, m);
    } else {
      box.innerHTML = '<div class="cw-win__head"><div class="cw-win__title">创建失败</div></div>'
        + '<div class="cw-win__body"><div class="cw-result cw-result--err"><div class="cw-result__big">✕</div>'
        + '<div class="cw-result__h">' + _errText(code.split(':')[0]) + '</div>'
        + '<div class="cw-result__m">未能完成创建</div>'
        + '<div class="cw-errcode">' + code + ' · 已回滚：临时目录已清理、名额未残留</div></div></div>'
        + '<div class="cw-win__foot"><span class="cw-grow"></span><button class="btn btn--ghost" id="create-agent-back2">返回</button><button class="btn btn--primary" id="create-agent-retry">重试</button></div>';
      box.querySelector('#create-agent-back2').addEventListener('click', function () { _renderPick(box); });
      box.querySelector('#create-agent-retry').addEventListener('click', function () { _doCreate(box, c, info); });
    }
  }
}

function wireCreateEntry() {
  const b = document.getElementById('btn-create-agent');
  if (b && !b.__wired) { b.__wired = true; b.addEventListener('click', openCreateWizard); }
}

if (typeof window !== 'undefined') window.__leizaiOpenCreateWizard = openCreateWizard;
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', function () { wireCreateEntry(); refreshQuota(); initProNudge(); });
}

// ═══════════════════════════════════════════════════════════════════════════
// P3 · Pro 升级引导卡（可关闭内联卡；输入区上方，非弹窗/不进消息流）
// 触发：Pro激活 && maxRoles>0 && activeRoles===0；DEV/Lite/maxRoles=null/达上限 → 不显示
// 两级关闭：× / 稍后 = 本次(sessionStorage)；不再提示 = 永久(localStorage)
// ═══════════════════════════════════════════════════════════════════════════
const NUDGE_NEVER = 'leizai.proNudge.never';
const NUDGE_SNOOZE = 'leizai.proNudge.snoozed';

async function initProNudge() {
  const host = document.getElementById('pro-upgrade-nudge');
  if (!host) return;
  const hide = function () { host.hidden = true; host.innerHTML = ''; };
  try {
    if (localStorage.getItem(NUDGE_NEVER) === '1') return hide();
    if (sessionStorage.getItem(NUDGE_SNOOZE) === '1') return hide();
    const st = await api.proStatus();
    const activated = !!(st && (st.activated === true || (st.effective && st.effective.tier === 'pro')));
    const isDev = !!(st && st.gate && /dev/i.test(String(st.gate.reason || '')));
    const maxRoles = (st && st.maxRoles !== undefined && st.maxRoles !== null) ? Number(st.maxRoles) : null;
    const activeRoles = Number(st && st.activeRoles) || 0;
    if (!activated || isDev) return hide();                 // Lite/DEV → 不显示
    if (maxRoles === null || maxRoles <= 0) return hide();   // 未知/无配额 → 不显示
    if (activeRoles !== 0) return hide();                    // 已有雷影（达上限）→ 不显示（每次升级仅一次）
    host.hidden = false;
    host.innerHTML = '<div class="card" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid rgba(128,128,128,.35);border-radius:8px;">'
      + '<span class="card__sub" style="flex:1;">你已是 Pro，可创建雷影帮你分工（已用 ' + activeRoles + ' / 上限 ' + maxRoles + '）</span>'
      + '<button class="btn btn--primary btn--sm" data-act="create">创建第一个雷影</button>'
      + '<button class="btn btn--ghost btn--sm" data-act="later">稍后</button>'
      + '<button class="btn btn--ghost btn--sm" data-act="never">不再提示</button>'
      + '<button class="btn btn--ghost btn--sm" data-act="close" title="关闭" aria-label="关闭">×</button>'
      + '</div>';
    host.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        const act = b.getAttribute('data-act');
        if (act === 'create') { if (window.__leizaiOpenCreateWizard) window.__leizaiOpenCreateWizard(); return; }
        if (act === 'never') { try { localStorage.setItem(NUDGE_NEVER, '1'); } catch { } return hide(); }
        try { sessionStorage.setItem(NUDGE_SNOOZE, '1'); } catch { }
        hide();
      });
    });
  } catch { hide(); }
}
