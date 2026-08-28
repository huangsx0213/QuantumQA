// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { recorderReducer } from '../ai-driven-recorder-reducer';
import { createInitialState, type RecorderRunState, type RecorderStep } from '../types';

/**
 * 复现并锁定 AI Recorder 运行面板的索引错位回归：
 * Agent 事件 nlStepIndex 为 0-based；前端播种必须使用同一基准。
 * 之前误用 1-based sequence 播种，导致：
 *   - 事件 0（第一条）匹配不到被丢弃
 *   - 事件 1..n-1 命中后一张卡片并覆盖其指令（整表错位一格）
 *   - 最后一张永远 PENDING
 */

function seedSteps(instructions: string[], base: number): RecorderStep[] {
  return instructions.map((instruction, i) => ({
    nlStepIndex: base + i,
    instruction,
    status: 'pending' as const,
    retryCount: 0,
  }));
}

function stateWith(steps: RecorderStep[]): RecorderRunState {
  return { ...createInitialState(), runId: 'r1', status: 'running', steps };
}

function runEvents(state: RecorderRunState, count: number) {
  let s = state;
  for (let idx = 0; idx < count; idx++) {
    s = recorderReducer(s, { type: 'STEP_START', runId: 'r1', nlStepIndex: idx, instruction: `instr-${idx}`, expected: '' });
    s = recorderReducer(s, { type: 'STEP_FAILED', runId: 'r1', nlStepIndex: idx, error: `boom-${idx}` });
  }
  return s;
}

describe('recorderReducer step index alignment', () => {
  const instructions = ['enter username', 'enter password', 'click sign in'];

  it('0-based seeding: every event updates its own card; none left pending', () => {
    const initial = stateWith(seedSteps(instructions, 0));
    const final = runEvents(initial, 3);

    expect(final.steps.map((s) => s.status)).toEqual(['failed', 'failed', 'failed']);
    // STEP_START 会用事件内文本覆盖指令；对齐后覆盖值与原指令一致
    expect(final.steps.map((s) => s.instruction)).toEqual(['instr-0', 'instr-1', 'instr-2']);
    expect(final.steps.every((s) => s.error?.startsWith('boom-'))).toBe(true);
  });

  it('documents the historical 1-based seeding bug: first event dropped, last card pending', () => {
    const initial = stateWith(seedSteps(instructions, 1));
    const final = runEvents(initial, 3);

    // 事件 0 无匹配；事件 1..2 命中前两张；第三张永远 pending
    expect(final.steps[0].status).toBe('failed');
    expect(final.steps[1].status).toBe('failed');
    expect(final.steps[2].status).toBe('pending');
  });

  it('STEP_FAILED on out-of-range index is a no-op', () => {
    const initial = stateWith(seedSteps(instructions, 0));
    const final = recorderReducer(initial, { type: 'STEP_FAILED', runId: 'r1', nlStepIndex: 99, error: 'x' });

    expect(final.steps.map((s) => s.status)).toEqual(['pending', 'pending', 'pending']);
  });

  it('STEP_COMPLETE marks only the targeted card completed', () => {
    const initial = stateWith(seedSteps(instructions, 0));
    const afterStart = recorderReducer(initial, { type: 'STEP_START', runId: 'r1', nlStepIndex: 1, instruction: 'enter password', expected: '' });
    const final = recorderReducer(afterStart, { type: 'STEP_COMPLETE', runId: 'r1', nlStepIndex: 1, recordedStepCount: 2, durationMs: 1500 });

    expect(final.steps[1].status).toBe('completed');
    expect(final.steps[1].durationMs).toBe(1500);
    expect(final.steps[0].status).toBe('pending');
    expect(final.steps[2].status).toBe('pending');
  });
});
describe('recorderReducer confirm phase', () => {
  it('CONFIRM_START marks the phase running', () => {
    let s = recorderReducer(createInitialState(), { type: 'START_REQUEST', nlCaseId: 'c1', providerConfigId: 'p1' });
    s = recorderReducer(s, { type: 'CONFIRM_START', runId: 'r1' });
    expect(s.confirmPhase).toEqual({ phase: 'running' });
  });

  it('CONFIRM_COMPLETE records the verdict summary', () => {
    let s = recorderReducer(createInitialState(), { type: 'CONFIRM_COMPLETE', runId: 'r1', completedRuns: 2, confirmed: 2, review: 1, blockedByInfraFailure: false });
    expect(s.confirmPhase).toEqual({ phase: 'done', completedRuns: 2, confirmed: 2, review: 1, blockedByInfraFailure: false });

    s = recorderReducer(s, { type: 'CONFIRM_COMPLETE', runId: 'r1', completedRuns: 0, confirmed: 0, review: 3, blockedByInfraFailure: true });
    expect(s.confirmPhase).toMatchObject({ phase: 'done', blockedByInfraFailure: true, review: 3 });
  });
});
