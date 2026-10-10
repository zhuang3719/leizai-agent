'use strict';
// 雷仔 · 模型 Provider 注册表（对齐 Prime Agent 的多模型 / 多提供方设计）
// 每个 provider 描述：默认 baseURL、apiKey 来源、默认模型目录、以及 OpenAI 兼容 API 的兼容性开关。
// 雷仔的 API 调用路径统一走「OpenAI 兼容 /chat/completions」；不同 provider 的差异主要在于：
//   - thinkingFormat：如何解析「推理内容」（deepseek → delta.reasoning_content；none → 不解析）；
//   - baseURL / 默认模型 / 密钥来源。
// 该文件只做「配置解析」，不发起任何网络请求，供 config/deepseek 使用；也便于单元测试。

// —— 内置 provider ——
// openaiCompatible = true 表示走标准 /chat/completions；false 未来可扩展到原生协议（如 Anthropic Messages）。
const PROFILE = {
  deepseek: {
    label: 'DeepSeek',
    openaiCompatible: true,
    baseURL: 'https://api.deepseek.com',
    apiKeyEnv: 'LEIZAI_DEEPSEEK_API_KEY',
    defaultModels: ['deepseek-flash', 'deepseek-v4-pro'],
    thinkingFormat: 'deepseek', // delta.reasoning_content
    effortSupport: 'full',       // 档位能力位（2026-10-07）：真档位——off 不发；low/medium/high/max 原样下发
    effortValues: ['off', 'low', 'medium', 'high', 'max'],
  },
  openai: {
    label: 'OpenAI',
    openaiCompatible: true,
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultModels: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6.1-sol-pro', 'gpt-5.6', 'gpt-5.6-luna'], // ⚠ 待核：源为 OpenRouter 聚合 slug，native 官方未验
    thinkingFormat: 'none', // 很多 OpenAI 系模型不流式输出 reasoning_content
  },
  anthropic: {
    label: 'Anthropic',
    openaiCompatible: true,
    baseURL: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    defaultModels: ['claude-sonnet-5.5', 'claude-opus-5.5', 'claude-fable-5.1', 'claude-opus-5'], // ⚠ 待核：源为 OpenRouter 聚合 slug，native 官方未验
    thinkingFormat: 'none',
  },
  azure: {
    label: 'Azure OpenAI',
    openaiCompatible: true,
    baseURL: 'https://YOUR_RESOURCE.openai.azure.com/openai/v1',
    apiKeyEnv: 'AZURE_OPENAI_API_KEY',
    defaultModels: ['gpt-5.6', 'gpt-5.6-luna'], // ✅ 官方（MS Learn）
    thinkingFormat: 'none',
  },
  groq: {
    label: 'Groq',
    openaiCompatible: true,
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    defaultModels: ['llama-3.3-70b-versatile'], // ⚠ 待核：官方页 403 未验
    thinkingFormat: 'none',
  },
  gemini: {
    label: 'Google Gemini',
    openaiCompatible: true,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    defaultModels: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'], // ⚠ 待核：源为 OpenRouter 聚合 slug，native 官方未验
    thinkingFormat: 'none',
  },
  xai: {
    label: 'xAI Grok',
    openaiCompatible: true,
    baseURL: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
    defaultModels: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.20'], // ⚠ 待核：源为 OpenRouter 聚合 slug，native 官方未验
    thinkingFormat: 'none',
  },
  'openrouter': {
    label: 'OpenRouter',
    openaiCompatible: true,
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    defaultModels: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'google/gemini-3.8-flash', 'x-ai/grok-4.7', 'qwen/qwen3.8-max'], // ✅ OpenRouter 自有 API 直读（权威）
    thinkingFormat: 'none',
  },
  'custom': {
    label: 'Custom (OpenAI-compatible)',
    openaiCompatible: true,
    baseURL: '', // 由 config.baseURL 覆盖
    apiKeyEnv: '',
    defaultModels: [],
    thinkingFormat: 'deepseek',
  },
  'qwen': {
    label: 'Qwen(阿里云百炼)',
    openaiCompatible: true,
    // 阿里云百炼 OpenAI 兼容端点（北京）；如需业务空间专属域名可覆写 baseURL
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    defaultModels: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash'],
    thinkingFormat: 'none',
  },
  'mimo': {
    label: 'Xiaomi MiMo',
    openaiCompatible: true,
    baseURL: 'https://api.xiaomimimo.com/v1',
    apiKeyEnv: 'LEIZAI_MIMO_API_KEY',
    defaultModels: ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro-ultraspeed', 'mimo-v2.5-pro', 'mimo-v2.5'],
    thinkingFormat: 'none', // 暂按不解析 reasoning_content；若实测返回该字段再改 'deepseek'
    effortSupport: 'onoff', // 档位能力位：开关语义（none=关思考；low/medium/high=开思考无梯度）
    effortValues: ['none', 'low', 'medium', 'high'],  // 严格解析（其它值→400）：off→none；max→钳制 high
  },
};

