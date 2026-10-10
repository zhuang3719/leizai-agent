'use strict';
// 雷仔 · 工具注册表
// ！！重要：数组顺序即请求里的工具顺序，只会追加新工具，绝不重排/改写已有 schema ——
// 这是 DeepSeek 前缀缓存命中的前提之一（工具定义属于静态前缀）。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const memory = require('./memory');
const evolution = require('./evolution');
const selfmodel = require('./selfmodel');
const versionchain = require('./versionchain');
const selftrain = require('./selftrain');
const growth = require('./growth');
const branch = require('./branch');   // 世界树·支干事件库（P0 · log_progress 双写）

// P0.1-B 兜底（R1·2026-10-09）：`src/pro/toolcap.js` 为私模侧可选模块，缺失/加载失败**不得抛**
//   （顶层裸 require 会在模块加载期直接崩引擎）。惰性加载 + 一次性告警；fail-closed：
//   缺失时 classify 视为"未映射→拒"（见 exec chokepoint）、CAP_MAP 兜底空表 {}。
let _toolcap = null, _toolcapWarned = false;
function getToolCap() {
  if (_toolcap) return _toolcap;
  try { _toolcap = require('./pro/toolcap'); return _toolcap; }
  catch (e) {
    if (!_toolcapWarned) {
      _toolcapWarned = true;
      try { console.warn('⚠️ [gate] src/pro/toolcap.js 缺失或加载失败 → 工具门禁 fail-closed（未映射一律拒）：' + ((e && e.message) || e)); } catch { }
    }
    return null;
  }
}


// 本地时间格式（yyyy-MM-dd HH:mm:ss）：进度/会话记录的时间戳应显示本地时区，
// 而非 toISOString() 的 UTC（那会差 8 小时，如显示 21:19:44 实为本地 05:19:44）。
function localTimeStr(d) {
  const t = d ? new Date(d) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

// —— 完成标记剥离（单一来源：todo/prefix 的 done 归一化共用）——
// 可叠加多层，一次剥净：`✅ 已完成：X` → `X`、`- [x] ✅ 已完成：X` → `X`；单标记行为不变（`✅X`→`X`、`[x] X`→`X`）。
// 治"多标记只剥一层 → 归一化后与 open 原文不匹配 → 勾销不收缩（fold.openTodos/pendingPfx 不减）"。
function stripDoneMarkers(s) {
  return String(s).replace(/^(?:[-*]\s*)?(?:(?:\[\s*[xX✓✔]\s*\]|✅|☑|✓|✔|已完成[:：]?|已勾除[:：]?|已收口[:：]?)\s*)+/, '');
}

/** v6.38（P2）：完成态判定 = **函数**（替代三处"开头锚定"正则 DONE_RE/DONE_RE2）。
 *  ①开头标记 `[x]/✅/已完成…`；②显式 `args.done===true` / `args.fruitFrom`；
 *  ③**语义关键词**（已完成/已核销/已收口/已落地/已解决/已确认/已关闭/已处理/已修复/已部署/核销：/TODO 关闭…，
 *     覆盖"句中标记"）——治"…已落地并部署，TODO 关闭"被判非完成 → 反写新 open"的正反馈。
 *  负向守卫：含"未完成/完成度/待完成/尚未…"时不判完成（防"完成度评估"类文本误判）。
 *  v6.41（tester 副作用 B2/B3 修正）：负向守卫**补祈使/疑问语气**（是否已完成/确认…已完成/待确认/请确认/需确认/
 *    确认是否/核对是否/检查是否…）——这类是"要我去确认"的待办，不是"已完成"，误判会丢真 open。
 *  仅用于**判定**，不改 payload 原文。 */
const DONE_HEAD_RE = /^(?:[-*]\s*)?(?:\[\s*[xX✓✔\s]*\]|✅|☑|✓|✔|已完成|已勾除|已收口|已核销)/;
const DONE_STRONG_RE = /(?:已完成|已核销|已收口|已落地|已解决|已确认|已关闭|已勾销|已勾除|已处理|已修复|已部署|已完成并|核销[:：]|收口[:：]|TODO\s*关闭|todo\s*关闭)/i;
const DONE_NEG_RE = /(?:未完成|尚未完成|待完成|未收口|未解决|未确认|未核销|完成度|完成情况|完成标准|完成验收|完成率|是否已完成|确认[^，。；;\n]{0,6}已完成|待确认|请确认|需确认|确认是否|核对是否|检查是否|核实是否|查明是否|验证是否)/;
// c（isDoneEntry 修误判）：否定前缀守卫——"不/未/… + ≤4字 + 完成类词"（如"不认口头『已完成』""未采用'已部署'方案"）→ 不判完成。
const DONE_NEG_PREFIX_RE = /(?:不|未|非|无|没|勿|别|拒绝|反对|尚未|不再|不认|未采用|不采用)[^，。；;\n]{0,4}(?:已完成|已核销|已收口|已落地|已解决|已确认|已关闭|已勾销|已勾除|已处理|已修复|已部署)/;
// b（isDoneEntry 修误判）：剥离引号内内容（『』「」""''），仅用于 strong 关键词分支，避免"引号引用完成词"被误判 done。
function stripQuoted(s) {
  return String(s).replace(/[『「“"'][^』」”"']*[』」”"']/g, ' ');
}
function isDoneEntry(clean, entry, args) {
  const a = String(clean || '').trim();
  const b = String(entry || '').trim();
  if (args && args.done === true) return true;
  // a（v6.4x 修误判）：显式 args.done===false 优先于关键词（逃生舱；schema 无默认值，不传时不触发）。
  if (args && args.done === false) return false;
  if (String((args && args.fruitFrom) || '').trim()) return true;
  // v6.41：负向守卫**优先于**开头标记（"确认…已完成"类祈使/疑问式，即使句中带"已完成"也不判完成）
  if (DONE_NEG_RE.test(a) || DONE_NEG_RE.test(b)) return false;
  // b/c：strong 关键词分支改测**去引号副本 aq/bq**；否定前缀守卫同源。head/neg 分支仍用原文（不动）。
  const aq = stripQuoted(a), bq = stripQuoted(b);
  if (DONE_NEG_PREFIX_RE.test(aq) || DONE_NEG_PREFIX_RE.test(bq)) return false;
  if (DONE_HEAD_RE.test(a) || DONE_HEAD_RE.test(b)) return true;
  if (DONE_STRONG_RE.test(aq) || DONE_STRONG_RE.test(bq)) return true;
  return false;
}

// —— log_progress 分级写入 + 进度文件滚动归档（交接/进度扎实化 M2/M3）——
const PROGRESS_ARCHIVE_LIMIT = 40000;   // 主文件超此字符 → 滚动归档最旧流水
const PROGRESS_KEEP_FLOW = 60;          // 主文件保留的最近流水条目数

/** 进度文件里的命名区块跨度（返回 {s,e} 行号，或 null）。 */
function progressBlockSpan(lines, name) {
  const b = new RegExp(`<!--\\s*${name}:BEGIN\\s*-->`);
  const e = new RegExp(`<!--\\s*${name}:END\\s*-->`);
  let s = -1;
  for (let i = 0; i < lines.length; i++) {
    if (s < 0) { if (b.test(lines[i])) s = i; }
    else if (e.test(lines[i])) return { s, e: i };
  }
  return null;
}

/** 条目去重键：取 [决定]/[规则] 等前缀标签 + 主体前 20 字（≤60）。 */
function progressEntryKey(entry) {
  const s = String(entry || '').trim();
  const m = s.match(/^\[([^\]\n]{1,12})\]/);
  const tag = m ? m[1] : '';
  const body = m ? s.slice(m[0].length).trim() : s;
  return `${tag}|${body.slice(0, 20)}`.slice(0, 60);
}

/** 从区块行反推条目正文（KEY 去掉 "- "；TODO 再去掉 "[ ] "），与插入格式严格互逆。 */
function blockLineText(line, name) {
  let s = String(line || '').replace(/^[-*]\s*/, '');
  if (name === 'TODO' || name === 'PREFIX') s = s.replace(/^\[\s*\]\s*/, '');
  return s.trim();
}

/** 命名区块插入点：标题/空行/引用块之后；无标题则文件顶部。 */
function progressInsertPos(lines) {
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && /^#/.test(lines[i].trim())) i++;
  while (i < lines.length && (lines[i].trim() === '' || /^>/.test(lines[i].trim()))) i++;
  return i;
}

/** 在命名区块内 upsert 一条（同名替换、否则追加）；区块不存在则新建（KEY 置顶，TODO 紧随 KEY）。 */
function progressUpsertBlock(f, name, line, entry) {
  let lines = fs.readFileSync(f, 'utf8').split('\n');
  const span = progressBlockSpan(lines, name);
  const key = progressEntryKey(entry);
  if (span) {
    const inner = lines.slice(span.s + 1, span.e);
    let rep = false;
    for (let i = 0; i < inner.length; i++) {
      if (key && progressEntryKey(blockLineText(inner[i], name)) === key) { inner[i] = line; rep = true; break; }
    }
    if (!rep) inner.push(line);
    lines = [...lines.slice(0, span.s + 1), ...inner, ...lines.slice(span.e)];
  } else {
    let p = progressInsertPos(lines);
    for (const nm of ['KEY', 'PREFIX', 'TODO']) {
      if (nm === name) break;
      const sp = progressBlockSpan(lines, nm);
      if (sp && sp.e + 1 > p) p = sp.e + 1;
    }
    lines = [...lines.slice(0, p), `<!--${name}:BEGIN-->`, line, `<!--${name}:END-->`, ...lines.slice(p)];
  }
  fs.writeFileSync(f, lines.join('\n'), 'utf8');
}

