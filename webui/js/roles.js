// A1 前端 · 角色元数据（颜色/字形/图标）——对齐 themes.css 的角色 token
// v6.48：雷影统一显示全名「雷影·X」（气泡/通知/通讯中心一致）；主我保持「主我」。
//   short = 紧凑场景专用短名（如 Nexus 环流轨道标签，避免长名溢出/互相压字）。
// 色彩映射：ROLE_META.color 为唯一权威（值=token 引用，实际色值仍由 base.css --role-* 定义）。
// 预置角色 color=token；自定义角色（无 cls）color=哈希色；未知/空 role → 无 color。
export const ROLE_META = {
  main:         { short: '主我',   glyph: '⚡', cls: 'role-main',        color: 'var(--role-main)',       icon: '/assets/role-main.svg' },
  programmer:  { short: '程序员', glyph: '程', cls: 'role-programmer', color: 'var(--role-programmer)', icon: '/assets/role-programmer.svg' },
  designer:     { short: '美工',   glyph: '美', cls: 'role-artist',     color: 'var(--role-artist)',     icon: '/assets/role-artist.svg' },
  writer:       { short: '文案',   glyph: '文', cls: 'role-writer',     color: 'var(--role-writer)',     icon: '/assets/role-writer.svg' },
  tester:       { short: '测试员', glyph: '测', cls: 'role-tester',     color: 'var(--role-tester)',     icon: '/assets/role-tester.svg' },
  researcher:   { short: '研究员', glyph: '研', cls: 'role-researcher', color: 'var(--role-researcher)', icon: '/assets/role-researcher.svg' },
  sales:        { short: '销售',   glyph: '销', cls: 'role-sales',      color: 'var(--role-sales)',      icon: '/assets/role-sales.svg' },
  editor:       { short: '剪辑师', glyph: '剪', cls: 'role-editor',     color: 'var(--role-editor)',     icon: '/assets/role-editor.svg' },
};

// 角色展示名单一来源：API /api/mailbox/summary 的 roles[].name（后端为一权威）。
// 本模块不再内置 name；无命中回退 role。
const _ROLE_NAMES = new Map();
export function setRoleNames(list) {
  if (!Array.isArray(list)) return;
  for (const r of list) { if (r && r.role && r.name) _ROLE_NAMES.set(r.role, r.name); }
}
export function roleName(role, fallback) {
  return fallback || _ROLE_NAMES.get(role) || role || '';
}

// D4：未知角色（自定义）缺省——glyph=名称首字、色=hash(role) 取色板、icon=通用「分身」svg。
// 色板由「对既有 8 角色色取最大最小色相距离」得出（minΔHue≥17°，与既有色不撞）。
export const CUSTOM_PALETTE = ['#DC42ED', '#4AED42', '#ED4253', '#EDED42', '#42A8ED', '#A842ED', '#ED42CB', '#42EDCB'];
export function hash32(s) {
  let h = 2166136261 >>> 0;                       // FNV-1a 32bit
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
// 稳定锚点 = role（后端 id）；display name 只用于 glyph。
export function customColor(role) { return CUSTOM_PALETTE[hash32(role || '') % CUSTOM_PALETTE.length]; }

export function roleMeta(role, name) {
  const known = ROLE_META[role];
  if (known) return known;
  const nm = String(name || roleName(role) || role || '未知').replace(/^雷影[·・]?/, '');
  return { short: nm, glyph: nm.slice(0, 1) || '?', cls: '', color: customColor(role), icon: '/api/agents/icon?role=' + encodeURIComponent(role || '') };
}

// 角色 → inline '--role' 样式（单一入口，预置/自定义统一）：
//   预置 → token 引用 'var(--role-*)'（色值仍唯一由 base.css 定义，零漂移）；
//   自定义 → 哈希色 customColor；空 role → {}（不注入）。
export function roleVar(role) {
  if (!role) return {};
  const c = roleMeta(role).color;
  return c ? { '--role': c } : {};
}

// 会话头像角色：不再按标题猜角色（曾误判"开源项目研究"→研究员）。
// 普通会话一律「主我」；真有雷影参与时由 sessions.js 的 group(s) 组合头像承担，与本函数无关。
export function guessSessionRole(_s) {
  return 'main';
}

export function relTime(ts) {
  if (!ts) return '';
  const d = (typeof ts === 'number' ? ts : Date.parse(ts));
  if (!d || isNaN(d)) return '';
  const diff = Date.now() - d;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  const dt = new Date(d);
  return (dt.getMonth() + 1) + '/' + dt.getDate();
}

export function hhmm(ts) {
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
  if (isNaN(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
