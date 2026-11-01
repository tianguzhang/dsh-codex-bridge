/**
 * adapters/doubao/adapter.ts —— 豆包（Doubao 桌面版）会话适配器
 *
 * 实测存储格式（2026-11-01，真实数据）：
 *   %LOCALAPPDATA%/Doubao/User Data/Default/.doubao/agent_mode/workspace/.sessions/<convId>/
 *     agents/<agentId>/system/trajectory.jsonl   —— 智能体轨迹（对话本体）
 *     agents/<agentId>/system/assignment.md      —— 带时间戳的追加需求记录（标题/时间来源）
 *     board.md / memory/MEMORY.md                —— 任务板与记忆（不解析）
 *
 * trajectory.jsonl 行型（OpenAI 风格，无逐行时间戳）：
 *   {"role":"user","content":"..."}
 *   {"role":"assistant","content":"...","tool_calls":[{"id","type":"function","function":{"name","arguments"(对象)}}]}
 *   {"role":"tool","content":"...","tool_call_id":"...","image_link_list":[...]?}
 *
 * 只读适配器：豆包是云端智能体会话，本地轨迹是运行时状态，
 * 写入不会在客户端界面出现（甚至可能干扰运行），故 canWrite=false。
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  SessionAdapter, AdapterCapability, ReadOptions, ReadResult,
  WriteOptions, WriteResult, SessionSummary, UirSession, UirTurn, UirStep,
} from '../../uir/types.js';
import { classifyText, isInjectedTemplate } from '../../uir/helpers.js';
import { doubaoUserData } from '../../host/clients.js';

/** 智能体会话根目录（.sessions） */
export function doubaoAgentSessionsRoot(): string {
  return path.join(doubaoUserData(), 'Default', '.doubao', 'agent_mode', 'workspace', '.sessions');
}

/** assignment.md 里的一条需求 */
export interface DoubaoNeed {
  /** 需求提出时间（毫秒；解析失败为 null） */
  ts: number | null;
  /** 需求原文（单行压缩） */
  text: string;
}

/**
 * 解析 assignment.md：形如
 *   ## [2026-09-22T12:41:39.356Z] 需求
 *   <需求原文，可多行>
 * 返回按出现顺序的需求列表。
 */
