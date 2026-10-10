'use strict';
// 雷仔 · 版本链（version chain）—— 自我修改安全的底层
// 每次"影子写入"前，先把目标当前版本快照进 data/versions/（带时间戳+哈希），
// 供启动自检回退 + 手动一键回退任意历史版本。只增不减，保留最近 N 个。
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, ROOT } = require('./config');
const crypto = require('node:crypto');

const VERSIONS_DIR = path.join(DATA_DIR, 'versions');
const MAX_KEEP = 20;   // 每个目标文件最多保留的版本数（可配）

function ensure() {
  fs.mkdirSync(VERSIONS_DIR, { recursive: true });
}

/** 对文件内容做 SHA-256 哈希（用于版本去重与回退校验）。 */
function hashOf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/** 生成版本文件名：<原名>-<序号>-<哈希>.bak（序号从 1 递增，避免同名覆盖）。 */
function versionPathFor(filePath) {
  const base = path.basename(filePath);
  // 用相对路径的目录结构来隔离不同文件的版本（避免重名文件互相覆盖）
  const rel = path.relative(ROOT, filePath).replace(/[\\/:*?"<>|#]+/g, '_');
  return path.join(VERSIONS_DIR, `${rel}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.bak`);
}

/**
 * 快照当前内容到版本链。只记录"内容真的有变化"的版本，避免重复堆积。
 * @param {string} filePath 目标文件绝对路径
 * @param {Buffer|string} content 目标当前内容（用于哈希去重）
 * @returns {string|null} 生成的版本文件名（无变化返回 null）
 */
function snapshot(filePath, content) {
  try {
    ensure();
    if (!fs.existsSync(filePath)) return null;   // 新建文件无需快照旧版
    // 只对项目根（ROOT）内的文件记版本链，避免临时/外部目录污染版本链
    const rel = path.relative(ROOT, filePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const cur = fs.readFileSync(filePath);
    const h = hashOf(cur);
    if (content !== undefined && hashOf(Buffer.isBuffer(content) ? content : Buffer.from(String(content))) === h) {
      return null;   // 内容未变，不重复版本
    }
    const vp = versionPathFor(filePath);
    fs.writeFileSync(vp, cur);
    prune(filePath);
    return vp;
  } catch (e) {
    console.error('[versionchain] 快照失败:', e.message);
    return null;
  }
}

/** 保留"同一目标文件"的最近 N 个版本，其余淘汰（避免无限膨胀）。 */
function prune(filePath) {
  try {
    const rel = path.relative(ROOT, filePath).replace(/[\\/:*?"<>|#]+/g, '_');
    const files = fs.readdirSync(VERSIONS_DIR).filter((f) => f.startsWith(rel + '-')).sort();
    while (files.length > MAX_KEEP) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(VERSIONS_DIR, oldest)); } catch { }
    }
  } catch { }
}

/** 列出某文件（或全部）的版本链，按时间倒序。 */
function list(filePath) {
  ensure();
  const prefix = filePath ? path.relative(ROOT, filePath).replace(/[\\/:*?"<>|#]+/g, '_') + '-' : '';
  return fs.readdirSync(VERSIONS_DIR)
    .filter((f) => f.endsWith('.bak') && (prefix ? f.startsWith(prefix) : true))
    .sort()
    .reverse();
}

/**
 * 回退到最近一个好版本：把 versions/ 里最新的 .bak 覆盖回目标文件。
 * @param {string} filePath 目标文件绝对路径
 * @returns {boolean} 是否成功回退
 */
function rollback(filePath) {
  try {
    const versions = list(filePath);
    if (!versions.length) return false;
    // 版本文件名形如 "rel-时间戳-随机.bak"，取当前目标文件同主题的最新一个
    const rel = path.relative(ROOT, filePath).replace(/[\\/:*?"<>|#]+/g, '_');
    const best = versions.find((v) => v.startsWith(rel + '-'));
    if (!best) return false;
    fs.copyFileSync(path.join(VERSIONS_DIR, best), filePath);
    console.log(`[versionchain] 已回退 ${path.basename(filePath)} ← ${best}`);
    return true;
  } catch (e) {
    console.error('[versionchain] 回退失败:', e.message);
    return false;
  }
}

/** 最近一次"实体是好版本"的锚点。启动自检时若发现坏版本，回退到此处。 */
module.exports = { VERSIONS_DIR, snapshot, list, rollback, hashOf, ensure, MAX_KEEP };
