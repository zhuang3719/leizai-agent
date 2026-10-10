// A1 前端 · 文件只读预览弹层（文本/代码 等宽显示；PDF 内嵌）——单例，供文件 chip 复用
// 依赖桥：bridge.readFile(path,maxBytes) → { dataUrl, mime, size, ... }（过大/不存在/无桥时 dataUrl 缺失）
import { bridge } from './bridge.js';
import { baseName } from './localpath.js';

const MAX_TEXT = 1024 * 1024;        // 文本预览上限 1MB
const MAX_PDF = 24 * 1024 * 1024;    // PDF 内嵌上限 24MB

let box = null, titleEl = null, noteEl = null, bodyEl = null, copyBtn = null;
let _copyValue = '';

function clip(txt) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt); return; } } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = txt; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  } catch { /* ignore */ }
}

function ensureBox() {
  if (box) return box;
  box = document.createElement('div');
  box.className = 'md-preview';
  box.hidden = true;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.innerHTML =
    '<div class="md-preview__panel">' +
      '<div class="md-preview__bar">' +
        '<span class="md-preview__name"></span>' +
        '<span class="md-preview__note"></span>' +
        '<button type="button" class="md-preview__copy" title="复制文件路径">复制路径</button>' +
        '<button type="button" class="md-preview__close" title="关闭（Esc）" aria-label="关闭">×</button>' +
      '</div>' +
      '<pre class="md-preview__body" tabindex="0"></pre>' +
    '</div>';
  titleEl = box.querySelector('.md-preview__name');
  noteEl = box.querySelector('.md-preview__note');
  bodyEl = box.querySelector('.md-preview__body');
  copyBtn = box.querySelector('.md-preview__copy');
  box.querySelector('.md-preview__close').addEventListener('click', closeFilePreview);
  box.addEventListener('click', (e) => { if (e.target === box) closeFilePreview(); });
  copyBtn.addEventListener('click', () => {
    if (!_copyValue) return;
    clip(_copyValue);
    const old = copyBtn.textContent;
    copyBtn.textContent = '已复制'; copyBtn.classList.add('is-ok');
    setTimeout(() => { copyBtn.textContent = old; copyBtn.classList.remove('is-ok'); }, 1200);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && box && !box.hidden) { e.preventDefault(); closeFilePreview(); }
  });
  document.body.appendChild(box);
  return box;
}

export function closeFilePreview() {
  if (!box) return;
  box.hidden = true;
  if (bodyEl) { bodyEl.textContent = ''; bodyEl.removeAttribute('data-embed'); }
}

function open(name, note, copyVal) {
  ensureBox();
  if (titleEl) titleEl.textContent = name || '';
  if (noteEl) noteEl.textContent = note || '';
  _copyValue = copyVal || '';
  if (copyBtn) copyBtn.hidden = !copyVal;
  box.hidden = false;
  return box;
}

function setNote(note) { if (noteEl) noteEl.textContent = note || ''; }
function setText(txt) { if (bodyEl) { bodyEl.removeAttribute('data-embed'); bodyEl.textContent = txt == null ? '' : String(txt); } }
function setEmbed(html) { if (bodyEl) { bodyEl.textContent = ''; bodyEl.setAttribute('data-embed', '1'); bodyEl.innerHTML = html; } }

function dataUrlToText(d) {
  const i = String(d || '').indexOf(',');
  const b64 = i >= 0 ? String(d).slice(i + 1) : '';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  return new TextDecoder('utf-8').decode(bytes);
}

function fmtSize(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + 'MB';
  if (b >= 1024) return Math.round(b / 1024) + 'KB';
  return b + 'B';
}

async function readFileSafe(path, maxBytes) {
  if (!bridge.available || typeof bridge.readFile !== 'function') return null;
  try { return await bridge.readFile(path, maxBytes); } catch { return null; }
}

/** 文本/代码只读预览：bridge.readFile → 等宽显示；过大/失败给提示不静默。 */
export async function openTextPreview(path, name) {
  open(name || baseName(path), '加载中…', path);
  setText('');
  const r = await readFileSafe(path, MAX_TEXT);
  if (!r || !r.dataUrl) { setNote('无法预览：文件过大（>' + fmtSize(MAX_TEXT) + '）或不存在 / 无桥'); return; }
  let text;
  try { text = dataUrlToText(r.dataUrl); } catch { setNote('解码失败'); return; }
  const trunc = Number(r.size) > MAX_TEXT;
  setNote(trunc ? '已截断（原始 ' + fmtSize(r.size) + '）' : '');
  setText(text);
}

/** PDF 内嵌预览（WebView2 原生 embed）。成功返回 true；失败返回 false 由调用方降级系统打开。 */
export async function openPdfPreview(path, name) {
  open(name || baseName(path), '加载中…', path);
  setText('');
  const r = await readFileSafe(path, MAX_PDF);
  if (!r || !r.dataUrl) { closeFilePreview(); return false; }
  setNote('');
  setEmbed('<embed class="md-preview__pdf" type="application/pdf" src="' + r.dataUrl + '">');
  return true;
}
