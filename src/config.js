'use strict';
// 雷仔 · 配置加载与保存
const fs = require('node:fs');
const path = require('node:path');

const P = require('./paths');                      // P1 布局方案A：数据路径单一权威
const ROOT = path.resolve(__dirname, '..');        // 代码目录（只读二进制所在），非数据根
/** 配置文件路径：环境变量 `LEIZAI_CONFIG_PATH` 优先（供测试隔离，指向临时 config）；
 *  未设置则用数据根下的 config.json（paths.configPath()）。每次解析 → 即便 require 后设 env 也能生效。 */
function configPath() {
  const p = process.env.LEIZAI_CONFIG_PATH;
  return p ? path.resolve(p) : P.configPath();
}
const CONFIG_PATH = configPath();   // 初始快照（兼容旧引用）；实际读写一律走 configPath()

/** 公共配置层路径：环境变量 `LEIZAI_CONFIG_COMMON_PATH` 优先；未设置则用 `<ROOT>/config.common.json`。
 *  公共键（非 INSTANCE_KEYS）集中于此，作为唯一来源；实例 config.json 只留专属键。 */
const COMMON_PATH = process.env.LEIZAI_CONFIG_COMMON_PATH || P.commonPath();
/** 实例专属键白名单：这些键留在实例 config.json，其余键一律进公共层 config.common.json。 */
const INSTANCE_KEYS = new Set(['agent', 'port', 'workdir', 'dataDir', 'temperature', 'contextBudget']);

