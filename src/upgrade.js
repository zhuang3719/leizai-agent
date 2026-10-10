'use strict';
/**
 * P2 · 旧版→新版 升级迁移（引擎内嵌模块）
 * ---------------------------------------------------------------------------
 * 接入点：**引擎启动自检**（src/server.js，config 加载后 / gate.init 与 listen 之前）。
 *   选择依据：①产品是 VP 原地升级，"安装后首启"即"引擎启动"，二者同一时机；
 *   ②迁移须在 branch.init / gate.init 之前完成（先补 branch.db 旧列，后者才不会因缺列中止）；
 *   ③比"版本号跳跃检测"更稳——启动自检天然幂等，且不依赖外部安装器改文件。
 *   生效范围：**仅产品/发布态**（`.release` 或 LEIZAI_RELEASE=1）；dev 永不触发。
 *   版本判据：`<root>/.srcver`（构建写入）> package.json.version；命中同版本 → 跳过（stamp 记于 <data>/.upgrade-stamp）。
 *
 * 职责（幂等 · 绝不 throw）：
 *   ① 备份 config.json / config.common.json / pro-token.json / *.db（.bak_p2mig_<ts>）
 *   ② pro 编译产物预检（leizai-pro.exe / manifest.json / manifest.pub / src/pro/toolcap.js）
 *   ③ branch.db 兼容补列（仅补 CREATE TABLE 有、branch.js ALTER 未覆盖的旧列）
 *   ④ 产出 <data>/_p2migrate/report.json + rollback.cmd（一键还原所有 .bak）
 * 铁律：绝不 throw 到调用方；绝不删数据；不落/不回显密钥；失败只告警不阻断启动。
 */
const fs = require('node:fs');
const path = require('node:path');

const STAMP_NAME = '.upgrade-stamp';
const OUT_DIRNAME = '_p2migrate';

/** branch_event 兼容必备列（单一来源 = src/branch.js 的 CREATE TABLE + ALTER 清单）。
 *  init 的 ALTER 覆盖 ref/corr_id/turn_no/sub_seq/origin/topic_key/topic_source，
 *  但 gen/turn_id/seq/payload/ts 只在 CREATE TABLE 里——旧库缺这些列时 init 的
 *  `CREATE INDEX ...(session_id, ts)` 会抛 "no such column: ts" → 整个 init 中止 → mode='off'。 */
const BRANCH_BASE_COLS = [
  ['gen', 'INTEGER NOT NULL DEFAULT 0'],
  ['turn_id', "TEXT NOT NULL DEFAULT ''"],
  ['seq', 'INTEGER NOT NULL DEFAULT 0'],
  ['payload', "TEXT NOT NULL DEFAULT ''"],
  ['ts', 'INTEGER NOT NULL DEFAULT 0'],
];

function tsStamp() { return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); }
function tableCols(db, t) { try { return new Set(db.prepare('PRAGMA table_info(' + t + ')').all().map((r) => String(r.name))); } catch { return null; } }

