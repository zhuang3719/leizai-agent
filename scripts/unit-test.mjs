// 雷仔 · 单元测试（无网络 / 无服务器 / 不改生产数据）
// 覆盖：Provider 解析、配置默认值、细粒度权限、记忆相关度排序、进化门禁决策逻辑。
// 用法: node scripts/unit-test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = require('node:path');
const providersMod = require('../src/providers.js');
const { resolve: resolveProvider } = providersMod;
const config = require('../src/config.js');
const memory = require('../src/memory.js');
const evolution = require('../src/evolution.js');
const tools = require('../src/tools.js');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); };

// ———— 1. Provider 解析 ————
{
  const d = resolveProvider({ provider: 'deepseek' });
  check('deepseek 默认 baseURL', d.baseURL === 'https://api.deepseek.com', d.baseURL);
  check('deepseek 默认 thinkingFormat=deepseek', d.thinkingFormat === 'deepseek', d.thinkingFormat);
  check('deepseek 默认模型含 flash', d.model === 'deepseek-v4-flash', d.model);
  check('deepseek openaiCompatible', d.openaiCompatible === true);
  const o = resolveProvider({ provider: 'openai' });
  check('openai thinkingFormat=none', o.thinkingFormat === 'none', o.thinkingFormat);
  const c = resolveProvider({ provider: 'deepseek', baseURL: 'https://my.gateway/v1', model: 'my-model', models: ['a', 'b'] });
  check('显式配置覆盖 baseURL/model', c.baseURL === 'https://my.gateway/v1' && c.model === 'my-model' && c.models.length === 2, c.baseURL);
  const fallback = resolveProvider({ provider: 'grok' });
  check('未知 provider fallback 到 custom 默认', String(fallback.label).toLowerCase().includes('custom'), fallback.label);
  check('provider 目录含 deepseek/openai/custom', ['deepseek', 'openai', 'custom'].every((p) => providersMod.SUPPORTED.includes(p)), JSON.stringify(providersMod.SUPPORTED));
}

// ———— 2. 配置默认值（新增字段） ————
{
  const cfg = config.load();
  check('provider 默认 deepseek', cfg.provider === 'deepseek', String(cfg.provider));
  check('allowedPaths 默认空数组', Array.isArray(cfg.allowedPaths) && cfg.allowedPaths.length === 0, JSON.stringify(cfg.allowedPaths));
  check('protectedPaths 默认空数组', Array.isArray(cfg.protectedPaths) && cfg.protectedPaths.length === 0, JSON.stringify(cfg.protectedPaths));
  check('protectedCommands 默认空数组', Array.isArray(cfg.protectedCommands) && cfg.protectedCommands.length === 0, JSON.stringify(cfg.protectedCommands));
  check('evolutionGate 默认空串', cfg.evolutionGate === '' || cfg.evolutionGate === undefined, String(cfg.evolutionGate));
  check('reflectionAuto 默认 true', cfg.reflectionAuto === true, String(cfg.reflectionAuto));
  check('reflectionEnabled 默认 true', cfg.reflectionEnabled === true, String(cfg.reflectionEnabled));
  check('fullAccess 字段仍存在', typeof cfg.fullAccess === 'boolean', String(cfg.fullAccess));
}

// ———— 3. 细粒度权限（resolvePath / assertWritable） ————
{
  const wd = config.load().workdir || 'C:\\x';
  // fullAccess=true：任意路径放行
  check('fullAccess 任意路径放行', (() => { try { tools.resolvePath(wd, 'C:\\Windows\\win.ini', { fullAccess: true }); return true; } catch { return false; } })());
  // fullAccess=false：越界拦截
  check('非 fullAccess 越界拦截', (() => { try { tools.resolvePath(wd, 'C:\\Windows\\win.ini', { fullAccess: false, allowedPaths: [] }); return false; } catch { return true; } })());
  // fullAccess=false + allowedPaths 放行
  check('allowedPaths 放行', (() => { try { tools.resolvePath(wd, 'C:\\allowed\\file.txt', { fullAccess: false, allowedPaths: ['C:\\allowed'] }); return true; } catch { return false; } })());
  // protectedPaths 写入拦截
  check('protectedPaths 写入拦截', (() => { try { tools.assertWritable('C:\\protected\\a.txt', { protectedPaths: ['C:\\protected'] }); return false; } catch { return true; } })());
  check('非 protected 写入放行', (() => { try { tools.assertWritable('C:\\ok\\a.txt', { protectedPaths: ['C:\\protected'] }); return true; } catch { return false; } })());
}

// ———— 4. 记忆相关度排序 ————
{
  const name = 'unit-临时-测试记忆';
  try {
    memory.erase('memory', name);
    memory.save('memory', name, '这是一条关于雷仔与主人的测试记忆，涉及闪电风格与自我进化能力。');
    // 查询用本测试独有的短语（真实记忆库有大量含"进化"的记忆，同分时按片段长度平局排序，
    // 会被真实长片段挤出 limit——测试必须数据无关）
    const r1 = memory.search('闪电风格 自我进化能力', { kind: 'memory', limit: 6 });
    check('记忆命中目标词', r1.some((h) => h.name === name), JSON.stringify(r1.map((h) => h.name)));
    check('记忆带 score 字段', r1.length === 0 || typeof r1[0].score === 'number', JSON.stringify(r1[0] || {}));
    const r2 = memory.search('完全不相关xyzq', { kind: 'memory', limit: 3 });
    check('无关词返回空', r2.length === 0, JSON.stringify(r2));
    // 部分匹配也应返回（不再是"全词必须命中"）
    const r3 = memory.search('闪电风格', { kind: 'memory', limit: 6 });
    check('单个词部分匹配命中', r3.some((h) => h.name === name), JSON.stringify(r3.map((h) => h.name)));
  } finally {
    memory.erase('memory', name);
  }
}

