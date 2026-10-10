// A1 前端 · API 封装（T-C1）——同源，无需 CORS
const BASE = ((typeof window !== 'undefined' && window.__LEIZAI_ENV__ && window.__LEIZAI_ENV__.apiBase) || '');

async function jsonReq(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const err = new Error((data && data.error) || ('HTTP ' + r.status));
    err.status = r.status; err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => jsonReq('GET', p),
  post: (p, b) => jsonReq('POST', p, b === undefined ? {} : b),
  put: (p, b) => jsonReq('PUT', p, b === undefined ? {} : b),
  del: (p) => jsonReq('DELETE', p),

  // —— 端点速写（按既定接口规格） ——
  health: () => api.get('/api/health'),
  daemon: () => api.get('/api/daemon'),
  config: () => api.get('/api/config'),
  providers: () => api.get('/api/providers'),   // 控制台·提供商表单：可选 provider 及其 models/baseURL
  saveConfig: (c) => api.put('/api/config', c),
  archiveUsage: () => api.get('/api/archive/usage'),
  stats: () => api.get('/api/stats'),
  sessions: () => api.get('/api/sessions'),
  session: (id) => api.get('/api/sessions/' + id),
  createSession: (t) => api.post('/api/sessions', t || {}),
  sessionStats: (id) => api.get('/api/sessions/' + id + '/stats'),
  // P1 聚合指标（本会话 + 其使用的所有雷影会话）：引擎未就绪时前端优雅降级
  sessionStatsAgg: (id) => api.get('/api/sessions/' + id + '/stats?aggregate=1'),
  sessionLinks: (id) => api.get('/api/sessions/' + id + '/links'),
  sessionRename: (id, title) => api.put('/api/sessions/' + id, { title }),
  // 本会话上下文预算（v1）：整数 token；null/'default' = 跟随全局
  sessionSetBudget: (id, budget) => api.put('/api/sessions/' + id, { contextBudget: budget }),
  sessionTrash: (id) => api.post('/api/sessions/' + id + '/trash', {}),
  sessionRestore: (id) => api.post('/api/sessions/' + id + '/restore', {}),
  sessionDelete: (id) => api.del('/api/sessions/' + id),
  archive: (id, limit, offset) => api.get('/api/sessions/' + id + '/archive?' + qs({ limit, offset })),
  handoff: (id, refine) => api.post('/api/sessions/' + id + '/handoff', { refine: !!refine }),
  evolution: () => api.get('/api/evolution'),
  growth: () => api.get('/api/growth'),
  memory: (kind) => api.get('/api/memory' + (kind ? '?kind=' + kind : '')),
  skills: () => api.get('/api/skills'),
  projects: () => api.get('/api/projects'),
  schedules: () => api.get('/api/schedules'),
  selftrain: (mode) => api.get('/api/selftrain' + (mode ? '?mode=' + mode : '')),
  agents: () => api.get('/api/agents'),
  // 创建雷影（P2）：独立实例名册 / 创建 / Pro 档位（maxRoles·activeRoles）
  agentsInstances: () => api.get('/api/agents/instances'),
  agentsCreate: (roleOrBody) => api.post('/api/agents/create', typeof roleOrBody === 'string' ? { role: roleOrBody } : (roleOrBody || {})),
  // 删除自定义雷影（仅 custom-* 可删；预置角色后端返回 400 preset_protected）
  agentsDelete: (role) => api.post('/api/agents/delete', { role }),
  agentsRoles: () => api.get('/api/agents/roles'),
  // v2：AI 补全（自定义角色）——按名称产出 {domain,temperature} 建议；失败/未就绪由前端降级。
  agentsAutoProfile: (b) => api.post('/api/agents/auto-profile', b || {}),
  // AI 生成专属图标（端点由后端提供；未就绪/失败 → 前端降级 generic）：入参 {name,domain}，返回 {ok,icon?}（icon=SVG 串或 URL）
  agentsIcon: (b) => api.post('/api/agents/icon', b || {}),
  agentsCommonConfig: () => api.get('/api/agents/common-config'),   // 雷影通用设置：读（apiKey 掩码）
  saveAgentsCommonConfig: (b) => api.post('/api/agents/common-config', b),   // 雷影通用设置：写（一处改全雷影）
  proStatus: () => api.get('/api/pro/status'),
  stop: (id) => api.post('/api/stop', { sessionId: id }),   // v6.22：显式停止该会话当前回合（不再只靠浏览器 abort）
  balance: () => api.get('/api/balance'),
  costToday: (refresh) => api.get('/api/cost/today' + (refresh ? '?refresh=1' : '')),   // 今日 0 点起·全家四实例合计审计成本
  llmHealth: (refresh) => api.get('/api/llm-health' + (refresh ? '?refresh=1' : '')),   // 任务B：模型服务探活（服务端 30s 缓存）
  eventsHistory: (limit) => api.get('/api/events/history' + (limit ? '?limit=' + limit : '')),
  // v6.53 涟漪流含雷影：聚合事件流（主我+关联雷影，引擎已按 at 排序并去重）；端点未就绪时前端降级用本地事件
  eventsAggregate: (sid) => api.get('/api/events/aggregate' + (sid ? '?sessionId=' + encodeURIComponent(sid) : '')),
  // 新端点（T-A2/A3/A4/A5）
  mailbox: (role, unread, limit) => api.get('/api/mailbox?' + qs({ role, unread, limit })),
  mailboxSummary: () => api.get('/api/mailbox/summary'),
  mailboxSend: (b) => api.post('/api/mailbox/send', b),
  // 通讯中心（v6 阶段3）：逾期/死信队列 + 重投（端点未就绪时前端需优雅降级）
  mailboxQueue: (status, limit) => api.get('/api/mailbox/queue?' + qs({ status, limit })),
  mailboxRetry: (id) => api.post('/api/mailbox/retry', { id }),
  // P2b-3（美工）：信箱全量流水（含已闭环）——任务脊/通讯中心下钻数据源，纯读无副作用。
  // 返回 { count, entries:[{id,from_id,to_id,type,ts,status,wake_intent,delivered,preview,topic}], available }。
  mailboxFlow: (o) => api.get('/api/mailbox/flow?' + qs(o || {})),
  // 询问选项框（美工）：回答 / 未答恢复
  askAnswer: (b) => api.post('/api/ask/answer', b),
  askPending: (sessionId) => api.get('/api/ask/pending?' + qs({ sessionId })),
  self: (task) => api.get('/api/self' + (task ? '?task=' + encodeURIComponent(task) : '')),
  // 会话树泳道图（美工）：主轴 + 分枝 + 梢事件。后端未就绪时前端优雅降级为空态
  sessionTree: (id, keepTurns) => api.get('/api/sessions/' + encodeURIComponent(id) + '/tree' + (keepTurns ? '?keepTurns=' + keepTurns : '')),
};

function qs(o) {
  const p = [];
  for (const k in o) if (o[k] !== undefined && o[k] !== null && o[k] !== '') p.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k]));
  return p.join('&');
}
