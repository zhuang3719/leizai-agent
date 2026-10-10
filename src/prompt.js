'use strict';
// 雷仔 · 稳定前缀系统提示词构建器
// DeepSeek 缓存优化核心：
//  1) system 提示词 = 基因组文件 + 技能目录 + 固定尾注，全部静态；
//  2) 任何动态内容（时间、轮次、目标状态）一律不进 system，而放在 user 消息尾部；
//  3) 加了技能/进化后前缀会变——这是一次成本换长期收益，之后每条消息命中该新前缀。
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, load: loadConfig } = require('./config');
const { CODE_ROOT } = require('./paths');
const crypto = require('node:crypto');

const SYSTEM_PATH = path.join(DATA_DIR, 'prompts', 'system.md');
const HARNESS_PATH = path.join(DATA_DIR, 'prompts', 'harness.md');
const SKILLS_DIR = path.join(DATA_DIR, 'skills');

const FOOTER = [
  '',
  '——',
  '[系统] 以上规则与技能目录是稳定的。当前时间、轮次等动态内容会出现在用户消息中。',
  '[系统] 每次重大任务完成后进行反思：沉淀记忆、更新技能、必要时提出进化提案（propose_evolution）。',
].join('\n');

/** 技能目录块：只读名字+一句话描述，body/代码不进 system（保持前缀轻且稳）。同名时"可执行包"优先于".md 文档"，避免重复。 */
function skillCatalog() {
  let entries = [];
  try {
    // 按 key 去重：可执行包（目录）优先，同名 .md 文档作为旧形态被覆盖，避免列表/前缀重复
    const byKey = new Map();
    for (const e of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md')) {
        const key = e.name.replace(/\.md$/, '');
        const cur = byKey.get(key);
        if (!cur || !cur.isPkg) byKey.set(key, { file: path.join(SKILLS_DIR, e.name), key, isPkg: false });
      } else if (e.isDirectory()) {
        const md = path.join(SKILLS_DIR, e.name, 'SKILL.md');
        if (!fs.existsSync(md)) continue;
        byKey.set(e.name, { file: md, key: e.name, isPkg: true });
      }
    }
    entries = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  } catch { entries = []; }
  // P0 技能按需检索：只列**技能名**（不含描述），稳定排序（按 key，无动态内容）；
  //   描述/用法改由 search_skills 按需检索（省前缀 ~11k token）。
  const names = entries.map(({ key }) => key).filter(Boolean);
  if (!names.length) return '(暂无技能)';
  return names.join('\n') + '\n（技能详情/用法用 search_skills 查）';
}

/** 身份覆盖块（置顶）：仅供**非 main 实例**（雷影）使用。
 *  背景：system.md/harness.md 均以"你叫雷仔"开篇，雷影身份定义在 harness 末尾→被盖过，
 *  雷影会把自己当成雷仔本人。故对非 main 实例，在最前面注入强措辞身份覆盖块；
 *  main（主我）返回空串，systemPrompt 输出逐字不变。 */
function identityOverlay() {
  try {
    const a = (loadConfig().agent) || {};
    if (!a.role || a.role === 'main' || a.isMain) return '';   // 主我：不注入，行为不变
    const nm = a.name || ('雷影·' + a.role);
    const core = `# \u26a0\ufe0f 你的真实身份（优先于下方一切文本）
你的名字是【${nm}】（role=${a.role}，领域=${a.domain || ''}）。
你是主智能体「雷仔」（主我）的领域专用执行分身——**你不是雷仔本人**。
下方文本中所有"你叫雷仔/你是雷仔/雷仔的行为规则"等，一律指代**你的本体/上级「主我·雷仔」**，不是你；你只继承其规则，绝不自称"雷仔"。
你的自称一律是「${nm}」。

`
    return core + readRoleL2(a);
  } catch { return ''; }
}

/** 本实例角色档位：main=主我（含无 role/未标 isMain）；其余一律 worker（雷影/子智能体）。 */
function _role() {
  try {
    const a = (loadConfig().agent) || {};
    if (!a.role || a.role === 'main' || a.isMain) return 'main';
    return 'worker';
  } catch { return 'main'; }
}

