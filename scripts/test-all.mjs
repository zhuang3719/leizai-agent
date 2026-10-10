// 雷仔 · 全面测试套件（单元 + 集成 + 端到端精简）
// 用法: node scripts/test-all.mjs   （服务器需已运行）
import { readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(ROOT, 'config.json'), 'utf8'));
const BASE = `http://127.0.0.1:${config.port}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};
const warn = (name, detail = '') => {
  results.push({ name, ok: true, warn: true });
  console.log(`⚠️  ${name}（警告，不阻塞） — ${detail}`);
};

/* ============ A. 单元测试（无需服务器） ============ */
console.log('== A. 单元测试 ==');
try {
  const tools = require('../src/tools.js');
  const cfg0 = require('../src/config.js').load();
  const ctx = { workdir: cfg0.workdir, cfg: cfg0, sessionId: 'unit' }; // fullAccess=true
  const ctxS = { workdir: cfg0.workdir, cfg: { ...cfg0, fullAccess: false }, sessionId: 'unit-sandbox' };
  // 1. 最大权限：越界路径放行（fullAccess） / 沙箱模式：拒绝
  const rF = await tools.exec('read_file', { path: 'C:\\Windows\\win.ini' }, ctx);
  check('最大权限：任意路径可读（C:\\Windows\\win.ini）', rF.includes('for 16-bit'), rF.slice(0, 40));
  let blocked = false;
  try { await tools.exec('read_file', { path: 'C:\\Windows\\win.ini' }, ctxS); } catch { blocked = true; }
  check('沙箱模式（fullAccess=false）：越界路径被拒绝', blocked);
  // 2. 最大权限：危险命令黑名单不拦截（用含"shutdown"的无害 echo 验证放行）
  const r2 = await tools.exec('run_command', { command: 'echo shutdown-test-OK' }, ctx);
  check('最大权限：危险命令放行（黑名单跳过）', r2.includes('shutdown-test-OK'), r2.slice(0, 60));
  // 3. 沙箱模式：危险命令拦截
  blocked = false;
  try { await tools.exec('run_command', { command: 'echo shutdown-test-OK' }, ctxS); } catch { blocked = true; }
  check('沙箱模式：危险命令被拦截', blocked);
  // 4. 正常命令（PowerShell 执行器，UTF-8 中文输出）
  const r1 = await tools.exec('run_command', { command: 'echo HELLO-雷仔-OK' }, ctx);
  check('run_command 正常执行（UTF-8 中文）', r1.includes('HELLO-雷仔-OK') && r1.includes('exit=0'), r1.slice(0, 80));
  // 5. 文件往返
  await tools.exec('write_file', { path: 'unit-test.txt', content: 'line1\nNEEDLE-42\nline3' }, ctx);
  const rd = await tools.exec('read_file', { path: 'unit-test.txt' }, ctx);
  const ed = await tools.exec('edit_file', { path: 'unit-test.txt', old: 'NEEDLE-42', new: 'PATCHED-42' }, ctx);
  const rd2 = await tools.exec('read_file', { path: 'unit-test.txt' }, ctx);
  const sr = await tools.exec('search_files', { pattern: 'PATCHED', path: '.' }, ctx);
  check('文件工具 写/读/编辑一致', rd2.includes('PATCHED-42') && rd.includes('NEEDLE-42') && ed.includes('1 处'));
  check('search_files 命中', sr.includes('unit-test.txt'));
  try { await unlink(path.join(config.workdir, 'unit-test.txt')); } catch { }
  // 6. 进化引擎（propose/reject/rollback/日志）
  const evo = require('../src/evolution.js');
  const { rawGenome } = require('../src/prompt.js');
  const before = rawGenome();
  const anchor = before.match(/^## [^\n]+/m)?.[0] || '## 身份特征';
  const p1 = evo.propose({ target: 'system.md', title: '全测·提案A', rationale: 'unit', patch: { old: anchor, new: `<!-- unit-a -->\n${anchor}` } });
  evo.approve(p1.id, { auto: true });
  const mid = rawGenome();
  evo.rollback(p1.id);
  check('进化：批准→生效', mid !== before);
  check('进化：回滚→原样', rawGenome() === before);
  let rejOk = false;
  try {
    const p2 = evo.propose({ target: 'system.md', title: '全测·提案B', rationale: 'unit', patch: { old: anchor, new: `<!-- unit-b -->\n${anchor}` } });
    evo.reject(p2.id);
    rejOk = evo.list().find((x) => x.id === p2.id).status === 'rejected';
  } catch { }
  check('进化：否决流程', rejOk);
  // 7. 记忆检索
  const memory = require('../src/memory.js');
  memory.save('memory', 'unit-mem', '雷仔单元测试专用条目 ZEBRA-77');
  const memHit = memory.search('ZEBRA', { kind: 'memory' }).length > 0;
  check('记忆库检索', memHit);
  memory.erase('memory', 'unit-mem');
  // 8. 系统提示词稳定性（缓存前缀纪律）
  const { systemPrompt } = require('../src/prompt.js');
  const a = systemPrompt(), b = systemPrompt();
  check('稳定前缀：两次构建字节一致', a.hash === b.hash, `hash=${a.hash}`);
  // 9. Python REPL 内核（持久状态）
  const rp1 = await tools.exec('python_repl', { code: 'x = 40\nprint("A1", x)' }, ctx);
  if (String(rp1).includes('[Python 错误]') || String(rp1).includes('无法启动')) {
    warn('python_repl 不可用（本机未安装 Python 或 pythonPath 未配置）', String(rp1).slice(0, 120));
  } else {
    check('python_repl 执行', rp1.includes('A1 40'), String(rp1).slice(0, 60));
    const rp2 = await tools.exec('python_repl', { code: 'print("A2", x + 2)' }, ctx);
    check('python_repl 状态持久（跨调用保留变量）', rp2.includes('A2 42'), String(rp2).slice(0, 60));
    const rp3 = await tools.exec('python_repl', { code: 'raise ValueError("boom")' }, ctx);
    check('python_repl 异常返回 traceback', rp3.includes('boom'));
  }
  // 10. 可执行技能包（save 带 code → run_skill）
  memory.save('skill', 'unit-skill', '单元测试技能', { description: 'unit test', code: 'def main(a):\n    n = a.get("n", 0)\n    return f"skill result {n}"' });
  const rs = await tools.exec('run_skill', { name: 'unit-skill', args: { n: 7 } }, ctx);
  check('run_skill 执行技能包', rs.includes('skill result 7'), String(rs).slice(0, 80));
  memory.erase('skill', 'unit-skill');
  // 11. agent 间直接通信（信箱投递/收取）
  const sub = require('../src/subagent.js');
  sub.send('unit-agent-test', '你好，请继续工作', 'tester');
  const got = sub.inbox('unit-agent-test');
  check('agent 间通信（投递→收取）', got.includes('你好，请继续工作'), String(got).slice(0, 60));
  // 12. 调度器（创建/停止）
  const sched = require('../src/scheduler.js');
  const hb = sched.createHeartbeat('unit-sched-session', 60, '单元测试心跳');
  check('调度：心跳创建', hb.id && hb.type === 'heartbeat' && hb.nextRun > Date.now());
  const at = sched.createAt('unit-sched-session', '23:59', '单元测试定时', { repeats: true });
  check('调度：定时创建（HH:MM 每天）', at.id && at.type === 'at');
  sched.remove(hb.id); sched.remove(at.id);
  check('调度：删除', sched.list().filter((x) => x.id === hb.id || x.id === at.id).length === 0);
} catch (e) { check('单元测试组', false, e.message); }

/* ============ B. 集成测试（HTTP） ============ */
console.log('\n== B. 集成测试 ==');
const testSids = [];   // 本套件创建的测试会话（结束时统一删除，不污染雷仔数据层）
async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!res.ok) throw new Error(`${res.status} ${j.error || JSON.stringify(j).slice(0, 200)}`);
  return j;
}
async function chat(sessionId, message, extra = {}) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message, ...extra }),
  });
  if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
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

try {
  const h = await api('GET', '/api/health');
  check('健康检查', h.ok && h.name === '雷仔');
  const c0 = await api('GET', '/api/config');
  check('配置读取（含 reasoningEffort）', typeof c0.reasoningEffort === 'string', c0.reasoningEffort);
  check('最大权限模式（fullAccess=true）', c0.fullAccess === true);
  // 配置写回（温度往返）
  const t0 = c0.temperature;
  await api('PUT', '/api/config', { temperature: t0 + 0.1 });
  const c1 = await api('GET', '/api/config');
  check('配置写入（PUT→GET 往返）', Math.abs(c1.temperature - (t0 + 0.1)) < 1e-9);
  await api('PUT', '/api/config', { temperature: t0 });
} catch (e) { check('配置组', false, e.message); }

// —— 对话 + 缓存命中 ——
let sess;
try {
  sess = await api('POST', '/api/sessions', {});
  testSids.push(sess.id);
  const e1 = await chat(sess.id, '你好！一句话介绍自己。');
  check('第一轮对话流式完成', e1.some((x) => x.ev === 'delta') && e1.some((x) => x.ev === 'done'));
  const e2 = await chat(sess.id, '继续：用一句话说说你的能力。');
  const d2 = e2.find((x) => x.ev === 'done');
  const u = d2?.data?.usage;
  const rate = u ? u.hitTokens / Math.max(u.hitTokens + u.missTokens, 1) : 0;
  check('第二轮缓存命中 > 60%', rate > 0.6, `hit=${u?.hitTokens} miss=${u?.missTokens} rate=${(rate * 100).toFixed(1)}%`);
} catch (e) { check('对话组', false, e.message); }

// —— 工具调用（agent 驱动 run_command） ——
try {
  const e = await chat(sess.id, '请调用 run_command 执行 echo LEIZAI-TOOL-TEST-123，然后把输出原样告诉我。不要做其他事。');
  const tool = e.find((x) => x.ev === 'tool');
  const tr = e.find((x) => x.ev === 'tool_result');
  check('agent 工具调用（run_command）', !!tool && tool.data.name === 'run_command' && !!tr);
  check('工具结果传递', tr ? tr.data.summary.includes('LEIZAI-TOOL-TEST-123') : false, tr?.data?.summary?.slice(0, 80));
} catch (e) { check('agent 工具调用组', false, e.message); }

// —— 子智能体（sync，全工具权限） ——
try {
  const e = await chat(sess.id, '请用 spawn_subagent（mode=sync，maxTurns=3）派一个子智能体做这件事：用 run_command 执行 echo SUBAGENT-WRITE-456，并回复 1+1 等于几。然后把子智能体的结果告诉我。');
  const evs = e.filter((x) => x.ev === 'tool');
  const sub = evs.find((x) => x.data.name === 'spawn_subagent');
  check('子智能体派出（sync）', !!sub, sub ? sub.data.args?.task?.slice(0, 30) : '');
  const agents = await api('GET', '/api/agents');
  const rec = agents.find((a) => a.role && a.id) || agents[0];
  check('子智能体结果落盘', agents.length > 0 && (rec?.status === 'done' || rec?.status === 'truncated'), rec ? `${rec.role} / ${rec.status}` : '');
} catch (e) { check('子智能体组', false, e.message); }

// —— 停止中断 + 会话解锁 ——
try {
  const s2 = await api('POST', '/api/sessions', {});
  testSids.push(s2.id);
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: s2.id, message: '请用至少 300 字详细介绍 DeepSeek 的上下文缓存机制，尽量写长一些。' }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let gotStarted = false;
  let stopped = false;
  const pump = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const blocks = buf.split('\n\n');
      buf = blocks.pop();
      for (const block of blocks) {
        if (block.includes('event: start')) gotStarted = true;
        if (block.includes('event: done') && block.includes('"stopped":true')) stopped = true;
      }
    }
  })();
  const t0 = Date.now();
  while (!gotStarted && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 100));
  await api('POST', '/api/stop', { sessionId: s2.id });
  await pump;
  check('停止中断（done.stopped）', stopped, `started=${gotStarted}`);
  const e3 = await chat(s2.id, '好了吗？一个字回复：好。');
  check('停止后会话解锁可继续', e3.some((x) => x.ev === 'done'));
} catch (e) { check('停止/解锁组', false, e.message); }

// —— 自治目标（小任务） ——
try {
  const g = await api('POST', '/api/goals', { objective: '请用一句话回答：2+2 等于几？完成后回复【完成】。', maxRounds: 3 });
  if (g && g.sessionId) testSids.push(g.sessionId);   // 目标绑定会话随测试会话一并删除（连带目标文件）
  const t0 = Date.now();
  let gs = null;
  while (Date.now() - t0 < 300000) {
    gs = (await api('GET', '/api/goals')).find((x) => x.id === g.id);
    if (gs && gs.status !== 'active') break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  check('自治目标完成', gs && gs.status !== 'active' && gs.status !== 'failed', gs ? `${gs.status} round=${gs.round}` : 'timeout');
} catch (e) { check('自治目标组', false, e.message); }

// —— 调度 API（创建/列表/停止） ——
try {
  const sid = sess ? sess.id : (await api('POST', '/api/sessions', {})).id;
  if (!sess) testSids.push(sid);
  const h1 = await api('POST', '/api/schedules', { sessionId: sid, message: '集成测试心跳', intervalSec: 60 });
  check('调度 API：心跳创建', h1.id && h1.type === 'heartbeat', h1.id);
  const a1 = await api('POST', '/api/schedules', { sessionId: sid, message: '集成测试定时', at: '23:58', repeats: true });
  check('调度 API：定时创建', a1.id && a1.type === 'at', a1.id);
  const sl = await api('GET', '/api/schedules');
  check('调度 API：列表', sl.some((x) => x.id === h1.id) && sl.some((x) => x.id === a1.id));
  await api('POST', `/api/schedules/${h1.id}/stop`);
  await api('POST', `/api/schedules/${a1.id}/stop`);
  check('调度 API：停止', (await api('GET', '/api/schedules')).filter((x) => x.id === h1.id || x.id === a1.id).length === 0);
} catch (e) { check('调度 API 组', false, e.message); }

// —— 网络工具（警告级） ——
try {
  const tools = require('../src/tools.js');
  const cfg0 = require('../src/config.js').load();
  const ctx = { workdir: cfg0.workdir, cfg: cfg0, sessionId: 'unit' };
  const wf = await tools.exec('web_fetch', { url: 'https://example.com' }, ctx);
  warn('web_fetch 可达性', wf.slice(0, 60));
  try {
    const ws = await tools.exec('web_search', { query: 'LeiZai' }, ctx);
    warn('web_search 可达性', ws.includes('[来源') ? ws.slice(0, 60) : 'no source');
  } catch (we) { warn('web_search 可达性（两源均失败，仅网络限制不影响主功能）', we.message.slice(0, 120)); }
} catch (e) { warn('网络工具组', e.message.slice(0, 120)); }

// —— 网页版已弃用 ——
try {
  const r = await fetch(BASE + '/');
  const j = await r.json().catch(() => ({}));
  check('网页版已弃用（根路径返回 410 + 提示）', r.status === 410 && /弃用/.test(j.error || ''), `status=${r.status}`);
  const r2 = await fetch(BASE + '/style.css');
  check('网页静态资源不再提供（410）', r2.status === 410, `status=${r2.status}`);
} catch (e) { check('网页版已弃用', false, e.message); }

/* ============ C. 客户端滚动回归（合成会话，无需服务器） ============ */
console.log('\n== C. 客户端滚动回归（scroll-test，合成会话） ==');
try {
  const rr = spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'scroll-test.ps1'), '-synthetic'],
    { encoding: 'utf8', timeout: 900000, cwd: ROOT });
  const out = `${rr.stdout || ''}\n${rr.stderr || ''}`;
  const ok = !out.includes('HARNESS EXCEPTION')
    && out.includes('FROZEN STEPS: 0')
    && out.includes('REVERSE/FWD STUCK=0')
    && out.includes('segments fit(<= 26000): True')
    && out.includes('content preserved: PASS');
  const tail = out.trim().split('\n').slice(-3).join(' | ');
  check('客户端滚动回归（全程无卡死/超长分段无损）', ok, `exit=${rr.status} ${tail.slice(0, 120)}`);
} catch (e) { check('客户端滚动回归', false, e.message); }

/* ============ 清理：删除本套件创建的测试会话（连带归档/项目夹/目标文件，不污染雷仔数据层） ============ */
try {
  for (const id of [...new Set(testSids.filter(Boolean))]) {
    try { await api('DELETE', '/api/sessions/' + id); console.log('  🧹 清理测试会话: ' + id); } catch { }
  }
} catch { }

const failed = results.filter((r) => !r.ok).length;
const warned = results.filter((r) => r.warn).length;
console.log(`\n== 结果: ${results.length - failed}/${results.length} 通过${warned ? `（${warned} 项警告）` : ''} ${failed ? '❌' : '🎉'} ==`);
process.exit(failed ? 1 : 0);
