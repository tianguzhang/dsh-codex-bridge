/**
 * adapters/registry.ts —— 适配器注册表与跨端转换
 *
 * 提供：
 *   - 统一的适配器查找（按 ClientKind）
 *   - 能力矩阵（UI 据此展示损失提示）
 *   - 跨端转换（read A → UIR → write B）
 */
import type { ClientKind, SessionAdapter, AdapterCapability, SessionSummary, ReadResult, WriteResult, UirSession } from '../uir/types.js';
import { summarizeSession } from '../budget/summarize.js';
import { claudeCodeAdapter } from './claude-code/adapter.js';
import { zcodeAdapter } from './zcode/adapter.js';
import { dshAdapter } from './dsh/adapter.js';
import { codexAdapter } from './codex/adapter.js';
import { workbuddyAdapter } from './workbuddy/adapter.js';

/**
 * 全部五端的 UIR 适配器。
 *
 * 每个适配器都实现 `probe / list / read / write`，
 * 因此任意两端都能通过 `transferSession` 互转。
 */
const ADAPTERS: Partial<Record<ClientKind, SessionAdapter>> = {
  'claude-code': claudeCodeAdapter,
  zcode: zcodeAdapter,
  dsh: dshAdapter,
  codex: codexAdapter,
  workbuddy: workbuddyAdapter,
};

/** 按客户端获取适配器 */
export function getAdapter(client: ClientKind): SessionAdapter | null {
  return ADAPTERS[client] ?? null;
}

/** 列出已实现 UIR 适配器的客户端 */
export function availableAdapters(): ClientKind[] {
  return Object.keys(ADAPTERS) as ClientKind[];
}

/** 能力矩阵（所有已注册适配器） */
export function capabilityMatrix(): AdapterCapability[] {
  return availableAdapters()
    .map((client) => ADAPTERS[client]?.capability)
    .filter((c): c is AdapterCapability => Boolean(c));
}

/** 列出所有可用客户端的会话（各端并行探测，速度优化） */
export async function listAllSessions(opts: {
  clients?: ClientKind[];
  limitPerClient?: number;
} = {}): Promise<{ sessions: SessionSummary[]; errors: Array<{ client: ClientKind; message: string }> }> {
  const targets = opts.clients ?? availableAdapters();
  const limit = opts.limitPerClient ?? 50;

  const results = await Promise.all(targets.map(async (client): Promise<{
    sessions: SessionSummary[];
    errors: Array<{ client: ClientKind; message: string }>;
  }> => {
    const adapter = getAdapter(client);
    if (!adapter) return { sessions: [], errors: [] };
    const probe = adapter.probe();
    if (!probe.available) {
      return { sessions: [], errors: [{ client, message: probe.reason ?? '不可用' }] };
    }
    try {
      const list = await adapter.list();
      return { sessions: list.slice(0, limit), errors: [] };
    } catch (e) {
      return { sessions: [], errors: [{ client, message: String((e as Error)?.message ?? e) }] };
    }
  }));

  const sessions = results.flatMap((r) => r.sessions);
  const errors = results.flatMap((r) => r.errors);
  return { sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt), errors };
}

// ── 读取缓存（速度优化）──
// get_context / summarize_session 常对同一会话反复调用（调预算、调轮数），
// 解压 + 解析是主要成本。TTL 兜底数据新鲜度；写回目标端后自动失效对应条目。
const READ_CACHE_TTL_MS = 5 * 60 * 1000;
const READ_CACHE_MAX = 24;
const readCache = new Map<string, { at: number; result: ReadResult }>();

/** 清空读取缓存（测试 / 强制刷新用） */
export function clearReadSessionCache(): void {
  readCache.clear();
}

/** 读取会话为 UIR（带 TTL 缓存） */
export async function readSession(client: ClientKind, sessionId: string): Promise<ReadResult> {
  const adapter = getAdapter(client);
  if (!adapter) {
    throw new Error(`客户端 ${client} 尚未支持 UIR 读取（当前支持：${availableAdapters().join(', ')}）`);
  }
  const key = `${client}\u0000${sessionId}`;
  const hit = readCache.get(key);
  if (hit) {
    if (Date.now() - hit.at < READ_CACHE_TTL_MS) {
      readCache.delete(key);
      readCache.set(key, hit);   // LRU 触碰
      return hit.result;
    }
    readCache.delete(key);
  }
  const result = await adapter.read({ sessionId });
  readCache.set(key, { at: Date.now(), result });
  if (readCache.size > READ_CACHE_MAX) {
    const oldest = readCache.keys().next().value;
    if (oldest !== undefined) readCache.delete(oldest);
  }
  return result;
}

/** 把 UIR 写入指定客户端（写回后失效该目标的读取缓存） */
export async function writeSession(
  client: ClientKind,
  session: UirSession,
  opts: { title?: string; cwd?: string; mode?: 'skip' | 'overwrite' } = {},
): Promise<WriteResult> {
  const adapter = getAdapter(client);
  if (!adapter) {
    throw new Error(`客户端 ${client} 尚未支持 UIR 写入（当前支持：${availableAdapters().join(', ')}）`);
  }
  const w = await adapter.write(session, opts);
  if (w.ok) readCache.delete(`${client}\u0000${w.targetId}`);
  return w;
}

