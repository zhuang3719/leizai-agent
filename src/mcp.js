'use strict';
// 雷仔 · MCP (Model Context Protocol) 客户端（stdio 传输）
// 对齐 Prime Agent 的 MCP 集成：通过 config.mcpServers 配置 stdio 服务器，
// 暴露 mcp_list_tools / mcp_call 两个工具，让模型可调用外部 MCP 工具。
// 协议：stdin/stdout 上逐行 JSON-RPC 2.0；预留 Streamable HTTP 扩展位。
const { spawn } = require('node:child_process');
const { load } = require('./config');

const servers = new Map(); // name -> { proc, pending:Map(id->{resolve,timer}), nextId, ready }
const DEFAULT_TIMEOUT = 30000;

function serverConfig(name, override) {
  if (override) return override;
  const cfg = load();
  const list = Array.isArray(cfg.mcpServers) ? cfg.mcpServers : [];
  return list.find((s) => s && s.name === name) || null;
}

function ensure(name, override) {
  let s = servers.get(name);
  if (s && s.proc.exitCode === null) return s;
  const cfg = serverConfig(name, override);
  if (!cfg || !cfg.command) throw new Error(`未配置 MCP 服务器: ${name}（请在 config.mcpServers 配置）`);
  const args = Array.isArray(cfg.args) ? cfg.args : [];
  const env = { ...process.env, ...(cfg.env || {}) };
  let proc;
  try {
    proc = spawn(cfg.command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
  } catch (e) { throw new Error(`MCP 启动失败(${name}): ${e.message}`); }
  s = { name, proc, pending: new Map(), nextId: 0, ready: false };
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      handle(s, msg);
    }
  });
  proc.stderr.on('data', () => { }); // 服务器 stderr 静默，避免污染
  proc.on('error', (e) => { rejectAll(s, `MCP 服务器错误(${name}): ${e.message}`); servers.delete(name); });
  proc.on('exit', (code) => { rejectAll(s, `MCP 服务器已退出(${name}, exit=${code})`); servers.delete(name); });
  servers.set(name, s);
  return s;
}

function handle(s, msg) {
  const id = msg && msg.id;
  if (id == null) return;               // 通知/其它：忽略
  const p = s.pending.get(id);
  if (p) { s.pending.delete(id); clearTimeout(p.timer); p.resolve(msg); }
}

function request(s, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = ++s.nextId;
    const timer = setTimeout(() => { s.pending.delete(id); reject(new Error(`MCP 请求超时: ${method}`)); }, timeoutMs || DEFAULT_TIMEOUT);
    s.pending.set(id, { resolve, timer });
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    try { s.proc.stdin.write(JSON.stringify(msg) + '\n'); }
    catch (e) { s.pending.delete(id); clearTimeout(timer); reject(new Error(`MCP 写入失败: ${e.message}`)); }
  });
}

async function initialize(s) {
  const r = await request(s, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { roots: { listChanged: false } },
    clientInfo: { name: 'leizai', version: '1.0.0' },
  });
  if (r && r.error) throw new Error(`MCP initialize 失败: ${r.error.message}`);
  try { s.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); } catch { }
  s.ready = true;
  return r ? r.result : null;
}

/** 列出某 MCP 服务器提供的工具。override 用于测试/显式传配置。 */
async function listTools(name, override) {
  const s = ensure(name, override);
  if (!s.ready) await initialize(s);
  const r = await request(s, 'tools/list');
  if (r && r.error) throw new Error(`MCP tools/list 失败(${name}): ${r.error.message}`);
  return ((r && r.result && r.result.tools) || []).map((t) => ({ name: t.name, description: t.description || '' }));
}

/** 调用某 MCP 服务器上的一个工具。 */
async function call(name, tool, args, override) {
  const s = ensure(name, override);
  if (!s.ready) await initialize(s);
  const r = await request(s, 'tools/call', { name: tool, arguments: args || {} });
  if (r && r.error) throw new Error(`MCP tools/call 失败(${name}/${tool}): ${r.error.message}`);
  const content = ((r && r.result && r.result.content) || []);
  const text = content.map((c) => {
    if (!c || typeof c !== 'object') return String(c);
    if (c.type === 'text') return String(c.text == null ? '' : c.text);
    if (c.type === 'image') return '[图片]';
    try { return JSON.stringify(c); } catch { return String(c); }
  }).filter((x) => x).join('\n');
  return text || '(无返回)';
}

function rejectAll(s, msg) {
  for (const [id, p] of s.pending) { clearTimeout(p.timer); p.reject(new Error(msg)); }
  s.pending.clear();
}

/** 关闭所有 MCP 子进程（服务器退出时调用）。 */
function closeAll() {
  for (const s of servers.values()) {
    try { s.proc.stdin.end(); } catch { }
    try { s.proc.kill(); } catch { }
  }
  servers.clear();
}

module.exports = { listTools, call, closeAll, ensure };
