// 会话级「模型 + 推理等级」选择器（雷影·美工）
// 位置：.composer__field 内、#composer-input 之后、#composer-stop/#btn-send 之前（按钮恒在最右）；作用域=当前会话（PUT /api/sessions/:id）。
// 数据：会话值 GET /api/sessions/:id（s.model / s.reasoningEffort，null=跟随全局）；全局值 GET /api/config。
// 契约：按既定交互规格（会话级模型与推理等级）
import { api } from '../api.js';
import { store, toast } from '../store.js';

const EFFORTS = [
  { v: 'low', label: '低' },
  { v: 'medium', label: '中' },
  { v: 'high', label: '高' },
  { v: 'max', label: '最高' },
  { v: 'off', label: '关闭' },
];
const EFFORT_LABEL = Object.fromEntries(EFFORTS.map((e) => [e.v, e.label]));

let _cfg = null;          // GET /api/config 缓存（含 model/reasoningEffort/models）
let _cfgAt = 0;           // 上次成功加载 _cfg 的时间戳（用于过期刷新）
let _open = null;         // 当前展开的 popup 控制器（互斥）
const _els = {};          // { modelBtn, modelPop, effortBtn, effortPop }

function curSession() {
  const id = store.currentId;
  if (!id) return null;
  return (store.sessions || []).find((s) => s.id === id) || null;
}

async function loadCfg() {
  if (_cfg) return _cfg;
  try { _cfg = await api.config(); _cfgAt = Date.now(); } catch { _cfg = null; }
  return _cfg;
}
// 强制刷新（供控制台改全局模型/推理后调用，或 open 前过期加固）
async function refreshCfg() {
  try { _cfg = await api.config(); _cfgAt = Date.now(); } catch { }
  return _cfg;
}

// 跟随全局时不显示"跟随全局"字样，改为显示当前生效值 + 弱化配色；title/aria 里说明继承关系。
function modelLabel() {
  const s = curSession();
  const g = _cfg ? _cfg.model : '';
  const cur = (s && s.model) ? s.model : null;
  if (cur) return { text: cur, follow: false, title: '模型（本会话）：' + cur };
  return { text: g || '默认', follow: true, title: '模型：跟随全局' + (g ? ('（' + g + '）') : '（未设置）') };
}
function effortLabel() {
  const s = curSession();
  const g = _cfg ? _cfg.reasoningEffort : '';
  const cur = (s && s.reasoningEffort) ? s.reasoningEffort : null;
  if (cur) { const t = EFFORT_LABEL[cur] || cur; return { text: t, follow: false, title: '推理等级（本会话）：' + t }; }
  const gl = g ? (EFFORT_LABEL[g] || g) : '默认';
  return { text: gl, follow: true, title: '推理等级：跟随全局' + (g ? ('（' + gl + '）') : '（未设置）') };
}

function render() {
  const m = modelLabel(), e = effortLabel();
  if (_els.modelBtn) {
    _els.modelBtn.querySelector('.scope-sel__val').textContent = m.text;
    _els.modelBtn.classList.toggle('is-follow', m.follow);
    _els.modelBtn.title = m.title;
    _els.modelBtn.setAttribute('aria-label', '模型：' + m.text + (m.follow ? '（跟随全局）' : '（本会话）'));
  }
  if (_els.effortBtn) {
    _els.effortBtn.querySelector('.scope-sel__val').textContent = e.text;
    _els.effortBtn.classList.toggle('is-follow', e.follow);
    _els.effortBtn.title = e.title;
    _els.effortBtn.setAttribute('aria-label', '推理等级：' + e.text + (e.follow ? '（跟随全局）' : '（本会话）'));
  }
}