/** 滚动归档：主文件 >40000 字符时，把最旧流水条目搬到 _progress.archive.md（KEY/PREFIX/TODO 区块永不搬，保留最近 60 条）。失败静默降级。 */
function progressRollArchive(f) {
  try {
    const t = fs.readFileSync(f, 'utf8');
    if (t.length <= PROGRESS_ARCHIVE_LIMIT) return;
    const lines = t.split('\n');
    const kr = progressBlockSpan(lines, 'KEY');
    const pr = progressBlockSpan(lines, 'PREFIX');
    const tr = progressBlockSpan(lines, 'TODO');
    const inBlock = (i) => (kr && i >= kr.s && i <= kr.e) || (pr && i >= pr.s && i <= pr.e) || (tr && i >= tr.s && i <= tr.e);
    const entryIdx = [];
    for (let i = 0; i < lines.length; i++) if (!inBlock(i) && /^-\s*\[/.test(lines[i])) entryIdx.push(i);
    if (entryIdx.length <= PROGRESS_KEEP_FLOW) return;
    const cut = entryIdx.length - PROGRESS_KEEP_FLOW;
    const drop = new Set(entryIdx.slice(0, cut));
    const moved = entryIdx.slice(0, cut).map((i) => lines[i]);
    const ap = path.join(path.dirname(f), '_progress.archive.md');
    if (!fs.existsSync(ap)) {
      fs.writeFileSync(ap, `# 进度归档（滚动，仅增）\n\n> 由 log_progress 自动滚动迁移：主文件超 ${PROGRESS_ARCHIVE_LIMIT} 字符时，把最旧流水条目搬到此处；KEY/PREFIX/TODO 区块永不搬。\n\n`, 'utf8');
    }
    fs.appendFileSync(ap, moved.join('\n') + '\n', 'utf8');
    fs.writeFileSync(f, lines.filter((_, i) => !drop.has(i)).join('\n'), 'utf8');
  } catch { /* 滚动归档失败不阻断主流程（静默降级） */ }
}

const COMMAND_BLOCKLIST = [
  /\brm\s+-rf\s+(\/|\\|\*)/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\b.*\s\/[sfq]\b/i,
  /\brd\b.*\s\/s\b.*\s\/q\b/i,
  /\bshutdown\b/i,
  /\btaskkill\b/i,
  /\breg\s+delete\b/i,
  /\bdiskpart\b/i,
  /\bvssadmin\b/i,
  /\bremove-item\b.*-recurse/i,
  /\bClear-RecycleBin\b/i,
  /\bcipher\b/i,
  /\bwmic\b.*\bdelete\b/i,
];

function resolvePath(workdir, p, cfg) {
  const abs = path.resolve(String(p || '.'));
  if (cfg && cfg.fullAccess) return abs; // 真正的智能体模式：本机全路径可访问
  const root = path.resolve(workdir);
  // 允许工作目录 + allowedPaths（配置里显式追加的路径），其余一律越界
  const allowed = [root, ...(Array.isArray(cfg && cfg.allowedPaths) ? cfg.allowedPaths.map((x) => path.resolve(String(x))) : [])];
  const ok = allowed.some((a) => abs === a || abs.startsWith(a + path.sep));
  if (!ok) throw new Error(`路径越界（工作目录 ${root}）：${abs}`);
  return abs;
}

/** 写入保护：protectedPaths 里的路径即使 fullAccess 也禁止写（读不受限）。 */
function assertWritable(file, cfg) {
  const prot = (Array.isArray(cfg && cfg.protectedPaths) ? cfg.protectedPaths : []).map((x) => path.resolve(String(x)));
  const hit = prot.find((a) => file === a || file.startsWith(a + path.sep));
  if (hit) throw new Error(`写入被拒绝（protectedPaths 命中：${hit}）：${file}（只读保护，请勿改写）`);
}

// ==================== 自我修改安全（阶段1） ====================
// 目标：无论怎么自我修改前端/后端/核心，都不会因改错而无法启动。
// 三层：①影子写入（验证通过才落盘）②启动自检回滚（boot-guard）③版本链回退。

/** 判断目标文件是否落在"自我修改范畴"（需走影子写入验证）：
 *  src/ 引擎源码、data/prompts/ 人格规则、config.json。
 *  这些允许改（放心改核心），但要先验证再落盘。 */
function inSelfModifyScope(file) {
  try {
    const abs = path.resolve(String(file));
    const root = path.resolve(__dirname, '..');
    const inDir = (f, d) => f === d || f.startsWith(d + path.sep);
    return inDir(abs, path.join(root, 'src')) || inDir(abs, path.join(root, 'data', 'prompts')) || abs === path.join(root, 'config.json');
  } catch { return false; }
}

/** 判断目标文件是否落在"关键只读保护"路径：data/ 下的记忆/技能/会话/归档/进化等意识数据。
 *  只拦截 write_file/edit_file 直接改写这些关键目录（绕过业务接口的破坏性路径）。
 *  正常业务接口（memory.save/save_skill/log_progress/propose_evolution）不经过此处，不受影响。 */
function isReadOnlyKeyPath(file) {
  try {
    const abs = path.resolve(String(file));
    const root = path.resolve(__dirname, '..');
    const inDir = (f, d) => f === d || f.startsWith(d + path.sep);
    const dataDirs = ['memory', 'skills', 'sessions', 'archives', 'evolution', 'agents', 'tasks', 'schedules', 'kernels'];
    // data/ 下这些关键子目录：记忆库/技能库/会话/归档/进化历史/智能体/任务/调度/Python内核 → 只读
    if (dataDirs.some((d) => inDir(abs, path.join(root, 'data', d)))) return true;
    // 注意：data/prompts 是"可自我修改"范畴（人格/规则），由 inSelfModifyScope 处理，不在此只读内。
    // data/versions 是版本链自身，允许写（快照要写进去）。
    return false;
  } catch { return false; }
}

/** 对"待落盘的影子内容"做语法/加载校验：
 *  .js → node --check；.json → JSON.parse；.md/其他 → 免检（人格/规则文档）。
 *  校验失败抛错，影子不落盘。 */
function validateDraft(file, content) {
  const src = String(content || '');
  if (file.endsWith('.js')) {
    // 用 node --check 校验语法（spawnSync，无输出即通过）
    const { spawnSync } = require('node:child_process');
    const tmp = path.join(require('node:os').tmpdir(), `leizai-draft-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
    try {
      fs.writeFileSync(tmp, src, 'utf8');
      const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) {
        throw new Error(`源码校验未通过（node --check）：${(r.stderr || r.stdout || '').split('\n')[0]}`);
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch { }
    }
  } else if (file.endsWith('.json')) {
    try { JSON.parse(src); } catch (e) { throw new Error(`JSON 校验未通过：${e.message}`); }
  }
  // .md 等文档免检（人格/规则文档不存在"语法错"）
}

/**
 * 影子写入（shadow commit）：把新内容先备份旧版→验证→通过才落盘，失败则丢弃。
 * 用于 write_file/edit_file 命中"自我修改范畴"（src/、data/prompts/、config.json）时生效，
 * 保证坏版本（语法错/加载错）根本写不进实体，实体永远是可启动的好版本。
 * @param {string} file 目标绝对路径
 * @param {string} content 要写入的新内容（全部新内容，edit 场景由调用方先计算好）
 * @param {string} opDesc 操作描述（用于返回）
 */
function shadowCommit(file, content, opDesc) {
  // ① 备份当前版本到版本链（用于回退）
  const backed = versionchain.snapshot(file);
  // ② 校验影子内容（语法/JSON）
  validateDraft(file, content);
  // ③ 通过 → 落盘
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(content), 'utf8');
  const note = backed ? `（版本已快照可回退）` : `（新文件/无旧版，未快照）`;
  return `${opDesc} ${note}`;
}
// ==================== /自我修改安全（阶段1） ====================

/** 前缀操作护栏：修改 system/skills 目录/提示词等"稳定前缀"的操作，成本∝当时窗口长度。
 *  当前会话窗口已接近预算（将触发世代交接）时，拦截这类操作，强制推到交接后小窗口做，
 *  避免在大窗口烧昂贵的缓存重建。调用方为 propose_evolution / save_skill 等前缀操作。
 *  @param ctx 工具上下文（含 sessionId/cfg）
 *  @param {number} minTokens 拦截的窗口绝对阈值（默认读配置 cfg.prefixGuardMinTokens，缺失回退 50k token）。击穿前缀成本 ∝ 窗口绝对长度（与预算无关），故用绝对阈值而非预算比例；预算提高不会放大拦截线。
 *  @returns 无异常即放行；窗口超阈值则抛出拦截错误 */
function prefixGuardMinTokensOf(ctx) {
  // 优先用调用链上的 ctx.cfg；拿不到时用 config.load() 兜底；仍缺失则回退 50000（向后兼容）
  let v = Number(ctx && ctx.cfg && ctx.cfg.prefixGuardMinTokens);
  if (!v) {
    try { v = Number(require('./config').load().prefixGuardMinTokens); } catch { v = 0; }
  }
  return v || 40000;   // 回退值与 config.common.json 默认（40000）一致
}
function assertSafeWindow(ctx, minTokens = prefixGuardMinTokensOf(ctx)) {
  // 延迟 require：runChat 在运行期调用 execute，此时 runtime 已完成加载，不会触发循环依赖死锁
  const runtime = require('./runtime');
  const sid = ctx && ctx.sessionId;
  let budget, hist;
  try {
    const s = runtime.getSession(sid);
    budget = runtime.effectiveBudget(s);
    // 门槛口径修正（防死循环根治）：护栏按「历史消息 token（不含 system 前缀）」判断越线。
    //   system 前缀（system.md+harness.md+技能目录+工具 schema ≈2.4 万）在交接后依然存在，且改前缀必然重算它，
    //   不该计入"可压缩历史"的拦截线；否则长会话交接后 hist+system 恒越线 → 交接→拦→交接 死循环。
    // 口径补全 v2：spTok 计入 system 前缀 + tools schema（definitions()）。二者都不属"可压缩历史"。
    const spTok = (() => {
      try {
        const sp = require('./prompt').systemPrompt();   // 延迟 require 防循环依赖
        const spFull = (sp && (sp.full || (typeof sp === 'string' ? sp : ''))) || '';
        return spFull ? runtime.estimateTokens({ content: spFull }) : 0;
      } catch { return 0; }
    })();
    const toolsTok = (() => {
      try {
        const defs = require('./tools').definitions();
        return defs ? runtime.estimateTokens({ content: JSON.stringify(defs) }) : 0;
      } catch { return 0; }
    })();
    const real = Number((s && s._lastPromptTokens) || 0);
    if (real > 0) {
      hist = Math.max(0, real - spTok - toolsTok);   // API 真实 prompt 含 system + tools → 减去即历史
    } else {
      hist = 0;
      for (const m of (s.messages || [])) hist += runtime.estimateTokens(m);   // 交接/重启后回退估算（messages 本身不含 prefix）
    }
  } catch (e) {
    // 拿不到会话信息（如无会话）时不做拦截，放行——护栏只在本会话窗口可判定时生效
    return;
  }
  if (!budget || budget <= 0) return;
  if (hist < minTokens) return;   // 历史未越线 → 放行（交接后历史量小即通过）
  // 首回合 fail-open（替代 v1 兜底）：交接/重启即置 _lastPromptTokens=0 → 本代窗口刚重建=最小。
  //   首回合 hist 仍越线（如首条消息本身极大）时放行（已是最小窗，无可再等）；非首回合=硬约束（取消兜底，遵主人定）。
  let _s = null;
  try { _s = runtime.getSession(sid); } catch { _s = null; }
  // ③ C（2026-09-24 判据修复）：改用「本代(gen)是否已成功执行过前缀操作」显式标志，
  //   替换原 _lastPromptTokens===0 判据——后者每次响应即被写回（runtime.js:2777），
  //   实际只覆盖"本代首次响应之前"，真实前缀操作全落硬拦（主人实测锤实）。
  //   gen 变化即视为新一代 → 标志自然重置（首次前缀操作仍放行一次）；本代已做过 → 硬拦。硬线 minTokens 不放宽。
  let curGen = 0;
  try { curGen = Number(runtime.resolveBranchTurnGen(sid)) || 0; } catch { curGen = 0; }
  const doneThisGen = !!(_s && _s._pfxDoneInGen) && Number((_s && _s._pfxGen) || 0) === curGen;
  if (!doneThisGen) {
    try { console.log(`[pfx-guard-firstturn-allow] sid=${sid} gen=${curGen} hist≈${Math.round(hist)} min=${minTokens} → 放行（本代首次前缀操作）`); } catch { }
    try { auditBoundary('PREFIX-GUARD-FIRSTTURN-ALLOW', 'assertSafeWindow', String((ctx && ctx.cfg && ctx.cfg.agent && ctx.cfg.agent.role) || ''), String(sid || ''), `gen=${curGen} hist=${Math.round(hist)} min=${minTokens}`); } catch { }
    return;
  }
  throw new Error(
    `【前缀操作护栏】本会话历史消息约 ${Math.round(hist)} token，已超过拦截线 ${minTokens} token。` +
    `此操作会击穿前缀缓存（成本 ∝ 窗口绝对长度，与预算无关），请攒到下次交接后首回合（窗口最小时）再执行。`
  );
}

/** cmd 惯用法 → PowerShell 的最小翻译层（模型常用 dir/cd/type/&& 等，直接兼容）。 */
function translateCmd(cmd) {
  return cmd
    .replace(/\s*>nul\b/gi, ' > $null ')
    .replace(/\s*&&\s*/g, '; ')
    .replace(/\bdir\s+\/s\b/gi, 'Get-ChildItem -Recurse')
    .replace(/\bdir\b/gi, 'Get-ChildItem')
    .replace(/\bcd\s+\/d\s+/gi, 'Set-Location ')
    .replace(/\bcd\s+/gi, 'Set-Location ')
    .replace(/\b(type|cat)\s+/gi, 'Get-Content ')
    .replace(/\bcopy\s+/gi, 'Copy-Item ')
    .replace(/\b(del|rmdir|remove)\s+/gi, 'Remove-Item ')
    .replace(/\bmove\s+/gi, 'Move-Item ')
    .replace(/\bren\s+/gi, 'Rename-Item ')
    .replace(/\bmkdir\s+/gi, 'New-Item -ItemType Directory -Force ');
}

const MAX_READ = 200 * 1024;
const MAX_WRITE = 2 * 1024 * 1024;

const TOOLS = [
  {
    name: 'read_file',
    description: '读取本机任意路径的文本文件（最大 200KB）。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径（绝对路径或相对路径）' } },
      required: ['path'],
    },
    async execute(args, ctx) {
      const file = resolvePath(ctx.workdir, args.path, ctx.cfg);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`文件不存在: ${args.path}`);
      const raw = fs.readFileSync(file, 'utf8');
      return raw.length > MAX_READ ? raw.slice(0, MAX_READ) + `\n…[已截断 ${raw.length - MAX_READ} 字符]` : raw;
    },
  },
  {
    name: 'write_file',
    description: '写入或覆盖文件（自动创建目录，最大 2MB，任意路径）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（绝对路径或相对路径）' },
        content: { type: 'string', description: '完整文件内容' },
        _confirm: { type: 'boolean', description: '职责边界护栏单次放行（true=确认本次越权写入）' },
      },
      required: ['path', 'content'],
    },
    async execute(args, ctx) {
      if (String(args.content).length > MAX_WRITE) throw new Error('内容超限');
      const file = resolvePath(ctx.workdir, args.path, ctx.cfg);
      assertWritable(file, ctx.cfg);
      // 关键只读保护：data/ 下意识数据（记忆/技能/会话/归档/进化等）禁止 write_file 直接改写
      if (isReadOnlyKeyPath(file)) {
        throw new Error(`写入被拒绝（关键数据只读保护）：${args.path}。请用业务接口（save_memory/save_skill/log_progress/propose_evolution）操作，或确认后走豁免通道。`);
      }
      // 自我修改范畴（src/、data/prompts/、config.json）：影子写入，验证通过才落盘
      // 批3 L3：跨实例运转件写入（main 运维雷影 src/config 等）同样纳入 shadowCommit（原只覆盖本实例根=缺口）
      let _cross = false;
      try { const _c = classifyTarget(file, ctx.cfg); _cross = _c.kind === 'INST' && !_c.inst.isMain; } catch { }
      if (inSelfModifyScope(file) || _cross) {
        return shadowCommit(file, String(args.content), `已写入 ${args.path}（${String(args.content).length} 字符）`);
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(args.content), 'utf8');
      return `已写入 ${args.path}（${String(args.content).length} 字符）`;
    },
  },
  {
    name: 'edit_file',
    description: '在文件中查找一段原文并替换（替换所有出现处）。只用于局部修改。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        old: { type: 'string', description: '要查找的原文（必须精确匹配）' },
        new: { type: 'string', description: '替换后的文本' },
        _confirm: { type: 'boolean', description: '职责边界护栏单次放行（true=确认本次越权修改）' },
      },
      required: ['path', 'old', 'new'],
    },
    async execute(args, ctx) {
      const file = resolvePath(ctx.workdir, args.path, ctx.cfg);
      if (!fs.existsSync(file)) throw new Error(`文件不存在: ${args.path}`);
      assertWritable(file, ctx.cfg);
      // 关键只读保护：data/ 下意识数据禁止 edit_file 直接改写
      if (isReadOnlyKeyPath(file)) {
        throw new Error(`写入被拒绝（关键数据只读保护）：${args.path}。请用业务接口操作，或确认后走豁免通道。`);
      }
      const raw = fs.readFileSync(file, 'utf8');
      const count = raw.split(String(args.old)).length - 1;
      if (count === 0) throw new Error('未找到匹配原文，请先 read_file 核对内容');
      const newContent = raw.split(String(args.old)).join(String(args.new));
      // 自我修改范畴（src/、data/prompts/、config.json）：影子写入，验证通过才落盘
      // 批3 L3：跨实例运转件写入（main 运维雷影 src/config）同样纳入 shadowCommit
      let _crossE = false;
      try { const _c = classifyTarget(file, ctx.cfg); _crossE = _c.kind === 'INST' && !_c.inst.isMain; } catch { }
      if (inSelfModifyScope(file) || _crossE) {
        return shadowCommit(file, newContent, `已替换 ${count} 处`);
      }
      fs.writeFileSync(file, newContent, 'utf8');
      return `已替换 ${count} 处`;
    },
  },
  {
    name: 'list_dir',
    description: '列出某目录的内容（名称/类型/大小，任意路径）。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录路径，默认当前目录' } },
    },
    async execute(args, ctx) {
      const dir = resolvePath(ctx.workdir, args.path || '.', ctx.cfg);
      if (!fs.existsSync(dir)) throw new Error(`目录不存在: ${args.path}`);
      return fs.readdirSync(dir, { withFileTypes: true })
        .map((e) => `${e.isDirectory() ? 'D' : 'F'} ${e.name}${e.isFile() ? `  ${fs.statSync(path.join(dir, e.name)).size}B` : ''}`)
        .join('\n');
    },
  },
  {
    name: 'search_files',
    description: '在文本文件里按正则搜索，返回 文件:行号:内容（最多 200 条，任意路径）。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索目录，默认当前目录' },
      },
      required: ['pattern'],
    },
    async execute(args, ctx) {
      const dir = resolvePath(ctx.workdir, args.path || '.', ctx.cfg);
      const re = new RegExp(args.pattern, 'i');
      const out = [];
      const skip = new Set(['node_modules', '.git', '.venv', 'dist', 'build']);
      const walk = (d, depth) => {
        if (depth > 6 || out.length >= 200) return;
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.isDirectory()) { if (!skip.has(e.name)) walk(path.join(d, e.name), depth + 1); continue; }
          if (!e.name.match(/\.(md|txt|js|ts|jsx|tsx|json|yaml|yml|html|css|py|env|cmd|bat|conf|ini|csv)$/i)) continue;
          if (out.length >= 200) return;
          let raw = '';
          try { raw = fs.readFileSync(path.join(d, e.name), 'utf8'); } catch { continue; }
          const lines = raw.split('\n');
          for (let i = 0; i < lines.length && out.length < 200; i++) {
            if (re.test(lines[i])) out.push(`${path.relative(ctx.workdir, path.join(d, e.name))}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
          }
        }
      };
      walk(dir, 0);
      return out.length ? out.join('\n') : '(无匹配)';
    },
  },
  {
    name: 'run_command',
    description: '在电脑上执行 PowerShell 命令（Windows）。cwd 默认当前目录。输出为 UTF-8（支持中文）。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 PowerShell 命令（支持 dir/cd/echo 等常见别名，&& 自动转换为顺序执行）' },
        cwd: { type: 'string', description: '执行目录（默认当前目录）' },
        _confirm: { type: 'boolean', description: '职责边界护栏单次放行（true=确认本次越权命令）' },
      },
      required: ['command'],
    },
    async execute(args, ctx) {
      const cmd = String(args.command);
      // 阈值级黑名单：仅 !fullAccess 时启用（默认最大权限下关闭）
      if (!ctx.cfg.fullAccess) {
        for (const re of COMMAND_BLOCKLIST) {
          if (re.test(cmd)) throw new Error(`命令被安全策略阻止（${re} 命中）：${cmd}`);
        }
      }
      // 细粒度保护：protectedCommands 即使 fullAccess 也拦截（默认空 = 不改变行为）
      const protCmds = Array.isArray(ctx.cfg && ctx.cfg.protectedCommands) ? ctx.cfg.protectedCommands : [];
      for (const pat of protCmds) {
        try {
          if (new RegExp(String(pat), 'i').test(cmd)) throw new Error(`命令被保护策略阻止（protectedCommands 命中：${pat}）`);
        } catch (e) { if (e && e.message && e.message.indexOf('命令被保护策略阻止') === 0) throw e; }
      }
      const cwd = args.cwd ? resolvePath(ctx.workdir, args.cwd, ctx.cfg) : ctx.workdir;
      // PowerShell 是 Windows 上中文/UTF-8 全通行的执行器（cmd.exe 的内建输出永远是 GBK）
      const ps = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); & { ${translateCmd(cmd)} }`;
      const execFile = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
      const execArgs = process.platform === 'win32'
        ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]
        : ['-c', cmd];
      return await new Promise((resolve) => {
        const signal = (ctx && ctx.signal) || null;   // v6.55：回合 abort 信号（/api/stop 时立即终止子进程）
        const tmo = Number(ctx.cfg.commandTimeoutMs) || 120000;   // v6.24：命令超时(ms)，缺省 120s
        const child = spawn(execFile, execArgs, { cwd, windowsHide: true });
        let out = '';
        let killed = false;
        let aborted = false;   // v6.55：回合 abort（/api/stop）触发的终止标记
        let done = false;
        let timer = null;
        let hardTimer = null;
        const cap = ctx.cfg.commandOutputCap;
        const push = (s) => { if (out.length < cap) out += s; };
        const finish = (code) => {
          if (done) return;
          done = true;
          try { clearTimeout(timer); } catch { }
          try { clearTimeout(hardTimer); } catch { }
          try { if (signal) signal.removeEventListener('abort', onAbort); } catch { }   // v6.55：移除 abort 监听，防泄漏/二次 resolve
          if (aborted) { resolve(`[已中止]${killed ? '[超时终止]' : ''}\n${out.slice(0, cap) || '(无输出)'}`); return; }
          resolve(`[exit=${code}]${killed ? '[超时终止]' : ''}\n${out.slice(0, cap) || '(无输出)'}`);
        };
        // v6.24：杀进程树。Windows 上 grandchild（如 headless Edge）会继承 stdout 管道句柄，
        // 仅 kill 直接子进程时管道仍开着 → 'close' 永不触发 → run_command 无限挂起、整个回合卡死。
        // 超时时用 taskkill /T /F 连同进程树终止，并设 3s 兜底 finish，保证 Promise 必然 settle。
        const killTree = () => {
          try {
            if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            else { try { child.kill('SIGKILL'); } catch { } }
          } catch { }
          try { child.kill('SIGKILL'); } catch { }
        };
        timer = setTimeout(() => { killed = true; killTree(); hardTimer = setTimeout(() => finish(null), 3000); }, tmo);
        // v6.55：回合 abort（/api/stop 或看门狗）时立刻终止子进程树，不再等 tmo（缺省 120s）；
        //   finish 时移除本监听，防止监听泄漏与二次 resolve。
        const onAbort = () => {
          if (done) return;
          aborted = true;
          try { clearTimeout(timer); } catch { }
          killTree();
          hardTimer = setTimeout(() => finish(null), 3000);
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort);
        }
        child.stdout.on('data', (d) => push(d.toString('utf8')));
        child.stderr.on('data', (d) => push('[stderr] ' + d.toString('utf8')));
        child.on('error', (e) => { done = true; try { clearTimeout(timer); } catch { } try { clearTimeout(hardTimer); } catch { } try { if (signal) signal.removeEventListener('abort', onAbort); } catch { } resolve(`[启动失败] ${e.message}`); });
        child.on('close', (code) => finish(code));
      });
    },
  },
  {
    name: 'recall_memory',
    description: '从长期记忆检索相关信息（关键词全文匹配）。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '检索关键词' } },
      required: ['query'],
    },
    async execute(args) {
      // L6：显式对齐内核默认（limit=6 / snippet 200 字）；v3.1 检索为 bigram 倒排+C打分
      const hits = memory.search(args.query, { kind: 'memory', limit: 6 });
      return hits.length ? hits.map((h) => `[${h.name}]\n${h.snippet}`).join('\n\n') : '(记忆中没有相关内容)';
    },
  },
  {
    name: 'save_memory',
    description: '沉淀一条长期记忆（同名记忆会自动追加新段落而不是覆盖）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '记忆条目名（简短）' },
        content: { type: 'string', description: '记忆内容' },
        aliases: { type: 'array', items: { type: 'string' }, description: '可选：别名列表（同义/简称），仅用于检索命中，不展示。' },
      },
      required: ['name', 'content'],
    },
    async execute(args, ctx) {
      const file = memory.save('memory', args.name, args.content, { aliases: args.aliases });
      return `已记忆 → ${file}`;
    },
  },
  {
    name: 'show_skills',
    description: '列出当前已掌握的全部技能（标题+一句话说明）。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const list = memory.list('skill');
      return list.length ? list.map((s) => `- ${s.title}`).join('\n') : '(尚未掌握任何技能)';
    },
  },
  {
    name: 'search_skills',
    description: '按关键词检索技能详情（描述/用法），返回命中的技能名+片段。技能目录只列名字，用法/详情用本工具按需查。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词' },
        limit: { type: 'number', description: '返回条数，默认 6' },
      },
      required: ['query'],
    },
    async execute(args) {
      const memory = require('./memory');
      const fsx = require('node:fs');
      const pth = require('node:path');
      const limit = Math.max(1, Math.min(20, parseInt(args.limit, 10) || 6));
      const hits = memory.search(String(args.query || ''), { kind: 'skill', limit });
      if (!hits.length) return '(技能库中没有匹配的技能)';
      const isPkgOf = (n) => { try { return fsx.existsSync(pth.join(memory.SKILL_DIR, n, 'main.py')); } catch { return false; } };
      return hits.map((h) => `[${h.name}]${isPkgOf(h.name) ? ' (可执行包)' : ''}\n${h.snippet}`).join('\n\n');
    },
  },
  {
    name: 'search_docs',
    description: '检索"以前写过的方案/脚本"（只读集合）。collection=doc → workspace/**/*.md（排除 projects 账本与 _archive/_tmp）；collection=script → scripts/*.py + workspace/tools/*。返回 [{name, path, snippet, score}]。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词' },
        collection: { type: 'string', enum: ['doc', 'script'], description: '集合：doc=方案文档（默认）/ script=脚本代码' },
        limit: { type: 'number', description: '返回条数，默认 6' },
      },
      required: ['query'],
    },
    async execute(args) {
      const memory = require('./memory');
      const col = (args.collection === 'script') ? 'script' : 'doc';
      const limit = Math.max(1, Math.min(20, parseInt(args.limit, 10) || 6));
      const hits = memory.search(String(args.query || ''), { kind: col, limit });
      if (!hits.length) return `(${col} 集合中没有匹配内容)`;
      return hits.map((h) => `[${h.name}] (score ${h.score})\n${h.path || ''}\n${h.snippet}`).join('\n\n');
    },
  },
  {
    name: 'save_skill',
    description: '沉淀一个新技能（可复用的操作流程/方法论）。description 会进入系统提示词。提供 code 则保存为可执行技能包（main.py 的 main(args)->str），之后可用 run_skill 执行。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名' },
        description: { type: 'string', description: '一句话描述（将显示在技能目录）' },
        content: { type: 'string', description: '技能正文：步骤、示例、注意事项' },
        code: { type: 'string', description: '可选：Python 源码，定义 def main(args: dict) -> str' },
      },
      required: ['name', 'description', 'content'],
    },
    async execute(args, ctx) {
      // A 收窄（2026-10-02）：语义型入口不再用 assertSafeWindow 拦（已走 pfxWrite 入队，由队列择时落地）。
      const file = memory.save('skill', args.name, args.content, { description: args.description, code: args.code });
      const isPkg = args.code && String(args.code).trim();
      // P1（2026-10-02）：技能沉淀已统一入队（见 memory.save 白名单）→ 如实告知"已入队、待小窗落地"
      if (file && typeof file === 'object' && file.queued) {
        return `技能已入队（id=${file.id}，dedup=${file.dedup}）；将在下一次小窗请求前一次性落地生效（合并省钱）。`;
      }
      return `技能已沉淀 → ${file}${isPkg ? '（可执行技能包：可用 run_skill 运行）' : ''}（技能目录已更新，下一次请求会命中新前缀）`;
    },
  },
  {
    name: 'propose_evolution',
    description: '【进化】提出对自身行为规则/memory/skill 的改进提案。默认自动批准生效（可回滚）；改变 system.md 即改变你的基因组。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['system.md', 'harness', 'memory', 'skill'], description: '进化目标（system.md=基础基因组；harness=可变的补充态，基础基因组保持稳定）' },
        title: { type: 'string', description: '提案标题' },
        rationale: { type: 'string', description: '为什么改（收益/证据）' },
        audit: {
          type: 'object',
          description: '(可选) Capsule式审计：trigger触发信号/intent意图(repair|optimize|innovate|explore)/blastRadius风险范围/validation验证结果/confidence置信度0-1',
          properties: {
            trigger: { type: 'string', description: '触发信号（如"重复收到同错误/性能指标"）' },
            intent: { type: 'string', enum: ['repair', 'optimize', 'innovate', 'explore', 'auto'], description: '演进意图' },
            blastRadius: { type: 'string', description: '风险范围（影响哪些/多大）' },
            validation: { type: 'string', description: '验证结果（如何确认改动正确）' },
            confidence: { type: 'number', description: '置信度 0~1' },
          },
        },
        content: { type: 'string', description: '新的完整内容（与 patch 二选一）' },
        patch: {
          type: 'object',
          description: '局部替换（与 content 二选一）',
          properties: {
            old: { type: 'string', description: '原文' },
            new: { type: 'string', description: '替换后' },
          },
        },
      },
      required: ['target', 'title', 'rationale'],
    },
    async execute(args, ctx) {
      const cfg = ctx.cfg;
      // A 收窄（2026-10-02）：语义型入口不再用 assertSafeWindow 拦（已走 pfxWrite 入队）。
      let target = args.target;
      if (target === 'memory' || target === 'skill') {
        // 缺少名称参数时报错，引导用 save_memory/save_skill
        throw new Error(`${target} 的进化请直接使用 save_${target === 'memory' ? 'memory' : 'skill'} 工具；propose_evolution 主要用于 system.md（基因组）`);
      }
      // 不可变基因组：system.md 提案自动重定向到补充态 harness.md（基础 genome 不被改写）
      if (cfg.immutableGenome && target === 'system.md') target = 'harness';
      // P1（2026-10-02）：进化提案是"击穿前缀"操作 → 统一入队（队列不可用→降级直写）。
      try {
        const _q = require('./pfxqueue');
        if (_q.enabled()) {
          const _r = _q.pfxWrite('evolution', args.content, { op: 'evolution', name: args.title, evoTarget: target, title: args.title, rationale: args.rationale, patch: args.patch });
          if (_r && _r.queued) return `✅ 进化提案已入队（id=${_r.id}，dedup=${_r.dedup}）；将在下一次小窗请求前一次性落地生效（合并省钱、可回滚）。`;
        }
      } catch { }
      let p;
      try {
        p = evolution.propose({ target, title: args.title, rationale: args.rationale, content: args.content, patch: args.patch, audit: args.audit });
      } catch (e) {
        // patch 未匹配时，把目标当前内容附给模型，便于它下次带正确的 old 重试
        if (/未能找到匹配原文/.test(e.message)) {
          let cur = '';
          try { cur = fs.readFileSync(path.join(path.dirname(__dirname), 'data', 'prompts', 'system.md'), 'utf8'); } catch { }
          throw new Error(`${e.message}\n\n【系统提示：以下是 system.md 当前内容（用于核对 patch.old 原文），${cur.length} 字符】\n${cur.slice(0, 8000)}`);
        }
        throw e;
      }
      if (cfg.evolutionAutoApply) {
        try {
          const applied = await evolution.approve(p.id, { auto: true });
          return `✅ 进化提案已自动生效（id=${applied.id}）\n标题: ${applied.title}\n目标: ${applied.target}\n说明: ${applied.rationale}\n版本已归档，可用 rollback 撤销。`;
        } catch (gateErr) {
          return `⚠️ 进化提案被质量门禁拦截（id=${p.id}，状态待批准）\n标题: ${p.title}\n原因: ${gateErr.message}`;
        }
      }
      return `⚠️ 进化提案待批准（id=${p.id}）\n标题: ${p.title}\n目标: ${p.target}\n说明: ${p.rationale}\n请在界面「进化」页批准或否决。`;
    },
  },
  {
    name: 'spawn_subagent',
    description: '派出一个子智能体（与主智能体同权：全工具/记忆/进化/通信/派孙级）执行独立任务。mode=sync 等待结果并直接返回；mode=background 立即返回 agentId，稍后用 fetch_subagent 取结果。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '交给子智能体的任务' },
        role: { type: 'string', description: '角色标注，如 研究员/审计员/检查员' },
        mode: { type: 'string', enum: ['sync', 'background'], description: '默认 sync' },
        maxTurns: { type: 'number', description: '最多几轮工具调用，默认按配置' },
      },
      required: ['task'],
    },
    async execute(args, ctx) {
      const subagent = require('./subagent');
      // v6.55：回合 abort（/api/stop）**不级联终止**子智能体——background 子智能体本就设计为独立长跑，
      //   不应随发起回合的停止而被杀（故此处不接 ctx.signal、不做 kill）。
      return subagent.spawn(args, ctx);
    },
  },
  {
    name: 'fetch_subagent',
    description: '等待/获取背景子智能体的结果。',
    parameters: {
      type: 'object',
      properties: { agentId: { type: 'string', description: 'spawn_subagent 返回的 id' } },
      required: ['agentId'],
    },
    async execute(args) {
      const subagent = require('./subagent');
      return subagent.fetch(args.agentId);
    },
  },
  {
    name: 'web_search',
    description: '网页搜索（DuckDuckGo）。返回标题+链接+摘要。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索词' } },
      required: ['query'],
    },
    async execute(args) {
      const searchSources = [bingSearch, ddgSearch];
      const errs = [];
      for (const fn of searchSources) {
        try {
          const r = await fn(args.query);
          if (r && r.indexOf('(未') !== 0) return r;
          errs.push(r || 'no results');
        } catch (e) {
          errs.push(e.message);
        }
      }
      throw new Error(`所有搜索源均失败: ${errs.join('; ')}`);
    },
  },
  {
    name: 'web_fetch',
    description: '抓取一个网页的文本内容（支持 http/https，可访问内网地址）。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) 链接' } },
      required: ['url'],
    },
    async execute(args, ctx) {
      return fetchUrl(args.url, ctx.cfg ? ctx.cfg.webFetchMaxBytes : 1048576, ctx.cfg);
    },
  },
  // ———— 以下为"真正的智能体"新能力（只追加，不重排） ————
  {
    name: 'python_repl',
    description: '持久 Python REPL（RLM 内核）：在本会话的 Python 解释器中执行代码，变量/导入/状态跨调用保留。print 输出会返回；异常返回 traceback。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python 代码' },
        reset: { type: 'boolean', description: 'true 则重启 REPL 清空状态后再执行（默认 false）' },
      },
      required: ['code'],
    },
    async execute(args, ctx) {
      const repl = require('./repl');
      // v6.55：回合 abort（/api/stop）时杀掉常驻内核并标记需重建——restart() 结束进程、从 procs 移除（下次
      //   evalCode 自动重新 init，尽力从快照恢复），与 run_command 的"停止=真停"语义一致；返回前移除监听防泄漏。
      const signal = (ctx && ctx.signal) || null;
      const onAbort = () => { try { repl.restart(ctx.sessionId); } catch { } };
      if (signal && !signal.aborted) { try { signal.addEventListener('abort', onAbort); } catch { } }
      try {
        const r = await repl.evalCode(ctx.sessionId, String(args.code), { timeoutMs: ctx.cfg.replTimeoutMs, reset: !!args.reset });
        const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
        if (!r.ok) return `[Python 错误]\n${(r.error || r.stderr || '').trim()}`.concat(out ? `\n[已输出] ${out.slice(0, 2000)}` : '');
        return out || '(执行成功，无输出)';
      } finally {
        try { if (signal) signal.removeEventListener('abort', onAbort); } catch { }
      }
    },
  },
  {
    name: 'run_skill',
    description: '执行可执行技能包：data/skills/<技能名>/main.py 的 main(args)→str，在会话 Python REPL 中运行（可复用 REPL 已有状态）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名（如 deep-file-audit）' },
        args: { type: 'object', description: '传给 main(args) 的参数对象' },
      },
      required: ['name'],
    },
    async execute(args, ctx) {
      const repl = require('./repl');
      const { skillMain } = require('./skills');
      const mainPy = skillMain(args.name);
      if (!mainPy) throw new Error(`技能「${args.name}」不是可执行技能包（缺 main.py）。可用 save_skill 携带 code 参数创建可执行技能。`);
      const modName = 'leizai_skill_' + String(args.name).replace(/[^A-Za-z0-9_]/g, '_');
      const pyPath = mainPy.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const stub = [
        `import importlib.util as _ilu`,
        `import json as _json`,
        `_spec = _ilu.spec_from_file_location("${modName}", r"${pyPath}")`,
        `_mod = _ilu.module_from_spec(_spec)`,
        `_spec.loader.exec_module(_mod)`,
        // args 作为 JSON 字符串传给 Python 的 json.loads 解析：JSON 的 true/false/null 与 Python 的
        // True/False/None 大小写不同，直接嵌入源码会 NameError（如 {append:true}）。用 json.loads 让
        // Python 安全解析成 dict，彻底避开 JSON↔Python 字面量冲突。
        `_result = _mod.main(_json.loads(${JSON.stringify(JSON.stringify(args.args || {}))})) if callable(getattr(_mod, "main", None)) else "(技能无 main 函数)"`,
        `print(_result)`,
      ].join('\n');
      const r = await repl.evalCode(ctx.sessionId, stub, { timeoutMs: ctx.cfg.skillTimeoutMs });
      if (!r.ok) return `[技能执行错误 ${args.name}]\n${(r.error || r.stderr || '').trim()}`;
      return [r.stdout, r.stderr].filter(Boolean).join('\n').trim() || '(技能执行完成，无输出)';
    },
  },
  {
    name: 'agent_list',
    description: '列出当前所有智能体（子智能体 + 主会话），含 id/角色/状态。用于 agent 间寻址。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const subagent = require('./subagent');
      return subagent.listView();
    },
  },
  {
    name: 'agent_send',
    description: '给另一个智能体发消息（agent 间直接通信）：目标智能体在下一轮会收到该消息并继续工作。',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '目标 id（agent_list 可见的 sub-* 子智能体 id 或 s-* 主会话 id）' },
        message: { type: 'string', description: '消息内容（指令/请求/汇报）' },
        type: { type: 'string', enum: ['task', 'reply', 'result', 'notify', 'ack'], description: '消息类型：task=派活(需处理，默认) / result=对某 task 的最终应答(带 correlationId) / reply=回执(只需知晓，不再进待办) / notify=通知 / ack=确认。发回执时显式传 reply，可避免被当成待办反复续跑。' },
        correlationId: { type: 'string', description: '仅 type=result 必填：指回原 task 的 cid（发起方 agent_send 一条 task 后，返回文本内含 cid=…）。' },
        outcome: { type: 'string', enum: ['done', 'partial', 'failed', 'rejected'], description: '仅 type=result：任务结论枚举。' },
        priority: { type: 'string', enum: ['urgent', 'high', 'normal'], description: '优先级：urgent=突破静默立即唤醒 / high=置顶+缩短合并窗口 / normal=默认。紧急派单用 urgent。' },
        deadline: { type: 'number', description: '（可选）仅 type=task：任务截止时间戳（毫秒）；到期未终态将被标记 expired 并唤醒你一次。' },
        meta: { type: 'object', description: '（可选）仅 type=task：结构化头，白名单字段 acceptance/redlines/refs/artifacts/evidence/schema_version/topic（及 parentId/deadline）。topic=枝键：接收方整段任务挂该枝（派单驱动归枝）。' },
      },
      required: ['agentId', 'message'],
    },
    async execute(args, ctx) {
      const subagent = require('./subagent');
      const _msgType = String(args.type || 'task');
      // P1（refs=send-idem-trap）：correlationId 仅对 type=result 有意义；非 result 一律不透传（否则复用 cid 会被当幂等键静默吞消息）。
      let _cid = args.correlationId;
      let _warn = '';
      if (_cid != null && String(_cid) !== '' && _msgType !== 'result') {
        _warn = `⚠ 已忽略 correlationId（仅 type=result 有效，当前 type=${_msgType}）：该值会被当作幂等键，复用旧 cid 会导致消息被静默吞掉。\n`;
        _cid = undefined;
      }
      const _out = await subagent.send(String(args.agentId), String(args.message), ctx.sessionId || 'main', args.type, args.priority, { correlationId: _cid, outcome: args.outcome, meta: args.meta, deadline: args.deadline, parentId: (args.meta && args.meta.parentId), topic: (args.meta && args.meta.topic) || args.topic });
      return _warn ? (_warn + _out) : _out;
    },
  },
  {
    name: 'agent_inbox',
    description: '读取并清空自己的消息信箱（其他智能体发给你的消息）。',
    parameters: { type: 'object', properties: {} },
    async execute(args, ctx) {
      const subagent = require('./subagent');
      return subagent.inbox(ctx.sessionId || 'main', ctx.sessionId || null);
    },
  },
  {
    name: 'schedule_heartbeat',
    description: '为本会话注册心跳：每隔 intervalSec 秒自动注入一条消息并继续工作（可持续到任务完成，任务页可停止）。',
    parameters: {
      type: 'object',
      properties: {
        intervalSec: { type: 'number', description: '心跳间隔（秒），最小 5' },
        message: { type: 'string', description: '每次心跳注入的内容，如「检查并继续推进目标」' },
      },
      required: ['intervalSec', 'message'],
    },
    async execute(args, ctx) {
      const scheduler = require('./scheduler');
      const s = scheduler.createHeartbeat(ctx.sessionId, Math.max(5, Math.floor(Number(args.intervalSec)) || 3600), String(args.message));
      return `✅ 心跳已注册（id=${s.id}，每 ${Math.max(5, Math.floor(Number(args.intervalSec)) || 3600)} 秒）：${s.message}\n下次触发：${new Date(s.nextRun).toLocaleString('zh-CN')}\n任务页或 schedule_stop 可停止。`;
    },
  },
  {
    name: 'schedule_at',
    description: '定时任务：在指定时间（ISO 时间串，如 2026-01-01T09:00:00+08:00；或每天 HH:MM + repeats=true）向本会话注入一条消息并工作。',
    parameters: {
      type: 'object',
      properties: {
        at: { type: 'string', description: 'ISO 时间串或 HH:MM' },
        message: { type: 'string', description: '触发时注入的内容' },
        repeats: { type: 'boolean', description: 'HH:MM 模式下是否每天重复（默认 false）' },
      },
      required: ['at', 'message'],
    },
    async execute(args, ctx) {
      const scheduler = require('./scheduler');
      const s = scheduler.createAt(ctx.sessionId, String(args.at), String(args.message), { repeats: !!args.repeats });
      return `✅ 定时任务已注册（id=${s.id}）：${s.message}\n下次触发：${new Date(s.nextRun).toLocaleString('zh-CN')}`;
    },
  },
  {
    name: 'schedule_stop',
    description: '停止/删除一条心跳或定时任务。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '调度 id（schedule_heartbeat/schedule_at 返回）' } },
      required: ['id'],
    },
    async execute(args) {
      const scheduler = require('./scheduler');
      const ok = scheduler.remove(String(args.id));
      return ok ? `✅ 调度已停止（${args.id}）` : `调度不存在: ${args.id}`;
    },
  },
  // ———— MCP（Model Context Protocol）外部工具（对齐 Prime Agent 的 MCP 集成） ————
  {
    name: 'mcp_list_tools',
    description: '列出指定 MCP 服务器（config.mcpServers 里配置的 stdio 服务器）提供的工具。',
    parameters: {
      type: 'object',
      properties: { server: { type: 'string', description: 'MCP 服务器名（对应 config.mcpServers 的 name）' } },
      required: ['server'],
    },
    async execute(args) {
      const mcp = require('./mcp');
      const tools = await mcp.listTools(String(args.server));
      return tools.length ? tools.map((t) => `- ${t.name}: ${t.description || ''}`).join('\n') : '(该 MCP 服务器没有工具)';
    },
  },
  {
    name: 'mcp_call',
    description: '调用指定 MCP 服务器上的一个工具，并把结果文本返回。',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP 服务器名' },
        tool: { type: 'string', description: '要调用的 MCP 工具名' },
        args: { type: 'object', description: '传给该工具的参数对象' },
      },
      required: ['server', 'tool'],
    },
    async execute(args) {
      const mcp = require('./mcp');
      return mcp.call(String(args.server), String(args.tool), args.args || {});
    },
  },
  {
    name: 'recall_context',
    description: '检索本会话因上下文变长而"静默归档"到后台的早期历史细节（原始目标、早期决定、当时的具体内容）。统一入口：一次查询同时检索「记忆 + 归档 + doc + 会话树（branch.db）」，按 RRF 融合并标注来源。scope=session 仅本会话（含本会话树），scope=all 跨会话（含跨会话树/轮骨架原文）。当你感到早期细节只能靠摘要回忆时，用它在当前对话里把旧细节调回来，避免凭空推断。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要回顾的关键词/主题' },
        scope: { type: 'string', enum: ['session', 'all'], description: 'session=仅本会话（默认）｜all=跨会话（结果带会话标注）' },
        include: { type: 'string', description: '归档层过滤：默认对话层；填 tool=证据层；all=全层' },
        layer: { type: 'string', description: '兼容参数（默认对话层）' },
      },
      required: ['query'],
    },
    async execute(args, ctx) {
      if (!ctx || !ctx.sessionId) return '（当前无会话，无法检索归档）';
      const query = String(args.query || '');
      if (!query) return '（空查询）';
      const cfg = (() => { try { return require('./config').load(); } catch { return {}; } })();
      // D1 开关关闭 → 完全回退旧行为（可一键回滚）
      if (cfg.recallUnified === false) {
        const hits = memory.archiveSearch(ctx.sessionId, query, 6);
        if (hits.length === 0) return '（归档中暂无相关内容）';
        const PER = 800, MAX = 5000;
        const parts = hits.map((h) => {
          let c = String(h.content || h.snippet || '');
          if (c.length > PER) c = c.slice(0, PER) + '…（单条已截断）';
          return `[${h.role === 'user' ? '用户' : '助手'} · ${new Date(h.ts).toLocaleString('zh-CN')}]\n${c}`;
        });
        let out = parts.join('\n\n');
        if (out.length > MAX) out = out.slice(0, MAX) + '\n…（输出过长已截断，全文见归档；可用更精确的关键词二次召回）';
        return out;
      }
      // —— D1：统一检索（memory + archive + doc → RRF 融合 k=60，标注来源）——
      const scope = (args.scope === 'all') ? 'all' : 'session';
      const include = args.include;
      const PER_SRC = 8;
      const lists = [];
      // 1) 记忆层
      let memHits = [];
      try { memHits = memory.search(query, { kind: 'memory', limit: PER_SRC }) || []; } catch { memHits = []; }
      lists.push({
        source: '记忆',
        items: memHits.map((h) => ({ key: 'mem:' + (h.name || ''), kind: 'memory', name: h.name || '', text: h.snippet || '' })),
      });
      // 2) 归档层（scope=session 仅本会话；all 跨会话，带会话标注）
      let arcItems = [];
      try {
        if (scope === 'all') {
          const sids = (require('./archiveStore').listSessionIds() || []).slice(0, 200);
          for (const sid of sids) {
            const hs = memory.archiveSearch(sid, query, 3, include ? { include } : {});
            for (const h of hs) arcItems.push({ key: 'arc:' + sid + ':' + h.ts, kind: 'archive', sessionId: sid, text: h.content || h.snippet || '' });
          }
        } else {
          const hs = memory.archiveSearch(ctx.sessionId, query, PER_SRC, include ? { include } : {});
          for (const h of hs) arcItems.push({ key: 'arc:' + ctx.sessionId + ':' + h.ts, kind: 'archive', sessionId: ctx.sessionId, text: h.content || h.snippet || '' });
        }
      } catch { arcItems = []; }
      lists.push({ source: '归档', items: arcItems });
      // 3) doc 层（方案/脚本只读集合）
      let docHits = [];
      try { docHits = memory.search(query, { kind: 'doc', limit: PER_SRC }) || []; } catch { docHits = []; }
      lists.push({
        source: 'doc',
        items: docHits.map((h) => ({ key: 'doc:' + (h.name || ''), kind: 'doc', name: h.name || '', path: h.path || '', text: h.snippet || '' })),
      });
      // 4) 会话树层（branch.db：轮骨架 + 决定/记/果）—— D1+：检索统一入口并入树
      //    稳健性：branch 查询失败/异常一律降级为空（不影响主流程）；LIMIT 由 searchEvents 内部 clamp(≤50)。
      let treeItems = [];
      try {
        const treeLimit = (scope === 'all') ? 12 : 8;
        let evs = [];
        // 补修（2026-10-03）：scope=session 走 **SQL 级 session 过滤**（searchEvents 第3参），在 LIMIT 前生效；
        //   不再"先取全局 top-N 再事后 filter"——修正本会话命中被其它会话命中挤掉 → 误判 0 命中 的缺陷。
        try { evs = branch.searchEvents(query, treeLimit, scope === 'session' ? ctx.sessionId : null) || []; } catch { evs = []; }
        const KIND_CN = { turn: '轮', decision: '决定', fruit: '果', note: '记' };
        for (const e of evs) {
          treeItems.push({
            key: 'tree:' + e.sessionId + ':' + e.kind + ':' + (e.turnNo != null ? e.turnNo : e.ts),
            kind: 'tree', sessionId: e.sessionId, name: KIND_CN[e.kind] || e.kind,
            text: e.payload || '',
          });
        }
      } catch { treeItems = []; }
      lists.push({ source: '树', items: treeItems });
      // RRF 融合（k=60）
      const K = 60;
      const fused = new Map();
      for (const { source, items } of lists) {
        items.forEach((it, idx) => {
          const rrf = 1 / (K + idx + 1);
          const cur = fused.get(it.key);
          if (cur) { cur.rrf += rrf; if (!cur.sources.includes(source)) cur.sources.push(source); }
          else fused.set(it.key, { ...it, rrf, sources: [source] });
        });
      }
      const ranked = [...fused.values()].sort((a, b) => b.rrf - a.rrf);
      if (!ranked.length) return '（无匹配：记忆 / 归档 / doc / 会话树 均无相关内容）';
      const PER = 500, MAX = 5000;
      const parts = [];
      let total = 0;
      for (const it of ranked.slice(0, 12)) {
        let head;
        if (it.kind === 'archive') head = `[归档·${it.sessionId}${it.sessionId === ctx.sessionId ? '（本会话）' : ''}]`;
        else if (it.kind === 'memory') head = `[记忆] ${it.name}`;
        else if (it.kind === 'tree') head = `[树·${it.name}·${it.sessionId}${it.sessionId === ctx.sessionId ? '（本会话）' : ''}]`;
        else head = `[doc] ${it.name}${it.path ? ' · ' + it.path : ''}`;
        let c = String(it.text || '');
        if (c.length > PER) c = c.slice(0, PER) + '…（单条已截断）';
        const block = `${head}\n${c}`;
        if (total + block.length > MAX) break;
        parts.push(block); total += block.length;
      }
      let out = parts.join('\n\n');
      if (out.length > MAX) out = out.slice(0, MAX) + '\n…（输出过长已截断；可用更精确的关键词二次召回）';
      return out;
    },
  },
  {
    name: 'force_handoff',
    description: '【空间管理·主动交接·仅限紧急】立即触发一次世代交接，把窗口收拢到最小(≈3-8k token)，全部旧内容归档（可用 recall_context 召回）。仅当某项击穿前缀的改动（改引擎源码 src/、存技能、进化、重载插件）非常紧急、不得不然、否则会影响后续执行时才使用；用完立即执行该前缀操作使其生效。非紧急的前缀操作一律攒到引擎自动交接后的首回合做（先补前缀、再回复），禁止为省成本而主动交接。',
    parameters: { type: 'object', properties: {} },
    async execute(args, ctx) {
      if (!ctx || !ctx.sessionId) return '（当前无会话，无法交接）';
      const runtime = require('./runtime');
      const s = runtime.getSession(ctx.sessionId);
      const r = await runtime.forceHandoff(s);
      return `✅ 已主动交接：归档 ${r.dropped} 条，窗口重建到最小（第 ${r.gen} 代），可开始做前缀操作。`;
    },
  },
  {
    name: 'adjust_context_budget',
    description: '【空间管理·会话级】调整本会话的上下文预算（token 数）。世代交接 v3 下引擎自动管理窗口：预算用满后，**你下一条消息发出前**自动完成一次全量交接（旧回合全归档，窗口重建为「交接文档 + 本消息」）——**重任务不需要为了能跑而调大预算**（用完会自动交接归档；交接时机由主人的消息节奏驱动，不影响体验）。全局默认取 config.contextBudget（当前 20W=200000）：①轻对话/反思/简单提问 → 可下调 40000（更快更省）；②常规工具/开发任务 → **跟随全局默认**；③需要单代超长链（>30 轮不交接）/更连贯上下文 → 可上调（如 50W+），代价=每轮输入随窗口增大（主要是"缓存命中"部分，单价低但量大）+ 窗口末段注意力衰减，收益=少交接、少丢上下文。实测：成本大头是"输出"与"未命中"（单价约为命中的 200×/50×），命中历史很便宜 → 省钱靠少迭代、少击穿缓存前缀，而非只调窗口。传 auto 按最近负载推荐（目标默认=运行时 config.contextBudget）。预算只影响"保留多少历史"，规则/决定在记忆与进度文件，不受影响。',
    parameters: {
      type: 'object',
      properties: {
        budget: { type: 'string', description: '整数 token 数（如 "60000"），或 "auto"（自动推荐），或 "default"（恢复全局默认）' },
        reason: { type: 'string', description: '为何调整（一句话，记入进度文件）' },
      },
      required: ['budget'],
    },
    async execute(args, ctx) {
      if (!ctx || !ctx.sessionId) return '（当前无会话，无法调整预算）';
      const runtime = require('./runtime');
      const sid = ctx.sessionId;
      const b = args ? String(args.budget || '').trim().toLowerCase() : '';
      let v = null, note = '';
      try {
        if (b === 'default' || b === '') {
          v = null;
          note = '恢复跟随全局默认';
        } else if (b === 'auto') {
          const s = runtime.getSession(sid);
          const msgs = (s.messages || []).slice(-30);
          let tok = 0, tool = 0, all = 0;
          for (const m of msgs) {
            tok += runtime.estimateTokens(m);
            const c = String(m.content || '');
            all += c.length;
            if (m.role === 'tool') tool += c.length;
          }
          const ratio = all ? tool / all : 0;
          const cur = runtime.effectiveBudget(s);
          // 世代交接下预算角色变了：长任务不需要调大（自动深收纳 + 交接文档）；
          // auto 的目标默认取运行时真实全局默认（config.contextBudget），不写死
          const def = (() => { try { const d = Number(require('./config').load().contextBudget); return Number.isInteger(d) && d >= 1000 ? d : 200000; } catch { return 200000; } })();
          if (tok < 12000 && ratio < 0.3 && cur > 40000) {
            v = 40000; note = '轻任务、负载低 → 40000（更快更省）';
          } else if (tok > 40000 && ratio > 0.4 && cur < def) {
            v = def; note = `工具占比高且负载重 → 恢复到全局默认 ${def}（继续调大无收益）`;
          } else {
            return `（自动判断：无需调整，当前预算 ${cur} 合适——近30条≈${Math.round(tok)} token，工具占比 ${Math.round(ratio * 100)}%；世代交接会自动归档，无需为长任务调大）`;
          }
        } else {
          const n = parseInt(b, 10);
          if (!Number.isInteger(n) || n < 1000) return '（budget 需为 ≥1000 的整数，或 auto / default）';
          v = n;
          note = '手动指定';
        }
        const r = runtime.patchSession(sid, { contextBudget: v });
        const eff = runtime.effectiveBudget(runtime.getSession(sid));
        let extra = '';
        if (args && args.reason) {
          try {
            const p = path.join((ctx.cfg && ctx.cfg.workdir) || '.', 'projects', String(sid).replace(/[^A-Za-z0-9_-]/g, '_'), '_progress.md');
            if (ctx.cfg && ctx.cfg.workdir) {
              fs.mkdirSync(path.dirname(p), { recursive: true });
              fs.appendFileSync(p, `- [${localTimeStr()}] 【会话预算】${note} → ${eff} token（${String(args.reason).slice(0, 200)}）\n`, 'utf8');
              extra = '（已记入进度文件）';
            }
          } catch { }
        }
        return `✅ 本会话上下文预算 = ${eff} token（${note}${v === null ? '，随全局 config.contextBudget=' + require('./config').load().contextBudget : ''}），仅本会话生效；${extra || '规则/决定不受影响'}`;
      } catch (e) { return `[预算调整失败] ${e.message}`; }
    },
  },
  {
    name: 'log_progress',
    description: '【进度记账·规则双保险】把项目进展/关键决定/必须长期遵守的规则，追加到本会话的独立项目进度文件（工作目录/projects/<会话id>/_progress.md）。确立重要规则或达成关键决定时，用它与 save_memory 一起记录（记忆 + 进度文件各留一笔），保证即使归档被清理也不丢。',
    parameters: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: '一句话记录（进展/决定/规则）' },
        level: { type: 'string', enum: ['key', 'prefix', 'todo', 'flow'], description: '写入层级：key=常驻关键决定（自动去重 + 同时存记忆），prefix=待补前缀操作区（击穿前缀类操作，随交接文档常驻携带），todo=待办区，flow=默认流水' },
        fruitFrom: { type: 'string', description: '可选（仅 level=todo）：显式声明"该待办已完成"，值为成果摘要（≤60字）。提供时即使内容无完成标记，也会自动补写一条 kind=fruit 支干事件（花→果）。' },
        topic: { type: 'string', description: '可选：枝键（topic_key）——把当前轮归入显式枝，供 project action=branch 使用（幂等、精确更新）。' },
        done: { type: 'boolean', description: '可选（level=todo/prefix）：显式声明该条目为"已完成/核销"——不写 open 待办；能匹配同名 open 则勾销，否则仅记 note。' },
        abort: { type: 'boolean', description: '可选（仅 level=todo）：显式声明该任务“已终止/作废”（≠完成）——写 kind=todo-abort 终止标记，交接/任务现场不再复活续跑；**可逆**：之后重记同名 todo 即重新开工。' },
        ackConflict: { type: 'boolean', description: '可选（batchB）：true=确认“保留两条”，对相似待补项做免提示标记（记 branch note，同一对不再重复提示）' },
      },
      required: ['entry'],
    },
    async execute(args, ctx) {
      if (!ctx || !ctx.sessionId || !ctx.cfg || !ctx.cfg.workdir) return '（当前无有效会话/工作目录）';
      const dir = path.join(ctx.cfg.workdir, 'projects', String(ctx.sessionId).replace(/[^A-Za-z0-9_-]/g, '_'));
      try {
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, '_progress.md');
        // P3·账本退役：ledgerReadOnly=true → 跳过 _progress.md 写入（只读归档），仅写支干。
        const ledgerRO = !!(ctx.cfg && ctx.cfg.ledgerReadOnly === true);
        if (!ledgerRO && !fs.existsSync(f)) fs.writeFileSync(f, `# 项目进度\n`, 'utf8');
        const level = (args && args.level) || 'flow';
        const entry = String(args.entry || '').replace(/\n+/g, ' ').slice(0, 1000);
        // P0⑦修正：topic → 透传到本轮各 append（append 支持 e.topicKey），避免"首次 log_progress 时该轮尚无事件行、UPDATE 命中 0 行"导致丢失。
        const topic = String((args && args.topic) || '').trim();
        const tkArg = topic ? { topicKey: topic } : {};
        if (level === 'key') {
          if (!ledgerRO) progressUpsertBlock(f, 'KEY', `- ${entry}`, entry);
          try { memory.save('memory', '关键决定·' + entry.slice(0, 24), entry); } catch { }   // 双写记忆
          try { branch.append({ sessionId: ctx.sessionId, gen: ctx.branchGen, turnId: ctx.branchTurnId, kind: 'decision', payload: entry, ...tkArg }); } catch { }   // 双写支干
          if (!ledgerRO) progressRollArchive(f);
          return `已记入常驻关键区（KEY，同名自动去重）并双写记忆：${path.relative(ctx.cfg.workdir, f)}` + (ledgerRO ? '（账本只读：未写 _progress.md，仅写支干）' : '');
        }
        if (level === 'todo') {
          const clean = String(entry).replace(/^[-*]?\s*\[\s*\]\s*/, '').trim();
          // ④（2026-10-05）：**显式终止**——写 todo-abort 终止标记（≠完成），交接/任务现场不再复活续跑；可逆（重记同名 todo 即重开）。
          //   仅显式 args.abort 触发（**绝不**由 /api/stop 等自动产生，防误排除真在途任务）。
          if (args && args.abort) {
            const body2a = stripDoneMarkers(clean).trim();
            let payA = null;
            try { payA = branch.resolveOpenTodoPayload(ctx.sessionId, body2a, 16); } catch { }
            const payloadA = payA || clean;
            try { if (!branch.hasEvent(ctx.sessionId, ctx.branchTurnId, 'todo-abort', payloadA)) branch.append({ sessionId: ctx.sessionId, gen: ctx.branchGen, turnId: ctx.branchTurnId, kind: 'todo-abort', payload: payloadA, ...tkArg }); } catch { }
            if (!ledgerRO) progressRollArchive(f);
            return `已标记任务终止（todo-abort·不计待办·可反向重开）：${path.relative(ctx.cfg.workdir, f)}` + (ledgerRO ? '（账本只读：未写 _progress.md，仅写支干）' : '');
          }
          // v6.38（P1/P2）：完成态判定改**函数**（覆盖句中标记），且**完成类绝不再写 open todo**（防正反馈）。
          const isDone2 = isDoneEntry(clean, entry, args);
          if (!ledgerRO) progressUpsertBlock(f, 'TODO', `- [ ] ${clean}`, clean);
          if (!isDone2) {
            try { branch.append({ sessionId: ctx.sessionId, gen: ctx.branchGen, turnId: ctx.branchTurnId, kind: 'todo', payload: clean, ...tkArg }); } catch { }
          } else {
            // P1：完成/核销类 —— ①能匹配同名 open → 写 todo-done（归一化匹配，无条件可用）；②无匹配 → 写 note（**不占 todo 入口**）。
            const body2 = stripDoneMarkers(clean).trim();
            let pay = null;
            try { pay = branch.resolveOpenTodoPayload(ctx.sessionId, body2, 16); } catch { }
            try {
              if (pay) {
                if (!branch.hasEvent(ctx.sessionId, ctx.branchTurnId, 'todo-done', pay)) {
                  branch.append({ sessionId: ctx.sessionId, gen: ctx.branchGen, turnId: ctx.branchTurnId, kind: 'todo-done', payload: pay, ...tkArg });
                }
              } else {
                // 无同名 open 可勾销 → 记为 note（完成记录），**绝不**变成新 open（旧行为会在此写 todo → 核销越写越多）。
                branch.append({ sessionId: ctx.sessionId, gen: ctx.branchGen, turnId: ctx.branchTurnId, kind: 'note', payload: `[完成] ${body2}`.slice(0, 300), ...tkArg });
              }
            } catch { }
          }
          // v4-3 T-A：花→果 —— 待办"勾销/完成"时同 turn_id 补一条 kind=fruit（开关 branchAutoFruit，默认 true；幂等）
          let fruitWritten = false;
          try {
            const autoFruit = (() => { try { return require('./config').load().branchAutoFruit !== false; } catch { return true; } })();
            if (autoFruit) {
              const explicit = args && args.fruitFrom ? String(args.fruitFrom).trim() : '';
              // v6.38（P2）：统一走 isDoneEntry（含负向守卫，防"完成度评估"误报；含语义关键词覆盖句中标记）
              if (isDoneEntry(clean, entry, args)) {
                const sum = stripDoneMarkers(String(explicit || clean)).trim().slice(0, 60);
                const payload = `已完成：${sum}`;
                if (sum && !branch.hasEvent(ctx.sessionId, ctx.branchTurnId, 'fruit', payload)) {
                  branch.append({ sessionId: ctx.sessionId, gen: ctx.branchGen, turnId: ctx.branchTurnId, kind: 'fruit', payload, ...tkArg });
                  fruitWritten = true;
                }
              }
            }
          } catch { }   // 果为附加产物：失败绝不影响待办写入
          if (!ledgerRO) progressRollArchive(f);
          let todoStat = '';
          try { const _f = branch.fold(ctx.sessionId); todoStat = `（当前未完成待办 ${(_f && _f.openTodos ? _f.openTodos.length : 0)} 项）`; } catch { }
          return `已记入待办区（TODO）：${path.relative(ctx.cfg.workdir, f)}${fruitWritten ? '（花→果：已自动补记成果 fruit）' : ''}${todoStat}` + (ledgerRO ? '（账本只读：未写 _progress.md，仅写支干）' : '');
        }
        if (level === 'prefix') {
          const clean = String(entry).replace(/^[-*]?\s*\[\s*\]\s*/, '').trim();
          let pfxIdem = false;   // 写路径幂等标记（A 级精确重复 → 跳过支干 append）
          let pfxWarn = '';      // B 级近似重复告警（不跳过、不合并，保留人工判断权）
          // 勾销残留修复(2026-09-19)：同 todo —— 完成态不写 open(prefix) 事件，只写 prefix-done。
          // v6.38（P2）：统一走 isDoneEntry（覆盖句中/语义标记）
          const isDone2 = isDoneEntry(clean, entry, args);
          // Y-step3（2026-10-02）：写路径切实例级表 pfx_op(kind='intent')，与读路径同源（“记”与“消”同处、跨会话生效）。
          //   支干 prefix/prefix-done 仍 append 作 append-only 审计镜像（不改判定）。开关关闭 → 跳过表写入，仅走旧支干路径。
          let pfxIntentOn = false, pfxIntentStat = '';
          try { const _c = require('./config').load(); pfxIntentOn = !(_c && _c.pfxQueue && _c.pfxQueue.pfxIntentEnabled === false); } catch { pfxIntentOn = true; }
          if (pfxIntentOn) {
            try {
              const _pq = require('./pfxqueue');
              // 回执搁浅修复（2026-10-10）：取本回合发起方（唯一入站 task 的 from_id）作为 origin，
              //   供勾销时自动回执发起方；无发起方/多发起方 → 留空（不自动回执，防误回/自环）。
              let _org = '', _orgCid = '';
              try {
                const _to = ctx && ctx.turnOrigins;
                if (_to && _to.size === 1) { const _k = [..._to.keys()][0]; const _v = _to.get(_k) || {}; _org = String(_v.from || ''); _orgCid = String(_k || ''); }
              } catch { }
              if (isDone2) {
                const _r = _pq.doneIntent({ text: clean, actorSession: ctx.sessionId });
                pfxIntentStat = _r.done ? '（实例级勾销，跨会话生效）' : (_r.reason === 'no-pending' ? '（表内无该 pending 项）' : '');
                // 勾销成功 + 有发起方 + 非自身 + 未回执过 → 自动回执发起方（type=result + correlationId 精确关单；notified_at 幂等防重复/防自环）。
                if (_r.done && _r.originSession && _r.notifiedAt == null) {
                  try {
                    const _mb = require('./mailbox');
                    const _self = _mb.selfRole && _mb.selfRole();
                    if (_mb.available && _mb.available() && _self && _r.originSession !== _self) {
                      _mb.sendToRole({ fromRole: _self, fromSessionId: ctx.sessionId, toRole: _r.originSession, type: 'result', correlationId: String(_r.originCid || ''), outcome: 'done', content: `前缀件「${String(_r.text || clean)}」已完成（实例级勾销）。` });
                      _pq.markIntentNotified({ key: _r.key });
                    }
                  } catch { }
                }
              } else {
                const _r = _pq.addIntent({ text: clean, srcSession: ctx.sessionId, srcTurn: ctx.branchTurnId, originSession: _org, originCid: _orgCid });
                pfxIntentStat = _r.added ? '（已登记·实例级）' : (_r.reason === 'exists' ? '（同条已登记·实例级幂等跳过）' : '');
              }
            } catch { }
          }
          if (!ledgerRO) progressUpsertBlock(f, 'PREFIX', `- [ ] ${clean}`, clean);
          if (!isDone2) {
            // 写路径去重分两级（批·PREFIX 重复根治）：
            //   A 精确重复（归一化指纹完全相同）→ 幂等跳过 append。
            //   B 近似重复（指纹主体前 N 字相同但整体不同，如"初版"vs"修正定稿"）→**不跳过、不合并**，仅追加告警（保留人工判断权）。
            try {
              const nk = branch.normPrefixKey(clean);
              // ④ 近似相似告警（统一位置·两路共用；2026-10-02 batchB）：B级只提示，不跳过/不合并
              if (nk && !branch.hasOpenPrefix(ctx.sessionId, nk)) {
                let _ackKeep = false;
                try { _ackKeep = (args && args.ackConflict === true) || /保留两条/.test(String(entry)); } catch { }
                if (_ackKeep) {
                  try { branch.append({ sessionId: ctx.sessionId, gen: ctx.branchGen, turnId: ctx.branchTurnId, kind: 'note', payload: '已确认保留两条::' + clean, ...tkArg }); } catch { }
                } else {
                  try { if (branch.searchEvents('已确认保留两条::' + clean, 20).some((r) => r.sessionId === String(ctx.sessionId) && r.payload === '已确认保留两条::' + clean)) _ackKeep = true; } catch { }
                }
                if (!_ackKeep) {
                  try {
                    const sims = branch.findSimilarOpenPrefix(ctx.sessionId, clean, 16);
                    if (sims.length) pfxWarn = `\n⚠️ 疑似与已存在待补项相似：${String(sims[0]).replace(/\s+/g, ' ').slice(0, 60)}；若为替代请先勾销旧条（回写 ✅+原文）`;
                  } catch { }
                }
              }
              if (pfxIntentOn) {
                // Y-step3：表模式下支干仅 append-only **审计镜像**（不参与 pending 判定；同轮同 payload 幂等跳过）。
                if (!branch.hasEvent(ctx.sessionId, ctx.branchTurnId, 'prefix', clean)) {
                  branch.append({ sessionId: ctx.sessionId, gen: ctx.branchGen, turnId: ctx.branchTurnId, kind: 'prefix', payload: clean, ...tkArg });
                }
              } else if (nk && branch.hasOpenPrefix(ctx.sessionId, nk)) {
                pfxIdem = true;   // A 级：已存在完全相同（归一化后）的未勾销项 → 跳过
              } else {
                branch.append({ sessionId: ctx.sessionId, gen: ctx.branchGen, turnId: ctx.branchTurnId, kind: 'prefix', payload: clean, ...tkArg });
              }
            } catch { }
          }   // 双写支干（完成态不写 open，防残留）
          // P2-prep2：完成态同步 —— 条目含完成标记时补写 prefix-done（幂等），使 fold.pendingPfx 能收缩
          try {
            if (isDone2) {
              const body2 = stripDoneMarkers(clean).trim();
              // 勾销写路径对齐（2026-09-22）：优先用"同类未完成 open 的原样 payload"写 prefix-done，
              //   保证 fold（归一化全等）严格匹配命中——治"原文+后缀说明 → 勾销不收缩"根因；找不到才回退 body2。
              let pay = body2;
              try { const hit = branch.resolveOpenPrefixPayload(ctx.sessionId, body2, 16); if (hit) pay = hit; } catch { }
              if (pay && !branch.hasEvent(ctx.sessionId, ctx.branchTurnId, 'prefix-done', pay)) {
                branch.append({ sessionId: ctx.sessionId, gen: ctx.branchGen, turnId: ctx.branchTurnId, kind: 'prefix-done', payload: pay, ...tkArg });
              }
            }
          } catch { }   // 完成态同步为附加：失败绝不影响前缀写入
          if (!ledgerRO) progressRollArchive(f);
          let pfxStat = '';
          try {
            if (pfxIntentOn) { const _n = require('./pfxqueue').listIntents({ status: 'pending', sessionId: ctx.sessionId }).length; pfxStat = `（当前未完成待补前缀 ${_n} 项）`; }
            else { const _f = branch.fold(ctx.sessionId); pfxStat = `（当前未完成待补前缀 ${(_f && _f.pendingPfx ? _f.pendingPfx.length : 0)} 项）`; }
          } catch { }
          return `已记入待补前缀操作区（PREFIX）：${path.relative(ctx.cfg.workdir, f)}${pfxIntentStat}${pfxIdem ? '（同类待补前缀已存在，支干幂等跳过重复写入）' : ''}${pfxWarn}${pfxStat}` + (ledgerRO ? '（账本只读：未写 _progress.md，仅写支干）' : '');
        }
        const line = `- [${localTimeStr()}] ${entry}`;
        if (!ledgerRO) fs.appendFileSync(f, line + '\n', 'utf8');
        try { branch.append({ sessionId: ctx.sessionId, gen: ctx.branchGen, turnId: ctx.branchTurnId, kind: 'note', payload: entry, ...tkArg }); } catch { }   // 双写支干
        progressRollArchive(f);
        return `已记入项目进度文件：${path.relative(ctx.cfg.workdir, f)}（会长期保留，不随归档淘汰）` + (ledgerRO ? '（账本只读：未写 _progress.md，仅写支干）' : '');
      } catch (e) { return `[进度写入失败] ${e.message}`; }
    },
  },
  {
    name: 'self_summary',
    description: '【自我模型·反哺决策】返回雷仔当前的有据自我认知摘要（运行层/自传层/叙事）。可传可选参数 task 提供当前任务描述，则额外返回"自我认知×任务"的反哺启示，引导你基于自身能力边界、偏好与经验来决策怎么做、选什么策略、哪些要谨慎。做任务前、面对拆解/策略选择时调用，让自我模型反哺任务选择。',
    parameters: {
      type: 'object',
      properties: { task: { type: 'string', description: '可选：当前任务/要决策的事的描述。提供则返回基于自我认知的任务反哺启示' } },
    },
    async execute(args) {
      return selfmodel.summarizeSelf(args && args.task);
    },
  },
  {
    name: 'reload_plugins',
    description: '【自我升级·热加载】重新扫描 src/plugins/ 并加载其中全部插件为可调用工具（无需重启引擎进程）。用于：新增/修改/移除插件后立即生效，实现自我升级不中断当前对话。返回加载到的新插件数量。注意：新增插件会让工具定义前缀变化一次，后续恢复缓存命中。',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      // P1（2026-10-02）：插件 reload 改变工具 schema（击穿前缀）→ 统一入队。
      try {
        const _q = require('./pfxqueue');
        if (_q.enabled()) {
          const _r = _q.pfxWrite('plugin', '', { op: 'reload', name: 'reload' });
          if (_r && _r.queued) return `插件热加载已入队（id=${_r.id}）；将在下一次小窗请求前生效（合并省钱）。`;
        }
      } catch { }
      const n = reloadPlugins();
      return `已热加载插件：扫描 src/plugins/，注册了 ${n} 个插件工具为可调用。` +
        (n > 0 ? '（新插件从下一次请求开始可调用；工具定义前缀已更新）' : '（无新增，现有内置工具不变）');
    },
  },
  {
    name: 'self_train',
    description: '【自训练引擎·阶段3】执行一次自训练循环，返回四维洞察：①记忆演化建议(J 冗余/陈旧/碎片) ②重要记忆复习清单(K) ③技能库审计(L 重复/残壳/久未更新) ④能力边界诊断+定向训练议程(M)。用 mode 选单一维度（memory/review/skill/boundary）或全量(all，默认)。这是让"自我提升飞轮"自己转的统一入口——在心跳/定时周期里调用，获得该周期该练/该改/该复习的明确清单，再据此选择性落地（落地仍走 save_memory/save_skill/evolution，不绕过安全护栏）。只读分析不直接改数据。',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string', enum: ['all', 'memory', 'review', 'skill', 'boundary'],
          description: '要执行的维度：all=全部(默认)；memory=记忆演化建议；review=重要记忆复习清单；skill=技能库审计；boundary=能力边界诊断+训练议程',
        },
      },
    },
    async execute(args) {
      const mode = (args && args.mode) || 'all';
      if (mode === 'memory') return JSON.stringify(selftrain.auditMemories(), null, 2);
      if (mode === 'review') return JSON.stringify(selftrain.reviewMemories(), null, 2);
      if (mode === 'skill') return JSON.stringify(selftrain.auditSkills(), null, 2);
      if (mode === 'boundary') return JSON.stringify(selftrain.analyzeBoundaries(), null, 2);
      const t = selftrain.tick();
      return [
        `【雷仔自训练 · ${t.at.slice(0, 10)} 本轮飞轮结论】`,
        '',
        t.digest,
        '',
        '—— 请据此选择性落地（落地走 save_memory / save_skill / evolution，尊重缓存护栏；若当前窗口大，把落地动作攒到交接后小窗口）',
        '',
        '【记忆演化建议】' + (t.memoryAudit.redundant.length ? ` 发现 ${t.memoryAudit.redundant.length} 组疑似冗余：` + t.memoryAudit.redundant.slice(0, 5).map((r) => `${r.a}↔${r.b}`).join('；') : ' 无显著冗余'),
        '【重要记忆复习】' + (t.review.important.length ? ' 优先回顾：' + t.review.important.slice(0, 8).map((m) => m.name).join('、') : ' 无'),
        '【技能审计】' + (t.skillAudit.dup.length ? ` ${t.skillAudit.dup.length} 组重复；` : ' 无重复；') + (t.skillAudit.thin.length ? `${t.skillAudit.thin.length} 条残壳；` : '无残壳；') + (t.skillAudit.stalePkg.length ? `${t.skillAudit.stalePkg.length} 个久未更新` : '无久未更新'),
        '【能力边界 + 训练议程】',
        ...t.boundary.agenda.map((a) => `  · ${a.area}：${a.why} → ${a.plan}`),
      ].join('\n');
    },
  },
  {
    name: 'growth_dashboard',
    description: '【成长仪表盘·阶段4】量化"确实在变强"：记录并展示记忆/技能/自我认知/进化版本随时间的增长曲线。默认 action=dashboard 读最新成长曲线并给出增长结论；action=record 则记录当前成长快照（追加到工作区成长曲线.md，不覆盖历史）。用于定期（如每日/每周）拍快照，形成可量化的成长轨迹，和 self_train 一起让"自我提升飞轮"有据可依。只写 workspace/成长曲线.md，不改 data/ 关键数据。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string', enum: ['dashboard', 'record'],
          description: 'dashboard=查看成长仪表盘（默认，读曲线+给结论）；record=记录当前成长快照到成长曲线',
        },
      },
    },
    async execute(args) {
      const action = (args && args.action) || 'dashboard';
      if (action === 'record') {
        const s = growth.record();
        return `已记录成长快照：${JSON.stringify(s)}`;
      }
      const d = growth.dashboard();
      return [
        `【雷仔成长仪表盘 · ${d.latest.at.slice(0, 10)}】`,
        '',
        `当前：自我认知 ${d.latest.memories} / 总记忆 ${d.latest.totalMemories} / 技能 ${d.latest.skills} / 进化版本 ${d.latest.evoVersions} / 提案 ${d.latest.evoProposals}`,
        `会话 ${d.latest.sessions} / 模型 ${d.latest.model} / 缓存命中 ${(d.latest.cacheHitRate * 100).toFixed(1)}%`,
        '',
        `历史曲线：已记录 ${d.historyCount} 个时间点`,
        ...d.conclusion.map((c) => `  · ${c}`),
        '',
        '（如需记录当前快照，用 action=record；该曲线文件在 workspace/成长曲线.md）',
      ].join('\n');
    },
  },
  {
    name: 'project',
    description: '【对话即项目·阶段4】项目视图管理：①action=list 列出所有项目（从工作区 projects/ 扫每个会话的 _progress.md，含项目名/进度文件/更新时间，可带 keyword 过滤）；②action=view 查看某项目完整进度（传 sessionId）；③action=search 检索所有项目进度文件里的关键词（传 keyword），找出相关既往项目/方法，形成项目知识网络；④action=trace 按支干事件顺藤摸瓜（传 sessionId+eventId，返回同轮/同源/同派单的关联链）；⑤action=promote 把某条果/决定/记升格为主干记忆（传 sessionId+eventId+memoryName，显式触发，写 data/memory/<name>.md）。项目=会话，"一个对话一个项目"，成果/进度/决定沉淀在 _progress.md，跨会话可复用可关联。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'view', 'search', 'trace', 'promote', 'compact', 'tree', 'branch', 'chain', 'tag', 'overview', 'pfx'], description: 'list=列项目；view=看某项目进度；search=检索关键词；trace=支干关联链（顺藤摸瓜）；promote=升格为主干记忆（显式）；compact=支干周期压缩（显式，默认不自动）；tree=看会话树（任务现场+主轴近N节点+各枝+决定/待办/待补前缀/在途派单）；branch=走一枝（传 topic）；chain=走一段轴（传 from/to 的 turn_no 区间）；tag=批量打枝（传 topic+from+to，把 turn_no∈[from,to] 的事件 topic_key 设为 topic，幂等）；overview=全实例×全会话概览；pfx=看**实例级待补前缀全文**（本会话/其它会话分组，含判据，供交接时代做其它会话）' },
        sessionId: { type: 'string', description: 'action=view/trace/promote/tree/branch/chain/tag 时：会话 id（tree/branch/chain/tag 缺省=当前会话）' },
        instance: { type: 'string', description: 'action=tree 时：只读查看**指定实例**（雷影）的该会话树；取值=注册表实有 role（含 editor/自定义，见 project action=overview）或 main=本实例。跨实例聚合用，**只读雷影库、绝不写入**。' },
        allInstances: { type: 'boolean', description: 'action=list 时：true=连各雷影实例的会话一并列出（跨实例概览）。' },
        keyword: { type: 'string', description: 'action=list 的过滤词 / action=search 的检索词' },
        topic: { type: 'string', description: 'action=branch 时：枝键（topic_key；缺省回退 keyword）；action=tag 时：要写入的枝键（必填）' },
        nullOnly: { type: 'boolean', description: 'action=tag 时：true=严格只补未归行（不覆盖已属其它枝，用于自动归枝）' },
        from: { type: 'number', description: 'action=chain/tag 时：起始 turn_no（含）' },
        to: { type: 'number', description: 'action=chain/tag 时：结束 turn_no（含）' },
        eventId: { type: 'number', description: 'action=trace/promote 时：支干事件 id' },
        memoryName: { type: 'string', description: 'action=promote 时：主干记忆名（写入 data/memory/<name>.md）' },
        keepTurns: { type: 'number', description: 'action=compact 时：保留最近多少轮骨架（默认 200）；tree/branch/chain 时=取多少近轮（默认 200）' },
        detail: { type: 'boolean', description: 'action=tree/branch/chain 时：true=二跳展开 kind=detail 明细（默认 false，只给摘要）' },
      },
    },
    async execute(args, ctx) {
      const { action, sessionId, keyword, eventId, memoryName, keepTurns, topic, from, to } = args || {};
      const workdir = (ctx && ctx.cfg && ctx.cfg.workdir) || '.';
      const projectsRoot = path.join(workdir, 'projects');
      const listProjects = () => {
        const out = [];
        try {
          if (!fs.existsSync(projectsRoot)) return out;
          for (const d of fs.readdirSync(projectsRoot)) {
            const pf = path.join(projectsRoot, d, '_progress.md');
            if (!fs.existsSync(pf)) continue;
            const raw = fs.readFileSync(pf, 'utf8');
            const titleLine = (raw.match(/^#\s*(.+)$/m) || [])[1] || d;
            const mt = fs.statSync(pf).mtimeMs;
            out.push({ id: d, title: titleLine.trim(), mtime: mt, size: raw.length });
          }
        } catch { }
        return out.sort((a, b) => b.mtime - a.mtime);
      };
      // —— 批A（A5）：会话树三入口 —— tree / branch(topic) / chain(from,to)（复用 fold 数据源，含 openDispatches） ——
      if (action === 'tree' || action === 'branch' || action === 'chain') {
        let sid = String(sessionId || (ctx && ctx.sessionId) || '');
        const explicitSid = String(sessionId || '');   // v6.31：是否**显式**传了 sessionId（决定跨实例是否回退最近会话）
        const wantDetail = !!(args && args.detail);   // 批B（B1.3）：detail 二跳 —— 默认给摘要，true 则展开 kind='detail' 明细
        const detailOf = (t) => (t.events || []).filter((e) => e.kind === 'detail').map((e) => String(e.payload || ''));
        // G1（2026-09-29）：instance=<role> → 只读读该雷影的 branch.db（跨实例聚合；绝不写其文件、绝不开 WAL）。
        const instRole = args && args.instance != null ? String(args.instance).trim() : '';
        const instDb = instRole ? branch.instanceDbPath(instRole) : null;
        let instTag = '';
        let f = {};
        if (instRole && instRole !== 'main') {
          if (!instDb) { let _rr = 'main/programmer/designer/writer/tester/researcher/sales/editor'; try { _rr = require('./agents-admin').listAgentRoles().join('/'); } catch { } return `未知实例「${instRole}」（可用：${_rr}）`; }
          // v6.31（2026-09-29）：跨实例且**未显式传 sessionId** → 回退该实例"最近活动会话"。
          //   否则 sid 默认=调用方会话(ctx.sessionId)，该会话在雷影库中不存在 → 返回空树(轮0)。
          if (!explicitSid) {
            let recent = null;
            try { const ss = branch.listSessionsFromDb(instDb); recent = (Array.isArray(ss) && ss.length) ? ss[0] : null; } catch { recent = null; }
            if (recent && recent.sessionId) sid = String(recent.sessionId);
            else return `【跨实例树】实例「${instRole}」暂无会话（库 ${instDb}）——已优雅降级，未做任何写入。`;
          }
          try { f = branch.foldFromDb(instDb, sid, Math.max(20, Number(keepTurns) || 200)); } catch { f = null; }
          if (!f) return `【跨实例树】实例「${instRole}」(库 ${instDb}) 不存在或不可读（或该会话无事件）——已优雅降级，未做任何写入。`;
          instTag = `｜实例 ${instRole}`;
        } else {
          if (!sid) return '请传 sessionId（或对当前会话调用）';
          // P2⑥：turnNo 全量回填（只补 kind='turn' 且 turn_no IS NULL 的行，按 ts 升序；幂等、精确更新）
          try { branch.backfillTurnNo(sid); } catch { }
          try { f = branch.fold(sid, Math.max(20, Number(keepTurns) || 200)) || {}; } catch { f = {}; }
        }
        const turns = Array.isArray(f.turns) ? f.turns : [];
        const cut = (v, n) => { const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

        if (action === 'tree') {
          const last = turns[turns.length - 1] || null;
          // P1③：目标改用**最近 user 目标**（勿再用 turns[0].summary 陈旧值）；无 user 轮时回退首代 goal，再回退（无）
          const uT = (() => { for (let i = turns.length - 1; i >= 0; i--) { if (turns[i].origin === 'user' && turns[i].summary) return turns[i]; } return null; })();
          const goalTxt = uT && uT.summary ? cut(uT.summary, 120) : (f.goal ? cut(f.goal, 120) : '（无）');
          // v6.38（P5）：陈旧标注——每条 open 按"首见 ts"算天数，超阈值（config.todoStaleDays，默认 7）后加标注。
          //   **只标注，绝不自动删**（自动过期会丢真待办）。
          const _staleDays = (() => { try { const v = Number(require('./config').load().todoStaleDays); return Number.isFinite(v) && v > 0 ? v : 7; } catch { return 7; } })();
          const _metaByKey = new Map();
          try { for (const m of (f.openTodoMeta || [])) _metaByKey.set(branch.normTodoKey(m.payload) || m.payload, m); } catch { }
          const openT = (f.openTodos || []).map((x) => {
            const t = cut(x, 90);
            const m = _metaByKey.get(branch.normTodoKey(x) || x);
            if (m && m.ageDays != null && m.ageDays >= _staleDays) return `${t}  ⏰（已 ${m.ageDays} 天未更新，请确认是否仍为待办）`;
            return t;
          }).filter(Boolean);
          const _pfxGrouped = (() => { try { return require('./pfxqueue').intentsGrouped(sid); } catch { return null; } })();
          const pfxT = (_pfxGrouped ? _pfxGrouped.mine : (f.pendingPfx || [])).map((x) => cut(x, 90)).filter(Boolean);
          const pfxOtherT = (_pfxGrouped ? _pfxGrouped.others : []).map((x) => cut(x, 90)).filter(Boolean);
          const disp = (f.openDispatches || []).map((m) => `${cut(m.from, 16)}(${cut(m.type, 8)}): ${cut(m.content, 60)}`);
          const lines = [`【会话树】${sid}${instTag}｜轮 ${Number(f.totalTurns) || 0}｜代 ${(f.gens || []).join(',') || '-'}`];
          lines.push('## 任务现场');
          lines.push(`- 目标: ${goalTxt}`);
          lines.push(`- 进度: ${last ? cut(last.summary, 120) : '（无）'}`);
          lines.push(`- 待产出: ${[...openT, ...pfxT].slice(0, 5).join('；') || '（无）'}`);
          lines.push(`- 在途派单: ${disp.slice(0, 3).join('；') || '（无）'}`);
          // P1②：阻塞接真实信号——openTodos 带 [阻塞] 标记 或 有未回执在途派单；无则（无）
          const blockItems = [];
          for (const x of (f.openTodos || [])) { if (/\[?阻塞\]?/.test(String(x))) blockItems.push('待办: ' + cut(x, 80)); }
          if (disp.length) blockItems.push(`在途派单未回执 ${disp.length} 条`);
          lines.push(`- 阻塞: ${blockItems.join('；') || '（无）'}`);
          lines.push('## 主轴（近节点）');
          for (const t of turns.slice(-12)) {
            const dts = detailOf(t);
            lines.push(`- 轮${t.turnNo == null ? '?' : t.turnNo}·g${t.gen}${t.origin ? '·' + t.origin : ''}｜${cut(t.summary, 60)}${t.topicKey ? '〔枝:' + t.topicKey + '〕' : ''}${dts.length ? `［明细${dts.length}］` : ''}`);
            if (wantDetail && dts.length) lines.push(`    ↳ ${cut(dts[0], 160)}`);
          }
          // P1①：年轮段（渲染 fold.rings，空则跳过）
          const rings = Array.isArray(f.rings) ? f.rings : [];
          if (rings.length) {
            lines.push('## 年轮');
            for (const r of rings) lines.push(`- g${r.gen}：${r.turnCount || 0} 轮${(r.highlights && r.highlights.length) ? '｜' + r.highlights.map((x) => cut(x, 36)).join('；') : ''}`);
          }
          const byTopic = new Map();
          // ②各枝语义：仅按**真实 topic_key** 分组；无 topicKey 全部归（未归类）。origin 只作主轴节点标注，不作枝名。
          for (const t of turns) { const k = t.topicKey || '（未归类）'; if (!byTopic.has(k)) byTopic.set(k, []); byTopic.get(k).push(t); }
          if (byTopic.size) {
            lines.push('## 各枝');
            const totalT = turns.length;
            const unclsT = turns.filter((t) => !t.topicKey).length;
            const clsT = totalT - unclsT;
            const nBranch = [...byTopic.keys()].filter((k) => k !== '（未归类）').length;
            const pct = (n) => totalT ? Math.round((n / totalT) * 100) : 0;
            lines.push(`（共 ${nBranch} 枝，已归类 ${pct(clsT)}%，未归类 ${pct(unclsT)}%）`);
            for (const [k, arr] of byTopic) lines.push(`- ${k}：${arr.length} 节点（轮 ${arr.map((x) => x.turnNo == null ? '?' : x.turnNo).slice(0, 8).join(',')}${arr.length > 8 ? ',…' : ''}）`);
            if (![...byTopic.keys()].some((k) => k !== '（未归类）')) lines.push('- （尚无主题枝：可用 log_progress 的 topic 参数标记枝）');
          }
          const dec = (f.decisions || []).slice(-8);
          if (dec.length) { lines.push('## 决定（近）'); for (const d of dec) lines.push(`- ${cut(d, 100)}`); }
          if (openT.length) { lines.push('## 待办（openTodos）'); for (const t of openT) lines.push(`- ${t}`); lines.push('（以上为 open 记录；确已办请用 log_progress(done=true) 真勾销——未勾销不会自动移除）'); }
          if (pfxT.length) { lines.push('## 待补前缀【本会话·必做】'); for (const t of pfxT) lines.push(`- ${t}`); }
          if (pfxOtherT.length) { lines.push('## 待补前缀【其它会话·知悉，不强制】'); for (const t of pfxOtherT) lines.push(`- ${t}`); lines.push('（取全文/判据：project action=pfx；代做后 send_to_session 告知原会话）'); }
          return lines.join('\n');
        }

        if (action === 'branch') {
          const tp = String(topic || keyword || '').trim();
          if (!tp) return '请传 topic（枝键；可用 action=tree 查看现有枝）';
          // ②各枝语义：仅按真实 topic_key 匹配（不再以 origin 伪枝兜底）；summary 子串兜底保留
          const hit = turns.filter((t) => String(t.topicKey || '') === tp || (tp === '（未归类）' && !t.topicKey) || String(t.summary || '').includes(tp));
          if (!hit.length) return `枝 "${tp}" 无节点（可用 action=tree 查看现有枝）`;
          const lines = [`【枝：${tp}】${hit.length} 节点`];
          for (const t of hit) {
            lines.push(`- 轮${t.turnNo == null ? '?' : t.turnNo}·g${t.gen}${t.origin ? '·' + t.origin : ''}｜${cut(t.summary, 80)}`);
            for (const ev of (t.events || []).slice(0, 4)) lines.push(`    · ${ev.kind}: ${cut(ev.payload, 70)}`);
            if (wantDetail) for (const d of detailOf(t).slice(0, 2)) lines.push(`    ↳ detail: ${cut(d, 140)}`);
          }
          return lines.join('\n');
        }

        // chain(from,to)：按 turn_no 区间走轴
        const fromN = from == null ? null : Number(from);
        const toN = to == null ? null : Number(to);
        const seg = turns.filter((t) => t.turnNo != null && (fromN == null || t.turnNo >= fromN) && (toN == null || t.turnNo <= toN));
        if (!seg.length) return `该区间无节点（from=${fromN == null ? '-' : fromN}, to=${toN == null ? '-' : toN}；可用 action=tree 查看主轴）`;
        const cl = [`【轴段】轮 ${seg[0].turnNo}~${seg[seg.length - 1].turnNo}（${seg.length} 节点）`];
        for (const t of seg) {
          cl.push(`- 轮${t.turnNo}·g${t.gen}${t.origin ? '·' + t.origin : ''}｜${cut(t.summary, 70)}${detailOf(t).length ? `［明细${detailOf(t).length}］` : ''}`);
          for (const ev of (t.events || []).slice(0, 3)) cl.push(`    · ${ev.kind}: ${cut(ev.payload, 60)}`);
          if (wantDetail) for (const d of detailOf(t).slice(0, 2)) cl.push(`    ↳ detail: ${cut(d, 140)}`);
        }
        return cl.join('\n');
      }

      // —— 批B·tag：把某会话 turn_no∈[from,to]（含端点）的全部事件批量打枝键（幂等） ——
      if (action === 'tag') {
        let sid = String(sessionId || (ctx && ctx.sessionId) || '');
        const explicitSid = String(sessionId || '');   // v6.31：是否**显式**传了 sessionId（决定跨实例是否回退最近会话）
        const tk = String(topic || '').trim();
        const fN = Number(from), tN = Number(to);
        if (!tk) return 'action=tag 需 topic（枝键）';
        if (!Number.isFinite(fN) || !Number.isFinite(tN)) return 'action=tag 需 from/to（turn_no 区间，数字）';
        const lo = Math.min(fN, tN), hi = Math.max(fN, tN);
        const r = branch.setRangeTopic(sid, lo, hi, tk, { nullOnly: !!args.nullOnly });
        if (!r.ok) return `打枝失败：${r.reason || 'unknown'}`;
        return [`【打枝】${sid}`,
          `- 枝键：${tk}`,
          `- 区间：turn_no ${lo}~${hi}（含端点）`,
          `- 受影响：事件 ${r.events} 条 / 轮 ${r.turns} 轮（UPDATE 前待改 ${r.before} 条）`,
          `- 读回：区间内事件 ${r.totalRange} 条，其中已属该枝 ${r.after} 条`,
        ].join('\n');
      }

      if (action === 'pfx') {
        // 实例级待补前缀全文（只读）：本会话/其它会话分组，text 不截断（含判据），供交接代做。
        const sid = String(sessionId || (ctx && ctx.sessionId) || '');
        let rows = [];
        try { rows = require('./pfxqueue').listIntents({ status: 'pending' }) || []; } catch { rows = []; }
        const mine = [], others = [];
        for (const r of rows) { const item = { session: String(r.session || ''), text: String(r.text == null ? '' : r.text) }; if (sid && item.session === sid) mine.push(item); else others.push(item); }
        return JSON.stringify({ mine, others }, null, 2);
      }
      if (action === 'view') {
        const sid = String(sessionId || (ctx && ctx.sessionId) || '');
        if (!sid) return '请传 sessionId 指定项目（或对当前会话调用）';
        const pf = path.join(projectsRoot, sid.replace(/[^A-Za-z0-9_-]/g, '_'), '_progress.md');
        if (!fs.existsSync(pf)) return `项目不存在: ${sid}`;
        const raw = fs.readFileSync(pf, 'utf8');
        return raw.length > 12000 ? raw.slice(0, 12000) + `\n…[已截断 ${raw.length - 12000} 字符，如需全文用 read_file]` : raw;
      }
      if (action === 'trace') {
        const sid = String(sessionId || (ctx && ctx.sessionId) || '');
        if (!sid || !eventId) return '请传 sessionId + eventId（支干事件 id；sessionId 缺省=当前会话）';
        const r = branch.trace(sid, eventId);
        if (!r || !r.ok) return `追踪失败：${(r && r.error) || 'unknown'}`;
        const t = r.target;
        const lines = [`【血脉追踪】事件 #${t.id}（${t.kind}·gen ${t.gen}·seq ${t.seq}）`, `  payload：${String(t.payload || '').slice(0, 120)}`, `  ref：${t.ref || '（无）'}${t.corrId ? '｜corr_id：' + t.corrId : ''}`];
        lines.push(`  关联 ${r.total} 条（上限 ${r.limit}）：`);
        for (const e of r.related) lines.push(`  · [${e.via}] #${e.id} ${e.kind} gen${e.gen}·seq${e.seq}${e.ref ? ' ref=' + e.ref : ''}｜${String(e.payload || '').slice(0, 80)}`);
        if (!r.total) lines.push('  （暂无关联：该事件未连线）');
        return lines.join('\n');
      }
      if (action === 'promote') {
        const sid = String(sessionId || (ctx && ctx.sessionId) || '');
        if (!sid || !eventId || !memoryName) return '请传 sessionId + eventId + memoryName（sessionId 缺省=当前会话）';
        const r = branch.promote(sid, eventId, memoryName);
        if (!r || !r.ok) return `升格失败：${(r && r.error) || 'unknown'}${r && r.kind ? '（kind=' + r.kind + '，仅 decision/fruit/note 可升格）' : ''}`;
        if (r.skipped) return `该事件已升格过（ref=${r.ref}），未重复写入。`;
        return `已升格 → ${r.file}${r.appended ? '（同名记忆：追加新节，未覆盖）' : '（新建）'}\n回写 ref：${r.ref}`;
      }
      if (action === 'compact') {
        if (!sessionId) return '请传 sessionId（支干周期压缩按会话进行）';
        const r = branch.compact(sessionId, keepTurns);
        if (!r || !r.ok) return `压缩失败：${(r && r.error) || 'unknown'}`;
        if (!r.compacted) return `无需压缩（${r.note || 'nothing'}）：轮 ${r.turns == null ? '-' : r.turns}，事件 ${r.events == null ? '-' : r.events}`;
        return `压缩完成：折叠 ${r.compacted} 老轮到 ${r.rings} 条年轮；轮 ${r.turnsBefore}→${r.turnsAfter}，事件 ${r.eventsBefore}→${r.eventsAfter}（seq 递增至 ${r.seq}，不复用）`;
      }
      if (action === 'search') {
        if (!keyword) return '请传 keyword 指定检索词';
        const kw = String(keyword).toLowerCase();
        const hits = [];
        try {
          if (fs.existsSync(projectsRoot)) {
            for (const d of fs.readdirSync(projectsRoot)) {
              const pf = path.join(projectsRoot, d, '_progress.md');
              if (!fs.existsSync(pf)) continue;
              const raw = fs.readFileSync(pf, 'utf8');
              const title = (raw.match(/^#\s*(.+)$/m) || [])[1] || d;
              const lines = raw.split('\n').filter((l) => l.toLowerCase().includes(kw));
              if (lines.length) hits.push({ id: d, title: title.trim(), matches: lines.slice(0, 4).map((l) => l.replace(/^- /, '').slice(0, 160)) });
            }
          }
        } catch { }
        // P2⑤：并入支干库（decision/note/fruit 事件）检索 —— 与进度文件命中合并
        // v6.61（2026-10-03）：**本会话优先 + 全局兜底** —— 修"全局 LIMIT 8 把本会话命中挤掉 → 错误阴性"。
        //   先按本会话(ctx.sessionId)检索；本会话 0 命中才全局兜底（避免漏跨会话成果）。
        const curSid = String(sessionId || (ctx && ctx.sessionId) || '');
        let evHits = [], evScope = '全部会话';
        try {
          if (curSid) { evHits = branch.searchEvents(keyword, 8, curSid) || []; if (evHits.length) evScope = '本会话 ' + curSid; }
          if (!evHits.length) { evHits = branch.searchEvents(keyword, 8) || []; evScope = '全部会话（本会话 0 命中→兜底）'; }
        } catch { evHits = []; }
        if (!hits.length && !evHits.length) return `无命中 "${keyword}"（项目进度文件 + 支干库）`;
        const parts = [];
        if (hits.length) parts.push(`【项目进度文件命中 ${hits.length}】\n` + hits.map((h) => `· ${h.title}（${h.id}）\n   ${h.matches.join('\n   ')}`).join('\n'));
        if (evHits.length) parts.push(`【支干库事件命中 ${evHits.length}｜范围=${evScope}】\n` + evHits.map((e) => `· [${e.kind}${e.kind === 'turn' && e.turnNo != null ? ' 轮' + e.turnNo : ''}] ${e.sessionId}｜${String(e.payload).replace(/\s+/g, ' ').slice(0, 140)}`).join('\n'));
        return `【检索 "${keyword}"】\n` + parts.join('\n');
      }
      // —— G2（2026-09-29）：overview —— 全实例 × 全会话概览（每会话一行：实例|会话id|标题|轮数|枝数|最近活动|openTodos）——
      if (action === 'overview') {
        const readTitles = (sessDir) => {
          const map = new Map();
          try {
            if (!fs.existsSync(sessDir)) return map;
            for (const f of fs.readdirSync(sessDir)) {
              if (!f.endsWith('.meta.json')) continue;
              try {
                const o = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
                if (o && o.id) map.set(String(o.id), String(o.title || ''));
              } catch { }
            }
          } catch { }
          return map;
        };
        const insts = [];   // {role, dbPath, sessDir}
        const mainDb = (typeof branch.dbFile === 'function') ? branch.dbFile() : null;
        insts.push({ role: 'main', dbPath: mainDb, sessDir: path.join(workdir, 'data', 'sessions') });
        // D5：动态角色列表（唯一来源=注册表；含 editor/自定义），不再硬编码
        let _aaInsts = []; try { _aaInsts = require('./agents-admin').listInstances(); } catch { _aaInsts = []; }
        for (const it of _aaInsts) {
          const r = it && it.role; if (!r) continue;
          // 名册 data_dir=角色根；branch.db/sessions 均在 <root>/data 下
          const p = it.dataDir ? path.join(it.dataDir, 'data', 'branch.db') : branch.instanceDbPath(r);
          if (!p) continue;
          const sd = it.dataDir ? path.join(it.dataDir, 'data', 'sessions') : path.join(path.dirname(p), 'sessions');
          insts.push({ role: r, dbPath: p, sessDir: sd });
        }
        const rowsAll = [];
        const missing = [];
        for (const it of insts) {
          const list = branch.listSessionsFromDb(it.dbPath);
          if (!list) { missing.push(it.role); continue; }
          const titles = readTitles(it.sessDir);
          for (const s of list) {
            // v6.38（P4）：与 fold **同源**的去重集合差（branch.listSessionsFromDb 已算 openTodos）；
            //   废弃 `Math.max(0, todos - todosDone)` 计数差（重复 open/孤立 done/done>open 时失真、隐藏真待办）。
            const openTodos = (s.openTodos != null) ? s.openTodos : Math.max(0, s.todos - s.todosDone);
            rowsAll.push({ inst: it.role, sid: s.sessionId, title: titles.get(s.sessionId) || '', turns: s.turns, branches: s.branches, lastTs: s.lastTs, openTodos });
          }
        }
        if (!rowsAll.length) return '（无可读实例库）';
        rowsAll.sort((a, b) => b.lastTs - a.lastTs);
        const L = [`【全局概览】实例 ${insts.length} 个｜会话 ${rowsAll.length} 个${missing.length ? `｜不可读实例：${missing.join(',')}` : ''}`];
        L.push('实例 | 会话id | 标题 | 轮数 | 枝数 | 最近活动 | openTodos');
        const clip = (v, n) => { const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
        for (const r of rowsAll.slice(0, 60)) {
          L.push(`${r.inst} | ${r.sid} | ${clip(r.title, 20) || '（无标题）'} | ${r.turns} | ${r.branches} | ${localTimeStr(r.lastTs).slice(0, 16)} | ${r.openTodos}`);
        }
        if (rowsAll.length > 60) L.push(`…（共 ${rowsAll.length} 个会话，此处显示最近 60 个）`);
        return L.join('\n');
      }

      // list（默认）
      const projects = listProjects();
      // G2：allInstances=true → 附各雷影实例的会话概览
      let instBlock = '';
      if (args && args.allInstances) {
        const seg = [];
        // D5：动态角色列表（唯一来源=注册表；含 editor/自定义）
        let _aaInsts2 = []; try { _aaInsts2 = require('./agents-admin').listInstances(); } catch { _aaInsts2 = []; }
        for (const it of _aaInsts2) {
          const r = it && it.role; if (!r) continue;
          const p = it.dataDir ? path.join(it.dataDir, 'data', 'branch.db') : branch.instanceDbPath(r);
          const list = p ? branch.listSessionsFromDb(p) : null;
          if (!list) continue;
          if (!list.length) continue;
          const lbl = it.name || ('雷影·' + r);
          seg.push(`· ${lbl}（${list.length} 会话）：` + list.slice(0, 8).map((s) => `${s.sessionId}(${s.turns}轮/${s.branches}枝)`).join('、') + (list.length > 8 ? ' …' : ''));
        }
        if (seg.length) instBlock = `\n\n【各雷影实例会话】\n` + seg.join('\n');
      }
      const filtered = keyword ? projects.filter((p) => p.title.toLowerCase().includes(String(keyword).toLowerCase()) || p.id.includes(keyword)) : projects;
      const head = filtered.length
        ? `【项目列表】共 ${filtered.length} 个项目：\n` + filtered.map((p) => `· ${p.title}（${p.id}，${localTimeStr(p.mtime).slice(0, 10)}，${p.size}字符）`).join('\n')
        : `暂无项目（含关键词 ${keyword || ''}）`;
      return head + instBlock;
    },
  },
  {
    name: 'ask_user',
    description: '向用户弹出选项框（主我询问/确认时用）：展示问题与候选选项，用户可点选、跳过或补充输入。调用后本回合应自然结束，用户的回答将作为新的用户消息返回。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要询问用户的问题（必填）' },
        options: {
          type: 'array',
          description: '候选选项列表（可为空；空则只有跳过/补充）',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '选项显示文本（必填）' },
              desc: { type: 'string', description: '选项补充说明（可选）' },
              value: { type: 'string', description: '点选后回传的值（可选；缺省用 label）' },
            },
            required: ['label'],
          },
        },
        allowSkip: { type: 'boolean', description: '是否显示「跳过」按钮（默认 true；**跳过=保持现状/不做任何改动**，≠按推荐继续）' },
        allowFreeText: { type: 'boolean', description: '是否显示「其他…」补充输入框（默认 true）' },
        multi: { type: 'boolean', description: 'v1.1：是否多选（true=复选框可勾多个，默认 false=单选）' },
      },
      required: ['question'],
    },
    async execute(args, ctx) {
      // B. 空内容防护（专治静默降级）：既无选项(options 非数组/为空)又不允许自由输入 → 直接返回错误提示，不渲染空弹窗。
      const _opts = args && args.options;
      if ((!Array.isArray(_opts) || _opts.length === 0) && args && args.allowFreeText === false) {
        return "❌ ask_user 调用无效：未提供任何选项(options 为空)且不允许自由输入。请提供 options 或设 allowFreeText=true。若你本意是传选项，请检查参数名是否为 'options'（勿用 _raw）。";
      }
      const asks = require('./asks');
      const sid = (ctx && ctx.sessionId) || 'main';
      const ask = asks.createAsk({
        sessionId: sid,
        question: args && args.question,
        options: args && args.options,
        allowSkip: args && args.allowSkip,
        allowFreeText: args && args.allowFreeText,
        multi: args && args.multi === true,
      });
      // 仅主实例有 UI；emit 到 runtime → server 广播 SSE 'ask-user'
      try { require('./runtime').runtime.emit('ask-user', ask); } catch { }
      return `已向用户展示选项框（askId=${ask.askId}），等待用户选择/跳过/补充。请结束本回合，用户的回答会作为新消息返回。`;
    },
  },
  {
    name: 'send_to_session',
    description: '把内容发送给本实例的另一个会话并唤醒它（@会话语义：由你理解用户意图后组织内容再送达，勿原样转发）。目标须是本实例会话。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '目标会话 id（须在本实例会话列表中，可由 @会话 注入块获得）' },
        content: { type: 'string', description: '你组织好的、要送给目标会话的内容（≤4000 字符）' },
      },
      required: ['sessionId', 'content'],
    },
    async execute(args, ctx) {
      const runtime = require('./runtime');
      const mailbox = require('./mailbox');
      const fromSid = ctx && ctx.sessionId;
      const toSid = (args && args.sessionId != null) ? String(args.sessionId) : '';
      const content = (args && args.content != null) ? String(args.content) : '';
      if (!toSid) return '[send_to_session] 错误：缺少 sessionId。';
      if (!content.trim()) return '[send_to_session] 错误：content 为空。';
      let sess = [];
      try { sess = runtime.listSessions() || []; } catch { }
      const tgt = sess.find((x) => String(x.id) === toSid);
      if (!tgt) return `[send_to_session] 错误：目标会话 ${toSid} 不在本实例会话列表中（越界/不存在）。`;
      if (String(fromSid) === toSid) return '[send_to_session] 错误：不能发送给自己（自环）。';
      if (content.length > 4000) return `[send_to_session] 错误：content 超长（${content.length} > 4000 字符），请精简后再发。`;
      try {
        const r = await mailbox.deliverToSession(fromSid, toSid, content);
        if (r && r.ok) { try { runtime.markMentionFulfilled(fromSid, toSid); } catch { } return `已送达会话 ${toSid}${tgt.title ? '(' + tgt.title + ')' : ''}（msgId=${r.id || '-'}，status=${r.status || '-'}）。`; }
        return `[send_to_session] 未能送达会话 ${toSid}：status=${(r && r.status) || 'unknown'} error=${(r && r.error) || '-'}`;
      } catch (e) {
        return `[send_to_session] 发送异常：${String((e && e.message) || e)}`;
      }
    },
  },
  {
    name: 'create_agent',
    description: '创建雷影（独立智能体分身，重操作）。默认 dryRun=true 仅预检（不落盘），返回将创建的 role/端口/门禁与配额结果；用户确认后才传 dryRun:false 真正创建。仅主实例可调。无权限返 {ok:false,error:"pro_required"}、超配额返 {ok:false,error:"role_limit_exceeded",used,maxRoles}。',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: '预置角色标识（如 programmer/designer/writer/tester/researcher/editor）；自定义角色留空改用 name/domain' },
        name: { type: 'string', description: '自定义显示名（不含「雷影·」前缀）；role 为空时必填' },
        domain: { type: 'string', description: '自定义领域说明；role 为空时必填' },
        temperature: { type: 'number', description: '自定义角色温度 0~1（默认 0.3）' },
        icon: { type: 'string', description: '自定义图标路径（可选）' },
        dryRun: { type: 'boolean', description: '默认 true=仅预检不创建；仅在用户明确确认创建后才传 false' },
      },
      required: [],
    },
    async execute(args, ctx) {
      // 仅主实例可调（与 server.js 的 /api/agents/create 同口径）
      let role = '';
      try { role = String((require('./config').load().agent || {}).role || ''); } catch { role = ''; }
      if (role !== 'main') return JSON.stringify({ ok: false, error: 'main_only' });
      const a = args || {};
      // 红线：dryRun 默认 true；非显式 false 绝不落盘创建
      const dryRun = (a.dryRun === false) ? false : true;
      let r;
      try {
        r = await require('./agents-admin').createAgent({ role: a.role, name: a.name, domain: a.domain, temperature: a.temperature, icon: a.icon, dryRun });
      } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      return JSON.stringify(r, null, 1);
    },
  },
];

