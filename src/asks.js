'use strict';
// 雷仔 · 询问选项框（Ask Box）· 未答 ask 持久化 + 读写
// 契约见 workspace/doc/询问选项框_方案v1.md §一。
// 存储：<dataDir>/asks.json（环境变量 LEIZAI_ASKS_PATH 可覆盖，供测试隔离）。
// 结构：{ asks: { <askId>: {askId, sessionId, question, options, allowSkip, allowFreeText, ts} } }
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('./config');

/** asks 存储路径：LEIZAI_ASKS_PATH 优先（测试隔离）；默认 <dataDir>/asks.json。 */
function asksPath() {
  const p = process.env.LEIZAI_ASKS_PATH;
  if (p) return path.resolve(p);
  return path.join(path.resolve(process.env.LEIZAI_DATA_DIR || DATA_DIR), 'asks.json');
}

/** 读全部未答 ask（文件不存在/损坏 → 空表，绝不抛）。 */
function loadAll() {
  try {
    const txt = fs.readFileSync(asksPath(), 'utf8');
    const j = JSON.parse(txt);
    return (j && typeof j === 'object' && j.asks && typeof j.asks === 'object') ? j.asks : {};
  } catch { return {}; }
}

/** 写回全部未答 ask（UTF-8 无 BOM）。 */
function saveAll(asks) {
  try {
    fs.mkdirSync(path.dirname(asksPath()), { recursive: true });
    fs.writeFileSync(asksPath(), JSON.stringify({ asks: asks || {} }, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

/** 归一化选项：保留 label(必填) + 可选 desc/value；丢弃无 label 的项。 */
function normOptions(options) {
  if (!Array.isArray(options)) return [];
  const out = [];
  for (const o of options) {
    if (!o || typeof o !== 'object') continue;
    const label = String(o.label == null ? '' : o.label).trim();
    if (!label) continue;
    const item = { label };
    if (o.desc != null && String(o.desc) !== '') item.desc = String(o.desc);
    if (o.value != null && String(o.value) !== '') item.value = String(o.value);
    out.push(item);
  }
  return out;
}

function newAskId() { return 'ask-' + crypto.randomBytes(6).toString('hex'); }

/** 创建并持久化一个待答 ask，返回 ask 对象（含 askId）。 */
function createAsk(a) {
  a = a || {};
  const ask = {
    askId: a.askId || newAskId(),
    sessionId: String(a.sessionId || ''),
    question: String(a.question || ''),
    options: normOptions(a.options),
    allowSkip: a.allowSkip !== false,           // 默认 true（显示跳过）
    allowFreeText: a.allowFreeText !== false,   // 默认 true（显示补充框）
    multi: a.multi === true,                     // v1.1：true=多选（复选框，默认 false）
    ts: Number.isFinite(a.ts) ? a.ts : Date.now(),
  };
  const all = loadAll();
  all[ask.askId] = ask;
  saveAll(all);
  return ask;
}

/** 按 id 取未答 ask；无 → null。 */
function getAsk(askId) {
  if (!askId) return null;
  const all = loadAll();
  return all[String(askId)] || null;
}

/** 标记已答：从存储移除。返回被移除的 ask；无 → null。 */
function removeAsk(askId) {
  if (!askId) return null;
  const all = loadAll();
  const k = String(askId);
  if (!(k in all)) return null;
  const ask = all[k];
  delete all[k];
  saveAll(all);
  return ask;
}

/** 未答列表：给定 sessionId 则只返回该会话；否则全部（按 ts 升序）。 */
function listPending(sessionId) {
  const all = loadAll();
  const list = Object.values(all).filter((x) => x && x.askId);
  const sid = sessionId ? String(sessionId) : '';
  const filtered = sid ? list.filter((x) => String(x.sessionId || '') === sid) : list;
  return filtered.sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

/** v1.1：把单个选项令牌解析为显示 label（容错 label/value 均可）。 */
function labelOf(opt, token) {
  const v = String(token == null ? '' : token);
  if (!opt) return v;
  const opts = Array.isArray(opt.options) ? opt.options : [];
  const hit = opts.find((o) => (o.value != null && String(o.value) === v)) || opts.find((o) => o.label === v);
  return hit ? hit.label : v;
}

/** 把回答解析为注入的用户消息文本（契约 §一 + §五 v1.1：option/skip/text/combo）。
 *  kind=option 时优先用选项 label（容错：value 传 label 或 option.value 均可）。
 *  kind=combo（v1.1）：options[]（可空）→【选择】A、B；text（可空）→ 追加 \n【补充】<text>；二者至少一个有值。 */
function composeAnswer(ask, kind, value, extra) {
  const k = String(kind || '');
  if (k === 'option') {
    return `【选择】${labelOf(ask, value)}`;
  }
  if (k === 'skip') return '【跳过】用户选择暂不执行，保持现状（不做任何变更）';
  if (k === 'text') return `【补充】${String(value == null ? '' : value)}`;
  if (k === 'combo') {
    const arr = Array.isArray(value) ? value : [];
    const text = (extra == null ? '' : String(extra));
    const labels = arr.map((t) => labelOf(ask, t)).filter((x) => x !== '');
    let out = '';
    if (labels.length) out += `【选择】${labels.join('、')}`;
    if (text !== '') out += (out ? '\n' : '') + `【补充】${text}`;
    return out === '' ? null : out;   // 选项与文字皆空 → 非法
  }
  return null;
}

module.exports = { asksPath, createAsk, getAsk, removeAsk, listPending, composeAnswer, newAskId };
