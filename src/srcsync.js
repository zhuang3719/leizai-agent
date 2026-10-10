'use strict';
/**
 * 雷仔 · 雷影代码随主程序更新（案①·2026-10-08，两会诊定案）
 * ---------------------------------------------------------------------------
 * 问题：雷影 src = 创建时快照 → 主程序升级后越来越旧（且旧版默认无感）。
 * 方案：
 *   ① 版本标记 `.srcver`（主程序根，= scripts/src-manifest.json 摘要）→ 各雷影根同名文件；
 *   ② 主实例启动早期比对 → 版本异则**原子换**（停 → stage 目录 → rename 交换 → 重启）；
 *   ③ 只覆盖**代码资产** SYNC_ITEMS（src/、templates/、config.common.json），
 *      **绝不碰 data/、config.json、portable.flag**（用户数据红线）；
 *   ④ 换前快照 `.src_bak_<ts>`，失败回退；⑤ 版本一致跳过（幂等）；
 *   ⑥ dev 不触发由上层 gate（`agent-spawn.mainIsRelease()`：无 `.release` + 无 LEIZAI_RELEASE → 不调用本模块）。
 * 纯加法、零数据风险；单一 revert = 不调用 + 删本文件。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SRCVER_FILE = '.srcver';
const SYNC_ITEMS = ['src', 'templates', 'config.common.json', 'closed'];   // 代码资产（SKELETON 减去 portable.flag；closed=闭源字节码，须随 src 同步，否则雷影 loader 找不到 ../closed/*.jsc）
const BAK_PREFIX = '.src_bak_';
const STAGE_PREFIX = '.src_stage_';

/** 读版本标记；无/空 → null。 */
function readSrcver(root) {
  try { const t = fs.readFileSync(path.join(root, SRCVER_FILE), 'utf8').trim(); return t || null; } catch { return null; }
}
/** 写版本标记（UTF-8 无 BOM）。 */
function writeSrcver(root, ver) {
  fs.writeFileSync(path.join(root, SRCVER_FILE), String(ver == null ? '' : ver), { encoding: 'utf8' });
}
/** 移除版本标记（回退时用）。 */
function removeSrcver(root) { try { fs.unlinkSync(path.join(root, SRCVER_FILE)); } catch { } }

/** 归一化 md5（strip \r）——与 scripts/sync-src.ps1 同口径，跨平台一致。 */
function normMd5(buf) {
  const arr = [];
  for (const b of buf) { if (b !== 13) arr.push(b); }
  return crypto.createHash('md5').update(Buffer.from(arr)).digest('hex');
}

/** 目录/文件 → {相对名: md5}；不存在 → null。 */
function digestItem(root, item) {
  const p = path.join(root, item);
  let st; try { st = fs.statSync(p); } catch { return null; }
  if (st.isFile()) return { [item]: normMd5(fs.readFileSync(p)) };
  const out = {};
  (function walk(d, base) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const rel = base ? base + '/' + e.name : e.name;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) { try { out[rel] = normMd5(fs.readFileSync(full)); } catch { } }
    }
  })(p, '');
  return out;
}

function sameDigest(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/** 精确路径递归删除（非通配；仅自建 stage/bak 内部用）。 */
function _rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { } }
function cleanupDir(p) { if (p) _rm(p); }

/**
 * 把 roots 中首个存在的 item 复制到 stageDir（不动原文件）。
 * @returns {{copied:boolean, changed:boolean}}
 */
function stageItem(targetDir, item, roots, stageDir) {
  let src = null;
  for (const r of roots) { try { if (r && fs.existsSync(path.join(r, item))) { src = path.join(r, item); break; } } catch { } }
  if (!src) return { copied: false, changed: false };
  const cur = digestItem(targetDir, item);
  const staged = path.join(stageDir, item);
  fs.mkdirSync(stageDir, { recursive: true });
  fs.cpSync(src, staged, { recursive: true, force: true });
  const nw = digestItem(stageDir, item);
  return { copied: true, changed: !sameDigest(cur, nw) };
}

/**
 * 快照 + 原子交换（**进程须已停**）：旧 item → `.src_bak_<stamp>/`，stage item → 原位。
 * @returns {{snapshotDir:string, swapped:string[]}}
 */
function snapshotAndSwap(targetDir, items, stageDir, stamp) {
  const snapshotDir = path.join(targetDir, BAK_PREFIX + stamp);
  fs.mkdirSync(snapshotDir, { recursive: true });
  const swapped = [];
  for (const it of items) {
    const staged = path.join(stageDir, it);
    if (!fs.existsSync(staged)) continue;
    const cur = path.join(targetDir, it);
    if (fs.existsSync(cur)) {
      try { fs.renameSync(cur, path.join(snapshotDir, it)); } catch { _rm(cur); }   // 同卷 rename；失败则删旧
    }
    fs.renameSync(staged, cur);
    swapped.push(it);
  }
  return { snapshotDir, swapped };
}

/** 回退：移走新 item，从快照恢复旧 item。 */
function rollbackSwap(targetDir, swapped, snapshotDir) {
  for (const it of (swapped || [])) { try { _rm(path.join(targetDir, it)); } catch { } }
  if (!snapshotDir) return;
  try {
    for (const e of fs.readdirSync(snapshotDir)) {
      try { fs.renameSync(path.join(snapshotDir, e), path.join(targetDir, e)); } catch { }
    }
  } catch { }
}

/**
 * 由 src-manifest 对象（{files:{rel:md5}}）生成版本摘要串（16 hex）。
 * 主程序根 `.srcver` = 本函数输出；由构建/打包侧写入。
 */
function manifestDigest(manifest) {
  try {
    const files = (manifest && manifest.files) || {};
    const lines = Object.keys(files).sort().map((k) => k + ':' + files[k]);
    return crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
  } catch { return null; }
}

module.exports = {
  SRCVER_FILE, SYNC_ITEMS, BAK_PREFIX, STAGE_PREFIX,
  readSrcver, writeSrcver, removeSrcver,
  normMd5, digestItem, sameDigest, stageItem, snapshotAndSwap, rollbackSwap, cleanupDir, manifestDigest,
};
