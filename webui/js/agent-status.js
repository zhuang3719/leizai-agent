// A1 前端 · 智能体头像「四态」判定单一权威（忙碌 / 空闲 / 离线 / 重启中）
//   设计（主人已确认，美工样例《智能体头像状态区分.html》）：
//     · 判定优先级：忙碌 > 重启中 > 离线 > 空闲
//     · 数据源：/api/mailbox/summary 的 roles[]（busy / restarting / online / lastSeen / lastTs）
//     · 兼容：引擎未提供 online/lastSeen 时（旧引擎未重启的过渡窗口）→ 一律回退「空闲」，
//             绝不用不可靠的 lastTs 误判离线（避免"大面积假离线"视觉回归）。
import { store } from './store.js';

export const OFFLINE_MS = 5 * 60 * 1000;   // 5min 无活动 → 离线（可配置阈值）

/** 依据单个角色信息求状态。{busy,restarting,online,lastSeen} */
export function statusOf({ busy, restarting, online, lastSeen } = {}) {
  if (busy) return 'busy';                                  // 忙碌（真实回合状态，最高优先）
  if (restarting) return 'restarting';                      // 重启中（引擎短 TTL 标记）
  if (online === false) return 'offline';                   // 离线（引擎探测判定）
  if (online === true) return 'idle';                       // 在线且非忙 → 空闲
  const ts = Number(lastSeen) || 0;                         // 引擎未给 online：用自注册时间新鲜度兜底
  if (ts && Date.now() - ts > OFFLINE_MS) return 'offline';
  return 'idle';                                            // 无可靠信息 → 空闲（不臆断离线）
}

/** 取某角色在 store.mailbox.roles 的原始信息（找不到 → {}）。 */
export function roleInfo(role) {
  const roles = (store.mailbox && store.mailbox.roles) || [];
  return roles.find((x) => x && x.role === role) || {};
}

/** 取某角色的四态（供列表/主区头像直接调用）。 */
export function roleStatus(role) {
  return statusOf(roleInfo(role));
}