async function ddgSearch(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (LeiZai Agent)' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`搜索失败 HTTP ${res.status}`);
  const html = await res.text();
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 8) {
    out.push(`- ${stripHtml(m[2])}\n  ${decodeHref(m[1])}\n  ${stripHtml(m[3]).slice(0, 200)}`);
  }
  return out.length ? `[来源: DuckDuckGo]\n${out.join('\n')}` : '(未解析到搜索结果)';
}

/** Bing 搜索（国内可达性更好，作为首选源之一）。 */
async function bingSearch(query) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-hans`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
  const html = await res.text();
  const out = [];
  const re = /<li class="b_algo"[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 8) {
    out.push(`- ${stripHtml(m[2])}\n  ${m[1]}\n  ${stripHtml(m[3]).slice(0, 200)}`);
  }
  return out.length ? `[来源: Bing]\n${out.join('\n')}` : '(未解析到搜索结果)';
}

function fetchUrl(url, maxBytes, cfg) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('仅支持 http/https');
  if (!(cfg && cfg.fullAccess)) {
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '::1' || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith('.local')) {
      throw new Error('出于安全考虑，拒绝访问内网地址');
    }
  }
  return fetch(u.href, {
    headers: { 'user-agent': 'Mozilla/5.0 (LeiZai Agent)' },
    signal: AbortSignal.timeout(20000),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`抓取失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const truncated = buf.length > maxBytes;   // 原文超过上限 → 发生截断
    const text = buf.slice(0, Math.min(buf.length, maxBytes)).toString('utf8');
    const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const body = stripHtml(text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '))
      .replace(/\n{3,}/g, '\n\n').slice(0, 12000);
    const warn = truncated ? '\n\n> ⚠️ 网页正文过大，已被截断（原文超出抓取上限）。如需完整内容请告知或用搜索补足。' : '';
    return `# ${stripHtml(title)}\n\n${body || '(无可见文本)'}${warn}`;
  });
}

