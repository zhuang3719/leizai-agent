// 询问选项框 Ask Box（雷影·美工）——前端侧 v1.1
// 数据流：SSE `ask-user` → #composer 上方渲染卡片；选/跳过/补充 → POST /api/ask/answer → 卡片收起。
// v1.1：①multi → 复选框多选 ②选中不再立即发送，改为点 [提交] 发送（可附补充文字）。
// 刷新恢复：挂载时 GET /api/ask/pending?sessionId= 恢复未答卡片。端点未就绪时静默降级。
import { api } from '../api.js';
import { store, toast, setBgRunning } from '../store.js';
import { onServerEvent } from '../sse.js';

const cards = new Map();   // askId -> { data, el, busy, multi, sel:Set<idx>, input }

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function initAskBox() {
  const composer = document.getElementById('composer');
  if (!composer || composer.dataset.askbox === '1') return;
  composer.dataset.askbox = '1';

  let host = document.getElementById('ask-box-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ask-box-host';
    host.className = 'ask-box-host';
    const field = composer.querySelector('.composer__field');
    if (field && field.parentNode) field.parentNode.insertBefore(host, field);
    else composer.insertBefore(host, composer.firstChild);
  }

  onServerEvent('ask-user', (d) => { if (d && d.askId) renderAsk(d, host); });
  onServerEvent('reconnect', () => restorePending(host));

  restorePending(host);

  window.__leizaiAskBoxRefresh = () => { pruneOthers(); restorePending(host); };
  return host;
}

function pruneOthers() {
  const cur = store.currentId;
  for (const [id, entry] of cards) {
    const sid = entry.data && entry.data.sessionId;
    if (cur && sid && sid !== cur) removeCard(id);
  }
}

async function restorePending(host) {
  if (!store.currentId) return;
  let r = null;
  try { r = await api.get('/api/ask/pending?sessionId=' + encodeURIComponent(store.currentId)); }
  catch { return; }   // 端点未就绪：静默降级
  const list = Array.isArray(r) ? r : ((r && (r.asks || r.pending || r.items)) || []);
  for (const d of list) if (d && d.askId) renderAsk(d, host);
}

function renderAsk(d, host) {
  if (!d || !d.askId || cards.has(d.askId)) return;
  if (d.sessionId && store.currentId && d.sessionId !== store.currentId) return;

  const multi = d.multi === true;
  const card = el('div', 'ask-box');
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', '主我询问');
  card.dataset.askId = d.askId;
  if (multi) card.classList.add('ask-box--multi');

  const entry = { data: d, el: card, busy: false, multi, sel: new Set(), input: null, submit: null };

  // ── 问题行 ──
  const head = el('div', 'ask-box__head');
  const icon = el('span', 'ask-box__icon', '❓'); icon.setAttribute('aria-hidden', 'true');
  head.appendChild(icon);
  head.appendChild(el('div', 'ask-box__q', d.question || '请选择'));
  card.appendChild(head);

  // ── 选项区 ──
  const opts = Array.isArray(d.options) ? d.options : [];
  const optEls = [];
  if (opts.length) {
    const box = el('div', 'ask-box__opts');
    box.setAttribute('role', multi ? 'group' : 'radiogroup');
    if (multi) box.setAttribute('aria-multiselectable', 'true');
    opts.forEach((o, i) => {
      const b = el('button', 'ask-opt');
      b.type = 'button';
      b.setAttribute('role', multi ? 'checkbox' : 'radio');
      b.setAttribute('aria-checked', 'false');
      const mark = el('span', 'ask-opt__mark'); mark.setAttribute('aria-hidden', 'true');
      const body = el('span', 'ask-opt__body');
      body.appendChild(el('span', 'ask-opt__label', o && o.label != null ? String(o.label) : ''));
      if (o && o.desc) body.appendChild(el('span', 'ask-opt__desc', String(o.desc)));
      b.append(mark, body);
      b.addEventListener('click', () => toggleOption(entry, i, optEls));
      // 双击单选选项 = 直接提交（保留一键手感）
      if (!multi) b.addEventListener('dblclick', () => submit(entry));
      optEls.push(b);
      box.appendChild(b);
    });
    card.appendChild(box);
  }

  // ── 底部：补充框 + 提交 + 跳过 ──
  const foot = el('div', 'ask-box__foot');
  if (d.allowFreeText !== false) {
    const wrap = el('div', 'ask-box__free');
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '补充说明（可选，回车提交）';
    input.setAttribute('aria-label', '补充回答');
    input.addEventListener('input', () => refreshSubmit(entry));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(entry); }
    });
    wrap.appendChild(input);
    entry.input = input;
    foot.appendChild(wrap);
  }
  const submitBtn = el('button', 'ask-submit', '提交');
  submitBtn.type = 'button';
  submitBtn.disabled = true;
  submitBtn.addEventListener('click', () => submit(entry));
  entry.submit = submitBtn;
  foot.appendChild(submitBtn);
  if (d.allowSkip !== false) {
    const sk = el('button', 'ask-skip', '跳过（不执行）');
    sk.type = 'button';
    sk.addEventListener('click', () => answer(entry, 'skip'));
    foot.appendChild(sk);
  }
  card.appendChild(foot);

  // Esc = 跳过（卡片内聚焦时）
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); answer(entry, 'skip'); }
  });

  entry.optEls = optEls;
  cards.set(d.askId, entry);
  host.appendChild(card);
  syncComposerState();
}