// 各提供方默认单价（USD / 百万 tokens），用于成本估算；可在 config.prices 覆盖。
// 计费：costUsd = Σ(tokens/1e6 × 单价)；costRmb = costUsd × cfg.usdRate（默认 7.2）。
// DeepSeek 官方以 **USD** 计价，且**分模型**、**分空闲/高峰**（高峰=北京时间周一至五 9:00-12:00、14:00-18:00，
//   中国法定节假日全天按空闲；高峰价 = 空闲价 ×2，节假日清单见 config.pricingHolidays）。
//   官方价见下方 DEEPSEEK_PRICES；PRICES.deepseek 为"未带模型名"时的默认口径（= deepseek-flash）。
const PRICES = {
  deepseek: {
    cachedPerM: 0.003, missedPerM: 0.15, outputPerM: 0.6,
    peak: { cachedPerM: 0.006, missedPerM: 0.3, outputPerM: 1.2 },   // 高峰时段价（空闲×2）；默认口径=deepseek-flash
  },
  openai: { cachedPerM: 1.0, missedPerM: 2.5, outputPerM: 10.0 },
  anthropic: { cachedPerM: 0.3, missedPerM: 3.0, outputPerM: 15.0 },
  azure: { cachedPerM: 1.0, missedPerM: 3.0, outputPerM: 6.0 },
  groq: { cachedPerM: 0.1, missedPerM: 0.6, outputPerM: 0.8 },
  gemini: { cachedPerM: 0.2, missedPerM: 1.25, outputPerM: 5.0 },
  xai: { cachedPerM: 0.15, missedPerM: 0.9, outputPerM: 2.8 },
  openrouter: { cachedPerM: 0.5, missedPerM: 1.5, outputPerM: 5.0 },
  // Xiaomi MiMo：官方以 **RMB/百万 tokens** 计价，此处按系统默认汇率 usdRate=7.2 折算为 USD/MTok（USD = RMB / 7.2）。
  //   本项为"未带模型名"默认口径（= pro 档）；实际按下方 MIMO_PRICES 分模型计价（见 pricesFor）。
  mimo: { cachedPerM: 0.003472, missedPerM: 0.416667, outputPerM: 0.833333 },
  custom: { cachedPerM: 0.5, missedPerM: 1.5, outputPerM: 5.0 },
};
for (const k of Object.keys(PROFILE)) PROFILE[k].prices = PRICES[k] || PRICES.custom;

// DeepSeek 分模型价表（USD / 百万 tokens；peak=高峰价，空闲×2）。来源 api-docs.deepseek.com/quick_start/pricing。
const DEEPSEEK_PRICES = {
  'deepseek-flash': { cachedPerM: 0.003, missedPerM: 0.15, outputPerM: 0.6,
    peak: { cachedPerM: 0.006, missedPerM: 0.3, outputPerM: 1.2 } },
  'deepseek-v4-pro': { cachedPerM: 0.022, missedPerM: 0.66, outputPerM: 1.98,
    peak: { cachedPerM: 0.044, missedPerM: 1.32, outputPerM: 3.96 } },
};

// Xiaomi MiMo 分模型价表（USD / 百万 tokens）。官方以 **RMB/百万 tokens** 计价，此处按系统默认汇率 7.2 折算
//   （USD = RMB / 7.2）：pro 0.025/3/6 → 0.003472/0.416667/0.833333；flash 0.02/1/2 → 0.002778/0.138889/0.277778；
//   ultraspeed 0.25/30/60 → 0.034722/4.166667/8.333333。若 config.usdRate 非 7.2，折算会有等比例偏差（同 deepseek 口径）。
const MIMO_PRICES = {
  'mimo-v2.6-pro': { cachedPerM: 0.003472, missedPerM: 0.416667, outputPerM: 0.833333 },
  'mimo-v2.6-flash': { cachedPerM: 0.002778, missedPerM: 0.138889, outputPerM: 0.277778 },
  'mimo-v2.6-pro-ultraspeed': { cachedPerM: 0.034722, missedPerM: 4.166667, outputPerM: 8.333333 },
};