/**
 * 跨端转换：从一端读到 UIR，再写入另一端。
 *
 * 这是 N×N 互通的核心：不需要 N² 个转换器，只要 2N 个适配器。
 *
 * 压缩导入（长度可自定义）：传 budget / model / maxTurns / focus 任一参数时，
 * 不做逐事件完整拷贝，而是先经压缩引擎生成上下文文档（单轮会话）再写入目标端。
 * 适合超大源会话导入小窗口目标端的场景。
 */
export async function transferSession(params: {
  from: ClientKind;
  fromId: string;
  to: ClientKind;
  title?: string;
  cwd?: string;
  /** 压缩导入：token 预算（数字或 '92k' / '1.2万' 字符串） */
  budget?: number | string;
  /** 压缩导入：按目标模型上下文自动定预算 */
  model?: string;
  /** 压缩导入：保真度 */
  fidelity?: 'full' | 'balanced' | 'compact';
  /** 压缩导入：关注点关键字 */
  focus?: string[];
  /** 压缩导入：只导入最近 N 轮 */
  maxTurns?: number;
}): Promise<{
  ok: boolean;
  source: { client: ClientKind; id: string; title: string; turns: number };
  target: { client: ClientKind; id: string; location: string; records: number };
  warnings: string[];
  /** 压缩导入时的统计（完整导入时为 undefined） */
  imported?: { originalTokens: number; importedTokens: number; ratio: number; level: string };
}> {
  const read = await readSession(params.from, params.fromId);

  const compress = params.budget != null || params.model != null
    || (params.focus?.length ?? 0) > 0
    || params.maxTurns != null;

  let sessionToWrite = read.session;
  let imported: { originalTokens: number; importedTokens: number; ratio: number; level: string } | undefined;
  const warnings = [...read.warnings];

  if (compress) {
    const sum = summarizeSession(read.session, {
      budget: params.budget,
      model: params.model,
      fidelity: params.fidelity,
      focus: params.focus,
      maxTurns: params.maxTurns,
    });
    const title = params.title ?? `【导入】${read.session.title}`.slice(0, 200);
    const note = [
      `> 🌉 本会话由 dsh-bridge 从 ${params.from} 压缩导入：`,
      `> 原始 ${sum.stats.originalTokens} → 导入 ${sum.stats.returnedTokens} tokens`,
      `>（级别 ${sum.stats.level}，保留 ${Math.round(sum.stats.compressionRatio * 100)}%；技术细节见文末技术索引）`,
    ].join('\n');
    sessionToWrite = compressedContextSession(read.session, `${note}\n\n${sum.context}`, title);
    imported = {
      originalTokens: sum.stats.originalTokens,
      importedTokens: sum.stats.returnedTokens,
      ratio: sum.stats.compressionRatio,
      level: sum.stats.level,
    };
    warnings.push(`已压缩导入：原始 ${sum.stats.originalTokens} → ${sum.stats.returnedTokens} tokens（级别 ${sum.stats.level}），完整原文仍在源端 ${params.from}`);
  }

  const write = await writeSession(params.to, sessionToWrite, {
    title: compress ? params.title : undefined,   // 压缩会话已带【导入】标题，显式 title 仍可覆盖
    cwd: params.cwd,
  });

  if (!write.ok) {
    throw new Error(write.error?.message ?? '写入目标端失败');
  }

  return {
    ok: true,
    source: {
      client: params.from,
      id: params.fromId,
      title: read.session.title,
      turns: read.session.turns.length,
    },
    target: {
      client: params.to,
      id: write.targetId,
      location: write.location,
      records: write.records,
    },
    warnings: [...warnings, ...write.warnings],
    imported,
  };
}

/** 把压缩后的上下文 markdown 包装成单轮 UIR 会话（供压缩导入写盘） */
function compressedContextSession(src: UirSession, markdown: string, title: string): UirSession {
  const now = Date.now();
  return {
    id: `transfer-${now}`,
    title,
    cwd: src.cwd,
    createdAt: now,
    updatedAt: now,
    origin: { client: 'mcp', originalId: src.id },
    turns: [{
      index: 0,
      startedAt: now,
      userMessages: [{ kind: 'text', role: 'user', text: markdown, tier: 'high' }],
      steps: [{ index: 0, blocks: [] }],
    }],
  };
}

/** 生成转换损失提示（中文） */
export function describeLoss(from: ClientKind, to: ClientKind): string[] {
  const matrix = capabilityMatrix();
  const src = matrix.find((c) => c.client === from);
  const dst = matrix.find((c) => c.client === to);
  if (!src || !dst) return [];

  const losses: string[] = [];

  if (src.supportsSubagent && !dst.supportsSubagent) {
    losses.push(`${dst.label} 不支持子代理结构，子代理会话将被合并或跳过`);
  }
  if (src.supportsBranching && !dst.supportsBranching) {
    losses.push(`${dst.label} 不支持消息分支，分支将线性化`);
  }
  if (src.supportsImage && !dst.supportsImage) {
    losses.push(`${dst.label} 不支持图片，图片将丢失`);
  }
  if (src.supportsFileChange && !dst.supportsFileChange) {
    losses.push(`${dst.label} 不支持文件变更记录，变更历史将丢失`);
  }

  // 目标端已知的有损字段
  for (const f of dst.lossyFields) {
    losses.push(`${dst.label}：${f}`);
  }

  return [...new Set(losses)];
}
