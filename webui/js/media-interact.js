// A1 前端 · 媒体 / 文件 / 链接 交互（P0+P1 统一委托层）
// markdown.js 只产标记，本文件负责全部交互与健壮性：
//   1) .md-link            点击 → bridge.openExternal(href)（无桥降级 window.open，仍阻止默认导航）
//   2) img.md-img          点击 → openImageLightbox(src)；video.md-video 点击 → openVideoLightbox(src)（原生控制条区域除外）
//   3) .md-file            点击/回车 → bridge.openPath(path)（目录=打开；文件=定位）
//   4) .md-code__copy      点击 → 复制代码（clipboard，降级 execCommand）
//   5) .md-code__toggle    点击 → 展开/收起长代码块
//   6) 媒体 onerror         → 友好占位（含本地"文件可能已移动"提示），不显示破图
//   7) 本地 media           data-local-src → bridge.readFile → dataUrl 水合；失败/超限/无桥降级为 chip
//   8) 滚动锚点            媒体加载改变高度时补偿滚动位置，避免对话窗口跳动
// 说明：WebView2 页面源为 http://127.0.0.1:<port>，Chromium 禁止从 http 源加载 file://，
//       故本地文件一律经 shell 桥 readFile 取回 dataUrl（见 shell/Bridge.cs OpReadFile）。
import { bridge } from './bridge.js';
import { openImageLightbox, openVideoLightbox } from './image-lightbox.js';
import { isLocal, localToPath as toLocalPath, baseName } from './localpath.js';
import { mediaKindOf } from './markdown.js';
import { openTextPreview, openPdfPreview } from './file-preview.js';

const MAX_IMG = 8 * 1024 * 1024;      // 图片：≤8MB 走 dataUrl
const MAX_MEDIA = 24 * 1024 * 1024;   // 音视频：≤24MB 走 dataUrl

// 同一路径只读一次
const _cache = new Map();
function resolveLocalSrc(path, maxBytes) {
  const key = path + '|' + maxBytes;
  if (_cache.has(key)) return _cache.get(key);
  const p = (async () => {
    if (!bridge.available || typeof bridge.readFile !== 'function') return null;
    try {
      const r = await bridge.readFile(path, maxBytes);
      return (r && r.dataUrl) ? r.dataUrl : null;   // 过大 / 不存在 / 非文件
    } catch { return null; }
  })();
  _cache.set(key, p);
  return p;
}

function makeChip(path, play) {
  const el = document.createElement('span');
  el.className = 'md-file' + (play ? ' md-file--play' : '');
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('data-path', path);
  el.setAttribute('title', (play ? '▶ 用系统播放器打开：' : '点击打开：') + path);
  el.setAttribute('aria-label', (play ? '用系统播放器打开 ' : '打开文件 ') + path);
  const ico = document.createElement('span');
  ico.className = 'md-file__ico'; ico.setAttribute('aria-hidden', 'true');
  const nm = document.createElement('span');
  nm.className = 'md-file__n'; nm.textContent = (play ? '▶ ' : '') + baseName(path);
  const tx = document.createElement('span');
  tx.className = 'md-file__p'; tx.textContent = play ? '用系统播放器打开' : path;
  el.appendChild(ico); el.appendChild(nm); el.appendChild(tx);
  return el;
}

/** 媒体加载失败 → 友好占位（不显示破图） */
function mediaFallback(el) {
  if (!el || el.__mdFallback) return;
  el.__mdFallback = true;
  const src = el.getAttribute('data-local-src') || el.getAttribute('src') || el.getAttribute('title') || '';
  const name = el.getAttribute('data-name') || src;
  const local = isLocal(src);
  const unsupported = el.getAttribute('data-unsupported') === '1';
  const box = document.createElement('div');
  box.className = 'md-media-fail' + (local ? ' md-media-fail--local' : '');
  box.setAttribute('role', 'note');
  const ico = document.createElement('span');
  ico.className = 'md-media-fail__ico'; ico.setAttribute('aria-hidden', 'true');
  const tx = document.createElement('span');
  tx.className = 'md-media-fail__t';
  let msg = '无法加载：' + (baseName(name) || '媒体');
  if (unsupported) msg += '（浏览器可能不支持该格式）';
  else if (local) msg += '（文件可能已移动）';
  tx.textContent = msg;
  box.appendChild(ico); box.appendChild(tx);
  if (local) {   // 健壮兜底：本地媒体不可播 → 可点「▶ 用系统播放器打开」
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'md-media-fail__open';
    btn.setAttribute('data-path', src);
    btn.setAttribute('title', '用系统播放器打开：' + src);
    btn.textContent = '▶ 用系统播放器打开';
    box.appendChild(btn);
  }
  el.replaceWith(box);
}