/** L2 领域约束模板目录（构建资产；产品包随包携带 templates/role-l2/）。 */
const ROLE_L2_DIR = path.join(CODE_ROOT, 'templates', 'role-l2');
let _warnedL2 = false;
/** 读本角色 L2 领域约束：预置角色读 `<role>.md`；无预置（自建角色）读 `_custom.md` 并按 name/domain 填充。缺失→跳过并 warn 一次（绝不 throw）。 */
function readRoleL2(a) {
  try {
    const role = String((a && a.role) || '').trim();
    if (!role) return '';
    let txt = '';
    const own = path.join(ROLE_L2_DIR, role + '.md');
    if (fs.existsSync(own)) {
      txt = fs.readFileSync(own, 'utf8');
    } else {
      const custom = path.join(ROLE_L2_DIR, '_custom.md');   // 自建角色模板
      if (fs.existsSync(custom)) {
        const nm = (a && a.name) || ('雷影·' + role);
        txt = fs.readFileSync(custom, 'utf8').split('{name}').join(nm).split('{domain}').join(String((a && a.domain) || ''));
      } else if (!_warnedL2) {
        _warnedL2 = true;
        try { console.warn('[prompt] 缺 role-l2 模板：' + own + '（跳过 L2 注入，仅提示一次）'); } catch { }
      }
    }
    txt = String(txt || '').trim();
    return txt ? ('\n' + txt + '\n') : '';
  } catch { return ''; }
}

// ———————— P0（2026-10-03）：首启播种 prompts（干净安装对话不可用修复）————————
// 现象：发布包干净装 → POST /api/chat → ENOENT <DATA_DIR>\prompts\system.md → 对话核心炸。
// 根因：包从未带 prompts 模板，且 systemPrompt() 直接 readFileSync(SYSTEM_PATH)（无 try/catch）。
// 方案：只读模板目录 <CODE_ROOT>/templates/prompts/；首启幂等播种到 <DATA_DIR>/prompts/；模板也缺则写内置最小串兜底。
const TEMPLATES_PROMPTS_DIR = path.join(CODE_ROOT, 'templates', 'prompts');
const MIN_SYSTEM_FALLBACK = [
  '# 雷仔 · 基础基因组（最小兜底）',
  '',
  '你是雷仔，一个自我进化型智能体。当前提示词模板缺失，此处为内置最小串兜底。',
  '请尽快恢复完整的 prompts/system.md。',
  '',
].join('\n');

/**
 * 首启播种 prompts（幂等）：目标 <DATA_DIR>/prompts/（= paths.dataDir()/prompts）。
 * 规则：①各文件**缺失才**从模板复制，**绝不覆盖已存在**；②模板也缺 → system.md 写非空内置最小串 + console.warn，**绝不抛错**；
 *       ③mkdir -p 目标目录；本函数自身绝不 throw（外层仍包 try）。
 * @returns {{seeded:string[], skipped:string[], fallback:boolean, dst:string}}
 */
function ensurePrompts() {
  const out = { seeded: [], skipped: [], fallback: false, dst: null };
  let dstDir;
  try { dstDir = path.join(require('./paths').dataDir(), 'prompts'); out.dst = dstDir; }
  catch { return out; }
  try { fs.mkdirSync(dstDir, { recursive: true }); }
  catch (e) { try { console.warn('[prompt] 播种 prompts 目录失败：' + (e && e.message)); } catch { } return out; }
  for (const name of ['system.md']) {   // 只播 system.md；产品基线与用户增量 harness 均不落 data（2026-10-08 定案）
    const dst = path.join(dstDir, name);
    try { if (fs.existsSync(dst)) { out.skipped.push(name); continue; } } catch { }
    const tpl = path.join(TEMPLATES_PROMPTS_DIR, name);
    try {
      if (fs.existsSync(tpl)) { fs.copyFileSync(tpl, dst); out.seeded.push(name); continue; }
    } catch (e) { try { console.warn(`[prompt] 复制模板 ${name} 失败：` + (e && e.message)); } catch { } }
    // 模板缺 → 仅 system.md 写内置最小串兜底（harness.md 缺失本就由 readHarness 容错为空）
    if (name === 'system.md') {
      try {
        fs.writeFileSync(dst, MIN_SYSTEM_FALLBACK, 'utf8');
        out.seeded.push('system.md(fallback)'); out.fallback = true;
        try { console.warn('[prompt] 模板缺失，system.md 已写内置最小串兜底（非空，绝不抛错）。'); } catch { }
      } catch { }
    }
  }
  return out;
}

