/**
 * scripts/bench-context.mjs —— 上下文导入性能基准
 *
 * 用法（仓库根目录）：
 *   node scripts/bench-context.mjs [--mcp <mcp-stdio.js 路径>]
 *
 * 环境变量：
 *   BENCH_CLIENT / BENCH_ID   指定大会话（默认 dsh 的开发会话）
 *
 * 计时项：list_clients / list_sessions（五端+单端）/ get_context（大小预算、重复调用）/ summarize_session
 * 用途：改动 summarize/registry 前后对比，验证「导入速度提升」。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MCP = process.argv.includes('--mcp')
  ? path.resolve(process.argv[process.argv.indexOf('--mcp') + 1])
  : path.join(ROOT, 'plugin', 'lib', 'mcp-stdio.js');
const CLIENT = process.env.BENCH_CLIENT ?? 'dsh';
const ID = process.env.BENCH_ID ?? 'session-2694c706-aa69-4fe3-959c-4499086b50c2';

if (!fs.existsSync(MCP)) {
  console.error(`❌ 未找到 MCP 入口：${MCP}`);
  process.exit(1);
}

// ── MCP stdio 客户端 ──
const child = spawn(process.execPath, [MCP], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', () => { /* 忽略日志 */ });

const pending = new Map();
let nextId = 1;
let buf = '';

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* 跳过坏行 */ }
  }
});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`超时：${method}`)); }, 300_000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function timed(label, method, params) {
  const t0 = performance.now();
  const res = await call(method, params);
  const ms = Math.round(performance.now() - t0);
  let extra = '';
  if (res.error) extra = ` ❌ ${res.error.message}`;
  else if (res.result?.isError) extra = ` ❌ ${String(res.result.content?.[0]?.text ?? '').slice(0, 80)}`;
  else if (res.result?.content?.[0]?.text != null) {
    extra = `（返回 ${res.result.content[0].text.length.toLocaleString()} 字符）`;
  }
  console.log(`${String(ms).padStart(6)} ms  ${label}${extra}`);
  return { ms, res };
}

console.log(`=== 基准：${path.relative(ROOT, MCP)} ===`);
console.log(`大会话：${CLIENT} / ${ID.slice(0, 24)}…\n`);

await timed('initialize', 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bench', version: '0' } });
await timed('list_clients', 'tools/call', { name: 'list_clients', arguments: {} });
await timed('list_sessions ×5端', 'tools/call', { name: 'list_sessions', arguments: { limit: 20 } });
await timed('list_sessions dsh', 'tools/call', { name: 'list_sessions', arguments: { client: 'dsh', limit: 20 } });
const big1 = await timed('get_context 大预算 92k', 'tools/call', {
  name: 'get_context', arguments: { client: CLIENT, sessionId: ID, budget: 92_000 },
});
await timed('get_context 重复调用', 'tools/call', {
  name: 'get_context', arguments: { client: CLIENT, sessionId: ID, budget: 92_000 },
});
await timed('get_context 小预算 8k', 'tools/call', {
  name: 'get_context', arguments: { client: CLIENT, sessionId: ID, budget: 8_000 },
});
await timed('summarize_session', 'tools/call', { name: 'summarize_session', arguments: { client: CLIENT, sessionId: ID } });
await timed('get_context 最近 3 轮', 'tools/call', {
  name: 'get_context', arguments: { client: CLIENT, sessionId: ID, budget: 92_000, maxTurns: 3 },
}).catch(() => console.log('       （当前版本不支持 maxTurns，忽略）'));

child.stdin.end();
const outChars = big1.res?.result?.content?.[0]?.text?.length ?? 0;
console.log(`\n完成。大预算返回 ${outChars.toLocaleString()} 字符`);
