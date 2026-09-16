import { describe, it, expect, vi } from 'vitest';
import { callLLMWithStructuredOutput } from '../graph/nodes/utils.ts';
import { emitAnalysisSkill, emitConditionSkill } from '../graph/skills/emit-condition-skill.ts';
import { createAnalystOutputProfile } from '../graph/structured-output/analyst.ts';

/**
 * Phase 1.25 emit-repair — 当 emit-extract 拼装后跨字段校验失败时，不落整批
 * Phase 2 JSON 重发，而是复用已声明实体 + 只开放 emit_* 工具让 LLM 定点重发。
 */
describe('Phase 1.25 emit-repair', () => {
  it('re-emits only the failing entity and converges without full JSON re-extraction', async () => {
    let callCount = 0;
    // 模拟：round1 emit 一个坏 flow 条件（无 flowStepRefs）→ parse 因 validateConditionTypes
    // 失败；修补轮 round3 重发同一 id 带 flowStepRefs → 收敛。
    const provider = {
      streamChat: vi.fn(async function* () {
        callCount += 1;
        // Emit 主循环
        if (callCount === 1) {
          yield { type: 'content', content: 'emitting' };
          yield { type: 'tool_call_start', toolCall: { id: 'e1', name: 'emit_condition', args: {} } };
          yield { type: 'tool_call_end', toolCall: { id: 'e1', name: 'emit_condition', args: {
            id: 'C-1', requirementId: 'REQ-1', condition: 'Verify cross-component login', conditionType: 'flow',
            category: 'integration', priority: 'critical', riskLevel: 'critical',
            primaryTechnique: 'Use Case Testing', techniqueRationale: 'cross-component journey', coverageDimensions: ['integration'],
            // 缺 flowStepRefs —— 工具 schema 通过（default []），但 parse 的 validateConditionTypes 会拒
          } } };
          yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
          return;
        }
        if (callCount === 2) {
          yield { type: 'content', content: 'no more tools' };
          yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
          return;
        }
        // 修补轮：重发 C-1 带 flowStepRefs
        if (callCount === 3) {
          yield { type: 'content', content: 'repairing' };
          yield { type: 'tool_call_start', toolCall: { id: 'r1', name: 'emit_condition', args: {} } };
          yield { type: 'tool_call_end', toolCall: { id: 'r1', name: 'emit_condition', args: {
            id: 'C-1', requirementId: 'REQ-1', condition: 'Verify cross-component login', conditionType: 'flow',
            flowStepRefs: [{ flowId: 'FLOW-1', sequence: 1, actionSummary: 'Auth API returns 200' }],
            category: 'integration', priority: 'critical', riskLevel: 'critical',
            primaryTechnique: 'Use Case Testing', techniqueRationale: 'cross-component journey', coverageDimensions: ['integration'],
          } } };
          yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
          return;
        }
        // 修补轮退出
        yield { type: 'content', content: 'no more tools' };
        yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
      }),
    } as any;

    const profile = createAnalystOutputProfile();
    const { output, toolCallRecords } = await callLLMWithStructuredOutput(
      provider,
      [] as any,
      [emitAnalysisSkill, emitConditionSkill] as any,
      profile,
      undefined,
      'test_analyst',
    );

    // 收敛：输出只有 1 个条件，且带 flowStepRefs
    const parsed = output as any;
    expect(parsed.testConditions).toHaveLength(1);
    expect(parsed.testConditions[0].id).toBe('C-1');
    expect(parsed.testConditions[0].flowStepRefs).toHaveLength(1);
    // 修补轮确实被触发（总 streamChat 调用 > 主循环需要的 2 次）
    expect(provider.streamChat).toHaveBeenCalledTimes(4);
  });
});