const DEFAULTS = {
  port: 3457,
  host: '127.0.0.1',
  workdir: path.join(ROOT, 'workspace'),
  // 意识数据目录（可迁移）：默认为 ROOT/data，但可被 config.json 的 dataDir 或环境变量
  // LEIZAI_DATA_DIR 覆盖。设为独立目录后，代码(ROOT)与意识(data)解耦——迁移/换机器/变强时
  // 只需把 data 目录搬到新位置并设 dataDir，代码不用动、意识一条不丢。
  dataDir: path.join(ROOT, 'data'),
  apiKey: '',
  // 按 provider 分别存 API Key（如 { deepseek:'sk-...', qwen:'sk-...' }），切换 provider 时各自的 key 互不覆盖
  apiKeys: {},
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  models: ['deepseek-flash', 'deepseek-v4-pro'],
  temperature: 0.3,
  // 防复读基线：frequency_penalty（0~2；0=不发送，保持旧行为）。模型陷入复读死循环时引擎会临时抬高重试。
  frequencyPenalty: 0,
  reasoningEffort: 'low',
  // 集中默认层（2026-09-22）：按调用 kind 覆盖 reasoning_effort（默认空=不覆盖→继承全局 reasoningEffort）。
  //   例：{"reflect":"medium","subagent":"low"}；清空即恢复全局。'off'=不发。
  reasoningEffortByKind: {},
  maxTokens: 16384,
  // 迭代账目提示（2026-09-22）：工具循环达阈值时在工具结果末尾追加"已第 N 次调用"提示，助模型自查收敛。
  //   iterHintThreshold：首次触发阈值（默认 8；≤0=关闭，完全等价旧版）；iterHintRepeat：之后每 N 次再提示（默认 4）。
  iterHintThreshold: 8,
  iterHintRepeat: 4,
  contextBudget: 200000,   // 默认上下文预算：20 万 token（200000）——产品与新建雷影的统一默认；世代交接模式下窗口自动管理（用满即交接），无需为长任务手动调大
  // —— 开机视频片头（v6.52，装饰性：任何失败静默降级回 CSS splash，绝不拖死外壳）——
  bootVideoEnabled: true,          // 总开关
  bootVideoPath: '/assets/boot.mp4', // 【兼容保留】旧单段路径；作为 intro 的回退值
  bootVideoPathIntro: '/assets/boot_intro.mp4', // 开场片头（播一次）；显式优先于旧 bootVideoPath
  bootVideoPathLoop: '/assets/boot_loop.mp4',   // 循环加载动画（intro 结束后无限循环，直到引擎就绪）
  bootVideoPolicy: 'session',      // 'session'（每页面会话一次）| 'always' | 'once'（永久一次）
  bootVideoFit: 'cover',           // 'cover'（铺满裁切）| 'contain'（完整留边）
  iterationCap: 24,
  // 原名自治目标轮数上限；自治目标已移除，现仅用于信箱待办自动续跑上限
  goalMaxRounds: 40,
  subAgentMaxTurns: 8,
  commandTimeoutMs: 120000,
  commandOutputCap: 60000,
  // —— 工具结果瘦身（窗口增长主因；2026-09-14 实测：消息部分工具结果占 77%）——
  // 单条工具结果内联上限（字符）：超限 → 活跃上下文只留头尾，全文即时入归档（recall_context 可调回）。
  // 默认 3000（原硬编码 16000）：该内容写一次后永不改写，属"新 token"，无缓存成本，纯赚。
  toolInlineMaxChars: 3000,
  // 工具结果老化：窗口逼近预算时，把"最近 toolResultKeepK 条"之外的旧工具结果替换为 stub（全文入归档）。
  toolResultAge: true,        // 总开关（false → 行为与旧版完全一致，可一键回滚）
  memIndexExcludeArchive: true, // F1 残留修复：分代归档合并文件（*-archive.md）不进检索索引（防污染 IDF）
  toolResultKeepK: 10,        // 保留最近多少条工具结果不老化
  toolAgeThresholdPct: 60,    // 触发阈值：usedTokens > 预算 × 该百分比 时才老化
  // E⁺（批2·P1）：历史回合"写完类工具"参数精简（write_file/save_skill/edit_file 的 content/code 截为占位符）
  toolArgsAge: true,          // 总开关（false → 行为与旧版完全一致，可一键回滚）
  toolArgsAgeThreshold: 0.75, // 触发阈值（比例）：usedTokens > 预算 × 该值 才触发一次（遵"改历史=击穿缓存"纪律）
  // v6.22："刚被用户停止"后的自动唤醒抑制窗口（ms）——防止停止后信箱续跑立刻复活（表现为停不掉）。0=关闭抑制。
  postStopSuppressMs: 3000,
  // —— 归档检索与记忆衔接 v3.1（批1·P0；每层独立开关，默认开，可一键回退旧行为）——
  // F1：压缩摘要分代有界 —— 记忆名用「会话 id + 代数」，每会话只留最近 K 代为独立记忆，更旧代合并进 -archive 条。
  compressSummaryBounded: true,
  compressSummaryKeepK: 5,        // 每会话保留最近多少代独立压缩摘要
  compressSummaryArchiveCap: 200000, // -archive 条正文上限（字符，超出保留尾部）——防有界机制自身再膨胀
  // C：归档 recall_context 零命中/低置信 → memory_miss_log.jsonl（kind='archive'）
  archiveMissLog: true,
  archiveMissLowConf: 0.5,        // 低置信阈值（top score < 该值 → 记 low-confidence）
  // C⁺：归档检索默认只查对话层（role!='tool'）；bigram 轻量打分
  archiveKindFilter: true,
  archiveBigramScore: true,
  archiveToolFallback: true,      // 对话层零命中时回退证据层（保旧召回率；"真 miss"才记账）
  // A（批2·P1）：归档 FTS5(bigram) 检索层 —— archive 表加 bi 固化列（应用层算 bigram），FTS5 external-content，
  // trigger 只 copy 列（禁调 JS 函数）；查询走 JOIN archive + session_id 隔离；异常回退 LIKE。
  archiveFts: true,               // 总开关（无 FTS5 表/异常时自动回退 LIKE，不阻断）
  // D1（批2·P1）：统一检索入口（recall_context 一次查 memory+archive+doc，RRF 融合 k=60，标注来源）
  recallUnified: true,            // 总开关（false → recall_context 行为与旧版完全一致）
  // D2（批2·P2）：交接时回填"归档纪要-<会话id>-gen<N>"记忆（主题地图 + 关键增量）
  archiveMemoBackfill: true,      // 总开关（false → 不写记忆，回退现状）
  archiveMemoKeepK: 3,            // 每会话保留最近 K 代独立记忆，更旧代并入 -archive（有界）
  archiveMemoCap: 200000,         // -archive 合并条字符上限（有界，防无界累积）
  // B：交接文档生成「本代归档主题地图」+ 双落点（_handoff.md + _progress.md「归档目录」区，滚动保留最近 K 代）
  handoffArchiveTopic: true,
  handoffTopicKeepK: 5,
  handoffTopicCap: 1200,          // 主题地图文本上限（字符）
  // F2：交接文档增加「本代记忆增量」段（本代新写/更新的记忆名 + 一句话）
  handoffMemoryIncrement: true,
  handoffMemIncCap: 1200,
  commandPolicy: 'auto',
  evolutionAutoApply: true,
  reflectionEnabled: true,
  reflectionAuto: true,
  // 「雷影协同」总开关：控制"自动领域分流"机制（分流/会诊/灰区提示整链）。
  //   true(默认)=开启；false=引擎不再注入任何领域分流块，且早于读 agents 表（省开销）。缺失视为 true。
  roleDispatchEnabled: true,
  webFetchMaxBytes: 1048576,
  // 真正的智能体模式：文件工具不限目录、危险命令不拦截、SSRF 防护关闭（默认为最大权限）
  fullAccess: true,
  // —— 多模型 / Provider 抽象（对齐 Prime Agent）：默认 deepseek，其余见 src/providers.js ——
  provider: 'deepseek',
  // 推理内容解析格式：deepseek 读 delta.reasoning_content；none 不解析（某些 OpenAI 兼容模型不流式输出）
  thinkingFormat: undefined,
  // —— 细粒度权限（对齐 Prime Agent 的 allowlist / protected-paths / 危险命令扩展，默认全空 = 不改变现有行为）——
  allowedPaths: [],     // !fullAccess 时额外允许的路径（默认工作目录之外的）
  protectedPaths: [],   // 即使 fullAccess 也禁止写入的路径（读不受限）
  protectedCommands: [],// 即使 fullAccess 也拦截的命令（正则串，逐个 test）
  // —— MCP 服务器（stdio 传输）：[{name, command, args[], env{}}]，供 mcp_list_tools / mcp_call 调用 ——
  mcpServers: [],
  // —— 守护进程模式（daemon): true 时后端作为独立后台运行，客户端关闭窗口后继续存活（可 attach/detach） ——
  daemonMode: false,
  // —— 进化质量门禁（对齐 Prime Agent 的 deterministic quality gates）：非空的 shell 命令；approved 前须退出码为 0 ——
  evolutionGate: '',
  // —— 不可变基因组（对齐 Prime Agent 的"base system prompt 不可变"）：true 时 system.md 不再被进化，
  //    提案自动重定向到补充态 harness.md；false（默认）保持现状直接演进 system.md ——
  immutableGenome: false,
  // Python 持久 REPL 内核：解释器可执行文件（未安装/不可用则 python_repl 报错提示）
  pythonPath: 'python',
  replTimeoutMs: 60000,
  // 可执行技能 main.py 的执行超时
  skillTimeoutMs: 30000,
  // —— 统一信箱（通讯方案 v5 · 共享 SQLite 库）——
  agentSharedDb: null,        // 共享信箱库路径（默认 <dataDir>/agents_shared.db；4 实例必须一致）
  // —— 项目文件总库（非文本产物落点）+ 项目名册 DB ——
  projectFilesRoot: null,     // 总库根目录（默认 <ROOT>/项目文件；4 实例应一致，配置里建议写绝对路径）
  projectRegistryDb: null,    // 项目名册库路径（默认 <dataDir>/projects_shared.db；4 实例必须一致）
  mailboxEnabled: true,       // 总开关（false → 全局回退旧 jsonl 信箱）
  mailboxInjectUnread: true,  // 回合起始"未读注入"开关（可即时关闭）
  mailboxAutoResume: true,    // 实例内续跑开关
  mailboxAutoReply: true,     // 回合结束自动把最终答复作为回执发回发送方（type='reply'，防回环；可即时关停）
  mailboxSilentReply: true,   // 回执(type='reply')静默投递（只落库不唤醒接收方）；false 时回执也唤醒
  mailboxSilentTypes: ['reply', 'ack', 'notify'],   // 静默投递的消息类型（只落库不唤醒）；仅 task 等动作类唤醒
  mailboxCoalesceMs: 800,     // 唤醒合并窗口(ms)：同一目标窗口内多条消息只投递一次(一次唤醒)；0=禁用(立即投递=旧行为)
  mailboxSilentForMain: true, // 发给主实例(is_main)的消息一律静默投递(只落库不唤醒)；主我靠未读注入读到，避免阻塞用户交互与连锁
  mailboxDispatcherForMain: false,   // v5.7→方案C(2026-09-12)：关闭"调度会话"机制；发给主实例的消息不再唤醒调度会话（保留 mailboxSilentForMain 静默落库，回归"回合起始未读注入"路径）
  mailboxInstantWake: true,    // v6.1：空闲即唤醒——雷影消息到达且目标会话空闲(running=false)时，立即触发一次内部回合处理（不打断=忙时不动）
  mailboxAutoResumeOnIdle: true, // v6.1：忙时排队续跑——当前回合正常结束且仍有信箱待办(未被本轮消费) → 自动续跑一轮（上限 goalMaxRounds）
  ledgerReadOnly: false, // 2026-09-19 P3·账本退役：true 时 log_progress **跳过 _progress.md 写入**（_progress.md 降为只读归档；支干 branch.append 照旧）；默认 false，可回滚
  mailboxResumeExcludeProcessing: true, // 2026-09-19 根因#3：续跑"待办"口径排除 status∈processing/done/failed/stale（防同一 task 被反复续跑注入重放）；置 false 回退旧口径
  mailboxStateMachine: false, // P1（2026-09-29 R1 重构）：消息生命周期单一状态机（state 列 + advance 唯一转换入口）。默认 false=灰度双写（新 state 与旧 status 并行写、读侧仍用旧列）；true=状态机权威。可回滚。
  wirePassReasoning: true, // v6.45：deepseek thinking 模式下 toWire 回传 assistant.reasoning_content（缺失时置空串兜底）→ 修 HTTP 400 "reasoning_content must be passed back"。false=不回传（回退旧行为，供 A/B）。
  mailboxAutoResumeOnUnread: true, // v6.9 方案A：回合正常结束后，若本会话在"本轮开始后"仍有新到达的未读（含 reply）→ 自动续跑一轮（防忙时到达的回执漏收；上限 MAILBOX_UNREAD_RESUME_MAX=3）
  mailboxWakeOnlyActionable: true, // v6.26 方案A：唤醒侧类型过滤——wakeMailbox/idleUnreadReady 仅按"动作类"(task 等)判定是否唤醒/续跑；reply/ack/notify 只落库+上屏+回合起始注入，不驱动新回合（根治"未读续跑"放大）。false 回退旧行为（reply 亦可唤醒）
  mailboxWakeRateMax: 3,           // v6.26 方案B：每会话自动唤醒速率窗内最大次数（兜底，防密集 reply 触发反复自我续跑）；0=不限
  mailboxWakeRateWindowMs: 60000,  // v6.26 方案B：自动唤醒速率窗长度(ms)
  mailboxShowInbound: true,    // v6.1：入站雷影消息实时上屏（会话窗口显示带头像气泡，正文不写入 messages 历史）
  mailboxShowOutbound: true,   // v6.53：主我出站派活实时上屏/涟漪流（outbound mailbox-message）
  dispatcherMaxIterations: 8,       // 调度会话单轮工具迭代上限（防自主行动连锁）
  mailboxInjectCap: 8000,     // 未读注入总量字符封顶（仅注入侧截断，库内保全文）
  mailboxPriorityWake: true,  // v6阶段2：priority 分级唤醒（urgent 突破静默立即唤醒；high 缩短合并窗口）；false=完全回退现状
  mailboxHighCoalesceMs: 200, // v6阶段2：priority=high 的唤醒合并窗口(ms)，取 min(mailboxCoalesceMs, 此值)
  mailboxStaleTaskMs: 1800000,// v6阶段3：task 超时(ms)未回 → 标 status='stale'（默认 30min，与 STALE_TASK_MS 对齐）
  mailboxRetentionDays: 30,   // GAP-2：retention 冷表——已闭环 task 及其 result 超此天数 → 移入 agent_messages_archive + 主表删（未闭环永不自动清）
  mailboxRetentionEnabled: true, // GAP-2：retention 归档周期任务开关（仅主引擎执行）
  mailboxAwaitingCloseNudgeMs: 600000, // P0(c)：awaiting_close（已交付未收口）超此 ms 未收口 → 催发起方一次（默认 10min）
  mailboxMaxAttempts: 3,      // v6阶段3：投递失败达此次数 → status='failed'（死信）
  mailboxBusyTtlMs: 300000,  // v6.4：busy 真实回合状态——busy_at 新鲜度上限(ms)，超此视为陈旧（防崩溃卡死）
  mailboxBusyInboundMs: 15000,// v6.4：busy 兜底——老版本对端未上报 busy_session 时，最近入站(role→本会话)新鲜窗口(ms)
  turnWatchdogMs: 180000,      // v6.6：回合看门狗(ms)——超此无活动即中止本轮；0=关
  turnHardCapMs: 600000,       // v6.7：回合硬上限(ms)——running 超此强制释放(卡死收割)；缺省 max(watchdog*3,600000)
  toolHardTimeoutMs: 300000,   // v6.24：单次工具执行硬超时(ms)——超时即返回"工具超时"错误结果给模型，杜绝任何工具把整个回合挂死；0=关
  turnReaperEnabled: true,     // v6.7：卡死回合收割器开关(入口判定 + 每60s周期扫描)
  mailboxWakeMaxIter: 6,       // v6.6：信箱唤醒/交接后回合的工具迭代上限；0=不限额
  mailboxLazyStart: true,      // v6.7：发消息时若对端未启动→按需拉起（惰性启动）；false=不探活不拉起（只落库，完全回退）
  mailboxLazyStartTimeoutMs: 8000, // v6.7：惰性拉起后探活轮询上限(ms)
  mailboxAutoReviveAgents: true, // v6.8：主引擎启动后自动恢复雷影（探活 agents 表 enabled 非-main role，不活则 ensureAgentUp）；false=不恢复
  mailboxAutoRedeliver: true,    // v6.8：投递失败自动重投（扫 delivered=0 的 pending，复用 deliver 重投）；false=不重投
  mailboxRedeliverIntervalMs: 60000, // v6.8：自动重投周期(ms)
  mailboxRedeliverMaxAttempts: 8,    // v6.8：自动重投累计失败达此次数 → status='failed'（死信）
  agent: null,                // 各实例在此填 {role,name,domain,baseUrl,isMain}
  prices: { cachedPerM: 0.02, missedPerM: 1, outputPerM: 4 },
  // 人民币计价：汇率（RMB/USD）与账户余额（人民币）
  usdRate: 7.2,
  accountBalance: 0,
  // 会话归档容量（"流水"条目上限）：超过后自动淘汰最旧条目（重要内容早已在记忆/进度文件，故淘汰安全）。
  // 0 = 不限条数（默认）；与 archiveMaxSizeMB 可同时生效，都设 0 则完全不裁剪。
  archiveMaxEntries: 0,
  // **单会话**归档容量上限（MB）：按本会话 SUM(length(content)+length(bi)) 估算，每会话独立判定。
  // 命中后删本会话最旧 flow 回 80% 低水位，并 PRAGMA incremental_vacuum 回收磁盘（doc 永不裁剪、他会话不受影响）。
  // 0 = 不限制；默认 2048 = 2GB/会话。
  archiveMaxSizeMB: 2048,
  archiveCapacityGuard: true,   // 容量兜底总开关（false → 完全回退旧行为）
  archivePruneScope: 'session', // 保留键（容量清理**恒为本会话**，此项已不再影响容量逻辑）
  archiveMinSizeMB: 50,         // 容量安全下限（MB）：archiveMaxSizeMB 若 >0 但 < 此值 → 只 WARN 不删（防误把上限改成极小值导致误删）
  archiveAllowTinyCap: false,   // 显式放行低于安全下限的容量上限（仅测试/特殊场景）。true 才允许 <archiveMinSizeMB 的清理
  // —— 世界树「支干」事件库（P0）——
  branchEnabled: true,          // 支干事件库开关：每轮写 turn 骨架 + 事件（双写、附加式；库不可用优雅回退，不影响主流程）
  branchHandoffPrimary: false,  // 批B：交接主路径开关。false（默认）=走文档版 buildHandoffDocSync（兜底，行为同改前）；true=走树版 buildHandoffDocFromBranch（由主我拍板翻）
  branchAutoAssign: { enabled: false, minHits: 2, samplesPerBranch: 50 },   // A1'：逐轮自动归枝（词表匹配）。**2026-09-29 停用**：实测 28.5%≈多数类基线(20.9%)，与 branchReflow 一并退场；改走「派单驱动归枝」
  branchReflow: { enabled: false, minScore: 0, knnK: 10, clusterSim: 0.34, capRatio: 0.4 },   // A1''：整代批量重整（**2026-09-29 停用**——实测≈多数类基线、标准答案主观，自动归枝退场，改走「派单驱动归枝」；代码与 topic_source/undo 基建保留）
  roleBoundaryGuard: 'enforce', // 批3：职责边界护栏档位 off=关 / nudge=只提醒不抛错 / enforce=写工具硬拦（默认）。工具调用传 _confirm:true 可单次放行
  // —— 唤醒盲区根治（回合收尾复查未读 + 静默投递通知目标实例）——
  mailboxSilentNotify: true,    // 静默投递(reply/ack/notify 或发往 main)也向目标实例发 /api/mailbox/event（不限 main；空闲即唤醒，忙则排队）
  mailboxIdleUnreadSweep: true, // 回合收尾复查未读：空闲且有未读 → 唤醒一次（堵"回合已结束、下回合未开始"的间隙投递盲区）
  mailboxIdleSweepDelaysMs: [0, 5000, 30000],  // 复查时机（毫秒）；有界重试，幂等无空转
  mailboxStaleInboundWake: true,       // v6.53：知情类回执(reply/ack/notify)空闲兜底唤醒——超阈值未读且会话空闲 → 兜底唤醒一次（治漏收回执）；false 关
  mailboxStaleInboundWakeMs: 45000,    // v6.53：上述兜底的"停留阈值"(ms)：入站未读超过该时长才兜底唤醒。须 < mailboxSilentReadMinAgeMs(60000) 保证兜底先于静默标读（v6.53a）
  // —— Pro 分档门禁（soft-gate）——见 src/pro/gate.js。★P0-1 安全默认：devAllowAll=false（无 license → Lite）。
  //    开发实例若要放行，须在 config.common.json / config.json 显式写 "pro":{"devAllowAll":true} 或用 env LEIZAI_PRO_DEV=1。
  pro: { devAllowAll: false, enforce: false, serverUrl: 'https://api.leizai.cc', licenseKey: '', deviceId: '', proModule: '' },
};

