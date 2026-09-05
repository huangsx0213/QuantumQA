import { Command, interrupt } from '@langchain/langgraph';
import { PHASE_BY_CHECKPOINT } from '../state';
import type { TestGenState, Phase } from '../state';
import { Log } from '../../../../shared/services/logger.ts';

interface CheckpointInterruptPayload {
  checkpointNumber: number;
  phase: Phase;
  conditions?: unknown[];
  analysis?: unknown;
  cases?: unknown[];
  matrix?: unknown;
}

const NEXT_AGENT: Record<number, string> = {
  1: 'designer',
  2: 'quality',
  3: 'complete',
};

const RETURN_AGENT: Record<number, string> = {
  1: 'analyst',
  2: 'designer',
  3: 'quality',
};

type CheckpointResponse = {
  conditions?: unknown[];
  cases?: unknown[];
  analysis?: unknown;
  matrix?: unknown;
  feedback?: string;
  retry?: boolean;
};

export function makeCheckpoint(checkpointNum: number) {
  return (state: TestGenState): Command => {
    const log = Log.for(`checkpoint_${checkpointNum}`);
    const phase = PHASE_BY_CHECKPOINT[checkpointNum] ?? `checkpoint_${checkpointNum}` as Phase;

    if (state.mode === 'auto') {
      // Forward-only flow: coverage gaps surface in the coverage report / review
      // queue rather than re-running the LLM (no backward repair loops).
      if (checkpointNum === 1) {
        const conditions = state.testConditions ?? [];
        // Self-heal once: the analyst must produce at least one condition. Required
        // fields are already enforced by the contract schema, so an empty result is
        // the only incompleteness signal worth routing back for.
        if (conditions.length === 0 && !state.humanReviewFeedback) {
          log.warn('AUTO gate: no conditions generated ── routing back to analyst once');
          return new Command({
            goto: RETURN_AGENT[checkpointNum],
            update: {
              humanReviewFeedback: 'Auto-gate: no test conditions were generated. You MUST derive at least one test condition.',
            },
          });
        }
        log.info(`AUTO mode ── auto-pass ✓ (${conditions.length} conditions)`);
        return new Command({
          goto: NEXT_AGENT[checkpointNum],
          update: {
            approvedConditions: conditions,
            humanReviewFeedback: '',
            phase: 'design' as Phase,
          },
        });
      }

      if (checkpointNum === 2) {
        const draftCases = state.draftTestCases ?? [];
        log.info(`AUTO mode ── auto-pass ✓ (${draftCases.length} draft cases)`);
        return new Command({
          goto: NEXT_AGENT[checkpointNum],
          update: {
            approvedDraftCases: draftCases,
            humanReviewFeedback: '',
            phase: 'quality' as Phase,
          },
        });
      }

      // checkpoint_3: proceed to complete; uncovered conditions are reported, not re-run.
      const missingCount = (state.coverageMatrix as any)?.summary?.missingConditions ?? 0;
      if (missingCount > 0) {
        log.warn(`AUTO gate: ${missingCount} condition(s) uncovered ── proceeding to complete (visible in coverage report)`);
      }
      log.info(`AUTO mode ── auto-pass ✓ (${state.finalTestCases?.length ?? 0} final cases)`);
      return new Command({
        goto: NEXT_AGENT[checkpointNum],
        update: { phase: 'complete' as Phase },
      });
    }

    // Interactive mode: interrupt and wait for review
    const payload: CheckpointInterruptPayload = { checkpointNumber: checkpointNum, phase };

    switch (checkpointNum) {
      case 1: {
        const tcCount = state.testConditions?.length ?? 0;
        log.info(`ENTER ── ${tcCount} conditions awaiting review`);
        payload.conditions = state.testConditions;
        payload.analysis = state.requirementAnalysis;
        break;
      }
      case 2: {
        const draftCount = state.draftTestCases?.length ?? 0;
        log.info(`ENTER ── ${draftCount} draft cases awaiting review`);
        payload.cases = state.draftTestCases;
        break;
      }
      case 3: {
        const finalCount = state.finalTestCases?.length ?? 0;
        log.info(`ENTER ── ${finalCount} final cases awaiting review`);
        payload.cases = state.finalTestCases;
        payload.matrix = state.coverageMatrix;
        break;
      }
    }

    const response = interrupt<CheckpointResponse>(payload);

    if (response?.retry) {
      log.info(`Retry requested ── returning to ${RETURN_AGENT[checkpointNum]}`);
      return new Command({
        goto: RETURN_AGENT[checkpointNum],
        update: { humanReviewFeedback: response.feedback ?? '' },
      });
    }

    // Approve
    switch (checkpointNum) {
      case 1: {
        const approved = response?.conditions?.length ?? state.testConditions?.length ?? 0;
        log.success(`EXIT ── ${approved} conditions approved`);
        return new Command({
          goto: NEXT_AGENT[checkpointNum],
          update: {
            approvedConditions: (response?.conditions ?? state.testConditions ?? []) as any,
            humanReviewFeedback: response?.feedback ?? '',
            phase: 'design' as Phase,
          },
        });
      }
      case 2: {
        const approved = response?.cases?.length ?? state.draftTestCases?.length ?? 0;
        log.success(`EXIT ── ${approved} draft cases approved`);
        return new Command({
          goto: NEXT_AGENT[checkpointNum],
          update: {
            approvedDraftCases: (response?.cases ?? state.draftTestCases ?? []) as any,
            humanReviewFeedback: response?.feedback ?? '',
            phase: 'quality' as Phase,
          },
        });
      }
      case 3: {
        log.success('EXIT ── test generation complete');
        return new Command({
          goto: NEXT_AGENT[checkpointNum],
          update: {
            finalTestCases: (response?.cases ?? state.finalTestCases ?? []) as any,
            coverageMatrix: (response?.matrix ?? state.coverageMatrix) as any,
            humanReviewFeedback: response?.feedback ?? '',
          },
        });
      }
      default:
        return new Command({ goto: NEXT_AGENT[checkpointNum] });
    }
  };
}