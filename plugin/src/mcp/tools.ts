/**
 * mcp/tools.ts —— MCP 工具注册
 *
 * 6 个工具：
 *   list_sessions      列出会话（可按客户端/目录/关键字过滤）
 *   get_context        获取压缩后的上下文（核心，200k 预算）
 *   push_context       把客户端传来的对话写入目标端
 *   transfer_session   端到端直接转换（不经客户端）
 *   summarize_session  单独生成摘要
 *   list_clients       列出可用客户端与能力
 */
import { McpServer, textResult, type McpTool } from './protocol.js';
import {
  availableAdapters, capabilityMatrix, listAllSessions,
  readSession, writeSession, transferSession, describeLoss,
} from '../adapters/registry.js';
import { summarizeSession, formatStats } from '../budget/summarize.js';
import { resolveBudget, parseBudgetValue, DEFAULT_BUDGET, MODEL_CONTEXT_PRESETS } from '../budget/tokens.js';
import { probeAllClients, platformSupport } from '../host/clients.js';
import type { ClientKind, UirSession, UirTurn, UirStep } from '../uir/types.js';

/** 校验客户端类型 */
function assertClient(v: unknown, field: string): ClientKind {
  const s = String(v ?? '');
  const valid = availableAdapters();
  if (!valid.includes(s as ClientKind)) {
    throw new Error(`${field} 必须是以下之一：${valid.join(', ')}（收到：${s || '空'}）`);
  }
  return s as ClientKind;
}

/** 校验并解析预算参数（数字或 '92k' / '1.2万' 字符串），非法时抛中文错误 */
function assertBudget(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = parseBudgetValue(v);
  if (n == null) {
    throw new Error(`budget 无法解析：${String(v)}（支持 92000 / 92k / 1.5m / 1.2万）`);
  }
  return n;
}

/** 校验 maxTurns 参数（≥1 的整数），非法时抛中文错误 */
function assertMaxTurns(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`maxTurns 必须是 ≥ 1 的数字（收到：${String(v)}）`);
  }
  return Math.floor(n);
}

/** 把纯文本消息数组转成 UIR 会话（供 push_context 使用） */
function messagesToUir(params: {
  messages: Array<{ role: string; content: string }>;
  title?: string;
  cwd?: string;
  client: ClientKind;
}): UirSession {
  const now = Date.now();
  const turns: UirTurn[] = [];
  let current: UirTurn | null = null;
  let step: UirStep | null = null;

  for (const m of params.messages) {
    const text = String(m.content ?? '');
    if (!text) continue;
    if (m.role === 'user') {
      current = {
        index: turns.length,
        startedAt: now,
        userMessages: [{ kind: 'text', role: 'user', text, tier: 'high' }],
        steps: [],
      };
      turns.push(current);
      step = { index: 0, blocks: [] };
      current.steps.push(step);
    } else if (m.role === 'assistant' && current && step) {
      step.blocks.push({ kind: 'text', role: 'assistant', text, tier: 'high' });
    } else if (m.role === 'tool' && current && step) {
      step.blocks.push({
        kind: 'tool-result',
        callId: `call-${turns.length}`,
        output: { text },
        isError: false,
        tier: 'critical',
      });
    }
  }

  return {
    id: `mcp-${now}`,
    title: params.title ?? '(来自 MCP)',
    cwd: params.cwd ?? process.cwd(),
    createdAt: now,
    updatedAt: now,
    origin: { client: 'mcp', originalId: `mcp-${now}` },
    turns,
  };
}