let lastCache = null;
/**
 * 返回当前稳定前缀（内容变化时自动重算 —— 只有进化/技能变化会触发）。
 * 补充态：若存在 data/prompts/harness.md（非空），会作为「补充规则/记忆」追加在技能目录之后。
 * 这样可在不改动基础基因组 system.md 的前提下沉淀可进化的补充知识（对齐 Prime Agent 的 Continual Harness）。
 */
function systemPrompt() {
  // 产品规则层：genome 优先取加密内嵌（产品态盘上无明文；主我/雷影同一来源，雷影不再依赖各自 system.md 播种）。
  //   雷影身份由 identityOverlay() 置顶强覆盖（见其注释），与 genome 内“你叫雷仔”表述并存无冲突。
  //   dev 无内嵌（src/gen 不存在）→ readEmbedded 返回 ''，回退各自 data/prompts/system.md，行为不变。
  const genome = readEmbedded('system') || fs.readFileSync(SYSTEM_PATH, 'utf8').trimEnd();
  const catalog = skillCatalog();
  const baseline = readBaseline();
  const harness = readHarness();
  const baselineBlock = baseline
    ? `\n\n# 通用基线规则（不可被后文覆盖）\n以下为通用基线规则，**不可被后文增量覆盖或忽略**；实例专属规则可在不冲突前提下补充。\n${baseline}\n`
    : '';
  const harnessBlock = harness
    ? `\n\n# 补充规则与沉淀（可变）\n本段可由进化提案修改（target=harness），用于沉淀补充行为规则/知识，基础基因组保持稳定。\n${harness}\n`
    : '';
  const full = `${identityOverlay()}${genome}\n\n# 已掌握技能\n${catalog}\n${baselineBlock}${harnessBlock}\n${FOOTER}\n`;
  if (!lastCache || lastCache.full !== full) {
    lastCache = { full, hash: hashOf(full) };
  }
  return lastCache;
}

// ———————— 产品规则层（加密内嵌，2026-10-09）————————
// 构建期 scripts/gen-baseline-embed.mjs 把 harness.baseline.md / system.md 加密为 src/gen/*.enc.js（仅密文），
// key 编译入 shell IL、运行期经子进程 stdin 一次性注入引擎（不落 env/命令行）。产品态盘上无明文规则文件。
const GEN_DIR = path.join(CODE_ROOT, 'src', 'gen');
let _keys, _keysInit = false;
function _asKey(s) { try { const b = Buffer.from(String(s || '').trim(), 'base64'); return b.length === 32 ? b : null; } catch { return null; } }
/** 规则层解密 key 表（按角色分份）：main=主我规则层+genome；worker=雷影规则层+genome（各自独立 key）。 */
function _roleKeyMap() {
  if (_keysInit) return _keys;
  _keysInit = true;
  _keys = Object.create(null);
  const ek = _asKey(process.env.LEIZAI_BASELINE_KEY);          // 降级/测试用（产品默认走 stdin），仅 main
  if (ek) _keys.main = ek;
  if (String(process.env.LEIZAI_KEY_STDIN || '') === '1') {    // stdin：每行 `role:base64key`（兼容旧单行=main）
    try {
      const b = Buffer.alloc(1024); const n = fs.readSync(0, b, 0, b.length, null);
      for (const line of String(b.slice(0, n)).split(/\r?\n/)) {
        const t = line.trim(); if (!t) continue;
        const i = t.indexOf(':');
        if (i > 0) { const k = _asKey(t.slice(i + 1)); if (k) _keys[t.slice(0, i)] = k; }
        else { const k = _asKey(t); if (k && !_keys.main) _keys.main = k; }   // 旧单行=main（兼容）
      }
    } catch { }
  }
  return _keys;
}
/** 取本实例角色对应的解密 key（缺省 role 由 _role() 判定）。无 → null。 */
function embedKey(role) {
  const m = _roleKeyMap();
  const r = role || _role();
  return m[r] || null;
}
/** 供主引擎把解密 key 传给雷影（雷影 src/gen 内嵌规则亦需 key）。无 key → ''。 */
function embedKeyB64(role) { const k = embedKey(role); return k ? k.toString('base64') : ''; }
/** 雷影专用：worker key（主引擎经子进程 stdin 转交雷影，雷影解 baseline.worker/system.worker）。 */
function embedWorkerKeyB64() { return embedKeyB64('worker'); }
let _warnedEmbed = Object.create(null);
function _warnEmbedOnce(name, msg) {
  if (_warnedEmbed[name]) return; _warnedEmbed[name] = true;
  try { console.warn(`[prompt] 内嵌规则(${name})不可用：${msg}（将回退本地文件）`); } catch { }
}
/** 解密内嵌规则（src/gen/<name>.enc.js）；不可用/无 key → ''（不抛）。
 *  缺 enc（dev/旧装）静默回退；enc 存在但 key 缺失/错 → 告警一次后回退（不崩）。 */