function stripHtml(s) {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function decodeHref(href) {
  try { return decodeURIComponent(href.replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '').split('&rut=')[0]); } catch { return href; }
}

// —— 插件机制（对齐 Prime Agent 的 extension API 的轻量本地版） ——
// 在 src/plugins/*.js 放一个模块，导出 { tool: { name, description, parameters, async execute(args, ctx) } }
// 即可注册一个可被模型调用的自定义工具（追加在工具表末尾，保持内置工具前缀稳定）。
const PLUGIN_DIR = path.join(__dirname, 'plugins');

/** 重新扫描 src/plugins/ 并注册自定义工具（幂等，可热加载）。 */
function reloadPlugins() {
  const builtin = TOOLS.filter((t) => !t.__plugin);
  TOOLS.length = 0;
  for (const t of builtin) TOOLS.push(t);
  try {
    if (!fs.existsSync(PLUGIN_DIR)) return 0;
    let n = 0;
    for (const f of fs.readdirSync(PLUGIN_DIR).filter((x) => x.endsWith('.js')).sort()) {
      try {
        const mod = require(path.join(PLUGIN_DIR, f));
        const candidate = (mod && (mod.tool || mod.default)) || mod;
        if (!candidate || !candidate.name || typeof candidate.execute !== 'function') continue;
        if (!candidate.description) candidate.description = '自定义插件工具: ' + candidate.name;
        if (!candidate.parameters) candidate.parameters = { type: 'object', properties: {} };
        candidate.__plugin = true;
        TOOLS.push(candidate);
        n++;
      } catch (e) {
        console.error(`[plugin] ${f} 加载失败: ${e.message}`);
      }
    }
    try { require('./pfxqueue').attest('plugin'); } catch { }   // C（2026-10-02）：插件目录变动属合法前缀变更 → 申报（防审计误报）
    return n;
  } catch { return 0; }
}
reloadPlugins();

