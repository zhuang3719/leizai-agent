// A1 前端 · 本地路径工具（单一权威）
// markdown.js 与 media-interact.js 共用，消除两份实现漂移。
export const RE_LOCAL = /^(?:[a-zA-Z]:[\\/]|\\\\|\/\/|file:\/\/)/i;   // 盘符 C:\ / UNC \\ / file://

export function isLocal(u) { return !!u && RE_LOCAL.test(u); }

export function localToPath(u) {
  return String(u).replace(/^file:\/\/\/?/i, '').replace(/\//g, '\\');
}

export function baseName(p) {
  const s = String(p == null ? '' : p);
  return s.split(/[\\/]/).pop() || s;
}
