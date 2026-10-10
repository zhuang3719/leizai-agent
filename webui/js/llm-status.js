// 任务B · 模型接口不可用时窗口内提示（雷影·程序员）
// 职责：①常驻横幅 #llm-banner（不自动消失，带原因 + 重试 + 关闭）
//       ②底部状态栏"模型正常/异常"（store.llm，由 app.js updateStatus 渲染）
//       ③首屏探活 + 每 60s 探活（页面隐藏暂停）/api/llm-health
// 依赖方向：app.js/sse.js → 本模块 → api.js/store.js（无环）。
import { api } from './api.js';
import { store, toast } from './store.js';

const BANNER_ID = 'llm-banner';
const PROBE_MS = 60000;
let _failStreak = 0;      // 连续失败次数（用于"已重试 N 次"）
let _userClosed = false;  // 用户点过"关闭" → 抑制重复弹出，直到一次成功
let _probeTimer = null;
let _inited = false;
let _lastProbe = null;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function bannerEl() { return document.getElementById(BANNER_ID); }

function hideLlmBanner() {
  const el = bannerEl();
  if (el) { el.hidden = true; el.classList.remove('is-open'); }
}

/** 显示常驻横幅（不自动消失）。 */
export function showLlmBanner(info) {
  const el = bannerEl();
  if (!el) return;
  const d = info || {};
  if (_userClosed && !(d.needsUserAction)) return;   // 用户已手动关闭 → 不打扰；但"需用户处理"（402/401）不受抑制（v6.37）
  const why = d.reasonText || d.reason || '模型服务不可用';
  const n = d.failStreak || _failStreak || 1;
  // v6.37：needsUserAction（402 欠费/401 鉴权）→ 不显示"重试"按钮（重试无用），只留"关闭"，并改口径。
  const needs = !!d.needsUserAction;
  const sub = needs ? '· 需处理后重新发送' : `· 已重试 ${n} 次`;
  // v6.61：缺 API Key（reason=no-key / 文案含 API Key）→ 横幅内追加"去设置"引导（直达控制台·大模型配置）。
  const noKey = String(d.reason || '') === 'no-key' || /API\s*Key/i.test(String(why));
  const hint = noKey ? '<br><span class="llm-banner__hint">请点「去设置」→ 控制台「大模型配置」填写 API Key 后再试。</span>' : '';
  const retryBtn = needs ? '' : '<button type="button" class="llm-banner__btn" data-act="retry">重试</button>';
  const setBtn = '<button type="button" class="llm-banner__btn llm-banner__btn--primary" data-act="settings">去设置</button>';
  el.innerHTML = `<div class="llm-banner__inner">
    <span class="llm-banner__icon" aria-hidden="true">⚠</span>
    <span class="llm-banner__text"><b>模型服务不可用</b>（${esc(why)}）${sub}${hint}</span>
    ${setBtn}
    ${retryBtn}
    <button type="button" class="llm-banner__btn llm-banner__btn--ghost" data-act="close">关闭</button>
  </div>`;
  el.hidden = false;
  el.classList.add('is-open');
}

/** SSE 'llm-status'（引擎每次 LLM 调用成功/失败广播）→ 更新横幅 + 状态栏。 */
export function handleLlmStatus(d) {
  if (!d) return;
  if (d.ok) {
    _failStreak = 0; _userClosed = false;
    store.llm = { ok: true, reason: null, reasonText: null, at: d.at || Date.now(), failStreak: 0 };
    hideLlmBanner();
  } else {
    _failStreak += 1;
    store.llm = { ok: false, reason: d.reason || 'unknown', reasonText: d.reasonText || null, needsUserAction: !!d.needsUserAction, at: d.at || Date.now(), failStreak: _failStreak };
    showLlmBanner({ reasonText: d.reasonText, reason: d.reason, needsUserAction: !!d.needsUserAction, failStreak: _failStreak });
  }
}

/** 本回合 error 帧带 llmUnavailable → 立即横幅（气泡内已有说明，由 sse.js 追加）。 */
export function showLlmUnavailable(data) {
  const d = data || {};
  _failStreak = Math.max(_failStreak, 1);
  store.llm = { ok: false, reason: d.llmReason || 'unknown', reasonText: d.llmReasonText || null, needsUserAction: !!d.needsUserAction, at: Date.now(), failStreak: _failStreak };
  showLlmBanner({ reasonText: d.llmReasonText, reason: d.llmReason, needsUserAction: !!d.needsUserAction, failStreak: _failStreak });
}

/** 探活（GET /api/llm-health，服务端 30s 缓存）。refresh=true 强制刷新。返回探活结果。 */
export async function probeLlmHealth(refresh) {
  let r = null;
  try {
    r = await api.llmHealth(!!refresh);
  } catch (e) {
    r = { ok: false, reason: 'network', reasonText: '无法连接本地引擎：' + ((e && e.message) || e), retryable: true };
  }
  _lastProbe = r;
  if (r && r.ok) {
    const wasDown = !!(store.llm && store.llm.ok === false);
    _failStreak = 0; _userClosed = false;
    store.llm = { ok: true, reason: null, reasonText: null, at: Date.now(), failStreak: 0 };
    hideLlmBanner();
    if (refresh && wasDown) { try { toast('模型服务已恢复', 'ok'); } catch { } }
  } else if (r) {
    _failStreak = Math.max(_failStreak, 1);
    store.llm = { ok: false, reason: r.reason, reasonText: r.reasonText || null, at: Date.now(), failStreak: _failStreak };
    if (refresh) showLlmBanner({ reasonText: r.reasonText, reason: r.reason, failStreak: _failStreak });
  }
  // 状态栏由 app.js 的 updateStatus 渲染；这里主动触发一次，避免等 15s 周期
  try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('leizai-llm-probe', { detail: r })); } catch { }
  return r;
}

function onBannerClick(e) {
  const btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
  if (!btn) return;
  const act = btn.getAttribute('data-act');
  if (act === 'close') { _userClosed = true; hideLlmBanner(); }
  else if (act === 'settings') {
    // v6.61：直达控制台（同 Ctrl+6）——复用既有 leizai-open-berth 事件通道（app.js setBerth）
    try { window.dispatchEvent(new CustomEvent('leizai-open-berth', { detail: 'console' })); } catch { }
  }
  else if (act === 'retry') {
    btn.disabled = true;
    Promise.resolve(probeLlmHealth(true)).finally(() => { try { btn.disabled = false; } catch { } });
  }
}

/** 启动：首屏探活 + 每 60s 探活（页面隐藏暂停）+ 横幅按钮绑定。幂等。 */
export function initLlmStatus() {
  if (_inited) return;
  _inited = true;
  const el = bannerEl();
  if (el) el.addEventListener('click', onBannerClick);
  probeLlmHealth(false);
  _probeTimer = setInterval(() => {
    try { if (document.hidden) return; } catch { }
    probeLlmHealth(false);
  }, PROBE_MS);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) probeLlmHealth(false); });
  }
}
