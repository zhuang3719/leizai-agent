'use strict';
// 雷仔 · DeepSeek 客户端（OpenAI 兼容协议）
// 关键优化：流式请求 + include_usage 缓存遥测 + 429/5xx 退避重试 + keep-alive 连接复用
const { load, ROOT } = require('./config');
const { resolve } = require('./providers');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

// —— 任务B：模型可用性状态总线 ——
// 每次 LLM 调用成功/失败后 emit('llm-status', { ok, reason, retryable, at, latencyMs })，
// 由 runtime 转 emit 到引擎事件总线 → server broadcast 'llm-status' → 前端常驻横幅。
// 只做"通知"，不改变任何调用行为（失败仍照原样抛出）。
const llmBus = new EventEmitter();
llmBus.setMaxListeners(100);
const LLM_REASON_TEXT = {
  network: '网络不可达（无法连接模型服务）',
  timeout: '连接超时',
  http5xx: '模型服务端异常（5xx）',
  http429: '请求被限流（429）',
  'no-key': '未配置 API Key',
  // v6.37（会诊定案）：非 429/5xx 的 HTTP 失败也要有中文原因——此前只有 reason='http4xx' 原样透传，用户看不懂。
  http402: '账户余额不足（欠费），请充值后重试',
  http401: 'API Key 无效或鉴权失败，请检查配置',
  http403: 'API Key 无权限或鉴权失败，请检查配置',
  http400: '请求被模型服务拒绝（400），多为消息格式/上下文问题',
  http4xx: '模型服务拒绝了本次请求（4xx），请稍后重试或检查配置',
  'empty-response': '模型未返回内容（上游异常，可重试）',
  'stream-truncated': '响应被中断（上游未正常结束，可重试）',
};
/** v6.37（会诊定案·根因）失败分类轴：从"可否重试"改为"**用户能否采取行动**"。
 *  - retryable：可自愈（429/5xx/network/timeout）→ 后台重试/点横幅重试；
 *  - needsUserAction：不可自愈且**用户必须动手**（402 充值 / 401·403 换 Key）→ 必须显式提示，且不能写"点重试"。
 *  此前只对 retryable 提示 → 最致命的 402/401 反而静默，方向恰好反了。 */
function isNeedsUserAction(reason) { return reason === 'http402' || reason === 'http401' || reason === 'http403' || reason === 'no-key'; }
/** HTTP 状态码 → { reason, retryable, needsUserAction }（单一分类入口，供 chatStream/chatOnce/probe 共用）。 */
function classifyHttp(status) {
  const s = Number(status) || 0;
  if (s === 401) return { reason: 'http401', retryable: false, needsUserAction: true };
  if (s === 403) return { reason: 'http403', retryable: false, needsUserAction: true };
  if (s === 402) return { reason: 'http402', retryable: false, needsUserAction: true };
  if (s === 429) return { reason: 'http429', retryable: true, needsUserAction: false };
  if (s >= 500) return { reason: 'http5xx', retryable: true, needsUserAction: false };
  if (s >= 400) return { reason: 'http4xx', retryable: false, needsUserAction: true };
  return { reason: 'http' + s, retryable: false, needsUserAction: true };
}
function llmReasonText(reason) { return LLM_REASON_TEXT[reason] || (reason ? String(reason) : '模型服务不可用'); }
function emitLlmStatus(ok, reason, extra) {
  try {
    llmBus.emit('llm-status', Object.assign({
      ok: !!ok,
      reason: ok ? null : (reason || 'unknown'),
      reasonText: ok ? null : llmReasonText(reason),
      at: Date.now(),
    }, extra || {}));
  } catch { }
}
/** 给错误打上"模型服务不可用"标记并广播状态；返回同一个 error（便于 throw markUnavailable(...)）。 */
function markUnavailable(err, reason, retryable) {
  const e = (err instanceof Error) ? err : new Error(String(err));
  if (!e.llmUnavailable) { e.llmUnavailable = true; e.llmReason = reason; e.llmReasonText = llmReasonText(reason); }
  e.llmRetryable = retryable !== false;
  e.llmNeedsUserAction = isNeedsUserAction(reason);
  emitLlmStatus(false, reason, { retryable: e.llmRetryable, needsUserAction: e.llmNeedsUserAction });
  return e;
}
function onLlmStatus(cb) { if (typeof cb === 'function') llmBus.on('llm-status', cb); }

function keyOf(cfg, pr) {
  // 1) 优先按 provider 从 apiKeys 字典取（多 provider 并存，切换互不覆盖）
  if (pr && pr.provider && cfg.apiKeys && cfg.apiKeys[pr.provider]) return cfg.apiKeys[pr.provider];
  // 2) 兼容旧配置：单一 apiKey 字段
  if (cfg.apiKey) return cfg.apiKey;
  // 3) 环境变量兜底（按 provider 的 apiKeyEnv）
  if (pr && pr.apiKeyEnv && process.env[pr.apiKeyEnv]) return process.env[pr.apiKeyEnv];
  return '';
}