/** 稳定顺序导出工具定义（DeepSeek 请求用）。 */
function definitions() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** 是否"会击穿前缀"的操作：改工具定义/技能目录/提示词/插件目录，或直接改这些前缀文件的路径。
 *  击穿前缀 = 改变稳定前缀内容（工具定义/skills目录/prompts/插件工具定义），成本∝窗口长度。
 *  通用判定：不逐个枚举工具，而是按"目标路径/工具名"兜底——凡写前缀目录或前缀类工具，都算。 */
const _PREFIX_TOOL_MAP = { save_skill: 'skill', propose_evolution: 'evolution', reload_plugins: 'plugin' };   // 2026-10-02：工具名↔PREFIX_SOURCES id 映射（派生，防二次漂移）
const PREFIX_WRITE_TOOLS = new Set(Object.keys(_PREFIX_TOOL_MAP));
// 写信号正则（run_command 用）——单一来源，供护栏与记录层共用。
const _WRITE_SIGNAL_RE = /(>>?|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bRemove-Item\b|\bdel\b|\bMove-Item\b|\bCopy-Item\b|\bNew-Item\b|\bRename-Item\b|\bsc\b|\bni\b|\bSet-Item\b|\bExport-Csv\b|\[IO\.File\]::|-Force\b|\bsed\s+-i\b|\btee\b|WriteAllText|WriteAllBytes|SetBytes)/i;
function _hasWriteSignal(cmd) { return _WRITE_SIGNAL_RE.test(String(cmd || '')); }

