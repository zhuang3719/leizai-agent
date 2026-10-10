// A1 前端 · WebView2 原生能力桥（T-C1）
// 非 WebView2（普通浏览器）时降级：原生 op 全部禁用，返回 {ok:false, degraded:true}。
const hasWebView = !!(typeof window !== 'undefined' && window.chrome && window.chrome.webview && window.chrome.webview.postMessage);

let _seq = 0;
const _pending = new Map();

if (typeof window !== 'undefined' && window.chrome && window.chrome.webview) {
  window.chrome.webview.addEventListener('message', (e) => {
    let msg = null;
    try { msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!msg) return;
    if (msg.id && _pending.has(msg.id)) {
      const p = _pending.get(msg.id); _pending.delete(msg.id);
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error || 'bridge error'));
    } else if (msg.type) {
      // host 主动推送（预留）
      window.dispatchEvent(new CustomEvent('leizai-bridge', { detail: msg }));
    }
  });
}

function call(op, args, timeoutMs) {
  if (!hasWebView) return Promise.resolve({ ok: false, degraded: true });
  const id = ++_seq;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    try { window.chrome.webview.postMessage(JSON.stringify(Object.assign({ op, id }, args || {}))); }
    catch (e) { _pending.delete(id); reject(e); return; }
    setTimeout(() => { if (_pending.has(id)) { _pending.delete(id); reject(new Error('bridge 超时: ' + op)); } }, timeoutMs || 15000);
  });
}

// v6.55：无应答的一次性通知（fire-and-forget），用于 uiPainted 等埋点信号
function post(op, args) {
  if (!hasWebView) return;
  try { window.chrome.webview.postMessage(JSON.stringify(Object.assign({ op: op }, args || {}))); } catch (e) { }
}

export const bridge = {
  available: hasWebView,
  post,
  openPath: (path) => call('openPath', { path }),
  // 系统默认程序打开文件 / 在文件夹中显示（外壳可能未就绪，调用方需降级）
  openFile: (path) => call('openFile', { path }),
  revealPath: (path) => call('revealPath', { path }),
  openExternal: (url) => call('openExternal', { url }),
  // 读取本地文件 → { path, name, ext, size, mime, dataUrl }；过大/不存在时 dataUrl 缺失
  readFile: (path, maxBytes) => call('readFile', { path, maxBytes }, 30000),
  pickImage: () => call('pickImage', {}, 120000),
  notify: (title, body) => call('notify', { title, body }),
  window: (action) => call('window', { action }),
  backend: (action) => call('backend', { action }),
  // 手动检查更新：交给 shell 的 UpdateNotice.CheckNow（结果由客户端弹窗反馈）
  checkUpdate: () => call('checkUpdate', {}, 60000),
  // 查询更新状态（左栏版本号 → 「有新版本」醒目提示）
  updateStatus: () => call('updateStatus', {}),
  devtools: () => call('devtools', {}),
};
