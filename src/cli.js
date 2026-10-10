'use strict';
// 雷仔 · 无头 / 程序化接口（对齐 Prime Agent 的 --mode json / --mode rpc 设计）
// 让雷仔可被脚本、CI、第三方 UI 驱动，而不再依赖桌面客户端。
//
// 用法：
//   node src/cli.js --rpc            —— 每行读入一个 JSON 命令，每行写出一条 JSON 响应（行分隔协议）
//   node src/cli.js ping             —— 一次性命令（一次性也走 RPC 语义，直接输出）
//   node src/cli.js chat --session s-... --message "..." [--images a.png,b.png]
//
// 命令（--rpc 下用 {"cmd":"...", ...}）：
//   ping                      -> {ok,pong,provider,model}
//   sessions:list             -> 会话列表
//   session:create            -> 新建会话 {id}
//   chat                      -> 跑一轮（可含多工具调用），返回最终文本 + 用量 {ok,sessionId,text,usage,toolCalls,stopped}
//   stop                      -> {stopped}
//   agents:list               -> 子智能体列表
//   schedules:list            -> 调度列表
//   config:get                -> 掩码后的配置
//   memory:recall             -> {query}
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { load: loadConfig } = require('./config');
const { resolve } = require('./providers');
const runtime = require('./runtime');
const subagent = require('./subagent');
const scheduler = require('./scheduler');
const memory = require('./memory');

function emit(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function ok(data) { return { ok: true, ...data }; }
function err(m, code) { return { ok: false, error: String(m), code: code || 'ERR' }; }

function maskedConfig() {
  const cfg = loadConfig();
  const pr = resolve(cfg);
  return {
    provider: pr.provider, label: pr.label, model: cfg.model, models: cfg.models,
    baseURL: pr.baseURL, thinkingFormat: pr.thinkingFormat,
    port: cfg.port, host: cfg.host, workdir: cfg.workdir,
    fullAccess: cfg.fullAccess, allowedPaths: cfg.allowedPaths || [], protectedPaths: cfg.protectedPaths || [],
    evolutionAutoApply: cfg.evolutionAutoApply, evolutionGate: cfg.evolutionGate || '',
    apiKeyMasked: cfg.apiKey ? cfg.apiKey.slice(0, 6) + '********' : '',
  };
}

async function dispatch(cmd) {
  switch (cmd.cmd) {
    case 'ping': {
      const cfg = loadConfig(); const pr = resolve(cfg);
      return ok({ pong: true, ts: Date.now(), provider: pr.provider, model: pr.model });
    }
    case 'sessions:list': return ok({ sessions: runtime.listSessions() });
    case 'session:create': { const s = runtime.createSession(); if (cmd.title) { s.title = String(cmd.title).slice(0, 40); runtime.saveSession(s); } if (cmd.project) { s.project = String(cmd.project).slice(0, 40); runtime.saveSession(s); } if (cmd.workdir) { s.workdir = String(cmd.workdir); runtime.saveSession(s); } return ok({ id: s.id, title: s.title, project: s.project || '' }); }
    case 'session:patch': { const r = runtime.patchSession(cmd.sessionId, { title: cmd.title, project: cmd.project, workdir: cmd.workdir }); return ok(r); }
    case 'chat': {
      // 兼容 `--session`（arg 解析写 cmd.session）与 RPC 的 cmd.sessionId
      let sid = cmd.sessionId || cmd.session; if (!sid) { const s = runtime.createSession(); sid = s.id; }
      if (!cmd.message) return err('chat 需要 message', 'BAD');
      const images = Array.isArray(cmd.images) ? cmd.images.slice(0, 4) : [];
      const evt = {}; // 无头模式：只取最终结果
      const r = await runtime.runChat(sid, String(cmd.message), { evt, images, origin: 'user' });
      return ok({ sessionId: sid, text: r.text, usage: r.usage, toolCalls: r.toolCallsCount, stopped: r.stopped });
    }
    case 'stop': return ok({ stopped: runtime.stopRun(cmd.sessionId) });
    case 'agents:list': return ok({ agents: subagent.listAll() });
    case 'schedules:list': return ok({ schedules: scheduler.list() });
    case 'config:get': return ok({ config: maskedConfig() });
    case 'memory:recall': return ok({ hits: memory.search(String(cmd.query || ''), { kind: 'memory' }) });
    default: return err(`未知命令: ${cmd.cmd}`, 'UNKNOWN');
  }
}

async function main() {
  const args = process.argv.slice(2);
  // —— 一次性命令：node src/cli.js <cmd> [--key value ...] ——
  if (args.length && args[0] !== '--rpc') {
    const cmd = { cmd: args[0] };
    for (let i = 1; i < args.length; i++) {
      if (args[i].startsWith('--')) { const k = args[i].slice(2); const v = args[i + 1]; if (v !== undefined) { cmd[k] = v; i++; } }
    }
    try { emit(await dispatch(cmd)); } catch (e) { emit(err(e.message)); }
    return;
  }
  // —— --rpc：行分隔 JSON 协议 ——
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // 串行化 dispatch：逐行依序处理，避免并发触发同一会话的"运行中"冲突。
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    let cmd; try { cmd = JSON.parse(t); } catch { chain = chain.then(() => emit(err('JSON 解析失败', 'BAD'))); return; }
    chain = chain.then(async () => {
      try { emit(await dispatch(cmd || {})); } catch (e) { emit(err(e.message)); }
    });
  });
}

main();