/** 把 data-local-src 的图片/音视频水合为可直接用的 src；失败降级为路径 chip。 */
export async function hydrateLocalMedia(root) {
  const scope = root || document;
  const nodes = scope.querySelectorAll(
    'img.md-img[data-local-src]:not([src]), video.md-video[data-local-src]:not([src]), audio.md-audio[data-local-src]:not([src])'
  );
  for (const el of nodes) {
    const path = el.getAttribute('data-local-src');
    if (!path) continue;
    const isAudio = el.tagName === 'AUDIO';
    const url = await resolveLocalSrc(path, isAudio ? MAX_MEDIA : MAX_IMG);
    if (url && el.isConnected) {
      el.setAttribute('src', url);
    } else if (el.isConnected) {
      // 健壮兜底：本地音/视频水合失败（读文件失败/超限/无桥）→ 可点「▶ 用系统播放器打开」，保证总能播
      const k = mediaKindOf(path);
      el.replaceWith(makeChip(toLocalPath(path), k === 'audio' || k === 'video'));
    }
  }
}

/** 离屏/远程媒体加载后若改变高度，补偿滚动位置（防止对话窗口跳动） */
function compensateScroll(el) {
  if (!el || !el.isConnected) return;
  // 元素顶部在视口上方时，其高度变化才会顶动可视区内容
  const before = el.getBoundingClientRect().top;
  if (before > 0) return;
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    const after = el.getBoundingClientRect().top;
    const d = after - before;
    if (!d) return;
    let sc = el.parentElement;
    while (sc && sc !== document.body) {
      const st = getComputedStyle(sc);
      if (/(auto|scroll)/.test(st.overflowY) && sc.scrollHeight > sc.clientHeight + 1) break;
      sc = sc.parentElement;
    }
    const target = (sc && sc !== document.body) ? sc : (document.scrollingElement || document.documentElement);
    target.scrollTop += d;
  });
}

function openPathOrCopy(path) {
  if (bridge.available) { bridge.openPath(path).catch(() => {}); return; }
  try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(path); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('leizai-media-copied', { detail: { path } }));
}

// ===== 文件 chip 按类型"打开"分发（v6.24）=====
// 文本/代码扩展名 → 应用内只读预览；图片 → 灯箱；pdf → 内嵌；其他 → 系统默认；无扩展名/疑似目录 → openPath
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'log', 'json', 'jsonl', 'csv', 'tsv', 'py', 'js', 'mjs', 'cjs',
  'ts', 'jsx', 'tsx', 'cs', 'java', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'html', 'htm',
  'css', 'scss', 'less', 'xml', 'yml', 'yaml', 'ini', 'conf', 'toml', 'bat', 'cmd',
  'ps1', 'sh', 'sql', 'env',
]);
function extOfPath(p) { const m = String(p == null ? '' : p).match(/\.([a-z0-9]+)$/i); return m ? m[1].toLowerCase() : ''; }

function copyPathFallback(path) {
  copyText(path).then((ok) => window.dispatchEvent(new CustomEvent('leizai-media-copied', { detail: { path, ok } })));
}
function openPathByShell(path) {
  if (!bridge.available) { copyPathFallback(path); return; }
  bridge.openPath(path).catch(() => copyPathFallback(path));
}
function openFileByShell(path) {
  if (!bridge.available) { copyPathFallback(path); return; }
  if (typeof bridge.openFile !== 'function') { openPathByShell(path); return; }   // 外壳未就绪 → 降级
  bridge.openFile(path).catch(() => copyPathFallback(path));
}
function revealByShell(path) {
  if (bridge.available && typeof bridge.revealPath === 'function') { bridge.revealPath(path).catch(() => openPathByShell(path)); return; }
  openPathByShell(path);                                                          // 外壳未就绪 → 降级
}

