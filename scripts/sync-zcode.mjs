/**
 * scripts/sync-zcode.mjs —— 把 MCP 构建产物同步进 Zcode 插件层
 *
 * 用法（任意目录）：
 *   node scripts/sync-zcode.mjs
 * 或经 plugin/ 的 npm script：
 *   cd plugin && npm run build:zcode
 *
 * 同步内容：plugin/lib/mcp-stdio.js → zcode-plugin/dsh-bridge/server/mcp-stdio.js
 * 原因：Zcode 安装插件时会把插件目录整体拷贝进缓存，MCP 必须自包含，
 *       不能引用仓库其他位置的文件；plugin/lib/mcp-stdio.js 仍是唯一来源。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'plugin', 'lib', 'mcp-stdio.js');
const DST_DIR = path.join(ROOT, 'zcode-plugin', 'dsh-bridge', 'server');
const DST = path.join(DST_DIR, 'mcp-stdio.js');

if (!fs.existsSync(SRC)) {
  console.error(`❌ 未找到构建产物：${SRC}`);
  console.error('   请先在 plugin/ 下运行 npm run build');
  process.exit(1);
}

fs.mkdirSync(DST_DIR, { recursive: true });
fs.copyFileSync(SRC, DST);

const srcSize = fs.statSync(SRC).size;
const dstSize = fs.statSync(DST).size;
if (srcSize !== dstSize) {
  console.error('❌ 同步后大小不一致，请重试');
  process.exit(1);
}
console.log(`✅ 已同步 MCP 产物 → ${path.relative(ROOT, DST)}（${(dstSize / 1024).toFixed(1)} KB）`);