/** 安全读 JSON：读文件→剥前导 BOM→JSON.parse。
 *  ENOENT 静默返回 null；解析错打印 WARN 返回 null。用于公共层/实例层统一读取。 */
function readJsonSafe(p) {
  try {
    let txt = fs.readFileSync(p, 'utf8');
    if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
    return JSON.parse(txt);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    console.error(`[WARN] ${p} 解析失败，已忽略该层（可能原因：文件被编辑出错或带 BOM）。原始错误: ${e.message}`);
    console.error(`[WARN] 请检查 ${p} 是否为合法 JSON（不要带 BOM）。`);
    return null;
  }
}

// —————— 模型三件套继承层（2026-10-07） ——————
// 非 main 实例（雷影）：provider/model/apiKey/apiKeys 若未在「自身层」（自身 config.common.json / config.json）
//   显式定义 → 运行时取【主引擎】config.common.json 的同名值；显式定义 → 用自身。
// 安全：仅这三键；不可读/未注册 → 降级为不继承（绝不抛错）；mtime 缓存避免每次重读。
const INHERIT_KEYS = ['provider', 'model', 'apiKey', 'apiKeys', 'baseURL', 'models', 'reasoningEffort', 'reflectionEnabled', 'evolutionAutoApply'];
function _isMainCfg(cfg) { return !(cfg && cfg.agent && cfg.agent.isMain === false); }
function _readJsonSilent(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
let _mainDirCache = { dbPath: null, dbMtime: 0, dir: null };
/** 定位主引擎数据根：LEIZAI_MAIN_DATA_DIR 覆盖 > agents 表 main 行 data_dir（mtime 缓存）。失败返回 null。 */
function _mainDataDir(agentSharedDb) {
  if (process.env.LEIZAI_MAIN_DATA_DIR) return process.env.LEIZAI_MAIN_DATA_DIR;
  if (!agentSharedDb) return null;
  // ★兜底（雷影 no-key 根因）：三共享键的 agents_shared.db 必位于**主 data 根**下 → dirname 即主 data 根。
  //   与 srcdrift.mainDataRoot 同法。用于"主未入 agents 表 / 库暂不可读"时仍能定位主 data（继承链不断）。
  const fallback = (() => { try { return path.dirname(path.resolve(agentSharedDb)); } catch { return null; } })();
  try {
    const st = fs.statSync(agentSharedDb);
    if (_mainDirCache.dbPath === agentSharedDb && _mainDirCache.dbMtime === st.mtimeMs) return _mainDirCache.dir || fallback;
    let dir = null;
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(agentSharedDb, { readOnly: true });
      const row = db.prepare("SELECT data_dir FROM agents WHERE role='main' LIMIT 1").get();
      db.close();
      if (row && row.data_dir) dir = row.data_dir;
    } catch { dir = null; }
    if (!dir) dir = fallback;
    _mainDirCache = { dbPath: agentSharedDb, dbMtime: st.mtimeMs, dir };
    return dir;
  } catch { return fallback; }
}
let _mainCommonCache = { path: null, mtime: 0, data: null };
/** 读主引擎 config.common.json（mtime 缓存）。不可读返回 null。 */
function _readMainCommon(agentSharedDb) {
  const dir = _mainDataDir(agentSharedDb);
  if (!dir) return null;
  const p = path.join(dir, 'config.common.json');
  try {
    const st = fs.statSync(p);
    if (_mainCommonCache.path === p && _mainCommonCache.mtime === st.mtimeMs) return _mainCommonCache.data;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    _mainCommonCache = { path: p, mtime: st.mtimeMs, data };
    return data;
  } catch { return null; }
}
let _mainInstCache = { path: null, mtime: 0, data: null };
/** 读主引擎实例层 config.json（mtime 缓存）。不可读返回 null。 */
function _readMainInstance(agentSharedDb) {
  const dir = _mainDataDir(agentSharedDb);
  if (!dir) return null;
  const p = path.join(dir, 'config.json');
  try {
    const st = fs.statSync(p);
    if (_mainInstCache.path === p && _mainInstCache.mtime === st.mtimeMs) return _mainInstCache.data;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    _mainInstCache = { path: p, mtime: st.mtimeMs, data };
    return data;
  } catch { return null; }
}
/** 应用继承：仅非 main、仅自身层缺失时取主引擎值；apiKeys 主为底、自身覆盖；contextBudget 取主引擎实例层（次选 common）。 */
function applyModelInheritance(base, common, inst) {
  if (_isMainCfg(base)) return;
  const main = _readMainCommon(base.agentSharedDb);
  if (!main) return;
  const ownHas = (k) => !!((common && Object.prototype.hasOwnProperty.call(common, k)) || (inst && Object.prototype.hasOwnProperty.call(inst, k)));
  for (const k of ['provider', 'model', 'apiKey', 'baseURL', 'models', 'reasoningEffort', 'reflectionEnabled', 'evolutionAutoApply']) {
    if (!ownHas(k) && main[k] !== undefined) base[k] = main[k];
  }
  if (main.apiKeys && typeof main.apiKeys === 'object') base.apiKeys = { ...main.apiKeys, ...(ownHas('apiKeys') ? (base.apiKeys || {}) : {}) };
  // contextBudget 属实例层：自身未显式设 → 取主引擎实例层（次选主引擎 common）
  if (!ownHas('contextBudget')) {
    const mi = _readMainInstance(base.agentSharedDb);
    const v = (mi && mi.contextBudget !== undefined) ? mi.contextBudget : main.contextBudget;
    if (v !== undefined) base.contextBudget = v;
  }
}
function load() {
  let base = { ...DEFAULTS };
  // 合并顺序：DEFAULTS ← config.common.json（公共层） ← 实例 config.json ← 环境变量。
  // 公共层不存在时行为与旧版完全一致（仅实例层）。
  const common = readJsonSafe(COMMON_PATH);
  if (common) base = { ...base, ...common };
  const inst = readJsonSafe(configPath());
  if (inst) base = { ...base, ...inst, prices: { ...DEFAULTS.prices, ...(inst.prices || {}), ...((common && common.prices) || {}) } };
  // 环境变量优先（不落盘，避免明文密钥到处复制）
  if (process.env.LEIZAI_DEEPSEEK_API_KEY) base.apiKey = process.env.LEIZAI_DEEPSEEK_API_KEY;
  // 意识数据目录：环境变量 LEIZAI_DATA_DIR > config.dataDir > 默认 ROOT/data
  // 关键：意识(data)与代码(ROOT)解耦，迁移时只搬 data + 设 dataDir，代码不用改
  if (process.env.LEIZAI_DATA_DIR) base.dataDir = process.env.LEIZAI_DATA_DIR;
  if (!base.dataDir) base.dataDir = DEFAULTS.dataDir;
  // 统一信箱库路径默认派生自 dataDir（便于迁移：data 搬家后库自动跟随）
  if (!base.agentSharedDb) base.agentSharedDb = path.join(path.resolve(base.dataDir), 'agents_shared.db');
  // 项目文件总库根：默认 <ROOT>/项目文件（可用 config.projectFilesRoot 绝对路径覆盖）
  if (!base.projectFilesRoot) base.projectFilesRoot = path.join(ROOT, '项目文件');
  // 项目名册库：默认跟随 dataDir（可用 config.projectRegistryDb 绝对路径覆盖）
  if (!base.projectRegistryDb) base.projectRegistryDb = path.join(path.resolve(base.dataDir), 'projects_shared.db');
  // Pro 分档：确保 pro 段存在（默认取 DEFAULTS.pro；缺 key 补齐，绝不 throw）。C 端可覆盖 licenseKey 等。
  if (!base.pro || typeof base.pro !== 'object') base.pro = {};
  base.pro = { ...DEFAULTS.pro, ...base.pro };
  applyModelInheritance(base, common, inst);
  return base;
}

