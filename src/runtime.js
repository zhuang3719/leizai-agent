'use strict';
// 雷仔 · 运行时：会话管理 + 工具调用回合引擎 + 反思进化循环 + 统计
//
// 缓存纪律（DeepSeek 前缀缓存）：
//  - system 提示词永远不变（进化除外，且进化经版本控制）；
//  - 对话历史严格按原顺序回放，绝不插入动态内容；
//  - 动态信息（时间/轮次/目标）全部追加在 user 消息正文里；
//  - 历史压缩只在超预算时进行，压缩后形成新的稳定前缀，后续回合继续命中。
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ROOT, DATA_DIR, load: loadConfig } = require('./config');
const { systemPrompt } = require('./prompt');
const tools = require('./tools');
const { chatStream, chatOnce } = require('./deepseek');
const { resolve: resolveProvider, pricesFor } = require('./providers');
const memory = require('./memory');
const archiveStore = require('./archiveStore');
const evolution = require('./evolution');
const selfmodel = require('./selfmodel');
const branch = require('./branch');   // 世界树·支干事件库（P0 · 双写、附加式）
// 任务B：模型可用性状态总线（deepseek 侧 emit → 引擎事件 'llm-status' → server broadcast → 前端常驻横幅）
const deepseekBus = require('./deepseek');

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

/** 本实例自身 role（config.agent.role）；未配置返回 null。 */
function selfRole() { const c = loadConfig(); return (c.agent && c.agent.role) ? String(c.agent.role) : null; }
const REFLECT_THROTTLE_MS = 3 * 60 * 1000;
// 重复输出护栏（防"死循环复读一句话"）：命中后重置气泡并以更强抗复读采样重试的次数上限
const REPEAT_RETRY_MAX = 1;
const REPEAT_RETRY_PENALTY = 0.8;   // 重试时临时抬高的 frequency_penalty
// 空响应护栏（既无正文也无工具调用）：自动重呼一次的上限（2026-10-02）
const EMPTY_RETRY_MAX = 2;
// 工具死循环护栏：工具名+参数完全一致连续出现次数上限，超过即停止本轮
const TOOL_LOOP_MAX = 4;
// v6.9 方案A：回合结束后"新到达未读"自动续跑的连续次数上限（防 A↔B 无限往返）
const MAILBOX_UNREAD_RESUME_MAX = 3;
// v6.26 方案B：每会话自动唤醒速率窗（兜底，防密集 reply 触发反复自我续跑）；可被 cfg.mailboxWakeRateMax/WindowMs 覆盖
const MAILBOX_WAKE_MAX_PER_WINDOW = 3;    // 时间窗内最多自动唤醒次数（0=不限）
const MAILBOX_WAKE_WINDOW_MS = 60 * 1000; // 速率窗长度(ms)
// 会话级上下文预算硬上限（后端兜底，防绕过前端直调 API/工具）：钳到 [1000, 900000]，绝不超模型 1M 窗口安全线。
const CONTEXT_BUDGET_MAX = 900000;
const _wakeWindowBySession = new Map();   // sessionId -> { ts, count }（仅内存）
// P2b-9：rate-limited 后按窗口剩余时间保底重排——确保"下一窗口被唤醒"，绝不静默悬挂（ADR §2.5/G8）
const MAX_WAKE_RATE_RETRY = 3;            // 单条未读链最多重排次数（防死循环）
const _rateRetryBySession = new Map();    // sessionId -> { count, timer }（仅内存）
// 批1 L3-④：引擎级"有界自续"连续轮数硬上限（防自驱无限循环）
const AUTO_RESUME_MAX = 2;
// v6.24：新建的空会话在列表中的可见窗口（超过则隐藏，避免空壳堆积）
const EMPTY_SESSION_VISIBLE_MS = 60 * 60 * 1000;
// 世界树·支干（P0）：sessionId → 当前世代号（仅内存，供 turn 骨架标注 gen；不落会话文件，不动现有持久化）
const branchGenBySession = new Map();

const runtime = new EventEmitter();
// 任务B：LLM 调用成功/失败 → 引擎事件 'llm-status'（前端据此显示/隐藏"模型服务不可用"常驻横幅）
try { deepseekBus.onLlmStatus((d) => { try { runtime.emit('llm-status', d); } catch { } }); } catch { }
runtime.globalStats = {
  calls: 0, hitTokens: 0, missTokens: 0, outputTokens: 0,
  ttfbSumMs: 0, ttfbCount: 0, durationSumMs: 0, durationCount: 0, startedAt: Date.now(),
  lastTurn: null, lastCacheHitRate: 0,
};
runtime.sessions = new Map();

// v6.7 卡死回合周期收割：每 60s 扫一遍，强制释放 running 超硬上限的会话（开关 cfg.turnReaperEnabled，默认 true）。
// 与 runChat 入口收割互补，杜绝"只能杀进程恢复"。函数声明提升，定义在后不影响此处引用。
try {
  const _reaperTimer = setInterval(() => {
    try {
      if (loadConfig().turnReaperEnabled === false) return;
      for (const s of runtime.sessions.values()) {
        if (s && s.running && isStuckTurn(s)) forceReleaseStuckTurn(s, 'reaper周期');
      }
    } catch { }
  }, 60000);
  if (_reaperTimer.unref) _reaperTimer.unref();
} catch { }

function sessionFile(id) { return path.join(SESSIONS_DIR, `${id}.json`); }
function sessionMetaFile(id) { return path.join(SESSIONS_DIR, `${id}.meta.json`); }

/** 会话元数据镜像（小文件）：listSessions 只读它，避免每次列表刷新都全量解析所有会话 JSON（含长消息）。
 *  - saveSession / 回退解析时写入；旧会话无 meta 时 listSessions 回退全量解析并顺手补一个；
 *  - 不存 running/controller 等运行时态（与主文件一致：落盘时一律 running=false，运行时态在内存）。 */
function writeMeta(s) {
  try {
    const m = {
      id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt,
      pinned: !!s.pinned, archived: !!s.archived,
      project: s.project || '', workdir: s.workdir || null, trashedAt: s.trashedAt || null,
      contextBudget: s.contextBudget || null,
      model: s.model || null,
      reasoningEffort: s.reasoningEffort || null,
      messageCount: (s.messages || []).length,
    };
    fs.writeFileSync(sessionMetaFile(s.id), JSON.stringify(m), 'utf8');
  } catch (e) { /* meta 写失败不阻塞主流程 */ }
}

function metaToView(m) {
  return {
    id: m.id, title: m.title, createdAt: m.createdAt, updatedAt: m.updatedAt,
    running: false, pinned: !!m.pinned, archived: !!m.archived,
    project: m.project || '', workdir: m.workdir || null, trashedAt: m.trashedAt || null,
    contextBudget: m.contextBudget || null,
    model: m.model || null,
    reasoningEffort: m.reasoningEffort || null,
    messageCount: m.messageCount || 0,
  };
}

function ensure() { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); }

/** 每个会话的独立项目文件夹（存放该项目进度/决定/笔记）。 */
function projectDir(id) {
  return path.join((loadConfig().workdir || ''), 'projects', String(id).replace(/[^A-Za-z0-9_-]/g, '_'));
}

/** 每个会话的项目文件总库（非文本产物默认落点）：<projectFilesRoot>/<项目名>/{图片,视频,音频,代码,其他数据}。
 *  目录名 = 项目名（共享名册 DB 为唯一事实源）；DB 不可用/异常 → 回退旧目录名（会话 id），绝不抛错。
 *  注意：**不再**在会话创建时预建 5 个空目录（根治空壳），改为真正写产物时按需创建。 */
function projectFilesDir(id) {
  const sid = String(id);
  let root = null, role = 'main', name = '', project = '', title = '';
  try {
    const c = loadConfig();
    root = c.projectFilesRoot || path.join(ROOT, '项目文件');
    role = (c.agent && c.agent.role) || 'main';
    const s = runtime.sessions.get(sid);
    if (s) { project = s.project || ''; title = s.title || ''; }
  } catch { }
  if (!root) root = path.join(ROOT, '项目文件');
  let folder = null;
  try {
    const reg = require('./projectRegistry');
    if (reg.available() || reg.init()) {
      const f = reg.resolveFolder(sid, { role, project, title });
      if (f) folder = f;
    }
  } catch { }
  if (!folder) folder = sid.replace(/[^A-Za-z0-9_-]/g, '_');   // 回退：旧目录名（会话 id）
  return path.join(root, folder);
}

/** 按需创建某类型产物子目录（首次写入时才建，避免预建空壳）。返回子目录路径；失败返回 null。 */
function ensureProjectFilesSubdir(id, type) {
  try {
    const dir = path.join(projectFilesDir(id), String(type || '其他数据'));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch { return null; }
}

/** 会话改名/改项目后同步：①名册 rename（含目录名唯一化）②物理目录 rename ③账本首行标题。失败仅记日志。 */
function syncProjectFiles(id) {
  try {
    const reg = require('./projectRegistry');
    if (!reg.available() && !reg.init()) return;
    const s = runtime.sessions.get(String(id));
    if (!s) return;
    const c = loadConfig();
    const root = c.projectFilesRoot || path.join(ROOT, '项目文件');
    const role = (c.agent && c.agent.role) || 'main';
    const r = reg.rename(String(id), { role, project: s.project || '', title: s.title || '' });
    if (r && r.changed && r.oldFolder && r.newFolder) {
      const oldDir = path.join(root, r.oldFolder);
      const newDir = path.join(root, r.newFolder);
      try {
        if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) fs.renameSync(oldDir, newDir);
      } catch (e) { console.error('[projectFiles] 目录改名失败:', e && e.message); }
    }
    // 同步账本首行标题（projects/<id>/_progress.md）
    try {
      const pf = path.join(projectDir(id), '_progress.md');
      if (fs.existsSync(pf)) {
        const txt = fs.readFileSync(pf, 'utf8');
        const nt = txt.replace(/^# 项目进度：.*$/m, `# 项目进度：${s.title || '新会话'}`);
        if (nt !== txt) fs.writeFileSync(pf, nt, 'utf8');
      }
    } catch (e) { console.error('[projectFiles] 账本标题同步失败:', e && e.message); }
  } catch (e) { console.error('[projectFiles] 同步失败:', e && e.message); }
}

function createSession() {
  ensure();
  const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const s = {
    id, title: '新会话', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), messages: [],
    stats: { calls: 0, hitTokens: 0, missTokens: 0, outputTokens: 0 },
    running: false, controller: null, lastReflectAt: 0,
    pinned: false, archived: false,
    // 轻量项目层：仅元数据（影响界面筛选/工作目录/记忆标注），绝不进入稳定 system 前缀 → 不影响 token 缓存
    project: '',      // 所属项目（仅组织与展示）
    workdir: null,    // 可选：本会话专属工作目录（默认用 config.workdir）
    trashedAt: null,  // 回收站：软删除时间戳（30 天后自动清除；可恢复）
    contextBudget: null,   // 会话级上下文预算（覆盖全局 config.contextBudget；null=跟随全局）
    model: null,           // 会话级模型覆盖（null=跟随全局 config.model）
    reasoningEffort: null, // 会话级推理等级覆盖（null=跟随全局 config.reasoningEffort；'off'=不发）
  };
  runtime.sessions.set(id, s);
  saveSession(s);
  // 每个会话自动建立独立项目文件夹 + 进度账本（"一个对话 = 一个项目"）
  try {
    fs.mkdirSync(projectDir(id), { recursive: true });
    const pf = path.join(projectDir(id), '_progress.md');
    if (!fs.existsSync(pf)) fs.writeFileSync(pf, `# 项目进度：${s.title || '新会话'}\n\n> 规则/决定/进展按时间记到这里（由 log_progress / 雷仔自动沉淀）。\n`, 'utf8');
  } catch { }
  // —— 项目文件总库：非文本产物默认落点 ——
  // 名册登记"会话→项目名目录" + 只建**项目名顶层目录**（不再预建 5 个类型空目录，根治空壳；
  // 5 个类型子目录由产物写入方按需创建）。失败静默，绝不影响会话创建。
  try {
    const reg = require('./projectRegistry');
    if (reg.available() || reg.init()) {
      reg.resolveFolder(id, { role: (loadConfig().agent && loadConfig().agent.role) || 'main', project: s.project || '', title: s.title || '' });
      fs.mkdirSync(projectFilesDir(id), { recursive: true });
    }
  } catch { }
  return s;
}

/** 会话生效预算：会话级 contextBudget 覆盖全局；仅影响压缩阈值与交接提示，绝不进入对话前缀。 */
function effectiveBudget(s) {
  const b = s && s.contextBudget;
  return (Number.isInteger(b) && b >= 1000) ? b : loadConfig().contextBudget;
}

function getSession(id) {
  let s = runtime.sessions.get(id);
  if (!s) {
    try {
      s = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
      s.running = false; s.controller = null; s.lastReflectAt = s.lastReflectAt || 0;
      recoverDraft(s);   // 崩溃恢复：残留回复草稿 → 补为正式 assistant 消息
      // 加载自愈（2026-09-24）：历史会话文件可能残留"孤儿 tool"（force_handoff 中途重建所致）→ 清理，防下次请求 HTTP 400。
      try { sanitizeOrphanTools(s.messages); } catch { }
      runtime.sessions.set(id, s);
    } catch { throw new Error(`会话不存在: ${id}`); }
  }
  return s;
}

/** 轻量存在性检查（不解析会话正文）：归档/删除等非正文接口用它，
 * 避免为"确认会话存在"全量 JSON.parse MB 级会话文件。 */
function sessionExists(id) {
  if (runtime.sessions.has(id)) return true;
  try { return fs.existsSync(sessionFile(id)); } catch { return false; }
}

let _lastSavedSig = new Map();   // sessionId → 上次落盘指纹（消息+元数据，避免无变化时重复 stringify+全量写盘）

/** 零风险的写盘节流：会话内容与上次落盘一致时跳过 stringify+写盘（进程内）；
 * 消息或管理字段（title/pinned/archived/project/workdir/trashedAt）确实变化时仍全量写 ——
 * **全量 JSON 保持崩溃恢复的完整性根基**，不改成增量 JSONL（那会破坏 getSession/
 * listSessions/删除/归档回滚的一致性语义）。指纹只做"变没变"判断（O(n) 轻量遍历），不做内容级比较。 */
function saveSession(s) {
  ensure();
  const sig = sessionSig(s);
  const prev = _lastSavedSig.get(s.id);
  if (prev === sig) {
    // 内容未变（如运行态复位/重复保存）：不重复写大文件（meta 也一致，无需补写）
    return;
  }
  _lastSavedSig.set(s.id, sig);
  const copy = { ...s, running: false, controller: null };
  fs.writeFileSync(sessionFile(s.id), JSON.stringify(copy), 'utf8');
  writeMeta(s);
}

/** 会话保存指纹：消息（条数+总长+首尾内容+角色种子）+ 管理字段（title/pinned/archived/project/workdir/trashedAt）。
 * 任何会影响"重启后看到的会话"的字段都纳入，缺一不可；O(n) 轻量遍历，避免把 stringify 成本前置。 */
/** 崩溃恢复兜底：流式回复期间的增量草稿落盘。
 *  回复是"流式生成、finally 才一次性落盘正式消息"，若进程在生成中途被重启，
 *  磁盘上无这条回复 → 丢失（用户感知为"回复凭空消失"）。这里在生成期间把当前
 *  草稿（replyDraft）节流写入会话文件；重启后由 recoverDraft 把它恢复成一条正式
 *  assistant 消息补入会话，实现"重启不丢已生成的回复"。
 *  草稿存会话顶层 replyDraft 字段，不进入 messages（避免污染 toWire/前缀），
 *  走独立写盘路径，不依赖 sessionSig（起草稿时 messages 未变，saveSession 会跳过）。 */
const DRAFT_THROTTLE_MS = 800;   // 最短落盘间隔：控制全量 stringify 频率，崩溃丢失窗口 ≤1s
function saveDraft(s) {
  if (!s || typeof s.replyDraft !== 'string' || !s.replyDraft.trim()) return;
  const now = Date.now();
  if (now - (s._draftTs || 0) < DRAFT_THROTTLE_MS) return;
  s._draftTs = now;
  try {
    // 不写 meta（草稿仅供恢复，不进列表计数）；running 落盘时归一为 false（与 saveSession 一致）
    const copy = { ...s, running: false, controller: null };
    fs.writeFileSync(sessionFile(s.id), JSON.stringify(copy), 'utf8');
  } catch (e) { /* 草稿落盘失败不阻塞回复流 */ }
}

/** 重启恢复：若会话文件里残留 replyDraft（上次进程在回复生成中被打断），
 *  把它恢复为一条正式 assistant 消息补入会话，并清掉草稿、落盘正式化。
 *  客户端渲染时按普通 assistant 消息处理，无需改客户端。 */
function recoverDraft(s) {
  if (!s || typeof s.replyDraft !== 'string' || !s.replyDraft.trim()) return;
  try {
    s.messages = s.messages || [];
    const txt = s.replyDraft;
    // v6.24：去重——若紧邻上一条 assistant 文本与草稿完全相同，视为已提交过，不再重复补（防"recoverDraft 与已提交消息重复"）。
    const last = s.messages[s.messages.length - 1];
    if (last && last.role === 'assistant' && String(last.content || '').trim() === txt.trim()) {
      delete s.replyDraft;
      s._draftTs = 0;
      saveSession(s);
      console.log(`[崩溃恢复] 会话 ${s.id} 草稿与末条 assistant 重复，已去重（不重复补入）`);
      return;
    }
    s.messages.push({ role: 'assistant', content: txt, _recovered: true });
    delete s.replyDraft;
    s._draftTs = 0;
    // messages 已新增一条 → sessionSig 变化 → saveSession 必然落盘（新进程 _lastSavedSig 为空，安全）
    saveSession(s);
    console.log(`[崩溃恢复] 会话 ${s.id} 发现中断回复草稿，已恢复为正式消息`);
  } catch (e) { /* 恢复失败保留草稿字段，不阻塞主流程 */ }
}

function sessionSig(s) {
  const msgs = s.messages || [];
  let sum = 0, seed = 0;
  const n = msgs.length;
  for (let i = 0; i < n; i++) {
    const m = msgs[i];
    const c = String((m && m.content) || '');
    sum += c.length;
    seed = ((seed * 31) + (m && m.role ? m.role.length : 0) + ((i & 7) === 0 ? c.length : 0)) >>> 0;
  }
  // H1 修补：_pendingInbound 必须纳入指纹 —— 入队只改该字段（messages 未变），
  // 若不计入，saveSession 首行 `prev===sig` 直接 return，忙时标记不落盘 → 重启即丢、启动 sweep 无货可补。
  // 出队（flush 后清空）同样改变指纹 → 补标后来一次真实落盘。空数组取 ''（与旧签名一致，无 pending 会话零影响）。
  const pbi = s._pendingInbound || [];
  const pbSig = pbi.length
    ? pbi.map((x) => (x && x.ts) || 0).join(',') + ':' + pbi.reduce((a, x) => a + String((x && x.content) || '').length, 0)
    : '';
  // P2b-15（2026-09-22）：会话级 model / reasoningEffort 必须纳入指纹 —— 否则仅改这两项时
  //   saveSession 首行 `prev===sig` 直接 return（不写盘、也不写 meta）→ 切会话列表读 meta 显示旧值、重启即丢。
  return `${n}|${sum}|${seed}|${String((msgs[0] && msgs[0].content) || '').slice(0, 200)}|${String((msgs[n - 1] && msgs[n - 1].content) || '').slice(-200)}|` +
    `${s.title}|${!!s.pinned}|${!!s.archived}|${s.project || ''}|${s.workdir || ''}|${s.trashedAt || ''}|${s.contextBudget || ''}|${s.model || ''}|${s.reasoningEffort || ''}|pb:${pbSig}`;
}

function listSessions() {
  ensure();
  const out = [];
  const filtered = (f) => f.endsWith('.json') && !f.endsWith('.meta.json');
  for (const f of fs.readdirSync(SESSIONS_DIR).filter(filtered)) {
    const id = f.slice(0, -5);   // 去掉 .json
    try {
      // 快路径：只读元数据小文件（列表刷新不再全量解析会话正文）
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(sessionMetaFile(id), 'utf8')); } catch (e) { }
      if (meta && meta.id === id) {
        out.push(metaToView(meta));
        continue;
      }
      // 回退：旧会话无 meta → 全量解析，并顺手生成 meta，之后走快路径
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      writeMeta(s);
      out.push({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt,
        running: s.running || false, pinned: !!s.pinned, archived: !!s.archived,
        project: s.project || '', workdir: s.workdir || null, trashedAt: s.trashedAt || null,
        contextBudget: s.contextBudget || null,
        model: s.model || null,
        reasoningEffort: s.reasoningEffort || null,
        messageCount: (s.messages || []).length });
    } catch (e) { /* 单个会话文件损坏：跳过，不阻塞整个列表 */ }
  }
  // v6.24 修复（任务·交互4项）：新建的空会话在"创建后一段窗口内"也可见。
  //   旧行为：`messageCount>0 || running || pinned || archived` —— 新建会话 messages=[]，
  //   于是 POST /api/sessions 后 GET /api/sessions 立即查**不含**新 id，须等首条消息落盘才出现，
  //   用户感知为"点了新建、列表半天不刷新"（已实测复现）。
  //   现改为：窗口内的空会话同样返回（窗口外的空壳仍隐藏，防历史空会话堆积）。
  const _now = Date.now();
  return out
    .filter((s) => s.messageCount > 0 || s.running || s.pinned || s.archived
      || (_now - Date.parse(s.createdAt || s.updatedAt || 0) < EMPTY_SESSION_VISIBLE_MS))
    .sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt > a.updatedAt ? 1 : -1);
    });
}

/** 更新会话元数据（标题 / 置顶 / 归档 / 项目 / 工作目录 / 会话级上下文预算）；只改管理字段，不触碰对话内容。 */
function patchSession(id, patch) {
  const s = getSession(id);
  if (patch && typeof patch.title === 'string') s.title = patch.title.trim().slice(0, 40) || s.title;
  if (patch && typeof patch.pinned === 'boolean') s.pinned = patch.pinned;
  if (patch && typeof patch.archived === 'boolean') s.archived = patch.archived;
  if (patch && typeof patch.project === 'string') s.project = patch.project.trim().slice(0, 40);
  if (patch && typeof patch.workdir === 'string') s.workdir = patch.workdir.trim() || null;
  // 会话级上下文预算：整数 ≥1000 生效，钳到 [1000, CONTEXT_BUDGET_MAX=900000]；null/'default'/空 = 恢复跟随全局
  if (patch && 'contextBudget' in patch) {
    const v = patch.contextBudget;
    if (v === null || v === undefined || v === '' || v === 'default') s.contextBudget = null;
    else if (Number.isInteger(v) && v >= 1000) s.contextBudget = Math.min(v, CONTEXT_BUDGET_MAX);
    else if (typeof v === 'number' && isFinite(v)) s.contextBudget = Math.min(CONTEXT_BUDGET_MAX, Math.max(1000, Math.round(v)));
  }
  // 会话级模型覆盖：string 生效（trim）；null/''/'default' = 恢复跟随全局
  if (patch && 'model' in patch) {
    const v = patch.model;
    if (v === null || v === undefined || v === '' || v === 'default') s.model = null;
    else if (typeof v === 'string') s.model = v.trim() || null;
  }
  // 会话级推理等级覆盖：枚举 {off,low,medium,high,max} 生效；null/''/'default' = 恢复跟随全局
  if (patch && 'reasoningEffort' in patch) {
    const v = patch.reasoningEffort;
    if (v === null || v === undefined || v === '' || v === 'default') s.reasoningEffort = null;
    else if (typeof v === 'string' && ['off', 'low', 'medium', 'high', 'max'].includes(v.trim())) s.reasoningEffort = v.trim();
  }
  saveSession(s);
  // 标题/项目变更 → 同步项目文件总库目录名 + 名册（失败静默）
  try { syncProjectFiles(s.id); } catch { }
  return { id: s.id, title: s.title, pinned: !!s.pinned, archived: !!s.archived, project: s.project || '', workdir: s.workdir || null, contextBudget: s.contextBudget || null, model: s.model || null, reasoningEffort: s.reasoningEffort || null };
}

function deleteSession(id) {
  const f = sessionFile(id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  const mf = sessionMetaFile(id);
  if (fs.existsSync(mf)) fs.unlinkSync(mf);
  runtime.sessions.delete(id);
  _lastSavedSig.delete(id);   // 清理写盘指纹，防 id 复用后误跳写盘
  try { memory.archiveErase(id); } catch { }   // 清除该会话的上下文归档
  try { require('./projectRegistry').remove(id); } catch { }   // 清理名册映射
  // C：级联清理信箱会话映射（正/反向），防删除主会话后残留孤儿映射+对端会话
  try { require('./mailbox').unlinkBySession(id); } catch { }
  // 清除该会话的独立项目文件夹（带防御性守卫：只删除 projects/ 下、名字为安全 token 的子目录）
  try {
    const pd = projectDir(id);
    const projRoot = path.join((loadConfig().workdir || ''), 'projects');
    if (pd.startsWith(projRoot + path.sep) && /^[A-Za-z0-9_-]+$/.test(path.basename(pd))) {
      fs.rmSync(pd, { recursive: true, force: true });
    }
  } catch { }
  // 会话销毁时释放其 Python REPL 进程
  try { require('./repl').kill(id); } catch { }
  // v6.56：会话销毁时清理其上传附件目录（DATA_DIR/uploads/<sid>，防残留堆积）
  try { const _uid = String(id).replace(/[^A-Za-z0-9_-]/g, '_'); if (_uid) fs.rmSync(path.join(DATA_DIR, 'uploads', _uid), { recursive: true, force: true }); } catch { }
}

function stopRun(id) {
  const s = runtime.sessions.get(id);
  if (!s) return false;
  let stopped = false;
  try {
    if (s.controller) {
      if (!(s.controller.signal && s.controller.signal.aborted)) s.controller.abort();
      stopped = true;
    }
  } catch { }
  // v6.22：记录中止时刻（供卡死收割器兜底）+ 标记"刚被停止"（短期抑制信箱自动唤醒，防"停不掉"复活）
  try { s._abortedAt = Date.now(); s._stoppedAt = Date.now(); } catch { }
  // 兜底：处于 running 却无 controller（异常残留）→ 直接释放运行标记，避免"停止无效/一直排队"
  if (!stopped && s.running) {
    try {
      s.running = false; s._runStartedAt = 0; s.controller = null;
      try { repairInterruptedTurn(s); } catch { }   // v6.24：兜底释放同样清理脏状态
      require('./mailbox').clearBusy(selfRole());
      console.log(`[停止] 兜底释放无 controller 的运行态 session=${id}`);
      stopped = true;
    } catch { }
  }
  return stopped;
}

// —— 消息换算 & 预算 ——

/**
 * 中文感知的 token 估算：CJK ≈ 0.7379 字/token（2026-09-04 对 DeepSeek API 实测校准值：
 * 2 万中文纯文本字 → 14757 prompt_tokens），其余按 ~3.3 字符/token。
 * 仅用于上下文预算/压缩判断（不参与计费）。触发判定另外以 API 回传的真实 prompt_tokens 为准（_lastPromptTokens）。
 */
function estimateTokens(m) {
  const s = JSON.stringify(m);
  let tok = 0;
  for (const ch of s) {
    tok += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 0.7379 : 0.3;
  }
  return Math.max(1, Math.ceil(tok));
}

/** v6.42：纯标记类入站消息判定——由通道B（/api/mailbox/event 写历史标记 + drainPendingInbound 落库摘要）
 *  写入 s.messages 的 user 气泡锚点（形如 `[雷影回执] from: …（共N字·详信箱）`）。
 *  它仅供 UI 气泡与未读窗口判定（读 s.messages），**不进 LLM wire**：全文由回合起始未读前缀唯一表达，
 *  根治"同一条入站在 wire 出现两次"（B 摘要 + A 前缀）。判定严格：需带 _inbound 且 content 为标记形态。 */
function isInboundMarkerMsg(m) {
  return !!(m && m.role === 'user' && m._inbound && typeof m.content === 'string'
    && /^\[雷影(回执|派活|应答|通知|确认)\]/.test(m.content));
}

/** refs=sys-marker（2026-10-10）：统一构造"入站标记气泡"（引擎注入锚点）——**单处权威**。
 *  恒带 engine:true（前端按「系统」样式渲染，勿冒充"主人"/角色）。
 *  本地直写（server.js /api/mailbox/event）、忙时延迟 drain（drainPendingInbound）、
 *  跨实例 notify 落点（经 mailbox 投递到目标实例后同样走此工厂）均调用本函数，消散点判定。
 *  @param {string} from 来源（role 或 session）
 *  @param {string} type task|result|reply|notify|ack
 *  @param {*} msgId 消息 id（幂等锚点）
 *  @param {string} content 标记文案（≤40 字锚点，全文在信箱库）
 *  @param {number} ts 入站时间戳
 *  @param {string} [wakeIntent] 写侧唤醒意图（可空；空则不写该键）
 *  @param {object} [extra] 追加 _inbound 字段（如 { delayed: true }）
 */
function buildInboundMarker(from, type, msgId, content, ts, wakeIntent, extra) {
  const _inbound = { from, type, msgId, ts };
  if (wakeIntent != null) _inbound.wake_intent = wakeIntent;
  if (extra && typeof extra === 'object') Object.assign(_inbound, extra);
  return { role: 'user', content, _inbound, engine: true };
}

function toWire(messages) {
  // v6.44/v6.45：thinking 模式（deepseek）要求回传 assistant 的 reasoning_content（否则偶发 400
  //   "The reasoning_content in the thinking mode must be passed back to the API"）。
  //   v6.45：开关 wirePassReasoning（默认 true，A/B 用；false=回退旧行为）；deepseek 下**所有 assistant 一律带**
  //     reasoning_content：有 reasoning 用真值，**缺失/空 → 置 ''**（空 RC 实测 200，可覆盖旧消息、消除"省略即报错"）。
  const _rcCfg = (() => { try { return loadConfig(); } catch { return {}; } })();
  const _rcOn = (() => { try { return resolveProvider(_rcCfg).thinkingFormat === 'deepseek' && _rcCfg.wirePassReasoning !== false; } catch { return false; } })();
  const attachRC = (w, m) => { if (_rcOn) { let _rc = (m && typeof m.reasoning === 'string' && m.reasoning) ? m.reasoning : ''; const _mx = (() => { const v = Number(_rcCfg && _rcCfg.wireReasoningMaxChars); return (isFinite(v) && v > 0) ? v : 0; })(); if (_mx && _rc.length > _mx) _rc = _rc.slice(-_mx); w.reasoning_content = _rc; } return w; };   // v6.50（修复③·可选·默认关）：cfg.wireReasoningMaxChars>0 → reasoning_content 截尾（省回传）
  // 双向配对过滤（防 API 400 'assistant message with tool_calls must be followed by tool messages'）：
  //  ① 未被紧邻应答的 assistant.tool_calls：只保留"其后的连续 tool 消息中存在同 id 应答"的 id；一个都没有 → 不输出 tool_calls（降级普通 assistant）。
  //  ② 孤儿 tool 消息（不属任何紧邻组的应答）：丢弃（其内容已在归档，可召回）。
  // 采用"紧邻分组"而非全局 id 集合：既保证每个 tool_call 有条目，又保证 tool 应答紧跟在 assistant.tool_calls 之后（DeepSeek 硬性要求相邻）。
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') {
      if (isInboundMarkerMsg(m)) continue;   // v6.42：纯标记（气泡锚点）不进 wire，全文由起始未读前缀唯一表达（toWire 仅组装副本，不改 s.messages 存储）
      out.push({ role: 'user', content: m.content }); continue;
    }
    if (m.role === 'assistant') {
      const calls = m.toolCalls || [];
      const w = { role: 'assistant', content: m.content || '' };
      if (!calls.length) { attachRC(w, m); out.push(w); continue; }
      // 收集紧随其后的连续 tool 消息（紧邻配对的应答）
      const byId = new Map();
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        const t = messages[j];
        if (t.toolCallId != null) byId.set(String(t.toolCallId), t);
        j++;
      }
      const kept = calls.filter((t) => t && t.id != null && byId.has(String(t.id)));
      if (kept.length) {
        w.tool_calls = kept.map((t) => ({
          id: t.id, type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.arguments) },
        }));
        attachRC(w, m); out.push(w);
        // 仅输出被 kept 认领的应答（按 kept 顺序），未认领的孤儿应答随组丢弃
        for (const t of kept) out.push({ role: 'tool', tool_call_id: t.id, content: byId.get(String(t.id)).content });
      } else {
        attachRC(w, m); out.push(w);   // 无任何应答 → 降级为普通 assistant，不带 tool_calls
      }
      i = j - 1;       // 消费掉本组连续 tool 消息
      continue;
    }
    // role:'tool' 且未落入上一 assistant 的紧邻组 → 孤儿，丢弃（不发送，避免 400）
  }
  return out;
}

// —— 缓存冷轮探针（诊断用：只读请求 + 追加写 data/cache-diag.log，绝不改请求行为）——
//   触发：单轮 miss > 50000 且 hit 率 < 0.5。用于定位"整段 24 万 token 全 miss"的真因：
//   ① sysChanged=true → 稳定前缀（system/技能/harness）变了；② toolsHash 变 → 工具定义变了；
//   ③ 内容逐条 hash 全同（firstDiffIndex 无差异）→ 请求未变，miss 系平台侧缓存过期/逐出（TTL）。
const CACHE_DIAG_MISS_MIN = 50000;
const CACHE_DIAG_HITRATE_MAX = 0.5;
const _cacheDiagPrev = new Map();   // sid → 上一轮请求指纹
/** 稳定短指纹：djb2 hex + 长度（脱敏，不含原文）。 */
function cacheDiagHash(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v == null ? '' : v);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16) + ':' + s.length;
}
/** 逐条消息指纹（role+content+tool_call_id+tool_calls）。 */
function cacheDiagMsgHash(m) {
  if (!m) return '-';
  const tc = m.tool_calls
    ? m.tool_calls.map((t) => (t && t.function ? (t.id + '|' + t.function.name + '|' + t.function.arguments) : '')).join('~')
    : '';
  const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content);
  return cacheDiagHash(String(m.role || '') + '\u0001' + c + '\u0001' + (m.tool_call_id || '') + '\u0001' + tc);
}
function cacheDiagSnippet(m) {
  try { const c = m && m.content; const s = typeof c === 'string' ? c : JSON.stringify(c == null ? '' : c); return String(s).slice(0, 200); } catch { return ''; }
}
function cacheDiagProbe(s, wire, usage, iter, params) {
  if (!s || !usage) return;
  const pt = Number(usage.promptTokens || 0), hit = Number(usage.hitTokens || 0), miss = Number(usage.missTokens || 0);
  const sys = (wire && wire[0]) || {};
  const msgHashes = (wire || []).map(cacheDiagMsgHash);
  const cur = { at: Date.now(), promptTokens: pt, hit, miss, sysHash: cacheDiagHash(sys.content || ''), nMsgs: msgHashes.length, msgHashes };
  const prev = _cacheDiagPrev.get(s.id) || null;
  _cacheDiagPrev.set(s.id, cur);
  const rate = pt ? hit / pt : 0;
  if (!(miss > CACHE_DIAG_MISS_MIN && rate < CACHE_DIAG_HITRATE_MAX)) return;   // 正常轮直接返回
  let firstDiffIndex = -1;
  if (prev) {
    const n = Math.min(prev.msgHashes.length, cur.msgHashes.length);
    for (let i = 0; i < n; i++) if (prev.msgHashes[i] !== cur.msgHashes[i]) { firstDiffIndex = i; break; }
    if (firstDiffIndex < 0 && cur.msgHashes.length !== prev.msgHashes.length) firstDiffIndex = n;
  }
  let toolsHash = null, toolsLen = 0;
  try { const td = tools.definitions(); toolsHash = cacheDiagHash(JSON.stringify(td)); toolsLen = td.length; } catch { }
  const rec = {
    t: new Date().toISOString(), sid: s.id, kind: 'turn', iter,
    promptTokens: pt, hit, miss, hitRate: Number(rate.toFixed(4)),
    sysLen: String(sys.content || '').length, sysHash: cur.sysHash,
    toolsLen, toolsHash, nMsgs: cur.nMsgs,
    params: params ? { model: params.model, temperature: params.temperature, reasoningEffort: params.reasoningEffort, maxTokens: params.maxTokens } : null,
    prev: prev ? { promptTokens: prev.promptTokens, hit: prev.hit, miss: prev.miss, sysHash: prev.sysHash, nMsgs: prev.nMsgs, ageMs: Date.now() - prev.at } : null,
    sysChanged: prev ? prev.sysHash !== cur.sysHash : null,
    firstDiffIndex,
    firstDiffSnippet: firstDiffIndex >= 0 ? cacheDiagSnippet(wire[firstDiffIndex]) : '(prefix identical)',
    msgHashes: cur.msgHashes,
  };
  try { fs.appendFileSync(path.join(DATA_DIR, 'cache-diag.log'), JSON.stringify(rec) + '\n'); } catch { }
}

// —— 巨文工具结果瘦身 ——
// 全量工具结果留活跃上下文会让单轮增长 5-8 万 token（4 万字符 ≈1.6 万 token/条），
// 预算几轮就撞线；且深收纳"最近 8 轮"窗口里全是巨文时会把归档后 floor 顶到触发线
//（就是此前"每轮归档一次"的根因之一）。
// 策略：超过 TOOL_INLINE_MAX 的结果，活跃上下文只留头尾，全文**立即**写入本会话归档
//（recall_context 可随时调回，不丢一字节）；瘦身消息打 _toolTrimmed 标记，
// 后续深收纳/滚动压缩切段时跳过重复归档（全文副本在创建时刻已在归档中、时序正确）。
const TOOL_INLINE_MAX = 16000;   // [已废弃·保留兜底] 现由 config.toolInlineMaxChars 覆盖（缺省 3000）
const TOOL_TRIM_NOTE = (n) => `\n…[中段 ${n} 字符已入归档，需全文时 recall_context 调回]…\n`;

/** 单条工具结果内联上限（字符）：读 config.toolInlineMaxChars，缺省 3000；非法/过小回退默认。 */
function toolInlineMax() {
  try {
    const v = Number(loadConfig().toolInlineMaxChars);
    if (Number.isFinite(v) && v >= 200) return Math.floor(v);
  } catch { }
  return 3000;
}

function slimToolResult(s, toolCallId, content2) {
  const LIMIT = toolInlineMax();
  const txt = String(content2 == null ? '' : content2);
  if (txt.length <= LIMIT) return { content: txt, trimmed: false };
  const half = Math.floor(LIMIT / 2);
  const head = txt.slice(0, half);
  const tail = txt.slice(-half);
  try {
    if (s && s.id) memory.archiveSave(s.id, [{ role: 'tool', toolCallId, content: txt, _full: true }]);
  } catch (e) {
    console.log(`[WARN] 巨文工具结果归档失败，全文仅保留头尾 ${LIMIT} 字符窗口: ${e.message}`);
  }
  return { content: head + TOOL_TRIM_NOTE(txt.length - LIMIT) + tail, trimmed: true };
}

/** 工具结果老化（项2）：窗口逼近预算时，把"最近 keepK 条"之外的旧工具结果替换为 stub。
 *  - 幂等：已老化（_toolAged）不再处理；
 *  - 保全文：未瘦身过的先 memory.archiveSave 一次（recall_context 可调回）；
 *  - 保 wire 配对：**只改 content，toolCallId 原样不动**（防 API 400）；
 *  - 一次调用批量做完（避免反复改历史 → 缓存抖动）。
 *  开关 config.toolResultAge=false → 直接返回，行为与旧版完全一致（可一键回滚）。 */
function ageToolResults(s, usedTokens, eb) {
  const before = Number(usedTokens || 0);
  try {
    const cfg = loadConfig();
    if (cfg.toolResultAge === false) return { aged: 0, before, after: before };
    const keepK = Number.isFinite(Number(cfg.toolResultKeepK)) ? Math.max(1, Math.floor(Number(cfg.toolResultKeepK))) : 10;
    const pct = Number.isFinite(Number(cfg.toolAgeThresholdPct)) ? Number(cfg.toolAgeThresholdPct) : 60;
    if (!(eb > 0) || !(before > eb * pct / 100)) return { aged: 0, before, after: before };
    const toolMsgs = s.messages.filter((m) => m && m.role === 'tool');
    if (toolMsgs.length <= keepK) return { aged: 0, before, after: before };
    let aged = 0;
    for (const m of toolMsgs.slice(0, toolMsgs.length - keepK)) {
      if (m._toolAged) continue;
      const txt = String(m.content == null ? '' : m.content);
      // 修2：小结果不老化——stub 本身约 30 字符 + 200 字符预览，比 <400 字符的原文还长，老化反增体积。
      if (txt.length < 400) { m._toolAged = true; continue; }
      // 修1：归档失败不得替换——否则 stub 谎称"全文见归档"而实际召回不到。失败则跳过该条、保原文。
      let archived = true;
      if (!m._toolTrimmed) {
        try { memory.archiveSave(s.id, [{ role: 'tool', toolCallId: m.toolCallId, content: txt, _full: true }]); }
        catch (err) { archived = false; console.error('[工具结果老化] 归档失败，跳过该条', err && err.message); }
      }
      if (!archived) { m._toolAged = true; continue; }   // 标已处理避免每轮重扫；但不动 content
      m.content = '[工具结果已老化·全文见归档，可用 recall_context 调回]\n' + txt.slice(0, 200);
      m._toolAged = true;   // 幂等标记（保留 toolCallId，不动 wire 配对）
      aged++;
    }
    if (!aged) return { aged: 0, before, after: before };
    let after = 0;
    for (const m of s.messages) after += estimateTokens(m);
    console.log(`[工具结果老化] 老化 ${aged} 条，窗口 usedTokens 前=${before} 后≈${after}`);
    return { aged, before, after };
  } catch (e) {
    console.error('[工具结果老化] 失败:', e.message);
    return { aged: 0, before, after: before };
  }
}

/** E⁺（批2·P1）：历史回合"写完类工具"调用参数精简。
 *  - 把 write_file/save_skill/edit_file 的 arguments.content/code 截为占位符
 *    「[全文已写入 <path>，需查看用 read_file]」，**保留 id / name / path**（其余参数原样）。
 *  - **只处理历史回合**：最后一条 user 消息（含）之后的消息=当前回合，一律不动。
 *  - 批处理 + 阈值触发：仅当 usedTokens > 预算 × cfg.toolArgsAgeThreshold(默认 0.75) 才触发一次
 *    （遵"改历史=击穿缓存"纪律，避免反复抖动）。
 *  - 幂等标记 _argsAged 写在 toolCall 对象上 → 随会话 JSON 落盘（重启后不重复处理、不漏处理）。
 *  - 开关 cfg.toolArgsAge=false → 直接返回，行为与旧版完全一致（可一键回滚）。 */
const WRITE_TOOLS = new Set(['write_file', 'save_skill', 'edit_file']);
function ageToolCallArgs(s, usedTokens, eb) {
  const before = Number(usedTokens || 0);
  const zero = { aged: 0, before, charsBefore: 0, charsAfter: 0 };
  try {
    const cfg = loadConfig();
    if (cfg.toolArgsAge === false) return zero;
    const thr = Number.isFinite(Number(cfg.toolArgsAgeThreshold)) ? Number(cfg.toolArgsAgeThreshold) : 0.75;
    if (!(eb > 0) || !(before > eb * thr)) return zero;
    const msgs = (s && s.messages) || [];
    // 当前回合起点：最后一条 user 消息之后的消息不动
    let lastUser = -1;
    for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i] && msgs[i].role === 'user') { lastUser = i; break; } }
    const end = lastUser < 0 ? msgs.length : lastUser;   // 只扫 [0, end)
    let aged = 0, charsBefore = 0, charsAfter = 0;
    for (let i = 0; i < end; i++) {
      const m = msgs[i];
      if (!m || m.role !== 'assistant' || !Array.isArray(m.toolCalls) || !m.toolCalls.length) continue;
      for (const tc of m.toolCalls) {
        const fn = tc && tc.function;
        if (!fn || !WRITE_TOOLS.has(fn.name)) continue;
        if (tc._argsAged) continue;              // 幂等：已处理过不再动
        let parsed;
        try { parsed = JSON.parse(String(fn.arguments == null ? '{}' : fn.arguments)); }
        catch { tc._argsAged = true; continue; }  // 解析失败：标已处理、保原样（不阻断）
        if (!parsed || typeof parsed !== 'object') { tc._argsAged = true; continue; }
        const pathVal = String(parsed.path || parsed.name || '');
        let changed = false;
        for (const key of ['content', 'code']) {
          const v = parsed[key];
          if (typeof v === 'string' && v.length > 0) {
            charsBefore += v.length;
            parsed[key] = `[全文已写入 ${pathVal}，需查看用 read_file]`;
            charsAfter += parsed[key].length;
            changed = true;
          }
        }
        if (changed) {
          try { fn.arguments = JSON.stringify(parsed); } catch { /* 保原样 */ }
          aged++;
        }
        tc._argsAged = true;   // 幂等标记（随会话 JSON 落盘）
      }
    }
    if (!aged) return zero;
    console.log(`[工具参数老化] 老化 ${aged} 个写完类工具参数，字符 ${charsBefore}→${charsAfter}`);
    return { aged, before, charsBefore, charsAfter };
  } catch (e) {
    console.error('[工具参数老化] 失败:', e.message);
    return zero;
  }
}

/** 切段归档：跳过已瘦身的工具消息（全文副本在创建时刻已入归档），避免重复条目与召回噪音。
 * @param {number} gen 世代号（缺省用当前世代——滚动压缩场景；深收纳换代时显式传新世代）。 */
function archiveCut(s, msgs, gen) {
  if (!s || !s.id || !msgs || !msgs.length) return;
  const toArch = msgs.filter((m) => !m._toolTrimmed && !m._toolAged);
  if (toArch.length) memory.archiveSave(s.id, toArch, { kind: 'flow', ...(gen !== undefined ? { gen } : {}) });
}

// —— v3 说明：滚动压缩（compactIfNeeded）已整体移除 ——
// 它原本在"没有归档/召回的年代"删除旧内容并留滚动摘要；世代交接 v3 下其职责
// 全部由"巨文瘦身（增长控制）+ 全量交接（窗口收拢）+ 归档召回（内容保全）"承担，
// 且每轮工具后的小切会反复使 ~13 万 token 前缀缓存失效（实测一回合 10 次抖动 ≈¥1.9）。
// 保留 summarizeSegment / summarizeCut 仅作为历史工具供旧测试脚本引用。


/** 对被压缩的旧回合做一次轻量总结（小调用，temperature=0）。失败则回退为保留首个 user 的原始目标，绝不中断。
 *  @param {object} [s] 发起会话（用于把后台调用 usage 计入成本；可缺省=只不计数） */
async function summarizeSegment(msgs, s) {
  try {
    const sys = systemPrompt().full;
    const gloss = msgs
      .map((m) => m.role === 'tool'
        // 工具结果常是 JSON/日志大块：只取首行 ≤120 字（否则摘要 gloss 被乱码大块污染 → 空回/劣质摘要）
        ? `工具: ${String(m.content || '').split('\n')[0].slice(0, 120)}`
        : `${m.role === 'user' ? '用户' : '助手'}: ${String(m.content || '').slice(0, 300)}`)
      .join('\n').slice(0, 6000);
    const _st0 = Date.now();
    const r = await chatOnce([
      { role: 'system', content: sys },
      { role: 'user', content: `【上下文压缩】以下是随对话推进已被移出主上下文的旧回合，请提炼成**可复用的关键信息摘要**（≤200字）。\n\n必须包含（如存在）：\n- 原始目标 / 最终结论\n- 已确认的决定（含用户明确的定性/规则）\n- 关键事实 / 数据 / 数值\n\n严格禁止（不要写）：\n- 过程流水（"正在读""下一步""尚未""待确认""当前状态：进行中"这类）\n- 单次工具调用的中间结果\n- 未完成的猜测\n\n只输出摘要正文，无前缀无解释。写成一段连贯的、下次能直接参考的结论，而非碎片记录。\n\n${gloss}` },
    ], { maxTokens: 640, temperature: 0, thinking: { type: 'disabled' }, kind: 'summarize' });
    try { creditUsage(s, r.usage, 'summarize', _st0); } catch { }   // 后台摘要计入发起会话/全局（第5项）
    const t = (r.text || '').trim().replace(/\r?\n+/g, ' ');
    return t.slice(0, 600) || '（未产生摘要）';
  } catch {
    const firstUser = msgs.find((m) => m.role === 'user');
    return firstUser
      ? `（摘要生成失败，仅保留原始目标）${String(firstUser.content || '').slice(0, 300)}`
      : '（摘要生成失败）';
  }
}

/** 深收纳（主人策略：触发归档时只保留最近一次完整回合，其余全量归档 + 分段交接摘要）。
 * 每次归档后活跃上下文 ≈ 交接摘要 + 最近一轮（几千 token），**增长空间 ≈ 整个预算**——
 * 归档频率 = 预算/每轮增长（≈10-30 轮一次），连续开发不再反复收拢；窗口也最干净。
 * 交接摘要**分段覆盖全部被压内容**（每段一次小调用，≤12 段），防跨度大时摘要过粗变笨；
 * 阈值不变（0.9× 预算触发）；被压部分全文进归档（recall_context 可随时召回），
 * 规则/决定按双保险早已在记忆与进度文件。返回 {dropped, kept}，dropped=0 表示无需归档。
 * **两段式**：deepArchiveNow 瞬时完成（切分+归档+占位+通知 → 客户端**立即**重建窗口，
 * 不再"回答完成后几秒才刷新"）；deepFillSummary 后台补分段交接摘要（完成后原位更新顶部摘要气泡）。 */
async function deepCompact(s) {
  const step1 = await deepArchiveNow(s);
  if (!step1 || !step1.dropped) return step1 || { dropped: 0, kept: (s.messages || []).length };
  await deepFillSummary(s, step1.cut, step1.gen, step1.dropped);   // 测试/同步路径：两步一次完成
  return step1;
}

/** 深收纳·瞬时步骤（v3 全量重置）：切分 + 全量归档 + **同步骨架交接文档** + lastCompact（无慢操作）。
 * 【世代交接 v3】任何回合起始时窗口已超预算 → 先交接再回答：
 * 全部旧消息入归档（不保留上一轮——本轮内容已进骨架文档与归档，连续性与召回由它们承担），
 * 窗口重建为 [骨架交接文档]（<100ms 本地拼装：进度文件尾部 + 本代未完成 + 归档索引）；
 * AI 增量提炼在后台 deepFillSummary 完成（非关键路径，完成后原位更新文档气泡）。
 * 触发线 = 预算本身（1.0×）；每代一次换代（gen = archiveStore.nextGen，持久化）。
 * @param {object} s 会话对象
 * @param {object} opts { keepLastRound } 溢出兜底路径保留最后 1 个完整 user 回合（正常不可达）
 */
/** 清洗孤儿 tool 消息：role=tool 但找不到配对 assistant(tool_calls) 的直接丢弃。
 *  防止交接切片把 assistant 的 tool_calls 归档掉、却留下其 tool 回复 →
 *  活跃上下文出现"孤儿 tool"，DeepSeek 返 HTTP 400 'tool must be response to tool_calls' 导致对话无响应。
 *  返回被移除的孤儿数（内容已在归档/记忆，不丢信息，纯防御性兜底）。 */
function sanitizeOrphanTools(msgs) {
  if (!msgs || !msgs.length) return 0;
  const open = new Set();   // 待回填的 toolCallId（来自 assistant.toolCalls）
  let removed = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant') {
      for (const tc of (m.toolCalls || [])) if (tc && tc.id) open.add(tc.id);
    } else if (m.role === 'tool') {
      if (m.toolCallId && open.has(m.toolCallId)) open.delete(m.toolCallId);
      else { msgs.splice(i, 1); i--; removed++; }   // 孤儿：无配对 assistant，删除
    }
  }
  return removed;
}

/** 回扫 messages 末尾，判断某 toolCallId 是否有配对 assistant(toolCalls)（同一紧邻组内）。
 *  用途：force_handoff 在工具执行中途重建窗口（keep=[]），会把"本次调用的 assistant(toolCalls)"一并归档；
 *  工具返回后若仍 push 为 role:'tool'，其配对 assistant 已不在 messages → 孤儿 tool → DeepSeek HTTP 400。
 *  回扫跳过 tool（同一轮多个 tool 结果）；遇到 user / 无该 id 的 assistant 即判定无配对。 */
function hasPairedToolCall(msgs, id) {
  if (!msgs || !msgs.length || id == null) return false;
  const target = String(id);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'tool') continue;              // 同一轮其它 tool 结果，跳过
    if (m.role === 'assistant') return (m.toolCalls || []).some((t) => t && String(t.id) === target);
    return false;                                  // user / 其它 → 无配对
  }
  return false;
}

/** 进度文件 PREFIX 区块是否含"未完成"前缀操作条目（- [ ]）；用于交接后接续指令分场景。 */
function progressHasPrefix(s) {
  try {
    const pf = path.join(projectDir(s.id), '_progress.md');
    if (!fs.existsSync(pf)) return false;
    const t = fs.readFileSync(pf, 'utf8');
    const m = t.match(/<!--\s*PREFIX:BEGIN\s*-->([\s\S]*?)<!--\s*PREFIX:END\s*-->/);
    return !!(m && /^\s*-\s*\[\s*\]/m.test(m[1]));   // 存在未完成（- [ ]）条目即视为有待补
  } catch { return false; }
}

/** 待补前缀强制兜底·纯判据（导出供离线单测）：
 *  入参 fb=s._pfxFallback、pend=当前未完成待补前缀数组、stopped=本轮是否被停。
 *  返回 {fire,disarm}：fire=true→调用方注入强制 user 消息并 continue（此处已把 fb.used 置真）；
 *  disarm=true→待补已清空，解除装填。每代最多 fire 一次（靠 fb.used 标记，杜绝死循环）。 */
function pfxFallbackDecision(fb, pend, stopped) {
  if (!fb || !fb.armed || fb.used || stopped) return { fire: false, disarm: false };
  if (Array.isArray(pend) && pend.length > 0) { fb.used = true; return { fire: true, disarm: false }; }
  return { fire: false, disarm: true };
}

function pfxIntentEnabled() {
  // Y-step2（2026-10-02）：读路径开关。pfxQueue.pfxIntentEnabled===false → 回退旧支干/账本读路径。
  try { const c = loadConfig(); return !(c && c.pfxQueue && c.pfxQueue.pfxIntentEnabled === false); } catch { return true; }
}
function _legacyListPendingPrefix(s) {
  // 旧读路径（支干 fold.pendingPfx → _progress.md PREFIX 区块）：只读兼容，保留不动。
  try {
    if (branch && typeof branch.fold === 'function') {
      const f = branch.fold(s.id);
      if (f && Array.isArray(f.pendingPfx)) {
        return f.pendingPfx.map((x) => String(x).replace(/^\s*[-*]\s*\[ \]\s*/, '').trim()).filter(Boolean);
      }
    }
  } catch { }
  try {
    const pf = path.join(projectDir(s.id), '_progress.md');
    if (!fs.existsSync(pf)) return [];
    const t = fs.readFileSync(pf, 'utf8');
    const m = t.match(/<!--\s*PREFIX:BEGIN\s*-->([\s\S]*?)<!--\s*PREFIX:END\s*-->/);
    if (!m) return [];
    return m[1].split('\n')
      .filter((l) => /^\s*[-*]\s*\[ \]/.test(l))
      .map((l) => l.replace(/^\s*[-*]\s*\[ \]\s*/, '').trim())
      .filter(Boolean);
  } catch { return []; }
}
function listPendingPrefixAll() {
  // Y-step2rename（2026-10-02）：**实例级**待补前缀（全实例合计；仅 intent 表有意义）。
  //   开关关闭 → 实例级无旧路径等价物，返回 []（会话级请用 listPendingPrefixForSession）。
  if (!pfxIntentEnabled()) return [];
  try { const rows = require('./pfxqueue').listIntents({ status: 'pending' }); if (Array.isArray(rows)) return rows.map((r) => r.text); } catch { }
  return [];
}
function listPendingPrefixForSession(s) {
  // Y-step2（2026-10-02）：**仅本会话**意图（兜底判定/交接提示/对比/窗口提示等“本会话”语义调用方用），避免他会话积压误触发本会话（task 第③条）。
  if (pfxIntentEnabled()) {
    try {
      const sid = String((s && s.id) || '');
      const rows = require('./pfxqueue').listIntents({ status: 'pending', sessionId: sid });
      if (Array.isArray(rows)) return rows.map((r) => r.text);
    } catch { }
  }
  return _legacyListPendingPrefix(s);
}

/** 本轮触发来源 → 人类可读标注（任务② T-C）。仅用于交接提示的来源行；非分支。 */
function originLabel(o) {
  return ({ user: '用户消息', mailbox: '派单回执', heartbeat: '心跳', timer: '定时', resume: '续跑', handoff: '主动交接' })[o] || '用户消息';
}

/** 交接判据单一来源（任务② T-A）：窗口是否已超预算。
 *  判据与旧入口逻辑完全一致（不新增倍数门槛）：_lastPromptTokens（API 真实值）优先，缺失回退估算；total > 预算 即需交接。
 *  入口 / do 循环内每轮起始 / 溢出路 三处共用，消除三处判据不一致。 */
function shouldHandoff(s) {
  try {
    const eb = effectiveBudget(s);
    let total = Number((s && s._lastPromptTokens) || 0);
    if (!(total > 0)) {
      total = 0;
      for (const m of ((s && s.messages) || [])) total += estimateTokens(m);
    }
    return { yes: total > eb, total, eb };
  } catch { return { yes: false, total: 0, eb: 0 }; }
}

/** 生成交接后"强制前置任务"提示（仅交接 + 有未完成前缀项时用）：
 *  B4 口径统一：不再内联前缀清单全文，只给一句引导（清单改由 首动作 project action=tree 取回）。 */
function pendingPrefixNotice(s, gen, origin) {
  const head = `\n\n【本代已自动交接】旧内容已全量归档（第 ${gen} 代，细节用 recall_context 召回）。\n[本轮触发：${originLabel(origin)}]\n`;
  const items = listPendingPrefixForSession(s);
  if (!items.length) {
    return head + `**⚠️ 检测到【待补前缀操作】（见文档『⚡待补前缀操作』区块）：请在当前最小窗口一次性完成全部前缀操作（propose_evolution / save_skill / 改 prompts / reload 等），完成后在进度文件 PREFIX 区块标记为已完成（改为 - [x]），再继续。**`;
  }
  return head + `⛔【强制前置任务】检测到 ${items.length} 项未完成【待补前缀操作】；请第一个动作执行 \`project action=tree\`（本会话）查看【待补前缀】区，**在做任何其它工具前先逐项执行前缀操作**（逐项完成），完成后补写 prefix-done 勾销。`;
}

function deepArchiveNow(s, opts = {}) {
  const msgs = (s && s.messages) || [];
  // P2b-16（性能）：listPendingPrefixForSession 内含 branch.fold 全扫事件（实测 ~28ms/次），原函数内被调 5 处。
  //   改为**懒求值 + 记忆化**：一次交接内至多算 1 次（早退路径也只算其实际需要的那 1 次）。
  let _pfxLen = null;
  const pfxLen = () => {
    if (_pfxLen === null) { try { _pfxLen = listPendingPrefixForSession(s).length; } catch { _pfxLen = 0; } }
    return _pfxLen;
  };
  if (!msgs.length) return { dropped: 0, kept: 0, hasPrefix: pfxLen() > 0 };
  const eb = effectiveBudget(s);
  // 溢出兜底路径跳过预算门（真实溢出时估算可能未越线）；常规路径触发线 = 预算
  // force=true（主动提前交接）：无条件跳过预算门，不等预算满立即归档重建窗口
  if (!(opts && opts.keepLastRound) && !(opts && opts.force)) {
    // 与 runChat 外门（L804-808）统一指标：优先 API 回传真实 prompt_tokens，重启/刚交接后无值才回退估算
    let total = Number((s && s._lastPromptTokens) || 0);
    if (!(total > 0)) {
      total = 0;
      for (const m of msgs) total += estimateTokens(m);
    }
    if (total <= eb) return { dropped: 0, kept: msgs.length, hasPrefix: pfxLen() > 0 };   // 未超预算：不交接
  }
  let keepFrom = msgs.length;   // 全量重置：归档全部（窗口只留文档）
  if (opts && opts.keepLastRound) {
    // 溢出兜底：保留最后 1 个完整 user 回合（wire 配对；其之前全部归档）
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { keepFrom = i; break; }
    }
    if (keepFrom <= 0) return { dropped: 0, kept: msgs.length, hasPrefix: pfxLen() > 0 };   // 不足 1 个完整回合：不归档
  }
  const cut = msgs.slice(0, keepFrom);
  const keep = msgs.slice(keepFrom);
  // 世代号：每次深收纳换代 +1（持久化于归档 meta；本代归档内容与交接文档共享此世代号）
  let gen = 0;
  try { gen = archiveStore.nextGen(s.id); } catch { }
  try { archiveCut(s, cut, gen); } catch { }
  // 骨架文档（同步、纯本地、零 AI——文档"不会生成失败"；失败时降级占位）
  let doc = `[上下文摘要] （交接文档生成中…）`;
  try {
    const useBranch = (() => { try { return loadConfig().branchHandoffPrimary === true; } catch { return false; } })();
    if (useBranch) {
      // B4 零文档丝滑：主路径不注入摘要正文，只给一句引导（任务现场改由 首动作 project action=tree 取回）
      doc = HANDOFF_BRANCH_GUIDE;
    } else {
      // 兜底路径行为完全不变（仍用同步骨架文档）；buildHandoffDocFromBranch 保留供测试/回退
      const d = buildHandoffDocSync(s, cut, gen);
      if (d && d.length) doc = `[上下文摘要] ${d}`;
    }
  } catch { }
  msgs.length = 0;
  msgs.push({ role: 'assistant', content: doc, _compaction: true });
  for (const m of keep) msgs.push(m);
  // 防孤儿 tool：交接切片可能把 tool_calls 归档掉却留下 tool 回复，这里统一清洗 keep 侧
  try { sanitizeOrphanTools(msgs); } catch (e) { console.log('[WARN] 清洗孤儿tool失败: ' + e.message); }
  s.compactions = (s.compactions || 0) + 1;
  try { s.lastCompact = { at: Date.now(), dropped: cut.length, kept: msgs.length }; } catch { }
  // 待补前缀强制兜底：交接时若存在未完成待补前缀 → 装填（本代最多兜底 1 次；回合收尾仍未清空则强制续跑）。
  try { s._pfxFallback = { armed: pfxLen() > 0, used: false }; } catch { }
  return { dropped: cut.length, kept: msgs.length, cut, gen, hasPrefix: pfxLen() > 0 };
}

/** 主动提前交接：无条件全量归档+重建窗口（跳过预算门，不等预算满）。
 *  供"急做击穿前缀操作"前主动收拢窗口到最小(≈3-8k token)，把缓存重建成本降到最低。
 *  force=true 全量重置（不留回合）；与 keepLastRound（溢出兜底留1回合）语义独立。 */
async function forceHandoff(s, opts = {}) {
  const r = deepArchiveNow(s, { force: true, keepLastRound: false });
  // 广播 compacted：主动交接同样要让客户端收拢窗口（与自动交接 notifyCompacted 一致）。
  // 否则客户端收不到窗口重建通知，界面停留在交接前的旧消息（雷影的诞生 第3代交接 bug 根因）。
  if (r && r.dropped > 0) {
    // 窗口已重建：真实 prompt_tokens 作废（与 runChat 自动交接路径一致，否则进度条/下一轮判定仍按旧值）
    s._lastPromptTokens = 0;
    // 任务② T-E：主动交接后注入轻提示（动作明确，无需重探索指令）。
    // 与自动交接路径对齐：存在未完成前缀项 → 注入 pendingPrefixNotice 强制清单（复用 listPendingPrefixForSession/pendingPrefixNotice）；
    // 无前缀项 → 保留原轻提示句。
    s._turnOrigin = 'handoff';
    try {
      const m0 = s.messages && s.messages[0];
      if (m0 && m0.role === 'assistant' && m0._compaction) {
        let hasPfx = false;
        try { hasPfx = listPendingPrefixForSession(s).length > 0; } catch { hasPfx = false; }
        m0.content += hasPfx
          ? pendingPrefixNotice(s, r.gen || 0, 'handoff')
          : `\n\n【已交接】请按当前任务继续。`;
      }
    } catch { }
    // 立即落盘：主动交接是"用户显式动作"，必须持久化，否则进程重启后交接丢失（磁盘仍是旧窗口）
    try { saveSession(s); } catch (e) { console.error('[handoff] 落盘失败:', e.message); }
    try {
      let total = 0; try { total = memory.archiveCount(s.id); } catch { }
      runtime.emit('compacted', { sessionId: s.id, dropped: r.dropped, kept: r.kept || s.messages.length, total, at: Date.now(), final: true, gen: r.gen || 0 });
    } catch (e) { /* 广播失败不阻塞交接 */ }
  }
  // T-A6（O-2）：refine=true 时后台补提炼，与自动交接路径一致
  // （生成"本代增量"、补全交接文档、落盘 _handoff.md、蒸馏记忆；不阻塞端点返回）。
  if (opts && opts.refine && r && r.dropped > 0) {
    setTimeout(() => { try { deepFillSummary(s, r.cut, r.gen, r.dropped); } catch (e) { console.error('[handoff] 后台提炼失败:', e.message); } }, 0);
  }
  return r;
}

/** 深收纳·后台步骤（v3）：生成"本代增量"并补全交接文档 → 原位更新顶部文档气泡 → 落盘 + 记忆蒸馏 + 通知。
 * 并发纪律：回合进行中不改 messages[0]（防前缀变化→缓存 miss），顺延到回合空闲后应用（最多等 1 分钟）。
 * 增量失败/超时：文档保持骨架+索引（接口功能完好，无单点失败）。 */
async function deepFillSummary(s, cut, gen = 0, dropped = 0) {
  try {
    const doc = await buildHandoffDoc(s, cut, gen);
    const title = (s.title || '会话').slice(0, 30);
    // B4b：与主路径口径一致——useBranch=true 时**不覆盖窗口顶部**（保留引导句），避免零文档被后台摘要填满
    const useBranch = (() => { try { return loadConfig().branchHandoffPrimary === true; } catch { return false; } })();
    const apply = () => {
      if (!useBranch && s.messages[0] && s.messages[0]._compaction) s.messages[0].content = `[上下文摘要] ${doc}`;
      try { saveSession(s); } catch { }
      let emitted = doc;
      if (useBranch) emitted = HANDOFF_BRANCH_GUIDE;   // 交接链路对齐：前端气泡 = 喂给模型的引导句（与 L809 同源常量），不再广播完整文档
      runtime.emit('compacted', { sessionId: s.id, final: true, summary: emitted, gen: gen || 0, dropped: dropped || 0 });
    };
    // 回合进行中：顺延（每 3s 检查一次，最多 20 次）
    if (s.running) {
      let tries = 0;
      await new Promise((resolve) => {
        const t = setInterval(() => {
          tries++;
          if (!s.running || tries >= 20) { clearInterval(t); resolve(); }
        }, 3000);
      });
    }
    apply();
    // 记忆蒸馏：写**全量**文档（不再截断 1200 字符——记忆索引即完整交接记录）
    distillSummary(s, title, doc.slice(0, 8000), gen || 0);
    // 交接文档落盘（当前代 = 覆盖写；历史各代在归档 doc 条目与记忆里可见）
    try {
      const pd = projectDir(s.id);
      fs.mkdirSync(pd, { recursive: true });
      fs.writeFileSync(path.join(pd, '_handoff.md'), `# 交接文档 · 第 ${gen} 代 · ${title}\n\n${doc}`, 'utf8');
    } catch { }
    // 文档本身入归档（kind=doc：永不参与裁剪；带世代号，可 recall_context 按词召回）
    try { memory.archiveSave(s.id, [{ role: 'assistant', content: doc, _full: true }], { kind: 'doc', gen }); } catch { }
  } catch (e) {
    console.log(`[WARN] 交接文档补全失败（保留骨架，可继续工作）: ${e.message}`);
  }
}

/** B4 零文档丝滑引导句（模块级常量，避免注入侧与后台 emit 侧两处字面量漂移）：交接时喂给模型=前端气泡=同一句。 */
const HANDOFF_BRANCH_GUIDE = '[上下文摘要] 本代已自动交接（窗口已重建）。请第一个动作执行 project action=tree（本会话）取回任务现场（目标/进度/待产出/在途派单/待办/待补前缀），不要重读大文件。';

/** 被压整段的分段交接摘要：每段 gloss ≈≤15k 字符（工具取首行），≤12 段，输出为分段清单。
 *  @param {object} [s] 发起会话（用于把后台调用 usage 计入成本；可缺省） */
async function summarizeCut(cutMsgs, s) {
  const segments = [];
  const SEG_GLOSS = 15000;
  let cur = [], curLen = 0;
  for (const m of cutMsgs) {
    const line = m.role === 'tool'
      ? `工具: ${String(m.content || '').split('\n')[0].slice(0, 120)}`
      : `${m.role === 'user' ? '用户' : '助手'}: ${String(m.content || '').slice(0, 300)}`;
    if (curLen + line.length > SEG_GLOSS && cur.length) { segments.push(cur); cur = []; curLen = 0; }
    cur.push(line); curLen += line.length;
  }
  if (cur.length) segments.push(cur);
  const sys = systemPrompt().full;
  const parts = [];
  const segN = segments.length;
  for (let i = 0; i < Math.min(segN, 12); i++) {
    const gloss = segments[i].join('\n').slice(0, 6000);
    try {
      const _hc0 = Date.now();
      const r = await chatOnce([
        { role: 'system', content: sys },
        { role: 'user', content: `【上下文压缩·交接摘要】以下是旧回合（第 ${i + 1}/${segN} 段）。提炼成一段衔接性摘要（≤200字），供重建窗口后继续工作。\n\n必须包含（如存在）：\n- 原始目标 / 当前进度\n- 已确认决定 / 用户明确要求\n- 关键事实 / 数据\n- 待办（未完成需继续的事项）\n\n禁止：过程流水、"正在读""下一步""尚未"等碎片、单次工具中间结果。无前缀，直接输出摘要正文。\n\n${gloss}` },
      ], { maxTokens: 640, temperature: 0, thinking: { type: 'disabled' }, kind: 'handoff-seg' });
      try { creditUsage(s, r.usage, 'handoff-seg', _hc0); } catch { }   // 后台交接摘要计入发起会话/全局（第5项）
      const t = (r.text || '').trim().replace(/\r?\n+/g, ' ');
      parts.push(t || `（第${i + 1}段摘要生成失败）`);
    } catch {
      parts.push(`（第${i + 1}段摘要生成失败）`);
    }
  }
  if (segN > 12) {
    const firstUser = cutMsgs.find((m) => m.role === 'user');
    parts.push(`（其余 ${segN - 12} 段：原始目标 ${firstUser ? String(firstUser.content || '').slice(0, 200) : ''}，全文见归档可召回）`);
  }
  return parts.join('\n');
}

// —— 世代交接 v3：结构化交接文档（骨架同步 + 增量后台；"地图+索引"，领土在归档） ——

/** 读取会话项目骨架：_progress.md（雷仔自写账本）取**尾部** ≤6000 字符——最新条目（本代进度/待办）优先，
 * 文档职责是"接续"而非"历史综述"（全量历史在归档与记忆，不再拼上一代 _handoff.md 全文 → 杜绝嵌套）。 */
/** 交接区块截断：**优先保留未完成项**（防未完成 `- [ ]` 因头部截断而消失）。
 *  规则：
 *   - 文本不超限 → 原样返回（零行为变化）；
 *   - 超限且**无**未完成项 → 保持原"头部截断"语义（不回归）；
 *   - 超限且**有**未完成项 → 未完成 `- [ ]` 行优先整行保留（必要时对单行限长），
 *     剩余额度再补已完成/其他行，确保未完成条目永不因截断而消失。
 *  仅影响交接文档的截断策略，不改 progressHasPrefix / 主流程 / 端点。 */
function truncKeepPending(block, max) {
  const text = String(block == null ? '' : block);
  const cap = Math.max(0, Number(max) || 0);
  if (text.length <= cap) return text;
  const lines = text.split('\n');
  const pending = [], done = [], other = [];
  for (const l of lines) {
    if (/^\s*[-*]\s*\[ \]/.test(l)) pending.push(l);
    else if (/^\s*[-*]\s*\[[xX]\]/.test(l)) done.push(l);
    else other.push(l);
  }
  if (!pending.length) return text.slice(0, cap);   // 无未完成项：原头部截断
  const out = []; let used = 0;
  const push = (l) => {
    let line = l;
    if (used + line.length + 1 > cap) {
      const room = cap - used - 1;
      if (room <= 0) return false;
      line = line.slice(0, room);   // 单条超长时限长，仍保证可见
    }
    out.push(line); used += line.length + 1; return true;
  };
  for (const l of pending) { if (!push(l)) break; }
  for (const l of done.concat(other)) { if (used + l.length + 1 > cap) break; push(l); }
  return out.join('\n');
}

/** 首部奠基 + 尾部最新 选取（与 truncKeyKeepRecent / fold 同口径，P2-prep3）。
 *  返回 arr 的「首 head 条」+「尾 (total-head) 条」，按值去重；arr.length ≤ total 时返回全部（勿重复）。
 *  用途：支干骨架 branchSkeletonText 的 DEC_K 截取——旧版直接 slice(-DEC_K) 丢掉首部奠基。 */
function pickHeadTail(arr, total = 12, head = 4) {
  const a = Array.isArray(arr) ? arr : [];
  const t = Math.max(1, Number(total) || 12);
  if (a.length <= t) return a.slice();
  const hk = Math.max(0, Math.min(Number(head) || 4, t - 1, a.length));
  const headArr = a.slice(0, hk);
  const tailArr = a.slice(-(t - hk));
  const seen = new Set(); const out = [];
  for (const x of headArr.concat(tailArr)) { const k = String(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}

/** 【KEY 区专用截断】📌常驻·关键决定区：条目格式为 `- [决定] …`（**非** `- [ ]`），
 *  故不能走 truncKeepPending（它只认 `- [ ]`/`- [x]`，会把 KEY 归入 other → 无 pending 时**从头截断**，
 *  导致「最新决定」被丢弃、只剩最旧十几条）。
 *  策略：**保留尾部最新条目** + **保留首部奠基条目**（默认 4 条，有界），中间以省略行占位；总长 ≤cap。
 *  **绝不从头截断**；文本不超限 → 原样返回（零行为变化）。仅 KEY 区使用，TODO/PREFIX 仍走 truncKeepPending。 */
function truncKeyKeepRecent(block, max, headKeep = 4) {
  const text = String(block == null ? '' : block);
  const cap = Math.max(0, Number(max) || 0);
  if (text.length <= cap) return text;                 // 未超限：零变化
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length <= 1) return text.slice(0, cap);
  const hk = Math.max(0, Math.min(Number(headKeep) || 4, lines.length - 1));
  const head = lines.slice(0, hk);
  const rest = lines.slice(hk);
  const marker = '…（中间条目已省略，全文见 _progress.md / 归档）…';
  // 首部预算：至多 35% cap，确保尾部最新条目始终有 >=65% 额度
  const headCap = Math.min(Math.floor(cap * 0.35), head.reduce((a, l) => a + l.length + 1, 0));
  const headOut = []; let used = 0;
  for (const l of head) {
    if (used + l.length + 1 > headCap) break;
    headOut.push(l); used += l.length + 1;
  }
  // 尾部：从最新往前收集（保证输出必含最新条目）
  const tailArr = []; let tUsed = 0;
  const tailCap = Math.max(0, cap - used - (marker.length + 1));
  for (let i = rest.length - 1; i >= 0; i--) {
    const l = rest[i];
    if (tUsed + l.length + 1 > tailCap) {
      const room = tailCap - tUsed - 1;
      if (room > 1 && tailArr.length === 0) {          // 单条超长：限长后仍保留（含最新）
        tailArr.unshift(l.slice(0, Math.max(0, room - 1)) + '…'); tUsed += room;
      }
      break;
    }
    tailArr.unshift(l); tUsed += l.length + 1;
  }
  const omitted = rest.length - tailArr.length;
  const parts = [...headOut];
  if (omitted > 0) parts.push(marker);
  parts.push(...tailArr);
  let s = parts.filter((x) => x !== '').join('\n');
  if (s.length > cap) s = s.slice(-cap);               // 极端兜底：**保尾部**（绝不从头截断）
  return s;
}

function handoffSkeleton(s, limit = 6000) {
  let key = '', prefix = '', todo = '', flow = '';
  try {
    const pf = path.join(projectDir(s.id), '_progress.md');
    if (fs.existsSync(pf)) {
      const t = fs.readFileSync(pf, 'utf8');
      const body = Math.max(500, Math.min(4000, limit));   // 骨架正文总预算（KEY+TODO+流水）
      // ① 常驻关键区块（<!--KEY:BEGIN-->…<!--KEY:END-->）：永远置顶，优先于流水（上限 2500）
      const km = t.match(/<!--\s*KEY:BEGIN\s*-->([\s\S]*?)<!--\s*KEY:END\s*-->/);
      if (km) key = truncKeyKeepRecent(km[1].trim(), Math.min(2500, body));
      // ② 待办区块（<!--TODO:BEGIN-->…<!--TODO:END-->）：随交带上，供 parseTodos 只读此区（上限 1000）
      const tm = t.match(/<!--\s*TODO:BEGIN\s*-->([\s\S]*?)<!--\s*TODO:END\s*-->/);
      if (tm) todo = truncKeepPending(tm[1].trim(), 1000);
      // ②.5 待补前缀操作区块（<!--PREFIX:BEGIN-->…<!--PREFIX:END-->）：置于 KEY 之后、TODO 之前（上限 600）
      const pm = t.match(/<!--\s*PREFIX:BEGIN\s*-->([\s\S]*?)<!--\s*PREFIX:END\s*-->/);
      if (pm) prefix = truncKeepPending(pm[1].trim(), 600);
      // ③ 流水尾部：从正文预算扣除常驻区/前缀区/待办区；无标记的旧文件走原"取尾部"逻辑
      const reserved = (key ? key.length + 40 : 0) + (prefix ? prefix.length + 40 : 0) + (todo ? todo.length + 40 : 0);
      const rest = Math.max(500, body - reserved);
      flow = t.length > rest ? `…[流水前段已略，全文见归档/项目目录]…\n` + t.slice(-rest) : t;
    }
  } catch { }
  const head = (key ? `📌【常驻·关键决定】\n${key}\n\n` : '')
    + (prefix ? `⚡【待补前缀操作】\n${prefix}\n\n` : '')
    + (todo ? `✅【待办·TODO】\n${todo}\n\n` : '');
  return ((head ? head + `📄【流水尾部】\n` : '') + flow).trim();
}

/** 取文本的"关键行"：首个非空行，压缩空白，≤200 字符（用于尾部参照段的动作结果）。 */
function tailKeyLine(text) {
  const lines = String(text || '').split('\n');
  for (const l of lines) { const t = l.trim(); if (t) return t.replace(/\s+/g, ' ').slice(0, 200); }
  return '';
}

/** 【尾部参照段】有界（≤1200 字符）·仅防最近细节失真：①最后一条 user 原文 ②最后一次动作关键行 ③一行未决动作。
 *  数据源用 `cut`（被归档的旧回合）——buildHandoffDocSync 在 deepFillSummary 阶段调用时 s.messages 已被清空，
 *  只有 cut 仍持有最后一条真实 user 消息与最后一次工具动作。 */
function buildTailReference(cut, skeleton, progressRaw) {
  const msgs = Array.isArray(cut) ? cut : [];
  // （a）最后一条 user 原文（超长则前200+末200，中略）
  let userExcerpt = '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === 'user') {
      let txt = String(msgs[i].content || '').trim();
      if (txt.length > 600) txt = txt.slice(0, 200) + '\n……（中略）……\n' + txt.slice(-200);
      userExcerpt = txt.slice(0, 700);
      break;
    }
  }
  // （b）最后一次 assistant 工具动作的"参数原文 + 结果关键行"
  let actionLine = '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      const tc = m.toolCalls[m.toolCalls.length - 1];
      const args = tc.arguments || {};
      let argLine = '';
      for (const k of ['command', 'path', 'file_path', 'filePath', 'url', 'pattern', 'query']) {
        if (args[k] !== undefined) { argLine = `${k}=${String(args[k])}`; break; }
      }
      if (!argLine) { try { argLine = JSON.stringify(args); } catch { argLine = ''; } }
      argLine = argLine.replace(/\s+/g, ' ').slice(0, 200);
      let resLine = '';
      for (let j = i + 1; j < msgs.length; j++) {
        if (msgs[j] && msgs[j].role === 'tool') { resLine = tailKeyLine(msgs[j].content); break; }
      }
      actionLine = `工具 ${tc.name}：${argLine}${resLine ? ' → ' + resLine : ''}`.slice(0, 350);
      break;
    }
  }
  // （c）一行未决动作（进度文件 todo 尾条；无则留空）
  let pending = '';
  try { const todos = parseTodos(progressRaw || skeleton); if (todos.length) pending = todos[todos.length - 1].slice(0, 120); } catch { }
  if (!userExcerpt && !actionLine && !pending) return '';
  const body = [
    `## 尾部参照段（非必读 · 仅防细节失真）`,
    `> 非必读：仅供核对最近细节，勿据此重复读取大文件；权威以 _progress.md 为准。`,
    `- 最后用户消息原文：${userExcerpt || '（无）'}`,
    `- 最后动作关键行：${actionLine || '（无）'}`,
    `- 未决动作：${pending || '（无）'}`,
  ].join('\n');
  return body.slice(0, 1200);
}

/** v6.7：读取某会话的 _progress.md 原文（供 parseTodos 走注释区块路径，条目最全；失败返回空串）。 */
function progressTextOf(s) {
  try {
    const pf = path.join(projectDir(s.id), '_progress.md');
    if (fs.existsSync(pf)) return fs.readFileSync(pf, 'utf8');
  } catch { }
  return '';
}

/** 从进度文件尾部解析"本代未完成"（约定标记：含 待办/未完成/todo 或 - [ ] 复选框），≤15 行。 */
function parseTodos(progressText) {
  // 只解析"待办区块"内的 "- [ ]" 复选框行。两条来源（v6.7 修复「本代未完成恒为空」）：
  //   ① 直接传原始 _progress.md → 注释区块 <!--TODO:BEGIN-->…<!--TODO:END-->；
  //   ② 传 handoffSkeleton() 的输出 → 分节式标题 `✅【待办·TODO】` 到下一个分区标题（📌【/⚡【/📄【）之间。
  //      （handoffSkeleton 拼 head 时把注释标记剥成标题式，且 todo 有 slice(0,1000) 截断会切掉 END 标记，
  //       故此处必须支持分节式，否则交接文档「本代未完成」恒为「（无）」。）
  // 旧版全文正则会把 KEY 常驻区/流水里出现的"待办/未完成/todo"字样误当本代未完成，故仍收敛为只认上述区块；无区块 → 不猜（返回空）。
  const text = String(progressText || '');
  let body = null;
  const m = text.match(/<!--\s*TODO:BEGIN\s*-->([\s\S]*?)<!--\s*TODO:END\s*-->/);
  if (m) body = m[1];
  else {
    const hm = text.match(/✅【待办·TODO】[^\n]*\n([\s\S]*?)(?=\n*(?:📌【|⚡【|📄【)|$)/);
    if (hm) body = hm[1];
  }
  if (body == null) return [];
  const out = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^[-*]\s*\[\s*\]/.test(t)) {   // 仅未勾选"- [ ]"（[x]已完成不算本代未完成）
      out.push(t.slice(0, 120));
      if (out.length >= 15) break;
    }
  }
  return out;
}

// ==================== v3.1 批1（P0）：归档主题地图 / 记忆增量 / 压缩摘要分代有界 ====================

/** 停用片/噪声词：工具名、通用动词、系统词（避免交接主题地图被工具日志词污染）。 */
const TOPIC_STOP = new Set([
  'read', 'file', 'write', 'edit', 'run', 'command', 'node', 'true', 'false', 'null', 'undefined',
  'read_file', 'write_file', 'edit_file', 'run_command', 'python_repl', 'save_memory', 'save_skill',
  'log_progress', 'search_files', 'list_dir', 'agent_send', 'agent_inbox', 'spawn_subagent',
  'utf', 'err', 'stdout', 'stderr', 'exit', 'http', 'https', 'html', 'json', 'jsonl', 'api', 'src', 'dist',
  'function', 'return', 'const', 'require', 'exports', 'module', 'test', 'ok', 'error', 'warn',
]);
const TOPIC_STOP_GRAMS = new Set([
  '的的', '了了', '是是', '我我', '你你', '他他', '在在', '和和', '与与', '就就', '都都', '也也', '不不',
  '有有', '这这', '那那', '一个个', '我们', '你们', '他们', '什么', '怎么', '可以', '如果', '因为', '所以',
  '但是', '而且', '已经', '还是', '就是', '不是', '没有', '一个', '这个', '那个', '一下', '现在', '然后',
  '问题', '情况', '内容', '东西', '时候', '需要', '进行', '通过', '使用', '结果', '输出', '执行', '文件', '工具',
]);

/** 本代归档主题地图（有界，纯本地零 AI）：只取 cut 里 user+assistant，bigram 频次 + 停用词过滤 + 位置权重。
 *  采样双上限（条数 ≤300 / 字符 ≤40000，超限降级"仅列高频片"）；输出 ≤cap 字符。 */
function archiveTopicMap(cut, cap = 1200) {
  try {
    const msgs = (Array.isArray(cut) ? cut : []).filter((m) => m && (m.role === 'user' || m.role === 'assistant'));
    if (!msgs.length) return '';
    const MSG_CAP = 300, CHAR_CAP = 40000;
    const picked = [];
    let chars = 0;
    for (let i = msgs.length - 1; i >= 0 && picked.length < MSG_CAP; i--) {
      const t = String(msgs[i].content || '').replace(/\s+/g, ' ');
      if (!t) continue;
      if (chars + t.length > CHAR_CAP && picked.length) break;
      picked.push({ role: msgs[i].role, t: t.slice(0, 3000) });
      chars += Math.min(t.length, 3000);
    }
    picked.reverse();
    // 归一：小写、去空白/标点；ASCII 字母数字替换为分隔符（主题词只取中文成词，英文另作高频词）
    const SEP = '\u0000';
    const cjk = (x) => x.toLowerCase().replace(/[\s\u3000]+/g, '').replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '').replace(/[a-z0-9]+/g, SEP);
    const freq = new Map();
    picked.forEach((x, idx) => {
      const w = (x.role === 'user' ? 1.5 : 1) * (1 + 0.2 * (idx / Math.max(1, picked.length - 1)));
      const t = cjk(x.t);
      for (let i = 0; i + 1 < t.length; i++) {
        const g = t.slice(i, i + 2);
        if (g.includes(SEP)) continue;
        if (TOPIC_STOP_GRAMS.has(g)) continue;
        freq.set(g, (freq.get(g) || 0) + w);
      }
    });
    // ASCII 词频（高频词用；滤工具/系统词）
    const ascii = new Map();
    for (const x of picked) {
      for (const tk of (x.t.toLowerCase().match(/[a-z0-9_]{3,}/g) || [])) {
        if (TOPIC_STOP.has(tk)) continue;
        if (/^\d+$/.test(tk)) continue;
        ascii.set(tk, (ascii.get(tk) || 0) + 1);
      }
    }
    if (!freq.size && !ascii.size) return '';
    const hot = new Set([...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 120).map((x) => x[0]));
    // 短语归并：扫描"每个 bigram 都热"的极长中文片段（4~8 字，遇分隔符断开）
    // 短语归并：先在"每个 bigram 都热"的极大中文片段内，统计长度 4~8 的**全部子片段**出现次数
    //（变体如「入站气泡孤儿根治」「入站气泡孤儿还有」→ 共同子片段「入站气泡孤儿」计数最高）
    const termCount = new Map();
    for (const x of picked) {
      const t = cjk(x.t);
      let i = 0;
      while (i + 1 < t.length) {
        if (t[i] === SEP || t[i + 1] === SEP) { i++; continue; }
        let j = i;
        while (j + 1 < t.length && t[j + 1] !== SEP && hot.has(t.slice(j, j + 2))) j++;
        const run = t.slice(i, Math.min(j + 2, i + 8));
        for (let a = 0; a < run.length; a++) {
          for (let l = 4; l <= 8 && a + l <= run.length; l++) {
            if (run.slice(a, a + l).includes(SEP)) continue;
            const k = run.slice(a, a + l);
            if (k.length >= 4) termCount.set(k, (termCount.get(k) || 0) + 1);
          }
        }
        i = Math.max(i + 1, i + run.length);
      }
    }
    const terms = [...termCount.entries()]
      .filter(([k, v]) => v >= 2)                       // 至少出现 2 次才称得上"主题"（其余进高频词兜底）
      .map(([k, v]) => ({ k, v, s: v * k.length * k.length }))
      .sort((a, b) => b.s - a.s || b.k.length - a.k.length);
    const topic = [];
    for (const { k } of terms) {
      if (topic.some((x) => x.includes(k) || k.includes(x))) continue;   // 互为子串 → 视为同一主题，保留得分更高者
      topic.push(k);
      if (topic.length >= 5) break;
    }
    const words = [...freq.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]).filter((g) => !TOPIC_STOP.has(g)).slice(0, 8);
    const asciiTop = [...ascii.entries()].sort((a, b) => b[1] - a[1]).filter(([, v]) => v >= 2).slice(0, 5).map((x) => x[0]);
    let out = topic.length ? `本代归档主题：${topic.join(' / ')}` : '本代归档主题：（文本不足，仅列高频词）';
    const hi = words.concat(asciiTop);
    if (hi.length) out += `；高频词：${hi.join('、')}`;
    return out.slice(0, cap);
  } catch { return ''; }
}

/** B 落点②（有界+幂等）：把本代主题写入 _progress.md「归档目录」区（滚动保留最近 K 代）。 */
function writeArchiveDir(s, gen, topicLine) {
  try {
    if (!topicLine) return;
    const pd = projectDir(s.id);
    fs.mkdirSync(pd, { recursive: true });
    const pf = path.join(pd, '_progress.md');
    let lines = fs.existsSync(pf) ? fs.readFileSync(pf, 'utf8').split('\n') : [`# 项目进度：${s.title || '新会话'}`, ''];
    const B = '<!--ARCHIVE:BEGIN-->', E = '<!--ARCHIVE:END-->';
    const RE_AB = /^<!--\s*ARCHIVE:BEGIN\s*-->$/, RE_AE = /^<!--\s*ARCHIVE:END\s*-->$/;
    // ① 幂等：移除**全部** ARCHIVE 块（历史上 indexOf 只取首个 → 残留块永不清理），内容合并去重后滚动保留最近 K 代
    let inner = [];
    {
      const out = []; let i = 0;
      while (i < lines.length) {
        if (RE_AB.test(lines[i].trim())) {
          let j = i + 1; while (j < lines.length && !RE_AE.test(lines[j].trim())) j++;
          inner.push(...lines.slice(i + 1, j).filter((x) => x.trim()));
          i = (j < lines.length) ? j + 1 : j;   // 精确按标记切片（无通配/递归删除）
        } else { out.push(lines[i]); i++; }
      }
      lines = out;
    }
    // ② KEY 块：只保留首个，删除其余（防重复块累积；容错 <!-- KEY:BEGIN --> 带空格变体）
    {
      const RE_KB = /^<!--\s*KEY:BEGIN\s*-->$/, RE_KE = /^<!--\s*KEY:END\s*-->$/;
      const out = []; let seen = false; let i = 0;
      while (i < lines.length) {
        if (RE_KB.test(lines[i].trim())) {
          let j = i + 1; while (j < lines.length && !RE_KE.test(lines[j].trim())) j++;
          if (!seen) { seen = true; out.push(...lines.slice(i, Math.min(j + 1, lines.length))); }
          i = (j < lines.length) ? j + 1 : j;
        } else { out.push(lines[i]); i++; }
      }
      lines = out;
    }
    inner = inner.filter((x) => !x.startsWith(`- 第${gen}代 · `) && x.trim() !== '## 归档目录');
    inner = [...new Set(inner)];   // 合并多块后按行去重（保序）
    inner.push(`- 第${gen}代 · ${topicLine}`);
    // 按代号升序排序后再取末 K（防乱序块"保留最近 K"丢最近代）
    const _g = (x) => { const m = /^- 第(\d+)代 · /.exec(x); return m ? Number(m[1]) : 0; };
    inner.sort((a, b) => _g(a) - _g(b));
    const K = Math.max(1, Number(loadConfig().handoffTopicKeepK) || 5);
    if (inner.length > K) inner = inner.slice(inner.length - K);
    let pos = 0;
    while (pos < lines.length && (lines[pos].trim() === '' || /^[#>]/.test(lines[pos].trim()))) pos++;
    for (const nm of ['KEY', 'PREFIX', 'TODO']) {
      const rb = new RegExp(`^<!--\\s*${nm}:BEGIN\\s*-->$`), re = new RegExp(`^<!--\\s*${nm}:END\\s*-->$`);
      const bs = lines.findIndex((x) => rb.test(x.trim())), be = lines.findIndex((x) => re.test(x.trim()));
      if (bs >= 0 && be > bs && be + 1 > pos) pos = be + 1;
    }
    lines = [...lines.slice(0, pos), B, '## 归档目录', ...inner, E, ...lines.slice(pos)];
    fs.writeFileSync(pf, lines.join('\n'), 'utf8');
  } catch { }
}

/** F2：本代新写/更新的记忆（按 mtime > sinceMs 过滤；取每个文件首行做一句话），有界 ≤cap 条。 */
function memIncrementLines(sinceMs, cap = 12) {
  try {
    const items = [];
    // ① 优先用新鲜缓存（无脏标记）——零额外 IO
    const cache = memory.SEARCH_CACHE && memory.SEARCH_CACHE.memory;
    const fresh = cache && !cache.dirty && cache.map && cache.map.size;
    if (fresh) {
      for (const [name, e] of cache.map) {
        if (!e || !(Number(e.mtime) > sinceMs)) continue;
        const first = String(e.clean || '').split('\n').map((x) => x.trim()).find((x) => x && !x.startsWith('#')) || '';
        items.push({ name, mtime: Number(e.mtime) || 0, line: first.slice(0, 80), file: null });
      }
    } else {
      // ② 缓存脏/缺失 → 直接扫盘（只 stat 不读，命中的 ≤cap 个才读）
      const dir = memory.MEM_DIR;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        let st; try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
        if (!(st.mtimeMs > sinceMs)) continue;
        items.push({ name: f.replace(/\.md$/, ''), mtime: st.mtimeMs, line: '', file: path.join(dir, f) });
      }
      items.sort((a, b) => b.mtime - a.mtime);
      for (const it of items.slice(0, cap)) {
        try {
          const raw = fs.readFileSync(it.file, 'utf8');
          const body = memory.stripMeta ? memory.stripMeta(raw).display : raw;
          it.line = String(body).split('\n').map((x) => x.trim()).find((x) => x && !x.startsWith('#')) || '';
        } catch { }
      }
    }
    items.sort((a, b) => b.mtime - a.mtime);
    return items.slice(0, cap).map((x) => `- ${x.name}：${String(x.line).slice(0, 80)}`);
  } catch { return []; }
}

/** F1：压缩摘要分代有界 —— 每会话仅保留最近 K 代独立记忆，更旧代合并进 `压缩摘要-<id>-archive`（有界）。 */
function compactSummaryGens(sid, keepK, archCap) {
  try {
    const K = Math.max(1, Number(keepK) || 5);
    const CAP = Math.max(2000, Number(archCap) || 200000);
    const esc = String(sid).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^压缩摘要-${esc}-gen(\\d+)$`);
    const mine = [];
    // 优先用内存缓存键（避免 memory.list 全库读盘）；缓存不可用再回退
    let names = [];
    try {
      const cache = memory.SEARCH_CACHE && memory.SEARCH_CACHE.memory;
      if (cache && cache.map && cache.map.size) names = [...cache.map.keys()];
    } catch { }
    if (!names.length) { try { names = memory.list('memory').map((it) => String((it && it.name) || it || '')); } catch { } }
    for (const nm of names) {
      const m = re.exec(nm);
      if (m) mine.push({ name: nm, gen: parseInt(m[1], 10) || 0 });
    }
    if (mine.length <= K) return;
    mine.sort((a, b) => b.gen - a.gen);
    const old = mine.slice(K);
    const archName = `压缩摘要-${sid}-archive`;
    let merged = '';
    for (const o of old.slice().reverse()) {
      try {
        const r = memory.read('memory', o.name);
        const txt = r && typeof r === 'object' ? String(r.content || '') : String(r || '');
        merged += `\n## gen${o.gen}\n${txt}\n`;
      } catch { }
    }
    if (merged) {
      // 有界①：本次待并入文本自身就超上限 → 只留尾部（最新部分）
      if (merged.length > CAP) merged = merged.slice(-Math.floor(CAP * 0.6));
      try {
        const af = memory.fileOf('memory', archName);
        if (fs.existsSync(af)) {
          const cur = fs.readFileSync(af, 'utf8');
          if (cur.length + merged.length > CAP) fs.writeFileSync(af, cur.slice(-Math.floor(CAP * 0.6)), 'utf8');
        }
      } catch { }
      memory.save('memory', archName, `[本会话历史压缩摘要合并（超出最近 ${K} 代的部分，有界）]\n${merged}`, {});
    }
    for (const o of old) { try { memory.erase('memory', o.name); } catch { } }
  } catch { }
}

/** 通用"分代有界记忆"合并：按前缀 <prefix>-<sid>-gen<N> 收集，仅保留最近 K 代，更旧代并入 <prefix>-<sid>-archive（有界）。
 *  D2 复用（不改动 F1 的 compactSummaryGens，保持既有行为零风险）。 */
function compactGensByPrefix(prefix, sid, keepK, archCap) {
  try {
    const K = Math.max(1, Number(keepK) || 3);
    const CAP = Math.max(2000, Number(archCap) || 200000);
    const esc = String(sid).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pfx = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${pfx}-${esc}-gen(\\d+)$`);
    const mine = [];
    let names = [];
    try {
      const cache = memory.SEARCH_CACHE && memory.SEARCH_CACHE.memory;
      if (cache && cache.map && cache.map.size) names = [...cache.map.keys()];
    } catch { }
    if (!names.length) { try { names = memory.list('memory').map((it) => String((it && it.name) || it || '')); } catch { } }
    for (const nm of names) { const m = re.exec(nm); if (m) mine.push({ name: nm, gen: parseInt(m[1], 10) || 0 }); }
    if (mine.length <= K) return;
    mine.sort((a, b) => b.gen - a.gen);
    const old = mine.slice(K);
    const archName = `${prefix}-${sid}-archive`;
    let merged = '';
    for (const o of old.slice().reverse()) {
      try {
        const r = memory.read('memory', o.name);
        const txt = r && typeof r === 'object' ? String(r.content || '') : String(r || '');
        merged += `\n## gen${o.gen}\n${txt}\n`;
      } catch { }
    }
    if (merged) {
      if (merged.length > CAP) merged = merged.slice(-Math.floor(CAP * 0.6));
      try {
        const af = memory.fileOf('memory', archName);
        if (fs.existsSync(af)) {
          const cur = fs.readFileSync(af, 'utf8');
          if (cur.length + merged.length > CAP) fs.writeFileSync(af, cur.slice(-Math.floor(CAP * 0.6)), 'utf8');
        }
      } catch { }
      memory.save('memory', archName, `[本会话历史归档纪要合并（超出最近 ${K} 代的部分，有界）]\n${merged}`, {});
    }
    for (const o of old) { try { memory.erase('memory', o.name); } catch { } }
  } catch { }
}

/** D2（批2·P2）：交接时回填"归档纪要-<会话id>-gen<N>"记忆（内容=该代归档主题地图 + 关键增量）。
 *  - 复用批1 B 层已算好的主题地图（topicLine，**不重算**）；滚动有界（K=3，更旧代并入 -archive）。
 *  - 幂等：同名记忆已存在 → 直接跳过（同一 gen 重复交接不重复追加）。
 *  - 写失败静默降级，**不阻断交接**（整体 try/catch）。
 *  - 开关 cfg.archiveMemoBackfill=false → 回退现状（不写记忆）。 */
function backfillArchiveMemo(s, sid, gen, topicLine, memInc) {
  try {
    const cfg = (() => { try { return loadConfig(); } catch { return {}; } })();
    if (cfg.archiveMemoBackfill === false) return;
    if (!sid || !gen) return;
    const parts = [];
    if (topicLine) parts.push(`**本代归档主题地图**：\n${String(topicLine).slice(0, 2000)}`);
    if (memInc) parts.push(String(memInc).replace(/^\n*## 本代记忆增量\s*/, '**本代记忆增量**：\n').slice(0, 2000));
    const body = parts.join('\n\n').slice(0, 4000);
    if (!body) return;
    const name = `归档纪要-${sid}-gen${gen}`;
    // 幂等：已存在同名记忆 → 跳过（同名 save 是"追加"，不检查会重复累积）
    try { const ex = memory.read('memory', name); if (ex) return; } catch { }
    const K = Math.max(1, Number(cfg.archiveMemoKeepK) || 3);
    const CAP = Math.max(2000, Number(cfg.archiveMemoCap) || 200000);
    memory.save('memory', name, `第 ${gen} 代归档回填（交接时自动生成）\n\n${body}`, {});
    compactGensByPrefix('归档纪要', sid, K, CAP);
  } catch { /* 静默降级：绝不阻断交接 */ }
}

/** 世界树·任务③：任务现场快照 + 未读信箱 + 在途派单（规则拼接、零 AI、失败静默降级）。 */
function buildTaskBlocks(s, goal, todos) {
  const blocks = [];
  const cutS = (v, n) => { const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
  const oneLine = (v, n) => cutS(v, n);
  const role = (() => { try { return selfRole(); } catch { return ''; } })();
  const mb = (() => { try { return require('./mailbox'); } catch { return null; } })();
  // —— 支干 fold（P0 数据源）——
  let f = { openTodos: [], pendingPfx: [], turns: [] };
  try { const r = branch.fold(s.id, 8); if (r) f = r; } catch { }
  // —— 在途派单（T-C）：派给本会话、未回执 ——
  let inflight = [];
  try { if (mb && mb.available && mb.available() && role) inflight = mb.listPendingForSession(role, s.id) || []; } catch { }
  // —— 未读信箱（T-B）：本会话未消费 ——
  let unread = [];
  try { if (mb && mb.available && mb.available() && role) unread = mb.fetchUnreadForSession(role, s.id, 20) || []; } catch { }

  // —— T-A 任务现场快照（字段固定 5 项；≤600 字符；"待产出/阻塞优先"截）——
  try {
    const todoT = (todos || []).map((t) => String(t).replace(/^[-*]?\s*\[\s*\]\s*/, '').trim()).filter(Boolean);
    const openT = (f.openTodos || []).map((t) => String(t).replace(/^[-*]?\s*\[\s*\]\s*/, '').trim()).filter(Boolean);
    const pfxT = (f.pendingPfx || []).map((t) => String(t).replace(/^[-*]?\s*\[\s*\]\s*/, '').trim()).filter(Boolean);
    const inFlightStr = inflight.length
      ? `${oneLine(inflight[0].from_id, 20)}: ${cutS(inflight[0].content, 60)}${inflight.length > 1 ? ` 等${inflight.length}条` : ''}`
      : '（无）';
    const lastTurn = (f.turns && f.turns.length) ? f.turns[f.turns.length - 1] : null;
    const progStr = lastTurn && lastTurn.summary
      ? (lastTurn.aborted ? `[中断] ${lastTurn.summary}` : lastTurn.summary)
      : (todoT.length ? `待办 ${todoT.length} 项` : '（无近轮记录）');
    const deliverList = [...todoT, ...[...openT, ...pfxT].filter((x) => !todoT.includes(x))];
    const deliverStr = deliverList.length ? deliverList.slice(0, 3).join('；') : '（无）';
    const goalStr = String(goal || '').trim() || '（无）';
    const blockStr = '（无）';
    const assemble = (caps) => [
      `- 目标: ${cutS(goalStr, caps.goal)}`,
      `- 进度: ${cutS(progStr, caps.prog)}`,
      `- 待产出: ${cutS(deliverStr, caps.deliver)}`,
      `- 在途派单: ${cutS(inFlightStr, caps.inflight)}`,
      `- 阻塞: ${cutS(blockStr, caps.block)}`,
    ].join('\n');
    const caps = { goal: 140, prog: 100, deliver: 160, inflight: 120, block: 60 };
    let body = assemble(caps);
    // 超 600：按"待产出/阻塞优先"——先压 目标→在途派单→进度，最后才动 待产出
    let guard = 0;
    while (body.length > 600 && guard++ < 12) {
      if (caps.goal > 24) caps.goal = Math.max(24, Math.floor(caps.goal * 0.6));
      else if (caps.inflight > 24) caps.inflight = Math.max(24, Math.floor(caps.inflight * 0.6));
      else if (caps.prog > 24) caps.prog = Math.max(24, Math.floor(caps.prog * 0.6));
      else if (caps.deliver > 60) caps.deliver = Math.max(60, Math.floor(caps.deliver * 0.75));
      else break;
      body = assemble(caps);
    }
    blocks.push(`## 任务现场（≤600字）\n${body.slice(0, 600)}`);
  } catch { }
  // 已终止（todo-abort）：单列可见（**不计入待办**），便于回溯与纠错。（④ 2026-10-05）
  try {
    const abT = (f.abortedTodos || []).map((t) => String(t).replace(/^[-*]?\s*\[\s*\]\s*/, '').trim()).filter(Boolean);
    if (abT.length) blocks.push(`## 已终止（不计待办）\n` + abT.slice(0, 10).map((t) => `- ${cutS(t, 80)}`).join('\n'));
  } catch { }

  // —— T-B 未读信箱 ——
  try {
    if (unread.length) {
      const rows = unread.slice(0, 5).map((m) => `- ${cutS(m.from_id, 16)}(${cutS(m.type, 8)}): ${cutS(m.content, 60)}`);
      if (unread.length > 5) rows.push(`- …等 ${unread.length} 条`);
      blocks.push(`## 未读信箱\n${rows.join('\n')}`);
    }
  } catch { }

  // —— T-C 在途派单 ——
  try {
    if (inflight.length) {
      const rows = inflight.slice(0, 5).map((m) => `- ${cutS(m.from_id, 16)}: ${cutS(m.content, 60)}`);
      if (inflight.length > 5) rows.push(`- …等 ${inflight.length} 条`);
      blocks.push(`## 在途派单\n${rows.join('\n')}`);
    }
  } catch { }

  return blocks;
}

// ==================== 世界树④-1：交接「近期时间线」支干渲染 + 影子比对 ====================

/** T-A：把支干 fold 的「近 N 轮骨架 + 该轮挂载事件」渲染为时间线段。
 *  纯读 / 幂等 / 有界（≤ branchTimelineMaxChars，默认 1500，超限按"近轮优先"截）。
 *  无 branch 数据 → 返回 ''（调用方省略该段）。 */
function renderBranchTimeline(sessionId, N = 8) {
  try {
    const c = (() => { try { return loadConfig(); } catch { return {}; } })();
    if (c.branchEnabled === false) return '';
    const MAX = Math.max(400, Number(c.branchTimelineMaxChars) || 1500);
    const CAP_EV = Math.max(1, Number(c.branchTimelineEventsPerTurn) || 3);
    let f = null;
    try { f = branch.fold(sessionId, Number(c.branchTimelineTurns) || N || 8); } catch { return ''; }
    if (!f || !Array.isArray(f.turns) || !f.turns.length) return '';
    const cut = (v, n) => { const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
    const KINDS = new Set(['todo', 'decision', 'fruit', 'prefix']);
    const groups = [];
    for (const t of f.turns) {
      const g = Number(t.gen);
      const gen = Number.isFinite(g) ? `g${g}` : 'gen?';   // v4-2：gen=0 显示 g0（第0代=尚未交接），确无值才用 gen?
      const head = cut(String(t.summary || '').replace(/^[#>*\-\s]+/, ''), 50) || '（无摘要）';
      const rows = [`- [${gen}·${t.seq == null ? '' : t.seq}] ${t.aborted ? '[中断] ' : ''}${head}`];
      for (const e of (t.events || []).filter((x) => KINDS.has(x.kind)).slice(0, CAP_EV)) {
        rows.push(`  - ${e.kind}: ${cut(e.payload, 60)}`);
      }
      groups.push(rows.join('\n'));
    }
    const ea = f.earlier || { count: 0 };
    if (ea.count > 0) {
      const range = (ea.genMin != null && ea.genMax != null) ? `第 ${ea.genMin}~${ea.genMax} 代` : '更早世代';
      groups.unshift(`- 更早：${range}（共 ${ea.count} 轮，详见归档）`);
    }
    let body = groups.join('\n');
    let dropped = false;
    while (body.length > MAX && groups.length > 1) { groups.shift(); dropped = true; body = groups.join('\n'); }
    if (dropped) body = `- …（更早轮次已省略）\n${body}`;
    return body.slice(0, MAX);
  } catch { return ''; }
}

/** T-C：影子比对（**只记录不切换**）——支干 fold 的 openTodos/pendingPfx 对比账本 _progress.md 的
 *  TODO/PREFIX 区，差异追加写 data/branch_shadow.log。纯旁路：异常静默降级，绝不影响交接内容与行为。 */
function shadowCompareBranch(s, gen, todos) {
  try {
    const c = (() => { try { return loadConfig(); } catch { return {}; } })();
    if (c.branchShadowCompare === false) return;   // 默认 true
    if (c.branchEnabled === false) return;
    const sid = (s && s.id) || '';
    const f = branch.fold(sid, Number(c.branchTimelineTurns) || 8) || {};
    const norm = (x) => String(x || '').replace(/^[-*]?\s*\[\s*[xX ]?\s*\]\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const uniq = (arr) => { const out = [], seen = new Set(); for (const v of (arr || [])) { const n = norm(v); if (!n || seen.has(n)) continue; seen.add(n); out.push(n); } return out; };
    const bT = uniq(f.openTodos), bP = uniq(f.pendingPfx);
    const lT = uniq(todos), lP = uniq(listPendingPrefixForSession(s));
    const only = (a, b) => a.filter((x) => !b.includes(x));
    const oBT = only(bT, lT), oLT = only(lT, bT), oBP = only(bP, lP), oLP = only(lP, bP);
    const same = !oBT.length && !oLT.length && !oBP.length && !oLP.length;
    const brief = (arr) => arr.slice(0, 2).map((x) => x.slice(0, 40)).join(' / ');
    const diffTxt = (same ? '一致' : [
      `仅支干待办${oBT.length}${oBT.length ? ':' + brief(oBT) : ''}`,
      `仅账本待办${oLT.length}${oLT.length ? ':' + brief(oLT) : ''}`,
      `仅支干前缀${oBP.length}${oBP.length ? ':' + brief(oBP) : ''}`,
      `仅账本前缀${oLP.length}${oLP.length ? ':' + brief(oLP) : ''}`,
    ].join(' ; ')).slice(0, 200);
    const line = `[${new Date().toISOString()}] session=${sid} gen=${gen} branch(todo=${bT.length},pfx=${bP.length}) ledger(todo=${lT.length},pfx=${lP.length}) same=${same} ${diffTxt}`;
    appendShadowLog(line);
  } catch { /* 旁路：绝不阻断交接 */ }
}

/** 影子日志追加（>2MB 清空重写；失败静默）。 */
function appendShadowLog(line) {
  try {
    const file = path.join(DATA_DIR, 'branch_shadow.log');
    try { if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.writeFileSync(file, '', 'utf8'); } catch { }
    fs.appendFileSync(file, String(line) + '\n', 'utf8');
  } catch { }
}

/** 取骨架文本中某分区标题（📌【/⚡【/✅【/📄【）下的 "- " 条目数。 */
function countSkeletonItems(text, headerRe) {
  try {
    const lines = String(text || '').split('\n');
    let on = false, n = 0;
    for (const l of lines) {
      const t = l.trim();
      if (/^(📌|⚡|✅|📄)【/.test(t)) { on = headerRe.test(t); continue; }
      if (on && /^[-*]\s+\S/.test(t)) n++;
    }
    return n;
  } catch { return 0; }
}

/** v4-3 T-B：年轮索引渲染（按 gen 分组，近 20 代；无数据 → ''）。
 *  **可选消费**：由 buildHandoffDocFromBranch（支干主路径）传入 ov.ringsText，供"归档索引"段使用。 */
function renderRingIndex(sessionId) {
  try {
    const c = (() => { try { return loadConfig(); } catch { return {}; } })();
    if (c.branchEnabled === false) return '';
    const f = branch.fold(sessionId, Number(c.branchTimelineTurns) || 8);
    const rings = (f && f.rings) || [];
    if (!rings.length) return '';
    return '**年轮索引（支干）**\n' + rings.map((r) => {
      const hl = (r.highlights || []).join('；');
      return `- 年轮 g${r.gen}：${r.turnCount} 轮${hl ? '｜' + hl : ''}`;
    }).join('\n');
  } catch { return ''; }
}

/** v4-2 T-A：回合「世代号」解析 —— **持久层优先**（archiveStore.currentGen，重启/未交接过均正确），
 *  持久层无记录（=从未归档过 → 0）时回退内存 Map（交接时写入）。 */
function resolveBranchTurnGen(sessionId) {
  try {
    const g = archiveStore.currentGen(sessionId);
    if (Number.isFinite(Number(g)) && Number(g) > 0) return Number(g);
  } catch { }
  try { return branchGenBySession.get(sessionId) || 0; } catch { return 0; }
}

/** v4-2 T-B：仅用支干 fold 合成交接骨架（KEY 决定 / PREFIX / TODO）+ 时间线数据源。不读 _progress.md。
 *  返回 { text, todos, timeline, decisions, prefixes }；支干无数据 → text=''（调用方回退现有路径）。 */
/** v6.38（P5）：open 待办首见元信息表（normTodoKey → {ageDays,…}）+ 陈旧阈值（config.todoStaleDays，默认 7 天）。纯辅助，失败安全。 */
function _tStaleDays(c) { try { const v = Number((c || {}).todoStaleDays); return Number.isFinite(v) && v > 0 ? v : 7; } catch { return 7; } }
function _tMeta(f) {
  const m = new Map();
  try { for (const x of ((f && f.openTodoMeta) || [])) m.set(branch.normTodoKey(x.payload) || x.payload, x); } catch { }
  return m;
}
function branchSkeletonText(s, cfgIn) {
  try {
    const c = cfgIn || (() => { try { return loadConfig(); } catch { return {}; } })();
    if (c.branchEnabled === false) return { text: '', todos: [], timeline: '', decisions: [], prefixes: [] };
    const f = branch.fold(s.id, Number(c.branchTimelineTurns) || 8) || {};
    const cut = (v, n) => { const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
    const DEC_K = Math.max(1, Number(c.branchSkeletonDecisions) || 12);
    // P2-prep3：与 P0/fold 对齐——首部奠基(head=4) + 尾部最新(DEC_K-4)，而非只取尾部（旧版丢奠基）。
    const decisions = pickHeadTail(f.decisions, DEC_K, 4);
    const prefixes = (f.pendingPfx || []);
    const todos = (f.openTodos || []).map((x) => { try { const m = (_tMeta(f).get(branch.normTodoKey(x) || x) || null); const sd = _tStaleDays(c); return (m && m.ageDays != null && m.ageDays >= sd) ? `${x}  ⏰（已 ${m.ageDays} 天未更新，请确认是否仍为待办）` : x; } catch { return x; } });   // v6.38 P5：陈旧标注（只标注不删）
    const parts = [];
    if (decisions.length) parts.push(`📌【常驻·关键决定】（支干 fold）\n${decisions.map((d) => `- ${cut(d, 140)}`).join('\n')}`);
    if (prefixes.length) parts.push(`⚡【待补前缀操作】（支干 fold）\n${prefixes.map((p) => `- [ ] ${cut(p, 140)}`).join('\n')}`);
    if (todos.length) parts.push(`✅【待办·TODO】（支干 fold）\n${todos.map((t) => `- [ ] ${cut(t, 140)}`).join('\n')}\n（以上为 open 记录；确已办请用 log_progress(done=true) 真勾销——未勾销不会自动移除）`);
    try { const _pr = require('./pfxqueue').listPendingRestart() || []; if (_pr.length) parts.push(`🔄【待重启收尾·需重启生效】（本实例）\n${_pr.map((r) => `- ${cut(String(r.target || ''), 40)} ${cut(String(r.path || ''), 120)}`).join('\n')}\n（重启完成后由部署方 clearPendingRestart 勾销）`); } catch { }
    const timeline = renderBranchTimeline(s.id, Number(c.branchTimelineTurns) || 8);
    let text = parts.join('\n\n');
    if (text.length > 6000) text = text.slice(0, 6000);
    return { text, todos, timeline, decisions, prefixes };
  } catch { return { text: '', todos: [], timeline: '', decisions: [], prefixes: [] }; }
}

/** v4-2 T-C：影子比对「支干 fold 合成骨架」 vs 「_progress.md 骨架」（只记录不切换）。 */
/** P2-prep：抽取骨架文本中「📌【常驻·关键决定】」区的条目（去掉前导 `- `）。 */
function keyEntriesOf(skeletonText) {
  const lines = String(skeletonText || '').split('\n');
  let on = false; const out = [];
  for (const l of lines) {
    const t = l.trim();
    if (/^(📌|⚡|✅|📄)【/.test(t)) { on = /📌/.test(t); continue; }
    if (on && /^[-*]\s+\S/.test(t)) out.push(t.replace(/^[-*]\s+/, ''));
  }
  return out;
}

function shadowCompareHandoffSkeleton(s, gen, ledgerSkeleton, ledgerTodos) {
  try {
    const c = (() => { try { return loadConfig(); } catch { return {}; } })();
    if (c.branchShadowCompare === false) return;
    if (c.branchHandoffPrimary === true) return;      // 已切主路径 → 无需影子
    if (c.branchEnabled === false) return;
    const b = branchSkeletonText(s, c);
    if (!b.text) return;                              // 支干无数据 → 无可比对
    // P2-prep：判据改「一致性/包含式」——不再比条数（账本 KEY 按**字符**截断显示、支干按**条数**截断，
    //   计数天然不等 → 旧判据永远 same=false，信号失真）。
    //   覆盖基准取 fold().decisions（首部奠基 + 尾部最新，见 branch.js fold），逐条前缀 30 字匹配账本 KEY 显示项。
    let bDecs;
    try { const f = branch.fold(s.id, Number(c.branchTimelineTurns) || 8) || {}; bDecs = (f.decisions || []); } catch { bDecs = (b.decisions || []); }
    const norm = (d) => String(d).replace(/\s+/g, '').slice(0, 30);
    const bDec = bDecs.length;
    const bNorms = bDecs.map(norm);
    const lDecItems = keyEntriesOf(ledgerSkeleton);
    let covered = 0;
    for (const it of lDecItems) { const k = norm(it); if (k && bNorms.some((bd) => bd && (bd.includes(k) || k.includes(bd)))) covered++; }
    // P2-prep2：todo/pfx 亦改**集合式双向覆盖**（不再比条数——账本区有"已完成历史"残留、支干 fold 已收缩，
    //   计数天然不等）。判据：支干 pending ⊆ 账本 pending 且 账本 pending ⊆ 支干 pending（去标记归一化后互含）。
    const nrm = (x) => String(x).replace(/^[-*]\s*\[\s*[xX✓✔]?\s*\]\s*/, '').replace(/^\s*[-*]\s*\[\s*\]\s*/, '')
      .replace(/(已完成|已勾除|已收口)[:：]?/g, '').replace(/[\s`*_#—…。，,、：:]+/g, '').slice(0, 30);
    const coverBoth = (aItems, bItems) => {
      const an = aItems.map(nrm).filter(Boolean), bn = bItems.map(nrm).filter(Boolean);
      const missing = an.filter((k) => !bn.some((x) => x && (x.includes(k) || k.includes(x))));
      const extra = bn.filter((k) => !an.some((x) => x && (x.includes(k) || k.includes(x))));
      return { ok: missing.length === 0 && extra.length === 0, missing, extra };
    };
    const bTodo = (b.todos || []).length, bPfx = (b.prefixes || []).length;
    const lTodo = (ledgerTodos || []).length, lPfx = listPendingPrefixForSession(s).length;
    const decOk = (lDecItems.length === 0) ? (bDec === 0) : (covered === lDecItems.length);
    const todoCmp = coverBoth(ledgerTodos || [], b.todos || []);
    const pfxCmp = coverBoth(listPendingPrefixForSession(s), b.prefixes || []);
    const same = (decOk && todoCmp.ok && pfxCmp.ok);
    const diff = (same ? '一致'
      : `决定 覆盖${covered}/${lDecItems.length} / 待办 缺${todoCmp.missing.length}多${todoCmp.extra.length} / 前缀 缺${pfxCmp.missing.length}多${pfxCmp.extra.length}`
        + (todoCmp.missing.length || todoCmp.extra.length ? `｜待办缺:${todoCmp.missing.slice(0, 2).join('|')}｜待办多:${todoCmp.extra.slice(0, 2).join('|')}` : '')
        + (pfxCmp.missing.length || pfxCmp.extra.length ? `｜前缀缺:${pfxCmp.missing.slice(0, 2).join('|')}｜前缀多:${pfxCmp.extra.slice(0, 2).join('|')}` : '')
    ).slice(0, 260);
    appendShadowLog(`[${new Date().toISOString()}] session=${(s && s.id) || ''} gen=${gen} kind=handoff-primary branch(dec=${bDec},todo=${bTodo},pfx=${bPfx}) ledger(dec=${lDecItems.length},todo=${lTodo},pfx=${lPfx}) same=${same} ${diff}`);
  } catch { /* 旁路：绝不阻断交接 */ }
}

/** v4-2 T-B：用支干 fold 合成整份交接文档（骨架部分来自支干；其余段落沿用现有实现）。
 *  支干无数据时回退现有 _progress.md 路径（优雅降级，不劣化）。 */
function buildHandoffDocFromBranch(s, cut, gen = 0) {
  const b = branchSkeletonText(s);
  // 批B（B1.2）：原始目标口径与引擎一致 —— 取 cut 里【最后一个 user】（runtime.js:1737 同口径，**非 turn_no=1**）；
  //   cut 为空时回退 fold().goal（kind='goal' 首代目标独立标记，compact 不丢）。
  const lastUser = [...(cut || [])].reverse().find((m) => m.role === 'user');
  let goal = lastUser ? String(lastUser.content || '').replace(/\s+/g, ' ').slice(0, 300) : '';
  if (!goal) { try { goal = String((branch.fold(s.id) || {}).goal || ''); } catch { } }
  if (!b.text && !b.timeline && !(b.todos || []).length) return buildHandoffDocSync(s, cut, gen, { goal });
  let ringsText = '';
  try { ringsText = renderRingIndex(s.id); } catch { }
  return buildHandoffDocSync(s, cut, gen, { goal, skeleton: b.text, todos: b.todos, timeline: b.timeline, skeletonHeading: '支干 fold 合成', ringsText });
}

/** P1：启动路径开关 —— 若 `config.branchSeedFromLedger === true`，把各项目账本 KEY 区决定
 *  幂等种子迁入支干（历史在前）。**默认 false → 立即返回，零副作用**（不写库、不扫盘）。 */
function seedBranchFromLedgerIfEnabled() {
  try {
    const c = (() => { try { return loadConfig(); } catch { return {}; } })();
    if (c.branchSeedFromLedger !== true) return { ok: true, skipped: true, reason: 'branchSeedFromLedger=false' };
    const root = path.join(c.workdir || '', 'projects');
    if (!fs.existsSync(root)) return { ok: true, skipped: true, reason: 'no-projects-dir' };
    const out = [];
    for (const name of fs.readdirSync(root)) {
      const pf = path.join(root, name, '_progress.md');
      if (!fs.existsSync(pf)) continue;
      try {
        const r = branch.seedDecisionsFromLedger(name, fs.readFileSync(pf, 'utf8'));
        if (r && r.ok && r.inserted) out.push({ session: name, inserted: r.inserted, skipped: r.skipped });
      } catch { }
    }
    return { ok: true, sessions: out.length, inserted: out.reduce((a, x) => a + x.inserted, 0), detail: out };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/** v3 骨架文档（同步、零 AI，<100ms）：原始目标 + 项目骨架(尾部) + 本代未完成 + 归档索引。≤8000 字符。 */
function buildHandoffDocSync(s, cut, gen = 0, ov = null) {
  // 【尾部参照段】先算（有界 ≤1200），再从骨架预算里扣同等额度，避免撑破 8000 把归档索引挤出。
  const progressRaw = progressTextOf(s);
  const tail = buildTailReference(cut, handoffSkeleton(s), progressRaw);
  // [goal修复] 原始目标应取【最近】的真实任务，而非 cut 里第一个(年代久远的旧目标)。
  // 多代累积会话下 cut 第一个 user 常是旧目标(如雷影的诞生取到gen=1旧会话)，导致交接后失忆。
  // 改为取 cut 里【最后一个】user(最近真实指令)，更贴近当前正在做的事。
  const lastUser = [...(cut || [])].reverse().find((m) => m.role === 'user');
  const goal = (ov && ov.goal != null) ? String(ov.goal) : (lastUser ? String(lastUser.content || '').replace(/\s+/g, ' ').slice(0, 300) : '');
  // ov（v4-2 T-B·可选）：支干 fold 合成骨架时由调用方注入（skeleton/todos/timeline/heading）。
  //   ov=null（默认）→ 完全走原 _progress.md 路径，行为与改前一致。
  const todos = (ov && Array.isArray(ov.todos)) ? ov.todos : parseTodos(progressRaw || handoffSkeleton(s));
  // —— v3.2 任务③：任务现场快照 / 未读信箱 / 在途派单（规则拼接、零 AI；插尾部参照后、项目骨架前）——
  const taskBlocks = buildTaskBlocks(s, goal, todos);
  const taskBlockText = taskBlocks.join('\n');
  const skeleton = (ov && ov.skeleton != null)
    ? String(ov.skeleton).slice(0, 6000)
    : handoffSkeleton(s, Math.max(1500, 6000 - tail.length - taskBlockText.length));
  // —— v3.1 Layer B：本代归档主题地图（有界；只取 user+assistant，滤工具日志词）——
  const cfg = (() => { try { return loadConfig(); } catch { return {}; } })();
  // —— v4-1：交接「近期时间线」（支干渲染；无数据则整段省略）+ 影子比对（旁路，只记录不切换）——
  let timeline = '';
  try { timeline = (ov && ov.timeline != null) ? String(ov.timeline) : renderBranchTimeline(s.id, Number(cfg.branchTimelineTurns) || 8); } catch { }
  if (!ov) {
    try { shadowCompareBranch(s, gen, todos); } catch { }
    // v4-2 T-C：fold 合成骨架 vs _progress.md 骨架 影子比对（仅 branchHandoffPrimary=false 时记录）
    try { shadowCompareHandoffSkeleton(s, gen, skeleton, todos); } catch { }
  }
  let topicLine = '';
  if (cfg.handoffArchiveTopic !== false) {
    topicLine = archiveTopicMap(cut, Number(cfg.handoffTopicCap) || 1200);
  }
  // 双落点②：_progress.md「归档目录」区（滚动保留最近 K 代，有界）
  if (topicLine) writeArchiveDir(s, gen, topicLine);
  const idx = [
    `- 本次归档 ${(cut || []).length} 条消息（第 ${gen} 代，含 ${(cut || []).filter((m) => m.role === 'user').length} 个用户回合），全文在归档；需要细节时用 recall_context <关键词> 调回。`,
  ];
  if (topicLine) idx.push(`- ${topicLine}`);
  idx.push(`- 更早旧内容同样在归档可召回（历史各代主题见项目账本「归档目录」区）；项目规则/决定以 _progress.md 为准。`);
  // —— v3.1 Layer F2：本代记忆增量（按 mtime > 上代交接时刻 过滤，有界）——
  let memInc = '';
  if (cfg.handoffMemoryIncrement !== false) {
    const since = (s && s.lastCompact && Number(s.lastCompact.at)) || 0;
    const lines = memIncrementLines(since, 12);
    if (lines.length) memInc = `\n## 本代记忆增量\n${lines.join('\n')}`.slice(0, Number(cfg.handoffMemIncCap) || 1200);
  }
  // —— v3.1 Layer D2：交接时回填"归档纪要"记忆（复用 topicLine，不重算；滚动有界；失败静默降级）——
  backfillArchiveMemo(s, (s && s.id) || '', gen, topicLine, memInc);
  // —— 自我模型反哺（MVP）：相关自我认知段（窗口重建时注入，边际成本≈0；空则不输出）——
  let selfHint = '';
  try { selfHint = buildSelfHint(goal, 3); } catch { selfHint = ''; }
  return [
    `## 原始目标（本代最早用户消息）`,
    goal || '（无）',
    tail ? `\n${tail}` : '',
    taskBlockText ? `\n${taskBlockText}` : '',
    selfHint ? `\n## 自我认知（相关）\n${selfHint}` : '',
    skeleton
      ? ((ov && ov.skeletonHeading) ? `\n## 项目骨架（${ov.skeletonHeading}）\n${skeleton}` : `\n## 项目骨架（_progress.md 权威）\n${skeleton}`)
      : `\n## 项目骨架\n（无进度文件——本代工作记录见归档，可用 recall_context 召回）`,
    timeline ? `\n## 近期时间线\n${timeline}` : '',
    todos.length
      ? `\n## 本代未完成\n${todos.map((t) => (String(t).trim().startsWith('-') ? String(t).trim() : '- ' + String(t).trim())).join('\n')}`
      : `\n## 本代未完成\n（无）`,
    `\n## 本代增量\n（后台提炼中；细节见归档，可 recall_context 召回）`,
    memInc,
    `\n## 归档索引\n${idx.join('\n')}${(ov && ov.ringsText) ? '\n' + ov.ringsText : ''}`,
  ].filter((x) => x !== '').join('\n').slice(0, 8000);
}

/** 增量区块占位（buildHandoffDoc 按此锚点替换/收尾）。 */
const INC_PLACEHOLDER = `\n## 本代增量\n（后台提炼中；细节见归档，可 recall_context 召回）`;
const INC_DEGRADED = `\n## 本代增量\n（无可提炼内容或提炼失败；旧回合细节见归档，可用 recall_context 召回）`;

/** 本代增量（后台·非关键路径）：旧回合分段提炼为"关键增量"bullet（每段 ≤800 字）。
 * segLimit：账本覆盖充分时只提炼最近 2 段（最近一轮是下一条消息最可能引用的对象）；缺省 ≤6 段。
 *  @param {object} [s] 发起会话（用于把后台调用 usage 计入成本；可缺省） */
async function summarizeHandoffSegments(cutMsgs, segLimit = 6, s) {
  const segments = [];
  const SEG_GLOSS = 15000;
  let cur = [], curLen = 0;
  for (const m of cutMsgs) {
    const line = m.role === 'tool'
      ? `工具: ${String(m.content || '').split('\n')[0].slice(0, 120)}`
      : `${m.role === 'user' ? '用户' : '助手'}: ${String(m.content || '').slice(0, 300)}`;
    if (curLen + line.length > SEG_GLOSS && cur.length) { segments.push(cur); cur = []; curLen = 0; }
    cur.push(line); curLen += line.length;
  }
  if (cur.length) segments.push(cur);
  const segs = segments.slice(-Math.max(1, segLimit));   // 只取最近 N 段（旧段落由归档+账本兜底）
  const sys = systemPrompt().full;
  const parts = [];
  const segN = segs.length;
  for (let i = 0; i < segN; i++) {
    const gloss = segs[i].join('\n').slice(0, 15000);
    const isLast = i === segN - 1;
    try {
      const _hf0 = Date.now();
      const r = await chatOnce([
        { role: 'system', content: sys },
        { role: 'user', content: `【交接提炼】以下是会话旧回合（第 ${i + 1}/${segN} 段）。提炼本段**关键增量**，只输出 bullet 行（每行 ≤60 字，最多 5 行），类别覆盖：事实/数据、已确认决定（含用户明确要求）、完成的成果、待办（未完成事项）。${isLast ? '本段是最近一轮：必须给出"做了什么/结果/未完成"三点。' : ''}没有增量就输出"无"。

严格禁止：复述输入原文、过程流水（"正在读""下一步""继续"类）、单次工具中间结果。\n\n${gloss}` },
      ], { maxTokens: 900, temperature: 0, thinking: { type: 'disabled' }, kind: 'handoff-fill' });
      try { creditUsage(s, r.usage, 'handoff-fill', _hf0); } catch { }   // 后台交接提炼计入发起会话/全局（第5项）
      const t = (r.text || '').trim().replace(/\r?\n+/g, '\n').slice(0, 800);
      parts.push(t || '无');
    } catch {
      parts.push('（提炼失败）');
    }
  }
  return parts.filter((p) => p !== '无' && p !== '（提炼失败）');
}

/** A1''（2026-09-29）：整代重整的 LLM 分组命名（另起一次小调用，独立失败回退）。
 *  输入 clusters=[{idx,terms,samples}]，返回 {idx:name}；失败/非法返回 null（调用方退回规则名）。 */
async function reflowLlmGroup(clusters, ctx) {
  try {
    if (!Array.isArray(clusters) || !clusters.length) return null;
    const sys = '你是会话归档助手。给定若干「话题簇」的关键词与样例，为每个簇起一个 4~10 字的简短中文主题名（名词短语，概括该簇在做什么）。要求：具体、可区分，避免"其他/杂项/讨论/工作"这类空泛词；簇间不得重名。只输出 JSON 对象，键为簇编号，值为主题名。';
    const body = clusters.map((c) => `#${c.idx} 关键词：${(c.terms || []).join('、')}；样例：${(c.samples || []).join(' / ')}`).join('\n');
    const _t0 = Date.now();
    const r = await chatOnce([
      { role: 'system', content: sys },
      { role: 'user', content: `为下列每个话题簇起一个简短中文主题名（4~10字，具体、互不重名）。只输出 JSON 对象，键=簇编号（数字），值=主题名。例：{"0":"会话树与交接","1":"成本与预算"}。\n\n${body}` },
    ], { maxTokens: 300, temperature: 0, thinking: { type: 'disabled' }, kind: 'reflow-topic' });
    try { creditUsage((ctx && ctx.s) || null, r.usage, 'reflow-topic', _t0); } catch { }
    const t = String(r.text || '').trim();
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    const out = {};
    for (const k of Object.keys(obj)) {
      const v = String(obj[k] || '').trim();
      if (v && v.length <= 24 && !/[\r\n]/.test(v)) out[Number(k)] = v;
    }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

/** A1''（2026-09-29）：交接后/轮末兜底触发整代重整（幂等；已在引擎侧，静默失败不阻塞）。 */
async function maybeReflowGen(s, closedGen) {
  try {
    if (!s || !s.id) return null;
    const g = Number(closedGen);
    if (!Number.isFinite(g) || g < 0) return null;
    // A（2026-09-29）：尊重开关——自动归枝已退场（改走"派单驱动归枝"，见 resolveTaskTopic/flushTurn topicKey）。
    try { const rf = loadConfig().branchReflow; if (!rf || rf.enabled === false) return { ok: true, reason: 'disabled' }; } catch { }
    const r = await branch.reflowGen(s.id, g, { llmGroup: (clusters, ctx) => reflowLlmGroup(clusters, { ...ctx, s }) });
    try { if (r && r.ok && r.reason !== 'already') console.log(`[reflow] sid=${s.id} ${r.line}`); } catch { }
    return r;
  } catch { return null; }
}

/** 完整交接文档 = 骨架（同步）+ 增量（AI，失败降级为占位声明）；deepCompact 测试路径与后台 deepFillSummary 使用。 */
async function buildHandoffDoc(s, cut, gen = 0) {
  const useBranch = (() => { try { return loadConfig().branchHandoffPrimary === true; } catch { return false; } })();
  const base = useBranch ? buildHandoffDocFromBranch(s, cut, gen) : buildHandoffDocSync(s, cut, gen);
  const skeleton = handoffSkeleton(s);
  const segLimit = skeleton.length > 200 ? 2 : 6;   // 账本覆盖充分 → 只提炼最近 2 段
  let increments = [];
  try { increments = await summarizeHandoffSegments(cut || [], segLimit, s); } catch { }
  let incSection = INC_DEGRADED;
  if (increments.length) {
    incSection = `\n## 本代增量（旧回合提炼）\n${increments.join('\n')}`;
  }
  return (base.includes(INC_PLACEHOLDER) ? base.replace(INC_PLACEHOLDER, incSection) : base + incSection).slice(0, 8000);
}

/** 【分层蒸馏·共识路径】压缩摘要写入长期记忆 + 约定句式升格（雷仔"暗号约定"增强，两路径共用）。 */
function distillSummary(s, sessTitle, summary, gen = 0) {
  try {
    if (s && s.id && summary && !summary.includes('摘要生成失败')
      && !summary.includes('（测试摘要') && !/^SUMM/.test(summary) && !summary.includes('（未产生摘要）')) {
      const ts = new Date().toISOString().slice(0, 10);
      const cfg = (() => { try { return loadConfig(); } catch { return {}; } })();
      const bounded = cfg.compressSummaryBounded !== false;
      // v3.1 F1：分代命名（用会话 id，消改名断链）+ 每会话只留最近 K 代（更旧代并入 -archive）
      const memName = bounded ? `压缩摘要-${s.id}-gen${gen}` : `压缩摘要-${sessTitle}`;
      memory.save('memory', memName, `[${ts} 会话 ${s.id} 上下文压缩提炼 · 第 ${gen} 代]\n${summary}`, {});
      if (bounded) compactSummaryGens(s.id, cfg.compressSummaryKeepK, cfg.compressSummaryArchiveCap);
      if (!summary.includes('（测试摘要') && !/^SUMM/.test(summary)
        && (/(主人|用户)(说|讲|定|说好|走之前|离开时)[^；。]{2,30}[＝=:：][^；。]{2,60}[；。]/.test(summary)
          || /(主人|用户).{0,20}(离开|走|出去|忙).{0,10}(说|说一句|讲).{0,40}(触发|探知|心跳|注册|自主)/.test(summary)
          || /(我回来了|停吧|停止|回来|说停).{0,15}(停掉|schedule_stop|专注|心跳)/.test(summary))) {
        try { memory.save('memory', `暗号约定-${sessTitle}`, `[${ts} 会话 ${s.id} 压缩蒸馏·识别双向约定]\n${summary}`, {}); } catch { }
      }
    }
  } catch { }
}

// 实时 token 燃烧预估（流式过程中没有真实 usage，仅按字符量粗估，用于 UI 动效强度）
function estTokens(chars) { return Math.max(1, Math.round(chars * 0.75)); }

/** v6.26 方案B：自动唤醒速率窗判定——超限返回 true（跳过本次唤醒）；未超限则计数并返回 false。
 *  rateMax=0 表示不限。仅内存计数，进程重启即清零。 */
function _wakeRateExceeded(sessionId, cfg) {
  const rateMax = (() => { const v = Number(cfg.mailboxWakeRateMax); return Number.isFinite(v) && v >= 0 ? v : MAILBOX_WAKE_MAX_PER_WINDOW; })();
  if (!(rateMax > 0)) return false;
  const rateWin = (() => { const v = Number(cfg.mailboxWakeRateWindowMs); return Number.isFinite(v) && v > 0 ? v : MAILBOX_WAKE_WINDOW_MS; })();
  const now = Date.now();
  const w = _wakeWindowBySession.get(sessionId) || { ts: 0, count: 0 };
  if (now - w.ts > rateWin) { w.ts = now; w.count = 0; }
  if (w.count >= rateMax) return true;
  w.count++; _wakeWindowBySession.set(sessionId, w);
  return false;
}

/** P2b-9：计算速率窗剩余毫秒（未限流/无记录返回 0）。 */
function _wakeRateWaitMs(sessionId, cfg) {
  try {
    const rateMax = (() => { const v = Number(cfg.mailboxWakeRateMax); return Number.isFinite(v) && v >= 0 ? v : MAILBOX_WAKE_MAX_PER_WINDOW; })();
    if (!(rateMax > 0)) return 0;
    const rateWin = (() => { const v = Number(cfg.mailboxWakeRateWindowMs); return Number.isFinite(v) && v > 0 ? v : MAILBOX_WAKE_WINDOW_MS; })();
    const w = _wakeWindowBySession.get(sessionId);
    if (!w) return 0;
    const rem = rateWin - (Date.now() - w.ts);
    return rem > 0 ? rem : 0;
  } catch { return 0; }
}

/** P2b-9：rate-limited 后保底重排——在窗口结束 + ε 后自再唤醒一次，确保"下一窗口唤醒"，绝不静默悬挂。
 *  幂等：同一会话已有待触发 timer 时不重复登记；累计重排次数 ≥ MAX_WAKE_RATE_RETRY 时停（防死循环）。 */
function _scheduleRateLimitRetry(sessionId, injectMsgIds) {   // A（2026-10-08）：带上触发限流的 injectMsgIds，重排时原样重放
  try {
    const cfg = loadConfig();
    const prev = _rateRetryBySession.get(sessionId);
    if (prev && prev.timer) return;                     // 已有待触发重排 → 幂等跳过
    const cnt = prev ? (Number(prev.count) || 0) : 0;
    if (cnt >= MAX_WAKE_RATE_RETRY) return;             // 达上限 → 停（兜底：新消息/下轮交互仍会注入）
    const wait = _wakeRateWaitMs(sessionId, cfg);
    if (!(wait > 0)) return;                            // 未限流（异常）→ 交给常规路径
    const delay = Math.max(200, wait + 500);            // 窗口结束后 +ε
    const ids = (Array.isArray(injectMsgIds) ? injectMsgIds : []).filter((x) => x != null).map(String);
    const timer = setTimeout(() => {
      try { const cur = _rateRetryBySession.get(sessionId) || { count: cnt }; _rateRetryBySession.set(sessionId, { count: cur.count, timer: null, ids: cur.ids }); } catch { }
      try { wakeMailbox(sessionId, ids.length ? { injectMsgIds: ids, rateRetryReplay: true } : null); } catch { }   // A：重放保底——原样重放原 injectMsgIds，并绕过二次过滤
      // 修正（2026-10-08·主我覆盖指令 3）：仅当消息确已 resolved（已读/离开 inbox）才清重排；否则保留，留给下次窗口再试。
      try {
        if (ids.length) {
          const _mb = require('./mailbox');
          let _allResolved = true;
          for (const _i of ids) { const _m = (_mb && typeof _mb.getMessage === 'function') ? _mb.getMessage(_i) : null; if (_m && _m.read_at == null && String(_m.state || 'inbox') === 'inbox') { _allResolved = false; break; } }
          if (_allResolved) _clearRateRetry(sessionId);
        }
      } catch { }
    }, delay);
    try { if (timer && typeof timer.unref === 'function') timer.unref(); } catch { }
    _rateRetryBySession.set(sessionId, { count: cnt + 1, timer, ids });
    try { console.log(`[mailbox-sweep] sid=${sessionId} rate-limited → 保底重排#${cnt + 1} @+${Math.round(delay)}ms ids=${ids.join(',') || '-'}`); } catch { }
  } catch { }
}

/** P2b-9：清空会话的保底重排计数（唤醒成功/无待处理时调用，防计数残留误杀）。 */
function _clearRateRetry(sessionId) {
  try {
    const prev = _rateRetryBySession.get(sessionId);
    if (prev && prev.timer) { try { clearTimeout(prev.timer); } catch { } }
    _rateRetryBySession.delete(sessionId);
  } catch { }
}

/** 异步「完成即推 + 短回检」最小件（2026-10-08 定案）——
 *  复用 mailbox 唤醒语义 + 现有调度；不建新表/新通道/新工具。
 *  ① 幂等：同一 task(cid) 的 done 只推一次；② 短回检：done 未被唤醒时 30s→60s 退避重试，直到真唤醒。 */
const _doneOnce = new Map();               // cid -> ts（幂等闸）
const DONE_ONCE_TTL_MS = 10 * 60 * 1000;
const _shortRecheck = new Map();           // sessionId -> { timer, tries, cid }
const SHORT_FIRST_MS = 30000, SHORT_MAX_MS = 60000, SHORT_MAX_TRIES = 30;

/** 幂等闸：同一 cid 的完成只允许推一次。true=首次（应推），false=重复（跳过）。 */
function markDoneOnce(cid) {
  try {
    if (!cid) return true;                                    // 无 cid → 不参与幂等（保持旧行为）
    const now = Date.now();
    for (const [k, ts] of _doneOnce) if (now - ts > DONE_ONCE_TTL_MS) _doneOnce.delete(k);
    if (_doneOnce.has(String(cid))) return false;
    _doneOnce.set(String(cid), now);
    return true;
  } catch { return true; }
}

/** 短回检：done 未被唤醒时登记**单条**退避重试（30s→60s 封顶）；成功即停（仅状态变化才唤醒），防搁浅。 */
function scheduleShortRecheck(sessionId, cid) {
  try {
    if (!sessionId) return;
    const prev = _shortRecheck.get(sessionId);
    if (prev && prev.timer) return;                           // 幂等：已有回检
    const tries = prev ? (Number(prev.tries) || 0) : 0;
    if (tries >= SHORT_MAX_TRIES) { _shortRecheck.delete(sessionId); return; }
    const delay = Math.min(SHORT_MAX_MS, Math.round(SHORT_FIRST_MS * Math.pow(2, tries)));
    const timer = setTimeout(() => {
      try { _shortRecheck.set(sessionId, { tries: tries + 1, timer: null, cid }); } catch { }
      let ok = false;
      try { const r = wakeMailbox(sessionId); ok = !!(r && r.ok); } catch { }
      if (ok) { try { _shortRecheck.delete(sessionId); } catch { } }             // 唤醒成功 → 停
      else { try { scheduleShortRecheck(sessionId, cid); } catch { } }           // 未成功 → 继续 ≤60s 退避
    }, delay);
    try { if (timer && typeof timer.unref === 'function') timer.unref(); } catch { }
    _shortRecheck.set(sessionId, { tries: tries + 1, timer, cid });
  } catch { }
}

/** 该 task 已完成/已唤醒 → 取消其短回检。 */
function cancelShortRecheck(sessionId) {
  try {
    const prev = _shortRecheck.get(sessionId);
    if (prev && prev.timer) { try { clearTimeout(prev.timer); } catch { } }
    _shortRecheck.delete(sessionId);
  } catch { }
}

// ———————— P6（refs=mailbox-structural）：唤醒权威 / 每 role 待处理队列 ————————
//  单一事实源 = 库中"存活待处理入站"（mailbox.listRolePending / listNotWokeInbound）。丢弃点不再"丢"，
//  而是登记**角色级 drain**（去抖）→ 空闲后统一重扫补唤醒（复用 sweepLostInboundWakes / sweepDeliveredUninjectedWakes）。
//  窗口内多路并发对同一 role 只排一次 drain，**对任意 N≥2 成立**；90s 周期兜底仍在 server.js。
const _roleDrainTimers = new Map();   // role -> { timer, at }
function enqueueRoleDrain(role, opts = {}) {
  try {
    role = role || selfRole();
    if (!role) return { ok: false, reason: 'no-role' };
    const delay = Number.isFinite(Number(opts && opts.delayMs)) ? Math.max(0, Number(opts.delayMs)) : 1500;
    const prev = _roleDrainTimers.get(role);
    if (prev) { try { clearTimeout(prev.timer); } catch { } }
    const timer = setTimeout(() => {
      _roleDrainTimers.delete(role);
      // 逐会话重扫"未起回合的动作类入站" + "已投递未注入"（两者判据均幂等，注入后自然不再命中）。
      try { sweepLostInboundWakes({ minAgeMs: 0 }); } catch { }
      try { sweepDeliveredUninjectedWakes({ minAgeMs: 0 }); } catch { }
    }, delay);
    try { if (timer && timer.unref) timer.unref(); } catch { }
    _roleDrainTimers.set(role, { timer, at: Date.now() });
    return { ok: true, delay };
  } catch { return { ok: false, reason: 'err' }; }
}

/** v6.1：空闲即唤醒——雷影消息到达且目标会话空闲时，立即起一轮内部回合处理未读来信。
 *  content 为空 + internalMailbox：不持久化 user 消息，正文只来自回合起始的未读前缀注入。
 *  返回 { ok, reason }；忙/关停/无待办则不唤醒（消息已在库，走未读注入或后续续跑）。 */
function wakeMailbox(sessionId, opts = {}) {
  try {
    const cfg = loadConfig();
    if (cfg.mailboxInstantWake === false) return { ok: false, reason: 'disabled' };
    const s = getSession(sessionId);
    if (!s) return { ok: false, reason: 'no-session' };
    if (s.running || s._compactBusy) { try { enqueueRoleDrain(selfRole(), { delayMs: 1500 }); } catch { } return { ok: false, reason: 'busy' }; }   // P6：busy 不丢，登记 drain
    // v6.22：刚被用户停止 → 短期抑制自动唤醒，防"停止后被信箱续跑立刻复活"（表现为停不掉）。
    const suppressMs = (() => { const v = Number(cfg.postStopSuppressMs); return Number.isFinite(v) ? v : 3000; })();
    if (suppressMs > 0 && s._stoppedAt && (Date.now() - s._stoppedAt) < suppressMs) {
      try { enqueueRoleDrain(selfRole(), { delayMs: suppressMs + 200 }); } catch { }   // P6-S2：抑制窗口过后重扫，不丢
      return { ok: false, reason: 'just-stopped' };
    }
    const mb = require('./mailbox');
    const role = selfRole();
    if (!mb.available() || !role) return { ok: false, reason: 'no-mailbox' };
    const unreadAll = mb.fetchUnreadForSession(role, s.id, 20) || [];
    // v6.26 方案A：唤醒侧类型过滤——仅"动作类"(task 等)驱动新回合；reply/ack/notify 只落库/上屏/回合起始注入
    const onlyAct = cfg.mailboxWakeOnlyActionable !== false;
    const unread = onlyAct ? unreadAll.filter((m) => isActionableType(m, cfg)) : unreadAll;
    // v6.32：唤醒判据改锚点——"存在未投递入站项"（延迟队列/已落库未注入）也唤醒一次轻量注入回合，
    //   治 D4 对 reply-only 空操作（reply/result(非首个) 攒在 _pendingInbound 时也能被消费）。
    const pend = _pendingDrainOn() && _hasUndeliveredInbound(s);
    // v6.49：显式 injectMsgIds（空闲事件触发）可直接驱动唤醒——不依赖 fetchUnreadForSession（其过滤 injected_at IS NULL，
    //   若消息在投递/前序回合已置 injected_at，会取空 → 唤醒空转）。收敛：忙/闲同一注入管线。
    let _injIds = Array.isArray(opts.injectMsgIds) ? opts.injectMsgIds.filter((x) => x != null) : [];
    // v6.50（定案 E）：injectMsgIds 亦须过"是否唤醒"判据——纯 reply/ack/notify（无 wake_intent）**不得**因 msgId 直传而唤醒，
    //   否则"回执不驱动回合"契约被绕过（R13-Ⅰ 实测：纯 reply 投递 → woke=true）。动作类消息仍照旧按 id 精确注入（v6.49 意图不变）。
    if (onlyAct && _injIds.length && opts.rateRetryReplay !== true) {   // 修正（2026-10-08）：限流重放路径跳过二次过滤（原唤醒已判动作类），防 :2259 再丢
      try {
        const _rows = (typeof mb.fetchInboundByIds === 'function') ? (mb.fetchInboundByIds(role, s.id, _injIds) || []) : [];
        const _okIds = new Set(_rows.filter((m) => isActionableType(m, cfg)).map((m) => String(m.id)));
        _injIds = _injIds.filter((x) => _okIds.has(String(x)));
      } catch { _injIds = []; }
    }
    if (!unread.length && !pend && !_injIds.length) return { ok: false, reason: (onlyAct && unreadAll.length) ? 'no-actionable' : 'no-unread' };
    // 修正（2026-10-08·主我覆盖指令 3）：**不再**在此清重排——unread 口径看不到 ≠ 已 resolved（那正是搁浅成因）；
    //   清空只发生在"真正唤醒成功"(:下方 _clearRateRetry) 或"重排时消息已 resolved"。
    // v6.26 方案B：速率窗兜底——每会话窗口内最多自动唤醒 N 次，超限跳过（消息仍在库，下次交互注入读到）
    // P2b-9：超限不再静默丢弃——按窗口剩余时间保底重排，确保"下一窗口被唤醒"（ADR §2.5/G8）。
    if (_wakeRateExceeded(s.id, cfg)) { _scheduleRateLimitRetry(s.id, _injIds); return { ok: false, reason: 'rate-limited' }; }
    _clearRateRetry(s.id);
    runChat(s.id, '', { internalMailbox: true, mailboxWake: true, origin: 'mailbox', injectMsgIds: _injIds.length ? _injIds : null }).catch((e) => { try { console.log('[mailbox-wake] runChat 异常: ' + (e && e.message) + ' sid=' + s.id); } catch { } });
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/** 动作类型（非静默）：仅这些类型驱动"唤醒/续跑"；静默类型(reply/ack/notify，见 cfg.mailboxSilentTypes)
 *  只落库/上屏/写标记，不唤醒、不起续跑轮（防"回执乒乓"）。缺省类型视为动作类（server 默认 type=task）。
 *  ★P0② 双型兼容（双型兼容修订）：入参可为 **type 字符串** 或 **消息对象 m**——
 *    - 字符串：原行为（按 type 判定）；
 *    - 对象：取 m.type；且 **wake_intent==='actionable'** 时一律视为动作类
 *      （用于 task-state done 的 notify 显式获得唤醒能力）。
 *    任一处漏改传字符串不得静默误判（否则 String({type:'reply'}) 落 silent 外→true→自激复活）。 */
function isActionableType(x, cfg) {
  const t = (typeof x === 'string') ? x : ((x && x.type) || 'task');
  // P2（R3）：唤醒意图改读 notify_target（新列）优先，回退兼容列 wake_intent。
  const notifyTarget = (x && typeof x === 'object') ? ((x.notify_target != null) ? x.notify_target : x.wake_intent) : null;
  // v6.50（定案 A·判据单源）：统一委派 mailbox.classify() —— 与写侧/读侧**同一分类函数**，杜绝散点各判漂移。
  try { const mb = require('./mailbox'); if (mb && typeof mb.classify === 'function') return !!mb.classify(x, { cfg }).wakeable; } catch { }
  try { const mb = require('./mailbox'); if (mb && typeof mb.pendingByMessage === 'function') return mb.pendingByMessage(t, notifyTarget); } catch { }
  if (String(notifyTarget || '') === 'actionable') return true;
  // P2b-1 T1/T3：result（应答）**仅在确有关单归属**（wake_intent='actionable'，即"首个关单"）时动作，
  //   否则视为知情类 → 不驱动唤醒/续跑，防"同 cid 第二个 result"重复放大唤醒（E2）。
  if (String(t || 'task') === 'result') return false;
  const silent = (cfg && Array.isArray(cfg.mailboxSilentTypes)) ? cfg.mailboxSilentTypes : ['reply', 'ack', 'notify'];
  return !silent.includes(String(t || 'task'));
}

/** 低优兜底（2026-10-03）：入站 task 回执 / 部署事件到达时，按 cid / meta.refs|artifacts / 正文长 token
 *  关键词反查**本会话 openTodos**，命中则输出"疑似可勾销 <原文>"提示——**仅提示、绝不自动勾销**（防误勾）。
 *  数据源：branch.fold(sid) 的 openTodos（与任务现场同源）。纯读，无副作用，绝不抛。
 *  @returns {string} '' 或 '\n\n## 疑似可勾销（仅提示，确认后再勾销）\n- ...' */
function buildSuspectTodoHint(sid, msgs) {
  try {
    const list = Array.isArray(msgs) ? msgs : [];
    if (!sid || !list.length) return '';
    const f = (() => { try { return branch.fold(sid, 1) || null; } catch { return null; } })();
    const todos = (f && f.openTodos) || [];
    if (!todos.length) return '';
    const kws = new Set();
    for (const m of list) {
      if (!m) continue;
      const t = String(m.type || '');
      if (!(t === 'result' || t === 'task' || t === 'reply' || m.outcome != null)) continue;   // 仅回执/任务/部署类
      if (m.correlation_id) kws.add(String(m.correlation_id));
      let meta = null; try { meta = m.meta ? (typeof m.meta === 'string' ? JSON.parse(m.meta) : m.meta) : null; } catch { }
      if (meta) for (const k of ['refs', 'artifacts']) { const v = meta[k]; if (Array.isArray(v)) for (const x of v) if (x) kws.add(String(x)); }
      const c = String(m.content || '');
      for (const tok of c.split(/[\s,;，；、()（）\[\]{}"'`<>]+/)) { if (tok.length >= 8 && /[\/\\.]/.test(tok)) kws.add(tok); }
    }
    const keys = [...kws].filter((k) => k && k.length >= 6);
    if (!keys.length) return '';
    const hits = [];
    for (const todo of todos) {
      const tt = String(todo);
      const hit = keys.find((k) => tt.includes(k));
      if (hit) hits.push({ todo: tt, key: hit });
      if (hits.length >= 5) break;
    }
    if (!hits.length) return '';
    return '\n\n## 疑似可勾销（仅提示，确认后再勾销）\n'
      + hits.map((h) => `- ${h.todo.replace(/\s+/g, ' ').slice(0, 80)}（关联 ${h.key.slice(0, 40)}）`).join('\n');
  } catch { return ''; }
}

/** 会诊定案 C（2026-09-30）：收敛入站注入管线——两个来源（unread 未读 / msgIds 按 id 补注入）
 *  共用同一「取正文→建前缀」逻辑，忙/闲同一条路。纯函数：不落库、不 markRead（副作用由调用方做）。
 *  - unread：调用方已按 isDisp 口径取好的未读消息数组；
 *  - msgIds：补唤醒按 id 精确注入（经 mailbox.fetchInboundByIds，**不按 read_at 过滤**，限本会话+未终态）。
 *  两来源按 id 合并去重；返回与 selectMailboxBatch 同构的节点头。
 *  @returns {{prefix:string, consumed:Array, ids:Set<string>, anyAct:boolean, total:number, shown:number}} */
function buildInboundPrefix({ role, sid, unread, msgIds, cfg } = {}) {
  const mb = require('./mailbox');
  const list = Array.isArray(unread) ? unread.slice() : [];
  if (Array.isArray(msgIds) && msgIds.length && typeof mb.fetchInboundByIds === 'function') {
    try {
      const byIds = mb.fetchInboundByIds(role, sid, msgIds) || [];
      const seen = new Set(list.map((m) => String(m.id)));
      for (const m of byIds) { if (m && !seen.has(String(m.id))) { seen.add(String(m.id)); list.push(m); } }
    } catch { }
  }
  const ids = new Set(list.map((m) => (m && m.id != null) ? String(m.id) : ''));
  if (!list.length) return { prefix: '', consumed: [], ids, anyAct: false, total: 0, shown: 0 };
  const batch = selectMailboxBatch(list, cfg);
  const shown = batch.shown, lines = batch.lines, consumed = batch.consumed;
  const anyAct = list.some((m) => isActionableType(m, cfg));
  const prefix = `[信箱 ${list.length} 条${shown < list.length ? `，本回合展示 ${shown} 条` : ''}${anyAct ? '' : '·均系回执/通知，仅供知晓无需回复'}]\n`
    + lines.join('\n')
    + (shown < list.length ? `\n\n（还有 ${list.length - shown} 条未读，需完整内容请用 agent_inbox 查看）` : '')
    + buildSuspectTodoHint(sid, list)   // 低优兜底：回执/部署事件疑似可勾销提示（仅提示）
    + '\n\n';
  return { prefix, consumed, ids, anyAct, total: list.length, shown };
}

/** 未读信箱"封顶截断"批次选择（纯函数，供 runChat 注入 + 单测）。
 *  修复：截断时**仅消费实际展示者**（否则被截断消息被误标已读→静默吞消息，实证 m-mulkm615）。
 *  规则：①动作类优先排序（reply/ack/notify 视为知情类靠后），避免重要 task 被 reply 洪流截掉；
 *  ②按 CAP 逐条累加，超限即停；③至少展示 1 条（防单条超 CAP 致永卡死、保证逐批排空）。
 *  @returns {{consumed:Array, lines:string[], shown:number}} */
function selectMailboxBatch(unread, cfg) {
  const CAP = Number(cfg && cfg.mailboxInjectCap) || 8000;           // 注入总量字符封顶
  const perType = (t) => (t === 'reply' ? 600 : 1200);               // reply 只给摘要，task 保留主体
  const silentLbl = (t) => (t === 'reply' ? '（回执摘要·仅供知晓，无需回复）' : ((t === 'ack' || t === 'notify') ? '（通知/确认·仅供知晓，无需回复）' : ''));
  const isSilent = (m) => !isActionableType(m, cfg);   // v6.31：唤醒/动作判定单一口径 = isActionableType
  const ordered = [...(unread || [])].sort((a, b) => (isSilent(a) ? 1 : 0) - (isSilent(b) ? 1 : 0));   // 稳定排序
  const lines = []; let used = 0, shown = 0;
  for (const m of ordered) {
    const body = String(m.content).slice(0, perType(m.type));
    // P2b-6→P2b-12：task 行注入 **完整** correlation_id（短码会导致 closeTaskByCid 精确失配、发起方不被唤醒）。
    const cidTag = (m.type === 'task' && m.correlation_id) ? ` [cid=${String(m.correlation_id)}]` : '';
    const line = `${m.from_id}${cidTag}${silentLbl(m.type)}: ${body}`;
    if (shown > 0 && used + line.length > CAP) break;   // 至少展示 1 条 → 保证逐批排空、防死循环
    lines.push(line); used += line.length; shown++;
  }
  return { consumed: ordered.slice(0, shown), lines, shown };
}

/** 唤醒盲区根治（判定）：本会话当前是否"空闲且有未读"（供回合收尾复查未读用；纯读、无副作用）。 */
function idleUnreadReady(sessionId) {
  try {
    const cfg = loadConfig();
    if (cfg.mailboxInstantWake === false) return false;
    const s = getSession(sessionId);
    if (!s || s.running || s._compactBusy) return false;
    const mb = require('./mailbox');
    const role = selfRole();
    if (!mb.available() || !role) return false;
    const unread = mb.fetchUnreadForSession(role, s.id, 20) || [];
    // v6.26 方案A：与 wakeMailbox 同口径——仅"动作类"视为可唤醒（reply/ack/notify 不驱动新回合）
    const actionable = (cfg.mailboxWakeOnlyActionable !== false) ? unread.filter((m) => isActionableType(m, cfg)) : unread;
    if (actionable.length > 0) return true;
    // v6.32：无动作类未读时，若存在未投递入站项（延迟队列/已落库未注入）→ 仍视为可唤醒（liveness）。
    return _pendingDrainOn() && _hasUndeliveredInbound(s);
  } catch { return false; }
}

/** D4 唤醒盲区根治（诊断）：输出本次 sweep 尝试的判定细节（供下次直查日志定位）。 */
function _sweepDiag(sessionId, why) {
  try {
    const cfg = loadConfig();
    const s = getSession(sessionId);
    let unreadN = -1, actN = -1;
    try {
      const mb = require('./mailbox');
      const role = selfRole();
      if (mb.available() && role && s) { const _u = mb.fetchUnreadForSession(role, s.id, 20) || []; unreadN = _u.length; actN = _u.filter((m) => isActionableType(m, cfg)).length; }
    } catch { }
    console.log(`[mailbox-sweep] sid=${sessionId} ${why} running=${s ? !!s.running : 'null'} compactBusy=${s ? !!s._compactBusy : 'null'} unread=${unreadN} actionable=${actN} instantWake=${cfg.mailboxInstantWake}`);
  } catch { }
}

/** D4：强制唤醒（跳过未读判定，仅要求空闲）——用于"忙时到达但未注入本回合"的补唤醒。
 *  与 wakeMailbox 同守卫（running/_compactBusy/just-stopped/可用性），仅省去 unread 检查。
 *  （消息的 [雷影回执] 标记已由 flushPendingInbound 落入历史，唤醒一回合即可被处理。） */
function wakeMailboxForced(sessionId, opts = {}) {
  try {
    const cfg = loadConfig();
    if (cfg.mailboxInstantWake === false) return { ok: false, reason: 'disabled' };
    const s = getSession(sessionId);
    if (!s) return { ok: false, reason: 'no-session' };
    if (s.running || s._compactBusy) { try { enqueueRoleDrain(selfRole(), { delayMs: 1500 }); } catch { } return { ok: false, reason: 'busy' }; }   // P6：busy 不丢，登记 drain
    const suppressMs = (() => { const v = Number(cfg.postStopSuppressMs); return Number.isFinite(v) ? v : 3000; })();
    if (suppressMs > 0 && s._stoppedAt && (Date.now() - s._stoppedAt) < suppressMs) { try { enqueueRoleDrain(selfRole(), { delayMs: suppressMs + 200 }); } catch { } return { ok: false, reason: 'just-stopped' }; }   // P6-S2
    // v6.26 方案A：强制补唤醒亦仅认动作类——reply/ack/notify 不驱动新回合（可见性由 SSE 上屏 + 回合起始注入保住）
    const mb = require('./mailbox'); const role = selfRole();
    if (cfg.mailboxWakeOnlyActionable !== false && mb.available() && role && !opts.skipUnread) {
      const unread = mb.fetchUnreadForSession(role, s.id, 20) || [];
      // v6.32：强制分支跳过 actionable 过滤——只要"存在未投递入站项"即可唤醒一次（治 D4 对 reply-only 空操作）。
      const _hasPend = _pendingDrainOn() && _hasUndeliveredInbound(s);
      if (!unread.some((m) => isActionableType(m, cfg)) && !_hasPend) return { ok: false, reason: 'no-actionable' };
    }
    // v6.26 方案B：速率窗兜底（与 wakeMailbox 同口径）
    if (_wakeRateExceeded(s.id, cfg)) return { ok: false, reason: 'rate-limited' };
    runChat(s.id, '', { internalMailbox: true, mailboxWake: true, origin: 'mailbox', injectMsgIds: (opts && opts.injectMsgIds) || null }).catch((e) => { try { console.log('[mailbox-wake] runChat 异常: ' + (e && e.message) + ' sid=' + s.id); } catch { } });
    return { ok: true, forced: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/** P2b-4 T1：接收方忙时收到同 cid 的新版本（rev>1）→ 置 pending_revision + 回合边界 abort。
 *  未在跑则直接 wakeMailboxForced 拉最新版。abort 后的重注入由 runChat 的 finally 显式复用 wakeMailboxForced 完成。
 *  纯内存操作（不写库、不起/停其它会话），离线可测。 */
function abortTurnForRevision(sessionId, cid) {
  try {
    const s = getSession(sessionId);
    if (!s) return { ok: false, reason: 'no-session' };
    s._pendingRevision = { cid: String(cid || ''), at: Date.now() };
    const aborted = !!(s.running && s.controller && !(s.controller.signal && s.controller.signal.aborted));
    if (aborted) {
      try { s.controller.abort(); } catch { }
      try { s._abortedAt = Date.now(); } catch { }
      return { ok: true, aborted: true };
    }
    if (s.running) return { ok: true, aborted: false, note: '运行中但无 controller' };
    return { ok: true, aborted: false, wake: wakeMailboxForced(sessionId) };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/** P2b-4 T1：修订 abort 收尾 —— 显式复用 wakeMailboxForced 强注入最新版。
 *  清 just-stopped 抑制窗确保立即 forced wake，并加 3.5s 兜底重试越过速率窗。返回 {ok,cid,wake}。 */
function reinjectPendingRevision(sessionId) {
  try {
    const s = getSession(sessionId);
    if (!s || !s._pendingRevision) return { ok: false, reason: 'none' };
    const cid = (s._pendingRevision && s._pendingRevision.cid) || '';
    s._pendingRevision = null;
    try { s._stoppedAt = 0; } catch { }
    const wake = wakeMailboxForced(sessionId);
    setTimeout(() => { try { wakeMailboxForced(sessionId); } catch { } }, 3500);
    // P6-S7（refs=mailbox-structural）：重注入失败（忙/被停）→ 登记 drain 兜底，防 abort 后重注入失败又造新孤儿。
    if (!(wake && wake.ok)) { try { enqueueRoleDrain(selfRole(), { delayMs: 3500 }); } catch { } }
    return { ok: true, cid, wake };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/** 唤醒盲区根治（单次复查）：回合收尾复查未读——空闲且有未读则唤醒一次。
 *  force=true（D4）：本回合有"忙时到达但未被注入本回合"的消息 → 即使 unread 为空也补唤醒。
 *  wakeFn 仅供离线测试注入，默认 wakeMailbox（其内自带"空闲+有未读"二次守卫，幂等）。 */
function sweepIdleUnread(sessionId, wakeFn, force) {
  let woke = false;
  try {
    const s = getSession(sessionId);
    const idle = !!(s && !s.running && !s._compactBusy);
    // v6.32：统一 sweeper——空闲时**先排空 pending 队列**（成功才清 + 落盘），再判 wake。
    if (idle && _pendingDrainOn()) { try { const _dn = drainPendingInbound(s, {}); if (_dn) saveSession(s); } catch { } }
    const ready = idleUnreadReady(sessionId);
    if (ready || (force && idle)) {
      const f = (typeof wakeFn === 'function') ? wakeFn : (force ? wakeMailboxForced : wakeMailbox);
      const r = f(sessionId);
      woke = !(r && r.ok === false);
      _sweepDiag(sessionId, `attempt(ready=${ready} force=${!!force}) -> ${woke ? 'WOKE' : 'skip:' + ((r && r.reason) || '?')}`);
    } else {
      _sweepDiag(sessionId, `attempt(ready=${ready} force=${!!force}) -> skip:${idle ? 'no-unread' : 'busy'}`);
    }
    // v6.50（定案 C）：空闲会话里"已展示但不会驱动回合"的非动作类入站 → 静默标读（read 语义=已展示）。
    //   仅空闲时做；minAge 保证 SSE mailbox-message 早已上屏（时序 ≥ 上屏）。
    if (idle) { try { const mb = require('./mailbox'); if (mb.available && mb.available() && typeof mb.sweepSilentRead === 'function') mb.sweepSilentRead(selfRole(), { minAgeMs: _silentReadMinAgeMs(), excludeSessionIds: _runningSessionIds() }); } catch { } }
  } catch { }
  return woke;
}

/** v6.50：静默收口最小年龄（默认 60s，保证 SSE 上屏先于标读）。 */
function _silentReadMinAgeMs() { try { const v = Number(loadConfig().mailboxSilentReadMinAgeMs); return Number.isFinite(v) && v >= 0 ? v : 60000; } catch { return 60000; } }
/** v6.50：本实例运行中/压缩中的会话 id 列表（静默标读需排除，防"正在注入的会话被标读"）。 */
function _runningSessionIds() {
  const out = [];
  try { for (const s of listSessions()) { if (s && (s.running || s._compactBusy)) out.push(s.id); } } catch { }
  return out;
}
/** v6.50（定案 C/D·周期驱动）：角色级静默收口非动作类未读——供 server 周期调用（空闲会话不再残留未读）。 */
function sweepIdleSilentReads() {
  try {
    const mb = require('./mailbox');
    const role = selfRole();
    if (!mb.available() || !role || typeof mb.sweepSilentRead !== 'function') return 0;
    return mb.sweepSilentRead(role, { minAgeMs: _silentReadMinAgeMs(), excludeSessionIds: _runningSessionIds() });
  } catch { return 0; }
}

/** 唤醒盲区根治（调度）：回合收尾复查未读——有界重试（默认 0/5s/30s），
 *  堵"回合已结束、下一回合尚未开始"的间隙投递盲区（忙时到达 / reflect·收尾窗口 / 连续间隙）。
 *  幂等无空转：wakeMailbox 自带"空闲+未读"守卫，消费后复查即 no-unread。
 *  opts.force=true（D4）：存在"忙时到达但未注入本回合"的消息 → 即使未读为空也补唤醒（首轮 + 5s 复查）。
 *  开关 cfg.mailboxIdleUnreadSweep=false 即时回退。 */
function scheduleIdleUnreadSweep(sessionId, opts) {
  try {
    const cfg = loadConfig();
    if (cfg.mailboxIdleUnreadSweep === false) return;
    const force = !!(opts && opts.force);
    const delays = Array.isArray(cfg.mailboxIdleSweepDelaysMs) ? cfg.mailboxIdleSweepDelaysMs : [0, 5000, 30000];
    if (force) { try { console.log(`[mailbox-sweep] sid=${sessionId} 登记收尾补唤醒(force)：忙时到达未注入本回合的消息`); } catch { } }
    for (const d of delays) {
      const t = setTimeout(() => { try { sweepIdleUnread(sessionId, null, force); } catch { } }, Math.max(0, Number(d) || 0));
      try { if (t && typeof t.unref === 'function') t.unref(); } catch { }
    }
  } catch { }
}

const _lostSweepAt = new Map();   // v6.47：sweepLostInboundWakes 的同会话去抖表

/** v6.47（2026-09-30）：唤醒丢失兜底扫描——遍历本实例会话，对"空闲且存在**未起回合处理的动作类入站**"者强制补唤醒。
 *  治：主我 busy 时到达的回执被判 notified_at（决策）却未起回合（silent 投递 + busy + D4 未生效）→ 永久静默。
 *  判据复用 mailbox.listNotWokeInbound（未读 + 未注入 + 动作类 + 非终态 + cid 无 woke_at）。
 *  opts: {minAgeMs, wakeFn(测试注入), sessionIds(限定)}。返回 {checked,woke}。绝不抛。 */
function sweepLostInboundWakes(opts = {}) {
  const out = { checked: 0, woke: 0 };
  try {
    const cfg = loadConfig();
    if (cfg.mailboxLostWakeSweep === false) return out;
    const role = selfRole();
    const mb = require('./mailbox');
    if (!role || !mb.available()) return out;
    const minAgeMs = Number.isFinite(Number(opts.minAgeMs)) ? Math.max(0, Number(opts.minAgeMs))
      : (Number.isFinite(Number(cfg.mailboxLostWakeMinAgeMs)) ? Number(cfg.mailboxLostWakeMinAgeMs) : 90000);
    const ids = Array.isArray(opts.sessionIds) ? opts.sessionIds : null;
    const now = Date.now();
    for (const s of listSessions()) {
      try {
        if (!s || s.archived || s.trashedAt) continue;
        if (ids && !ids.includes(s.id)) continue;
        if (s.running || s._compactBusy) continue;             // 只补空闲会话
        out.checked++;
        if (!mb.hasNotWokeInbound(role, s.id, { minAgeMs })) continue;
        // 同会话 sweep 去抖（默认 60s 内不重复扫，防抖）
        const last = Number((_lostSweepAt.get(s.id) || 0));
        const gap = Number.isFinite(Number(cfg.mailboxLostWakeDebounceMs)) ? Number(cfg.mailboxLostWakeDebounceMs) : 60000;
        if (now - last < gap) continue;
        _lostSweepAt.set(s.id, now);
        const f = (typeof opts.wakeFn === 'function') ? opts.wakeFn : wakeMailboxForced;
        const rr = f(s.id);
        if (!(rr && rr.ok === false)) out.woke++;
        try { console.log(`[mailbox-sweep] sid=${s.id} 唤醒丢失兜底 → ${rr && rr.ok === false ? 'skip:' + rr.reason : 'WOKE'}`); } catch { }
      } catch { }
    }
  } catch { }
  return out;
}

/** v6.53（2026-09-30）：知情类回执「空闲兜底唤醒」扫描——遍历本实例会话，对"空闲且存在**超阈值未读的不可唤醒知情类**"（reply/ack/notify/result，v6.53b）
 *  者补唤醒**一次**（注入这批回执的摘要，走既有 buildInboundPrefix 管线）。
 *  治：reply/ack/notify 无 cid 且无 open task → wakeDecision 不唤醒、未读续跑亦排除 → 主我空闲时永久漏收（实测 m-muo8el3o）。
 *  与 sweepLostInboundWakes（动作类）互补：本函数**只兜底知情类**，不改"reply 不驱动回合"策略（受配置+空闲+超时+去重四重约束）。
 *  幂等：命中批次唤醒成功后写入 silent_wake_log（同批只提醒一次，被消费后不再命中）。
 *  opts: {minAgeMs, wakeFn(测试注入), sessionIds(限定)}。返回 {checked,woke}。绝不抛。 */
function sweepStaleSilentInboundWakes(opts = {}) {
  const out = { checked: 0, woke: 0 };
  try {
    const cfg = loadConfig();
    if (cfg.mailboxStaleInboundWake === false) return out;
    const role = selfRole();
    const mb = require('./mailbox');
    if (!role || !mb.available() || typeof mb.listStaleSilentInbound !== 'function') return out;
    const minAgeMs = Number.isFinite(Number(opts.minAgeMs)) ? Math.max(0, Number(opts.minAgeMs))
      : (Number.isFinite(Number(cfg.mailboxStaleInboundWakeMs)) ? Number(cfg.mailboxStaleInboundWakeMs) : 45000);
    const ids = Array.isArray(opts.sessionIds) ? opts.sessionIds : null;
    for (const s of listSessions()) {
      try {
        if (!s || s.archived || s.trashedAt) continue;
        if (ids && !ids.includes(s.id)) continue;
        if (s.running || s._compactBusy) continue;             // 只兜底空闲会话
        out.checked++;
        const rows = mb.listStaleSilentInbound(role, s.id, { minAgeMs }) || [];
        if (!rows.length) continue;
        const msgIds = rows.map((r) => String(r.id)).filter(Boolean);
        const f = (typeof opts.wakeFn === 'function') ? opts.wakeFn : wakeMailboxForced;
        const rr = f(s.id, { skipUnread: true, injectMsgIds: msgIds });
        const froms = [...new Set(rows.map((r) => r.from_id))].join(',');
        const cids = rows.map((r) => r.correlation_id || '-').join(',');
        if (rr && rr.ok === false) {
          try { console.log(`[mailbox-stale-wake] sid=${s.id} 兜底跳过:${rr.reason} n=${rows.length} from=${froms}`); } catch { }
          continue;
        }
        out.woke++;
        try { mb.markStaleSilentNotified(msgIds); } catch { }
        try { console.log(`[mailbox-stale-wake] sid=${s.id} n=${rows.length} from=${froms} cid=${cids} → WOKE`); } catch { }
      } catch { }
    }
  } catch { }
  return out;
}

/**
 * B②（2026-10-10）：已投递未注入兜底唤醒——空闲会话存在 delivered=1 且 injected_at IS NULL 的入站 →
 *  强制补唤醒一次（幂等：注入后 injected_at 落值即不再命中）。防"投递了但没消费"。
 *  opts: {minAgeMs, wakeFn(测试注入), sessionIds(限定)}。返回 {checked,woke}。绝不抛。 */
function sweepDeliveredUninjectedWakes(opts = {}) {
  const out = { checked: 0, woke: 0 };
  try {
    const role = selfRole();
    const mb = require('./mailbox');
    if (!role || !mb.available() || typeof mb.listDeliveredUninjected !== 'function') return out;
    const minAgeMs = Number.isFinite(Number(opts.minAgeMs)) ? Math.max(0, Number(opts.minAgeMs)) : 60000;
    const ids = Array.isArray(opts.sessionIds) ? opts.sessionIds : null;
    for (const s of listSessions()) {
      try {
        if (!s || s.archived || s.trashedAt) continue;
        if (ids && !ids.includes(s.id)) continue;
        if (s.running || s._compactBusy) continue;             // 只兜底空闲会话
        out.checked++;
        const rows = mb.listDeliveredUninjected(role, s.id, { minAgeMs }) || [];
        if (!rows.length) continue;
        const msgIds = rows.map((r) => String(r.id)).filter(Boolean);
        const f = (typeof opts.wakeFn === 'function') ? opts.wakeFn : wakeMailboxForced;
        const rr = f(s.id, { skipUnread: true, injectMsgIds: msgIds });
        const froms = [...new Set(rows.map((r) => r.from_id))].join(',');
        if (rr && rr.ok === false) {
          try { console.log(`[mailbox-deliv-wake] sid=${s.id} 兜底跳过:${rr.reason} n=${rows.length} from=${froms}`); } catch { }
          continue;
        }
        out.woke++;
        try { console.log(`[mailbox-deliv-wake] sid=${s.id} n=${rows.length} from=${froms} → WOKE`); } catch { }
      } catch { }
    }
  } catch { }
  return out;
}

// —— 主回合 ——

/**
 * 执行一轮对话（含多轮工具调用）。
 * @param {string} sessionId
 * @param {string} content user 消息正文（goals 会传入 [自治任务] 文本）
 * @param {object} opts { evt, forceReflect, maxIterations }
 * @param {object} opts.evt 事件回调 {start,reasoning,delta,tool,tool_result,done,error}
 */
/** v6.7：让工具调用可被回合中止——与 abort signal 竞速；signal abort 时以 Error reject，
 *  从而解开 `await tools.exec(...)` → 走到 finally → 释放 s.running（根治"工具卡死 → running 永不释放"）。
 *  注意：abort/reject 后务必移除事件监听（防泄漏）。 */
function raceToolAbort(execFn, signal, timeoutMs) {
  const tmo = Number(timeoutMs) || 0;
  if (!signal && tmo <= 0) return Promise.resolve().then(execFn);
  if (signal && signal.aborted) return Promise.reject(new Error('回合已中止'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      try { if (signal) signal.removeEventListener('abort', onAbort); } catch { }
      try { if (timer) clearTimeout(timer); } catch { }
    };
    const onAbort = () => { if (settled) return; settled = true; cleanup(); reject(new Error('回合已中止')); };
    // v6.24：通用工具硬超时——任何工具（含未来新增）超时即 reject，回合据此写入"[工具错误]"结果继续，
    // 杜绝"某个工具永不返回 → await 挂死整个回合、只能靠 reaper 强杀"。
    const onTimeout = () => { if (settled) return; settled = true; cleanup(); reject(new Error(`工具执行超时（${Math.round(tmo / 1000)}s），已强制中断以防挂死回合`)); };
    if (signal) signal.addEventListener('abort', onAbort);
    if (tmo > 0) timer = setTimeout(onTimeout, tmo);
    Promise.resolve().then(execFn).then(
      (v) => { if (settled) return; settled = true; cleanup(); resolve(v); },
      (e) => { if (settled) return; settled = true; cleanup(); reject(e); },
    );
  });
}

/** v6.24：单次工具执行硬超时(ms)——读 config.toolHardTimeoutMs，缺省 300000(5min)，0=关。 */
function toolHardTimeoutMs() {
  try {
    const v = Number(loadConfig().toolHardTimeoutMs);
    if (Number.isFinite(v) && v >= 0) return v;
  } catch { }
  return 300000;
}

/** v6.7：回合硬上限（ms）——running 超此即判卡死强制释放；默认 max(watchdog*3, 600000)。 */
function turnHardCapMs() {
  const c = loadConfig();
  const v = Number(c.turnHardCapMs);
  if (Number.isFinite(v) && v > 0) return v;
  return Math.max((Number(c.turnWatchdogMs) || 0) * 3, 600000);
}

/** v6.7：是否卡死回合——①已 abort 且距 abort/开始 >60s；②距开始 > 硬上限。 */
function isStuckTurn(s) {
  if (!s || !s.running) return false;
  const now = Date.now();
  const started = Number(s._runStartedAt) || 0;
  const aborted = !!(s.controller && s.controller.signal && s.controller.signal.aborted);
  if (aborted) { const ref = Number(s._abortedAt) || started; if (ref && now - ref > 60000) return true; }
  if (started && now - started > turnHardCapMs()) return true;
  return false;
}

/** v6.7：强制释放卡死回合（告警 + 清运行态），新回合可接管。 */
/** v6.24：清理"被强制中断回合"留下的脏状态——①移除悬空 tool_calls（无对应 tool 结果）；
 *  ②去重（_recovered 草稿与紧邻上一条 assistant 文本重复则删除）；③补一条用户可见的中断提示。
 *  返回是否发生改动（用于落盘）。 */
function repairInterruptedTurn(s) {
  if (!s || !Array.isArray(s.messages)) return false;
  let changed = false;
  // ① 悬空 tool_calls：收集已应答 id，任何未被应答的 tool_call 从 assistant.toolCalls 移除（全无则删字段）
  const answered = new Set();
  for (const m of s.messages) if (m.role === 'tool' && m.toolCallId != null) answered.add(String(m.toolCallId));
  for (const m of s.messages) {
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      const kept = m.toolCalls.filter((t) => t && t.id != null && answered.has(String(t.id)));
      if (kept.length !== m.toolCalls.length) {
        if (kept.length) m.toolCalls = kept; else delete m.toolCalls;
        changed = true;
      }
    }
  }
  // ② 去重：_recovered 的 assistant 若与紧邻上一条 assistant 文本完全相同 → 删除
  for (let i = s.messages.length - 1; i > 0; i--) {
    const m = s.messages[i], p = s.messages[i - 1];
    if (m && m.role === 'assistant' && m._recovered && p && p.role === 'assistant'
        && String(p.content || '').trim() === String(m.content || '').trim()) {
      s.messages.splice(i, 1);
      changed = true;
    }
  }
  // ③ 用户可见的中断提示（仅在确有清理动作、且末条非中断提示时补一条，防重复）
  const last = s.messages[s.messages.length - 1];
  if (changed && !(last && last._interrupted)) {
    s.messages.push({ role: 'assistant', content: '（上一回合被系统强制中断：工具未返回结果。请重发或继续说，我会继续。）', _interrupted: true });
  }
  if (changed) { try { saveSession(s); } catch { } }
  return changed;
}

function forceReleaseStuckTurn(s, where) {
  const el = (s && s._runStartedAt) ? Date.now() - s._runStartedAt : 0;
  console.error(`[reaper] 强制释放卡死回合 session=${s && s.id} where=${where} elapsedMs=${el}`);
  // v6.9：收割时对本回合已消费的动作类入站 task 补回写（防 reaper 强杀后假待办续跑循环）
  try {
    const mb = require('./mailbox');
    const ids = (s && s._turnConsumedIds && s._turnConsumedIds.size) ? [...s._turnConsumedIds] : [];
    if (s && s._turnConsumedInfoIds && s._turnConsumedInfoIds.size) for (const id of s._turnConsumedInfoIds) ids.push(id);
    if (ids.length && mb.available() && mb.sendInterruptedResults) mb.sendInterruptedResults(ids, { fromRole: selfRole(), fromSessionId: s.id, outcome: 'failed', content: '⚠ 回合被中断，未产生结果，请重发' });
  } catch { }
  try { s._turnConsumedIds = null; } catch { }
  try { s._turnConsumedInfoIds = null; } catch { }
  try { s.running = false; s.controller = null; s._runStartedAt = 0; s._abortedAt = 0; } catch { }
  try { if (typeof s.replyDraft === 'string' && s.replyDraft.trim()) recoverDraft(s); } catch { }
  // v6.24：干净收尾——移除悬空 tool_calls、去重、补可见中断提示（防"释放后留下非法 wire / 重复消息"）
  try { repairInterruptedTurn(s); } catch { }
  try { require('./mailbox').clearBusy(selfRole()); } catch { }
}

/** 世界树·支干（P0）：规则生成一轮 turn 摘要（user 首行 + 末条 assistant 首句，拼接≤50 字）。 */
/** C（2026-09-29）：派单驱动归枝——从入站 task 消息解析枝键。
 *  优先 meta.topic / topic 字段；无则从正文推导（开头【…】标题→去掉"任务·"等前缀；否则前 12 字有效文本）。
 *  @returns {string} 归一后的枝键（空串=无法解析） */
function deriveTaskTopic(text) {
  try {
    const t = String(text == null ? '' : text).replace(/^\s+/, '');
    const m = t.match(/^\s*【([^】]{1,40})】/);
    let s = m ? m[1] : '';
    if (!s) { const first = t.split('\n').map((x) => x.trim()).find(Boolean) || ''; s = first.slice(0, 12); }
    s = String(s).replace(/^\s*(任务|派单|指令|会诊|实现|修复|修|核验|通知|结果|回执)\s*[·:：\-—\s]\s*/, '').trim();
    return s.slice(0, 24);
  } catch { return ''; }
}
/** C：从一条入站消息解析枝键（meta.topic → 顶层 topic → 正文推导）。 */
function resolveTaskTopic(m) {
  try {
    let tk = '';
    if (m && m.topic) tk = String(m.topic).trim();
    if (!tk && m && m.meta) { try { const o = JSON.parse(String(m.meta)); if (o && o.topic) tk = String(o.topic).trim(); } catch { } }
    if (!tk) tk = deriveTaskTopic(m && m.content);
    return String(tk || '').slice(0, 24);
  } catch { return ''; }
}

function branchTurnSummary(content, text, toolNames) {
  try {
    // A（2026-09-29）：骨架可读性升级——改走**纯规则合成**（用户实义片段 → 助手结论/末段 + 〔工具名〕，≤120 字）。
    //   跳过纯应答行/短行取实义；助手侧优先结论句、否则末段（开头常是语气词）；**零 LLM**。连续性不变（仍 1 轮 1 骨架）。
    return require('./branch').composeTurnSummary({ userText: content, assistantText: text, toolNames });
  } catch { return ''; }
}

// —— 内部回合正文实时上屏（turn-stream）：按 sessionId+kind 累积增量，节流广播，避免逐 token 刷屏 ——
//    仅内部回合（无每请求流 sink）调用；前端发起的回合走自身 SSE，不调用。
const _streamBuf = new Map();   // `${sid}|${kind}` → { sid, kind, delta, timer }
const STREAM_FLUSH_MS = 300, STREAM_FLUSH_CHARS = 200;
function flushTurnStream(key) {
  const b = _streamBuf.get(key);
  if (!b) return;
  if (b.timer) { try { clearTimeout(b.timer); } catch { } b.timer = null; }
  if (b.delta) {
    const delta = b.delta; b.delta = '';
    try { runtime.emit('turn-stream', { sessionId: b.sid, kind: b.kind, delta }); } catch { }
  }
}
/** 累积一段增量；满 200 字符立即 flush，否则 300ms 后 flush（首段起定时器）。 */
function emitTurnStream(sid, kind, d) {
  if (!sid || !d) return;
  const key = `${sid}|${kind}`;
  let b = _streamBuf.get(key);
  if (!b) { b = { sid, kind, delta: '', timer: null }; _streamBuf.set(key, b); }
  b.delta += d;
  if (b.delta.length >= STREAM_FLUSH_CHARS) { flushTurnStream(key); return; }
  if (!b.timer) b.timer = setTimeout(() => flushTurnStream(key), STREAM_FLUSH_MS);
}
/** 回合结束：flush 该会话两个 kind 的余量（runChat finally 调用）。 */
function flushTurnStreamSession(sid) {
  if (!sid) return;
  flushTurnStream(`${sid}|text`);
  flushTurnStream(`${sid}|reasoning`);
}

/** 迭代账目提示·纯判据（导出供离线单测）：按调用次数 N 生成待追加文案，或 null（不追加）。
 *  触发：threshold>0 且 N===threshold，或 N>threshold 且 (N-threshold)%repeat===0（cadence）。
 *  turnProgOps=0 且 N>=threshold*2 → 加重"疑似试错空转"。 */
function buildIterHint(N, threshold, repeat, progOps) {
  const th = Number(threshold), rep = Number(repeat);
  if (!(th > 0)) return null;                 // ≤0 = 关闭（等价旧版）
  if (N < th) return null;
  const rp = rep > 0 ? rep : 4;
  if (N !== th && (N - th) % rp !== 0) return null;
  const heavy = (Number(progOps) || 0) === 0 && N >= th * 2
    ? '（已多次调用但无实质进展，疑似试错空转，建议换策略或请示）' : '';
  return `\n\n〔迭代账目〕本回合已第 ${N} 次工具调用（实质进展 ${Number(progOps) || 0} 次）。若收尾在望，请优先"批量探测/先想清再跑/合并命令/回执批量处理"，减少往返。${heavy}`;
}

/** ① B 窗口余量提示·纯判据（导出供离线单测）。主我侧在工具结果尾注入前缀窗口状态。
 *  hist 口径与 tools.assertSafeWindow 一致：真实 prompt − system前缀 − tools schema；无真实值回退本地估算。 */
function pfxWindowHist(s) {
  const real = Number((s && s._lastPromptTokens) || 0);
  let spTok = 0, toolsTok = 0;
  try {
    const sp = require('./prompt').systemPrompt();
    const f = (sp && (sp.full || (typeof sp === 'string' ? sp : ''))) || '';
    spTok = f ? estimateTokens({ content: f }) : 0;
  } catch { }
  try {
    const defs = require('./tools').definitions();
    toolsTok = defs ? estimateTokens({ content: JSON.stringify(defs) }) : 0;
  } catch { }
  if (real > 0) return Math.max(0, real - spTok - toolsTok);
  let hist = 0;
  for (const m of ((s && s.messages) || [])) hist += estimateTokens(m);
  return hist;
}
/** 触发条件=pendingPfx>0 或 hist>60%*拦截线（防噪声）；仅 main（主我侧）注入，雷影返回 null。 */
function buildPfxWindowHint(s, cfg, pendCount, hist) {
  try {
    if (!(cfg && cfg.agent && cfg.agent.isMain)) return null;
    const min = Number((cfg && cfg.prefixGuardMinTokens) || 0) || 40000;
    const n = Number(pendCount) || 0;
    const h = Number(hist) || 0;
    // 失败可见（2026-10-03）：落盘失败项（attempts>0）不再静默——带 target/name/错误摘要注入，达阈值者提示已停自动重试。
    let fails = [];
    try { const q = require('./pfxqueue'); if (q.listFailed) fails = q.listFailed(5) || []; } catch { fails = []; }
    if (!(n > 0 || fails.length > 0 || h > min * 0.6)) return null;
    let line = `\n\n[前缀窗口] 历史≈${Math.round(h)} / 拦截线 ${min} / 待补前缀 ${n}`;
    if (fails.length) {
      const det = fails.map((f) => `${f.target}${f.name ? '/' + f.name : ''}(×${f.attempts}${f.last_err ? ':' + String(f.last_err).slice(0, 40) : ''})`).join('; ');
      line += `\n[前缀落盘失败 ${fails.length} 条] ${det} —— 达${3}次已停止自动重试，需主我处理`;
    }
    return line;
  } catch { return null; }
}

// @会话 v2（2026-10-02）：本轮 @ 目标会话的达成追踪（sessionId → { targets:[id], fulfilled:Set }）。
const _mentionTurnState = new Map();
/** 由 send_to_session 工具在成功送达后调用，标记本回合某目标已达成。 */
function markMentionFulfilled(sessionId, targetId) {
  try { const st = _mentionTurnState.get(String(sessionId)); if (st) st.fulfilled.add(String(targetId)); } catch { }
}
/** 【当前时间】行（本地时区，2026-10-06）：供每轮 user 消息尾注入，让 agent 可靠知时（含周几）。
 *  纯函数、可传 Date 便于测试；不依赖任何会话状态。 */
function currentTimeLine(d) {
  const _d = (d instanceof Date) ? d : new Date();
  const _wd = '日一二三四五六'[_d.getDay()];
  const _p = (x) => String(x).padStart(2, '0');
  return `【当前时间】${_d.getFullYear()}-${_p(_d.getMonth() + 1)}-${_p(_d.getDate())} ${_p(_d.getHours())}:${_p(_d.getMinutes())}:${_p(_d.getSeconds())} 周${_wd}`;
}

async function runChat(sessionId, content, opts = {}) {
  const s = getSession(sessionId);
  // v6.7 卡死回合收割（入口）：running 已超硬上限 / 已 abort 超 60s → 强制释放，新回合接管（防永久"排队中"）
  if (s.running && isStuckTurn(s)) forceReleaseStuckTurn(s, 'runChat入口');
  if (s.running) throw new Error('该会话正在运行中，请稍候或先停止');
  // 等待上一轮"done 之后"的收尾压缩完成（瞬时值通常为 0）；v6.7 加 120s 上限防 _compactBusy 死等
  { const _cb0 = Date.now();
    while (s._compactBusy) {
      if (Date.now() - _cb0 > 120000) { console.error(`[reaper] _compactBusy 等待超限，强制继续 session=${s.id}`); try { s._compactBusy = false; } catch { } break; }
      await new Promise((r) => setTimeout(r, 30));
    } }
  const cfg = loadConfig();
  // 任务② T-C：本轮触发来源（user|mailbox|heartbeat|timer|resume|handoff），仅作标注、不分支。
  const origin = opts.origin || (opts.internalMailbox ? 'mailbox' : 'user');
  s._turnOrigin = origin;
  const evt = opts.evt || {};
  // 内部回合实时上屏：本回合无每请求流 sink（evt.delta 缺失）时，把正文/思考增量节流广播为全局 turn-stream。
  // 有 evt.delta（前端发起的 /api/chat 回合）→ 不发（前端已有自己的 SSE 流，防重复渲染）。
  // P2（R4·2026-09-29）：可见性改绑**会话**——所有回合（含内部唤醒 x-leizai-wake）统一按 sessionId emit turn-stream，
  //   删除"有无用户连接(noStreamSink)"分支。前端 store.streams[sessionId] 据此实时上屏，无需切会话/刷新。
  //   （evt.delta 仍回给发起方连接，二者按 sessionId 幂等消费。）
  const images = Array.isArray(opts.images) ? opts.images.slice(0, 4) : [];
  // v6.56：文件附件（任意文件）——只携带路径元数据，**绝不内联字节**；最多 20 个。
  const attachments = Array.isArray(opts.attachments) ? opts.attachments.slice(0, 20) : [];
  const wd = s.workdir || cfg.workdir;   // 会话级工作目录（缺省用全局）
  s.running = true;
  s._runStartedAt = Date.now();   // v6.7：供卡死收割器判断回合时长
  // v6.4：向共享库上报本实例"正在跑回合"的真实状态（busy 指示器的准确信号；finally 收尾置空）
  // v6.30（2026-09-29）：busy 上报延迟到下方受 try/finally 保护的区段内设置（见 `try {    const sys =`）——
  //   原先在此设 busy，但本行与主 try(≈L2843) 之间若抛异常则 finally 不达 → busy 残留在共享库（前端一直"忙"）。
  //   移入 try 后：未到 LLM 前任何抛出都不会置 busy（无残留）；设过后必经 finally 清理。
  s.controller = new AbortController();
  const startedAt = Date.now();
  // 世界树·支干（P0 / 批A·A2）：本轮 turn_id —— user 轮用稳定键 `<sid>:u:<触发本轮 user 消息 id>`（同轮重放键不变 → 幂等查重有效）；
  //   无 user 消息 id（内部轮/旧调用）回退时间戳（此时 origin≠user）。
  const _userMsgId = (opts && opts.userMsgId != null && String(opts.userMsgId)) ? String(opts.userMsgId) : '';
  const branchTurnId = (origin === 'user' && _userMsgId) ? `${s.id}:u:${_userMsgId}` : `${s.id}:${startedAt}`;
  // v4-2 T-A：世代号解析抽为具名函数（持久层优先；供离线测试直接调用）。
  const branchTurnGen = resolveBranchTurnGen(s.id);
  // —— 自动归档（上下文压缩）通知：本轮若有旧回合被压入归档，发事件让客户端重建聊天窗口，
  //    否则"旧内容已归档、气泡还占着聊天窗口"（一个对话=一个项目，窗口必须跟随归档收拢）。
  //    total = 本会话归档累计条数（徽标显示"累计"而非"本轮"——用户按总量感知）。
  const notifyCompacted = (dropped, gen) => {
    if (!dropped) return;
    let total = 0;
    try { total = memory.archiveCount(s.id); } catch { }
    let g = gen;
    if (!g) { try { g = archiveStore.currentGen(s.id) || 0; } catch { } }
    const d = { sessionId: s.id, dropped, kept: s.messages.length, total, at: Date.now(), gen: g || 0 };
    try { evt.compacted && evt.compacted(d); } catch { }
    runtime.emit('compacted', d);
  };
  // —— v3 世代交接：任何回合起始时若"窗口已超预算"→ 先全量交接，再处理本消息 ——
  //    判定：上次 API 回传的真实 prompt_tokens（_lastPromptTokens）优先，重启后回退估算；
  //    交接 = 全部旧内容归档 + 同步骨架文档（<100ms 零 AI）→ 本消息在 [骨架文档 + 新消息] 窗口下回答。
  //    并发保护：交接期间持 _compactBusy（瞬时步骤，另一 runChat 起步处等待）。
  let handovered = false, cutForFill = null, genForFill = 0, droppedForFill = 0, hasPrefixForFill = false;
  let preUsedTokens = 0, preBudget = 0;   // 项2：工具结果老化的判定口径（与交接判定同源）
  let injectedIds = new Set();   // D4：提升到函数级（finally 里的收尾补唤醒需读取本回合已注入的信箱 id）
  s._compactBusy = true;
  try {
    // 任务② T-A：交接判据单一来源 shouldHandoff(s)（与循环内/溢出路共用，判据不变）。
    const h0 = shouldHandoff(s);
    const eb = h0.eb;
    const total = h0.total;
    preUsedTokens = total; preBudget = eb;
    if (h0.yes) {
      const r = await deepArchiveNow(s);
      if (r && r.dropped > 0) {
        cutForFill = r.cut; genForFill = r.gen || 0; droppedForFill = r.dropped || 0;
        hasPrefixForFill = !!r.hasPrefix;
        handovered = true;
        branchGenBySession.set(s.id, genForFill);   // 支干：记录本会话当前世代号（供 turn 骨架标注）
        s._lastPromptTokens = 0;   // 窗口已重建：真实用量作废，下轮用估算/回传重建
        notifyCompacted(r.dropped, r.gen);
        console.log(`[世代交接] 归档 ${r.dropped} 条，窗口重建（骨架文档 + 本消息，gen=${genForFill}）`);
      }
    }
  } catch { }
  s._compactBusy = false;
  // —— 项2：工具结果老化（自动交接判定之后；批量、幂等、保 toolCallId）——
  try {
    const _ag = ageToolResults(s, preUsedTokens, preBudget);
    const _aa = ageToolCallArgs(s, preUsedTokens, preBudget);
    if (_ag.aged > 0 || _aa.aged > 0) saveSession(s);
  } catch { }
  if (handovered) saveSession(s);

  if (!s.title || s.title === '新会话') {
    // 自动标题尽量保留完整内容（尤其去掉 goal 前导标记后仍能看懂目标），不要截得过短
    s.title = content.replace(/\s+/g, ' ').slice(0, 60) || '新会话';
  }
  // 接续指令（仅交接后注入本消息尾部——动态内容本就在 user 正文，system 稳定前缀不动）
  // 任务② T-B：提示中性化 + 来源标注行；所有来源共用同一句，只换标记。
  let notice = handovered
    ? (hasPrefixForFill
      ? pendingPrefixNotice(s, genForFill, origin)
      : `\n\n【本代已自动交接】旧内容已全量归档（第 ${genForFill} 代，细节用 recall_context 召回）。\n[本轮触发：${originLabel(origin)}]\n请第一个动作执行 project action=tree（本会话）取回任务现场（目标/进度/待产出/在途派单/待办/待补前缀），不要重读大文件或重新探索。`)
    : '';
  // —— 回合起始：信箱未读注入（开关 cfg.mailboxInjectUnread；无 role/无未读则不注入）——
  //    注入内容只是本轮 content 前缀；关闭开关即恢复原样。
  let mailboxPrefix = '';
  let _mailboxCarrierPushed = false;   // v6.49e：前缀已作为真实 user 消息落历史 → withMailboxPrefix 不再注入
  let mailboxInbound = [];   // 本回合注入的、需要自动回执的入站消息（v5.2）
  let mailboxOrigins = [];   // v5.7：调度会话回报目标（原始派活会话 id 集合）
  injectedIds = new Set();   // 本回合已消费/已注入的信箱消息 id（防正常结束时对已处理消息重复续跑）
  const turnActionableIds = new Set();   // v6.9：本回合已消费的"动作类"入站 id（type∉reply/ack/notify）→ 收口补回写（防中断后假待办续跑）
  const turnInformationalIds = new Set();// v6.34：本回合已消费的"信息类"入站 id（reply/ack/notify + 非 action result）→ 收口终态化（现象B 根治）
  const turnCids = new Map();            // P2b-4 T2：本回合注入的动作类 task 的 cid → 发起方 from_id（停手检查点用）
  const turnOrigins = new Map();         // 回执搁浅修复（2026-10-10）：cid → { from, session }；供 tools ctx 取"发起方会话"做自动回执
  let turnCancelCid = null;              // P2b-4 T2：本回合因撤回停手时记下 cid（收尾回 result(cancelled)）
  let turnFailReason = null;             // v6.37：本回合失败原因（用于空正文回执时给出可读说明）
  let turnTaskTopic = null;              // 修粘性 branchTopic（C/b）：枝键只作用于"该 task 唤起的那一轮"，runChat 局部，不落 session 粘性
  try { s._turnConsumedIds = turnActionableIds; } catch { }   // v6.9：暴露给收口/收割路径，供补回写
  try { s._turnConsumedInfoIds = turnInformationalIds; } catch { }   // v6.34：信息类消费集合（收割时一并终态化）
  // v6.32（liveness）：delayed 锚点前移——**回合起始即排空**忙时入队的 _pendingInbound（绕开收尾时机约束）。
  //   成功注入者直接进入本回合上下文；已消费 → 不置 _lastFlushedInbound（防自环）。
  try { if (_pendingDrainOn()) { const _dn = drainPendingInbound(s, { at: 'start' }); if (_dn > 0) saveSession(s); } } catch { }
  if (cfg.mailboxInjectUnread !== false) {
    try {
      const mb = require('./mailbox');
      const role = selfRole();
      if (mb.available() && role) {
        // v5.7：调度会话（project=dispatcher）读"全部未读"；普通会话只读本会话未读
        let isDisp = false;
        try { isDisp = (s.project === 'dispatcher') || (mb.getDispatcher && mb.getDispatcher(role) === s.id); } catch { }
        // v5.7.1：调度会话不读 type='notify'——notify 是回投给"用户交互会话"的摘要；
        // 若被调度会话读到并 markRead，用户下次交互将读不到摘要（被吞），且会污染 mailboxOrigins 造成重复回投。
        const unreadAll = isDisp ? mb.fetchUnread(role, 50) : mb.fetchUnreadForSession(role, s.id, 20);
        const unread = isDisp ? unreadAll.filter((m) => m.type !== 'notify') : unreadAll;
        // 会诊定案 C（2026-09-30）：收敛入站注入管线——unread（未读）与 msgIds（补唤醒按 id 精确注入，
        //   不按 read_at 过滤）两来源共用同一 buildInboundPrefix，忙/闲一条路（治"补唤醒空回合"）。
        const _built = buildInboundPrefix({ role, sid: s.id, unread, msgIds: opts.injectMsgIds, cfg });
        mailboxPrefix = _built.prefix;
        const consumed = _built.consumed;
        if (consumed.length) {
          mb.markRead(consumed.map((m) => m.id));
          // v6.47：本回合真消费了这些入站 → 记 cid 的 woke 位（notified_at=决策 / woke_at=真起回合，拆两位，供唤醒丢失兜底）。
          try { for (const _m of consumed) { if (_m && _m.correlation_id && mb.markCidWoke) mb.markCidWoke(_m.correlation_id); } } catch { }
          for (const m of consumed) injectedIds.add(m.id);   // 本轮已消费 → 正常结束不因它们再续跑
          for (const m of consumed) {   // v6.9：动作类入站记入补回写集合（无论 autoReply 开关）
            if (m.type !== 'reply' && m.type !== 'ack' && m.type !== 'notify' && m.from_id && m.from_id !== role) {
              turnActionableIds.add(m.id);
              if (m.correlation_id) turnCids.set(String(m.correlation_id), String(m.from_id));   // P2b-4 T2：记录 cid 供停手检查点
              if (m.correlation_id) { try { turnOrigins.set(String(m.correlation_id), { from: String(m.from_id || ''), session: String(m.from_session_id || '') }); } catch { } }
            } else if (m.from_id && m.from_id !== role) {
              // v6.34：信息类（reply/ack/notify 或非 action 的 result）已消费 → 收口终态化，防其永久滞留 pending/processing（现象B）
              turnInformationalIds.add(m.id);
            }
          }
          if (cfg.mailboxAutoReply !== false) {
            // v5.2 + 2026-09-19 行为层定案：回执闭环**仅对动作类(task 等)**——reply/ack/notify 均不回执（防回执乒乓）。
            mailboxInbound = consumed
              .filter((m) => isActionableType(m, cfg) && !m.wake_intent && m.from_id && m.from_id !== role)
              .map((m) => ({ id: m.id, from_id: m.from_id, correlation_id: m.correlation_id }));
          }
          // C（2026-09-29）派单驱动归枝：入站 task 带 topic → **仅本轮**挂该枝（runChat 局部，不落 session 粘性；多 task 同轮首个非空优先；无 topic 则正文推导）。
          try {
            const _tasks = consumed.filter((m) => m.type === 'task');
            for (const m of _tasks) { if (turnTaskTopic) break; const _tk = resolveTaskTopic(m); if (_tk) turnTaskTopic = _tk; }
          } catch { }
        }
        // v5.7：调度会话记录回报目标（原始派活会话，排除自身）
        if (isDisp) mailboxOrigins = [...new Set(consumed.map((m) => m.to_session_id).filter((x) => x && x !== s.id))];
      }
    } catch (e) { /* 未读注入失败不得阻塞本轮 */ }
  }
  // @会话 v2（2026-10-02）：用户 @ 了目标会话 → 注入结构化块，要求雷仔理解意图后调用 send_to_session 组织发送（不原样转发）。
  const _mentionTargets = Array.isArray(opts.mentionTargets) ? opts.mentionTargets.map(String).filter(Boolean) : [];
  if (_mentionTargets.length) {
    let _byId = new Map();
    try { _byId = new Map(listSessions().map((x) => [String(x.id), x])); } catch { }
    const _mlines = _mentionTargets.map((id) => { const t = _byId.get(String(id)); const title = (t && t.title) ? String(t.title) : ''; return '- ' + id + (title ? '(' + title + ')' : ''); });
    const _mblk = '【@会话】用户要你把内容送达以下会话，须你理解意图后调用 send_to_session 组织发送，勿原样转发：\n' + _mlines.join('\n') + '\n';
    mailboxPrefix = _mblk + (mailboxPrefix || '');
    try { _mentionTurnState.set(String(s.id), { targets: _mentionTargets.slice(), fulfilled: new Set() }); } catch { }
  }
  const internalMailbox = !!opts.internalMailbox;   // 空闲唤醒内部回合：不持久化 user 消息（正文只来自未读前缀，历史仅增雷影未读标记）
  // C 组：引擎自造/调度消息（心跳/定时/自治目标）→ 标记 engine，前端渲染成"系统/引擎"样式（不冒充用户）
  const engineMsg = !!(opts.engine || opts.origin === 'heartbeat' || opts.origin === 'timer');
  let userText = `${content}${notice}`;
  // —— 自我模型反哺（第二版）：任务起始轮在 user 消息尾追加相关自我认知（只读、节流、可关）——
  //    节流：交接后首轮必注入；否则每 cfg.selfInjectEvery 轮一次（默认 5，设 0 关闭）。注入块带标记，reflect 侧剔除。
  const _taskTxt = String(content || '').trim() || String(s.title || '') || (function () { for (let i = s.messages.length - 1; i >= 0; i--) if (s.messages[i].role === 'user') return String(s.messages[i].content || '').slice(0, 300); return ''; })();
  try {
    userText += maybeSelfHint(s, cfg, _taskTxt, handovered);
  } catch { }
  // —— 领域分流提醒（V4·动态匹配）：仅真实用户请求；仅"命中相关领域 / 会诊信号 / 交接首轮"注入（降频，非每轮）——
  try {
    if (String(content || '').trim() && !internalMailbox) {
      const _taskKey = _taskTxt.slice(0, 120);
      if (!s._consultHint || typeof s._consultHint !== 'object') s._consultHint = {};
      if (!s._greyHint || typeof s._greyHint !== 'object') s._greyHint = {};
      const _dh = buildRoleDispatchHint(_taskTxt, { handoverFirst: !!handovered, consultGate: { key: _taskKey, store: s._consultHint }, greyGate: { key: _taskKey, store: s._greyHint } });
      if (_dh) userText += `\n\n${_dh}`;
    }
  } catch { }
  if (s.project === 'dispatcher') {
    userText += '\n\n【调度员守则】你是主实例的调度中心：分拣雷影消息、必要时用 agent_send 回执雷影、把进展记入项目进度。**默认不要主动给雷影派发新任务**；保持简短，处理完即止。';
  }
  // v6.56：文件附件清单——只注入"名/大小/类型/绝对路径"，**绝不内联文件字节**（防 token 爆炸与二进制污染）；
  //   模型需要内容时自行用 read_file / run_command 读取。
  if (attachments.length) {
    const _lines = attachments.map((a) => {
      const nm = String((a && a.name) || '').replace(/[\r\n]/g, ' ').slice(0, 120) || '(未命名)';
      const sz = Number((a && a.size)) || 0;
      const szT = sz >= 1048576 ? (sz / 1048576).toFixed(1) + 'MB' : (sz >= 1024 ? (sz / 1024).toFixed(1) + 'KB' : sz + 'B');
      const mt = String((a && a.mime) || 'application/octet-stream').slice(0, 80);
      const pt = String((a && a.path) || '');
      return `- ${nm}（${szT} · ${mt}）：${pt}`;
    });
    userText += `\n\n【附件】本消息附带 ${attachments.length} 个文件（仅提供路径，未内联内容；需要时可用 read_file/run_command 读取）：\n${_lines.join('\n')}`;
  }
  // 【当前时间】注入（2026-10-06）：只在"本轮"新建的 user 消息**尾**追加本地时间（历史消息不改、system/工具前缀不动 → 不击穿缓存）；幂等（已含标记不重复）。
  try { if (userText && !userText.includes('【当前时间】')) userText += '\n\n' + currentTimeLine(); } catch { }
  if (internalMailbox && !content && mailboxPrefix) {
    // v6.49e（2026-09-30 回归修复）：空闲唤醒无本轮 user → 把信箱前缀作为**一条真实 user 消息**落历史（只在轮首落一次）。
    //   旧 v6.49c 在 withMailboxPrefix 里"每迭代临时追加"→ 同一入站在每个工具迭代都被当作**新的尾部 user**再现，
    //   表现为"同一消息被重复注入 / 主我连续多轮收到同一条"。落历史后：每次 wire 稳定出现一次、不再重复。
    try { console.log(`[mailbox-inject-diag] sid=${s.id} injectMsgIds=${(opts.injectMsgIds || []).join(',') || '-'} prefixLen=${(mailboxPrefix || '').length} unreadLen=${(mailboxInbound || []).length} internalMailbox=true contentLen=0 attachPath=push-history-once`); } catch { }
    // 【当前时间】注入（2026-10-06 补充）：信箱空闲唤醒轮（internalMailbox && !content）正文由本 carrier 承载，
    //   userText 为空 → :3091 未命中；故在 carrier 尾同样追加本地时间（幂等：已含标记不重复）。
    const _carrierRaw = (mailboxPrefix || '') + (notice ? '\n' + notice : '');
    const _carrier = _carrierRaw.includes('【当前时间】') ? _carrierRaw : _carrierRaw + '\n\n' + currentTimeLine();
    s.messages.push({ role: 'user', content: _carrier, _mailboxCarrier: true, engine: true });   // v6.52：引擎注入载体恒带 engine（前端按系统消息渲染，勿冒充"主人"）
    _mailboxCarrierPushed = true;
  } else if (!(internalMailbox && !content)) {
    s.messages.push({
      role: 'user',
      content: images.length
        ? [
            { type: 'text', text: userText },
            ...images.map((u) => ({ type: 'image_url', image_url: { url: u } })),
          ]
        : userText,
      ...(engineMsg ? { engine: true } : {}),   // C 组：调度/自治消息标记（随会话落盘）
    });
  }
  // 会话列表即时刷新（回合起始 touch）：置 updatedAt=now 并**直接 writeMeta**（不走 saveSession——sessionSig 不含
  //   updatedAt，会在 L241 提前 return 而不写 meta），并 emit 'session-activity' 让 server 广播 sessions-changed，
  //   使左侧列表在回合进行中即反映最新时间/条数。不改回合结束语义（turn-done 仍写最终 updatedAt）。
  try {
    s.updatedAt = new Date().toISOString();
    writeMeta(s);
    runtime.emit('session-activity', { sessionId: s.id, at: Date.now() });
  } catch { }
  // 把信箱未读前缀**临时**拼到本轮 wire 的最后一条 user 消息上（仅本轮可见，不写回 s.messages 持久历史）。
  // v6.49c/v6.49e（2026-09-30）：空闲唤醒内部回合（internalMailbox && content 为空）不写本轮 user 消息，
  //   且入站"气泡锚点"标记被 toWire(isInboundMarkerMsg) 过滤 → wire 末条=上一轮 assistant，前缀无处可贴（v6.49c 根因）。
  //   v6.49c 曾在**本函数里每迭代临时追加**一条 user 承载 → 同一入站在每个工具迭代都被当作"新的尾部 user"再现，
  //   表现为"同一消息被重复注入"。v6.49e 改为：**轮首把前缀作为一条真实 user 消息落历史一次**（见上方 push 分支），
  //   随后 _mailboxCarrierPushed=true → 本函数不再注入（每次 wire 稳定出现一次，不重复）。
  const withMailboxPrefix = (arr) => {
    if (!mailboxPrefix || !arr.length) return arr;
    if (_mailboxCarrierPushed) return arr;   // v6.49e：前缀已在 s.messages（稳定位置）→ 勿再注入
    // v5.4 T-B：只贴到最后一条 user 消息——工具迭代中末条是 tool 结果，不应被污染、也不必每迭代重贴
    let idx = -1;
    for (let i = arr.length - 1; i >= 0; i--) { if (arr[i].role === 'user') { idx = i; break; } }
    if (idx < 0) return [...arr, { role: 'user', content: (mailboxPrefix || '') + (notice ? '\n' + notice : '') }];   // 无 user 消息（兜底）→ 临时承载前缀，不写历史
    const last = { ...arr[idx] };
    if (Array.isArray(last.content)) last.content = [{ type: 'text', text: mailboxPrefix }, ...last.content];
    else last.content = mailboxPrefix + (last.content || '');
    arr[idx] = last;
    return arr;
  };
  if (handovered && cutForFill) {
    // 后台补"本代增量"（非关键路径；完成后原位更新顶部文档气泡）
    setTimeout(() => { deepFillSummary(s, cutForFill, genForFill, droppedForFill).catch(() => { }); }, 0);
  }
  const usage = { hitTokens: 0, missTokens: 0, outputTokens: 0 };
  let text = '';
  let burnChars = 0, burnToks = 0;   // 本轮已“燃烧”的字符/token 预估（驱动右侧面板动效）
  let toolCallsCount = 0;
  const turnToolNames = [];   // 批A（A6）：本轮工具名（去重后写入 kind='detail' 明细）
  let stopped = false;
  let lastTtfb = -1;
  // 带图片时自动切到 vision 模型（配置里存在 vision 模型且未手动选择时）
  let model = s.model || cfg.model;   // 会话级模型覆盖 > 全局（null=跟随全局）
  if (images.length && !String(model).includes('vision')) {
    const visionModel = (cfg.models || []).find((m) => String(m).includes('vision'));
    if (visionModel) model = visionModel;
  }
  evt.start && evt.start({ model, sessionId });
// v6.6 卡死根治：回合看门狗——维护"最近活动时间"，超 cfg.turnWatchdogMs 无活动即中止本轮（0=关）。
let lastActivityAt = Date.now();
let wdTimer = null;
// v7（busy 心跳）：回合级定时器——每 60s 续约 busy_at，覆盖"单次长流式 LLM 调用 >5min、循环尚未迭代"的空档
let busyHbTimer = null;
  try {    try { require('./mailbox').setBusy(selfRole(), s.id); } catch { }   // v6.30：busy 上报移入受保护区段（见 finally 清理）

    // P1 审计（2026-10-02）：仅"交接后首代"核验前缀指纹，检出绕过 pfxWrite 的直写；普通回合不跑（避免每轮 ~92ms 的 skills 全量 hash）。异常不影响回合。
    // 未来若要每回合检测，可改用"skills 快指纹(stat mtime+size) + harness 全量 hash"（本次不做）。
    if (handovered) { try { const _pqh = require('./pfxqueue'); _pqh.runAudit('handoff'); _pqh.registerRestartNeeded(); } catch { } }

    // P2 落地择时（唯一决策点 · 2026-10-02）：仅"小窗 + (脏标记 or 过节流)"时一次性落盘（一批一事务=只付1次重建）。
    //  紧贴 chatStream 前；全 try，flush 失败/超时 → 不阻塞本轮（照常以旧前缀发出，失败项留 pending）。
    try {
      const _pq = require('./pfxqueue');
      if (_pq.enabled()) {
        const _minTok = Number(cfg && cfg.prefixGuardMinTokens) || 40000;
        const _hist = pfxWindowHist(s);
        if (_hist < _minTok) await _pq.maybeFlush({ hist: _hist, minTokens: _minTok });
        try { _pq.quickCheck('pre-request'); } catch { }   // C（2026-10-02）：快指纹早发现（仅 stat 签名变化才跑全量 audit）
      }
    } catch { }

    const sys = systemPrompt().full;
    // v6.6 1A 看门狗定时器：每 30s 检查；超时 → 发 turn-watchdog 事件并 abort 本回合
    {
      const watchdogMs = Number(cfg.turnWatchdogMs) || 0;
      if (watchdogMs > 0) wdTimer = setInterval(() => {
        if (Date.now() - lastActivityAt > watchdogMs) {
          const info = { sessionId: s.id, elapsedMs: Date.now() - lastActivityAt };
          try { evt.watchdog && evt.watchdog(info); } catch { }
          try { runtime.emit('turn-watchdog', info); } catch { }
          try { s.controller && s.controller.abort(); } catch { }
          try { s._abortedAt = Date.now(); } catch { }   // v6.7：记录中止时刻，供收割器判定
        }
      }, 30000);
      try { if (wdTimer && wdTimer.unref) wdTimer.unref(); } catch { }
    }
    // v7：总线繁忙心跳（独立于 turnWatchdogMs；只刷时间戳，无副作用）
    busyHbTimer = setInterval(() => { try { require('./mailbox').touchAgentBusy(selfRole()); } catch { } }, 60000);
    try { if (busyHbTimer && busyHbTimer.unref) busyHbTimer.unref(); } catch { }
    let maxIter = (s.project === 'dispatcher')
      ? Math.min(Number(cfg.dispatcherMaxIterations) || 8, opts.maxIterations || 99)
      : (opts.maxIterations || cfg.iterationCap);
    // v6.6 1C：交接后/信箱唤醒的回合只做最小处理（不再几十步重探索）。cfg.mailboxWakeMaxIter=0 → 不限额（回滚）。
    const mailboxCap = Number(cfg.mailboxWakeMaxIter) || 0;
    if (opts.mailboxWake && mailboxCap > 0) maxIter = Math.min(maxIter, mailboxCap);
    const maxResume = Number(cfg.goalMaxRounds) || 40;
    let resumeRound = 0, unreadResumeRound = 0, autoResumeRound = 0, endedBy = 'final';
    do {
    // 任务② T-A：do 循环内每轮起始重判（堵"续跑永不交接"·坑B）——命中即交接，保留最近 1 完整回合（§7）。
    //    判据与入口同源（shouldHandoff），不用人为倍数；入口已交接时此处自动为否（窗口已重建）。
    try {
      const hL = shouldHandoff(s);
      if (hL.yes) {
        const rL = await deepArchiveNow(s, { keepLastRound: true });
        if (rL && rL.dropped > 0) {
          s._lastPromptTokens = 0;
          notifyCompacted(rL.dropped, rL.gen);
          try { branchGenBySession.set(s.id, rL.gen || 0); } catch { }
          // 刷新交接提示（来源行随本轮 origin），并入最近一条 user 消息（与入口同法，模型可见）
          notice = listPendingPrefixForSession(s).length > 0
            ? pendingPrefixNotice(s, rL.gen || 0, s._turnOrigin || origin)
            : `\n\n【本代已自动交接】旧内容已全量归档（第 ${rL.gen || 0} 代，细节用 recall_context 召回）。\n[本轮触发：${originLabel(s._turnOrigin || origin)}]\n请第一个动作执行 project action=tree（本会话）取回任务现场（目标/进度/待产出/在途派单/待办/待补前缀），不要重读大文件或重新探索。`;
          try {
            for (let _i = s.messages.length - 1; _i >= 0; _i--) {
              if (s.messages[_i].role === 'user') {
                const c0 = s.messages[_i].content;
                if (typeof c0 === 'string' && !c0.includes('[本轮触发：')) s.messages[_i] = { ...s.messages[_i], content: c0 + notice };
                break;
              }
            }
          } catch { }
          console.log(`[世代交接] 循环内交接 归档 ${rL.dropped} 条（保留最近1回合，gen=${rL.gen || 0}）`);
        }
      }
    } catch { }
    let wire = withMailboxPrefix([ { role: 'system', content: sys }, ...toWire(s.messages) ]);
    let iter = 0;
    let overflowTries = 0;
    let repeatTries = 0;                 // 重复输出护栏：已重试次数
    let emptyTries = 0;                  // 空响应护栏：已重试次数
    let lastToolFp = ''; let toolStreak = 0;   // 工具死循环护栏：上次调用指纹 + 连续次数
    let turnProgOps = 0;                        // 批1 L3-④：本轮"实质进展"计数（成功 edit_file/write_file 或 run_command rc=0）；每轮起始归零
    while (iter < maxIter) {
      iter++;
      // v7（busy 心跳）：每轮 LLM 调用前**续约** busy_at → 长回合持续显示忙碌动效（TTL 语义不变，仅刷新时间戳）
      try { require('./mailbox').touchAgentBusy(selfRole()); } catch { }
      // P6（refs=mailbox-structural）：注入租约心跳——长回合逐轮续约 injected_at，防 sweepInjectedLeases 误判超时释放孤儿。
      try { if (turnActionableIds && turnActionableIds.size) require('./mailbox').touchLease(Array.from(turnActionableIds)); } catch { }
      let r;
      try {
        r = await chatStream({
          messages: wire,
          tools: tools.definitions(),
          model,
          temperature: cfg.temperature,
          maxTokens: cfg.maxTokens,
          reasoningEffort: ((s.reasoningEffort ?? cfg.reasoningEffort) === 'off' ? undefined : (s.reasoningEffort ?? cfg.reasoningEffort)),
          signal: s.controller.signal,
          frequencyPenalty: cfg.frequencyPenalty,   // 防复读基线（未配置则不发送）
          kind: 'turn',
        }, {
          onDelta: (d) => { lastActivityAt = Date.now(); text += d; burnChars += d.length; burnToks = estTokens(burnChars); evt.delta && evt.delta({ text: d, chars: burnChars, tokens: burnToks }); s.replyDraft = s.replyDraft || ''; s.replyDraft += d; saveDraft(s); try { emitTurnStream(s.id, 'text', d); } catch { } },
          onReasoning: (d) => { lastActivityAt = Date.now(); burnChars += d.length; burnToks = estTokens(burnChars); evt.reasoning && evt.reasoning({ text: d, chars: burnChars, tokens: burnToks }); try { emitTurnStream(s.id, 'reasoning', d); } catch { } },
        });
        // —— 缓存冷轮探针（诊断，只写 data/cache-diag.log；不改请求/不改流程）——
        try { cacheDiagProbe(s, wire, r && r.usage, iter, { model, temperature: cfg.temperature, reasoningEffort: (s.reasoningEffort ?? cfg.reasoningEffort), maxTokens: cfg.maxTokens }); } catch { }
      } catch (e) {
        if (e.name === 'AbortError') { r = { text, toolCalls: [], stopped: true }; }
        else if (e && e.contextOverflow && overflowTries < 2) {
          // 上下文溢出（防御性，正常不可达：预算 150k + 瘦身 ≤16k 字符/次，单回合最大 ≈630k < 1M）：
          // 一次"全量交接式"大切（保留当前进行中的最后回合）后重试，wire 在循环末尾按新消息重建
          // 任务② T-A：与入口/循环共用判据 shouldHandoff —— 本地确认仍超预算才归档（API 误报则仅重建 wire）。
          overflowTries++;
          const _ho = shouldHandoff(s);
          if (_ho.yes) {
            const r2 = await deepArchiveNow(s, { keepLastRound: true });
            if (r2 && r2.dropped > 0) { s._lastPromptTokens = 0; notifyCompacted(r2.dropped, r2.gen); }
          } else {
            s._lastPromptTokens = 0;   // API 误报：不归档，仅重建 wire 重试
          }
          wire = withMailboxPrefix([ { role: 'system', content: sys }, ...toWire(s.messages) ]);
          evt.delta && evt.delta({ text: `（上下文已超出，正在压缩后继续…）`, chars: burnChars, tokens: burnToks });
          continue;
        } else throw e;
      }
      // —— 重复输出护栏（死循环复读）：重置气泡 → 更强抗复读采样重试一次 → 仍复读则截断收尾 ——
      if (r.repeated) {
        if (repeatTries < REPEAT_RETRY_MAX) {
          repeatTries++;
          text = ''; burnChars = 0; burnToks = 0;   // 客户端气泡已 reset，本地从头累积
          evt.reset && evt.reset({});
          try {
            r = await chatStream({
              messages: wire,
              tools: tools.definitions(),
              model,
              temperature: Math.min(0.9, (typeof cfg.temperature === 'number' ? cfg.temperature : 0.3) + 0.3),
              maxTokens: cfg.maxTokens,
              reasoningEffort: ((s.reasoningEffort ?? cfg.reasoningEffort) === 'off' ? undefined : (s.reasoningEffort ?? cfg.reasoningEffort)),
              signal: s.controller.signal,
              frequencyPenalty: REPEAT_RETRY_PENALTY,
              kind: 'turn',
            }, {
              onDelta: (d) => { lastActivityAt = Date.now(); text += d; burnChars += d.length; burnToks = estTokens(burnChars); evt.delta && evt.delta({ text: d, chars: burnChars, tokens: burnToks }); s.replyDraft = s.replyDraft || ''; s.replyDraft += d; saveDraft(s); try { emitTurnStream(s.id, 'text', d); } catch { } },
              onReasoning: (d) => { lastActivityAt = Date.now(); burnChars += d.length; burnToks = estTokens(burnChars); evt.reasoning && evt.reasoning({ text: d, chars: burnChars, tokens: burnToks }); try { emitTurnStream(s.id, 'reasoning', d); } catch { } },
            });
          } catch (e2) {
            if (e2.name === 'AbortError') { r = { text, toolCalls: [], stopped: true }; }
            else throw e2;
          }
        }
        if (r.repeated) {
          // 重试后仍复读：护栏截断后的正文作为最终回复（气泡重置后再展示一次，末尾带说明）
          text = r.text || '';
          burnChars = text.length; burnToks = estTokens(burnChars);
          evt.reset && evt.reset({});
          evt.delta && evt.delta({ text: `${text}\n\n（检测到重复输出，已自动截断）`, chars: burnChars, tokens: burnToks });
        }
      }
      accumulateUsage(usage, r.usage);
      if (r.usage && r.usage.promptTokens > 0) s._lastPromptTokens = r.usage.promptTokens;   // 触发判定用真实值（自校准）
      if (r.ttfbMs >= 0) {
        lastTtfb = r.ttfbMs;
        runtime.globalStats.ttfbSumMs += r.ttfbMs;
        runtime.globalStats.ttfbCount++;
      }
      stopped = !!r.stopped;
      // —— 空响应自动重试（既无正文也无工具调用）：就地重呼一次，仍空则落下方原分支只留一条提示（复用复读重试同款模式） ——
      const _empty = !String(r.text || '').trim() && !(r.toolCalls && r.toolCalls.length) && !r.stopped;
      if (_empty && emptyTries < EMPTY_RETRY_MAX && cfg.emptyRetry !== false) {
        emptyTries++;
        text = ''; burnChars = 0; burnToks = 0;   // 客户端气泡已 reset，本地从头累积
        evt.reset && evt.reset({});
        try {
          r = await chatStream({
            messages: wire,
            tools: tools.definitions(),
            model,
            temperature: cfg.temperature,
            maxTokens: cfg.maxTokens,
            reasoningEffort: ((s.reasoningEffort ?? cfg.reasoningEffort) === 'off' ? undefined : (s.reasoningEffort ?? cfg.reasoningEffort)),
            signal: s.controller.signal,
            frequencyPenalty: cfg.frequencyPenalty,   // 防复读基线（未配置则不发送）
            kind: 'turn',
          }, {
          onDelta: (d) => { lastActivityAt = Date.now(); text += d; burnChars += d.length; burnToks = estTokens(burnChars); evt.delta && evt.delta({ text: d, chars: burnChars, tokens: burnToks }); s.replyDraft = s.replyDraft || ''; s.replyDraft += d; saveDraft(s); try { emitTurnStream(s.id, 'text', d); } catch { } },

          onReasoning: (d) => { lastActivityAt = Date.now(); burnChars += d.length; burnToks = estTokens(burnChars); evt.reasoning && evt.reasoning({ text: d, chars: burnChars, tokens: burnToks }); try { emitTurnStream(s.id, 'reasoning', d); } catch { } },

          });
        } catch (e2) {
          if (e2.name === 'AbortError') { r = { text, toolCalls: [], stopped: true }; }
          else throw e2;
        }
        accumulateUsage(usage, r.usage);                              // 重试调用单独计费，不漏不双计
        if (r.usage && r.usage.promptTokens > 0) s._lastPromptTokens = r.usage.promptTokens;
        stopped = !!r.stopped;   // 重试后重算（AbortError 分支可能置 stopped）
      }
      if (!r.toolCalls || r.toolCalls.length === 0) {
        const _emptyResp = !String(r.text || '').trim() && !stopped;
      // 分类（2026-10-03）：http 200 且无正文/工具且未收到 [DONE] = **响应流被截断**（上游未正常结束），
      //   区别于真正的"空返回"。仅影响分类/文案/llm-status，不改重试判据（text 空仍走重试）。
      const _streamTrunc = _emptyResp && Number(r.httpStatus) === 200 && !r.sawDone && !((r.toolCalls || []).length);
      const _emptyReason = _streamTrunc ? 'stream-truncated' : 'empty-response';
      if (_emptyResp) { turnFailReason = turnFailReason || (_streamTrunc ? '响应流被截断（上游未正常结束）' : '模型返回空内容'); try { require('./deepseek').emitLlmStatus(false, _emptyReason, { retryable: true, needsUserAction: false }); } catch { } try { require('./deepseek').dumpEmptyReq(wire, { kind: 'turn', model, attempt: emptyTries, reason: _emptyReason, httpStatus: r.httpStatus, finishReason: r.finishReason, sawDone: r.sawDone, evCount: r.evCount, textLen: String(r.text || '').length, reasoningLen: String(r.reasoning || '').length, toolCalls: (r.toolCalls || []).length, ttfbMs: r.ttfbMs, durationMs: r.durationMs, usage: r.usage, messageCount: Array.isArray(wire) ? wire.length : null }, ''); } catch { } } s.messages.push({ role: 'assistant', content: _emptyResp ? (_streamTrunc ? `⚠ 响应被中断（上游未正常结束），已自动重试 ${emptyTries} 次，可稍后重发。` : '⚠ 本轮模型未返回任何内容（既无正文也无工具调用）。可能是模型服务异常或上下文异常，请重发或点顶部横幅「重试」。') : r.text, reasoning: _emptyResp ? undefined : (r.reasoning || undefined), _usage: r.usage || undefined, ...(_emptyResp ? { _llmEmpty: true, _emptyReason } : ((stopped && !String(r.text || '').trim()) ? { _stopped: true } : {})) });
        // 最终回复已正式入会话 → 清草稿（下次 saveSession 落盘），避免误当作崩溃残留
        delete s.replyDraft; s._draftTs = 0;
        // 待补前缀强制兜底：交接时装填了未完成待补前缀、本回合自然结束仍未清空 → 注入强制 user 消息并继续（每代最多 1 次，防空转）。
        let _pfxContinued = false;
        try {
          const pend = listPendingPrefixForSession(s);
          const _d = pfxFallbackDecision(s._pfxFallback, pend, stopped);
          if (_d.fire) {
            const lines = pend.map((x) => `- [ ] ${x}`).join('\n');
            s.messages.push({ role: 'user', content: `⛔【待补前缀未完成·强制继续】本代交接时存在 ${pend.length} 项待补前缀，尚未完成。请**在做任何其它工具前先逐项执行前缀操作**（propose_evolution / save_skill / 改 prompts），完成并补写 prefix-done 勾销；若本次被前缀护栏拦下（非首回合硬拦），请说明并写 prefix-done 让下次交接首回合处理。完成或处理后再简短汇报。\n${lines}`, engine: true });   // v6.52：引擎注入载体恒带 engine
            try { saveSession(s); } catch { }
            try { runtime.emit('turn-progress', { sessionId: s.id, iter, step: toolCallsCount, tool: `（待补前缀强制继续：${pend.length} 项）` }); } catch { }
            wire = withMailboxPrefix([ { role: 'system', content: sys }, ...toWire(s.messages) ]);
            _pfxContinued = true;
          } else if (_d.disarm) {
            s._pfxFallback.armed = false;   // 已清空 → 解除装填
          }
        } catch { }
        if (_pfxContinued) continue;
        break;
      }
      // 工具调用回合
      const asstMsg = {
        role: 'assistant', content: r.text || '',
        toolCalls: r.toolCalls.map((t) => ({ id: t.id || `call_${Math.random().toString(36).slice(2, 8)}`, name: t.name, arguments: t.arguments })),
        reasoning: r.reasoning || undefined,
        _usage: r.usage || undefined,
      };
      const msgBase = s.messages.length;
      s.messages.push(asstMsg);
      let loopStop = false;
      for (const tc of asstMsg.toolCalls) {
        // P2b-4 T2 停手检查点：每次工具调用前查本回合 cid 最新状态是否含 cancel → 停手 + 收尾回 result(cancelled)。
        if (turnCids.size && !stopped) {
          try {
            const mbx = require('./mailbox');
            for (const [ccid] of turnCids) {
              if (mbx.isCidCancelled && mbx.isCidCancelled(ccid)) { turnCancelCid = ccid; break; }
            }
            if (turnCancelCid) {
              stopped = true; loopStop = true;
              try { runtime.emit('turn-progress', { sessionId: s.id, iter, step: toolCallsCount, tool: `（收到撤回 ${turnCancelCid}，停手）` }); } catch { }
            }
          } catch { }
        }
        if (stopped && turnCancelCid) break;
        // 工具死循环护栏：名称+参数完全一致的调用连续 ≥4 次 → 停止本轮（"读→再读/验证→再验证"式死循环）
        const fp = `${tc.name}|${JSON.stringify(tc.arguments || {})}`;
        if (fp === lastToolFp) toolStreak++; else { toolStreak = 1; lastToolFp = fp; }
        if (toolStreak >= TOOL_LOOP_MAX) { loopStop = true; break; }
        toolCallsCount++;
        try { turnToolNames.push(String(tc.name || '')); } catch { }
        lastActivityAt = Date.now();   // v6.6：工具调用开始刷新活动时间
        evt.tool && evt.tool({ index: toolCallsCount, name: tc.name, args: tc.arguments });
        // v6.6 1B：进度事件（工具调用开始）——SSE turn-progress {step,tool,iter}
        try { const info = { sessionId: s.id, step: toolCallsCount, tool: tc.name, iter }; evt.progress && evt.progress(info); runtime.emit('turn-progress', info); } catch { }
        let result;
        // v6.7：卡死根治——工具调用可被回合 abort 中止（raceToolAbort）；在飞期间每 60s 刷新活动时间，防正常长工具被看门狗误杀
        const toolBeat = (Number(cfg.turnWatchdogMs) || 0) > 0
          ? setInterval(() => { lastActivityAt = Date.now(); try { require('./mailbox').touchAgentBusy(selfRole()); } catch { } }, 60000) : null;
        try { if (toolBeat && toolBeat.unref) toolBeat.unref(); } catch { }
        try {
          result = await raceToolAbort(
            () => tools.exec(tc.name, tc.arguments, { workdir: wd, cfg, sessionId: s.id, project: s.project || '', branchTurnId, branchGen: branchTurnGen, turnOrigins, signal: (s.controller && s.controller.signal) || null }),
            s.controller && s.controller.signal,
            toolHardTimeoutMs()
          );
        } catch (e) {
          result = `[工具错误] ${e.message}`;
        } finally {
          if (toolBeat) { try { clearInterval(toolBeat); } catch { } }
        }
        const content2 = String(result);
        // 批1 L3-④：记录本轮"实质进展"（成功变更类操作）——供有界自续门控（edit_file/write_file 成功，或 run_command rc=0）。
        try {
          const _err2 = content2.startsWith('[工具错误]') || content2.startsWith('[错误]');
          if (!_err2 && (tc.name === 'edit_file' || tc.name === 'write_file')) turnProgOps++;
          else if (tc.name === 'run_command' && /\[exit=0\]/.test(content2)) turnProgOps++;
        } catch { }
        // 巨文工具结果瘦身：活跃上下文只留头尾（≤16k 字符），全文立即入归档可召回——
        // 替代旧的"全量塞进会话"（单轮 5-8 万 token，几轮撞线）与更早的"12000 截断丢弃"。
        const slim = slimToolResult(s, tc.id, content2);
        // 迭代账目提示（2026-09-22）：达阈值时在工具结果末尾追加（slim 后追加，不动 toolCallId/role）。
        let toolContent = slim.content;
        try {
          const hint = buildIterHint(toolCallsCount, cfg.iterHintThreshold, cfg.iterHintRepeat, turnProgOps);
          if (hint) toolContent = `${toolContent}${hint}`;
          // ① B：窗口余量提示（主我侧；待补前缀>0 或 hist>60%线时才注入）——先短路非 main，省 listPendingPrefixForSession/fold 开销
          if (cfg && cfg.agent && cfg.agent.isMain) {
            let _pfxN = 0; try { _pfxN = listPendingPrefixForSession(s).length; } catch { _pfxN = 0; }
            const pfxHint = buildPfxWindowHint(s, cfg, _pfxN, pfxWindowHist(s));
            if (pfxHint) toolContent = `${toolContent}${pfxHint}`;
          }
        } catch { }
        // 防孤儿 tool（2026-09-24 治本·force_handoff 中途重建窗口）：force_handoff 工具在**执行中途**调
        //   deepArchiveNow(force,keepLastRound:false) → keep=[] 全量归档，把"本次调用的 assistant(toolCalls)"
        //   一并抽走；工具返回时若仍 push 为 role:'tool'，配对 assistant 已不在 messages → 孤儿 tool → HTTP 400。
        //   （原 sanitizeOrphanTools 在 deepArchiveNow 内执行时工具尚未返回，无孤儿可清 → 防线时机错位。）
        //   故 push 前回扫配对：有配对→标准 tool 消息；无配对→降级普通 assistant 注记（保留结果文本，不产生孤儿）。
        const _pairedCall = hasPairedToolCall(s.messages, tc.id);
        if (_pairedCall) {
          s.messages.push({ role: 'tool', toolCallId: tc.id, content: toolContent, ...(slim.trimmed ? { _toolTrimmed: true } : {}) });
        } else {
          try { console.warn(`[orphan-tool-guard] tool=${tc.name} id=${tc.id} 无配对 assistant（交接抽走）→ 降级 assistant 注记`); } catch { }
          s.messages.push({ role: 'assistant', content: `（工具 ${tc.name} 已返回；其调用消息已随交接归档）\n\n${toolContent}` });
        }
        evt.tool_result && evt.tool_result({
          index: toolCallsCount, name: tc.name,
          outcome: content2.startsWith('[工具错误]') || content2.startsWith('[错误]') ? 'error' : 'ok',
          summary: content2.replace(/\s+/g, ' ').slice(0, 160),
        });
        lastActivityAt = Date.now();   // v6.6：工具返回后刷新活动时间
      }
      if (loopStop) {
        endedBy = 'loopStop';
        // 回滚本轮（撤销 asstMsg + 已 push 的 tool 结果，保证 wire 中 assistant.toolCalls 与 tool 结果配对），换说明消息收尾
        while (s.messages.length > msgBase) s.messages.pop();
        s.messages.push({ role: 'assistant', content: `${r.text || ''}\n\n（检测到连续 ${TOOL_LOOP_MAX} 次重复执行同一工具调用，已停止本轮。任务可能未完成，请告诉我继续。）` });
        try { delete s.replyDraft; s._draftTs = 0; } catch { }
        break;
      }
      // v3：回合中不再做预防性压缩（滚动压缩已移除）——单回合巨增长由"下一回合起始的全量交接"统一收口
      wire = withMailboxPrefix([ { role: 'system', content: sys }, ...toWire(s.messages) ]);
    }
    if (iter >= maxIter) {
      s.messages.push({ role: 'assistant', content: `（已达本回合工具调用上限 ${maxIter} 次。）若剩余为执行/产出类工作 → 建议派雷影（agent_send）继续；若为主我本职工作（决策/架构/审计/自我运维）→ 请回复继续；若本职中含可拆执行部分 → 拆出派雷影，主我留决策。` });
      try { delete s.replyDraft; s._draftTs = 0; } catch { }
      if (endedBy === 'final') endedBy = 'maxIter';
      // v6.23：达上限即落盘 + 广播可见进度——否则"达上限+自动续跑"整条链期间，
      //   前端既看不到这条消息、也收不到任何回合信号（表现为窗口卡死/无状态，须切会话才看到）。
      try { saveSession(s); } catch { }
      try { runtime.emit('turn-progress', { sessionId: s.id, iter: maxIter, step: toolCallsCount, tool: '（已达单回合工具上限，自动续跑准备中）', maxIterHit: true }); } catch { }
    }
    // —— 信箱续跑判定（实例内、同进程；开关 cfg.mailboxAutoResume，可即时关停）——
    //    停止原因为「达迭代上限」或「工具死循环护栏」、且该会话仍有信箱待办 → 自动再注入一轮（上限 goalMaxRounds）。
    let __resume = false;
    // v6.1：paused(达上限/死循环) 照旧；另"正常结束且收到未被本轮消费的新待办"在开关开启时也续跑一轮（忙则排队续跑）
    const normalEnd = (endedBy !== 'maxIter' && endedBy !== 'loopStop');
    const resumeByPending = normalEnd && cfg.mailboxAutoResumeOnIdle !== false;
    if ((endedBy === 'maxIter' || endedBy === 'loopStop' || resumeByPending) && cfg.mailboxAutoResume !== false
        && resumeRound < maxResume && !(s.controller && s.controller.signal.aborted)) {
      try {
        const mb = require('./mailbox');
        const role = selfRole();
        if (mb.available() && role) {
          const pend = mb.listPendingForSession(role, s.id).filter((m) => !injectedIds.has(m.id));
          if (pend.length) {
            resumeRound++;
            __resume = true;
            s._turnOrigin = 'resume';   // 任务② T-C：续跑来源标注
            for (const m of pend) injectedIds.add(m.id);
            mb.markProcessing(pend.map((m) => m.id));
            s.messages.push({ role: 'user', content: `[信箱续跑 第${resumeRound}轮] 信箱仍有 ${pend.length} 条待办消息，请继续处理：\n` + pend.map((m) => `${m.from_id}: ${String(m.content).slice(0, 800)}`).join('\n'), engine: true });
            try { saveSession(s); } catch { }   // v6.23：续跑轮边界落盘（前端中途 reload 也能看到最新内容）
            try { runtime.emit('turn-progress', { sessionId: s.id, iter: 0, step: 0, round: resumeRound, tool: `（信箱续跑 第${resumeRound}轮）` }); } catch { }
          }
        }
      } catch (e) { /* 续跑判定失败不阻塞收尾 */ }
    }
    // —— v6.9 方案A：回合正常结束 → 本会话在"本轮开始后"仍有新到达的未读（含 reply）→ 自动续跑一轮 ——
    //    根治"忙时到达的回执漏收"：wakeMailbox 判忙跳过、reply 不计入 listPendingForSession → 原无兜底。
    //    ★四重防死循环：①仅 m.ts > startedAt 的新到达未读（本轮已注入/消费的 id 排除）；
    //    ②连续自动续跑上限 MAILBOX_UNREAD_RESUME_MAX(=3)，达上限即停；③会话 running 中不触发（本块只在
    //    本轮回合循环内、只"续跑自己"不另起进程）；④与下方 wakeMailbox 互斥：本块置 __resume=true 后，
    //    wakeMailbox 块因 !__resume 跳过 → 同一轮绝不重复触发。开关 cfg.mailboxAutoResumeOnUnread=false 即时回退。
    if (!__resume && normalEnd && cfg.mailboxAutoResumeOnUnread !== false
        && unreadResumeRound < MAILBOX_UNREAD_RESUME_MAX
        && !(s.controller && s.controller.signal.aborted)) {
      try {
        const mb = require('./mailbox');
        const role = selfRole();
        if (mb.available() && role) {
          // v6.25 确认回环(ack loop)修复：续跑数据源**仅认动作类(task)**——reply/ack/notify 仍经 SSE/marker 上屏，
          //   但绝不触发 __resume 续跑（解耦"上屏可见性"与"续跑"）。否则对方每条回执都勾起本回合再续跑一轮，
          //   上限 3 轮即出现"同一批回执多轮上屏"。开关同 cfg.mailboxAutoResumeOnUnread。
          const fresh = mb.fetchUnreadForSession(role, s.id, 20)
            .filter((m) => Number(m.ts) > startedAt && !injectedIds.has(m.id) && isActionableType(m, cfg));
          if (fresh.length) {
            unreadResumeRound++;
            for (const m of fresh) injectedIds.add(m.id);
            for (const m of fresh) {   // v6.9：动作类入站记入补回写集合
              if (m.type !== 'reply' && m.type !== 'ack' && m.type !== 'notify' && m.from_id && m.from_id !== role) {
                turnActionableIds.add(m.id);
                if (m.correlation_id) turnCids.set(String(m.correlation_id), String(m.from_id));   // P2b-4 T2：记录 cid 供停手检查点
                if (m.correlation_id) { try { turnOrigins.set(String(m.correlation_id), { from: String(m.from_id || ''), session: String(m.from_session_id || '') }); } catch { } }
              }
            }
            mb.markRead(fresh.map((m) => m.id));   // 已消费 → 防下一回合起始重复注入
            // 行为层定案：仅**动作类**纳入自动回执，与"回合起始注入"路径一致（reply/ack/notify 不回执=防回执乒乓）
            if (cfg.mailboxAutoReply !== false) {
              for (const m of fresh) {
                if (isActionableType(m, cfg) && !m.wake_intent && m.from_id && m.from_id !== role) mailboxInbound.push({ id: m.id, from_id: m.from_id });
              }
            }
            __resume = true;
            s._turnOrigin = 'resume';   // 任务② T-C：续跑来源标注
            try { saveSession(s); } catch { }   // v6.23：续跑轮边界落盘
          try { runtime.emit('turn-progress', { sessionId: s.id, iter: 0, step: 0, round: unreadResumeRound, tool: `（信箱自动续跑 第${unreadResumeRound}轮）` }); } catch { }
          {
            const _fmt = (m) => `${m.from_id}${m.type === 'reply' ? '（回执）' : m.type === 'ack' ? '（确认）' : m.type === 'notify' ? '（通知）' : ''}: ${String(m.content).slice(0, 800)}`;
            const _act = fresh.filter((m) => isActionableType(m, cfg));
            const _sil = fresh.filter((m) => !isActionableType(m, cfg));
            const _parts = [];
            if (_act.length) _parts.push(`[信箱自动续跑 第${unreadResumeRound}轮] 本轮结束后收到 ${_act.length} 条新消息，请继续处理：\n` + _act.map(_fmt).join('\n'));
            // 防回执乒乓：回执/通知类**独立成段**，明示"仅供知晓，无需回复"，绝不与"请继续处理"混排。
            if (_sil.length) _parts.push(`[信箱自动续跑 第${unreadResumeRound}轮·回执/通知] 本轮结束后收到 ${_sil.length} 条回执/通知，**仅供知晓，无需回复**（请勿再回执，避免往复）：\n` + _sil.map(_fmt).join('\n'));
            let _rTxt = _parts.join('\n\n');
            try { _rTxt += maybeSelfHint(s, cfg, String(s.title || '') || _rTxt.slice(0, 200), false); } catch { }
            s.messages.push({ role: 'user', content: _rTxt, engine: true });
          }
          }
        }
      } catch (e) { /* 自动续跑判定失败不阻塞收尾 */ }
    }
    // —— 批1 L3-④ 有界自续（非心跳·引擎级）：达上限 + 无信箱待办 + 本轮有实质进展 → 自动再续一轮 ——
    //    硬上限 AUTO_RESUME_MAX(=2) 轮；开关 cfg.autoResume(缺省 true) 即时回退。
    //    优先级：信箱续跑 > 有界自续（上方已置 __resume 则本块跳过）。复用同一 __resume/resume 循环通道。
    if (!__resume && endedBy === 'maxIter' && cfg.autoResume !== false
        && autoResumeRound < AUTO_RESUME_MAX && turnProgOps > 0
        && !(s.controller && s.controller.signal.aborted)) {
      try {
        const mb = require('./mailbox');
        const role = selfRole();
        const pend = (mb.available() && role) ? mb.listPendingForSession(role, s.id).filter((m) => !injectedIds.has(m.id)) : [];
        if (!pend.length) {   // 无信箱待办才自续（有则交给上方信箱续跑）
          autoResumeRound++;
          __resume = true;
          s._turnOrigin = 'auto-resume';
          s.messages.push({ role: 'user', content: `[有界自续 第${autoResumeRound}轮] 继续完成剩余工作；若为执行/产出类，优先派雷影（agent_send）；若为本职不可委派类，继续分段落盘（log_progress）。`, engine: true });
          try { saveSession(s); } catch { }
          try { runtime.emit('turn-progress', { sessionId: s.id, iter: 0, step: 0, round: autoResumeRound, tool: `（有界自续 第${autoResumeRound}轮）` }); } catch { }
        }
      } catch (e) { /* 有界自续判定失败不阻塞收尾 */ }
    }
    // v6.2 覆盖缝隙兜底：忙时到达的 reply 类回执「不唤醒、不续跑」——本回合正常结束、无待续跑、
    // 且开关开启时，延迟一拍（等 runChat 的 finally 释放 s.running）再调 wakeMailbox；其自带「空闲+有未读(含 reply)」
    // 守卫，无未读绝不空转。★防回环：wakeMailbox 起常规回合，runtime 对 reply 类入站不自动回执（mailboxInbound
    // 已 filter type!=='reply'），不会 A↔B 互唤醒。开关 cfg.mailboxWakeAfterTurn=false 可即时回退。
    if (!__resume && normalEnd && cfg.mailboxWakeAfterTurn !== false
        && !(s.controller && s.controller.signal.aborted)) {
      setTimeout(() => { try { wakeMailbox(s.id); } catch { } }, 0);
    }
    // P6-S3：未读续跑已达上限(=MAILBOX_UNREAD_RESUME_MAX)而仍有动作类待办 → 告警（不静默）；drain 已兜底。
    try {
      if (!__resume && normalEnd && unreadResumeRound >= MAILBOX_UNREAD_RESUME_MAX) {
        const mb3 = require('./mailbox'); const role3 = selfRole();
        if (mb3.available() && role3) {
          const p3 = mb3.listPendingForSession(role3, s.id).filter((m) => !injectedIds.has(m.id) && isActionableType(m, cfg));
          if (p3.length) console.warn(`[mailbox-resume] 告警：sid=${s.id} 未读续跑达上限(${MAILBOX_UNREAD_RESUME_MAX}) 仍有 ${p3.length} 条动作类待办 → 停续跑，已登记 drain 兜底`);
        }
      }
    } catch { }
    // P6（refs=mailbox-structural）：任一回合收尾即**统一 drain**（把散落丢弃点收口为"回合收尾重扫"）；
    //   server.js 的 90s 周期兜底仍在（双保险）。
    if (!__resume) { try { enqueueRoleDrain(selfRole(), { delayMs: 0 }); } catch { } }
    if (!__resume) break;
    } while (true);
  } catch (e) {
    // 任务B：模型服务不可用 → 除 SSE error 帧外，在会话里留一条明确说明（气泡持久可见，不只闪一个 toast）。
    //   有部分流式草稿 → 附加说明到草稿末尾（由 finally 的 recoverDraft 物化）；无草稿 → 直接补一条 assistant 消息并落盘。
    if (e && e.llmUnavailable) {
      try {
        // v6.37：区分「可重试」与「需用户动手」——402 欠费/401 鉴权不能写"点重试"，要给可操作指引。
        const why = e.llmReasonText || e.llmReason || '未知原因'; const _hint = e.llmNeedsUserAction ? '（请按上述提示处理后重新发送）' : '（可点顶部横幅「重试」）'; const note = `⚠ 模型服务不可用：${why}${_hint}`; try { turnFailReason = why; } catch { }
        if (typeof s.replyDraft === 'string' && s.replyDraft.trim()) {
          s.replyDraft = s.replyDraft.replace(/\s+$/, '') + '\n\n' + note;
        } else {
          s.messages = s.messages || [];
          s.messages.push({ role: 'assistant', content: note, _llmUnavailable: true, llmReason: e.llmReason || null, llmNeedsUserAction: !!e.llmNeedsUserAction });
          saveSession(s);
        }
      } catch { /* 落说明失败不得影响错误上抛 */ }
    }
    evt.error && evt.error({ message: e.message, llmUnavailable: !!e.llmUnavailable, llmReason: e.llmReason || null, llmReasonText: e.llmReasonText || null, needsUserAction: !!e.llmNeedsUserAction });
    throw e;
  } finally {
    const _turnAborted = !!stopped || !!s._abortedAt;   // 支干：失败/中断轮标记（须在下方清零前捕获）
    if (wdTimer) { try { clearInterval(wdTimer); } catch { } wdTimer = null; }   // v6.6：清理看门狗定时器（防泄漏）
    if (busyHbTimer) { try { clearInterval(busyHbTimer); } catch { } busyHbTimer = null; }   // v7：清理 busy 心跳定时器（防泄漏）
    // G3 中断内容保全：回合若因异常/中止结束仍有未落盘的流式草稿 → 物化为正式 assistant 消息（防内容丢失）
    try { if (typeof s.replyDraft === 'string' && s.replyDraft.trim()) recoverDraft(s); } catch { }
    // 1) 完成信号先行：done 立即发出 → 客户端燃烧动画/待机态即刻恢复
    s.running = false;   // 提前释放运行标记；收尾压缩期间新回合经 _compactBusy 锁等待
    // v6.4：回合收尾 → 置空闲（busy 指示器准确信号；null=空闲）
    try { require('./mailbox').clearBusy(selfRole()); } catch { }
    try { require('./mailbox').touchLastSeen(selfRole()); } catch { }   // B1：回合收尾刷新实例心跳（原 touchLastSeen 全仓无调用者 → last_seen 冻结）
    // v6.x 修法B：回合收尾补标（忙时到达的入站标记落库；须在 evt.done/turn-done 之前，前端 reload 才能读到）
    try { if (flushPendingInbound(s)) saveSession(s); } catch { }
    // 唤醒盲区根治：回合收尾复查未读（有界重试 0/5s/30s）——堵"回合已结束、下回合未开始"间隙投递的静默盲区。
    //  D4：本回合若有"忙时到达的入站标记"经 flushPendingInbound 落库（delayed 补标）→ 即使 unread 已被本回合消费为空，
    //      也 **force 补唤醒一次**，确保"忙时到达的回执"在回合结束后被一个专属回合可靠处理（每回合至多一次；
    //      flush 已清空 _pendingInbound → 该补唤醒回合不会再有补标 → 无自环）。
    try {
      const _flushed = ((s && s._lastFlushedInbound) || []).filter((it) => it && it.msgId != null);
      const _unInjected = _flushed.filter((it) => !injectedIds.has(it.msgId));
      if (s) s._lastFlushedInbound = null;
      // v6.26 主我新定案（取代 2026-09-19 旧口径）：force 补唤醒亦**仅认动作类**——reply/ack/notify 不再驱动新回合
      //  （方案A：根治"未读续跑"放大）；可见性由 SSE 上屏 + 回合起始注入保住。开关 cfg.mailboxWakeOnlyActionable=false 回退。
      const _actN = _flushed.filter((it) => isActionableType(it, cfg)).length;
      if (_flushed.length) {
        try { console.log(`[mailbox-sweep] sid=${s.id} 检出忙时到达补标 ${_flushed.length} 条（动作类 ${_actN} 条 / 回执类 ${_flushed.length - _actN} 条，未注入本回合 ${_unInjected.length} 条，msgId=${_flushed.map((x) => x.msgId).join(',')}）→ force 补唤醒（仅动作类）`); } catch { }
        // v6.48（打回重修·残余根因）：未注入的动作类补标 → 直接强制补唤醒（skipUnread），不再依赖 DB-unread 门控。
        const _actUninj = _unInjected.filter((it) => isActionableType(it, cfg)).length;
        // v6.49（P3·补唤醒不空转）：**必须延到 finally 清理之后再起回合**——否则紧随其后的 `s.controller = null`
        //   会清掉新回合控制器 → 新回合读 s.controller.signal 抛 null → 静默死亡（"补唤醒空回合"根因）。
        //   同时把"动作类未注入"的 msgId 透传 injectMsgIds，按 id 从库取正文精确注入（不空转·契约 B）。
        const _actUninjIds = _unInjected.filter((it) => isActionableType(it, cfg)).map((it) => it.msgId).filter((x) => x != null);
        if (_actUninjIds.length > 0) {
          const _wsid = s.id;
          try {
            const t = setTimeout(() => {
              try {
                const s2 = getSession(_wsid);
                if (!s2 || s2.running || s2._compactBusy) { try { console.log(`[mailbox-sweep] sid=${_wsid} D4 延后补唤醒 skip:busy`); } catch { } return; }
                const rr = wakeMailboxForced(_wsid, { skipUnread: true, injectMsgIds: _actUninjIds });
                try { console.log(`[mailbox-sweep] sid=${_wsid} D4 延后强制补唤醒 动作类未注入=${_actUninjIds.length} -> ${rr && rr.ok === false ? 'skip:' + rr.reason : 'WOKE'}`); } catch { }
              } catch (e2) { try { console.log('[mailbox-sweep] D4 延后补唤醒异常: ' + (e2 && e2.message)); } catch { } }
            }, 0);
            if (t && typeof t.unref === 'function') t.unref();
          } catch { }
        }
        else scheduleIdleUnreadSweep(s.id, { force: true });
      } else {
        scheduleIdleUnreadSweep(s.id);
      }
    } catch { }
    // P2b-4 T1：修订 abort 收尾 —— 显式复用 wakeMailboxForced 强注入最新版（详见 reinjectPendingRevision）。
    if (s._pendingRevision) {
      // v6.49：同样延后到 finally 清理之后（避免紧随的 s.controller=null 清掉新回合控制器 → 空转）。
      try { const _rsid = s.id; const _t2 = setTimeout(() => { try { const _rr = reinjectPendingRevision(_rsid); try { console.log(`[mailbox-rev] sid=${_rsid} cid=${_rr && _rr.cid} -> ${(_rr && _rr.wake && _rr.wake.ok) ? 'WOKE' : 'skip:' + ((_rr && _rr.wake && _rr.wake.reason) || (_rr && _rr.reason) || '?')}`); } catch { } } catch { } }, 0); if (_t2 && typeof _t2.unref === 'function') _t2.unref(); } catch { }
      try { runtime.emit('turn-progress', { sessionId: s.id, iter: 0, step: 0, tool: `（修订：已中止当前回合，按最新版重注入）` }); } catch { }
    }
    s.controller = null;
    s._runStartedAt = 0; s._abortedAt = 0;   // v6.7：清运行态时间戳（配合卡死收割器）
    s.updatedAt = new Date().toISOString();
    // E（会诊定案·2026-09-30）：internalMailbox 回合若 out=0 且 miss=0 → 判注入失败、打告警（空回合绝不正常）。
    if (internalMailbox && Number(usage.outputTokens) === 0 && Number(usage.missTokens) === 0) {
      try { console.warn(`[mailbox-inject] 告警：internalMailbox 回合为空（out=0 && miss=0）→ 疑入站注入失败 sid=${s.id} injectMsgIds=${(opts.injectMsgIds || []).join(',') || '-'} prefixLen=${(mailboxPrefix || '').length} unreadLen=${(mailboxInbound || []).length}`); } catch { }
    }
    addSessionUsage(s, usage, startedAt);
    accumulateGlobal(usage, text, lastTtfb, startedAt, s.id);
    // @会话 v2（2026-10-02）：回合末若 @ 了目标但本回合未调用 send_to_session → 通知前端"未转达"。
    try {
      const _mst = _mentionTurnState.get(String(s.id));
      if (_mst) {
        _mentionTurnState.delete(String(s.id));
        const _un = _mst.targets.filter((t) => !_mst.fulfilled.has(String(t)));
        if (_un.length && evt.mentionUnfulfilled) { try { evt.mentionUnfulfilled({ targets: _un }); } catch { } }
      }
    } catch { }
    evt.done && evt.done({
      text, stopped, usage, ttfbMs: lastTtfb, durationMs: Date.now() - startedAt,
    });
    // 世界树·支干（P0）：每轮结束写一条 turn 骨架（双写、附加式；失败静默，绝不影响主流程）。
    // 世界树·支干（批A·A3/A6）：轮末统一 flush —— user 轮写 turn 骨架(turn_no=MAX+1) 并把本轮事件挂同一 turn_no；
    //   非 user 轮不自增、挂上一 user 轮 + sub_seq。明细(kind='detail') 记本轮工具与答复要点。失败静默，绝不影响主流程。
    try {
      const _tools = [...new Set((turnToolNames || []).filter(Boolean))].slice(0, 20).join(',');
      const _detail = `工具${toolCallsCount}次${_tools ? '：' + _tools : ''}｜${String(text || '').replace(/\s+/g, ' ').slice(0, 160)}`;
      const _ft = branch.flushTurn({ sessionId: s.id, turnId: branchTurnId, gen: branchTurnGen, summary: branchTurnSummary(content, text, turnToolNames), origin: (s._turnOrigin || origin), ts: Date.now(), aborted: _turnAborted, detail: _detail, topicKey: (turnTaskTopic || null) });
      // A1（2026-09-25）：自动归枝（规则法·零成本）——仅对本轮 turn_no 的未归行补枝键，不命中留 NULL 不猜；异常静默。
      try {
        if (_ft && _ft.ok && _ft.turnNo != null && !_turnAborted) {
          const _sch = branchTurnSummary(content, text, turnToolNames);
          const _ar = branch.autoAssignTopic(s.id, _ft.turnNo, _sch);
          try { console.log(`[auto-topic] sid=${s.id} turn=${_ft.turnNo} reason=${_ar.reason} assigned=${_ar.assigned}${_ar.topic ? ' topic=' + _ar.topic : ''}${_ar.score ? ' score=' + _ar.score : ''}`); } catch { }
        }
      } catch { }
      // A1''（2026-09-29·D）：轮末兜底整代重整 —— 若"刚闭合的上一代"（branchTurnGen-1）尚未重整，则补做（幂等）。
      //   交接后首回合：branchTurnGen 已 +1 → closedGen=上一代，天然覆盖"交接后首回合"；异步不阻塞回合。
      try { if (!_turnAborted) setTimeout(() => { maybeReflowGen(s, branchTurnGen - 1).catch(() => { }); }, 0); } catch { }
    } catch { }
    // v4-4 T-C：周期压缩钩子 —— 仅当 config.branchAutoCompact === true 时才真正执行（默认 false → 立即返回，零副作用）。
    try { branch.maybeAutoCompact(s.id); } catch { }
    // 内部回合实时上屏：flush 本会话两 kind 余量（须在 turn-done 之前，确保最后片段先于终止事件上屏）
    try { flushTurnStreamSession(s.id); } catch { }
    // v6.1.2：turn-done 带本轮 token 用量，供前端涟漪流展示"本次 token + 命中率"
    {
      const __rd = (usage.hitTokens || 0) + (usage.missTokens || 0);
      runtime.emit('turn-done', {
        sessionId: s.id,
        usage: {
          promptTokens: __rd,
          hitTokens: usage.hitTokens || 0,
          missTokens: usage.missTokens || 0,
          outputTokens: usage.outputTokens || 0,
          cacheHitRate: __rd ? (usage.hitTokens || 0) / __rd : 0,
          durationMs: Date.now() - startedAt,
        },
      });
    }
    // v3：世代交接不再在回合末触发——改在下一回合起始（回答前）完成；这里只落盘本轮状态
    saveSession(s);
    // v5.2 自动回执：回合结束把最终答复作为 reply 发回发送方（复用 v5.1 反向映射归位原会话；防回环靠 type='reply'）
    if (cfg.mailboxAutoReply !== false && mailboxInbound.length) {
      try {
        const mb = require('./mailbox');
        const role = selfRole();
        if (mb.available() && role) {
          const targets = [...new Set(mailboxInbound.map((m) => m.from_id))];
          for (const R of targets) {
            const items = mailboxInbound.filter((m) => m.from_id === R);
            const ids = items.map((m) => m.id);
            // 本轮已主动 agent_send 回执过 R → 不重复发，仅标记已回
            if (!mb.hasReplySince(role, R, startedAt)) {
              // GAP-4：精确回执——取该回合消费 task 的 cid 发 **result**，走 closeTaskByCid（精确关单，非启发式）。
              const cids = [...new Set(items.map((m) => m.correlation_id).filter(Boolean))];
              if (cids.length) {
                for (const c of cids) {
                  mb.sendToRole({ fromRole: role, fromSessionId: s.id, toRole: R,
                    content: (text && String(text).trim()) ? text : `⚠ 本轮模型未返回内容${turnFailReason ? `（原因：${turnFailReason}）` : ''}。未产生实质结果，如需继续请重新派单。`, type: 'result', correlationId: c, outcome: 'done' });
                }
              } else {
                // 无 cid（存量 task）→ 发 result 无 cid，由 P2b-6 在 sendMessage 内自动补 cid 精确关单；仍无则 P1a 兜底。
                mb.sendToRole({ fromRole: role, fromSessionId: s.id, toRole: R,
                  content: (text && String(text).trim()) ? text : `⚠ 本轮模型未返回内容${turnFailReason ? `（原因：${turnFailReason}）` : ''}。未产生实质结果，如需继续请重新派单。`, type: 'result', outcome: 'done' });
              }
            }
            mb.markReplied(ids);
          }
        }
      } catch (e) { /* 自动回执失败不得影响回合收尾 */ }
    }
    // v6.9 补回写（收口路径）：回合被中断/异常结束（看门狗 abort / 错误 / 上限 / 收割）时，
    //   本回合已消费的动作类入站 task 若仍 replied_at=NULL，补一次 markReplied → 
    //   防 listPendingForSession 把它当"假待办"引发对端续跑循环（≤30min）。幂等，不覆盖已有 replied_at。
    try {
      const mb2 = require('./mailbox');
      const _ids = turnActionableIds.size ? [...turnActionableIds] : [];
      // v6.34：信息类（reply/ack/notify 等）已消费 → 一并终态化（replied_at 置位 + status='done'）→ 不再被 listPending 命中（现象B）
      if (turnInformationalIds.size) for (const id of turnInformationalIds) _ids.push(id);
      if (_ids.length && mb2.available() && mb2.sendInterruptedResults) mb2.sendInterruptedResults(_ids, { fromRole: selfRole(), fromSessionId: s.id, outcome: 'failed', content: '⚠ 回合被中断，未产生结果，请重发' });
    } catch { /* 补回写失败不得影响收尾 */ }
    // P2b-4 T2：撤回停手 → 回 result(cancelled) 给发起方（幂等；终态单调由 sendMessage/closeTaskByCid 保证）。
    if (turnCancelCid) {
      try {
        const mb3 = require('./mailbox'); const role3 = selfRole();
        const toWho = turnCids.get(turnCancelCid) || 'main';
        if (mb3.available() && role3) {
          mb3.sendToRole({ fromRole: role3, fromSessionId: s.id, toRole: toWho, type: 'result',
            correlationId: turnCancelCid, outcome: 'cancelled', summary: '任务已撤回，接收方停手',
            content: `任务 ${turnCancelCid} 已撤回，停手。` });
        }
      } catch { }
    }
    try { s._turnConsumedIds = null; } catch { }
  try { s._turnConsumedInfoIds = null; } catch { }
        // v5.7：调度会话回合结束 → 把答复 notify 静默投递回各原始派活会话（用户下次交互读到摘要）
    if (s.project === 'dispatcher' && cfg.mailboxDispatcherForMain !== false && mailboxOrigins.length) {
      try {
        const mb = require('./mailbox');
        if (mb.available() && mb.notifySession) {
          for (const osid of mailboxOrigins) mb.notifySession(osid, text || '(调度会话无内容)');
        }
      } catch { }
    }
    // 反思进化（不阻塞回复）
    // reflectionEnabled = 反射总开关（false 时连 /refine 也不反射）；
    // reflectionAuto = 自动反射开关（false 时仅 /refine 手动触发，禁止"工具调用≥2 自动反射"）。
    const autoOk = cfg.reflectionAuto !== false && toolCallsCount >= 2;
    if (cfg.reflectionEnabled && (autoOk || opts.forceReflect)) {
      const throttleOk = Date.now() - (s.lastReflectAt || 0) > REFLECT_THROTTLE_MS;
      if (throttleOk || opts.forceReflect) {
        s.lastReflectAt = Date.now();
        reflect(s, { force: !!opts.forceReflect, branchTurnId, branchGen: branchTurnGen }).catch(() => {});
      }
    }
  }
  return { text, usage, stopped, toolCallsCount };
}

/** v6.x 修法B：判断末尾是否仍有未应答 tool_calls（同 server.hasPendingToolCalls 逻辑）。
 *  有则不得插入 user 标记（会破坏 assistant(tool_calls)→tool 配对 → DeepSeek 400）。 */
function _hasPendingToolCalls(messages) {
  let pending = 0;
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'assistant') {
      const tcs = m.toolCalls || m.tool_calls || [];
      pending += tcs.length;
    } else if (m.role === 'tool') {
      if (pending > 0) pending -= 1;
    }
  }
  return pending > 0;
}

/** v6.33（陈旧悬空豁免）：返回**最陈旧未闭合工具轮**的 ts（ms）；无未闭合或无 ts 则返回 null。
 *  与 _hasPendingToolCalls 同源配对算法（FIFO 栈），仅额外记录未闭合 assistant 的 ts。 */
function _pendingToolCallOldestTs(messages) {
  const stack = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'assistant') {
      const tcs = m.toolCalls || m.tool_calls || [];
      const ts = Number(m.ts || m.time || m.timestamp || 0) || null;
      for (let i = 0; i < tcs.length; i++) stack.push(ts);
    } else if (m.role === 'tool') {
      if (stack.length) stack.shift();
    }
  }
  let oldest = null;
  for (const ts of stack) { if (ts) oldest = (oldest == null) ? ts : Math.min(oldest, ts); }
  return oldest;
}

/** v6.33：陈旧阈值（ms）——悬空工具轮/滞留队列超过此龄则放行 drain（默认 10 分钟）。
 *  保留"新鲜悬空仍等待配对"（防在途工具轮被误判）；配置项 mailboxPendingDrainStaleMs 可调。 */
function _pendingDrainStaleMs() {
  try { const v = Number(loadConfig().mailboxPendingDrainStaleMs); return (isFinite(v) && v > 0) ? v : 10 * 60 * 1000; } catch { return 10 * 60 * 1000; }
}

/** v6.32（2026-09-29·liveness 根治）：回滚开关——mailboxPendingDrain 默认 true=新行为（有界重试 + 起始注入锚点）。 */
const PENDING_DRAIN_MAX_RETRY = 10;   // 有界下-tick 重试上限（防死循环，超限告警）
function _pendingDrainOn() { try { const v = loadConfig().mailboxPendingDrain; return v !== false; } catch { return true; } }

/** 会话是否存在"未投递入站项"：延迟队列非空 **或** 已落库但未注入本回合（_lastFlushedInbound）。
 *  v6.32：唤醒判据的新锚点（取代"仅类型=actionable"）——reply/result(非首个) 也据此获得一次轻量注入回合。 */
function _hasUndeliveredInbound(s) {
  try {
    if (!s) return false;
    if ((s._pendingInbound || []).length) return true;
    if ((s._lastFlushedInbound || []).length) return true;
    return false;
  } catch { return false; }
}

/**
 * v6.32（liveness 根治）：**单一排空路径** drainPendingInbound(s, opts)。
 *  幂等排空 s._pendingInbound → 注入 s.messages（user 标记）→ **成功才清**。
 *  opts.at === 'start' → 回合起始注入（已入本回合上下文 → 不留补唤醒标记，防自环）；
 *  否则（回合收尾/启动兜底）→ 成功注入者记入 s._lastFlushedInbound（供收尾补唤醒判据）。
 *  遇未闭合 tool 对（_hasPendingToolCalls）→ **有界下-tick 重试**（最多 PENDING_DRAIN_MAX_RETRY 次），不静默丢；
 *  超限则告警保留队列（等下次触发）。
 *  开关 mailboxPendingDrain=false → 回到旧行为（静默保留、不重试、不区分 at）。
 *  @returns {number} 本次实际注入条数；-1=排空被推迟（重试中）；0=无待排空/开关关闭
 */
function drainPendingInbound(s, opts = {}) {
  try {
    const on = _pendingDrainOn();
    const q = s && s._pendingInbound;
    if (!q || !q.length) return 0;
    if (_hasPendingToolCalls(s.messages)) {
      if (!on) return 0;   // 旧行为：静默保留，等下回合收尾
      // v6.33：陈旧悬空豁免——历史遗留的未闭合工具轮不应永久卡死入站投递。
      let stale = false;
      try {
        const lim = _pendingDrainStaleMs();
        const nowMs = Date.now();
        const aTs = _pendingToolCallOldestTs(s.messages);       // 悬空工具轮年龄
        if (aTs && (nowMs - aTs) >= lim) stale = true;
        if (!stale) {                                            // 或队列滞留超时
          let qTs = Infinity;
          for (const it of q) { const t = Number(it && it.ts); if (t) qTs = Math.min(qTs, t); }
          if (isFinite(qTs) && (nowMs - qTs) >= lim) stale = true;
        }
      } catch { }
      if (!stale) {   // 新鲜悬空 → 仍等待配对（防在途工具轮被误判）
        const n = Number(s._pendingDrainRetry || 0);
        if (n >= PENDING_DRAIN_MAX_RETRY) {
          try { console.warn(`[pending-drain] sid=${s.id} 未闭合工具轮持续 ${PENDING_DRAIN_MAX_RETRY} 次重试仍无法排空，队列保留(${q.length}条)待下次触发`); } catch { }
          return -1;
        }
        try { s._pendingDrainRetry = n + 1; } catch { }
        try { const t = setTimeout(() => { try { drainPendingInbound(s, opts); } catch { } }, 0); if (t && typeof t.unref === 'function') t.unref(); } catch { }
        return -1;
      }
      try { console.warn(`[pending-drain] sid=${s.id} 陈旧悬空工具轮（超 ${_pendingDrainStaleMs()}ms）→ 豁免配对闸，放行排空(${q.length}条)`); } catch { }
    }
    try { s._pendingDrainRetry = 0; } catch { }
    const pushed = [];
    for (const it of q) {
      if (!it) continue;
      const dup = s.messages.some((m) => m && m._inbound && (
        (it.msgId != null && String(m._inbound.msgId) === String(it.msgId)) ||
        (it.msgId == null && m._inbound.from === it.from && m._inbound.ts === it.ts)
      ));
      if (dup) continue;
      s.messages.push(buildInboundMarker(it.from, it.type, it.msgId, it.content, it.ts, it.wake_intent || it.notify_target || null, { delayed: true }));
      pushed.push(it);
    }
    s._pendingInbound = [];   // 成功才清（唯一清队列处）
    try {
      if (on && opts.at === 'start') s._lastFlushedInbound = null;      // 起始注入=已消费，不留补唤醒标记（防自环）
      else if (pushed.length) s._lastFlushedInbound = pushed;
    } catch { }
    if (pushed.length) { try { runtime.emit('inbound-flushed', { sessionId: s.id, count: pushed.length, at: String(opts.at || 'end') }); } catch { } }
    return pushed.length;
  } catch { return 0; }
}

/** v6.x 修法B（兼容包装）：回合收尾补写——现委托单一排空路径 drainPendingInbound。
 *  幂等（同 msgId / 同 from+ts 已存在则跳过）。返回补写条数。 */
function flushPendingInbound(s) { return drainPendingInbound(s, {}); }

/** v6.32：入队即驱动——排空 + 补唤醒（不阻塞调用方）。忙时由回合收尾处理；空闲则下-tick 排空并复查未读。 */
function schedulePendingDrain(sessionId) {
  try {
    const s = getSession(sessionId);
    if (!s) return;
    if (s.running || s._compactBusy) return;   // 忙：回合收尾/下次触发兜底
    try { const t = setTimeout(() => {
      try {
        const cs = getSession(sessionId);
        if (!cs) return;
        const n = drainPendingInbound(cs, {});
        if (n) saveSession(cs);
        if (_hasUndeliveredInbound(cs)) scheduleIdleUnreadSweep(sessionId, { force: true });
      } catch { }
    }, 0); if (t && typeof t.unref === 'function') t.unref(); } catch { }
  } catch { }
}

/** v6.33（2026-09-29）：把消息类型/语义归类为"应注入"（动作类）——仅 task 与"首个 actionable result"。
 *  reply/ack/notify 及非 actionable 的 result **设计上不注入上下文**（仅落库/上屏），不计入 liveness 泄漏。 */
function _isInjectableKind(type, wakeIntent) {
  const t = String(type || 'task');
  if (t === 'task') return true;
  if (t === 'result') return String(wakeIntent || '') === 'actionable';
  return false;   // reply / ack / notify 及未知 → 非应注入
}

/** v6.33：识别"系统自动通知"模板（超期 expired / 收尾催办）——此类**设计上不注入**上下文（仅提醒一次），
 *  即便历史遗留行 sys_notice 未标（列早于本次修复），也据内容模板排除，防失真计入。 */
const _SYS_NOTICE_RE = /^任务 \S+ (已超期未完成|已完成但尚未收口)/;
function _isSystemNoticeText(content) { try { return _SYS_NOTICE_RE.test(String(content || '').trim()); } catch { return false; } }

/** v6.33（liveness 诊断·req⑤）：会话级入站投递不变量——"应注入却未注入"= 0。
 *  口径修正（治"永远非0失真"）：
 *   ① 只统计**应注入**者：task + 首个 actionable result；**排除 reply/ack/notify**（设计不注入）；
 *   ② **排除窗口外旧消息**：无 `_inbound` 标记且 ts < 当前窗口起点者不可辨识 → 计入 undeterminable，不计 readNotInjected；
 *   ③ 若**完全无法判定窗口**（历史上无任何 `_inbound` 标记）→ 诚实返回 readNotInjected=null + reason。
 *  返回 {sid, pendingQueue, lastFlushed, readNotInjected, undeterminable, windowStart, ok}。只读。 */
function inboundLivenessDiag(sessionId) {
  try {
    const s = getSession(sessionId);
    if (!s) return { sid: sessionId, ok: false, reason: 'no-session' };
    const mb = require('./mailbox'); const role = selfRole();
    const pendQ = (s._pendingInbound || []).length;
    const lastF = (s._lastFlushedInbound || []).length;
    if (!mb.available() || !role) return { sid: sessionId, pendingQueue: pendQ, lastFlushed: lastF, readNotInjected: null, undeterminable: null, ok: true, reason: 'mailbox 不可用' };
    const marked = (s.messages || []).filter((m) => m && m._inbound && m._inbound.ts != null);
    const histIds = new Set(marked.map((m) => m._inbound.msgId != null ? String(m._inbound.msgId) : null).filter(Boolean));
    const pendIds = new Set((s._pendingInbound || []).map((x) => x && x.msgId != null ? String(x.msgId) : null).filter(Boolean));
    let windowStart = marked.length ? Math.min(...marked.map((m) => Number(m._inbound.ts))) : null;
    const hasWindow = windowStart != null;
    let readNotInjected = 0, undeterminable = 0, systemNotices = 0;
    try {
      const { DatabaseSync } = require('node:sqlite');
      const h = new DatabaseSync(mb.dbPath(), { readOnly: true });
      try {
        const q = h.prepare("SELECT id, type, wake_intent, sys_notice, content, ts FROM agent_messages WHERE to_id=? AND read_at IS NOT NULL AND (to_session_id=? OR to_session_id IS NULL) ORDER BY ts DESC LIMIT 400");
        const list = q.all(String(role), s.id) || [];
        for (const r of list) {
          const id = String(r.id);
          if (histIds.has(id) || pendIds.has(id)) continue;                    // 已辨识/在队 → 已消费或待消费
          if (!_isInjectableKind(r.type, r.wake_intent)) continue;             // ① 非应注入（reply/ack/notify）→ 设计不注入，跳过
          if (Number(r.sys_notice) === 1 || _isSystemNoticeText(r.content)) { systemNotices++; continue; }   // ①b 系统通知（超期/催办）→ 设计不注入
          if (!hasWindow || (Number(r.ts) || 0) < windowStart) { undeterminable++; continue; }   // ② 窗口外不可辨
          readNotInjected++;                                                   // 窗口内、应注入、未辨注入 → 真泄漏
        }
      } finally { try { h.close(); } catch { } }
    } catch { }
    if (!hasWindow) return { sid: sessionId, pendingQueue: pendQ, lastFlushed: lastF, readNotInjected: null, undeterminable, systemNotices, windowStart: null, ok: true, reason: '窗口外不可辨（历史无 _inbound 标记）' };
    return { sid: sessionId, pendingQueue: pendQ, lastFlushed: lastF, readNotInjected, undeterminable, systemNotices, windowStart, ok: readNotInjected === 0 };
  } catch (e) { return { sid: sessionId, ok: false, reason: e.message }; }
}

/** D3-③：启动兜底补标 —— 遍历会话，把**未运行**会话残留的 _pendingInbound 尽快 flush 落库。
 *  场景：忙时入站标记只挂内存 + 主引擎重启 → 标记丢失、前端气泡永远找不到锚点（孤儿）。
 *  幂等 + 异常安全；已归档/回收站会话跳过（不产生新内容）。返回 {sessions, flushed}。 */
function sweepPendingInbound() {
  let sessions = 0, flushed = 0;
  try {
    for (const meta of listSessions()) {
      if (!meta || meta.running) continue;
      if (meta.archived || meta.trashedAt) continue;
      let s;
      try { s = getSession(meta.id); } catch { continue; }
      if (s.running) continue;
      if (!s._pendingInbound || !s._pendingInbound.length) continue;
      sessions++;
      try { flushed += flushPendingInbound(s); saveSession(s); } catch { }
    }
  } catch { }
  return { sessions, flushed };
}

function accumulateUsage(total, u) {
  if (!u) return;
  total.hitTokens += u.hitTokens || 0;
  total.missTokens += u.missTokens || 0;
  total.outputTokens += u.outputTokens || 0;
}

/** 归一模型名：空值逐级兜底为当前 provider 默认模型（跨实例通用），绝不留 'unknown'
 *  （否则 deepseek 下虽仍落 flash 档，但分桶语义含混、跨 provider 误判）。 */
function _normModel(model) {
  const m = String(model || '').trim();
  if (m) return m;
  try {
    const c = loadConfig();
    return String(c.model || (Array.isArray(c.models) && c.models[0]) || 'deepseek-flash');
  } catch { return 'deepseek-flash'; }
}

/** 成本快照：把"某容器**现有** token"按**当前价表+当前汇率**折算固化（用于旧数据迁移到快照口径）。
 *  返回 { usd, rmb, byGroup:{peak:{usd,rmb},off:{usd,rmb}}, byModel:{m:{usd,rmb}}, rate }。
 *  与 _costSplit 同口径：byModel 分桶各用其价，组内剩余走 provider 兜底价。 */
function _snapshotExisting(container, cfg, rate) {
  const byModel = (container.byModel && Object.keys(container.byModel).length) ? container.byModel : null;
  const acc = { usd: 0, rmb: 0, byGroup: { peak: { usd: 0, rmb: 0 }, off: { usd: 0, rmb: 0 } }, byModel: {}, rate };
  const put = (model, group, c, mult) => {
    acc.usd += c; acc.rmb += c * mult;
    const bg = acc.byGroup[group] || (acc.byGroup[group] = { usd: 0, rmb: 0 });
    bg.usd += c; bg.rmb += c * mult;
    const mb = acc.byModel[model] || (acc.byModel[model] = { usd: 0, rmb: 0 });
    mb.usd += c; mb.rmb += c * mult;
  };
  const multOf = (pri) => (pri.currency === 'CNY') ? 1 : rate;
  for (const group of ['peak', 'off']) {
    const gt = container[group] || {};
    let bHit = 0, bMiss = 0, bOut = 0;
    if (byModel) for (const m of Object.keys(byModel)) {
      const bg = (byModel[m] && byModel[m][group]) || {};
      const h = bg.hitTokens || 0, mi = bg.missTokens || 0, o = bg.outputTokens || 0;
      if (h || mi || o) { const pri = pricesOf(cfg, m); put(m, group, _costGroup(pri, group, h, mi, o), multOf(pri)); }
      bHit += h; bMiss += mi; bOut += o;
    }
    const rH = Math.max(0, (gt.hitTokens || 0) - bHit), rM = Math.max(0, (gt.missTokens || 0) - bMiss), rO = Math.max(0, (gt.outputTokens || 0) - bOut);
    if (rH || rM || rO) { const pri = pricesOf(cfg); put('__fallback__', group, _costGroup(pri, group, rH, rM, rO), multOf(pri)); }
  }
  // 未进 peak/off 分组的剩余（旧数据/异常）→ provider 空闲价
  const pkSum = (container.peak && ((container.peak.hitTokens || 0) + (container.peak.missTokens || 0) + (container.peak.outputTokens || 0))) || 0;
  const offSum = (container.off && ((container.off.hitTokens || 0) + (container.off.missTokens || 0) + (container.off.outputTokens || 0))) || 0;
  const totalSum = (container.hitTokens || 0) + (container.missTokens || 0) + (container.outputTokens || 0);
  if (totalSum > pkSum + offSum) {
    const h = Math.max(0, (container.hitTokens || 0) - (((container.peak || {}).hitTokens || 0) + ((container.off || {}).hitTokens || 0)));
    const mi = Math.max(0, (container.missTokens || 0) - (((container.peak || {}).missTokens || 0) + ((container.off || {}).missTokens || 0)));
    const o = Math.max(0, (container.outputTokens || 0) - (((container.peak || {}).outputTokens || 0) + ((container.off || {}).outputTokens || 0)));
    if (h || mi || o) { const pri = pricesOf(cfg); put('__fallback__', 'off', _costGroup(pri, 'off', h, mi, o), multOf(pri)); }
  }
  return acc;
}

/** 把一次调用的 token 计入容器（总累计 + 该时段 peak/off 分组 + 该模型分桶 + **成本快照**）——单一收口，
 *  供主回合（addSessionUsage/accumulateGlobal）与后台调用（creditUsage）共用，保证同一计价口径。
 *  成本快照：本次增量按"当时的价表 + 当时的汇率"折算并累加（固化历史；改价/改汇率不影响老账）。
 *  首次遇到无快照的容器（旧数据）→ 先把存量 token 按当前价固化为初始快照，再叠加本次增量。
 *  @param {object} container s.stats 或 runtime.globalStats
 *  @param {object} u {hitTokens,missTokens,outputTokens,model}
 *  @param {string} group 'peak'|'off'
 *  @param {string} model 实际请求模型名 */
function _addBucket(container, u, group, model) {
  // ① 成本快照（先固化"存量"，再叠加本次增量；避免本次 token 被计入两次）
  try {
    const cfg = loadConfig();
    const rate = (typeof cfg.usdRate === 'number' && cfg.usdRate > 0) ? cfg.usdRate : 7.2;
    if (!container.costSnap) container.costSnap = _snapshotExisting(container, cfg, rate);
    const pri = pricesOf(cfg, model);
    const mult = (pri.currency === 'CNY') ? 1 : rate;
    const incUsd = _costGroup(pri, group, u.hitTokens || 0, u.missTokens || 0, u.outputTokens || 0);
    const cs = container.costSnap;
    cs.rate = rate;
    cs.usd += incUsd; cs.rmb += incUsd * mult;
    const bg = cs.byGroup[group] || (cs.byGroup[group] = { usd: 0, rmb: 0 });
    bg.usd += incUsd; bg.rmb += incUsd * mult;
    const mb = cs.byModel[model] || (cs.byModel[model] = { usd: 0, rmb: 0 });
    mb.usd += incUsd; mb.rmb += incUsd * mult;
  } catch { }
  // ② token 累计（原口径不变）
  container.hitTokens += u.hitTokens || 0;
  container.missTokens += u.missTokens || 0;
  container.outputTokens += u.outputTokens || 0;
  if (!container[group]) container[group] = { calls: 0, hitTokens: 0, missTokens: 0, outputTokens: 0 };
  const gb = container[group];
  gb.calls++;
  gb.hitTokens += u.hitTokens || 0; gb.missTokens += u.missTokens || 0; gb.outputTokens += u.outputTokens || 0;
  if (!container.byModel || typeof container.byModel !== 'object') container.byModel = {};
  let b = container.byModel[model];
  if (!b) b = container.byModel[model] = { hitTokens: 0, missTokens: 0, outputTokens: 0 };
  b.hitTokens += u.hitTokens || 0; b.missTokens += u.missTokens || 0; b.outputTokens += u.outputTokens || 0;
  if (!b[group]) b[group] = { calls: 0, hitTokens: 0, missTokens: 0, outputTokens: 0 };
  const bb = b[group];
  bb.calls++; bb.hitTokens += u.hitTokens || 0; bb.missTokens += u.missTokens || 0; bb.outputTokens += u.outputTokens || 0;
}

function addSessionUsage(s, u, at) {
  // 按调用时刻（startedAt）判断高峰/空闲，拆分累计到对应分组（用于分时段计价）
  const group = isPeakHour(at) ? 'peak' : 'off';
  const model = _normModel(u && u.model);   // 实际请求模型（按模型分价；空值兜底默认模型）
  const st = s.stats;
  st.calls++;
  _addBucket(st, u, group, model);   // 总累计 + peak/off + byModel 分桶（与后台调用同一收口）
}

function accumulateGlobal(usage, text, ttfb, startedAt, sid) {
  const g = runtime.globalStats;
  g.calls++;
  // 分时段拆分（高峰/空闲）+ byModel 分桶（计价口径与后台调用一致）
  const group = isPeakHour(startedAt) ? 'peak' : 'off';
  const model = _normModel(usage.model);
  _addBucket(g, usage, group, model);
  const dur = Date.now() - startedAt;
  g.durationSumMs += dur; g.durationCount++;
  const denom = g.hitTokens + g.missTokens || 1;
  g.lastCacheHitRate = g.hitTokens / denom;
  const rDenom = (usage.hitTokens || 0) + (usage.missTokens || 0) || 1;
  g.lastTurn = {
    at: new Date().toISOString(), text: text.slice(0, 60), durationMs: dur, ttfbMs: ttfb,
    hitTokens: usage.hitTokens || 0, missTokens: usage.missTokens || 0, outputTokens: usage.outputTokens || 0,
    hitRate: (usage.hitTokens || 0) / rDenom,
  };
  // 单轮命中明细写入日志（logs/leizai.log，便于按轮复盘——"/stats"只给累计）
  try {
    console.log(`[回合 sid=${sid || '?'}] hit=${usage.hitTokens || 0} miss=${usage.missTokens || 0} out=${usage.outputTokens || 0} rate=${Math.round((usage.hitTokens || 0) / rDenom * 100)}% dur=${Math.round(dur / 1000)}s`);
  } catch { }
}

/** 把一次"后台 LLM 调用"（反思/上下文摘要/交接摘要/子智能体）的 usage 计入**发起会话**与**全局**，
 *  复用主回合同一计价口径（peak/off 分时段 + byModel 分桶）→ 成本总额 = 主回合 + 后台。
 *  额外在 stats/globalStats 记 `bg`（后台总额）与 `bgByKind`（按 kind 分类）供追溯（仅统计，不影响总额计算）。
 *  注意：不计入 calls/ttfb/duration/lastTurn（那些语义 = 主回合），只加 token。
 *  @param {object} s 发起会话（可为 null；为 null 时只计全局）
 *  @param {object} usage {hitTokens,missTokens,outputTokens,model}
 *  @param {string} kind 后台调用类型（reflect/summarize/handoff-seg/handoff-fill/subagent…）
 *  @param {number} [at] 调用时刻（判 peak/off），缺省 now
 *  @returns {boolean} 是否计入 */
function creditUsage(s, usage, kind, at) {
  try {
    if (!usage) return false;
    const hit = usage.hitTokens || 0, miss = usage.missTokens || 0, out = usage.outputTokens || 0;
    if (!hit && !miss && !out) return false;
    const t = at || Date.now();
    const group = isPeakHour(t) ? 'peak' : 'off';
    const model = _normModel(usage.model);
    const u = { hitTokens: hit, missTokens: miss, outputTokens: out, model };
    const k = String(kind || 'bg');
    // 会话侧：计入总额（peak/off + byModel）+ 后台追溯分桶
    if (s && s.stats) {
      const st = s.stats;
      _addBucket(st, u, group, model);
      if (!st.bg) st.bg = { calls: 0, hitTokens: 0, missTokens: 0, outputTokens: 0 };
      const bg = st.bg; bg.calls++; bg.hitTokens += hit; bg.missTokens += miss; bg.outputTokens += out;
      if (!st.bgByKind || typeof st.bgByKind !== 'object') st.bgByKind = {};
      const kb = st.bgByKind[k] || (st.bgByKind[k] = { calls: 0, hitTokens: 0, missTokens: 0, outputTokens: 0 });
      kb.calls++; kb.hitTokens += hit; kb.missTokens += miss; kb.outputTokens += out;
    }
    // 全局侧：同一口径 + 后台追溯
    const g = runtime.globalStats;
    _addBucket(g, u, group, model);
    if (!g.bg) g.bg = { calls: 0, hitTokens: 0, missTokens: 0, outputTokens: 0 };
    const gbg = g.bg; gbg.calls++; gbg.hitTokens += hit; gbg.missTokens += miss; gbg.outputTokens += out;
    if (!g.bgByKind || typeof g.bgByKind !== 'object') g.bgByKind = {};
    const gkb = g.bgByKind[k] || (g.bgByKind[k] = { calls: 0, hitTokens: 0, missTokens: 0, outputTokens: 0 });
    gkb.calls++; gkb.hitTokens += hit; gkb.missTokens += miss; gkb.outputTokens += out;
    return true;
  } catch { return false; }
}

/** 按会话 id 计入（供拿不到会话对象的调用方使用，如 subagent.js）。 */
function creditUsageById(sessionId, usage, kind, at) {
  let s = null;
  try { if (sessionId) s = getSession(sessionId); } catch { s = null; }
  return creditUsage(s, usage, kind, at);
}

// —— 自我模型反哺决策：把"相关自我认知"注入交接文档 / user 消息尾（只读 self-*，不进 system/工具前缀）——

/** 自我认知注入的标记（reflect 输入侧据此剔除，防"写自我→读自我"正反馈）。 */
const SELF_HINT_OPEN = '【相关自我认知】';
const SELF_HINT_CLOSE = '【/相关自我认知】';

/** 剔除文本中已注入的自我认知块（供 reflect 输入净化用）。 */
function stripSelfHint(text) {
  let t = String(text || '');
  const i = t.indexOf(SELF_HINT_OPEN);
  if (i < 0) return t;
  const j = t.indexOf(SELF_HINT_CLOSE, i + SELF_HINT_OPEN.length);
  return (t.slice(0, i) + (j >= 0 ? t.slice(j + SELF_HINT_CLOSE.length) : '')).trim();
}

// —— 领域分流提醒（V4·动态匹配版）：只在**命中相关领域**或**会诊信号**时注入，收敛噪声 ——
//  红线：只在 user 消息尾注入，绝不触碰 system / tools / prompts（不击穿前缀）；库不可用静默降级。
const DISPATCH_HINT_OPEN = '【领域分流】';
const DISPATCH_HINT_CLOSE = '【/领域分流】';
const CONSULT_HINT = '【会诊提示】涉及架构/方案/根因类 → 建议先组织背对背会诊，勿单方拍板。';
// 会诊信号词（L1 关键词兜底；高阶决策信号。裸词"设计/上线"易误报（设计稿/还没上线）→ 已移出，
//   改由 L0 结构信号的动作×对象复合模式覆盖）
const CONSULT_SIGNALS = ['架构', '方案', '重构', '根因', '改引擎', '多实例', '选型', '不可逆', '会诊', '定案', '取舍', '迁移', '宣传', '推广', '营销', '落地'];
// L0 结构信号（最高优先）：客观事实型高风险场景——角色生命周期 / 引擎源码 / 系统性；就近窗口 {0,8} 降误报
const L0_STRUCT_RES = [
  /(?:创建|新建|新增|删除|移除|注销|停用|启用|接入|退出|注册)[\s\S]{0,8}(?:雷影|角色|agent|实例|分身)/i,
  /(?:雷影|角色|agent|实例)[\s\S]{0,8}(?:创建|删除|注销|新增|移除)/i,
  /(?:改|修改|重构|实现|修复|新增|加)[\s\S]{0,8}(?:src|源码|引擎|代码|接口|机制|流程)/i,
  /(?:src|源码|引擎|代码|接口|机制|流程)[\s\S]{0,8}(?:改|修改|重构|实现|修复|优化|调整)/i,
  /多实例|不可逆|迁移|架构|机制/,
];
// —— 决策属性触发（方向无关）：决策词 且 对象词 且 影响面；轻量词不升级 ——
const DECISION_RE = /(要不要|该不该|是否要|是否该|哪个|哪种|怎么选|选哪|选什么|方向|策略|战略|定位|取舍|权衡|可行性|值不值)/;
const STRONG_DECISION_RE = /(方向|策略|战略|定位|取舍|权衡|可行性|值不值)/;   // 高阶决策：自身即含影响面
const OBJECT_RE = /(市场|宣传|视觉|风格|主题|方案|路线|产品|品牌|投放|定价|人群|渠道|文案|设计|页面|架构|机制|流程|规则|功能|模式|接口|标准|命名)/;
const REVERSIBLE_RE = /(改个|换个|微调|小改|试试|临时|随便|加个|删个)/;   // 双向门/轻量 → 不升级
const IMPACT_RE = /(上线|发布|对外|公开|客户|用户可见|不可逆|永久|删除|删掉|删了|移除|下线|停用|注销|废弃|清空|重置|撤回|撤下)/;
const IMPACT_COST_RE = /(成本|预算|投入|长期|重构|迁移|人力|工期|资源)/;
const HIGH_IMPACT_OBJECT_RE = /(市场|品牌|战略|定位|定价|投放|渠道|人群|产品|路线|商业模式)/;   // 对象本身即高影响面
/** 是否应触发会诊（建议，非硬拦截）：L0 结构信号 OR (决策×对象×影响面) OR L1 关键词。纯函数（可测）。
 *  @param {string} taskText 请求文本
 *  @param {{matchedCount?:number}} [ctx] 领域命中数（供影响面判据用） */
function isConsultIntent(taskText, ctx = {}) {
  const t = String(taskText || '');
  try { if (L0_STRUCT_RES.some((re) => re.test(t))) return true; } catch { }
  // 可逆性闸（Bezos 双向门）：轻量/试错词 → 不升级为会诊
  let reversible = false;
  try { reversible = REVERSIBLE_RE.test(t); } catch { }
  if (!reversible) {
    try {
      const decision = DECISION_RE.test(t);
      const object = OBJECT_RE.test(t);
      let impact = false;
      try {
        impact = IMPACT_RE.test(t) || IMPACT_COST_RE.test(t) || STRONG_DECISION_RE.test(t) || HIGH_IMPACT_OBJECT_RE.test(t) || (Number(ctx.matchedCount) >= 1);
      } catch { impact = false; }
      if (decision && object && impact) return true;
    } catch { }
  }
  try { return CONSULT_SIGNALS.some((w) => t.includes(w)); } catch { return false; }
}
// 各 role 的匹配补充词（domain 字面之外的近义/常用表达，单一来源）。
// 注：未登记 role（含自定义/未来新增）走 r.name/r.domain 派生兜底（matchRoleDispatch 已用二者切词+bigram），无需逐个登记。
const ROLE_MATCH_EXTRA = {
  programmer: ['代码', '程序', 'bug', '修复', '重构', '模块', '架构', '引擎', '接口', '函数', '脚本', '编译', '源码', '报错', '调试', '开发', '实现'],
  designer: ['界面', '按钮', '颜色', '样式', '布局', '图标', '视觉', '前端', '美化', '动画', '字体', '弹窗设计', 'ui弹窗', '截图', 'ui', '配色', '渲染', '页面'],
  writer: ['文案', '撰写', '标题', '措辞', '稿', '内容创作', '润色', '宣传', '推广', '营销', '软文', '标语', '介绍', '海报文案'],
  tester: ['测试', '验收', '复验', '校验', '验证', '用例', '回归', '质量'],
  researcher: ['研究', '调研', '情报', '选型', '开源', '对比', '论文', '技术方案', '可行性', '竞品', '市场', '资料'],
  editor: ['剪辑', '视频', '后期', '字幕', '配音', '成片', '素材', '转场', '音轨', '抽帧'],
};
// 跨域多义词（一词多义，易误报）：命中词含下述词根时视为"词歧义"灰区信号（须配合其它信号才判灰，防误）
const CROSS_DOMAIN_WORDS = ['弹窗', '设计', '方案', '实现', '文案', '页面', '内容', '介绍', '样式', '模型', '素材', '资料'];
// 独立方域语义（防同源自证；按 domain/name 语义判定，零硬编码 role 名）
//  验证类（可充当"独立复验"）：测试/验证/复验/验收/质量/独立/审计/复核
//  广义独立域（候选兜底）：上述 ∪ 调研/研究/情报/评估/评审
//  **产出语义**（开发/实现/创作/设计/渲染…）不得判为独立方——避免"代码开发/调试验证"被误判
const VERIFY_DOMAIN_RE = /(测试|验证|复验|验收|质量|独立|审计|复核)/;
const INDEP_DOMAIN_RE = /(测试|验证|复验|验收|质量|独立|审计|复核|调研|研究|情报|评估|评审)/;
const PRODUCE_DOMAIN_RE = /(开发|实现|编码|编写|创作|设计|渲染|制作|搭建|视觉)/;
let _roleRowsCache = { at: 0, rows: null };   // 60s 内存缓存（避免每轮开库）

/** 读 agents_shared.db 的 agents 表（enabled=1 且 is_main=0）→ rows；库不可用/无行 → []。 */
function _loadRoleRows() {
  try {
    if (_roleRowsCache.rows && Date.now() - _roleRowsCache.at < 60000) return _roleRowsCache.rows;
    let rows = [];
    try {
      const cfg = loadConfig() || {};
      const p = cfg.agentSharedDb || process.env.LEIZAI_AGENT_SHARED_DB;
      if (p && fs.existsSync(p)) {
        const { DatabaseSync } = require('node:sqlite');
        const d = new DatabaseSync(p, { readOnly: true });
        rows = (d.prepare('SELECT role, name, domain FROM agents WHERE enabled=1 AND is_main=0 AND retired_at IS NULL').all() || []).filter((r) => r && r.role);
        d.close();
      }
    } catch { rows = []; }
    _roleRowsCache = { at: Date.now(), rows };
    return rows;
  } catch { return []; }
}

/** 请求文本 → 命中的雷影领域（top≤topN，阈值以下不列）。纯函数（可测）。 */
function matchRoleDispatch(taskText, rows, topN = 2) {
  const task = String(taskText || '').toLowerCase();
  if (!task.trim()) return [];
  let taskG = new Set();
  try { taskG = new Set(memory.gramsOf(task)); } catch { }
  const out = [];
  for (const r of (rows || [])) {
    const terms = String(r.domain || '').split(/[\/、，,;；\s]+/).filter(Boolean);
    const extra = ROLE_MATCH_EXTRA[r.role] || [];
    let score = 0, domainHit = false;
    const extraHits = [];
    for (const t of terms) if (t && task.includes(t.toLowerCase())) { score += 2; domainHit = true; }   // domain 字面命中权高
    for (const t of extra) if (task.includes(t.toLowerCase())) { score += 1; extraHits.push(t); }        // 近义词命中权低
    let hit = 0;
    try { const rg = new Set(memory.gramsOf(`${r.name || ''} ${r.domain || ''}`)); for (const g of taskG) if (rg.has(g)) hit++; } catch { }
    if (hit >= 2) score += 1;   // bigram 重合补充分
    if (score > 0) out.push({ role: r.role, name: r.name, domain: r.domain, score, domainHit, extraHits });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(1, topN));
}

/** 灰区置信度纯函数：matchRoleDispatch 输出 → {conf, grey, signals}。
 *  信号：weak=绝对弱(s1≤1且无domain字面) / close=相对近(s2>0且s1-s2≤1) / ambiguous=首命中含跨域多义词。
 *  判据：signals.length≥2 → grey（单信号不判灰，防误）；conf=s1/(s1+s2)。纯函数（可测）。 */
function confidence(matched) {
  const m = (matched || []).filter((x) => x && Number(x.score) > 0);
  if (!m.length) return { conf: 1, grey: false, signals: [] };
  const s1 = Number(m[0].score) || 0;
  const s2 = m.length > 1 ? (Number(m[1].score) || 0) : 0;
  const signals = [];
  if (s1 <= 1 && !m[0].domainHit) signals.push('weak');
  if (s2 > 0 && (s1 - s2) <= 1) signals.push('close');
  const words = m[0].extraHits || [];
  if (words.some((w) => CROSS_DOMAIN_WORDS.some((cw) => w === cw || String(w).includes(cw)))) signals.push('ambiguous');
  const conf = (s1 + s2) > 0 ? Math.round((s1 / (s1 + s2)) * 100) / 100 : 1;
  return { conf, grey: signals.length >= 2, signals };
}

/** 会诊参会方：命中域专家（top≤4）+ 若缺独立方则补 1 个（防自证）。全部来自 agents 表。 */
function buildConsultPanel(task, rows, matched) {
  const panel = [];
  const seen = new Set();
  const add = (r) => { if (r && r.role && !seen.has(r.role)) { seen.add(r.role); panel.push({ role: r.role, name: r.name || r.role, domain: r.domain || '', kind: 'expert' }); } };
  for (const m of (matched || []).slice(0, 4)) add(m);
  const isIndep = (r) => { const d = `${r.domain || ''} ${r.name || ''}`; return INDEP_DOMAIN_RE.test(d) && !PRODUCE_DOMAIN_RE.test(String(r.domain || '')); };
  const isVerify = (r) => { const d = `${r.domain || ''} ${r.name || ''}`; return VERIFY_DOMAIN_RE.test(d) && !PRODUCE_DOMAIN_RE.test(String(r.domain || '')); };
  // 命中里是否已有"独立复验类"（严格验证域；研究类不等同于独立复验）
  const hasIndep = panel.some((p) => isVerify(p));
  if (!hasIndep) {
    // 独立方须与命中域不重叠 → 只从未命中 role 中取；优先严格验证类，其次广义独立域
    const cands = (rows || []).filter((r) => r && r.role && !seen.has(r.role) && isIndep(r));
    cands.sort((a, b) => (isVerify(b) ? 1 : 0) - (isVerify(a) ? 1 : 0));
    if (cands.length) add(Object.assign({}, cands[0], { kind: 'indep' }));
  }
  return panel.slice(0, 4);
}

/** 渲染参会方一行：`雷影·A（相关领域）、雷影·B（相关领域）＋ 雷影·测试（独立复验，防自证）` */
function renderConsultPanel(panel) {
  if (!panel || !panel.length) return '';
  const exps = panel.filter((p) => p.kind === 'expert').map((p) => `${p.name}（${p.domain || '相关领域'}）`);
  const inds = panel.filter((p) => p.kind === 'indep').map((p) => `${p.name}（独立复验，防自证）`);
  const parts = [];
  if (exps.length) parts.push(exps.join('、'));
  if (inds.length) parts.push(inds.join('、'));
  return `建议参会：${parts.join(' ＋ ')}`;
}

// 协作链信号：命中产出域且任务含"验证/交付/…"等 → pipeline（实现方 → 独立复验）
const PIPELINE_SIGNALS = ['验证', '复验', '验收', '测试', '完成', '交付', '上线', '实现', '发布', '并', '同时', '然后', '之后'];

/** 严格验证域（可充独立复验），排除产出语义域。 */
function _isVerifyRole(p) { const d = `${p.domain || ''} ${p.name || ''}`; return VERIFY_DOMAIN_RE.test(d) && !PRODUCE_DOMAIN_RE.test(String(p.domain || '')); }

/** 统一领域路由内核（薄抽象）：请求文本 × 角色注册表 → 参与者 + 意图/拓扑/汇总。
 *  - intent: 'execute'|'consult'|'none'；topology: 'single'|'fanout'|'pipeline'|'debate'；aggregate: 'none'|'merge'|'verdict'
 *  - participants：execute=全量有序命中；consult=命中专家(≤4)+≥1独立方（沿用 buildConsultPanel）。
 *  - matched：全量有序命中（供上层取 top≤2 派单清单）。纯函数（可测）。 */
function routeTask(text, rows) {
  const task = String(text || '');
  const all = matchRoleDispatch(task, rows, Math.max(1, (rows || []).length || 1));
  let consult = false;
  try { consult = isConsultIntent(task, { matchedCount: all.length }); } catch { consult = false; }
  if (consult) {
    const panel = all.length ? buildConsultPanel(task, rows, all) : [];   // 方向无命中 → 无参会专家（上层给"建议创建"）
    return { participants: panel, matched: all, intent: 'consult', topology: 'debate', aggregate: 'verdict' };
  }
  if (!all.length) return { participants: [], matched: [], intent: 'none', topology: 'single', aggregate: 'none' };
  const producers = all.filter((p) => !_isVerifyRole(p));
  let hasSignal = false;
  try { hasSignal = PIPELINE_SIGNALS.some((w) => task.includes(w)); } catch { hasSignal = false; }
  if (producers.length && hasSignal) return { participants: all, matched: all, intent: 'execute', topology: 'pipeline', aggregate: 'merge' };
  if (all.length > 1) return { participants: all, matched: all, intent: 'execute', topology: 'fanout', aggregate: 'merge' };
  return { participants: all, matched: all, intent: 'execute', topology: 'single', aggregate: 'none' };
}

/** pipeline 协作链行：`协作链：雷影·X（实现）→ 雷影·测试（独立复验）`；无复验角色 → ''。 */
function renderPipelineChain(producers, rows) {
  const verifier = (rows || []).find((r) => r && r.role && _isVerifyRole(r));
  if (!verifier || !producers || !producers.length) return '';
  const names = producers.map((p) => p.name || p.role).join('、');
  return `协作链：${names}（实现）→ ${verifier.name || verifier.role}（独立复验）`;
}

/** 生成「领域分流」块：命中领域 top≤2（execute）/ 会诊提示 + 建议参会（consult）；两者皆无 → ''（handoverFirst 给兜底行）。
 *  @param {string} taskText 请求文本
 *  @param {{handoverFirst?:boolean, consultGate?:{key:string,store:object}}} [opts]
 *    handoverFirst：交接首轮，无命中时给一行兜底；
 *    consultGate：频控——同 key 已提示过则本次不再出会诊段（`store.key` 由本函数写入） */
function buildRoleDispatchHint(taskText, opts = {}) {
  try {
    const cfg = loadConfig() || {};
    // 守卫：本机制只应**主实例**注入（雷影不向下派；防同步到雷影后误派/空转）
    if (!(cfg.agent && cfg.agent.isMain)) return '';
    // 「雷影协同」总开关：关则整链不注入（分流/会诊/灰区），且早于读 agents 表（省开销）。缺失视为开启。
    if (cfg.roleDispatchEnabled === false) return '';
    const task = String(taskText || '');
    const rows = _loadRoleRows();
    const r = routeTask(task, rows);
    let consult = r.intent === 'consult';
    // 频控：同一任务已提示过会诊 → 本次抑制会诊段（防提示疲劳）
    if (consult && opts.consultGate) {
      try { if (opts.consultGate.store && opts.consultGate.store.key === opts.consultGate.key) consult = false; } catch { }
    }
    const experts = (r.matched || []).filter((p) => p.kind !== 'indep');
    const matched = (consult ? experts : (r.matched || [])).slice(0, 2);
    if (!matched.length && !consult && !opts.handoverFirst) return '';
    const lines = [];
    if (matched.length) {
      lines.push('真实执行/产出类请求若落在下列雷影领域 → 必须派该雷影（不得自己动手）：');
      for (const m of matched) lines.push(`- ${m.name || m.role}（${m.role}）：${m.domain || '（未标注领域）'}`);
    } else if (opts.handoverFirst) {
      lines.push('（本请求未匹配到具体雷影领域）若属执行/产出类且无对应雷影 → 可暂代，但应提示创建（经主人确认）。');
    }
    if (consult) {
      lines.push(CONSULT_HINT);
      if (experts.length) {
        const line = renderConsultPanel(r.participants);
        if (line) lines.push(line);
      } else {
        lines.push('该方向暂无对应雷影 → 建议创建（经主人确认）。');
      }
      try { if (opts.consultGate && opts.consultGate.store) opts.consultGate.store.key = opts.consultGate.key; } catch { }
    } else if (r.intent === 'execute' && r.topology === 'pipeline') {
      const chain = renderPipelineChain((r.participants || []).filter((p) => !_isVerifyRole(p)), rows);
      if (chain) lines.push(chain);
    }
    if (!lines.length) return '';
    // ②（2026-10-05）固定行：雷影自身类动作（新建/改/重启/停）由主我独占——该块生成时必含此提醒。
    lines.push('雷影自身（含 新建/改/重启/停）→ 主我独占，禁派任何雷影。');
    // 判定灰区 → 分级处理（按"操作客观属性"：可逆=轻提示不弹；不可逆=建议 ask_user）。intent=none 绝不追加。
    if (!consult && r.intent === 'execute' && matched.length) {
      const gate = opts.greyGate;
      const cooled = !!(gate && gate.store && gate.store.key === gate.key);   // 同任务已提示过 → 冷却抑制
      if (!cooled) {
        const cf = confidence(r.matched || []);
        if (cf.grey) {
          const top = matched[0];
          const t2 = (r.matched || [])[1];
          const t = String(taskText || '');
          let irreversible = false;
          try { irreversible = IMPACT_RE.test(t) || IMPACT_COST_RE.test(t) || HIGH_IMPACT_OBJECT_RE.test(t); } catch { }
          try { if (REVERSIBLE_RE.test(t)) irreversible = false; } catch { }
          if (!irreversible) {
            lines.push(`⚠️（拿不准，已按 ${top.name || top.role} 走；可改）`);
          } else {
            const optsList = [`派${top.name || top.role}`];
            if (t2) optsList.push(`派${t2.name || t2.role}`);
            optsList.push('我自己做', '跳过=保持现状');
            lines.push(`⚠️ 拿不准且不可逆 → 请用 ask_user 让主人定夺（选项：${optsList.join('／')}）`);
          }
          try { if (gate && gate.store) gate.store.key = gate.key; } catch { }
        }
      }
    }
    return `${DISPATCH_HINT_OPEN}\n${lines.join('\n')}\n${DISPATCH_HINT_CLOSE}`;
  } catch { return ''; }
}

/** 剔除文本中已注入的领域分流块（供 reflect 输入净化用）。 */
function stripDispatchHint(text) {
  let t = String(text || '');
  const i = t.indexOf(DISPATCH_HINT_OPEN);
  if (i < 0) return t;
  const j = t.indexOf(DISPATCH_HINT_CLOSE, i + DISPATCH_HINT_OPEN.length);
  return (t.slice(0, i) + (j >= 0 ? t.slice(j + DISPATCH_HINT_CLOSE.length) : '')).trim();
}

/** 元认知/自我指涉类噪声（只留可执行动作型认知）：名或正文命中即排除。 */
function _isMetaSelf(name, body) {
  return /(自我认知|元认知|自指|自我指涉|超限|重复膨胀|条目数|条目上限|合并主题|正反馈|记忆膨胀)/.test(String(name || '') + ' ' + String(body || ''));
}

// V3：自我认知检索已下沉为 memory.js 的段级倒排索引（searchSelfSections）；
// 原三函数 _hintGrams / _overlapScore / _selfSections（两段式线性打分）已删除。

/** 生成"相关自我认知"提示文本（≤k 段、每段 1 句 ≤60 字、总计 ≤200 字）；无命中返回 ''。
 *  纯只读（不写 self、不触碰 system/工具前缀）。
 *  @param {string} task 任务/目标文本
 *  @param {number} [k=3] 最多条数 */
function buildSelfHint(task, k = 3) {
  try {
    const K = Math.max(1, Math.min(5, Number(k) || 3));
    let secs = [];
    try { secs = memory.searchSelfSections(task, { limit: Math.max(K * 3, 6) }) || []; } catch { secs = []; }
    if (!secs.length) return '';
    const lines = [];
    const seen = new Set();
    let total = 0;
    for (const s of secs) {
      const body = String(s.snippet || '').trim();
      if (!body) continue;
      if (_isMetaSelf(String(s.section || ''), body)) continue;   // 保留元认知噪声过滤
      const key = body.slice(0, 20);
      if (seen.has(key)) continue;                                // 去重
      seen.add(key);
      const first = (body.split(/[。；;!！?？\n]/)[0] || body).replace(/^[。；;、\s]+/, '').trim();
      const t = first.slice(0, 60);
      if (t.length < 6) continue;                       // 过短视为噪声
      const line = `- ${t}`;
      if (total + line.length + 1 > 200) break;
      lines.push(line); total += line.length + 1;
      if (lines.length >= K) break;
    }
    return lines.length ? lines.join('\n') : '';
  } catch { return ''; }
}

/** 节流判定 + 生成注入块（带标记）。交接后首轮必注入；否则每 cfg.selfInjectEvery 轮一次（默认 5，0=关）。
 *  @returns {string} '' 或 `\n\n【相关自我认知】\n…\n【/相关自我认知】` */
function maybeSelfHint(s, cfg, taskTxt, forceHandoffTurn) {
  try {
    const n = Number(cfg.selfInjectEvery);
    const every = Number.isFinite(n) ? n : 5;
    if (!(every > 0)) return '';
    s._selfTick = (Number(s._selfTick) || 0) + 1;
    if (!forceHandoffTurn && (s._selfTick % every !== 0)) return '';
    const hint = buildSelfHint(taskTxt, 3);
    return hint ? `\n\n${SELF_HINT_OPEN}\n${hint}\n${SELF_HINT_CLOSE}` : '';
  } catch { return ''; }
}

// —— 反思 + 进化（Prime Agent RLM 循环的本地版）——

// ==================== 反思写入攒批化（reflectStaging，2026-09-27） ====================
// 背景：reflect() 自动写 skills/skillUpdates/evolution 会改动"稳定前缀"（技能目录/规则基因），
//   在大窗口会随机击穿前缀缓存（实测某轮命中率仅 52%）。改为入队 `reflect-pending`（支干暂存），
//   攒到"安全小窗"（交接/重启后首回合，hist < 拦截线）一次性 drain 落地。
// 边界：仅 stage skills/skillUpdates/evolution；memories/self 不进前缀，保持即时写。
// 开关：config.reflectStaging（默认 true）；false → reflect() 走原"立即写"路径（可回滚）。
// A（2026-10-02）：废弃 _drainDue / _reflectDrainFlagPath / markReflectDrainDue —— "置脏标记"职责已由 pfxqueue.markPfxDue 取代
//   （reflect 写入直接入队 pfx_op，不再需要实例级 reflect-drain 脏标记）。存量迁移见 migrateReflectPending()。

// [deprecated 兼容·2026-10-02 A] reflectStaging 保留作回滚：true=经 _stageReflect 直接入队；false=走原直写分支——
//   二者**均已统一经 pfx_op 队列**（memory.save/improveSkill/pfxWrite），不击穿前缀，故当前无行为差异。
function reflectStagingOn() { try { return loadConfig().reflectStaging !== false; } catch { return true; } }
function _sha1(s) { try { return require('node:crypto').createHash('sha1').update(String(s), 'utf8').digest('hex'); } catch { return ''; } }
/** 幂等键：type + name + sha1(content)。 */
function reflectPendingKey(o) {
  const t = String((o && o.type) || '');
  const n = String((o && (o.name || o.title)) || '');
  const c = String((o && (o.content != null ? o.content : (o.note != null ? o.note : ''))) || '');
  return `${t}|${n}|${_sha1(c)}`;
}
/** 读 branch.db 中本会话的 reflect-pending / reflect-flushed 事件（库不可用 → 空）。 */
function _readReflectEvents(sessionId) {
  const out = { pending: [], flushed: new Set() };
  try {
    const p = branch.dbFile && branch.dbFile();
    if (!p || !fs.existsSync(p)) return out;
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(p, { readOnly: true });
    const rows = d.prepare("SELECT id, kind, payload FROM branch_event WHERE session_id=? AND kind IN ('reflect-pending','reflect-flushed') ORDER BY id ASC").all(String(sessionId));
    d.close();
    for (const r of (rows || [])) {
      if (r.kind === 'reflect-pending') out.pending.push({ id: Number(r.id) || 0, payload: String(r.payload || '') });
      else out.flushed.add(String(r.payload || ''));
    }
  } catch { }
  return out;
}
/** 入队一条暂存的反思写入（branch 不可用 → false，调用方回退为立即写）。 */
function _stageReflect(obj, s, gen, turnId) {
  // A（2026-10-02）：记录层合一——reflect 产出**直接入队 pfx_op**（不再写 reflect-pending）。
  //   skill→memory.save（已下沉入队）/skillUpdate→memory.improveSkill（已入队）/evolution→pfxqueue.pfxWrite。
  //   审计字段（session/turn）随 opts 透传进队列（src_session/src_turn 列）。
  try {
    const _src = String((s && s.id) || '');
    const _meta = { srcSession: _src, srcTurn: turnId };
    if (obj && obj.type === 'skill' && obj.name && obj.content) { memory.save('skill', String(obj.name), `> ${obj.description || ''}\n\n${obj.content}`, _meta); return true; }
    if (obj && obj.type === 'skillUpdate' && obj.name && obj.note) { memory.improveSkill(String(obj.name), String(obj.note), _meta); return true; }
    if (obj && obj.type === 'evolution' && obj.title && ((obj.patch && obj.patch.old) || obj.content)) {
      const q = require('./pfxqueue');
      if (q.enabled()) { const r = q.pfxWrite('evolution', obj.content, { op: 'evolution', name: obj.title, evoTarget: obj.target, title: obj.title, rationale: obj.rationale, patch: obj.patch, srcSession: _src, srcTurn: turnId }); return !!(r && r.queued); }
      return false;
    }
    return false;
  } catch { return false; }
}
/** 批量落地暂存的反思写入：reflect-pending → 执行 → reflect-flushed 标记。幂等、可重入、失败不标记留待重试。 */
async function drainReflectPending(s, opts = {}) {
  const stat = { done: 0, skipped: 0, failed: 0 };
  try {
    const sid = s && s.id; if (!sid) return stat;
    const { pending, flushed } = _readReflectEvents(sid);
    if (!pending.length) return stat;
    const gen = resolveBranchTurnGen(sid);
    const turnId = (opts && opts.branchTurnId) || `${sid}:reflect-drain`;
    // 合并（v6.x 2026-10-02）：同会话内**同名同类**的 skill/skillUpdate 合并为一次写（减少前缀重建次数）；
    //   evolution 保持逐条（保 patch 链顺序）；未知类型原样逐条。
    const _ops = [];
    const _skillIdx = new Map();
    const _updIdx = new Map();
    for (const ev of pending) {
      let o; try { o = JSON.parse(ev.payload); } catch { continue; }
      if (!o || !o.type) continue;
      const key = reflectPendingKey(o);
      if (o.type === 'skill' && o.name && o.content) {
        if (_skillIdx.has(o.name)) { const op = _ops[_skillIdx.get(o.name)]; op.o = o; op.keys.push(key); }
        else { _skillIdx.set(o.name, _ops.length); _ops.push({ type: 'skill', o, keys: [key] }); }
      } else if (o.type === 'skillUpdate' && o.name && o.note) {
        if (_updIdx.has(o.name)) { const op = _ops[_updIdx.get(o.name)]; op.notes.push(String(o.note)); op.keys.push(key); }
        else { _updIdx.set(o.name, _ops.length); _ops.push({ type: 'skillUpdate', o, notes: [String(o.note)], keys: [key] }); }
      } else {
        _ops.push({ type: o.type, o, keys: [key] });
      }
    }
    for (const op of _ops) {
      if (op.keys.every((k) => flushed.has(k))) { stat.skipped++; continue; }
      let ok = false;
      try {
        if (op.type === 'skill') {
          memory.save('skill', String(op.o.name), `> ${op.o.description || ''}\n\n${op.o.content}`); ok = true;
        } else if (op.type === 'skillUpdate') {
          memory.improveSkill(String(op.o.name), op.notes.join('\n')); ok = true;
        } else if (op.type === 'evolution') {
          const o = op.o;
          if (o.title && ((o.patch && o.patch.old) || o.content)) {
            const evoTarget = o.target || (loadConfig().immutableGenome ? 'harness' : 'system.md');
            // P1（2026-10-02）：进化写入统一入队（由本函数末尾一次性落盘）。
            const _q = require('./pfxqueue');
            const _r = _q.enabled() ? _q.pfxWrite('evolution', o.content, { op: 'evolution', name: o.title, evoTarget, title: o.title, rationale: o.rationale, patch: o.patch }) : { queued: false };
            if (_r && _r.queued) { ok = true; }
            else {
              const p = evolution.propose({ target: evoTarget, title: o.title, rationale: o.rationale, patch: o.patch, content: o.content });
              if (loadConfig().evolutionAutoApply) await evolution.approve(p.id, { auto: true });
              ok = true;
            }
          }
        }
      } catch { ok = false; }
      if (ok) {
        // 幂等去重按「单条 key」记账（flushed 集以 payload 精确匹配）→ 合并落地后仍逐 key 打 reflect-flushed，防重复写。
        for (const _k of op.keys) { try { branch.append({ sessionId: sid, gen, turnId, kind: 'reflect-flushed', payload: _k }); } catch { } }
        stat.done++;
      }
      else { stat.failed++; }
    }

  } catch { }
  // B（2026-10-02）：drain 只负责"转队列"（skill/skillUpdate/evolution 已入 pfx_op）；落地交唯一决策点(P2 maybeFlush，同回合紧跟其后)。
  return stat;
}

/** 实例级兜底 drain：扫描 branch.db 中所有含 reflect-pending 的会话，各尝试 drain 一次。
 *  用途：治"休眠会话"的搁浅反思（这些会话永不再进小窗 → 反思永不落地）。
 *  只读**本实例**库（branch.dbFile()）；全 try 包裹、单会话失败不阻塞其余；幂等（reflect-flushed）。
 *  @returns {Promise<{sessions:number, done:number, failed:number, skipped:number}>} */
async function drainReflectPendingAll(opts = {}) {
  const stat = { sessions: 0, done: 0, failed: 0, skipped: 0 };
  try {
    if (!(opts && opts.force) && !reflectStagingOn()) return stat;
    const p = (branch && branch.dbFile) ? branch.dbFile() : '';
    if (!p || !fs.existsSync(p)) return stat;
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(p, { readOnly: true });
    let rows = [];
    try { rows = d.prepare("SELECT DISTINCT session_id FROM branch_event WHERE kind='reflect-pending'").all(); } catch { }
    d.close();
    const seen = new Set();
    for (const r of (rows || [])) {
      const sid = String((r && r.session_id) || '').trim();
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      try {
        const st = await drainReflectPending({ id: sid });
        if (st) { stat.sessions++; stat.done += st.done || 0; stat.failed += st.failed || 0; stat.skipped += st.skipped || 0; }
      } catch { /* 单会话失败不阻塞其余 */ }
    }
  } catch { }
  // B（2026-10-02）：dormant 兜底——置脏标记（非 flush），任一后续小窗请求必落地。
  try { require('./pfxqueue').markPfxDue(); } catch { }
  return stat;
}
/** A（2026-10-02）一次性迁移器：把**存量** reflect-pending 逐条转入 pfx_op（标 reflect-flushed）。
 *  开关 reflectPendingMigrate（默认跑一次；false=停用）；幂等（flag reflect-pending-migrated.flag；仅成功落 flag）。
 *  reflect 写入现已直接入队，本迁移器只为历史存量兜底。 */
async function migrateReflectPending(opts = {}) {
  const stat = { migrated: false, already: false, done: 0, failed: 0, skipped: 0, sessions: 0 };
  try {
    const c = loadConfig();
    if (c && c.reflectPendingMigrate === false) { stat.disabled = true; return stat; }
    const flag = path.join(DATA_DIR, 'reflect-pending-migrated.flag');
    if (fs.existsSync(flag)) { stat.already = true; return stat; }
    const r = await drainReflectPendingAll({ force: true });
    if (r) { stat.done = r.done || 0; stat.failed = r.failed || 0; stat.skipped = r.skipped || 0; stat.sessions = r.sessions || 0; }
    stat.migrated = true;
    try { fs.writeFileSync(flag, String(Date.now()), 'utf8'); } catch { }
  } catch (e) { stat.error = String(e && e.message || e); }
  return stat;
}

// —— 反思：回顾本回合工作，沉淀记忆/技能/进化（异步、不阻塞回复）——
async function reflect(s, opts = {}) {
  try {
    const sys = systemPrompt().full;
    // 只取本回合最近上下文与最近工具痕迹做反思（用小调用，控制成本）
    const recent = s.messages.slice(-24).filter((m) => m.role === 'user' || m.role === 'tool');
    const gloss = recent.map((m) =>
      m.role === 'user' ? `用户: ${stripDispatchHint(stripSelfHint(String(m.content))).slice(0, 400)}`   // 剔除已注入的自我认知/领域分流块（防回灌正反馈）
        : `工具结果(${String(m.content).split('\n')[0].slice(0, 120)})`
    ).join('\n');
    // 注入当前自我摘要作为反思的自我参照（让反思"带着我是谁的认知"沉淀新的自我认知，形成自我强化的循环）
    let selfRef = '';
    try { selfRef = selfmodel.summarizeSelf(); } catch { selfRef = ''; }
    const prompt = `【反思要求】请回顾上面的工作，按以下 JSON 输出（不要输出别的）：
{
  "memories": [{ "name": "短名", "content": "一句话事实/经验" }],
  "self": [{ "name": "自我认知短名", "content": "关于雷仔自己的一条有据事实：能力边界/偏好/行为模式/对自身局限的发现。必须有据可查，宁缺毋滥" }],
  "skills": [{ "name": "技能名", "description": "一句话说明", "content": "步骤/方法正文（>4行）" }],
  "skillUpdates": [{ "name": "已存在技能名", "note": "本次使用后可写回该技能的一段改进补充" }],
  "evolution": { "title": "对系统规则的改进", "rationale": "为什么", "patch": { "old": "原文中的一小段", "new": "修改后的这段" } } | null
}
只能提议当真实的改进存在；没有就输出 {"memories":[],"self":[],"skills":[],"skillUpdates":[],"evolution":null}。\n\n${selfRef ? `【我目前的自我认知】\n${selfRef}\n\n` : ''}【本次工作记录】\n${gloss.slice(0, 6000)}`;
    const _rt0 = Date.now();
    const r = await chatOnce([{ role: 'system', content: sys }, { role: 'user', content: prompt }],
      { maxTokens: 1600, temperature: 0.2, kind: 'reflect' });
    try { creditUsage(s, r.usage, 'reflect', _rt0); } catch { }   // 后台反思计入发起会话/全局（第5项）
    const json = extractJson(r.text);
    const result = { memories: [], self: [], skills: [], evolution: null, note: r.usage ? { hit: r.usage.hitTokens, miss: r.usage.missTokens } : null };
    if (!json) { result.note = { parseError: r.text.slice(0, 200) }; runtime.emit('reflect', { sessionId: s.id, result }); return result; }
    for (const m of (json.memories || []).slice(0, 3)) {
      if (m.name && m.content) { memory.save('memory', String(m.name), String(m.content)); result.memories.push(m.name); }
    }
    // 自我认知沉淀：写入记忆库（名称统一 self: 前缀），作为"有据自我模型"的自传层原料，供 self-portrait 技能读取
    // 护栏（2026-09-14 防膨胀，改主引擎 runtime.js reflect）：①去重：同名/高相似主题的 self 记忆已存在则跳过；②上限：self 记忆总数 ≤ SELF_MEM_LIMIT，超限只跳过新增、绝不删旧。护栏失败回退为直接写入，不影响反思主流程。
    try {
      const SELF_MEM_LIMIT = 1200;   // 段级上限（合并后段数≈614，原 200=文件级口径已不适用；仅防无界增长）
      const selfKey = (x) => String(x || '').replace(/^self:?/, '').trim().toLowerCase().replace(/[\s:：\-—_·,，.。()（）\[\]【】/\\]+/g, '');
      const existingSelf = new Set();
      let selfCount = 0;
      // 段级判重（2026-09-23 修：合并为 21 主题文件后，按"文件名"判重已失效 → 改按**段名**清点）
      try {
        for (const [, e] of (memory.getSelfSectionData('self') || new Map())) {
          selfCount++;
          const k = selfKey(e && e.section);
          if (k) existingSelf.add(k);
        }
      } catch { /* 段表不可用则退化为不判重，appendSelfSection 仍幂等兜底 */ }
      const isSelfDup = (k) => {
        if (!k) return true;
        if (existingSelf.has(k)) return true;
        for (const e of existingSelf) {
          if (e && (e.includes(k) || k.includes(e)) && Math.min(e.length, k.length) >= 3) return true;
        }
        return false;
      };
      for (const sm of (json.self || []).slice(0, 3)) {
        if (!(sm.name && sm.content)) continue;
        const nm = String(sm.name);
        const k = selfKey(nm);
        if (selfCount >= SELF_MEM_LIMIT || isSelfDup(k)) continue;
        memory.appendSelfSection(nm, String(sm.content));
        existingSelf.add(k); selfCount++;
        result.self.push(nm);
      }
    } catch {
      for (const sm of (json.self || []).slice(0, 3)) {
        try { if (sm.name && sm.content) { memory.appendSelfSection(String(sm.name), String(sm.content)); result.self.push(sm.name); } } catch { /* 忽略单条失败 */ }
      }
    }
    // —— 反思写入攒批化：skills/skillUpdates/evolution 入队 reflect-pending（攒到安全小窗 drain）；
    //    reflectStaging=false 或 branch 不可用 → 回退原"立即写"路径。memories/self 已即时写（不进前缀）。
    const _staging = reflectStagingOn();
    // C（2026-10-02）：删除"staging=false 大窗退化为入队 reflect-pending"分支——已冗余。
    //   staging=false 的直写路径（memory.save('skill')/improveSkill/pfxWrite('evolution')）现均经统一队列 pfx_op，不会击穿前缀。
    const _shouldStage = (obj) => {
      if (_staging) return _stageReflect(obj, s, _refGen, _refTurn);
      return false;   // staging=false → 直写（内容由 memory.save/pfxWrite 入队，落地由 P2 择时）
    };
    const _refGen = (opts && opts.branchGen != null) ? opts.branchGen : resolveBranchTurnGen(s.id);
    const _refTurn = (opts && opts.branchTurnId) || `${s.id}:reflect:${s.lastReflectAt || Date.now()}`;
    for (const k of (json.skills || []).slice(0, 1)) {
      if (k.name && k.content) {
        const obj = { type: 'skill', name: String(k.name), description: k.description, content: String(k.content) };
        if (_shouldStage(obj)) { result.skills.push(`[staged]${k.name}`); }
        else { memory.save('skill', String(k.name), `> ${k.description || ''}\n\n${k.content}`); result.skills.push(k.name); }
      }
    }
    // 技能"在使用中自我改进"：若反思产出 skillUpdates（对已有技能的改进建议），追加改进节，不覆盖旧内容
    for (const u of (json.skillUpdates || []).slice(0, 2)) {
      try {
        if (u.name && u.note) {
          const obj = { type: 'skillUpdate', name: String(u.name), note: String(u.note) };
          if (_shouldStage(obj)) { result.skills.push(`[staged]${u.name}+改进`); }
          else { memory.improveSkill(String(u.name), String(u.note)); result.skills.push(`${u.name}+改进`); }
        }
      } catch { /* skillUpdates 失败不阻塞主反思 */ }
    }
    const ev = json.evolution;
    if (ev && ev.title && (ev.patch?.old || ev.content)) {
      const evoTarget = loadConfig().immutableGenome ? 'harness' : 'system.md';
      const _obj = { type: 'evolution', target: evoTarget, title: String(ev.title), rationale: ev.rationale, patch: ev.patch, content: ev.content };
      if (_shouldStage(_obj)) {
        result.evolution = { status: 'staged', title: ev.title };
      } else {
        try {
          // C 配套（2026-10-02）：evolution 亦经统一队列（防 staging=false+大窗直写击穿前缀）。
          const _q = require('./pfxqueue');
          const _r = _q.enabled() ? _q.pfxWrite('evolution', ev.content, { op: 'evolution', name: ev.title, evoTarget, title: ev.title, rationale: ev.rationale, patch: ev.patch }) : { queued: false };
          if (_r && _r.queued) { result.evolution = { status: 'staged', title: ev.title, id: _r.id }; }
          else {
            const p = evolution.propose({ target: evoTarget, title: ev.title, rationale: ev.rationale, patch: ev.patch, content: ev.content });
            if (loadConfig().evolutionAutoApply) {
              await evolution.approve(p.id, { auto: true });
              result.evolution = { id: p.id, status: 'auto-applied', title: ev.title };
            } else {
              result.evolution = { id: p.id, status: 'pending', title: ev.title };
            }
          }
        } catch (err) {
          result.evolution = { error: err.message };
        }
      }
    }
    saveSession(s);
    runtime.emit('reflect', { sessionId: s.id, result });
    return result;
  } catch (e) {
    runtime.emit('reflect', { sessionId: s.id, result: { error: e.message } });
    return { error: e.message };
  }
}

function extractJson(text) {
  const t = String(text).replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/** 2026 年中国法定节假日（国务院办公厅国办发明电〔2025〕7号；格式 'YYYY-MM-DD'，含调休放假日）。
 *  可被 config.pricingHolidays 覆盖。 */
// 权威源=config.common.json.pricingHolidays（内置列表仅作回退；2026-10-02 单源化）
const DEFAULT_PRICING_HOLIDAYS_2026 = [
  '2026-01-01', '2026-01-02', '2026-01-03',            // 元旦
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23', // 春节
  '2026-04-04', '2026-04-05', '2026-04-06',            // 清明
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', // 劳动节
  '2026-06-19', '2026-06-20', '2026-06-21',            // 端午
  '2026-09-25', '2026-09-26', '2026-09-27',            // 中秋
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', // 国庆
];

/** 取生效节假日清单：config.pricingHolidays（数组）优先，否则内置 2026 默认值。
 *  @returns {Set<string>} 'YYYY-MM-DD' 集合 */
function pricingHolidaySet() {
  try {
    const arr = loadConfig().pricingHolidays;
    if (Array.isArray(arr) && arr.length) return new Set(arr.map((x) => String(x).slice(0, 10)));
  } catch { }
  return new Set(DEFAULT_PRICING_HOLIDAYS_2026);
}

/** DeepSeek 高峰时段（北京时间：周一至五 9:00-12:00、14:00-18:00；否则为空闲）。
 *  高峰价 = 空闲价×2。用本地时间判断（本机即 UTC+8）；中国法定节假日全天按空闲。
 *  @param {Date|number} date 默认当前时间 */
function isPeakHour(date) {
  const d = date ? new Date(date) : new Date();
  const day = d.getDay();          // 0=周日 6=周六
  if (day === 0 || day === 6) return false;      // 周末全空闲
  // 中国法定节假日全天按空闲（config.pricingHolidays 可覆盖内置清单）
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (pricingHolidaySet().has(ymd)) return false;
  const h = d.getHours(), m = d.getMinutes();    // 北京时间
  const t = h * 60 + m;                          // 当天分钟数
  const inMorning = t >= 9 * 60 && t < 12 * 60;   // 9:00-12:00
  const inAfternoon = t >= 14 * 60 && t < 18 * 60; // 14:00-18:00
  return inMorning || inAfternoon;
}

/** 成本单价：优先按 provider+实际模型名取价（deepseek 分模型），其次 provider 默认单价，再其次 config.prices。
 *  @param {object} cfg 配置
 *  @param {string} [model] 实际请求的模型名（决定 deepseek 用哪档价） */
function pricesOf(cfg, model) {
  const r = resolveProvider(cfg);
  try {
    const p = pricesFor(r.provider, model);
    if (p && p.cachedPerM != null) return p;
  } catch { }
  return (r.prices && r.prices.cachedPerM != null) ? r.prices : (cfg.prices || { cachedPerM: 0.07, missedPerM: 0.28, outputPerM: 0.42 });
}

/** 某分组（peak/off）单价的 token 折算成本（USD，与单价币种一致）。 */
function _costGroup(pri, group, hit, miss, out) {
  const p = pgroup(pri, group);
  return (hit / 1e6) * p.cachedPerM + (miss / 1e6) * p.missedPerM + (out / 1e6) * p.outputPerM;
}

/** 取某个分组（peak/off/默认）的单价。 */
function pgroup(pri, group) {
  if (group && pri.peak && pri.peak.cachedPerM != null) {
    if (group === 'peak') return { cachedPerM: pri.peak.cachedPerM, missedPerM: pri.peak.missedPerM, outputPerM: pri.peak.outputPerM, currency: pri.currency };
    if (group === 'off') return { cachedPerM: pri.cachedPerM, missedPerM: pri.missedPerM, outputPerM: pri.outputPerM, currency: pri.currency };
  }
  return pri;
}

/** 成本三分量：按"模型分桶 + 剩余兜底"全覆盖（byModel 只覆盖最近调用，历史累计必须用 provider 兜底价补算）。
 *  规则：每个时段组（peak/off）内，ΣbyModel各模型价 + (该组总量 − ΣbyModel该组) × provider 价；
 *  再加未分组剩余（总量 − peak − off）× provider 空闲价。保证任何数据形态下总量不丢、不漏、不重复。
 *  @returns {{cost:number, peakCost:number, offCost:number}} */
function _costSplit(cfg, container, pri) {
  // 优先用记账时固化的成本快照（历史不随当前价/汇率漂移）；无快照（旧数据）→ 按当前价回退计算。
  const cs = container && container.costSnap;
  if (cs && typeof cs.usd === 'number') {
    const g = cs.byGroup || {};
    return { cost: cs.usd || 0, peakCost: (g.peak && g.peak.usd) || 0, offCost: (g.off && g.off.usd) || 0,
             costRmb: cs.rmb || 0, peakRmb: (g.peak && g.peak.rmb) || 0, offRmb: (g.off && g.off.rmb) || 0 };
  }
  const byModel = (container.byModel && Object.keys(container.byModel).length) ? container.byModel : null;
  let cost = 0, peakCost = 0, offCost = 0;
  for (const group of ['peak', 'off']) {
    const gt = container[group] || {};
    let gHit = gt.hitTokens || 0, gMiss = gt.missTokens || 0, gOut = gt.outputTokens || 0;
    let bHit = 0, bMiss = 0, bOut = 0, gc = 0;
    if (byModel) {
      for (const m of Object.keys(byModel)) {
        const bg = (byModel[m] && byModel[m][group]) || {};
        const h = bg.hitTokens || 0, mi = bg.missTokens || 0, o = bg.outputTokens || 0;
        if (h || mi || o) gc += _costGroup(pricesOf(cfg, m), group, h, mi, o);
        bHit += h; bMiss += mi; bOut += o;
      }
    }
    // 该组内未被 byModel 覆盖的剩余（历史累计）→ provider 兜底价
    const rHit = Math.max(0, gHit - bHit), rMiss = Math.max(0, gMiss - bMiss), rOut = Math.max(0, gOut - bOut);
    const rc = _costGroup(pri, group, rHit, rMiss, rOut);
    const groupCost = gc + rc;
    if (group === 'peak') peakCost += groupCost; else offCost += groupCost;
    cost += groupCost;
  }
  // 未进入 peak/off 分组的剩余（旧数据/异常）→ provider 空闲价
  const pkSum = (container.peak && ((container.peak.hitTokens || 0) + (container.peak.missTokens || 0) + (container.peak.outputTokens || 0))) || 0;
  const offSum = (container.off && ((container.off.hitTokens || 0) + (container.off.missTokens || 0) + (container.off.outputTokens || 0))) || 0;
  const totalSum = (container.hitTokens || 0) + (container.missTokens || 0) + (container.outputTokens || 0);
  if (totalSum > pkSum + offSum) {
    const rHit = Math.max(0, (container.hitTokens || 0) - (((container.peak || {}).hitTokens || 0) + ((container.off || {}).hitTokens || 0)));
    const rMiss = Math.max(0, (container.missTokens || 0) - (((container.peak || {}).missTokens || 0) + ((container.off || {}).missTokens || 0)));
    const rOut = Math.max(0, (container.outputTokens || 0) - (((container.peak || {}).outputTokens || 0) + ((container.off || {}).outputTokens || 0)));
    const uc = _costGroup(pri, 'off', rHit, rMiss, rOut);
    cost += uc; offCost += uc;
  }
  return { cost, peakCost, offCost, costRmb: null, peakRmb: null, offRmb: null };   // 无快照 → rmb 由调用方按当前汇率折算
}

function sessionStats(s) {
  const cfg = loadConfig();
  const rate = typeof cfg.usdRate === 'number' && cfg.usdRate > 0 ? cfg.usdRate : 7.2;
  const st = s.stats || {};
  const hit = st.hitTokens || 0, miss = st.missTokens || 0, out = st.outputTokens || 0;
  const pk = (st.peak || {}), off = (st.off || {});
  const pri = pricesOf(cfg);   // 无模型信息/历史累计的兜底价（deepseek 默认 flash 档）
  // 计价：按模型分桶各用其价 + 剩余（历史累计）用 provider 兜底价，总量全覆盖（防 byModel 只含最近调用时漏计）
  const split = _costSplit(cfg, st, pri);
  const cost = split.cost, peakCost = split.peakCost, offCost = split.offCost;
  const mult = (pri.currency === 'CNY') ? 1 : rate;
  const rmb = (split.costRmb != null) ? split.costRmb : cost * mult;          // 有快照→用固化的 RMB；否则按当前汇率折算
  const peakRmb = (split.peakRmb != null) ? split.peakRmb : peakCost * mult;
  const offRmb = (split.offRmb != null) ? split.offRmb : offCost * mult;
  // 右侧面板"预算余额"：生效预算（会话级覆盖/全局）− 当前窗口 token 用量
  // 与引擎判交接用同一数据源：优先 API 回传真实 prompt_tokens（s._lastPromptTokens，见世代交接 L641），
  // 无值（如刚交接/重启后已清零）才回退本地 estimateTokens 估算，保证界面余额与引擎交接判定一致。
  let usedTokens = 0;
  const _real = Number(s._lastPromptTokens || 0);
  if (_real > 0) usedTokens = _real;
  else { try { for (const m of (s.messages || [])) usedTokens += estimateTokens(m); } catch { } }
  const contextBudget = effectiveBudget(s);
  return {
    ...s.stats, cacheHitRate: (hit + miss) ? hit / (hit + miss) : 0, costUsd: cost, costRmb: rmb, peakRmb, offRmb,
    contextBudget, usedTokens, budgetLeft: contextBudget - usedTokens,
    compactions: s.compactions || 0, gen: (() => { try { return archiveStore.currentGen(s.id) || 0; } catch { return s.compactions || 0; } })(),   // v6.53c：代数单源——stats.gen = 归档权威 gen（原=s.compactions 本地计数，致与涟漪/年轮不一致）
  };
}

/** P1（运行指标聚合）：由**原始 token** 用本引擎 cfg 统一计价 —— 跨实例聚合时避免各实例价/汇率漂移。
 *  @param {{hit?:number,miss?:number,out?:number}} tokens
 *  @returns {{costUsd:number,costRmb:number}} */
function costFromTokens(tokens) {
  const cfg = loadConfig();
  const rate = (typeof cfg.usdRate === 'number' && cfg.usdRate > 0) ? cfg.usdRate : 7.2;
  const pri = pricesOf(cfg);
  const st = {
    hitTokens: Number(tokens && tokens.hit) || 0,
    missTokens: Number(tokens && tokens.miss) || 0,
    outputTokens: Number(tokens && tokens.out) || 0,
  };
  const { cost } = _costSplit(cfg, st, pri);
  const mult = (pri.currency === 'CNY') ? 1 : rate;
  return { costUsd: cost, costRmb: cost * mult };
}

function globalStatsView() {
  const g = runtime.globalStats;
  const cfg = loadConfig();
  const denom = g.hitTokens + g.missTokens || 1;
  const rate = typeof cfg.usdRate === 'number' && cfg.usdRate > 0 ? cfg.usdRate : 7.2;
  // 分时段计价：按模型分桶各用其价 + 剩余（历史累计）用 provider 兜底价，总量全覆盖
  const pri = pricesOf(cfg);
  const poff = pgroup(pri, 'off');
  const split = _costSplit(cfg, g, pri);
  const cost = split.cost, peakCost = split.peakCost, offCost = split.offCost;
  const noCacheCost = ((g.hitTokens + g.missTokens) / 1e6) * poff.missedPerM + (g.outputTokens / 1e6) * poff.outputPerM;
  const mult = (pri.currency === 'CNY') ? 1 : rate;
  const costRmb = (split.costRmb != null) ? split.costRmb : cost * mult;
  const peakCostRmb = (split.peakRmb != null) ? split.peakRmb : peakCost * mult;
  const offCostRmb = (split.offRmb != null) ? split.offRmb : offCost * mult;
  const cacheSaveRmb = (noCacheCost - cost) * mult;
  return {
    calls: g.calls, hitTokens: g.hitTokens, missTokens: g.missTokens, outputTokens: g.outputTokens,
    cacheHitRate: g.hitTokens / denom, costUsd: cost, costRmb: costRmb,
    peakCostRmb: peakCostRmb,
    offCostRmb: offCostRmb,
    avgTtfbMs: g.ttfbCount ? Math.round(g.ttfbSumMs / g.ttfbCount) : null,
    avgDurationMs: g.durationCount ? Math.round(g.durationSumMs / g.durationCount) : null,
    cacheSaveRmb: cacheSaveRmb,
    uptimeSec: Math.round((Date.now() - g.startedAt) / 1000),
    uptimeMs: Date.now() - g.startedAt,
    lastTurn: g.lastTurn,
  };
}

/** 软删除：移入回收站（保留可恢复；30 天后自动清除）。 */
function trashSession(id) {
  const s = getSession(id);
  s.trashedAt = Date.now();
  saveSession(s);
  // C：回收站同样清信箱映射（防恢复到脏映射；对端残留会话由 D 兜底）
  try { require('./mailbox').unlinkBySession(id); } catch { }
  return { id: s.id, trashedAt: s.trashedAt };
}

/** 从回收站恢复。 */
function restoreSession(id) {
  const s = getSession(id);
  s.trashedAt = null;
  saveSession(s);
  return { id: s.id };
}

/** 清除过期回收站项（>30 天）：连同归档一并硬删除。返回清除数。直接扫描会话文件（含空会话）。 */
function purgeTrash(days = 30) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let n = 0;
  if (!fs.existsSync(SESSIONS_DIR)) return 0;
  for (const f of fs.readdirSync(SESSIONS_DIR).filter((x) => x.endsWith('.json') && !x.endsWith('.meta.json'))) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      if (s.trashedAt && s.trashedAt <= cutoff) { deleteSession(s.id); n++; }
    } catch { /* 单个坏文件跳过 */ }
  }
  return n;
}

/** D 兜底：把本实例内【任意标题】0 消息、超期（默认 >24h）的会话移入回收站（软删可恢复）——清首测类空壳。
 *  传 opts.titlePrefix 可仅限特定前缀；不传=不限前缀（覆盖旧"信箱会话:"及任何空壳）。
 *  仅清扫本实例会话文件，绝不跨实例；apply=false 只统计不改。返回 {scanned, trashed, ids}。 */
function sweepEmptyPeerSessions(opts = {}) {
  const olderThanMs = Number(opts.olderThanMs) || 24 * 3600 * 1000;
  const apply = opts.apply !== false;
  const prefix = opts.titlePrefix ? String(opts.titlePrefix) : '';
  const cutoff = Date.now() - olderThanMs;
  const out = { scanned: 0, trashed: 0, ids: [] };
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return out;
    for (const f of fs.readdirSync(SESSIONS_DIR).filter((x) => x.endsWith('.json') && !x.endsWith('.meta.json'))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
        if (!s || !s.id || s.trashedAt || s.running) continue;
        if (prefix && String(s.title || '').indexOf(prefix) !== 0) continue;
        if ((s.messages || []).length !== 0) continue;
        // 年龄：updatedAt/createdAt 为 ISO 字符串（历史亦可能是 number 毫秒）→ 兼容解析。
        // ★2026-10-10 修：原 `Number(ISO)`=NaN → `ts>cutoff` 恒 false → 24h 阈值失效、空会话不分新旧被清。
        // 无/坏时间戳 → ts=0 → 跳过（保护，绝不误清）。
        const raw = s.updatedAt || s.createdAt;
        const ts = (typeof raw === 'number') ? raw : (raw ? Date.parse(raw) : 0);
        if (!ts || ts > cutoff) continue;
        out.scanned++;
        if (apply) { trashSession(s.id); out.trashed++; out.ids.push(s.id); }
      } catch { /* 单个坏文件跳过 */ }
    }
  } catch { }
  return out;
}

module.exports = {
  currentTimeLine,   // 【当前时间】注入（2026-10-06，供测试）
  markMentionFulfilled,
  runtime, createSession, getSession, sessionExists, listSessions, deleteSession, saveSession, patchSession,
  stopRun, runChat, sessionStats, globalStatsView, isPeakHour, pricesOf, creditUsage, creditUsageById, costFromTokens,
  trashSession, restoreSession, purgeTrash, sweepEmptyPeerSessions,
  // 导出内部工具供测试：预算/压缩/摘要/交接提醒/世代交接
  // 导出内部工具供测试：预算/估算/世代交接
  estimateTokens, summarizeSegment, effectiveBudget, deepCompact, summarizeCut,
  deepArchiveNow, deepFillSummary, slimToolResult, ageToolResults, ageToolCallArgs, toolInlineMax, buildSelfHint, stripSelfHint, maybeSelfHint, buildRoleDispatchHint, stripDispatchHint, routeTask, matchRoleDispatch, confidence, isConsultIntent, archiveCut, buildHandoffDoc, buildHandoffDocSync, parseTodos, handoffSkeleton, forceHandoff,
  pickHeadTail, truncKeyKeepRecent, truncKeepPending,
  renderBranchTimeline, shadowCompareBranch, buildHandoffDocFromBranch, branchSkeletonText, shadowCompareHandoffSkeleton, resolveBranchTurnGen, renderRingIndex, seedBranchFromLedgerIfEnabled,
  drainReflectPending, drainReflectPendingAll, migrateReflectPending, reflectPendingKey, _stageReflect,   // 反思写入攒批化（导出供单测/启动兜底）
  raceToolAbort, isStuckTurn, forceReleaseStuckTurn, turnHardCapMs, toolHardTimeoutMs, repairInterruptedTurn,
  wakeMailbox, wakeMailboxForced, enqueueRoleDrain, flushPendingInbound, drainPendingInbound, schedulePendingDrain, _hasUndeliveredInbound, inboundLivenessDiag,   // P6：enqueueRoleDrain（角色级 drain）
  sweepLostInboundWakes,   // v6.47：唤醒丢失兜底扫描（未起回合的动作类入站 → 补唤醒）
  sweepStaleSilentInboundWakes,   // v6.53：知情类回执空闲兜底唤醒（reply/ack/notify/result 超阈值未读 → 兜底唤醒一次）   // v6.x/v6.32：忙时入站标记补写 + 排空单一路径 + liveness 诊断
  sweepDeliveredUninjectedWakes,   // B②：已投递未注入兜底唤醒（delivered=1 且 injected_at IS NULL → 补唤醒）
  abortTurnForRevision,   // P2b-4 T1：修订 → 回合边界 abort + 重注入（导出供 server/单测）
  reinjectPendingRevision,   // P2b-4 T1：abort 收尾强制唤醒重注入（离线可测）
  idleUnreadReady, sweepIdleUnread, scheduleIdleUnreadSweep, sweepIdleSilentReads, isActionableType, selectMailboxBatch,   // 唤醒盲区根治 + 回执乒乓修复 + 信箱截断消费修复（导出供单测）
  markDoneOnce, scheduleShortRecheck, cancelShortRecheck,   // 异步「完成即推 + 短回检」最小件（导出供单测）
  emitTurnStream, flushTurnStreamSession,   // P2（R4）：回合正文按 sessionId 实时广播（导出供单测）
  deriveTaskTopic, resolveTaskTopic,   // C（2026-09-29）派单驱动归枝：枝键推导（导出供单测）
  sweepPendingInbound,   // D3-③：启动兜底补标（未运行会话的 _pendingInbound 落库）
  // v3.1 批1（P0）：导出供测试/独立验收
  archiveTopicMap, compactSummaryGens, compactGensByPrefix, backfillArchiveMemo, memIncrementLines, writeArchiveDir, distillSummary,
  projectDir, projectFilesDir, ensureProjectFilesSubdir, syncProjectFiles,
  shouldHandoff, originLabel,   // 任务②：导出纯判据/标注供离线单测
  listPendingPrefixAll, listPendingPrefixForSession, pfxIntentEnabled, progressHasPrefix, pfxFallbackDecision, buildIterHint, buildPfxWindowHint, pfxWindowHist, sanitizeOrphanTools, hasPairedToolCall,   // P3·账本退役 + 待补前缀强制兜底 + 迭代账目 + 前缀窗口提示 + 孤儿tool防护：导出供离线单测
  buildTaskBlocks,   // 任务③：导出供离线单测（现场快照/未读信箱/在途派单）
  buildSuspectTodoHint,   // 低优兜底（2026-10-03）：回执/部署事件按 cid/refs 反查 openTodos 的"疑似可勾销"提示（导出供单测）
  toWire, isInboundMarkerMsg, buildInboundMarker,   // v6.42：入站二次表达根治（组装层排除纯标记）导出供离线单测；refs=sys-marker：统一标记工厂
};