// ① 弹窗开合 ↔ 底部输入区显隐：有卡片时给 #composer 加 ask-box-open（CSS 隐藏 .composer__field），无卡片则移除。
function syncComposerState() {
  const c = document.getElementById('composer');
  if (!c) return;
  if (cards.size > 0) c.classList.add('ask-box-open');
  else c.classList.remove('ask-box-open');
}

function toggleOption(entry, i, optEls) {
  if (entry.busy) return;
  if (entry.multi) {
    if (entry.sel.has(i)) entry.sel.delete(i); else entry.sel.add(i);
  } else {
    entry.sel.clear();
    entry.sel.add(i);
  }
  for (let k = 0; k < optEls.length; k++) {
    const on = entry.sel.has(k);
    optEls[k].classList.toggle('is-selected', on);
    optEls[k].setAttribute('aria-checked', on ? 'true' : 'false');
  }
  refreshSubmit(entry);
}

function refreshSubmit(entry) {
  const hasOpt = entry.sel.size > 0;
  const hasText = !!(entry.input && entry.input.value.trim());
  if (entry.submit) entry.submit.disabled = !(hasOpt || hasText);
}

function selectedValues(entry) {
  const opts = Array.isArray(entry.data.options) ? entry.data.options : [];
  const out = [];
  for (const i of Array.from(entry.sel).sort((a, b) => a - b)) {
    const o = opts[i];
    if (!o) continue;
    out.push(o.value != null ? o.value : (o.label != null ? String(o.label) : ''));
  }
  return out;
}

// 合成提交：多选/单选有选项 → combo；仅文字 → text；跳过 → skip
function submit(entry) {
  if (!entry || entry.busy) return;
  const text = entry.input ? entry.input.value.trim() : '';
  const options = selectedValues(entry);
  if (!options.length && !text) { refreshSubmit(entry); return; }
  if (options.length) answer(entry, 'combo', { options, text });
  else answer(entry, 'text', text);
}

async function answer(entry, kind, payload) {
  if (!entry || entry.busy) return;
  entry.busy = true;
  entry.el.classList.add('is-answered');
  entry.el.querySelectorAll('button, input').forEach((n) => { n.disabled = true; });

  let body;
  if (kind === 'skip') body = { askId: entry.data.askId, kind: 'skip' };
  else if (kind === 'combo') body = { askId: entry.data.askId, kind: 'combo', options: payload.options || [], text: payload.text || '' };
  else body = { askId: entry.data.askId, kind: 'text', value: payload == null ? '' : payload };

  try {
    await api.post('/api/ask/answer', body);
    // 提交成功即乐观置忙：答案触发的是内部回合，客户端无 start 事件 → 立即亮"后台任务中…"（清理由 sse.js 的 turn-done clearBgRunning 负责）
    // v6.51：skip = 暂不执行/仅关闭弹窗（不触发回合）→ 不置忙，否则会残留"后台任务中"。
    if (kind !== 'skip') { try { setBgRunning(store.currentId, 'bg'); } catch { } }
  } catch (e) {
    entry.busy = false;
    entry.el.classList.remove('is-answered');
    if (entry.submit) entry.submit.disabled = false;
    if (entry.input) entry.input.disabled = false;
    toast('回答发送失败：' + ((e && e.message) || e), 'err');
    return;
  }
  removeCard(entry.data.askId);
}

function removeCard(askId) {
  const entry = cards.get(askId);
  if (!entry) return;
  cards.delete(askId);
  syncComposerState();
  const node = entry.el;
  node.classList.add('is-closing');
  setTimeout(() => { try { node.remove(); } catch { } }, 200);
}
