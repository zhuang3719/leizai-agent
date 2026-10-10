// 雷仔 · DeepSeek API 冒烟测试 v2
// 用法: node scripts/api-smoke.mjs [model]
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(ROOT, 'config.json'), 'utf8'));
const model = process.argv[2] || config.model;
const key = process.env.LEIZAI_DEEPSEEK_API_KEY || config.apiKey;
const base = config.baseURL || 'https://api.deepseek.com';

// 模拟雷仔的“稳定静态前缀”：够长（约 1500+ token 级别），内容完全不变
const system = [
  '你是雷仔。',
  '# 身份',
  '雷仔是一个独立运行在用户电脑上的、能够自我进化的智能体。它基于 DeepSeek 大模型构建，拥有记忆、技能、工具与自我改进机制。',
  '# 行为准则',
  '1. 诚实：不知道就说不知道，不编造事实。',
  '2. 简洁：用最少的字说清楚，中文回复。',
  '3. 可靠：执行工具时先确认参数，出错时报告错误而不是假装成功。',
  '4. 学习：每次完成任务后反思，沉淀记忆与技能。',
  '5. 进化：定期检查自己的行为准则，提出改进提案，经批准后生效。',
  '# 工具使用规则',
  '先阅读再修改；写文件前确认目录存在；命令失败要读到 stderr；大输出截断。',
  '# 沟通风格',
  '直接、冷静、带一点锐利。像闪电一样快而准。',
].join('\n');
const FILLER = Array.from({ length: 8 }, (_, i) =>
  `补充规则 ${i + 1}：处理长任务时先分解步骤，逐步执行并检查中间结果；每个步骤失败时报告失败原因与建议的替代方案。`).join('\n');
const stableSystem = system + '\n' + FILLER;

async function call(tag, tweet, dumpDelta) {
  const t0 = Date.now();
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: stableSystem },
        { role: 'user', content: tweet },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 2048,
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`[${tag}] HTTP ${res.status}: ${err.slice(0, 400)}`);
    process.exit(1);
  }
  let text = '';
  let reasoning = '';
  let usage = null;
  let ttfbText = -1;
  let deltaKeys = new Set();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const data = s.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        if (j.usage) usage = j.usage;
        const d = j.choices?.[0]?.delta;
        if (d && dumpDelta && Object.keys(d).length) {
          for (const k of Object.keys(d)) deltaKeys.add(k);
        }
        if (d?.reasoning_content) { reasoning += d.reasoning_content; }
        if (d?.content) { text += d.content; if (ttfbText < 0) ttfbText = Date.now() - t0; }
      } catch { /* ignore */ }
    }
  }
  const ms = Date.now() - t0;
  const hit = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const miss = usage?.prompt_cache_miss_tokens ?? (usage?.prompt_tokens - hit) ?? 0;
  console.log(`[${tag}] ${model} ttfb(text)=${ttfbText}ms total=${ms}ms`);
  console.log(`[${tag}] usage: prompt=${usage?.prompt_tokens} hit=${hit} miss=${miss} out=${usage?.completion_tokens}`);
  if (dumpDelta) console.log(`[${tag}] delta keys: ${[...deltaKeys].join(',')}`);
  console.log(`[${tag}] reasoning(${reasoning.length}): ${reasoning.slice(0, 100)}`);
  console.log(`[${tag}] text(${text.length}): ${text.slice(0, 120)}`);
  return { ms, hit, miss, text };
}

await call('第1次(应 miss)', '你好，一句话介绍你自己。', true);
const b = await call('第2次(应 hit )', '你现在知道什么是文件吗？', false);
await call('第3次(应 hit )', '你运行在什么环境？', false);
console.log('---');
const rate = (b.hit / Math.max(b.hit + b.miss, 1) * 100).toFixed(1);
console.log('第2次缓存命中率:', rate + '%', b.hit > 0 ? '✅ 缓存命中生效' : '⚠️ 未观察到命中');