async function activateFile(path) {
  if (!path) return;
  const ext = extOfPath(path);
  const kind = mediaKindOf(path);                    // image|audio|video|file|''
  if (kind === 'image') {
    const url = await resolveLocalSrc(path, MAX_IMG);
    if (url) { openImageLightbox(url); return; }
    openFileByShell(path); return;
  }
  if (kind === 'audio' || kind === 'video') { openFileByShell(path); return; }   // 播放器已内嵌渲染
  if (ext === 'pdf') { const ok = await openPdfPreview(path); if (!ok) openFileByShell(path); return; }
  if (TEXT_EXTS.has(ext)) { openTextPreview(path); return; }
  if (!ext) { openPathByShell(path); return; }       // 无扩展名 → 疑似目录
  openFileByShell(path);                             // 其他二进制/文档 → 系统默认
}

// ===== 文件 chip 右键菜单 =====
let _menu = null;
function ensureMenu() {
  if (_menu) return _menu;
  _menu = document.createElement('div');
  _menu.className = 'md-ctxmenu';
  _menu.hidden = true;
  _menu.setAttribute('role', 'menu');
  _menu.innerHTML =
    '<button type="button" role="menuitem" data-act="open">系统打开</button>' +
    '<button type="button" role="menuitem" data-act="reveal">在文件夹中显示</button>' +
    '<button type="button" role="menuitem" data-act="copy">复制路径</button>';
  _menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const p = _menu.__path;
    const act = btn.getAttribute('data-act');
    hideMenu();
    if (act === 'open') openFileByShell(p);
    else if (act === 'reveal') revealByShell(p);
    else copyPathFallback(p);
  });
  document.body.appendChild(_menu);
  return _menu;
}
function showMenu(path, x, y) {
  const m = ensureMenu();
  m.__path = path; m.hidden = false;
  m.style.left = '0px'; m.style.top = '0px';
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(4, Math.min(x, (window.innerWidth || 0) - w - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(y, (window.innerHeight || 0) - h - 6)) + 'px';
}
function hideMenu() { if (_menu) _menu.hidden = true; }
function onContextMenu(e) {
  const f = e.target && e.target.closest && e.target.closest('.md-file[data-path]');
  if (!f) return;
  e.preventDefault();
  showMenu(f.getAttribute('data-path'), e.clientX, e.clientY);
}

function onLink(a, e) {
  const href = a.getAttribute('href') || '';
  if (!href) return;
  e.preventDefault();
  e.stopPropagation();
  if (isLocal(href)) { openPathOrCopy(toLocalPath(href)); return; }
  if (bridge.available) bridge.openExternal(href).catch(() => { try { window.open(href, '_blank', 'noopener'); } catch { } });
  else { try { window.open(href, '_blank', 'noopener'); } catch { } }
}

async function copyText(txt) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(txt); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = txt; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

function flashCopied(btn, ok) {
  if (!btn) return;
  const old = btn.textContent;
  btn.textContent = ok ? '已复制' : '复制失败';
  btn.classList.toggle('is-ok', !!ok);
  setTimeout(() => { btn.textContent = old; btn.classList.remove('is-ok'); }, 1200);
}

function onClick(e) {
  const t = e.target;
  if (!t || typeof t.closest !== 'function') return;
  hideMenu();

  // 代码块：复制
  const cp = t.closest('.md-code__copy');
  if (cp) {
    e.preventDefault(); e.stopPropagation();
    const box = cp.closest('.md-code');
    const code = box && box.querySelector('pre.md-pre code');
    copyText(code ? code.textContent : '').then((ok) => flashCopied(cp, ok));
    return;
  }
  // 代码块：展开/收起
  const tg = t.closest('.md-code__toggle');
  if (tg) {
    e.preventDefault(); e.stopPropagation();
    const box = tg.closest('.md-code');
    if (!box) return;
    const collapsed = box.getAttribute('data-collapsed') === '1';
    box.setAttribute('data-collapsed', collapsed ? '0' : '1');
    tg.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
    const n = box.getAttribute('data-lines') || '';
    tg.textContent = collapsed ? '收起' : ('展开（共 ' + n + ' 行）');
    return;
  }

  const fileEl = t.closest('.md-file[data-path]');
  if (fileEl) { e.preventDefault(); e.stopPropagation(); hideMenu(); activateFile(fileEl.getAttribute('data-path')); return; }

  // 本地媒体加载失败占位里的「▶ 用系统播放器打开」
  const failOpen = t.closest('.md-media-fail__open[data-path]');
  if (failOpen) { e.preventDefault(); e.stopPropagation(); hideMenu(); activateFile(failOpen.getAttribute('data-path')); return; }

  const img = t.closest('img.md-img');
  if (img) {
    const src = img.getAttribute('src');
    if (src) { e.preventDefault(); e.stopPropagation(); openImageLightbox(src); }
    else { hydrateLocalMedia(img.parentNode || document); }   // 尚未水合：点一下补一次
    return;
  }

  // 视频：点缩略视频 → 全屏灯箱观看；点原生控制条区域（底部约44px）不触发，交播放器
  const vid = t.closest('video.md-video');
  if (vid) {
    const rect = vid.getBoundingClientRect ? vid.getBoundingClientRect() : null;
    const onControls = !!(rect && rect.height > 0 && typeof e.clientY === 'number'
      && (e.clientY - rect.top) > (rect.height - 44));
    if (!onControls) {
      const src = vid.getAttribute('src') || vid.currentSrc;
      if (src) { e.preventDefault(); e.stopPropagation(); openVideoLightbox(src); }
      else { hydrateLocalMedia(vid.parentNode || document); }   // 尚未水合：点一下补一次
    }
    return;
  }

  const link = t.closest('a.md-link');
  if (link) { onLink(link, e); return; }
}

function onKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target;
  if (!t || typeof t.closest !== 'function') return;
  hideMenu();
  const fileEl = t.closest('.md-file[data-path]') || t.closest('.md-media-fail__open[data-path]');
  if (fileEl) { e.preventDefault(); activateFile(fileEl.getAttribute('data-path')); }
}