/** 执行一次迁移（幂等）。任何异常 → 返回 {ok:false,error}，绝不 throw。 */
function runUpgrade(opts = {}) {
  const dryRun = !!opts.dryRun;
  const heal = opts.heal !== false;
  const say = typeof opts.log === 'function' ? opts.log : (s) => { try { console.log(s); } catch { } };
  let ROOT, DATA;
  try { ROOT = path.resolve(opts.root || require('./paths').CODE_ROOT); } catch { ROOT = path.resolve(__dirname, '..'); }
  try { DATA = path.resolve(opts.dataDir || require('./config').DATA_DIR); } catch { DATA = path.resolve(ROOT, 'data'); }
  const TS = tsStamp();
  const report = { at: new Date().toISOString(), data: DATA, root: ROOT, dryRun, steps: {}, ok: true, warnings: [] };
  try {
    say('== P2 升级迁移 == data=' + DATA + ' root=' + ROOT + ' dryRun=' + dryRun);
    if (!fs.existsSync(DATA)) return { ok: false, error: 'data 目录不存在: ' + DATA };

    // ① 备份
    say('[1] 备份关键文件');
    report.steps.backup = [];
    const backup = (p) => {
      try {
        if (!fs.existsSync(p)) return null;
        const b = p + '.bak_p2mig_' + TS;
        if (!dryRun) fs.copyFileSync(p, b);
        say('  备份 ' + path.basename(p) + ' → ' + path.basename(b));
        return b;
      } catch (e) { say('  ! 备份失败 ' + p + ': ' + e.message); return null; }
    };
    for (const rel of ['config.json', 'config.common.json', 'pro-token.json']) {
      const b = backup(path.join(DATA, rel)); if (b) report.steps.backup.push(b);
    }
    let dbs = [];
    try { dbs = fs.readdirSync(DATA).filter((f) => f.endsWith('.db')); } catch { }
    for (const f of dbs) { const b = backup(path.join(DATA, f)); if (b) report.steps.backup.push(b); }

    // ② pro 编译产物预检
    say('[2] pro 编译产物预检');
    const pro = {
      exe: path.join(ROOT, 'pro', 'leizai-pro.exe'),
      manifest: path.join(ROOT, 'pro', 'manifest.json'),
      pub: path.join(ROOT, 'pro', 'manifest.pub'),
      toolcap: path.join(ROOT, 'src', 'pro', 'toolcap.js'),
    };
    report.steps.proAssets = {};
    for (const k of Object.keys(pro)) report.steps.proAssets[k] = fs.existsSync(pro[k]);
    if (!report.steps.proAssets.toolcap) { report.warnings.push('缺 src/pro/toolcap.js → 工具门禁 fail-closed（新版 tools.js 惰性兜底已不崩，但能力全拒）。必须随包。'); }
    if (!report.steps.proAssets.exe) report.warnings.push('缺 pro/leizai-pro.exe → enforce 态落 Lite(no-pro-module)，不崩。');
    if (!report.steps.proAssets.manifest || !report.steps.proAssets.pub) report.warnings.push('缺 manifest/manifest.pub → 完整性互校不可用（发布态 fail-closed 降 Lite）。');
    say('  ' + JSON.stringify(report.steps.proAssets));

    // ③ branch.db 数据预检 + 兼容补列
    say('[3] 数据预检 + 兼容补列');
    report.steps.db = {};
    const brDb = path.join(DATA, 'branch.db');
    if (fs.existsSync(brDb)) {
      try {
        const D = require('node:sqlite').DatabaseSync;
        const db = new D(brDb);
        let cols = tableCols(db, 'branch_event');
        if (cols) {
          report.steps.db.branchBefore = [...cols];
          const missing = BRANCH_BASE_COLS.filter(([c]) => !cols.has(c));
          if (missing.length) {
            say('  branch_event 缺基础列: ' + missing.map((m) => m[0]).join(',') + ((!heal || dryRun) ? '（跳过补列）' : ' → 补列'));
            if (heal && !dryRun) for (const [c, t] of missing) { try { db.exec('ALTER TABLE branch_event ADD COLUMN ' + c + ' ' + t); } catch (e) { report.warnings.push('补列 ' + c + ' 失败: ' + e.message); } }
            cols = tableCols(db, 'branch_event');
          }
          report.steps.db.branchAfter = [...cols];
        } else report.steps.db.branch = 'no-branch_event-table(old/empty)';
        try { const r = db.prepare('PRAGMA integrity_check').get(); report.steps.db.integrity = r && (r.integrity_check || Object.values(r)[0]); } catch { }
        db.close();
      } catch (e) { report.warnings.push('branch.db 处理异常: ' + e.message); }
    } else say('  (无 branch.db)');

    // ④ 报告 + 回退脚本
    say('[4] 产出报告 + 回退脚本');
    const outDir = path.join(DATA, OUT_DIRNAME);
    const rb = ['@echo off', 'REM P2 升级迁移回退（把 .bak_p2mig_' + TS + ' 还原为原名）', 'setlocal'];
    for (const b of report.steps.backup) { const orig = b.replace(/\.bak_p2mig_\d+$/, ''); rb.push('copy /Y "' + b + '" "' + orig + '"'); }
    rb.push('echo done & pause');
    if (!dryRun) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'rollback.cmd'), rb.join('\r\n'), 'utf8');
      fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    }
    say('  报告: ' + path.join(outDir, 'report.json') + ' ; 回退: ' + path.join(outDir, 'rollback.cmd'));
    return report;
  } catch (e) {
    report.ok = false; report.error = String((e && e.message) || e);
    say('  ! 迁移异常（不阻断）：' + report.error);
    return report;
  }
}

/** 是否产品/发布态（dev 不触发）。 */
function isReleaseCtx() {
  try { if (process.env.LEIZAI_RELEASE === '1') return true; } catch { }
  try { return require('./pro/gate').isReleaseBuild(); } catch { }
  try { return fs.existsSync(path.join(require('./paths').CODE_ROOT, '.release')); } catch { }
  return false;
}

/** 当前构建版本标识（用于版本跳跃判据）：.srcver > package.json.version。 */
function currentVersion(root) {
  try { const v = fs.readFileSync(path.join(root, '.srcver'), 'utf8').trim(); if (v) return 'srcver:' + v; } catch { }
  try { const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); if (pkg.version) return 'pkg:' + pkg.version; } catch { }
  return '';
}

/**
 * 启动自检入口（server.js 调用）：仅发布态 + 版本跳跃时运行；幂等；**绝不阻断启动**。
 * @returns {object} {skipped}|report
 */
function maybeRunOnBoot(/* cfg */) {
  try {
    if (!isReleaseCtx()) return { skipped: 'not-release' };
    const root = require('./paths').CODE_ROOT;
    const dataDir = require('./config').DATA_DIR;
    const cur = currentVersion(root);
    const stampFile = path.join(dataDir, STAMP_NAME);
    let last = ''; try { last = fs.readFileSync(stampFile, 'utf8').trim(); } catch { }
    if (cur && cur === last) return { skipped: 'same-version', version: cur };
    const report = runUpgrade({ root, dataDir, dryRun: false, heal: true, log: (s) => { try { console.log('[upgrade] ' + s); } catch { } } });
    if (report.ok && cur) { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(stampFile, cur, 'utf8'); } catch { } }
    if (!report.ok) { try { console.warn('[upgrade] 迁移未通过（不阻断启动）：' + (report.error || (report.warnings || []).join('; '))); } catch { } }
    return report;
  } catch (e) {
    try { console.warn('[upgrade] 异常已忽略（不阻断）：' + (e && e.message)); } catch { }
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { runUpgrade, maybeRunOnBoot, isReleaseCtx, currentVersion, BRANCH_BASE_COLS };

// —— CLI（隔离/运维手工跑）——
if (require.main === module) {
  const a = (n, d) => { const i = process.argv.indexOf('--' + n); if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; } return d; };
  const r = runUpgrade({
    dataDir: a('data', undefined),
    root: a('root', undefined),
    dryRun: !!a('dry-run', false),
    heal: !a('no-heal', false),
  });
  console.log('DONE ok=' + r.ok + (r.error ? ' error=' + r.error : ''));
  process.exit(r.ok ? 0 : 1);
}