function readEmbedded(name) {
  const role = _role();
  let mod;
  // 命名：'baseline.' + role + '.enc.js' / 'system.' + role + '.enc.js'（按角色分份；worker 仅拿得到 worker 密文）
  try { mod = require(path.join(GEN_DIR, name + '.' + role + '.enc.js')); }
  catch {
    try { mod = require(path.join(GEN_DIR, name + '.enc.js')); }   // 旧单份（dev/旧装）兼容
    catch { return ''; }                        // 无内嵌（dev/旧装）→ 正常回退，不告警
  }
  try {
    const k = embedKey(role);
    if (!k) { _warnEmbedOnce(name, '无解密 key'); return ''; }
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(mod.iv, 'base64'));
    d.setAuthTag(Buffer.from(mod.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(mod.data, 'base64')), d.final()]).toString('utf8').trim();
  } catch (e) { _warnEmbedOnce(name, '解密失败：' + ((e && e.message) || e)); return ''; }
}

// ———————— 产品基线 harness（只读构建资产，2026-10-08 / 内嵌 2026-10-09）————————
// 定位：① 加密内嵌 src/gen/baseline.enc.js（产品态，盘上无明文文件）
//        ② env LEIZAI_BASELINE_DIR 的明文 md（旧装）/ CODE_ROOT/templates/prompts/（dev，无内嵌时）
const BASELINE_FILENAME = 'harness.baseline.md';
let _warnedBaseline = false;
function baselinePath() {
  const envDir = String(process.env.LEIZAI_BASELINE_DIR || '').trim();
  if (envDir) return path.join(envDir, 'templates', 'prompts', BASELINE_FILENAME);
  return path.join(TEMPLATES_PROMPTS_DIR, BASELINE_FILENAME);
}
/** 读产品基线：① 加密内嵌 ② 明文文件（dev/旧装）③ 都没有 → WARN（不再静默）返回 ''。 */
function readBaseline() {
  const emb = readEmbedded('baseline');
  if (emb) return emb;
  const p = baselinePath();
  try {
    return fs.readFileSync(p, 'utf8').trim() || '';
  } catch (e) {
    if (!_warnedBaseline) {
      _warnedBaseline = true;
      try { console.warn(`[prompt] 产品基线不可读（无内嵌、且文件缺失）：${p} : ${(e && e.message) || e}`); } catch { }
    }
    return '';
  }
}
/** 老装残留判定：== 当前基线全文，或为旧随包裁剪稿标题 → 视为基线种子（去重）。 */
function isBaselineResidue(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  const base = readBaseline();
  if (base && s === base) return true;
  return /^#\s*(?:雷仔\s*·\s*)?行为规则层（随包/.test(s);
}

/** 读取用户/实例增量（data/prompts/harness.md）；不存在或为基线残留 → 视为空。 */
function readHarness() {
  try {
    const t = fs.readFileSync(HARNESS_PATH, 'utf8').trim();
    if (!t || isBaselineResidue(t)) return '';
    return t;
  } catch { return ''; }
}

/** 供进化模块读取/回滚补充态。 */
function rawHarness() {
  return fs.readFileSync(HARNESS_PATH, 'utf8');
}

function hashOf(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** 供进化模块回滚/校验时读取原始基因组文件。 */
function rawGenome() {
  return fs.readFileSync(SYSTEM_PATH, 'utf8');
}

module.exports = { systemPrompt, identityOverlay, rawGenome, rawHarness, readHarness, skillCatalog, ensurePrompts, readBaseline, readEmbedded, embedKeyB64, embedWorkerKeyB64, _role, SYSTEM_PATH, HARNESS_PATH, SKILLS_DIR };
