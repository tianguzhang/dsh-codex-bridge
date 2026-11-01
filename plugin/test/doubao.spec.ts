/**
 * test/doubao.spec.ts —— 豆包适配器测试（合成 fixture，真实格式实测于 2026-11-01）
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { doubaoAdapter, parseAssignment } from '../src/adapters/doubao/adapter.js';

// ── 合成豆包 User Data fixture ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-test-'));
const USER_DATA = path.join(TMP, 'User Data');
const SESSIONS = path.join(USER_DATA, 'Default', '.doubao', 'agent_mode', 'workspace', '.sessions');
const CONV = '38450581292660226';
const SYSTEM_DIR = path.join(SESSIONS, CONV, 'agents', 'm_test001', 'system');
fs.mkdirSync(SYSTEM_DIR, { recursive: true });

const ASSIGNMENT = [
  '## [2026-10-31T06:00:00.000Z] 需求',
  '排查网络卡顿，PPPoE 掉线',
  '',
  '## [2026-10-31T07:30:00.000Z] 需求',
  '改成静态 IP 试试',
].join('\n');
fs.writeFileSync(path.join(SYSTEM_DIR, 'assignment.md'), ASSIGNMENT, 'utf8');

const TRAJECTORY = [
  JSON.stringify({ role: 'user', content: '排查网络卡顿，PPPoE 掉线' }),
  JSON.stringify({
    role: 'assistant',
    content: '先看拨号状态。',
    tool_calls: [{
      id: 'tc-1', type: 'function',
      function: { name: 'Run', arguments: { command: 'plog dsl-provider' } },
    }],
  }),
  JSON.stringify({ role: 'tool', content: 'Plugin ppp loaded.', tool_call_id: 'tc-1' }),
  JSON.stringify({ role: 'user', content: '改成静态 IP 试试' }),
  JSON.stringify({ role: 'assistant', content: '已改好，验证通过。' }),
].join('\n');
fs.writeFileSync(path.join(SYSTEM_DIR, 'trajectory.jsonl'), TRAJECTORY, 'utf8');

// 让适配器指向 fixture
process.env['DOUBAO_HOME'] = USER_DATA;

afterAll(() => {
  delete process.env['DOUBAO_HOME'];
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('assignment.md 解析', () => {
  it('解析出两条需求并带时间戳', () => {
    const needs = parseAssignment(ASSIGNMENT);
    expect(needs.length).toBe(2);
    expect(needs[0].text).toContain('PPPoE');
    expect(needs[0].ts).toBe(Date.parse('2026-10-31T06:00:00.000Z'));
    expect(needs[1].ts).toBe(Date.parse('2026-10-31T07:30:00.000Z'));
  });

  it('无时间戳时不崩溃（ts=null）', () => {
    const needs = parseAssignment('## [not-a-date] 需求\n内容');
    expect(needs.length).toBe(1);
    expect(needs[0].ts).toBeNull();
    expect(needs[0].text).toContain('内容');
  });
});

describe('豆包适配器', () => {
  it('probe 检测到 fixture', () => {
    expect(doubaoAdapter.probe().available).toBe(true);
  });

  it('capability 为只读', () => {
    expect(doubaoAdapter.capability.client).toBe('doubao');
    expect(doubaoAdapter.capability.canRead).toBe(true);
    expect(doubaoAdapter.capability.canWrite).toBe(false);
  });

  it('list：标题来自 assignment.md，轮数正确', async () => {
    const list = await doubaoAdapter.list();
    const row = list.find((s) => s.id === CONV);
    expect(row).toBeTruthy();
    expect(row!.title).toContain('PPPoE');
    expect(row!.turns).toBe(2);
    expect(row!.client).toBe('doubao');
  });

  it('read：UIR 映射（user/assistant/tool_calls/tool-result 全链）', async () => {
    const { session } = await doubaoAdapter.read({ sessionId: CONV });
    expect(session.id).toBe(`doubao-${CONV}`);
    expect(session.title).toContain('PPPoE');
    expect(session.turns.length).toBe(2);

    const t0 = session.turns[0];
    expect(t0.userMessages[0]).toMatchObject({ kind: 'text', role: 'user' });
    // 轮次时间对齐 assignment 时间戳
    expect(t0.startedAt).toBe(Date.parse('2026-10-31T06:00:00.000Z'));
    expect(session.turns[1].startedAt).toBe(Date.parse('2026-10-31T07:30:00.000Z'));

    const step = t0.steps[0];
    const textBlock = step.blocks.find((b) => b.kind === 'text');
    expect(textBlock).toMatchObject({ role: 'assistant' });
    const call = step.blocks.find((b) => b.kind === 'tool-call') as any;
    expect(call.name).toBe('Run');
    expect(call.rawArgs).toContain('dsl-provider');

    const result = step.blocks.find((b) => b.kind === 'tool-result') as any;
    expect(result.callId).toBe('tc-1');
    expect(result.name).toBe('Run');   // 从 assistant tool_calls 反查
    expect(result.output.text).toContain('ppp loaded');
  });

  it('write 被拒绝且提示只读', async () => {
    const { emptySession } = await import('../src/uir/helpers.js');
    await expect(doubaoAdapter.write(emptySession({ client: 'mcp', originalId: 'x' })))
      .rejects.toThrow('暂不支持写入');
  });
});