// —— 自定义下拉：button + listbox（键盘：Enter/Space 开、↑↓ 选、Enter 定、Esc 关）——
function buildSel(kind, icon) {
  const wrap = document.createElement('div');
  wrap.className = 'scope-sel';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'scope-sel__btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const ic = document.createElement('span'); ic.className = 'scope-sel__ico'; ic.textContent = icon; ic.setAttribute('aria-hidden', 'true');
  const val = document.createElement('span'); val.className = 'scope-sel__val';
  const car = document.createElement('span'); car.className = 'scope-sel__car'; car.textContent = '▾'; car.setAttribute('aria-hidden', 'true');
  btn.append(ic, val, car);

  const pop = document.createElement('div');
  pop.className = 'scope-pop';
  pop.setAttribute('role', 'listbox');
  pop.hidden = true;

  wrap.append(btn, pop);
  _els[kind + 'Btn'] = btn;
  _els[kind + 'Pop'] = pop;

  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(kind); });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(kind, true); }
    else if (e.key === 'Escape') close();
  });
  pop.addEventListener('keydown', (e) => {
    const items = [...pop.querySelectorAll('.scope-pop__item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); _els[kind + 'Btn'].focus(); }
  });
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Tab') close(); });
  return wrap;
}

function open(kind, focusFirst) {
  const pop = _els[kind + 'Pop'], btn = _els[kind + 'Btn'];
  if (!pop || !btn) return;
  if (_open && _open !== kind) close();
  // 加固：_cfg 过期(>10s) → 后台刷新后重填（用旧值立即可见，刷新回来再更新）
  if (_cfg && Date.now() - _cfgAt > 10000) refreshCfg().then(() => { if (_open === kind) fill(kind); });
  fill(kind);
  pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
  _open = kind;
  if (focusFirst) { const f = pop.querySelector('.scope-pop__item.is-cur') || pop.querySelector('.scope-pop__item'); if (f) f.focus(); }
}
function close() {
  if (!_open) return;
  const pop = _els[_open + 'Pop'], btn = _els[_open + 'Btn'];
  if (pop) pop.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
  _open = null;
}
function toggle(kind) { (_open === kind) ? close() : open(kind, false); }

function fill(kind) {
  const pop = _els[kind + 'Pop'];
  if (!pop) return;
  pop.innerHTML = '';
  const s = curSession();
  const items = kind === 'model' ? buildModelItems(s) : buildEffortItems(s);
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'scope-pop__item' + (it.cur ? ' is-cur' : '');
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', it.cur ? 'true' : 'false');
    el.tabIndex = -1;
    const lab = document.createElement('span'); lab.textContent = it.label;
    el.appendChild(lab);
    if (it.hint) { const h = document.createElement('span'); h.className = 'scope-pop__hint'; h.textContent = it.hint; el.appendChild(h); }
    const mark = document.createElement('span'); mark.className = 'scope-pop__mark'; mark.textContent = it.cur ? '✓' : ''; el.appendChild(mark);
    el.addEventListener('click', (e) => { e.stopPropagation(); pick(kind, it.value); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pick(kind, it.value); } });
    pop.appendChild(el);
  }
}

function buildModelItems(s) {
  const cur = (s && s.model) || null;
  const list = [{ label: '跟随全局', value: null, cur: !cur, hint: _cfg && _cfg.model ? _cfg.model : '' }];
  const models = (_cfg && Array.isArray(_cfg.models)) ? _cfg.models.slice() : [];
  if (cur && !models.includes(cur)) models.unshift(cur);
  for (const m of models) list.push({ label: m, value: m, cur: cur === m });
  return list;
}
function buildEffortItems(s) {
  const cur = (s && s.reasoningEffort) || null;
  const list = [{ label: '跟随全局', value: null, cur: !cur, hint: _cfg && _cfg.reasoningEffort ? (_cfg.reasoningEffort) : '' }];
  for (const e of EFFORTS) list.push({ label: e.label + '（' + e.v + '）', value: e.v, cur: cur === e.v });
  return list;
}

async function pick(kind, value) {
  close();
  const id = store.currentId;
  if (!id) return;
  // 乐观更新本地显示
  const s = curSession();
  if (s) { if (kind === 'model') s.model = value; else s.reasoningEffort = value; }
  render();
  const body = kind === 'model' ? { model: value } : { reasoningEffort: value };
  try {
    await api.put('/api/sessions/' + encodeURIComponent(id), body);
  } catch (e) {
    // 失败回滚 + 提示（引擎未就绪时走此分支）
    try { const fresh = await api.session(id); const t = curSession(); if (t && fresh) { t.model = fresh.model ?? null; t.reasoningEffort = fresh.reasoningEffort ?? null; } } catch { }
    render();
    const msg = (e && e.status === 400) ? '取值不被接受' : '会话级设置暂不可用（引擎可能未就绪）';
    toast(msg + '：' + ((e && e.message) || e), 'err');
    return;
  }
  render();
}

export function initScopeSelect() {
  const field = document.querySelector('.composer__field');
  if (!field || field.dataset.scope === '1') return;
  const send = document.getElementById('btn-send');
  if (!send) return;
  const box = document.createElement('div');
  box.className = 'scope-sels';
  box.id = 'composer-scope';
  box.append(buildSel('model', '◈'), buildSel('effort', '⌁'));
  const stop = document.getElementById('composer-stop');
  // 插到 #composer-input 之后、#composer-stop 之前 → 运行中顺序 [input, scope, stop, send]，
  // 按钮(stop/send)恒在最右（修"发送按钮跑到模型左边"bug）。stop 缺失时回退到 send 之前。
  field.insertBefore(box, stop || send);
  field.dataset.scope = '1';

  document.addEventListener('click', () => close());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  window.__leizaiScopeRefresh = () => { close(); render(); };

  // 初次加载：先拿全局配置，再刷新
  loadCfg().then(() => { render(); });
  render();

  window.__leizaiScopeReload = async () => { _cfg = null; await loadCfg(); render(); };  return box;
}
