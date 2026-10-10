// A1 前端 · Markdown 渲染（T-C2）
// 支持：标题 / 代码块(折叠+复制) / 表格(横向滚动) / 有序无序列表 / 链接(裸URL自动链接化) /
//       图片 / 视频 / 音频 / 通用文件 chip / 引用 / 行内代码 / 粗斜体 / 分隔线。
// 约定：本文件只产标记（HTML 字符串，已转义）；全部交互（点击/复制/折叠/媒体失败占位）由 media-interact.js 统一委托。
import { isLocal as isLocalPath, localToPath, baseName } from './localpath.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ===== 媒体 / 文件 类型总表（按扩展名分派）=====
const EXT_SETS = {
  audio: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus', 'wma'],
  video: ['mp4', 'webm', 'ogv', 'mov', 'mkv', 'avi', 'm4v'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'apng'],
  file: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'rar', '7z', 'tar', 'gz',
    'txt', 'csv', 'json', 'jsonl', 'md', 'log', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
    'cs', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'html', 'htm', 'xml', 'yml', 'yaml',
    'ini', 'conf', 'bat', 'ps1', 'sh', 'sql', 'db', 'exe', 'msi', 'env'],
};
const EXT_MAP = {};
for (const k in EXT_SETS) for (const e of EXT_SETS[k]) EXT_MAP[e] = k;

// 浏览器普遍不支持的容器（给出降级提示，不静默失败）
const VIDEO_UNSUPPORTED = ['mkv', 'avi', 'mov', 'ogv', 'wmv', 'flv'];

