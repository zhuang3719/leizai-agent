#!/usr/bin/env node
/**
 * 雷仔 · Pro 完整性 manifest 工具（P3-c）
 * ---------------------------------------------------------------------------
 * 用法：
 *   node scripts/pro-manifest.mjs generate   # 生成 pro/manifest.json + pro/manifest.pub（需私钥，仅构建机）
 *   node scripts/pro-manifest.mjs verify     # 验签 + 逐文件互校（启动互校等价；退出码 0=通过 1=不通过）
 *
 * 私钥来源（**绝不落仓/绝不打印**）：env `LEIZAI_PRO_MANIFEST_SK`(base64 PKCS8)
 *   > env `LEIZAI_PRO_MANIFEST_SK_FILE`(路径) > `<构建机本地>/keys/signing_key_pkcs8.b64`（构建机本地，gitignore）
 * 公钥：写入 `pro/manifest.pub`（base64 SPKI DER，可入仓/随包）。
 *
 * 依据：workspace/doc/P3-Pro硬防护-定案.md §1/§4。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { canonical, verifyIntegrity } = require('../src/pro/integrity.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.LEIZAI_ROOT ? path.resolve(process.env.LEIZAI_ROOT) : path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'pro', 'manifest.json');
const PUBFILE = path.join(ROOT, 'pro', 'manifest.pub');
const SCHEMA = 'leizai-pro-manifest/1';
const VERSION = 'p3c-1';

/** 受保护文件（相对 ROOT）——单一权威清单 */
const PROTECTED = [
  'src/pro/gate.js',
  'src/pro/proclient.js',
  'src/pro/integrity.js',
  'pro/leizai-pro.exe',
  'LeiZai.exe',
];

const DEFAULT_SK = '';   // 本机私钥路径不硬编码；构建机用 env LEIZAI_PRO_MANIFEST_SK_FILE 指定

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function loadPrivateKey() {
  if (process.env.LEIZAI_PRO_MANIFEST_SK && process.env.LEIZAI_PRO_MANIFEST_SK.trim()) {
    return Buffer.from(process.env.LEIZAI_PRO_MANIFEST_SK.trim(), 'base64');
  }
  const f = process.env.LEIZAI_PRO_MANIFEST_SK_FILE || (fs.existsSync(DEFAULT_SK) ? DEFAULT_SK : '');
  if (!f || !fs.existsSync(f)) throw new Error('私钥不可用：设 env LEIZAI_PRO_MANIFEST_SK(base64)/LEIZAI_PRO_MANIFEST_SK_FILE');
  return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64');
}

function generate() {
  const skDer = loadPrivateKey();
  const priv = crypto.createPrivateKey({ key: skDer, format: 'der', type: 'pkcs8' });   // Ed25519
  const pubSpki = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });

  const files = PROTECTED.map((rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) throw new Error('受保护文件缺失: ' + rel);
    return { path: rel, size: fs.statSync(abs).size, sha256: sha256File(abs) };
  });

  const m = { schema: SCHEMA, algo: 'sha256', sig_algo: 'ed25519', version: VERSION, generatedAt: Date.now(), files };
  const sig = crypto.sign(null, Buffer.from(canonical(m), 'utf8'), priv);
  m.signature = sig.toString('base64');

  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2), { encoding: 'utf8' });
  fs.writeFileSync(PUBFILE, pubSpki.toString('base64') + '\n', { encoding: 'utf8' });

  console.log('[generate] manifest ->', MANIFEST);
  console.log('[generate] pubkey   ->', PUBFILE);
  console.log('[generate] files x' + files.length + ' | version=' + VERSION);
  for (const f of files) console.log('    ' + f.sha256.slice(0, 16) + '  ' + f.path);
  console.log('[generate] signature(b64)=' + m.signature);
  console.log('[generate] pubkey_spki_b64=' + pubSpki.toString('base64'));
}

function verify() {
  const v = verifyIntegrity({ root: ROOT });
  console.log('[verify] root=' + ROOT);
  console.log('[verify] sigOk=' + v.sigOk + ' manifestOk=' + v.manifestOk + ' checked=' + v.checked + ' ok=' + v.ok + ' reason=' + v.reason);
  if (v.tampered.length) console.log('[verify] tampered=' + JSON.stringify(v.tampered, null, 2));
  if (v.missing.length) console.log('[verify] missing=' + JSON.stringify(v.missing));
  process.exit(v.ok ? 0 : 1);
}

const cmd = (process.argv[2] || 'verify').toLowerCase();
try {
  if (cmd === 'generate') generate();
  else if (cmd === 'verify') verify();
  else { console.error('usage: node scripts/pro-manifest.mjs generate|verify'); process.exit(2); }
} catch (e) {
  console.error('[manifest] ERROR: ' + (e && e.message ? e.message : e));
  process.exit(3);
}