export function parseAssignment(md: string): DoubaoNeed[] {
  const out: DoubaoNeed[] = [];
  if (!md) return out;
  const lines = md.split('\n');
  let current: DoubaoNeed | null = null;
  for (const line of lines) {
    const m = line.match(/^##\s*\[([^\]]+)\]/);
    if (m) {
      if (current) out.push(current);
      const t = Date.parse(m[1]);
      current = { ts: Number.isFinite(t) ? t : null, text: '' };
      continue;
    }
    if (current && line.trim()) {
      current.text = (current.text ? `${current.text} ` : '') + line.trim();
    }
  }
  if (current) out.push(current);
  for (const n of out) n.text = n.text.replace(/\s+/g, ' ').slice(0, 200);
  return out;
}

/** 找到会话目录下的第一个 agent 的 system 目录（实测每会话 1 个 agent） */
function findAgentSystem(sessionDir: string): { systemDir: string; agentId: string } | null {
  const agentsDir = path.join(sessionDir, 'agents');
  let agents: string[] = [];
  try { agents = fs.readdirSync(agentsDir); } catch { return null; }
  for (const a of agents) {
    const systemDir = path.join(agentsDir, a, 'system');
    if (fs.existsSync(path.join(systemDir, 'trajectory.jsonl'))) {
      return { systemDir, agentId: a };
    }
  }
  return null;
}

/** 从 assignment.md 提取标题（第一条需求的文字） */
function titleFromAssignment(md: string): string {
  const needs = parseAssignment(md);
  for (const n of needs) {
    if (n.text) return n.text.replace(/\s+/g, ' ').slice(0, 80);
  }
  return '';
}

export class DoubaoAdapter implements SessionAdapter {
  readonly capability: AdapterCapability = {
    client: 'doubao',
    label: '豆包',
    canRead: true,
    canWrite: false,
    supportsSubagent: false,   // agents 目录结构存在但未实测多智能体
    supportsImage: true,        // tool 行带 image_link_list（图片链接）
    supportsFileChange: false,  // 无 diff 概念（工具直接产出文件）
    supportsBranching: false,
    lossyFields: [
      '只读：豆包为云端智能体会话，不支持写入（可从豆包导出到其他端）',
      '轨迹无逐行时间戳，轮次时间为按需求记录估算',
      '图片仅为链接占位',
    ],
  };

  probe(): { available: boolean; reason?: string } {
    const root = doubaoAgentSessionsRoot();
    if (!fs.existsSync(root)) {
      return { available: false, reason: `未找到豆包智能体会话目录：${root}` };
    }
    return { available: true };
  }

  /**
   * 概要缓存（速度优化）：与 DSH 适配器同一套 mtime+size 策略。
   * 列表页用 assignment.md 提标题（小文件），不动 trajectory 全文。
   */
  private listCache = new Map<string, { mtime: number; size: number; summary: SessionSummary }>();

  async list(): Promise<SessionSummary[]> {
    const root = doubaoAgentSessionsRoot();
    let convs: string[] = [];
    try {
      convs = fs.readdirSync(root).filter((n) => /^\d+$/.test(n));
    } catch {
      return [];
    }

    const out: SessionSummary[] = [];
    const liveKeys = new Set<string>();

    for (const convId of convs) {
      const sessionDir = path.join(root, convId);
      const agent = findAgentSystem(sessionDir);
      if (!agent) continue;
      const trajFile = path.join(agent.systemDir, 'trajectory.jsonl');
      let st: fs.Stats;
      try { st = fs.statSync(trajFile); } catch { continue; }

      const cacheKey = trajFile;
      liveKeys.add(cacheKey);
      const cached = this.listCache.get(cacheKey);
      if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) {
        out.push(cached.summary);
        continue;
      }

      // 标题：assignment.md 优先（官方需求记录）→ 回退轨迹首条用户消息
      let title = '';
      const assignFile = path.join(agent.systemDir, 'assignment.md');
      try { title = titleFromAssignment(fs.readFileSync(assignFile, 'utf8')); } catch { /* 无 assignment */ }
      let createdAt: number | null = null;
      if (!title || createdAt === null) {
        const needs = (() => {
          try { return parseAssignment(fs.readFileSync(assignFile, 'utf8')); } catch { return []; }
        })();
        if (needs.length > 0 && needs[0].ts != null) createdAt = needs[0].ts;
      }
      let firstUser = '';
      let userCount = 0;
      try {
        const text = fs.readFileSync(trajFile, 'utf8');
        for (const line of text.split('\n')) {
          if (!line.includes('"role":"user"')) continue;
          userCount++;
          if (!firstUser) {
            try {
              const o = JSON.parse(line);
              if (typeof o.content === 'string' && o.content && !isInjectedTemplate(o.content)) {
                firstUser = o.content.replace(/\s+/g, ' ').slice(0, 80);
              }
            } catch { /* 跳过坏行 */ }
          }
        }
      } catch { continue; }

      const summary: SessionSummary = {
        client: 'doubao',
        id: convId,
        title: title || firstUser || '(无标题)',
        cwd: workspaceDirOf(sessionDir),
        createdAt: createdAt ?? (Math.floor(st.birthtimeMs) || st.mtimeMs),
        updatedAt: st.mtimeMs,
        turns: userCount,
      };
      this.listCache.set(cacheKey, { mtime: st.mtimeMs, size: st.size, summary });
      out.push(summary);
    }

    for (const key of this.listCache.keys()) {
      if (!liveKeys.has(key)) this.listCache.delete(key);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async read(opts: ReadOptions): Promise<ReadResult> {
    const root = doubaoAgentSessionsRoot();
    const sessionDir = path.join(root, opts.sessionId);
    if (!fs.existsSync(sessionDir)) {
      throw new Error(`未找到豆包会话：${opts.sessionId}`);
    }
    const agent = findAgentSystem(sessionDir);
    if (!agent) {
      throw new Error(`豆包会话 ${opts.sessionId} 缺少智能体轨迹（agents/*/system/trajectory.jsonl）`);
    }

    const warnings: string[] = [];
    const trajFile = path.join(agent.systemDir, 'trajectory.jsonl');
    const st = fs.statSync(trajFile);

    // assignment.md：需求时间戳 + 标题
    const assignFile = path.join(agent.systemDir, 'assignment.md');
    let needs: DoubaoNeed[] = [];
    try { needs = parseAssignment(fs.readFileSync(assignFile, 'utf8')); } catch { /* 无 assignment */ }

    // 轨迹行解析
    const lines: any[] = [];
    for (const line of fs.readFileSync(trajFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch { warnings.push(`轨迹第 ${lines.length + 1} 行 JSON 损坏，已跳过`); }
    }

    const userCount = lines.filter((l) => l.role === 'user').length;
    const alignTime = needs.length > 0 && needs.length === userCount;   // 需求数与用户轮数一致时才对齐
    if (!alignTime && needs.length > 0) {
      warnings.push('豆包轨迹无逐行时间戳，且需求数与用户轮数不一致，轮次时间按会话起点估算');
    }
    const sessionStart = needs[0]?.ts ?? (Math.floor(st.birthtimeMs) || st.mtimeMs);

    const turns: UirTurn[] = [];
    let current: UirTurn | null = null;
    let step: UirStep | null = null;
    let needIdx = 0;
    const callNames = new Map<string, string>();
    const title = needs.find((n) => n.text)?.text.slice(0, 80) ?? '';

    const ensureTurn = (ts: number) => {
      if (!current) {
        current = { index: turns.length, startedAt: ts, userMessages: [], steps: [] };
        turns.push(current);
        step = null;
      }
      return current;
    };
    const ensureStep = (ts: number) => {
      const t = ensureTurn(ts);
      if (!step) {
        step = { index: t.steps.length, blocks: [] };
        t.steps.push(step);
      }
      return step;
    };

    for (const l of lines) {
      const ts = alignTime && l.role === 'user' && needs[needIdx]?.ts != null
        ? needs[needIdx]!.ts!
        : sessionStart;
      switch (l.role) {
        case 'user': {
          const content = typeof l.content === 'string' ? l.content : '';
          if (!content) break;
          current = {
            index: turns.length,
            startedAt: ts,
            userMessages: [{
              kind: 'text', role: 'user', text: content,
              tier: classifyText(content, { injected: isInjectedTemplate(content) }),
              injected: isInjectedTemplate(content),
            }],
            steps: [],
          } as UirTurn;
          turns.push(current);
          step = null;
          if (alignTime) needIdx++;
          break;
        }
        case 'assistant': {
          const t = ensureTurn(ts);
          const s = ensureStep(ts);
          if (typeof l.content === 'string' && l.content) {
            s.blocks.push({
              kind: 'text', role: 'assistant', text: l.content,
              tier: classifyText(l.content, {}),
            });
          }
          for (const tc of Array.isArray(l.tool_calls) ? l.tool_calls : []) {
            const fn = tc?.function ?? {};
            const callId = String(tc.id ?? `call-${turns.length}-${s.blocks.length}`);
            const name = String(fn.name ?? 'tool');
            callNames.set(callId, name);
            const rawArgs = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
            s.blocks.push({
              kind: 'tool-call', callId, name,
              args: typeof fn.arguments === 'object' && fn.arguments != null ? fn.arguments : safeJson(fn.arguments),
              rawArgs,
              tier: 'critical',
            });
          }
          break;
        }
        case 'tool': {
          const t = ensureTurn(ts);
          const s = ensureStep(ts);
          const callId = String(l.tool_call_id ?? `call-${t.index}-${s.blocks.length}`);
          const out = typeof l.content === 'string' ? l.content : String(l.content ?? '');
          if (Array.isArray(l.image_link_list) && l.image_link_list.length > 0) {
            warnings.push('轨迹含图片链接（image_link_list），仅保留占位');
          }
          s.blocks.push({
            kind: 'tool-result', callId,
            name: callNames.get(callId),
            output: { text: out, originalLength: out.length },
            isError: false,
            tier: 'critical',
          });
          break;
        }
        default:
          break;   // system 等其他行型忽略（未实测出现）
      }
    }

    const session: UirSession = {
      id: `doubao-${opts.sessionId}`,
      title: title || '(无标题)',
      cwd: workspaceDirOf(sessionDir),
      createdAt: sessionStart,
      updatedAt: st.mtimeMs,
      origin: {
        client: 'doubao',
        originalId: opts.sessionId,
        raw: { agentId: agent.agentId, trajectory: trajFile },
      },
      turns,
      warnings,
    };
    return { session, warnings };
  }

  async write(_session: UirSession, _opts: WriteOptions = {}): Promise<WriteResult> {
    // capability.canWrite=false；registry.writeSession 会先行拦截并给出友好提示
    throw new Error('豆包为云端智能体会话，暂不支持写入（可从豆包读取导出到其他端）');
  }
}

/**
 * 会话的沙箱工作目录：豆包把每个会话的工作文件放在
 * ~/Doubao/chats/<日期>/<会话名>/ —— 与 .sessions 无 ID 关联，
 * 这里返回轨迹所在 .sessions 路径作为 cwd 兜底（UIR 要求非空 cwd）。
 */
function workspaceDirOf(sessionDir: string): string {
  return sessionDir;
}

function safeJson(s: unknown): unknown {
  if (typeof s !== 'string') return s ?? {};
  try { return JSON.parse(s); } catch { return {}; }
}

export const doubaoAdapter = new DoubaoAdapter();