// ———————— 配置写入防呆：mojibake / 非 UTF-8 内容检测（2026-09-22）————————
// 背景：以 GB2312/Win PS5.1 提交含中文 JSON body，服务端按 UTF-8 解析 → 值被写成乱码（如 "??\uFFFD??"）。
// 策略：**命中特征即判可疑**（宁可漏拦，绝不误伤正常 UTF-8 中文）。只在"字段值整串仅由 ? / \uFFFD / 空白组成"
//   或出现替换符 \uFFFD / 典型 GBK-UTF8 双解序列时才拦。
const MOJIBAKE_REPLACEMENT = /\uFFFD/;                       // 解码失败替换符（最硬信号）
const MOJIBAKE_SEQ = /锟斤拷|锟斤|鐎|鍜|鎴|娴|鍚|鏄|鐨|绱|锛|鑻|鍑|鏂/;   // GBK/UTF-8 双解常见串
const MOJIBAKE_FIELD = /"(?:name|domain|title|project|provider|model|role)"\s*:\s*"[?\uFFFD\s]+"/;  // 值整串=问号/替换符/空白
const MOJIBAKE_RUNQ = /\?{3,}/;   // 值内连续 ≥3 个问号（实测全部真实 config 命中数=0，安全）——覆盖 `<项目根>\????` 这类