// —— 其余 provider 分模型价表（USD / 百万 tokens；字段同 DEEPSEEK_PRICES：cachedPerM=缓存命中输入价,
//    missedPerM=未命中输入价, outputPerM=输出价）。查证日期 2026-10-07。
//    来源标注：【官方】= provider 官方价目已核，URL 见注释；【待核·OR聚合】= native 官方价页不可达（403/JS），
//    值取自 OpenRouter 官方 API https://openrouter.ai/api/v1/models 的同名/同款模型聚合价（非 native 官方，待复核）。
//    未列出的模型一律不进表 → pricesFor 回退 provider 兜底价 PRICES[name]（不臆造）。
const OPENAI_PRICES = {   // 【待核·OR聚合】(openai/*)
  'gpt-6.1-sol': { cachedPerM: 0.1, missedPerM: 2, outputPerM: 10 },
  'gpt-6-luna': { cachedPerM: 0.01, missedPerM: 0.1, outputPerM: 0.5 },
  'gpt-6.1-sol-pro': { cachedPerM: 0.1, missedPerM: 2, outputPerM: 10 },
  'gpt-5.6-luna': { cachedPerM: 0.02, missedPerM: 0.2, outputPerM: 1.2 },
  // 'gpt-5.6'：无对应价 → 兜底
};
const ANTHROPIC_PRICES = {  // 【官方】https://www.anthropic.com/pricing（2026-10-07）
  'claude-sonnet-5.5': { cachedPerM: 0.2, missedPerM: 2, outputPerM: 10 },
  'claude-opus-5.5': { cachedPerM: 0.2, missedPerM: 4, outputPerM: 20 },
  'claude-fable-5.1': { cachedPerM: 0.25, missedPerM: 10, outputPerM: 50 },
  'claude-opus-5': { cachedPerM: 0.5, missedPerM: 5, outputPerM: 25 },  // 【待核】官方页未单列，源 OR 聚合
};
const GEMINI_PRICES = {   // 【待核·OR聚合】(google/*)
  'gemini-3.8-flash': { cachedPerM: 0.075, missedPerM: 0.75, outputPerM: 3.75 },
  'gemini-3.7-flash': { cachedPerM: 0.075, missedPerM: 0.75, outputPerM: 3.75 },
  'gemini-3.6-flash': { cachedPerM: 0.075, missedPerM: 0.75, outputPerM: 3.75 },
  'gemini-3.5-flash-lite': { cachedPerM: 0.03, missedPerM: 0.3, outputPerM: 2.5 },
};
const XAI_PRICES = {      // 【待核·OR聚合】(x-ai/*)
  'grok-4.7': { cachedPerM: 0.5, missedPerM: 2, outputPerM: 6 },
  'grok-4.6': { cachedPerM: 0.5, missedPerM: 2, outputPerM: 6 },
  'grok-4.5': { cachedPerM: 0.3, missedPerM: 2, outputPerM: 6 },
  'grok-4.20': { cachedPerM: 0.2, missedPerM: 1.25, outputPerM: 2.5 },
};
const QWEN_PRICES = {     // 【待核·OR聚合】(qwen/*)
  'qwen3.7-plus': { cachedPerM: 0.064, missedPerM: 0.32, outputPerM: 1.28 },
  'qwen3.8-flash': { cachedPerM: 0.016, missedPerM: 0.15, outputPerM: 0.47 },
  // 'qwen3.8-max'：OR 无精确同名条目（仅 -prime/-0902）→ 兜底
};
const GROQ_PRICES = {     // 【待核】Groq 官方价页不可达；值取自 OR 聚合 meta-llama/llama-3.3-70b-instruct
  'llama-3.3-70b-versatile': { cachedPerM: 0.11, missedPerM: 0.22, outputPerM: 0.5 },
};
const OPENROUTER_PRICES = {  // 【官方】https://openrouter.ai/api/v1/models（2026-10-07）
  'anthropic/claude-sonnet-5.5': { cachedPerM: 0.2, missedPerM: 2, outputPerM: 10 },
  'openai/gpt-6.1-sol': { cachedPerM: 0.1, missedPerM: 2, outputPerM: 10 },
  'google/gemini-3.8-flash': { cachedPerM: 0.075, missedPerM: 0.75, outputPerM: 3.75 },
  'x-ai/grok-4.7': { cachedPerM: 0.5, missedPerM: 2, outputPerM: 6 },
  // 'qwen/qwen3.8-max'：OR 无精确同名条目 → 兜底
};
const MODEL_PRICES = { openai: OPENAI_PRICES, anthropic: ANTHROPIC_PRICES, gemini: GEMINI_PRICES, xai: XAI_PRICES, qwen: QWEN_PRICES, groq: GROQ_PRICES, openrouter: OPENROUTER_PRICES };