function onMediaError(e) {
  const el = e.target;
  if (el && el.matches && el.matches('img.md-img, video.md-video, audio.md-audio')) mediaFallback(el);
}
function onMediaSettled(e) {
  const el = e.target;
  if (el && el.matches && el.matches('img.md-img, video.md-video, audio.md-audio')) compensateScroll(el);
}

let _obs = null;
/** 安装统一委托 + DOM 观察（对 v-html 动态渲染的本地媒体自动水合）。幂等，可重复调用。 */
export function initMediaInteract() {
  if (typeof window === 'undefined') return;
  if (window.__leizaiMediaInteract) return;
  window.__leizaiMediaInteract = true;

  document.addEventListener('click', onClick, false);
  document.addEventListener('keydown', onKeydown, false);
  document.addEventListener('contextmenu', onContextMenu, false);
  window.addEventListener('scroll', hideMenu, true);
  // error 不冒泡 → capture；媒体加载完成用 load/loadedmetadata/loadeddata
  document.addEventListener('error', onMediaError, true);
  document.addEventListener('load', onMediaSettled, true);
  document.addEventListener('loadedmetadata', onMediaSettled, true);
  document.addEventListener('loadeddata', onMediaSettled, true);

  hydrateLocalMedia(document);
  try {
    _obs = new MutationObserver((muts) => {
      let dirty = false;
      for (const m of muts) { if (m.addedNodes && m.addedNodes.length) { dirty = true; break; } }
      if (dirty) hydrateLocalMedia(document);
    });
    _obs.observe(document.documentElement || document.body, { childList: true, subtree: true });
  } catch { /* 观察器不可用则退化为首屏水合 */ }
}