/** 判断文本是否疑似 mojibake / 非 UTF-8 写入。@returns {boolean} true=可疑，应拒绝写入 */
function looksMojibake(text) {
  const s = String(text == null ? '' : text);
  if (!s) return false;
  try {
    if (MOJIBAKE_REPLACEMENT.test(s)) return true;
    if (MOJIBAKE_SEQ.test(s)) return true;
    if (MOJIBAKE_FIELD.test(s)) return true;
    if (MOJIBAKE_RUNQ.test(s)) return true;
  } catch { return false; }
  return false;
}

function save(cfg) {
  cfg = { ...cfg };
  // 响应给前端前不落盘的环境变量密钥
  if (process.env.LEIZAI_DEEPSEEK_API_KEY) delete cfg.apiKey;
  // 拆分写：专属键(INSTANCE_KEYS) → 实例 config.json；其余 → 公共层 config.common.json。
  const inst = {}, common = {};
  for (const [k, v] of Object.entries(cfg)) (INSTANCE_KEYS.has(k) ? inst : common)[k] = v;
  // 公共层合并写：保留 common 里已有的、非本次提交的键（避免前端只提交部分时丢键）。
  const cur = readJsonSafe(COMMON_PATH) || {};
  // 继承层防"物化回写"（2026-10-07）：provider/model/apiKey/apiKeys 若当前自身层未显式持有，
  //   则其值来自继承（load()）——save() 不得把继承值写成显式值（否则继承永久失效）。
  // 【P0 修复 2026-10-09·全新安装无法保存 API Key】仅非 main（有继承层）才剔除；main/独立安装无继承，剔除会误删本次显式提交的键。
  if (!_isMainCfg(cfg)) for (const k of INHERIT_KEYS) if (!(k in cur)) delete common[k];
  const instStr = JSON.stringify(inst, null, 2);
  const commonStr = JSON.stringify({ ...cur, ...common }, null, 2);
  // 配置写入防呆（2026-09-22）：命中 mojibake/非法编码特征 → 抛错、**两个文件都不写**（防半写）。
  //   背景：主我用 PowerShell(GB2312) 提交含中文 body → 服务端按 UTF-8 解析 → agent.name 被写成乱码。
  if (looksMojibake(instStr) || looksMojibake(commonStr)) {
    const e = new Error('配置含 mojibake/非 UTF-8 内容，已拒绝写入（请用 UTF-8 提交）');
    e.rejected = true;
    e.status = 400;
    throw e;
  }
  fs.writeFileSync(configPath(), instStr, 'utf8');
  fs.writeFileSync(COMMON_PATH, commonStr, 'utf8');
  // C（2026-10-02）：身份类字段进前缀（agent.name/role/domain…）→ 合法保存后申报指纹，防审计误报。
  try { require('./pfxqueue').attest('config.identity'); } catch { }
}

