'use strict';
// 雷仔 · 数据路径（Node 侧）。优先读 env LEIZAI_DATA_DIR（由 shell/Paths.cs 注入），仅兜底自算。
// 与外层 shell/Paths.cs 保持同一优先级链：env > portable.flag(安装根) > %LOCALAPPDATA%\LeiZaiData > 代码目录。
// ⚠ 安装版数据根 = %LOCALAPPDATA%\LeiZaiData（不可用 %LOCALAPPDATA%\LeiZai——那是 Velopack {packId} 安装目录，卸载会整目录删除）。
const fs = require('node:fs');
const path = require('node:path');

/** 代码目录（src 的上一级，只读二进制所在）。 */
const CODE_ROOT = path.resolve(__dirname, '..');
const FLAG = 'portable.flag';

/** 从 startDir 起（含自身）上溯最多 2 层找 portable.flag；返回其目录或 null。 */
function findPortableFlag(startDir) {
  let d = path.resolve(startDir);
  for (let i = 0; i < 3; i++) {
    try { if (fs.existsSync(path.join(d, FLAG))) return d; } catch { /* ignore */ }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

let _root = null;
let _source = null;

/** 数据目录指针文件（固定位置，不随数据根/安装目录变化；卸载不删 → 自定义目录可跨重装保留）。 */
function pointerPath() {
  const lad = process.env.LOCALAPPDATA || process.env.USERPROFILE || '';
  return lad ? path.join(lad, 'LeiZaiDataDir.txt') : null;
}
function readPointer() {
  const p = pointerPath(); if (!p) return null;
  try { const s = fs.readFileSync(p, 'utf8').trim(); return s ? path.resolve(s) : null; } catch { return null; }
}
function writePointer(dir) {
  const p = pointerPath(); if (!p) throw new Error('LOCALAPPDATA 不可用');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, path.resolve(dir), 'utf8');   // UTF-8 无 BOM
}
function clearOverride() { const p = pointerPath(); if (p) { try { fs.unlinkSync(p); } catch { } } }

/** 可变数据根。优先级：env > portable.flag > 指针文件 > %LOCALAPPDATA%\LeiZaiData > 代码目录。 */
function root() {
  if (_root) return _root;
  // ① env 优先（C# 注入 / 测试隔离 / 运维覆盖）
  if (process.env.LEIZAI_DATA_DIR) { _root = path.resolve(process.env.LEIZAI_DATA_DIR); _source = 'env'; return _root; }
  // ② portable.flag（安装根 / 绿色目录）
  const f = findPortableFlag(CODE_ROOT);
  if (f) { _root = f; _source = 'portable'; return _root; }
  // ③ 用户自定义指针（UI「更改数据目录」写入；跨重装保留）
  const ptr = readPointer();
  if (ptr) { _root = ptr; _source = 'pointer'; return _root; }
  // ④ %LOCALAPPDATA%\LeiZaiData（安装版默认；避开 Velopack {packId} 安装目录 %LOCALAPPDATA%\LeiZai，防卸载误删）
  const lad = process.env.LOCALAPPDATA || process.env.USERPROFILE;
  if (lad) { _root = path.join(lad, 'LeiZaiData'); _source = 'default'; return _root; }
  // ⑤ 兜底
  _root = CODE_ROOT; _source = 'codeDir';
  return _root;
}

/** 供 /api/paths 暴露：当前数据目录与来源（只读，不改行为）。 */
function info() {
  const d = root();
  const ptr = readPointer();
  const env = process.env.LEIZAI_DATA_DIR || '';
  let src = _source || 'unknown';
  // 安装版：shell 会把 Root() 注入 env；若 env 值 == 指针值，则真实来源是"用户自定义指针"
  if (env && ptr && path.resolve(env) === ptr) src = 'pointer';
  return {
    dataDir: d,
    codeRoot: CODE_ROOT,
    source: src,
    pointerFile: pointerPath(),
    pointerDir: ptr || null,
    portableFlag: !!findPortableFlag(CODE_ROOT),
    envOverride: !!env,
  };
}

/** 设置自定义数据目录：校验可写 →（可选）迁移现有数据 → 写指针。需重启应用生效。 */
function setDataDir(dir, migrate) {
  if (!dir || typeof dir !== 'string') return { ok: false, error: 'dir_required' };
  const target = path.resolve(dir.trim());
  const cur = root();
  // 便携模式(portable.flag)/环境变量覆盖下，指针优先级低于它们 → 明确拒绝，防"改了不生效"的静默失败
  const src = _source || 'unknown';
  if (src === 'portable') return { ok: false, error: 'portable_mode: 当前为便携模式（数据跟在程序目录），不可更改' };
  if (target === cur) return { ok: true, needRestart: false, dataDir: cur, note: 'same_dir' };
  try { fs.mkdirSync(target, { recursive: true }); } catch (e) { return { ok: false, error: 'mkdir_failed:' + e.message }; }
  // 写权限探针
  try { const t = path.join(target, '.leizai_write_test'); fs.writeFileSync(t, '1'); fs.unlinkSync(t); }
  catch (e) { return { ok: false, error: 'not_writable:' + e.message }; }

  let migrated = false, copyStat = null;
  if (migrate) {
    try { copyStat = copyTreeBestEffort(cur, target, target); migrated = true; }
    catch (e) { return { ok: false, error: 'migrate_failed:' + e.message }; }
  }
  try { writePointer(target); } catch (e) { return { ok: false, error: 'pointer_failed:' + e.message }; }
  return { ok: true, needRestart: true, dataDir: target, from: cur, migrated, copyStat };
}

/** 递归复制（best-effort：单个文件失败不中断，跳过符号链接；skipAbs=不复制该绝对路径=防自嵌套）。 */
function copyTreeBestEffort(src, dst, skipAbs) {
  let copied = 0, failed = 0; const failedList = [];
  try { fs.mkdirSync(dst, { recursive: true }); } catch { }
  let ents = [];
  try { ents = fs.readdirSync(src, { withFileTypes: true }); } catch { return { copied, failed: 1, failedList: [src] }; }
  for (const ent of ents) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (skipAbs && path.resolve(s) === path.resolve(skipAbs)) continue;   // 防自嵌套
    try {
      if (ent.isDirectory()) {
        const r = copyTreeBestEffort(s, d, skipAbs); copied += r.copied; failed += r.failed;
        if (r.failedList && r.failedList.length) failedList.push(...r.failedList);
      } else if (ent.isFile()) { if (!fs.existsSync(d)) { fs.copyFileSync(s, d); copied++; } }
    } catch (e) { failed++; if (failedList.length < 20) failedList.push(s); }   // 记录失败项（上限20，防爆）
  }
  return { copied, failed, failedList };
}

module.exports = {
  CODE_ROOT,
  root,
  info,
  setDataDir,
  clearOverride,
  pointerPath,
  configPath: () => path.join(root(), 'config.json'),
  commonPath: () => path.join(root(), 'config.common.json'),
  dataDir: () => path.join(root(), 'data'),
  logsDir: () => path.join(root(), 'logs'),
  webViewDataDir: () => path.join(root(), 'webview2-data'),
};