/** 注册全部 MCP 工具 */
export function registerTools(server: McpServer): void {
  // ── 1. list_clients ──
  server.tool(
    {
      name: 'list_clients',
      description: '列出本机可用的编程客户端（DSH / Codex / Zcode / Claude Code / WorkBuddy / 豆包）及其能力与损失提示。豆包为只读端（可导出，不可写入）。',
      inputSchema: { type: 'object', properties: {} },
    },
    async () => {
      const clients = probeAllClients();
      const caps = capabilityMatrix();
      const platform = platformSupport();
      const lines: string[] = [];
      lines.push(`平台：${platform.note}`);
      lines.push('');
      lines.push('| 客户端 | 检测到 | 会话数 | 可读 | 可写 | 子代理 | 分支 |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const c of clients) {
        const cap = caps.find((x) => x.client === c.kind);
        lines.push(
          `| ${c.label} | ${c.detected ? '✅' : '❌'} | ${c.sessionCount ?? '—'} | ${c.canRead ? '✅' : '—'} | ${c.canWrite ? '✅' : '—'} | ${cap?.supportsSubagent ? '✅' : '—'} | ${cap?.supportsBranching ? '✅' : '—'} |`,
        );
      }
      const missing = clients.filter((c) => !c.detected);
      if (missing.length > 0) {
        lines.push('');
        lines.push('未检测到：');
        for (const c of missing) lines.push(`- ${c.label}：${c.reason ?? '未知原因'}`);
      }
      return textResult(lines.join('\n'));
    },
  );

  // ── 2. list_sessions ──
  server.tool(
    {
      name: 'list_sessions',
      description:
        '【用途】列出本机各客户端的历史会话，返回 Markdown 表格。'
        + '\n【典型场景】用户说「看看我有哪些会话」「找找那个关于 XX 的会话」时调用。'
        + '\n【下一步】拿到表格里的「会话 ID」后，可传给 get_context（读上下文）或 transfer_session（转换到别的端）。'
        + '\n【注意】表格里的「会话 ID」是长字符串，不是标题；传给其他工具时必须用 ID 而不是标题。',
      inputSchema: {
        type: 'object',
        properties: {
          client: {
            type: 'string',
            enum: ['dsh', 'codex', 'zcode', 'claude-code', 'workbuddy', 'doubao'],
            description: '只列某个客户端（可选）。不传则列全部六端。',
          },
          query: { type: 'string', description: '关键字过滤（匹配标题或工作目录，不区分大小写）' },
          cwd: { type: 'string', description: '按工作目录过滤（包含匹配），如 "FPS_Extraction"' },
          limit: { type: 'number', description: '每个客户端最多返回多少条，默认 20，上限 100' },
        },
      },
    },
    async (args) => {
      const clients = args.client ? [assertClient(args.client, 'client')] : undefined;
      const limit = Math.min(Number(args.limit ?? 20) || 20, 100);
      const r = await listAllSessions({ clients, limitPerClient: limit });

      let sessions = r.sessions;
      if (args.query) {
        const q = String(args.query).toLowerCase();
        sessions = sessions.filter((s) => s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));
      }
      if (args.cwd) {
        const c = String(args.cwd).toLowerCase();
        sessions = sessions.filter((s) => s.cwd.toLowerCase().includes(c));
      }

      const lines: string[] = [];
      lines.push(`共 ${sessions.length} 个会话`);
      lines.push('');
      lines.push('| 客户端 | 会话 ID | 标题 | 轮次 | 更新 | 工作目录 |');
      lines.push('|---|---|---|---|---|---|');
      for (const s of sessions.slice(0, 200)) {
        const upd = new Date(s.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
        lines.push(`| ${s.client} | \`${s.id}\` | ${s.title.slice(0, 50)} | ${s.turns ?? '—'} | ${upd} | \`${s.cwd.slice(0, 50)}\` |`);
      }
      if (r.errors.length > 0) {
        lines.push('');
        lines.push('部分客户端读取失败：');
        for (const e of r.errors) lines.push(`- ${e.client}：${e.message}`);
      }
      return textResult(lines.join('\n'));
    },
  );

  // ── 3. get_context ──（核心）
  server.tool(
    {
      name: 'get_context',
      description:
        '【用途】把某个客户端的历史会话读成一段可直接用于对话的 Markdown 上下文。'
        + '典型场景：用户说「把我在 DSH/Codex 里那个会话的上下文拉进来」，你就调这个工具。'
        + '\n【调用前】先用 list_sessions 拿到 client 和 sessionId（sessionId 是会话 ID，不是标题）。'
        + '\n【长度自定义】两个维度：①token 预算——budget（数字或 92k/1.2万 字符串）或 model（按模型窗口自动定）；'
        + '②轮数——maxTurns（只导入最近 N 轮，更早的折叠为概览）。可组合。'
        + '\n【预算优先级】budget > model > 默认 200k。'
        + '\n【保留策略】技术细节（代码块、命令、文件路径、报错、参数、版本号）逐字保留；'
        + '叙述性内容压缩；超出预算时早期轮次折叠为摘要，并在末尾附「技术索引」列出全部文件名/命令/报错。'
        + '\n【返回】Markdown 文本，开头有 HTML 注释标明来源、预算、压缩统计。',
      inputSchema: {
        type: 'object',
        properties: {
          client: {
            type: 'string',
            enum: ['dsh', 'codex', 'zcode', 'claude-code', 'workbuddy', 'doubao'],
            description: '会话所在的客户端。可选值见 enum；不确定有哪些可先调 list_clients。',
          },
          sessionId: {
            type: 'string',
            description: '会话 ID（必填）。从 list_sessions 返回的表格里取「会话 ID」那一列，'
              + '是长字符串（如 session-xxx 或 UUID），不是标题。',
          },
          model: {
            type: 'string',
            description: '模型名（推荐）。按该模型的上下文窗口自动定预算，'
              + '如 claude-sonnet-4-5→200k、gpt-4.1→920k、gemini-1.5-pro→1.84M、deepseek-v4→235k、glm-5→184k。'
              + '完整列表调 list_models。与 budget 同时传时 budget 优先。',
          },
          budget: {
            anyOf: [{ type: 'number' }, { type: 'string' }],
            description: '显式 token 预算（可选，优先级最高）。支持数字 32000 或字符串 92k / 1.5m / 1.2万，上限 2,000,000。'
              + '实际可用 = 该值 × 0.92（安全余量）。',
          },
          maxTurns: {
            type: 'number',
            minimum: 1,
            description: '只导入最近 N 轮（可选）。更早的轮次折叠为概览，其技术细节仍保留在文末技术索引。'
              + '与 budget 组合可精确控制导入长度。',
          },
          fidelity: {
            type: 'string',
            enum: ['full', 'balanced', 'compact'],
            description: '压缩力度。full=尽量不压（可能超预算）、balanced=默认平衡、compact=更激进压缩。默认 balanced。',
          },
          focus: {
            type: 'array',
            items: { type: 'string' },
            description: '关注点关键字（可选）。命中这些词的内容会提升保留优先级，'
              + '如 ["报错", "API 参数", "数据库迁移"]。',
          },
        },
        required: ['client', 'sessionId'],
      },
    },
    async (args) => {
      const client = assertClient(args.client, 'client');
      const sessionId = String(args.sessionId ?? '');
      if (!sessionId) throw new Error('sessionId 不能为空');
      const budgetArg = assertBudget(args.budget);
      const maxTurns = assertMaxTurns(args.maxTurns);

      const model = args.model ? String(args.model) : undefined;

      const read = await readSession(client, sessionId);
      const sum = summarizeSession(read.session, {
        budget: budgetArg,
        model,
        fidelity: args.fidelity as any,
        focus: Array.isArray(args.focus) ? args.focus.map(String) : undefined,
        maxTurns,
      });

      // 预算来源说明
      const budgetInfo = resolveBudget({ budget: budgetArg, model });
      const sourceText = budgetInfo.source === 'model'
        ? `模型 ${model} → ${budgetInfo.modelPreset?.label ?? '预设'} ${budgetInfo.modelPreset?.context ?? budgetInfo.requested}`
        : budgetInfo.source === 'explicit'
          ? `显式指定 ${budgetInfo.requested}`
          : budgetInfo.source === 'clamped'
            ? `已裁剪到上限 ${budgetInfo.requested}`
            : `默认 ${budgetInfo.requested}`;

      const header = [
        `<!-- 会话上下文：${read.session.title} -->`,
        `<!-- 来源 ${client} · ${read.session.turns.length} 轮 · 预算 ${budgetInfo.effective}（${sourceText}，安全系数 92%） -->`,
        ...(maxTurns != null ? [`<!-- 轮数限制：只导入最近 ${maxTurns} 轮，更早轮次已折叠（见概览与技术索引） -->`] : []),
        `<!-- ${formatStats(sum.stats).replace(/\n/g, ' | ')} -->`,
        '',
      ].join('\n');

      return textResult(header + sum.context);
    },
  );

  // ── 4. push_context ──
  server.tool(
    {
      name: 'push_context',
      description:
        '把当前对话内容写入指定客户端，成为该客户端的一个新会话。'
        + '用于「在任意 MCP 客户端里干活，结果存回 DSH/Codex/Zcode 等」。',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标客户端（必填）' },
          title: { type: 'string', description: '会话标题' },
          cwd: { type: 'string', description: '工作目录（默认当前目录）' },
          messages: {
            type: 'array',
            description: '对话消息数组',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string', enum: ['user', 'assistant', 'tool'] },
                content: { type: 'string' },
              },
              required: ['role', 'content'],
            },
          },
        },
        required: ['target', 'messages'],
      },
    },
    async (args) => {
      const target = assertClient(args.target, 'target');
      const messages = Array.isArray(args.messages) ? args.messages : [];
      if (messages.length === 0) throw new Error('messages 不能为空');

      const uir = messagesToUir({
        messages: messages as any,
        title: args.title ? String(args.title) : undefined,
        cwd: args.cwd ? String(args.cwd) : undefined,
        client: target,
      });

      const w = await writeSession(target, uir, {
        title: args.title ? String(args.title) : undefined,
        cwd: args.cwd ? String(args.cwd) : undefined,
      });

      if (!w.ok) {
        return textResult(`写入失败：${w.error?.message ?? '未知错误'}`, true);
      }
      return textResult([
        `✅ 已写入 ${target}`,
        `- 会话 ID：\`${w.targetId}\``,
        `- 位置：\`${w.location}\``,
        `- 记录数：${w.records}`,
        w.warnings.length > 0 ? `- 提示：${w.warnings.join('；')}` : '',
      ].filter(Boolean).join('\n'));
    },
  );

  // ── 5. transfer_session ──
  server.tool(
    {
      name: 'transfer_session',
      description:
        '把一个客户端的历史会话直接转换到另一个客户端（不经客户端传内容）。'
        + '\n【两种导入方式】①完整导入（默认，不传压缩参数）——逐事件完整拷贝；'
        + '②压缩导入——传 budget / model / maxTurns / focus 任一参数即触发，'
        + '先经压缩引擎生成上下文文档（单轮会话）再写入，长度可自定义，适合超大源会话导入小窗口目标端。'
        + '\n【注意】压缩导入保留技术细节（代码/命令/路径/报错，见技术索引），但对话结构变为单轮文档；'
        + '要完整对话结构就用完整导入。',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '源客户端（必填）' },
          fromId: { type: 'string', description: '源会话 ID（必填）' },
          to: { type: 'string', description: '目标客户端（必填）' },
          title: { type: 'string', description: '覆盖标题（压缩导入时缺省为【导入】原标题）' },
          cwd: { type: 'string', description: '覆盖工作目录' },
          budget: {
            anyOf: [{ type: 'number' }, { type: 'string' }],
            description: '压缩导入：token 预算（数字或 92k / 1.2万）。与 model 同时传时 budget 优先',
          },
          model: { type: 'string', description: '压缩导入：按目标模型上下文自动定预算，如 glm-5、claude-sonnet-4-5' },
          maxTurns: { type: 'number', minimum: 1, description: '压缩导入：只导入最近 N 轮' },
          fidelity: {
            type: 'string',
            enum: ['full', 'balanced', 'compact'],
            description: '压缩导入：保真度，默认 balanced',
          },
          focus: { type: 'array', items: { type: 'string' }, description: '压缩导入：关注点关键字' },
        },
        required: ['from', 'fromId', 'to'],
      },
    },
    async (args) => {
      const from = assertClient(args.from, 'from');
      const to = assertClient(args.to, 'to');
      const fromId = String(args.fromId ?? '');
      if (!fromId) throw new Error('fromId 不能为空');
      if (from === to) throw new Error('源端与目标端相同，无需转换');
      const budgetArg = assertBudget(args.budget);
      const maxTurns = assertMaxTurns(args.maxTurns);

      const losses = describeLoss(from, to);
      const r = await transferSession({
        from, fromId, to,
        title: args.title ? String(args.title) : undefined,
        cwd: args.cwd ? String(args.cwd) : undefined,
        budget: budgetArg,
        model: args.model ? String(args.model) : undefined,
        fidelity: args.fidelity as any,
        focus: Array.isArray(args.focus) ? args.focus.map(String) : undefined,
        maxTurns,
      });

      const lines = [
        `✅ ${from} → ${to} 转换完成`,
        `- 源会话：${r.source.title}（${r.source.turns} 轮）`,
        `- 目标 ID：\`${r.target.id}\``,
        `- 位置：\`${r.target.location}\``,
        `- 记录数：${r.target.records}`,
      ];
      if (r.imported) {
        lines.push(
          `- 导入方式：压缩导入（原始 ${r.imported.originalTokens} → 导入 ${r.imported.importedTokens} tokens，级别 ${r.imported.level}，保留 ${Math.round(r.imported.ratio * 100)}%）`,
        );
      }
      if (losses.length > 0) {
        lines.push('', '⚠️ 本次转换的已知损失：');
        for (const l of losses) lines.push(`- ${l}`);
      }
      if (r.warnings.length > 0) {
        lines.push('', '提示：');
        for (const w of r.warnings) lines.push(`- ${w}`);
      }
      return textResult(lines.join('\n'));
    },
  );

  // ── 6. summarize_session ──
  server.tool(
    {
      name: 'summarize_session',
      description: '只生成会话摘要（不返回完整上下文），适合快速了解历史。',
      inputSchema: {
        type: 'object',
        properties: {
          client: { type: 'string', description: '客户端（必填）' },
          sessionId: { type: 'string', description: '会话 ID（必填）' },
          budget: {
            anyOf: [{ type: 'number' }, { type: 'string' }],
            description: '摘要目标 token，默认 8000。支持数字或 8k / 1.2万 字符串',
          },
          model: { type: 'string', description: '模型名（可选，用于自动定预算；显式 budget 优先）' },
          maxTurns: { type: 'number', minimum: 1, description: '只摘要最近 N 轮' },
        },
        required: ['client', 'sessionId'],
      },
    },
    async (args) => {
      const client = assertClient(args.client, 'client');
      const sessionId = String(args.sessionId ?? '');
      if (!sessionId) throw new Error('sessionId 不能为空');
      const budget = args.budget != null ? assertBudget(args.budget) ?? 8_000 : 8_000;
      const maxTurns = assertMaxTurns(args.maxTurns);
      const model = args.model ? String(args.model) : undefined;

      const read = await readSession(client, sessionId);
      const sum = summarizeSession(read.session, { budget, model, fidelity: 'compact', maxTurns });

      const lines = [
        `# ${read.session.title}`,
        '',
        `来源 ${client} · ${read.session.turns.length} 轮 · 工作目录 \`${read.session.cwd}\``,
        '',
        formatStats(sum.stats),
        '',
        '## 轮次大纲',
        '',
      ];
      for (const o of sum.outline) {
        const files = o.files.length > 0 ? ` · 文件：${o.files.slice(0, 5).join(', ')}` : '';
        const tools = o.tools.length > 0 ? ` · 工具：${o.tools.join(', ')}` : '';
        lines.push(`- **第 ${o.turn} 轮**：${o.intent || '（无明确意图）'}${files}${tools}`);
      }
      lines.push('', '## 压缩上下文', '', sum.context);
      return textResult(lines.join('\n'));
    },
  );

  // ── 7. list_models ──
  server.tool(
    {
      name: 'list_models',
      description:
        '列出内置的模型上下文长度预设。调用 get_context 时可传 model 名自动定预算，'
        + '也可直接传 budget（显式 token 数，优先级更高）。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '按名称过滤（可选）' },
        },
      },
    },
    async (args) => {
      const q = args.query ? String(args.query).toLowerCase() : '';
      const rows = MODEL_CONTEXT_PRESETS.filter(
        (p) => !q || p.match.includes(q) || p.label.toLowerCase().includes(q),
      );
      const lines = [
        '# 模型上下文长度预设',
        '',
        `默认预算：${DEFAULT_BUDGET.toLocaleString()} tokens（未指定 model / budget 时）`,
        `安全系数：92%（实际可用 = 上下文 × 0.92）`,
        `硬上限：2,000,000 tokens`,
        '',
        '| 匹配片段 | 上下文窗口 | 实际可用 | 模型 |',
        '|---|---|---|---|',
      ];
      for (const p of rows) {
        lines.push(
          `| \`${p.match}\` | ${p.context.toLocaleString()} | ${Math.floor(p.context * 0.92).toLocaleString()} | ${p.label} |`,
        );
      }
      lines.push('');
      lines.push('用法示例：');
      lines.push('- `get_context({ client, sessionId, model: "claude-sonnet-4-5" })` → 按 200k 预算');
      lines.push('- `get_context({ client, sessionId, budget: 500000 })` → 显式 500k');
      lines.push('- 两者同时传时，`budget` 优先');
      return textResult(lines.join('\n'));
    },
  );
}

/** 创建并配置好工具的 MCP 服务端 */
export function createBridgeMcpServer(): McpServer {
  const server = new McpServer({ name: 'dsh-codex-bridge', version: '0.4.0' });
  registerTools(server);
  return server;
}
