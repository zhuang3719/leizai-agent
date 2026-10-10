// A1 前端 · 运行指标聚合控制器（P1）
// 数据源：GET /api/sessions/:id/stats?aggregate=1 → { total, items, history }
//   total  : 聚合总数（usedTokens/hitTokens/missTokens/outputTokens/costRmb/calls/hitRate）——hitRate 由引擎加权
//   items  : 各会话明细 [{ sessionId, role, name, hitTokens, missTokens, outputTokens, costRmb, online }]
//   history: 引擎按 ts 合并对齐的回合点 [{ at|ts, cost, hit, miss, out, hitTokens }]
// 未就绪 / 失败 / 竞态 一律降级（store.sessionAgg=null，调用方回退单会话 store.sessionStats），不抛错。
import { api } from './api.js';
import { store } from './store.js';

const TTL = 4000;                      // 短缓存，避免短时间重复请求
let _token = 0;                        // 竞态令牌：切会话 / 新请求即令旧响应失效
let _cache = { id: null, at: 0, data: null };

export function invalidateAgg() { _cache = { id: null, at: 0, data: null }; _token++; }

// 字段归一化（公共）：兼容引擎聚合短名(total/items: hit/miss/out) 与单会话长名(hitTokens/missTokens/outputTokens)。
// 截断/缺字段一律按 0，绝不产生 NaN。
const TOK_ALIAS = { hit: ['hit', 'hitTokens'], miss: ['miss', 'missTokens'], out: ['out', 'outputTokens'] };
export function normTok(x, k) {
  if (x == null) return 0;
  const keys = TOK_ALIAS[k] || [k];
  for (const key of keys) { const v = x[key]; if (v != null) return Number(v) || 0; }
  return 0;
}

/** 拉取聚合并写入 store.sessionAgg；失败/未就绪 → 置 null 降级。返回数据或 null。 */
export async function refreshAgg(id, opts) {
  const force = !!(opts && opts.force);
  if (!id || id !== store.currentId) return null;                       // 已切走，丢弃
  const now = Date.now();
  if (!force && _cache.id === id && (now - _cache.at) < TTL) { store.sessionAgg = _cache.data; return _cache.data; }
  const my = ++_token;
  try {
    const r = await api.sessionStatsAgg(id);
    if (my !== _token || id !== store.currentId) return null;           // 竞态：旧响应丢弃
    const data = (r && r.total) ? r : null;
    _cache = { id, at: Date.now(), data };
    store.sessionAgg = data;
    return data;
  } catch {
    if (my === _token && id === store.currentId) store.sessionAgg = null;   // 端点未就绪 → 降级（不报错）
    return null;
  }
}

/** turn-done 触发：仅当 sid 属于「当前聚合集合」时才重拉（集合取自 items，动态，绝不硬编码角色表）。 */
export function maybeRefreshAgg(sid) {
  if (!sid || !store.currentId) return;
  const a = store.sessionAgg;
  const items = (a && Array.isArray(a.items)) ? a.items : null;
  const hit = sid === store.currentId || (!!items && items.some((it) => it && (it.sessionId === sid || it.id === sid)));
  refreshAgg(store.currentId, { force: !!hit });
}