// —— v6.43：LLM 失败诊断日志（独立落盘，供事后诊断"模型链接断开"等间歇性故障）——
// 背景：失败只走 console.error（daemon 隐藏窗口 → stdout 丢失），logs/leizai.log 仅成功行 → 无法事后诊断。
// 原则：只记录不改变行为；写盘全程 try/catch 包裹，绝不影响主流程；**脱敏**（apiKey/Authorization）。
const LLM_ERR_LOG = path.join(ROOT, 'logs', 'llm-errors.log');
const LLM_ERR_MAX = 2 * 1024 * 1024;   // 2MB 轮转阈值
/** 脱敏：抹掉 apiKey / Authorization / Bearer / sk- 形态的密钥，防泄漏进日志。 */
function _redactSecret(s) {
  let t = String(s == null ? '' : s);
  // Authorization: Bearer xxx / apiKey=xxx / "key":"xxx"
  t = t.replace(/(authorization|api[_-]?key|bearer|secret|token)["'\s:=]{1,4}[A-Za-z0-9._\-]{4,}/ig, '$1:***');
  // 裸 sk- 形态
  t = t.replace(/sk-[A-Za-z0-9_\-]{6,}/g, 'sk-***');
  return t;
}
/** 本地时间戳（含毫秒）：yyyy-MM-dd HH:mm:ss.SSS */
function _localTs(d = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
/** 超 ~2MB 则把 llm-errors.log 改名 .1（保留最近 1 份）；失败静默。 */
function _rotateLlmErrLog() {
  try {
    const st = fs.statSync(LLM_ERR_LOG);
    if (st.size > LLM_ERR_MAX) {
      try { fs.rmSync(LLM_ERR_LOG + '.1', { force: true }); } catch { }
      fs.renameSync(LLM_ERR_LOG, LLM_ERR_LOG + '.1');
    }
  } catch { /* 文件不存在等 → 忽略 */ }
}
/** 落盘一条 LLM 失败记录（JSON 单行 append，UTF-8）。任何异常都不抛出。 */
function logLlmError(info = {}) {
  try {
    const cfg = load();
    const pr = resolve(cfg);
    const bodyRaw = info.body != null ? String(info.body) : '';
    const body = _redactSecret(bodyRaw).slice(0, 500);
    const rid = (bodyRaw.match(/request[_-]?id["'\s:=]{1,4}([A-Za-z0-9\-_]+)/i) || [])[1]
      || (bodyRaw.match(/"id"["'\s:=]{1,4}([A-Za-z0-9\-_]+)/i) || [])[1] || '';
    const rec = {
      ts: _localTs(),
      kind: info.kind || 'unknown',
      httpStatus: Number(info.httpStatus) || 0,
      reason: info.reason || '',
      provider: (pr && pr.provider) || '',
      model: info.model || (pr && pr.model) || '',
      stream: !!info.stream,
      attempt: (info.attempt != null ? Number(info.attempt) : 0),
      requestId: rid,
      msg: _redactSecret(info.message || '').slice(0, 300),
      body,
    };
    _rotateLlmErrLog();
    try { fs.mkdirSync(path.dirname(LLM_ERR_LOG), { recursive: true }); } catch { }
    fs.appendFileSync(LLM_ERR_LOG, JSON.stringify(rec) + '\n', { encoding: 'utf8' });
    // v6.43：顺带在 logs/leizai.log 补一行（daemon 窗口隐藏，但文件镜像可见）
    try { console.log(`[LLM调用失败] kind=${rec.kind} http=${rec.httpStatus || '-'} reason=${rec.reason} provider=${rec.provider} model=${rec.model}${rec.requestId ? ' req=' + rec.requestId : ''}`); } catch { }
  } catch { /* 写盘/读取失败绝不外抛，不影响主流程 */ }
}

// —— v6.45：请求 dump（诊断"引擎实发 payload"与"手发 200 payload"逐字节对比）——
// 目的：抓引擎运行时真实请求（含 messages 全量），供 400 复现对比；**脱敏 authorization/apiKey**。
// 原则：全程 try/catch，绝不阻断请求；默认只落文件不打 console。
const LLM_LAST_REQ = path.join(ROOT, 'logs', 'llm-last-req.json');     // 每次请求前覆盖写
const LLM_FAIL_DIR = path.join(ROOT, 'logs');                          // llm-fail-<ts>.json 所在目录
const LLM_FAIL_KEEP = 10;                                              // 保留最近 10 份
/** 结构脱敏：按 key 名抹掉敏感值（authorization/apiKey/bearer/secret），messages 内容完整保留。 */
function _dumpSanitize(payload) {
  try {
    return JSON.stringify(payload, (k, v) => {
      if (typeof v === 'string' && /^(authorization|api_?key|bearer|secret)$/i.test(String(k))) return '***';
      return v;
    });
  } catch (e) { return JSON.stringify({ _dumpError: String((e && e.message) || e) }); }
}
/** 每次请求前/后覆盖写 logs/llm-last-req.json（含 meta + 完整 payload）。绝不抛出。 */
function dumpLastReq(payload, meta = {}) {
  try {
    const rec = {
      ts: _localTs(),
      kind: meta.kind || 'unknown',
      attempt: meta.attempt != null ? Number(meta.attempt) : 0,
      provider: meta.provider || '', model: meta.model || '', stream: !!meta.stream,
      httpStatus: meta.httpStatus != null ? Number(meta.httpStatus) : null,
      startedAt: meta.startedAt != null ? meta.startedAt : Date.now(),
      durationMs: meta.durationMs != null ? meta.durationMs : null,
    };
    fs.mkdirSync(path.dirname(LLM_LAST_REQ), { recursive: true });
    fs.writeFileSync(LLM_LAST_REQ, `{"meta":${JSON.stringify(rec)},"payload":${_dumpSanitize(payload || {})}}`, { encoding: 'utf8' });
  } catch { }
}
/** 非 2xx / 网络失败时另存 logs/llm-fail-<ts>.json（payload + 响应体 + requestId），保留最近 10 份。绝不抛出。 */
function dumpFailReq(payload, meta = {}, respText = '') {
  try {
    const rt = String(respText || '');
    const rid = (rt.match(/request[_-]?id["'\s:=]{1,4}([A-Za-z0-9\-_]+)/i) || [])[1] || '';
    const rec = {
      ts: _localTs(), kind: meta.kind || 'unknown', attempt: meta.attempt != null ? Number(meta.attempt) : 0,
      provider: meta.provider || '', model: meta.model || '', stream: !!meta.stream,
      httpStatus: meta.httpStatus != null ? Number(meta.httpStatus) : 0,
      requestId: rid,
      startedAt: meta.startedAt != null ? meta.startedAt : Date.now(),
      durationMs: meta.durationMs != null ? meta.durationMs : null,
      error: _redactSecret(meta.error || ''),
      responseBody: rt.slice(0, 4000),
    };
    fs.mkdirSync(LLM_FAIL_DIR, { recursive: true });
    const fn = path.join(LLM_FAIL_DIR, `llm-fail-${Date.now()}.json`);
    fs.writeFileSync(fn, `{"meta":${JSON.stringify(rec)},"payload":${_dumpSanitize(payload || {})}}`, { encoding: 'utf8' });
    try {
      const files = fs.readdirSync(LLM_FAIL_DIR).filter((f) => f.startsWith('llm-fail-') && f.endsWith('.json')).sort();
      while (files.length > LLM_FAIL_KEEP) { const del = files.shift(); try { fs.rmSync(path.join(LLM_FAIL_DIR, del), { force: true }); } catch { } }
    } catch { }
  } catch { }
}

/** 空返回插桩（2026-10-03）：dump "本轮模型空返回"的请求 payload + 响应摘要到 logs/empty-dump-<ts>.json。
 *  限速：同一分钟最多 EMPTY_DUMP_PER_MIN 条；总量上限 EMPTY_DUMP_KEEP 份（达上限直接不写，防刷盘）。绝不抛出。 */
const EMPTY_DUMP_PER_MIN = 3;
const EMPTY_DUMP_KEEP = 30;
let _emptyDumpMin = '';
let _emptyDumpMinCount = 0;
function dumpEmptyReq(payload, meta = {}, respText = '') {
  try {
    const mk = new Date().toISOString().slice(0, 16);   // 分钟键（UTC，够用）
    if (_emptyDumpMin !== mk) { _emptyDumpMin = mk; _emptyDumpMinCount = 0; }
    if (_emptyDumpMinCount >= EMPTY_DUMP_PER_MIN) return false;   // 同分钟限速
    fs.mkdirSync(LLM_FAIL_DIR, { recursive: true });
    let files = [];
    try { files = fs.readdirSync(LLM_FAIL_DIR).filter((f) => f.startsWith('empty-dump-') && f.endsWith('.json')).sort(); } catch { }
    if (files.length >= EMPTY_DUMP_KEEP) return false;            // 总量上限（不写、也不轮转，防刷盘）
    _emptyDumpMinCount++;
    const rec = {
      ts: _localTs(), kind: meta.kind || 'unknown', model: meta.model || '',
      attempt: meta.attempt != null ? Number(meta.attempt) : 0,
      httpStatus: meta.httpStatus != null ? Number(meta.httpStatus) : 0,
      finishReason: meta.finishReason || '', sawDone: !!meta.sawDone,
      evCount: meta.evCount != null ? Number(meta.evCount) : null,
      textLen: meta.textLen != null ? Number(meta.textLen) : 0,
      reasoningLen: meta.reasoningLen != null ? Number(meta.reasoningLen) : 0,
      toolCalls: meta.toolCalls != null ? Number(meta.toolCalls) : 0,
      messageCount: meta.messageCount != null ? Number(meta.messageCount) : null,
      ttfbMs: meta.ttfbMs != null ? Number(meta.ttfbMs) : null,
      durationMs: meta.durationMs != null ? Number(meta.durationMs) : null,
      usage: meta.usage || null,
      error: _redactSecret(meta.error || ''),
      responseBody: String(respText || '').slice(0, 2000),
    };
    const fn = path.join(LLM_FAIL_DIR, `empty-dump-${Date.now()}.json`);
    fs.writeFileSync(fn, `{"meta":${JSON.stringify(rec)},"payload":${_dumpSanitize(payload || {})}}`, { encoding: 'utf8' });
    return true;
  } catch { return false; }
}

/** 判断 DeepSeek 报错是否为"上下文长度超限"。命中时抛出的错误带 contextOverflow 标志，供 Runtime 触发压缩重试。 */
function isContextOverflow(body) {
  const b = String(body || '');
  return /context\s*(length|window|exceed|too long|limit)|maximum\s*context|input\s*tokens?\s*(exceed|too large)|prompt\s*is\s*too\s*long/i.test(b);
}

/** 构造一个可能带 contextOverflow 标志的错误。
 *  v6.37：所有非 2xx 都**广播 llm-status**（此前仅 429/5xx 走 markUnavailable → 402/401 静默，前端无横幅）。
 *  opts.silent=true 用于"还有一次重试机会"的中间失败（不提前弹提示）。 */
function mkErr(status, body, prefix, opts) {
  const e = new Error(`${prefix}DeepSeek HTTP ${status}: ${String(body || '').slice(0, 500)}`);
  if (isContextOverflow(body)) e.contextOverflow = true;
  e.httpStatus = Number(status) || 0;
  try {
    if (!(opts && opts.silent)) {
      const c = classifyHttp(status);
      emitLlmStatus(false, c.reason, { retryable: c.retryable, needsUserAction: c.needsUserAction, httpStatus: e.httpStatus });
    }
  } catch { }
  return e;
}
/** v6.37：非 2xx → 构造"已标记可用性"的错误（带三态语义），统一出口，杜绝静默。
 *  v6.43：ctx={kind,model,stream,attempt} 传入 → 同时落盘诊断日志 logs/llm-errors.log（只记录不改行为）。 */
function httpFailure(status, body, prefix, ctx) {
  const c = classifyHttp(status);
  const e = mkErr(status, body, prefix || '');
  e.llmUnavailable = true;
  e.llmReason = c.reason;
  e.llmReasonText = llmReasonText(c.reason);
  e.llmRetryable = c.retryable;
  e.llmNeedsUserAction = c.needsUserAction;
  logLlmError(Object.assign({ httpStatus: status, body, reason: c.reason, message: prefix }, ctx || {}));
  return e;
}

// —— 重复输出护栏（防"死循环重复一句话"）——
// 现象：模型（尤其实验模型+长上下文退化）会在一次回复中把同一句话/同一组句子
// 连续生成几十上百遍（实测会话里出现过"再 node 验证 workdir."×418）。
// 护栏实时检测两种退化形态，命中即取消流并截断文本：
//   1) 行周期重复：最近出现 3 组完全相同的连续行序列（p=1 是单行复读，p>1 是循环复读）；
//   2) 无换行复读：尾部指定长度内同一 12 字符块真实出现 ≥6 次才判复读刷屏（"现在验证。"反复刷屏才触发；正常中文短句凑 3~5 次不误伤）。
// 命中后返回 { repeated: true }，由 runChat 触发一次"重置气泡+更强惩罚重试"。
function makeRepeatGuard() {
  const LINE_WINDOW = 48;      // 最多追踪的最近完整行数
  const PERIOD_MAX = 8;        // 检测的最大周期（行）
  const GROUPS = 3;            // 周期需重复 3 组才判退化（防代码块等合法重复误判）
  const CHUNK_LEN = 12;        // 无换行退化：滑窗块长（字符）——加长，避免短词凑巧重复误伤
  const CHUNK_TIMES = 6;       // 块出现次数阈值（真正生效！）：同一 12 字符块在整个尾部出现 ≥6 次才判复读刷屏——正常中文短句凑 3~5 次都不误伤
  const CHUNK_TAIL = 200;      // 尾部检查长度——加长，让正常长段落有足够判定帧

  const nlines = [];           // 非空完整行 {norm, start}（start=该行在 text 中的起始偏移）
  let proc = 0;                // 已扫描过的 text 长度（增量行解析）
  let curLineStart = 0;        // 当前未完成行的起点
  let hitCut = -1;             // 命中时的截断偏移

  function cut() { return hitCut; }

  function scanLines(text) {
    for (let i = proc; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {           // \n
        const raw = text.slice(curLineStart, i).replace(/\r$/, '');
        const norm = raw.trim();
        if (norm) {
          nlines.push({ norm, start: curLineStart });
          if (nlines.length > LINE_WINDOW) nlines.splice(0, nlines.length - LINE_WINDOW);
        }
        curLineStart = i + 1;
      }
    }
    proc = text.length;
  }

  function checkLines() {
    const n = nlines.length;
    if (n < 3) return false;
    const maxP = Math.min(PERIOD_MAX, Math.floor(n / GROUPS));
    for (let p = 1; p <= maxP; p++) {
      let ok = true;
      for (let g = 1; g < GROUPS && ok; g++) {
        for (let k = 0; k < p; k++) {
          if (nlines[n - g * p + k].norm !== nlines[n - (g + 1) * p + k].norm) { ok = false; break; }
        }
      }
      if (ok) {
        hitCut = nlines[n - GROUPS * p].start;
        return true;
      }
    }
    return false;
  }

  function checkChunks(text) {
    // 仅当尾部无换行才做块级复读检查（有换行的退化交给行周期检测，避免每 token 全量扫描）
    const tail = text.slice(-CHUNK_TAIL);
    if (tail.indexOf('\n') >= 0) return false;
    if (tail.length < CHUNK_LEN * CHUNK_TIMES) return false;
    // 对每个滑窗块，统计它在尾部出现的总次数（用递归 indexOf 计数），达到 CHUNK_TIMES 才命中。
    // 关键修正：旧代码硬编码"i, i+len, i+2len 三处出现"就命中，等于永远按 3 次触发、
    // 完全没用上 CHUNK_TIMES——所以之前调大 CHUNK_TIMES 根本没降误伤。现在改成真实计数。
    for (let i = 0; i <= tail.length - CHUNK_LEN; i++) {
      const sub = tail.slice(i, i + CHUNK_LEN);
      let count = 0, pos = tail.indexOf(sub);
      while (pos >= 0) { count++; pos = tail.indexOf(sub, pos + CHUNK_LEN); }
      if (count >= CHUNK_TIMES) {
        // 截断在重复块最早出现处：只可能多删 0~CHUNK_LEN-1 个边界字符（跨周期对齐歧义），
        // 绝不可能把复读内容留在保留文本里。
        hitCut = Math.max(0, text.length - CHUNK_TAIL) + i;
        return true;
      }
    }
    return false;
  }

  /** 每收到一段增量调用：返回 true 表示命中退化（此后应停止采集/取消流）。 */
  function observe(text) {
    if (hitCut >= 0) return true;
    scanLines(text);
    if (checkLines()) return true;
    return checkChunks(text);
  }

  return { observe, cut };
}

/** 统一 reasoning_effort 取值（集中默认层，2026-09-22）：
 *  优先级 opts.reasoningEffort（显式）> cfg.reasoningEffortByKind[kind] > cfg.reasoningEffort（全局）> 不发。
 *  ''/null/非字符串 → 不发；'off' → 'full' 不发（回滚语义不变）/'onoff' 发 'none'（真关思考省钱）。
 *  thinking={type:'disabled'} → 强制不发（关思考优先，避免与 effort 冲突）。
 *  按 provider 能力位 effortSupport 下发（providers.js PROFILE，2026-10-07 起取代 thinkingFormat 闸门）：
 *    'full'=真档位原样下发；'onoff'=开关语义（off→'none' 关思考、max→'high' 钳制防 400、none/low/medium/high 原样、其余不发）；'none'=不发。
 *  thinkingFormat 仍只管流解析（思考内容怎么读），与本函数无关。
 *  @param {object|string} profileOrFormat providers.resolve() 画像（首选）或旧版 thinkingFormat 字符串
 *  @returns {string|undefined} 生效档位，或 undefined（不发） */
function resolveEffort(cfg, kind, opts = {}, profileOrFormat = 'deepseek', thinking) {
  if (thinking && String(thinking.type || '') === 'disabled') return undefined;   // 关思考优先
  // 能力位闸门：对象第 4 参读 effortSupport；旧签名字符串按等价映射（'deepseek'→'full'，其余→'none'），行为与旧版一致
  const support = (profileOrFormat && typeof profileOrFormat === 'object')
    ? String(profileOrFormat.effortSupport || 'none')
    : (String(profileOrFormat || '') === 'deepseek' ? 'full' : 'none');
  if (support === 'none') return undefined;                                       // 未声明能力 → 不下发（防 400）
  const byKind = (cfg && cfg.reasoningEffortByKind && typeof cfg.reasoningEffortByKind === 'object') ? cfg.reasoningEffortByKind : {};
  let v;
  if (opts && opts.reasoningEffort !== undefined) v = opts.reasoningEffort;
  else if (kind && byKind[kind] !== undefined) v = byKind[kind];
  else v = (cfg ? cfg.reasoningEffort : undefined);
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') v = String(v);
  v = v.trim();
  if (!v) return undefined;
  if (v === 'off') return support === 'onoff' ? 'none' : undefined;               // onoff：off=真关思考；full：off=不发（现状）
  if (support === 'onoff') {
    if (v === 'max') return 'high';                                               // mimo 无 max → 钳制防 400
    return ['none', 'low', 'medium', 'high'].includes(v) ? v : undefined;         // 合法值原样，其余不发
  }
  return v;                                                                       // 'full'：原样下发
}

/**
 * 流式对话调用。
 * @param {object} opts
 *   messages  - 完整消息数组（含 system）
 *   tools     - 工具定义数组（可为 undefined）
 *   signal    - AbortSignal
 *   model/temperature/maxTokens/reasoningEffort
 * @param {object} cb
 *   onDelta(text) 最终内容增量
 *   onReasoning(text) 思考增量
 *   onToolCallDelta(partial) 工具调用增量（index, name, arguments 增量）
 * @returns {Promise<{text, reasoning, toolCalls, usage, ttfbMs, durationMs, stopped}>}
 */
async function chatStream(opts, cb = {}) {
  const cfg = load();
  const kind = opts.kind || 'unknown';   // 调用来源标识（turn/summarize/handoff-seg/handoff-fill/reflect/subagent/leiyin…），供审计
  const pr = resolve(cfg);
  const key = keyOf(cfg, pr);
  if (!key) {
    throw markUnavailable(new Error(`未配置 API Key：请在 config.json 的 apiKey，或环境变量 ${pr.apiKeyEnv || 'LEIZAI_DEEPSEEK_API_KEY'} 中配置`), 'no-key', false);
  }
  // 实际请求的模型名（带出到 usage，供按模型分价计费）；缺失时逐级兜底，绝不为空（防落 'unknown' 用错价）
  const usedModel = opts.model || pr.model || (pr.defaultModels && pr.defaultModels[0]) || 'deepseek-flash';
  const payload = {
    model: usedModel,
    messages: opts.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(opts.tools && opts.tools.length ? { tools: opts.tools } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
    // 集中默认：reasoning_effort 统一走 resolveEffort（显式 opts 最高优先 → turn 行为等价）；
    //   按能力位 pr.effortSupport 下发（none 不发；onoff：off→none、max→high 钳制）；disabled 不发。
    ...((() => { const e = resolveEffort(cfg, kind, opts, pr, opts.thinking); return e !== undefined ? { reasoning_effort: e } : {}; })()),
    // 防复读：frequency_penalty 会惩罚重复 token（DeepSeek OpenAI 兼容参数，范围 -2~2；
    // 未配置则不发送，保持旧行为）。重复输出护栏重试时会临时抬高。
    ...(typeof opts.frequencyPenalty === 'number' && isFinite(opts.frequencyPenalty) ? { frequency_penalty: opts.frequencyPenalty } : {}),
  };

  const startedAt = Date.now();
  let ttfbMs = -1;
  let lastErr = null;
  // v6.50（2026-10-04 根因修复①）：读空闲超时——防上游"只 stall 不关连接"导致回合永久挂起。
  //   默认 90s 无任何 SSE 数据 → 判读空闲超时（归类 timeout 且可重试）。cfg.llmReadIdleMs 可覆盖；0=关闭（回滚）。
  const READ_IDLE_MS = (() => { const v = Number(cfg && cfg.llmReadIdleMs); return (isFinite(v) && v >= 0) ? v : 90000; })();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 800)); // 退避
    let res;
    const _reqT0 = Date.now();
    try {
      res = await fetch(`${pr.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
        signal: opts.signal,
      });
    } catch (e) {
      dumpLastReq(payload, { kind, model: usedModel, stream: true, attempt, provider: pr.provider, startedAt: _reqT0, durationMs: Date.now() - _reqT0 });
      dumpFailReq(payload, { kind, model: usedModel, stream: true, attempt, provider: pr.provider, startedAt: _reqT0, durationMs: Date.now() - _reqT0, error: (e && (e.message || e.code)) || 'network-error' }, '');
      if (e.name === 'AbortError') throw e;
      lastErr = e;
      continue;
    }
    dumpLastReq(payload, { kind, model: usedModel, stream: true, attempt, provider: pr.provider, httpStatus: res.status, startedAt: _reqT0, durationMs: Date.now() - _reqT0 });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      dumpFailReq(payload, { kind, model: usedModel, stream: true, attempt, provider: pr.provider, httpStatus: res.status, startedAt: _reqT0, durationMs: Date.now() - _reqT0 }, body);
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        lastErr = mkErr(res.status, body, '', { silent: true });   // 中间失败：留一次重试，先不弹提示
        continue;
      }
      // v6.37：非 429/5xx（含 402/401/403/400）**不再静默抛 mkErr** → 统一走 httpFailure（三态分类 + 广播）
      throw httpFailure(res.status, body, (res.status === 429 || res.status >= 500) ? '（重试后仍失败）' : '', { kind, model: usedModel, stream: true, attempt });
    }

    // —— 解析 SSE ——
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let text = '';
    let reasoning = '';
    let toolCalls = []; // [{id,index,name,args:''}]
    let usage = null;
    let stopped = false;
    let finishReason = '', sawDone = false, evCount = 0;   // 空返回插桩（2026-10-03）：响应侧诊断字段
    // 重复输出护栏：命中即取消流并截断，防止模型在同一回复里复读同一句话成百上千遍
    const guard = makeRepeatGuard();
    // v6.49d：思考流独立护栏——reasoning 与 content 是两股独立增量流（此前只 observe(content)，
    //   导致"思考时一句话反复重复"完全不被拦截）。命中同样取消流（思考退化成死循环时永远产不出正文）。
    const rGuard = makeRepeatGuard();
    let repeated = false;
    let repeatedBy = null;   // 'content' | 'reasoning'（诊断/日志用）
    try {
      outer: while (true) {
        // v6.50（2026-10-04 修复①）：读空闲超时——防上游只 stall 不关连接导致回合永久挂起。
        const _rp = READ_IDLE_MS ? await new Promise((resolve, reject) => {
          const _t = setTimeout(() => reject(Object.assign(new Error('LLM 读空闲超时'), { llmReadIdle: true })), READ_IDLE_MS);
          reader.read().then((v) => { clearTimeout(_t); resolve(v); }, (e) => { clearTimeout(_t); reject(e); });
        }) : await reader.read();
        const { done, value } = _rp;
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const data = s.slice(5).trim();
          if (data === '[DONE]') { sawDone = true; continue; }
          let j;
          try { j = JSON.parse(data); } catch { continue; }
          evCount++;
          if (j.usage) usage = j.usage;
          { const _ch = j.choices && j.choices[0]; if (_ch && _ch.finish_reason) finishReason = String(_ch.finish_reason); }
          const d = j.choices && j.choices[0] ? j.choices[0].delta : null;
          if (!d) continue;
          if (pr.thinkingFormat === 'deepseek' && d.reasoning_content) {
            reasoning += d.reasoning_content;
            if (rGuard.observe(reasoning)) {           // v6.49d：思考流复读护栏（与正文同阈值，独立状态）
              repeated = true; repeatedBy = 'reasoning';
              reasoning = reasoning.slice(0, Math.max(0, rGuard.cut()));
              try { reader.cancel(); } catch { }
              break outer;
            }
            if (cb.onReasoning) cb.onReasoning(d.reasoning_content);
          } else if (pr.thinkingFormat !== 'deepseek' && d.reasoning) {
            // 非 DeepSeek 的 OpenAI 兼容模型偶尔用 reasoning 字段（有则收，多数为 none 不输出）
            reasoning += String(d.reasoning);
            if (rGuard.observe(reasoning)) {           // v6.49d：思考流复读护栏
              repeated = true; repeatedBy = 'reasoning';
              reasoning = reasoning.slice(0, Math.max(0, rGuard.cut()));
              try { reader.cancel(); } catch { }
              break outer;
            }
            if (cb.onReasoning) cb.onReasoning(String(d.reasoning));
          }
          if (d.content) {
            if (ttfbMs < 0) ttfbMs = Date.now() - startedAt;
            text += d.content;
            if (guard.observe(text)) {
              // 退化复读：立即取消流（省 token），文本截断到重复段起点，之后不再转发增量
              repeated = true; repeatedBy = 'content';
              text = text.slice(0, Math.max(0, guard.cut()));
              try { reader.cancel(); } catch { }
              break outer;
            }
            if (cb.onDelta) cb.onDelta(d.content);
          }
          if (d.tool_calls && d.tool_calls.length) {
            for (const tc of d.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', args: '' };
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function) {
                if (tc.function.name) toolCalls[idx].name += tc.function.name;
                if (tc.function.arguments) {
                  toolCalls[idx].args += tc.function.arguments;
                  if (cb.onToolCallDelta) cb.onToolCallDelta({ index: idx, args: tc.function.arguments });
                }
              }
            }
          }
        }
      }
    } catch (e) {
      if (e && e.llmReadIdle) {
        try { reader.cancel(); } catch { }
        logLlmError({ kind, model: usedModel, stream: true, attempt, reason: 'timeout', message: 'read-idle-timeout' });
        if (attempt === 0) { lastErr = e; continue; }
        throw markUnavailable(e, 'timeout', true);
      } else if (e.name === 'AbortError') {
        stopped = true;
      } else {
        throw e;
      }
    }

    const durationMs = Date.now() - startedAt;
    const hit = usage ? (usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0) : 0;
    const miss = usage ? (usage.prompt_cache_miss_tokens ?? usage.prompt_tokens - hit ?? 0) : 0;
    const out = usage ? usage.completion_tokens : 0;
    const usage2 = usage
      ? {
          promptTokens: usage.prompt_tokens,
          hitTokens: hit,
          missTokens: miss,
          outputTokens: out,
          reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
          model: usedModel,   // 实际请求模型（按模型分价计费）
        }
      : null;
    // 统一 usage 审计日志（额外一行，不改 [回合] 日志）；开关 cfg.llmUsageLog 默认 true，false 可回滚。
    if (cfg.llmUsageLog !== false) {
      try { console.log(`[LLM调用 kind=${kind}] hit=${hit} miss=${miss} out=${out}`); } catch { }
    }

    // 任务B：本次 LLM 调用成功 → 广播 ok:true（前端据此自动隐藏横幅）
    emitLlmStatus(true, null, { latencyMs: durationMs, kind });
    return {
      text, reasoning,
      toolCalls: toolCalls.filter(Boolean).map((t) => ({
        id: t.id,
        name: t.name,
        arguments: safeJson(t.args || '{}'),
      })),
      usage: usage2,
      ttfbMs,
      durationMs,
      stopped,
      finishReason, sawDone, evCount, httpStatus: res.status,   // 空返回插桩（2026-10-03）
      repeated,   // 重复输出护栏命中：text 已截断，流已取消（runChat 应重试或收尾）
      repeatedBy, // v6.49d：命中来源 'content'|'reasoning'（诊断）
    };
  }
  const reason = (lastErr && /timeout|timed out|ETIMEDOUT|UND_ERR_CONNECT|headers timeout|body timeout/i.test(String(lastErr.message || lastErr.code || ''))) ? 'timeout' : 'network';
  logLlmError({ kind, model: usedModel, stream: true, attempt: 1, reason, message: (lastErr && (lastErr.message || lastErr.code)) || 'network-error', body: (lastErr && lastErr.cause && lastErr.cause.message) || '' });
  throw markUnavailable(lastErr || new Error('DeepSeek 请求失败'), reason, true);
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}

/** 便宜的评估调用（目标推进判断 / 反思解析用），temperature=0，小 max_tokens。 */
async function chatOnce(messages, { model, maxTokens = 300, signal, temperature = 0, thinking, reasoningEffort, frequencyPenalty, kind = 'unknown' } = {}) {
  const cfg = load();
  const pr = resolve(cfg);
  const key = keyOf(cfg, pr);
  if (!key) throw markUnavailable(new Error(`未配置 API Key：请在 config.json 的 apiKey，或环境变量 ${pr.apiKeyEnv || 'LEIZAI_DEEPSEEK_API_KEY'} 中配置`), 'no-key', false);
  const pen = typeof frequencyPenalty === 'number' && isFinite(frequencyPenalty)
    ? frequencyPenalty
    : (typeof cfg.frequencyPenalty === 'number' && isFinite(cfg.frequencyPenalty) ? cfg.frequencyPenalty : undefined);
  // 集中默认：reasoning_effort 走 resolveEffort（显式 reasoningEffort > ByKind > 全局；disabled / effortSupport='none' → 不发）
  const effort = resolveEffort(cfg, kind, { reasoningEffort }, pr, thinking);
  const _oncePayload = {
    model: model || pr.model,
    messages,
    stream: false,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
    ...(pen !== undefined ? { frequency_penalty: pen } : {}),
    max_tokens: maxTokens,
  };
  let res;
  const _reqT0 = Date.now();
  try {
    res = await fetch(`${pr.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(_oncePayload),
      signal,
    });
  } catch (e) {
    // v6.43：网络/超时失败 → 落盘诊断日志（只记录不改行为；AbortError 亦记录），随后原样抛出
    const _rsn = (e && /timeout|timed out|ETIMEDOUT|UND_ERR_CONNECT|headers timeout|body timeout/i.test(String(e.message || e.code || ''))) ? 'timeout' : 'network';
    logLlmError({ kind, model: model || pr.model, stream: false, attempt: 0, reason: _rsn, message: (e && (e.message || e.code)) || 'network-error', body: (e && e.cause && e.cause.message) || '' });
    dumpLastReq(_oncePayload, { kind, model: model || pr.model, stream: false, attempt: 0, provider: pr.provider, startedAt: _reqT0, durationMs: Date.now() - _reqT0 });
    dumpFailReq(_oncePayload, { kind, model: model || pr.model, stream: false, attempt: 0, provider: pr.provider, startedAt: _reqT0, durationMs: Date.now() - _reqT0, error: (e && (e.message || e.code)) || 'network-error' }, '');
    throw e;
  }
  dumpLastReq(_oncePayload, { kind, model: model || pr.model, stream: false, attempt: 0, provider: pr.provider, httpStatus: res.status, startedAt: _reqT0, durationMs: Date.now() - _reqT0 });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    dumpFailReq(_oncePayload, { kind, model: model || pr.model, stream: false, attempt: 0, provider: pr.provider, httpStatus: res.status, startedAt: _reqT0, durationMs: Date.now() - _reqT0 }, body);
    // v6.37：与非流式一致——所有非 2xx 统一走 httpFailure（三态分类 + 广播），429/5xx 保持可重试语义
    throw httpFailure(res.status, body, '', { kind, model: model || pr.model, stream: false, attempt: 0 });
  }
  const j = await res.json();
  const usage = j.usage || {};
  const hit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const _miss = usage.prompt_cache_miss_tokens ?? (usage.prompt_tokens - hit) ?? 0;
  const _out = usage.completion_tokens ?? 0;
  // 统一 usage 审计日志（额外一行，不改 [回合] 日志）；开关 cfg.llmUsageLog 默认 true。
  if (cfg.llmUsageLog !== false) {
    try { console.log(`[LLM调用 kind=${kind}] hit=${hit} miss=${_miss} out=${_out}`); } catch { }
  }
  emitLlmStatus(true, null, { kind });
  return {
    text: (j.choices?.[0]?.message?.content || '').trim(),
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      hitTokens: hit,
      missTokens: usage.prompt_cache_miss_tokens ?? (usage.prompt_tokens - hit) ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      model: model || pr.model || (pr.defaultModels && pr.defaultModels[0]) || 'deepseek-flash',   // 实际请求模型（按模型分价计费；逐级兜底防空）
    },
  };
}

/** 拉取 DeepSeek 账户余额（/user/balance）。返回原始 JSON，含 balance_infos[]。 */
async function fetchBalance() {
  const cfg = load();
  const pr = resolve(cfg);
  const key = keyOf(cfg, pr);
  if (!key) throw new Error('未配置 API Key');
  const res = await fetch(`${pr.baseURL}/user/balance`, {
    method: 'GET',
    headers: { authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return await res.json();
}

/**
 * 任务B：模型服务探活（GET /models，成本≈0；端点无此路由时回退 1-token chat 探活）。返回 { ok, reason, reasonText, latencyMs, retryable }，**不抛**。
 * 供 GET /api/llm-health 使用（server 侧 30s 缓存，防轮询打爆）。
 */
async function probe(timeoutMs = 8000) {
  const cfg = load();
  const pr = resolve(cfg);
  const key = keyOf(cfg, pr);
  if (!key) return { ok: false, reason: 'no-key', reasonText: llmReasonText('no-key'), latencyMs: 0, retryable: false };
  const t0 = Date.now();
  try {
    const ctrl = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(timeoutMs) : undefined;
    const res = await fetch(`${pr.baseURL}/models`, { method: 'GET', headers: { authorization: `Bearer ${key}` }, signal: ctrl });
    const latencyMs = Date.now() - t0;
    if (res.ok) return { ok: true, reason: null, reasonText: null, latencyMs };
    if (res.status === 404) return await probeViaChat(timeoutMs);   // 兼容端点无 /models
    let reason = 'http' + res.status;
    let retryable = false;
    if (res.status === 401 || res.status === 403) { reason = 'no-key'; }
    else if (res.status === 429) { reason = 'http429'; retryable = true; }
    else if (res.status >= 500) { reason = 'http5xx'; retryable = true; }
    // v6.37：探活也走同一分类 → 402 归 'http402'（此前落 'unknown'，前端理由不明）
    else { const c = classifyHttp(res.status); reason = c.reason; retryable = c.retryable; }
    logLlmError({ kind: 'health', model: pr.model, stream: false, attempt: 0, httpStatus: res.status, reason, message: 'probe /models' });   // v6.43：探活非 2xx 落盘
    return { ok: false, reason, reasonText: llmReasonText(reason), latencyMs, retryable, needsUserAction: isNeedsUserAction(reason), httpStatus: res.status };
  } catch (e) {
    const latencyMs = Date.now() - t0;
    const isTimeout = !!(e && (e.name === 'TimeoutError' || e.name === 'AbortError' || /timeout|timed out/i.test(String(e.message || ''))));
    const reason = isTimeout ? 'timeout' : 'network';
    logLlmError({ kind: 'health', model: pr.model, stream: false, attempt: 0, reason, message: (e && (e.message || e.code)) || 'probe-error' });   // v6.43：探活网络失败落盘
    return { ok: false, reason, reasonText: llmReasonText(reason), latencyMs, retryable: true };
  }
}
/** /models 不可用时的最小成本 chat 探活（max_tokens=1）。 */
async function probeViaChat(timeoutMs) {
  const t0 = Date.now();
  try {
    const ctrl = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(timeoutMs) : undefined;
    await chatOnce([{ role: 'user', content: 'ping' }], { maxTokens: 1, kind: 'health', signal: ctrl });
    return { ok: true, reason: null, reasonText: null, latencyMs: Date.now() - t0 };
  } catch (e) {
    const reason = e && e.llmUnavailable ? e.llmReason : 'unknown';
    // v6.37：探活经 chatOnce → httpFailure 已带三态标记；needsUserAction 一并透出（402/401 不再报 unknown）
    return { ok: false, reason, reasonText: llmReasonText(reason), latencyMs: Date.now() - t0, retryable: !!(e && e.llmUnavailable && e.llmRetryable), needsUserAction: !!(e && e.llmNeedsUserAction) };
  }
}

module.exports = { chatStream, chatOnce, fetchBalance, isContextOverflow, mkErr, makeRepeatGuard, probe, resolveEffort, onLlmStatus, emitLlmStatus, llmReasonText, classifyHttp, isNeedsUserAction, LLM_REASON_TEXT, logLlmError, _redactSecret, _rotateLlmErrLog, LLM_ERR_LOG, dumpLastReq, dumpFailReq, dumpEmptyReq, _dumpSanitize, LLM_LAST_REQ };