/** 在分模型价表里按模型名取键：小写归一 + 去 vendor 前缀后精确匹配；未命中返回 null（由 pricesFor 回退兜底价）。 */
function priceKeyIn(table, model) {
  const raw = String(model || '').trim().toLowerCase();
  if (!raw) return null;
  if (table[raw]) return raw;
  const tail = raw.split('/').pop();
  return table[tail] ? tail : null;
}

/** 把实际请求的模型名归到 MiMo 计价档：含 'ultraspeed' → 极速档；含 'flash' → flash 档；其余（含 pro / v2.5 / 未知）→ pro 档。 */
function mimoPriceKey(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('ultraspeed')) return 'mimo-v2.6-pro-ultraspeed';
  if (m.includes('flash')) return 'mimo-v2.6-flash';
  return 'mimo-v2.6-pro';
}

/** 把实际请求的模型名归到 DeepSeek 计价档：含 'pro' → deepseek-v4-pro，其余（flash/旧名/未知）→ deepseek-flash。 */
function deepseekPriceKey(model) {
  const m = String(model || '').toLowerCase();
  return m.includes('pro') ? 'deepseek-v4-pro' : 'deepseek-flash';
}

/** 按 provider + 实际模型名取单价对象。
 *  deepseek/mimo 用归并档；其余 provider 先查分模型价表（精确名匹配），未命中 → provider 兜底价；未知 provider → custom。 */
function pricesFor(name, model) {
  const n = String(name || '');
  if (n === 'deepseek') return DEEPSEEK_PRICES[deepseekPriceKey(model)];
  if (n === 'mimo') return MIMO_PRICES[mimoPriceKey(model)] || MIMO_PRICES['mimo-v2.6-pro'];
  const table = MODEL_PRICES[n];
  if (table) { const k = priceKeyIn(table, model); if (k) return table[k]; }
  return PRICES[n] || PRICES.custom;
}

const SUPPORTED = Object.keys(PROFILE);

/** 返回某个 provider 的画像（未知回退到 custom；请求名仍单独记录在 resolve().provider）。 */
function profile(name) {
  return PROFILE[name] || { ...PROFILE.custom };
}

/**
 * 把「零散配置」解析成一次请求所需的确定性参数。
 * 优先使用 config 里显式设置的 baseURL / model / models / apiKey（兼容旧配置），
 * 缺失部分回退到 provider 画像的默认值。此函数不访问网络、不做 IO。
 * @param {object} cfg loadConfig() 的结果
 * @returns {{provider, label, baseURL|string, models:string[], thinkingFormat, openaiCompatible:boolean}}
 */
function resolve(cfg = {}) {
  const name = String(cfg.provider || 'deepseek');
  const prof = profile(name);
  const baseURL = String(cfg.baseURL || prof.baseURL || '').replace(/\/+$/, '');
  const models = Array.isArray(cfg.models) && cfg.models.length
    ? cfg.models
    : (prof.defaultModels.length ? [...prof.defaultModels] : []);
  const model = String(cfg.model || models[0] || '');
  const thinkingFormat = String(cfg.thinkingFormat || prof.thinkingFormat || 'deepseek');
  const apiKeyEnv = prof.apiKeyEnv || '';
  return { provider: name, label: prof.label, baseURL, model, models, thinkingFormat, effortSupport: prof.effortSupport || 'none', openaiCompatible: prof.openaiCompatible, apiKeyEnv, prices: prof.prices };
}

module.exports = { PROFILE, SUPPORTED, profile, resolve, pricesFor, deepseekPriceKey, DEEPSEEK_PRICES, mimoPriceKey, MIMO_PRICES, priceKeyIn, MODEL_PRICES, OPENAI_PRICES, ANTHROPIC_PRICES, GEMINI_PRICES, XAI_PRICES, QWEN_PRICES, GROQ_PRICES, OPENROUTER_PRICES };