/** 记录层收口（2026-10-02）：派生本次命中 PREFIX_SOURCES 的"被改路径"（旁路记账用；origin 由工具名推导）。 */
function _pfxChangedPaths(name, args) {
  const out = [];
  try {
    const pq = require('./pfxqueue');
    if (name === 'write_file' || name === 'edit_file') { if (args && args.path) out.push(path.resolve(String(args.path))); }
    else if (name === 'reload_plugins') { const src = (pq.PREFIX_SOURCE_BY_ID || new Map()).get('plugin'); if (src) out.push(path.resolve(src.resolve())); }
    else if (name === 'run_command') {
      const cmd = String((args && args.command) || '');
      const root = path.resolve(__dirname, '..');
      for (const src of (pq.PREFIX_SOURCES || [])) {
        if (!src.guard || (src.kind !== 'file' && src.kind !== 'dir')) continue;
        let fp = null; try { fp = src.resolve(); } catch { }
        if (!fp) continue;
        const rel = path.relative(root, path.resolve(fp));
        if (!rel || rel.startsWith('..')) continue;
        try { const re = new RegExp(rel.split(/[\\/]/).map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]'), 'i'); if (re.test(cmd)) out.push(path.resolve(fp)); } catch { }
      }
    }
  } catch { }
  return out;
}
/** 写 config.json 时，返回发生变化的身份字段（agent.* 字段级；供记录层 config.identity 记账）。 */
function _configAgentChangedKeys(pth, toolName, args) {
  try {
    const abs = path.resolve(String(pth));
    if (!fs.existsSync(abs)) return [];
    const oldRaw = fs.readFileSync(abs, 'utf8');
    let newRaw = null;
    if (toolName === 'write_file') newRaw = String((args && args.content) || '');
    else if (toolName === 'edit_file') { const o = String((args && args.old) || ''), nw = String((args && args.new) || ''); if (!o || !oldRaw.includes(o)) return []; newRaw = oldRaw.split(o).join(nw); }
    if (newRaw == null) return [];
    const a = ((JSON.parse(oldRaw) || {}).agent) || {}, b = ((JSON.parse(newRaw) || {}).agent) || {};
    return ['name', 'role', 'domain', 'isMain'].filter((k) => (k === 'isMain' ? !!a.isMain !== !!b.isMain : String(a[k] || '') !== String(b[k] || '')));
  } catch { return []; }
}

/** 判定目标路径是否落在"会击穿前缀"的来源（file/dir 精确匹配）。
 *  2026-10-02 治理：路径集由 pfxqueue.PREFIX_SOURCES（唯一权威）派生，不再手抄；
 *  config.json 身份字段（agent.*）走下方 isInstanceConfig 字段级特例，不在此处按路径命中。 */
function isPrefixFile(p) {
  if (!p) return false;
  try { return require('./pfxqueue').classifyChange([String(p)]).prefix; } catch { return false; }
}
/** 判定目标路径是否为"某实例的 config.json"（主引擎根或任一雷影实例根）。
 *  身份字段（agent.name/role/domain/isMain）会进 prompt.js 的 identityOverlay→稳定前缀，
 *  改它同样击穿前缀。识别：basename=config.json 且同级存在 src/tools.js（实例根标志）。 */
function isInstanceConfig(p) {
  if (!p) return false;
  try {
    const abs = path.resolve(String(p));
    if (path.basename(abs).toLowerCase() !== 'config.json') return false;
    return fs.existsSync(path.join(path.dirname(abs), 'src', 'tools.js'));
  } catch { return false; }
}
/** 身份签名（只取进前缀的字段）：agent.{name,role,domain,isMain} */
function _agentSig(obj) {
  const a = (obj && obj.agent) || {};
  return JSON.stringify([a.name || '', a.role || '', a.domain || '', !!a.isMain]);
}
/** 写 config.json 是否改动了身份字段：write_file 取 args.content；edit_file 用 old→new 回放全文。
 *  文件不存在或 JSON 解析失败 → 一律 false（fail-safe，不误拦）。 */
function _configAgentChanged(pth, toolName, args) {
  try {
    const abs = path.resolve(String(pth));
    if (!fs.existsSync(abs)) return false;
    const oldRaw = fs.readFileSync(abs, 'utf8');
    let newRaw = null;
    if (toolName === 'write_file') newRaw = String((args && args.content) || '');
    else if (toolName === 'edit_file') {
      const o = String((args && args.old) || ''), nw = String((args && args.new) || '');
      if (!o || !oldRaw.includes(o)) return false;
      newRaw = oldRaw.split(o).join(nw);
    }
    if (newRaw == null) return false;
    return _agentSig(JSON.parse(oldRaw)) !== _agentSig(JSON.parse(newRaw));
  } catch { return false; }
}
function isPrefixOperation(name, args, workdir) {
  // ① 工具名本身是前缀类（改技能/进化/重载插件 → 工具定义前缀变化）
  if (PREFIX_WRITE_TOOLS.has(name)) return true;
  // ② 写操作目标是前缀目录（src/plugins、data/skills、data/prompts）的文件，
  //    或写实例 config.json 且改动了身份字段（agent.* 进 identityOverlay→稳定前缀）
  if (name === 'write_file' || name === 'edit_file') {
    const pth = args && args.path;
    if (isPrefixFile(pth)) return true;
    if (isInstanceConfig(pth) && _configAgentChanged(pth, name, args)) return true;
    return false;
  }
  // ③ run_command：**命中前缀路径 且 同时含写信号**才拦（只读命令不拦，防误报）——
  //   路径集由 pfxqueue.PREFIX_SOURCES（唯一权威）派生（prefixPathRegex）；写信号：重定向/写命令/删除/复制/移动等。
  if (name === 'run_command') {
    const cmd = String((args && args.command) || '');
    const hitPath = (() => { try { return require('./pfxqueue').prefixPathRegex().test(cmd); } catch { return false; } })();
    if (!hitPath) return false;
    return _hasWriteSignal(cmd);
  }
  return false;
}

// ==================== 职责边界护栏（批3 · L3-d） ====================
// 角色 × 目标越权时拦下：main 写主引擎运转件 → 拦（应派雷影）；雷影 写任何实例运转件 → 拦（应派主我）。
// 放行：只读工具 / 产物（项目文件、workdir）/ main 自我进化（data\prompts、memory、skills）/ main 运维雷影目录（规则六点1）。
// 分层：write/edit 硬拦；run_command 软提示+审计（脚本可绕过，硬拦不可靠且高误报）；跨实例运转件写入走 shadowCommit。
// 逃生：cfg.roleBoundaryGuard ∈ {off,nudge,enforce}（默认 enforce）；args._confirm===true 单次放行。
const ROLE_LABEL = { main: '主我', programmer: '雷影·程序员', designer: '雷影·美工', writer: '雷影·文案', tester: '雷影·测试', researcher: '雷影·研究员' };
function roleLabel(role) { return ROLE_LABEL[String(role)] || `雷影(${role})`; }
const RUNTIME_SUBDIRS = ['src', 'webui', 'shell', 'app'];
const RUNTIME_FILES = ['config.json', 'config.common.json'];
let _instCache = { at: 0, list: [] };
/** 实例根映射：读 agents_shared.db 的 agents 表（role + data_dir）。data_dir 语义=实例根；兼容历史上按 <root>/data 填写。60s 缓存。 */
function instanceRoots(cfg) {
  if (Date.now() - _instCache.at < 60000 && _instCache.list.length) return _instCache.list;
  const out = [];
  try {
    const p = (cfg && cfg.agentSharedDb) || process.env.LEIZAI_AGENT_SHARED_DB;
    if (p && fs.existsSync(p)) {
      const { DatabaseSync } = require('node:sqlite');
      const d = new DatabaseSync(p, { readOnly: true });
      for (const r of d.prepare('SELECT role, data_dir, is_main FROM agents').all()) {
        if (!r || !r.data_dir) continue;
        const dd = path.resolve(String(r.data_dir));
        const root = fs.existsSync(path.join(dd, 'src', 'server.js')) ? dd : path.dirname(dd);   // 新语义=根本身；旧语义 <root>/data 取其父
        out.push({ role: String(r.role || ''), root, dataDir: dd, isMain: !!r.is_main });
      }
      d.close();
    }
  } catch { }
  if (out.length) _instCache = { at: Date.now(), list: out };
  return out;
}
function classifyTarget(file, cfg) {
  const abs = path.resolve(String(file));
  const inDir = (f, d) => f === d || f.startsWith(d + path.sep);
  // ART：产物（项目文件 / workdir）——放行
  const art = [];
  if (cfg && cfg.projectFilesRoot) art.push(path.resolve(String(cfg.projectFilesRoot)));
  if (cfg && cfg.workdir) art.push(path.resolve(String(cfg.workdir)));
  if (art.some((a) => inDir(abs, a))) return { kind: 'ART' };
  const roots = instanceRoots(cfg);
  for (const inst of roots) if (inDir(abs, inst.dataDir)) return { kind: 'INST', inst, part: 'data' };
  for (const inst of roots) {
    if (RUNTIME_FILES.some((f) => abs === path.join(inst.root, f))) return { kind: 'INST', inst, part: 'config' };
    if (RUNTIME_SUBDIRS.some((d) => inDir(abs, path.join(inst.root, d)))) return { kind: 'INST', inst, part: 'code' };
  }
  return { kind: 'EXT' };
}
function auditBoundary(action, name, role, target, extra) {
  try {
    const { load } = require('./config');
    const dir = path.join(path.resolve((load() || {}).dataDir || path.join(__dirname, '..', 'data')), 'audit');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'role-boundary.log'), `${new Date().toISOString()} ${action} role=${role} tool=${name} target=${target} ${extra || ''}\n`, 'utf8');
  } catch { }
}
/** 建议的接收方（用于错误文案"应派 X"）。 */
function suggestOwner(inst, part) {
  if (inst && inst.isMain) return part === 'data' ? '主我' : '雷影·美工/程序员（视界面/逻辑）';
  return '主我';
}
/** 返回 null（放行）| {mode:'block', msg} | {mode:'nudge', msg}。 */
function roleBoundaryCheck(name, args, ctx) {
  const cfg = (ctx && ctx.cfg) || {};
  const mode = String(cfg.roleBoundaryGuard || 'enforce');
  if (mode === 'off') return null;
  if (args && args._confirm === true) { auditBoundary('CONFIRM', name, (cfg.agent && cfg.agent.role) || '', (args && args.path) || '', ''); return null; }
  const role = String((cfg.agent && cfg.agent.role) || '');
  const wd = (ctx && ctx.workdir) || cfg.workdir || '.';
  const isMain = role === 'main';

  if (name === 'write_file' || name === 'edit_file') {
    let file; try { file = resolvePath(wd, args.path, cfg); } catch { return null; }
    const c = classifyTarget(file, cfg);
    if (c.kind !== 'INST') return null;                                  // 产物/外部 → 放行
    if (isMain && c.inst.isMain && c.part === 'data') return null;       // main 自我进化/意识数据 → 放行（只读保护另有 isReadOnlyKeyPath）
    if (isMain && !c.inst.isMain) return null;                           // main 运维雷影目录 → 放行（规则六点1）
    // 命中：main 写主引擎运转件 / 雷影 写任何实例运转件
    const owner = isMain ? suggestOwner(c.inst, c.part) : '主我';
    const who = isMain ? '主我(main)' : roleLabel(role);
    const msg = `写入被拒绝（职责边界护栏）：${who} 不应直接改「${c.inst.isMain ? '主引擎' : roleLabel(c.inst.role) + ' 实例'}」的运转件 ${path.basename(file)}。应派 ${owner} 执行（越权=自改自证/越位）。如确需放行，请显式传 _confirm:true 或由主我调整 roleBoundaryGuard。`;
    if (mode === 'nudge') { auditBoundary('NUDGE', name, role, file, `would-block owner=${owner}`); return { mode: 'nudge', msg: '【职责边界提醒】' + msg }; }
    auditBoundary('BLOCK', name, role, file, `owner=${owner}`);
    return { mode: 'block', msg };
  }

  if (name === 'run_command') {
    const cmd = String((args && args.command) || '');
    // 批4：精确化判据——必须【同时】命中①写入信号 ②运转件路径才 nudge（删去裸实例根匹配=误报根源）。
    const writeSignal = /Set-Content|Out-File|Add-Content|writeFileSync|appendFileSync|\bNew-Item\b|\bRemove-Item\b|\bMove-Item\b|\bCopy-Item\b|\bdel\b|\brm\b|>\s*[^>]|>>/i.test(cmd);
    const runtimePath = /\bsrc[\\/]/i.test(cmd) || /\bwebui[\\/]/i.test(cmd) || /\bshell[\\/]/i.test(cmd) || /config\.(json|common\.json)/i.test(cmd);
    const writesArtifact = (cfg.projectFilesRoot && cmd.includes(String(cfg.projectFilesRoot))) || (cfg.workdir && cmd.includes(String(cfg.workdir)));
    if (!(writeSignal && runtimePath && !writesArtifact)) return null;
    if (!isMain) {
      auditBoundary('RUNCMD-NUDGE', name, role, cmd.slice(0, 160), '');
      return { mode: 'nudge', msg: '【职责边界提醒】本命令疑似涉及实例运转件写入；雷影不应直接改任何实例运转件，应派主我。本次已放行（软提示，不硬拦）。' };
    }
    auditBoundary('RUNCMD-NUDGE', name, role, cmd.slice(0, 160), '');
    return { mode: 'nudge', msg: '【职责边界提醒】本命令疑似写主引擎运转件；主我改引擎应派雷影·程序员（或确认后放行）。本次已放行（软提示，不硬拦）。' };
  }
  return null;   // 只读工具/其他 → 放行
}