function extOf(url) {
  const u = String(url == null ? '' : url).replace(/[?#].*$/, '');
  const m = u.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}
/** 'audio' | 'video' | 'image' | 'file' | '' */
function kindOf(url) { return EXT_MAP[extOf(url)] || ''; }

function isHttpUrl(u) { return /^https?:\/\//i.test(String(u || '')); }

// 裸本地绝对路径（含空格、以 .ext 结尾、右侧词边界）
const RE_BARE_PATH = /(?<![\w\\/])((?:[a-zA-Z]:[\\/]|\\\\)[^\r\n\t<>"|?*]+?\.[a-zA-Z0-9]{1,6})(?=$|[\s,;:&)\]}>）】」，。、！？'"‘’“”])/g;
// 裸媒体 URL（http(s) 且以媒体扩展名结尾，含可选 ?query）——扩展名列表从 EXT_SETS 派生，消除第二份内嵌列表漂移
const MEDIA_EXTS = [].concat(EXT_SETS.audio, EXT_SETS.video, EXT_SETS.image).join('|');
const RE_BARE_MEDIA_URL = new RegExp('(?<![\\w\\/=@])(https?:\\/\\/[^\\s<>"\')]+?\\.(?:' + MEDIA_EXTS + ')(?:[?#][^\\s<>"\')]*)?)', 'gi');
// 裸 http(s) 链接（非媒体，媒体已被上一条消化）
const RE_BARE_URL = /(?<![\w/=@])(https?:\/\/[^\s<>"')]+)/g;

function mediaTitle(url, label) {
  const lb = label && label !== url ? label + '：' : '';
  return ' title="' + lb + url + '"';
}

// 音频（本地走 data-local-src，由 media-interact.js 经 bridge.readFile 水合）
function audioTag(url, label) {
  const t = mediaTitle(url, label);
  if (isLocalPath(url)) return '<audio class="md-audio" data-media="1" data-local-src="' + url + '" preload="metadata" controls' + t + '></audio>';
  return '<audio class="md-audio" data-media="1" src="' + url + '" preload="metadata" controls' + t + '></audio>';
}
// 视频（不支持容器加 data-unsupported 提示）
function videoTag(url, label) {
  const t = mediaTitle(url, label);
  const warn = VIDEO_UNSUPPORTED.indexOf(extOf(url)) >= 0 ? ' data-unsupported="1"' : '';
  if (isLocalPath(url)) return '<video class="md-video" data-media="1" data-local-src="' + url + '"' + warn + ' preload="metadata" controls' + t + '></video>';
  return '<video class="md-video" data-media="1" src="' + url + '"' + warn + ' preload="metadata" controls' + t + '></video>';
}
// 图片（本地 svg 也用 img 标签，绝不 inline，避免脚本执行）
function imgTag(alt, url) {
  const k = kindOf(url);
  if (k === 'audio') return audioTag(url, alt);
  if (k === 'video') return videoTag(url, alt);
  const nm = alt ? ' data-name="' + alt + '"' : '';
  if (isLocalPath(url)) {
    return '<img class="md-img md-img--local" data-media="1" data-local-src="' + url + '"' + nm + ' alt="' + alt + '" loading="lazy">';
  }
  return '<img class="md-img" data-media="1" src="' + url + '"' + nm + ' alt="' + alt + '" loading="lazy">';
}
// 通用文件 chip（点击 → bridge.openPath；类型图标由 data-ext 驱动）
function fileChip(path, label) {
  const p = String(path == null ? '' : path);
  const lb = String(label == null ? '' : label);
  const name = baseName(p);
  const ext = extOf(p);
  const show = (lb && lb !== p && lb !== name) ? lb : name;
  return '<span class="md-file" role="button" tabindex="0" data-path="' + p + '" data-ext="' + esc(ext) + '"'
    + ' title="点击打开：' + p + '" aria-label="打开文件 ' + p + '">'
    + '<span class="md-file__ico" data-ext="' + esc(ext) + '" aria-hidden="true"></span>'
    + '<span class="md-file__n">' + show + '</span>'
    + '<span class="md-file__p">' + p + '</span></span>';
}
// 链接（媒体扩展 → 对应媒体标签；本地路径 → 文件 chip；其余 → 外链，点击委托交给 bridge.openExternal）
function linkTag(txt, url) {
  const k = kindOf(url);
  if (k === 'audio') return audioTag(url, txt);
  if (k === 'video') return videoTag(url, txt);
  if (k === 'image') return imgTag(txt, url);
  if (isLocalPath(url)) return fileChip(localToPath(url), txt);
  return '<a class="md-link" href="' + url + '" target="_blank" rel="noopener noreferrer" title="' + url + '">' + txt + '</a>';
}

// 行内代码「整串恰好=一个媒体路径/URL」→ 默认渲染为媒体/文件；否则维持代码保护（防把真代码片段误当媒体）
const RE_INLINE_URL_FULL = /^https?:\/\/\S+$/i;
const RE_INLINE_PATH_FULL = /^(?:[a-zA-Z]:[\\/]|\\\\)[^\r\n<>"|?*]+?\.[a-zA-Z0-9]{1,6}$/;
function inlineMediaOrCode(c) {
  const code = '<code class="md-inline">' + c + '</code>';
  const s = String(c == null ? '' : c).trim();
  if (!s || /[\r\n`]/.test(s)) return code;                 // 多行/空/含反引号 → 保持代码
  let target = null, local = false;
  if (RE_INLINE_URL_FULL.test(s)) target = s;               // (a) 整串 http(s) URL（禁空格）
  else if (RE_INLINE_PATH_FULL.test(s)) { target = s; local = true; }  // (b) 整串本地路径（禁 <>"|?*）
  if (!target || !kindOf(target)) return code;              // 扩展名非媒体/文件 → 保持代码
  const k = kindOf(target);
  if (k === 'audio') return audioTag(target, '');
  if (k === 'video') return videoTag(target, '');
  if (k === 'image') return imgTag('', target);
  return fileChip(local ? localToPath(target) : target, '');
}

function inline(text) {
  let t = esc(text);
  const stash = [];
  const keep = (html) => { stash.push(html); return '\u0000' + (stash.length - 1) + '\u0000'; };

  // 行内代码（最高优先）：整串恰为媒体路径/URL → 默认渲染媒体；否则整体保护为代码
  t = t.replace(/`([^`]+)`/g, (m, c) => keep(inlineMediaOrCode(c)));
  // 图片 ![alt](url) / 链接 [text](url)
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => keep(imgTag(alt, url)));
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) => keep(linkTag(txt, url)));
  // 裸媒体 URL（http…/x.mp4|mp3|png…）
  t = t.replace(RE_BARE_MEDIA_URL, (m) => {
    const k = kindOf(m);
    return keep(k === 'audio' ? audioTag(m, '') : k === 'image' ? imgTag('', m) : videoTag(m, ''));
  });
  // 裸 http(s) 链接（非媒体）→ .md-link
  t = t.replace(RE_BARE_URL, (m) => {
    let url = m, tail = '';
    const tm = url.match(/[.,;:!?)\]}）】》」』]+$/);   // 尾随标点不属 URL
    if (tm) { tail = tm[0]; url = url.slice(0, -tail.length); }
    return keep('<a class="md-link" href="' + url + '" target="_blank" rel="noopener noreferrer" title="' + url + '">' + url + '</a>') + tail;
  });
  // 裸本地绝对路径（X:\…\name.ext / X:/…）→ 按扩展名分派：媒体走媒体标签(本地用 data-local-src)，其余走文件 chip
  t = t.replace(RE_BARE_PATH, (m) => {
    const p = localToPath(m);
    const k = kindOf(p);
    if (k === 'audio') return keep(audioTag(p, ''));
    if (k === 'video') return keep(videoTag(p, ''));
    if (k === 'image') return keep(imgTag('', p));
    return keep(fileChip(p, ''));
  });

  // 粗体 / 斜体 / 删除线（此时正文只剩占位符，不受 HTML 属性干扰）
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  t = t.replace(/\u0000(\d+)\u0000/g, (m, i) => { const h = stash[Number(i)]; return h == null ? '' : h; });
  return t;
}

function renderTable(lines) {
  const rows = lines.map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  if (rows.length < 2) return '';
  const head = rows[0];
  const body = rows.slice(2);
  let html = '<table class="md-table"><thead><tr>';
  for (const h of head) html += '<th>' + inline(h) + '</th>';
  html += '</tr></thead><tbody>';
  for (const r of body) {
    html += '<tr>';
    for (let i = 0; i < head.length; i++) html += '<td>' + inline(r[i] || '') + '</td>';
    html += '</tr>';
  }
  return html + '</tbody></table>';
}

const CODE_COLLAPSE_LINES = 24;

/** 代码块：视听语言直接出播放器；其余出「折叠+复制」代码卡片。 */
function codeBlock(raw, lang) {
  const L = String(lang || '').toLowerCase();
  const u = esc(String(raw || '').trim());
  if (L === 'audio' || EXT_SETS.audio.indexOf(L) >= 0) return audioTag(u, '');
  if (L === 'video' || EXT_SETS.video.indexOf(L) >= 0) return videoTag(u, '');
  // 3(a) 去格式依赖：围栏块「整块仅由本地媒体路径组成」（1+ 行）→ 直接渲染为媒体；其它代码块不动。
  const onlyPaths = String(raw || '').split('\n').map((x) => x.trim()).filter(Boolean);
  if (onlyPaths.length && onlyPaths.every((p) => isLocalPath(p) && ['audio', 'video', 'image'].indexOf(kindOf(p)) >= 0)) {
    return onlyPaths.map((p) => {
      const k = kindOf(p);
      return k === 'audio' ? audioTag(p, '') : k === 'video' ? videoTag(p, '') : imgTag('', p);
    }).join('\n');
  }
  const n = String(raw == null ? '' : raw).split('\n').length;
  const collapsed = n > CODE_COLLAPSE_LINES ? '1' : '0';
  const label = lang ? String(lang).toUpperCase() : 'CODE';
  let html = '<div class="md-code" data-collapsed="' + collapsed + '" data-lines="' + n + '">'
    + '<div class="md-code__bar"><span class="md-code__lang">' + esc(label) + '</span>'
    + '<button class="md-code__copy" type="button" title="复制代码" aria-label="复制代码">复制</button></div>'
    + '<pre class="md-pre" data-lang="' + esc(lang) + '"><code>' + esc(raw) + '</code></pre>';
  if (n > CODE_COLLAPSE_LINES) {
    html += '<button class="md-code__toggle" type="button" aria-expanded="false">展开（共 ' + n + ' 行）</button>';
  }
  return html + '</div>';
}

/**
 * 渲染 markdown → HTML。
 * @param {string} src
 * @returns {string}
 */
export function renderMarkdown(src) {
  if (!src) return '';
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let listType = null;
  const closeList = () => { if (listType) { out.push('</' + listType + '>'); listType = null; } };

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      closeList();
      const lang = fence[1] || '';
      i++;
      const buf = [];
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // skip closing fence
      out.push(codeBlock(buf.join('\n'), lang));
      continue;
    }

    // 表格（当前行含 | 且下一行是分隔行）
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      closeList();
      const tbl = [];
      while (i < lines.length && /\|/.test(lines[i])) { tbl.push(lines[i]); i++; }
      out.push('<div class="md-table-wrap">' + renderTable(tbl) + '</div>');
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out.push('<h' + h[1].length + ' class="md-h">' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeList(); out.push('<hr class="md-hr">'); i++; continue; }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push('<blockquote class="md-quote">' + renderMarkdown(buf.join('\n')) + '</blockquote>');
      continue;
    }

    // 列表
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      const type = ul ? 'ul' : 'ol';
      if (listType !== type) { closeList(); out.push('<' + type + ' class="md-list">'); listType = type; }
      out.push('<li>' + inline((ul || ol)[1]) + '</li>');
      i++; continue;
    }

    // 空行
    if (/^\s*$/.test(line)) { closeList(); i++; continue; }

    // 段落
    closeList();
    const buf = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*```/.test(lines[i]) && !/^\s*[-*+]\s/.test(lines[i]) && !/^\s*\d+\.\s/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !(/\|/.test(lines[i]) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1]))) {
      buf.push(lines[i]); i++;
    }
    out.push('<p>' + buf.map(inline).join('<br>') + '</p>');
  }
  closeList();
  return out.join('\n');
}

/**
 * 用户气泡文本渲染（3(b)）：默认纯文本转义；仅把「独立的本地媒体路径 / 裸媒体 URL」升级为媒体标签，
 * 其余保持纯文本。用于 user 气泡（不再只 esc，粘贴一条本地音/视频路径也能直接看/听）。
 */
export function renderUserContent(text) {
  let t = esc(text);
  const stash = [];
  const keep = (html) => { stash.push(html); return '\u0000' + (stash.length - 1) + '\u0000'; };
  t = t.replace(RE_BARE_MEDIA_URL, (m) => {
    const k = kindOf(m);
    return keep(k === 'audio' ? audioTag(m, '') : k === 'image' ? imgTag('', m) : videoTag(m, ''));
  });
  t = t.replace(RE_BARE_PATH, (m) => {
    const p = localToPath(m);
    const k = kindOf(p);
    if (k === 'audio') return keep(audioTag(p, ''));
    if (k === 'video') return keep(videoTag(p, ''));
    if (k === 'image') return keep(imgTag('', p));
    return m;   // 非媒体本地路径 → 保持文本
  });
  t = t.replace(/\u0000(\d+)\u0000/g, (m, i) => { const h = stash[Number(i)]; return h == null ? '' : h; });
  return t.replace(/\n/g, '<br>');
}

/** 高亮代码块用的轻量语言标签（P0：仅标注，不高亮） */
export function codeLangLabel(lang) { return lang ? lang.toUpperCase() : 'CODE'; }

/** 供 media-interact.js 复用：扩展名 → 类别（audio/video/image/file/''） */
export function mediaKindOf(url) { return kindOf(url); }
