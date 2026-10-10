'use strict';
// 雷仔 · 集成测试（假设服务器已在运行）
// 用法: node scripts/integration-test.mjs
// 自建数据（会话/目标）在 finally 中自动清理，测试不留垃圾。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(ROOT, 'config.json'), 'utf8'));
const BASE = `http://127.0.0.1:${config.port}`;

const results = [];
// 测试自建资源登记：结束后统一清理（会话删除会连带归档/项目文件；目标先 stop 再删任务文件与会话）
const createdSessions = [];
const createdGoals = [];   // { id }（其 sessionId 从 goal 详情/列表里读，一并清理）

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  let j;
  try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!res.ok) throw new Error(`${res.status} ${j.error || JSON.stringify(j).slice(0, 200)}`);
  return j;
}

async function apiOrNull(method, p, body) {
  try { return await api(method, p, body); } catch { return null; }
}

async function chat(sessionId, message) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  });
  if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const blocks = buf.split('\n\n');
    buf = blocks.pop();
    for (const block of blocks) {
      let ev = 'message', data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) ev = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6).trim();
      }
      if (data) { try { events.push({ ev, data: JSON.parse(data) }); } catch { } }
    }
  }
  return events;
}

async function cleanup() {
  // 1) 目标：stop + 取其 sessionId（创建响应已带；兜底再从列表找）
  for (const g of createdGoals) {
    try { await apiOrNull('POST', `/api/goals/${g.id}/stop`, {}); } catch { }
    if (g.sessionId && !createdSessions.includes(g.sessionId)) createdSessions.push(g.sessionId);
  }
  // 2) 删除目标任务文件（goals API 无 DELETE 端点 → 直删文件）
  for (const g of createdGoals) {
    try {
      const { rm } = await import('node:fs/promises');
      await rm(path.join(ROOT, 'data', 'tasks', `${g.id}.json`), { force: true });
    } catch { }
  }
  // 3) 会话：删除（服务端会连带归档/项目文件/repl）
  for (const sid of createdSessions) {
    try { await apiOrNull('DELETE', `/api/sessions/${sid}`); } catch { }
  }
  if (createdSessions.length || createdGoals.length) {
    console.log(`\n[cleanup] 已清理测试数据: session=${createdSessions.length} goal=${createdGoals.length}`);
  }
}

console.log('== 雷仔集成测试 ==');

try {
  // 1. 健康
  try {
    const h = await api('GET', '/api/health');
    check('健康检查', h.ok && h.name === '雷仔');
    const s0 = await api('GET', '/api/stats');
    check('统计接口', typeof s0.calls === 'number');
  } catch (e) { check('健康检查', false, e.message); }

  // 2. 会话 + 两轮对话（验证缓存命中）
  try {
    const s = await api('POST', '/api/sessions', {});
    createdSessions.push(s.id);
    const ev1 = await chat(s.id, '你好！用一句话介绍你自己。');
    const done1 = ev1.find((e) => e.ev === 'done');
    check('第一轮对话完成', !!done1, done1 ? `text=${(done1.data.text || '').slice(0, 30)}` : '');
    const ev2 = await chat(s.id, '你怎么看我这个问题？一句话即可。');
    const done2 = ev2.find((e) => e.ev === 'done');
    const u = done2 && done2.data.usage;
    if (u) {
      const rate = u.hitTokens / Math.max(u.hitTokens + u.missTokens, 1);
      check('第二轮缓存命中 > 60%', rate > 0.6, `hit=${u.hitTokens} miss=${u.missTokens} 命中率=${(rate * 100).toFixed(1)}%`);
    } else {
      check('第二轮缓存命中 > 60%', false, '无 usage');
    }
    check('会话持久化', (await api('GET', `/api/sessions/${s.id}`)).messages.length >= 4);
  } catch (e) { check('对话链路', false, e.message); }

  // 3. 进化引擎（直测模块：propose → approve → rollback）
  try {
    const evo = await import('../src/evolution.js');
    const { rawGenome } = await import('../src/prompt.js');
    const before = rawGenome();
    const anchor = before.match(/^## [^\n]+/m)?.[0] || '## 身份特征';
    const p = evo.propose({ target: 'system.md', title: '测试提案: 在开头加一行注释', rationale: '集成测试', patch: { old: anchor, new: `<!-- evo-test -->\n${anchor}` } });
    evo.approve(p.id, { auto: true });
    const after = rawGenome();
    check('进化：提案+批准生效', after.includes('<!-- evo-test -->'));
    evo.rollback(p.id);
    check('进化：回滚恢复', rawGenome() === before, 'hash 一致');
  } catch (e) { check('进化引擎', false, e.message); }

  // 4. 记忆/技能 API
  try {
    await api('POST', '/api/memory', { name: 'itest-记忆', content: '集成测试记忆条目' });
    const mem = await api('GET', '/api/memory');
    check('记忆 API', mem.some((m) => m.name === 'itest-记忆'));
    await api('DELETE', '/api/memory?name=itest-记忆');
  } catch (e) { check('记忆 API', false, e.message); }

  // 5. 自治目标（小任务，最多3轮）
  try {
    const g = await api('POST', '/api/goals', { objective: '请用一句话回答：1+1 等于几？然后回复【完成】并停止。', maxRounds: 3 });
    createdGoals.push({ id: g.id, sessionId: g.sessionId || null });
    check('目标已创建', g.id && g.status === 'active', g.id);
    const t0 = Date.now();
    let gs = null;
    while (Date.now() - t0 < 6 * 60 * 1000) {
      gs = await api('GET', '/api/goals');
      const me = gs.find((x) => x.id === g.id);
      if (me && (me.status === 'done' || me.status === 'stopped' || me.status === 'failed')) { gs = me; break; }
      await new Promise((r) => setTimeout(r, 4000));
    }
    check('目标自动完成', gs && (gs.status === 'done' || gs.status === 'stopped'), gs ? `status=${gs.status} round=${gs.round}` : 'timeout');
    if (gs && gs.status === 'active') { try { await api('POST', `/api/goals/${g.id}/stop`); } catch { } }
  } catch (e) { check('自治目标', false, e.message); }

  // 6. 进化接口（HTTP 侧读）
  try {
    const feed = await api('GET', '/api/evolution/feed');
    check('进化日志接口', Array.isArray(feed));
  } catch (e) { check('进化日志接口', false, e.message); }
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n== 结果: ${results.length - failed}/${results.length} 通过 ${failed ? '（有失败项）' : '🎉 全部通过'} ==`);
process.exit(failed ? 1 : 0);