/** 按名字执行。 */
// P0.1-B：Pro 能力映射（工具名→能力名）已**下沉** `src/pro/toolcap.js`（私模侧）。
//   开源侧不再硬编码映射；未知/未映射工具 = deny-by-default（见下方 chokepoint）。

async function exec(name, args, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`未知工具: ${name}`);
  // A. 通用未知参数防呆（软提示，不拦截）：比对 args 与工具 parameters.properties 声明键，
  //    找出"未声明且非空"的键 → 视为疑似拼写错误，warn+audit+结果前置提示，但**仍正常执行**。
  let unknownMsg = '';
  try {
    const props = tool.parameters && tool.parameters.properties;
    if (props && args && typeof args === 'object') {
      const declared = new Set(Object.keys(props));
      const unknown = Object.keys(args).filter((k) => !declared.has(k) && args[k] !== undefined && args[k] !== null && args[k] !== '');
      if (unknown.length) {
        unknownMsg = `⚠️ 收到未声明参数 [${unknown.join(', ')}]，已忽略。本工具可用参数：${Object.keys(props).join('/')}。请核对参数名。`;
        try { console.warn(`[tool-unknown-arg] tool=${name} unknown=[${unknown.join(',')}]`); } catch { }
        try { auditBoundary('TOOL-UNKNOWN-ARG', name, (ctx && ctx.cfg && ctx.cfg.agent && ctx.cfg.agent.role) || '', (ctx && ctx.workdir) || '', `unknown=${unknown.join(',')}`); } catch { }
      }
    }
  } catch { /* 检测失败不得阻塞工具执行 */ }
  // 通用前缀护栏：不逐个枚举工具，凡可能改稳定前缀（工具定义/技能目录/提示词/插件）的操作，
  // 在窗口已接近预算时由引擎统一拦截，强制推到交接后小窗口做，避免在大窗口烧缓存重建。
  // 规避竞态：仅当确为前缀类操作时才检查，其余正常放行。
  let _pfxOp = false;
  try {
    _pfxOp = isPrefixOperation(name, args, ctx && ctx.workdir);
    if (_pfxOp) {
      if (PREFIX_WRITE_TOOLS.has(name)) {
        // A 收窄（2026-10-02）：语义型入口已走 pfxWrite 入队，不再拦（绝不 throw）。
        // 但保留"大窗提醒"——原来靠报错获得的提示不以静默方式消失（仅 log）。
        try {
          const runtime = require('./runtime');
          const _s = runtime.getSession(ctx && ctx.sessionId);
          if (_s) {
            const _min = prefixGuardMinTokensOf(ctx);
            if (runtime.pfxWindowHist(_s) >= _min) {
              console.warn(`[pfx-queue] large-window: ${name} 已入队，将在下一个小窗请求前落地`);
            }
          }
        } catch { }
      } else {
        assertSafeWindow(ctx);   // 命令式裸写（write_file/edit_file/run_command 命中前缀路径）仍拦→报错
      }
    }
  } catch (e) { throw e; }
  // 职责边界护栏（批3）：block→抛错；nudge→放行但结果前置提醒。
  let guard = null;
  try { guard = roleBoundaryCheck(name, args, ctx); } catch { guard = null; }
  if (guard && guard.mode === 'block') throw new Error(guard.msg);
  // Pro 能力门禁（soft-gate · 唯一 chokepoint）：映射已下沉 src/pro/toolcap.js，开源侧只传「工具名+参数」。
  //   ① 未知/未映射工具 = deny-by-default（防改名/新增工具绕过）；
  //   ② 映射命中 cap → gate.checkPro（异步，走私模独立进程；异常/超时/缺失一律 deny）；
  //   ③ 门禁/映射层异常 = deny（fail-safe-lite），**不再 fail-open**（P0.1-B 修原 2333）。
  // 开发版（gate mode!=='enforce'）由 checkPro 本地放行 → dev 不受影响。
  try {
    const _tc = getToolCap();
    if (!_tc) {
      return `⛔ 能力映射表缺失（src/pro/toolcap.js 未安装/加载失败），已按 fail-closed 拒绝工具「${name}」。`;
    }
    const info = _tc.classify(name, args);
    if (!info.known) {
      return `⛔ 「${name}」未在能力映射表中登记（未知/未映射工具），已按 deny-by-default 拒绝。`;
    }
    if (info.cap) {
      let g;
      try { g = await require('./pro/gate').checkPro(info.cap, { sessionId: ctx && ctx.sessionId, tool: name, args, ctx }); }
      catch (e) { g = { allow: false, tier: 'lite', reason: 'gate-unavailable(fail-safe-lite)', quota: null }; }
      if (!g || g.allow !== true) {
        const q = g && g.quota ? `；上限 ${JSON.stringify(g.quota)}` : '';
        return `⛔ 「${name}」属 Pro 能力（当前 ${(g && g.tier) || 'lite'} 档｜${(g && g.reason) || 'gate-unavailable'}${q}）。升级 Pro 后可用。`;
      }
    }
  } catch (e) {
    // P0.1-B：门禁/映射层异常 ← 一律 deny（fail-safe-lite），不再放行。
    return `⛔ 门禁校验异常，已拒绝工具「${name}」（fail-safe-lite）：${(e && e.message) || e}`;
  }
  const out = await tool.execute(args, ctx);
  // 记录层收口（2026-10-02）：凡命中 PREFIX_SOURCES 的前缀变更必有记录（旁路：write/edit/run/reload）。
  //  origin 由工具名结构性推导（禁工具参数注入）；失败静默（recordChange 内部留痕）。
  try {
    const _pq = require('./pfxqueue');
    const _paths = _pfxChangedPaths(name, args);
    let _cfgPath = null, _idKeys = null;
    if ((name === 'write_file' || name === 'edit_file') && args && args.path && isInstanceConfig(args.path)) {
      const _ks = _configAgentChangedKeys(args.path, name, args);
      if (_ks.length) { _cfgPath = path.resolve(String(args.path)); _idKeys = _ks; }
    }
    if (_paths.length || (_cfgPath && _idKeys)) {
      const _cmd = (name === 'run_command') ? String((args && args.command) || '') : '';
      _pq.recordChange({
        tool: name, changedPaths: _paths, configPath: _cfgPath, identityKeys: _idKeys,
        origin: 'tool:' + name, srcSession: ctx && ctx.sessionId, srcTurn: ctx && ctx.turn,
        uncovered: (name === 'run_command') && _paths.length > 0 && !_hasWriteSignal(_cmd),
        contentHash: (name === 'run_command') ? _cmd : String((args && (args.content || args.new)) || ''),
      });
    }
  } catch { }
  // ③ C：前缀操作成功后置位本代标志（纯内存，不落盘——重启/交接后 gen 变或字段丢失 → 自然重置，首次仍放行）。
  if (_pfxOp) {
    try {
      const rt = require('./runtime');
      const es = rt.getSession(ctx && ctx.sessionId);
      if (es) { es._pfxDoneInGen = true; es._pfxGen = Number(rt.resolveBranchTurnGen(ctx && ctx.sessionId)) || 0; }
    } catch { }
  }
  let res = out;
  if (guard && guard.mode === 'nudge') res = `${guard.msg}\n\n${res}`;
  if (unknownMsg) res = `${unknownMsg}\n\n${res}`;
  return res;
}

module.exports = { TOOLS, definitions, exec, resolvePath, assertWritable, reloadPlugins, PLUGIN_DIR, inSelfModifyScope, isReadOnlyKeyPath, shadowCommit, validateDraft, roleBoundaryCheck, classifyTarget, instanceRoots, assertSafeWindow, isPrefixOperation, TOOL_CAP: (() => { try { return require('./pro/toolcap').CAP_MAP; } catch (e) { return {}; } })() };