// 意识数据目录（DATA_DIR）：P1 布局方案A 起由 src/paths.js 统一派生
// （env LEIZAI_DATA_DIR > portable.flag 安装根 > %LOCALAPPDATA%\LeiZai > 代码目录）。
// config.dataDir 已退役为「播种来源」——不再作运行时权威，避免与 env 两套并存。
const DATA_DIR = P.dataDir();

// E-3b（2026-10-03）：数据目录不可用（ENOTDIR/EACCES/EPERM…）不得抛未捕获异常。
// 纯校验（无副作用）：沿路径上溯到最近存在的祖先，若其为文件（非目录）→ 明确中文报错后优雅退出。
(function guardDataDir() {
  let d = path.resolve(DATA_DIR);
  let bad = null;
  for (;;) {
    try {
      const st = fs.statSync(d);
      if (!st.isDirectory()) { bad = Object.assign(new Error('路径已存在但不是目录（可能是文件）'), { code: 'ENOTDIR' }); }
      break;
    } catch (e) {
      if (e && e.code === 'ENOENT') { const up = path.dirname(d); if (up === d) break; d = up; continue; }
      bad = e; break;
    }
  }
  if (!bad) return;
  const reason = ((bad && bad.code) ? bad.code + ': ' : '') + String((bad && bad.message) || bad).split('\n')[0];
  const msg = `[雷仔] 数据目录不可用，无法启动：\n  路径：${DATA_DIR}\n  原因：${reason}\n  请检查环境变量 LEIZAI_DATA_DIR / 数据目录配置或目录权限。`;
  try { process.stderr.write(msg + '\n'); } catch { try { console.error(msg); } catch { } }
  process.exit(1);
})();


/** 主引擎当前 provider/model（供控制台占位「跟随主引擎」展示）。不可读返回 null。 */
function mainModelDefault(agentSharedDb) {
  let db = agentSharedDb;
  if (!db) { try { db = load().agentSharedDb; } catch { db = null; } }
  const m = _readMainCommon(db);
  if (!m) return null;
  const mi = _readMainInstance(db) || {};
  const cb = (mi.contextBudget !== undefined) ? mi.contextBudget : ((m.contextBudget !== undefined) ? m.contextBudget : null);
  return {
    provider: m.provider || null, model: m.model || null,
    reasoningEffort: (m.reasoningEffort !== undefined) ? m.reasoningEffort : null,
    reflectionEnabled: (m.reflectionEnabled !== undefined) ? m.reflectionEnabled : null,
    evolutionAutoApply: (m.evolutionAutoApply !== undefined) ? m.evolutionAutoApply : null,
    contextBudget: cb,
  };
}

module.exports = { ROOT, CONFIG_PATH, COMMON_PATH, configPath, DATA_DIR, load, save, looksMojibake, applyModelInheritance, INHERIT_KEYS, mainModelDefault, _mainDataDir };
