'use strict';
// 雷仔 · src 漂移自检（防漂移结构根治·路线B，2026-10-08）
// 目标：让"雷影 src 与主 src 漂移"从"靠人记得同步"升级为"自动可见"。
// 设计：
//   1) 主引擎**启动时**对自身 src 全量 sha256（排除 .bak*/_bak*/_archive/_tmp/__pycache__）→ 写 <主 data>/src_baseline.json；
//   2) 各实例启动/请求时读该基线，比对自己 src → 结果挂 /api/health 的 srcDrift；
//   3) 默认**告警不拒启**（绝不因漂移停机）；
//   4) 开关见 config.common.json：srcDriftCheck(默认 true) / srcDriftAutoSync(默认 false，暂只透出不做自动动作)。
// 纯加法、零数据风险；单一 revert = 关闭开关，或撤本文件 + server.js 两处调用。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');

const SRC_DIR = __dirname;                 // 本实例 src 目录（本文件所在即 src）
const BASELINE_NAME = 'src_baseline.json';

/** 是否应排除（备份/归档/临时/字节码目录或文件）。 */
function isExcluded(rel) {
  const segs = rel.split('/');
  return segs.some((s) => /\.bak/i.test(s) || /^_bak/i.test(s) || s === '_tmp' || s === '_archive' || s === '__pycache__');
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function walk(dir, base, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const rel = base ? base + '/' + e.name : e.name;
    if (isExcluded(rel)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, rel, out);
    else if (e.isFile()) { try { out[rel] = sha256(fs.readFileSync(full)); } catch { } }
  }
  return out;
}

/** 对 src 目录生成 {relPath: sha256}（排除备份/临时），relPath 统一以 '/' 分隔。缺省本实例 src。 */
function hashDir(dir) { return walk(dir || SRC_DIR, '', {}); }

/** 定位主引擎数据根：env LEIZAI_MAIN_DATA_DIR > cfg.agentSharedDb 所在目录（三共享键，必在主 data） > 本实例 DATA_DIR。 */
function mainDataRoot(cfg) {
  if (process.env.LEIZAI_MAIN_DATA_DIR) return process.env.LEIZAI_MAIN_DATA_DIR;
  const db = (cfg && cfg.agentSharedDb) || null;
  if (db) return path.dirname(path.resolve(db));
  return config.DATA_DIR;
}

/** 基线文件路径（主引擎 data 根下，即 <项目根>\data\src_baseline.json）。 */
function baselinePath(cfg) { return path.join(mainDataRoot(cfg), BASELINE_NAME); }

/** 生成基线（主实例启动时调用）。原子写、UTF-8 无 BOM。 */
function generateBaseline(cfg, srcDir) {
  const dir = srcDir || SRC_DIR;
  const files = hashDir(dir);
  const data = { generatedAt: Date.now(), srcDir: dir, count: Object.keys(files).length, files };
  const bp = baselinePath(cfg);
  fs.mkdirSync(path.dirname(bp), { recursive: true });
  const tmp = bp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, bp);
  _driftCache.clear();
  return data;
}

/** TTL 缓存：key(bp|dir) -> 结果；避免每次 /api/health 都重算整目录 hash。 */
const _driftCache = new Map();
function _cacheTtl(cfg) { const v = Number(cfg && cfg.srcDriftCacheMs); return Number.isFinite(v) && v >= 0 ? v : 30000; }
function _finalize(c) {
  const o = { enabled: true, autoSync: c.autoSync, baselinePath: c.bp,
    baselineAgeMs: c.gen ? (Date.now() - c.gen) : null,
    fileCount: c.fileCount, missing: c.missing, extra: c.extra, modified: c.modified };
  if (c.error) o.error = c.error;
  return o;
}
/** 比对当前 src 与基线。TTL 缓存（cfg.srcDriftCacheMs，默认 30000，0=禁用）。异常安全，绝不 throw。 */
function getDrift(cfg, srcDir) {
  const dir = srcDir || SRC_DIR;
  const enabled = !(cfg && cfg.srcDriftCheck === false);
  const autoSync = !!(cfg && cfg.srcDriftAutoSync === true);
  const bp = baselinePath(cfg);
  if (!enabled) return { enabled: false, autoSync, baselinePath: bp };
  const ttl = _cacheTtl(cfg);
  const key = bp + '|' + dir;
  const now = Date.now();
  const hit = _driftCache.get(key);
  if (ttl > 0 && hit && (now - hit.at) < ttl) return _finalize(hit);
  let base = null;
  try { base = JSON.parse(fs.readFileSync(bp, 'utf8')); } catch { }
  let c;
  if (!base || !base.files || typeof base.files !== 'object') {
    c = { bp, autoSync, at: now, gen: 0, fileCount: 0, missing: [], extra: [], modified: [], error: 'baseline-missing' };
  } else {
    const cur = hashDir(dir);
    const missing = [], extra = [], modified = [];
    for (const k of Object.keys(base.files)) {
      if (!(k in cur)) missing.push(k);
      else if (cur[k] !== base.files[k]) modified.push(k);
    }
    for (const k of Object.keys(cur)) if (!(k in base.files)) extra.push(k);
    c = { bp, autoSync, at: now, gen: base.generatedAt || 0, fileCount: Object.keys(cur).length, missing, extra, modified };
  }
  if (ttl > 0) _driftCache.set(key, c);
  return _finalize(c);
}

function clearDriftCache() { _driftCache.clear(); }
module.exports = { generateBaseline, getDrift, clearDriftCache, hashDir, baselinePath, mainDataRoot, SRC_DIR, BASELINE_NAME, isExcluded };
