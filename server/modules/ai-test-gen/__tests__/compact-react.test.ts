import { describe, expect, it } from 'vitest';
import { compactReActConversation } from '../graph/nodes/utils.ts';
import type { ChatMessage } from '../infra/provider.ts';

function asst(round: number, toolIds: string[], content: string): ChatMessage {
  return {
    role: 'assistant',
    content,
    toolCalls: toolIds.map((id) => ({
      type: 'function' as const,
      function: { name: `tool_${round}`, arguments: '{}' },
      id,
    })),
  };
}

function tool(id: string, content: string): ChatMessage {
  return { role: 'tool', content, toolCallId: id };
}

/**
 * 构造一个 5 轮 ReAct 历史（base + 每轮 assistant(toolCalls) + N 个 tool）。
 * 超过 REACT_KEEP_RECENT_ROUNDS(3) 后，最早 2 轮的工具结果应被摘要化。
 */
function build5RoundHistory(): { all: ChatMessage[]; baseCount: number } {
  const base: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'user' },
  ];
  const rounds: ChatMessage[] = [
    asst(1, ['a1', 'a2'], 'round1 reasoning'),
    tool('a1', 'x'.repeat(5000)),
    tool('a2', 'y'.repeat(4000)),
    asst(2, ['b1'], 'round2 reasoning'),
    tool('b1', 'z'.repeat(3000)),
    asst(3, ['c1', 'c2', 'c3'], 'round3 reasoning'),
    tool('c1', 'p'.repeat(2000)),
    tool('c2', 'q'.repeat(2000)),
    tool('c3', 'r'.repeat(2000)),
    asst(4, ['d1'], 'round4 reasoning'),
    tool('d1', 's'.repeat(1500)),
    asst(5, ['e1'], 'round5 reasoning'),
    tool('e1', 't'.repeat(1000)),
  ];
  return { all: [...base, ...rounds], baseCount: base.length };
}

describe('compactReActConversation', () => {
  it('keeps the full history when round count is within the keep window', () => {
    const { all, baseCount } = build5RoundHistory();
    // 用 base + 3 轮以内的情况：这里直接用前 5 轮会压缩，改造一个 3 轮的输入
    const threeRound = all.slice(0, baseCount + 7); // base + round1 + round2 + round3
    const out = compactReActConversation(threeRound, baseCount);
    expect(out.length).toBe(threeRound.length);
    // 工具结果内容未被摘要化
    expect(out.find((m) => m.role === 'tool' && String(m.content).includes('earlier tool result'))).toBeUndefined();
  });

  it('summarizes tool results of rounds older than the keep window, keeping assistant messages intact', () => {
    const { all, baseCount } = build5RoundHistory();
    const out = compactReActConversation(all, baseCount);
    // base + 5 轮 → 最早 2 轮（round1/round2）的工具结果被摘要化
    const compactedTools = out.filter((m) => m.role === 'tool' && String(m.content).includes('[earlier tool result]'));
    expect(compactedTools.length).toBe(3); // round1 的 2 个 + round2 的 1 个
    // 最近 3 轮（round3/4/5）的工具结果保留完整：c1,c2,c3 / d1 / e1 = 5 个
    const fullTools = out.filter((m) => m.role === 'tool' && !String(m.content).includes('[earlier tool result]'));
    expect(fullTools.length).toBe(5);
  });

  it('preserves assistant ↔ tool pairing so provider APIs stay valid', () => {
    const { all, baseCount } = build5RoundHistory();
    const out = compactReActConversation(all, baseCount);
    // 所有 assistant(toolCalls) 的 id 都必须有对应的 tool 消息（无论摘要化与否）
    const toolIds = new Set<string>();
    for (const m of out) if (m.role === 'tool' && m.toolCallId) toolIds.add(m.toolCallId);
    for (const m of out) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) {
          expect(toolIds.has(tc.id), `tool_call_id ${tc.id} missing after compaction`).toBe(true);
        }
      }
    }
  });

  it('summarized tool results include a short preview and length note', () => {
    const { all, baseCount } = build5RoundHistory();
    const out = compactReActConversation(all, baseCount);
    const compacted = out.filter((m) => m.role === 'tool' && String(m.content).includes('[earlier tool result]'));
    for (const m of compacted) {
      const c = String(m.content);
      expect(c.length).toBeLessThan(300);
      expect(c).toMatch(/total \d+ chars/);
    }
  });
});
