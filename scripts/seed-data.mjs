#!/usr/bin/env node
// 雷仔 · 首启播种（P1 布局方案A）
// 用法: node scripts/seed-data.mjs --from <旧目录> --to <新目录>
// 纪律：幂等(.seeded) / 只 copy 不 move / 原子 rename / 失败不丢数据 / 可重跑。
'use strict';
import fs from 'node:fs';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i].replace(/^--/, '');
  args[k] = process.argv[i + 1];
}
const from = args.from ? path.resolve(args.from) : null;
const to = args.to ? path.resolve(args.to) : null;

const log = (m) => console.log('[seed] ' + m);
const fail = (m) => { console.error('[seed][FAIL] ' + m); process.exit(1); };

if (!from || !to) fail('用法: node seed-data.mjs --from <旧目录> --to <新目录>');
if (!fs.existsSync(from)) fail('来源目录不存在: ' + from);
if (from.toLowerCase() === to.toLowerCase()) { log('来源=目标，跳过'); process.exit(0); }

const marker = path.join(to, '.seeded');
if (fs.existsSync(marker)) { log('已播种(.seeded 存在)，跳过: ' + to); process.exit(0); }

// 目标非空且无标记 → 保守跳过（绝不覆盖已有数据）
if (fs.existsSync(to)) {
  const items = fs.readdirSync(to).filter((x) => x !== '.seeded');
  if (items.length > 0) { log('目标非空且无 .seeded 标记，保守跳过（不覆盖）: ' + to); process.exit(0); }
}

// 搬什么（不搬 src/node_modules/exe/dll/_bak*/_tmp*/webview2-data）
const COPY = ['config.json', 'config.common.json', 'data', 'workspace', 'projects', 'logs'];
const existed = COPY.filter((name) => fs.existsSync(path.join(from, name)));
if (existed.length === 0) { log('来源无任何待搬项，跳过: ' + from); process.exit(0); }

const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const stage = to + '.seeding-' + ts;
try {
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const name of existed) {
    fs.cpSync(path.join(from, name), path.join(stage, name), { recursive: true });
    log('copy ' + name);
  }
  // 原子落地：同盘 rename
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to)) fs.rmdirSync(to); // 仅当为空（上面已校验）
  fs.renameSync(stage, to);
  fs.writeFileSync(marker, JSON.stringify({ from, to, at: new Date().toISOString(), items: existed }, null, 2), 'utf8');
  log('OK 播种完成 → ' + to + ' (items: ' + existed.join(',') + ')');
} catch (e) {
  // 失败：来源数据未动，目标保持原状；保留 stage 供排查
  fail('播种失败（来源未改动，目标保持原状）: ' + e.message);
}