// ———— 5. 进化门禁决策逻辑 ————
{
  // 空门禁 → 放行（不 spawn）
  const g0 = await evolution.runGate('');
  check('空门禁放行', g0.pass === true, JSON.stringify(g0));
  // 非空门禁有输出字段
  const g1 = await evolution.runGate('exit 0', 5000);
  check('exit 0 门禁结果字段完整', typeof g1.pass === 'boolean' && typeof g1.code === 'number', JSON.stringify(g1));
}

// ———— 6. 插件机制（自定义工具热加载） ————
{
  const fsm = require('node:fs');
  const pm = require('node:path');
  const pd = tools.PLUGIN_DIR;
  const file = pm.join(pd, '_unittest_plugin.js');
  const code = `module.exports={tool:{name:'unit_plugin_echo',description:'test',parameters:{type:'object',properties:{x:{type:'string'}},required:[]},async execute(args){return 'PLUGIN_OK:'+(args&&args.x||'');}}};`;
  try {
    fsm.writeFileSync(file, code, 'utf8');
    const n = tools.reloadPlugins();
    const def = tools.definitions().find((d) => d.function.name === 'unit_plugin_echo');
    check('插件注册成功', n >= 1 && !!def, 'n=' + n);
    const r = await tools.exec('unit_plugin_echo', { x: 'Z' }, {});
    check('插件 execute 执行', r === 'PLUGIN_OK:Z', r);
  } finally {
    try { fsm.unlinkSync(file); } catch { }
    tools.reloadPlugins();
  }
  const def2 = tools.definitions().find((d) => d.function.name === 'unit_plugin_echo');
  check('移除插件后不再注册', !def2);
}

// ———— 7. 补充态 harness + 不可变基因组 ——
{
  const prompt = require('../src/prompt.js');
  const fsm = require('node:fs');
  const hp = prompt.HARNESS_PATH;
  const orig = fsm.existsSync(hp) ? fsm.readFileSync(hp, 'utf8') : '';
  let pid = null;
  try {
    fsm.writeFileSync(hp, '补充：遇到不确定时先读后写。', 'utf8');
    const sp = prompt.systemPrompt().full;
    check('harness 进入系统提示词', sp.includes('补充规则与沉淀') && sp.includes('遇到不确定时先读后写'), 'len=' + sp.length);
    const p = evolution.propose({ target: 'harness', title: '补充态示例', rationale: '验证 harness 进化', content: '补充：已实践验证。' });
    pid = p.id;
    await evolution.approve(p.id, { auto: true });
    check('harness 进化生效', fsm.readFileSync(hp, 'utf8').includes('已实践验证'));
    check('harness 进化后进入提示词', prompt.systemPrompt().full.includes('已实践验证'));
  } finally {
    try { if (pid) fsm.unlinkSync(path.join(config.ROOT, 'data', 'evolution', 'proposals', pid + '.json')); } catch { }
    try { if (pid) fsm.unlinkSync(path.join(config.ROOT, 'data', 'evolution', 'versions', pid + '.json')); } catch { }
    try { fsm.writeFileSync(hp, orig, 'utf8'); } catch { }
  }
}

// ———— 8. Python REPL 内核快照/恢复（跨重启） ————
{
  const repl = require('../src/repl.js');
  const fsm = require('node:fs');
  const sid = 'unit-kernel-test';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await repl.evalCode(sid, 'x = 41; y = "hello"', { timeoutMs: 20000 });
    const s1 = await repl.evalCode(sid, 'print(x, y)', { timeoutMs: 20000 });
    check('REPL 变量跨调用保留', (s1.stdout || '').includes('41') && (s1.stdout || '').includes('hello'), s1.stdout);
    const snap = await repl.snapshot(sid);
    const f = repl.kernelFile(sid);
    check('快照生成并落盘', snap.ok === true && fsm.existsSync(f) && fsm.statSync(f).size > 0, JSON.stringify(snap));
    repl.restart(sid);           // 模拟崩溃/重启（不删快照）
    await sleep(600);
    const s2 = await repl.evalCode(sid, 'print(x)', { timeoutMs: 20000 });
    check('重启后从快照恢复内核状态', (s2.stdout || '').includes('41'), s2.stdout);
  } finally {
    try { repl.kill(sid); } catch { }
  }
}

// ———— 9. MCP 客户端（stdio JSON-RPC） ————
{
  const mcp = require('../src/mcp.js');
  const mockPath = path.join(process.cwd(), 'scripts', 'mock-mcp.mjs');
  const cfg = { name: 'mock', command: process.execPath, args: [mockPath] };
  try {
    const tools = await mcp.listTools('mock', cfg);
    check('MCP tools/list 列出工具', tools.length === 1 && tools[0].name === 'greet', JSON.stringify(tools));
    const res = await mcp.call('mock', 'greet', { name: '雷仔' }, cfg);
    check('MCP tools/call 调用', String(res).includes('Hello, 雷仔'), res);
  } finally {
    try { mcp.closeAll(); } catch { }
  }
}

const failed = results.filter((x) => !x.ok).length;
console.log(`\n== 单元测试: ${results.length - failed}/${results.length} 通过 ==`);
process.exit(failed ? 1 : 0);
