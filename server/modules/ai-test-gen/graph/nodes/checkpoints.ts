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
      // Auto mode quality gate for checkpoint_1: validate condition completeness
      if (checkpointNum === 1) {
        const conditions = state.testConditions ?? [];
        const issues: string[] = [];

        if (conditions.length === 0) {
          issues.push('No test conditions generated — Analyst output is empty.');
        } else {
          for (const c of conditions) {
            const cond = c as unknown as Record<string, unknown>;
            const cid = String(cond.id ?? 'unknown');
            if (!cond.primaryTechnique) {
              issues.push(`${cid}: missing primaryTechnique`);
            }
            if (!cond.conditionType) {
              issues.push(`${cid}: missing conditionType`);
            }
            if (!cond.requirementId) {
              issues.push(`${cid}: missing requirementId`);
            }
          }
        }

        // If issues found AND this is the first pass (no feedback yet), route back to analyst
        if (issues.length > 0 && !state.humanReviewFeedback) {
          log.warn(`AUTO gate: ${issues.length} condition issues found — routing back to analyst for correction`);
          return new Command({
            goto: RETURN_AGENT[checkpointNum],
            update: {
              humanReviewFeedback: `Auto-gate found condition issues that MUST be fixed:\n${issues.join('\n')}`,
            },
          });
        }

        // Second pass or no issues: approve and proceed.
        // Clear the auto-gate feedback so it does not leak into the Designer's prompt.
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
      log.info('AUTO mode ── auto-pass ✓');
      // checkpoint_2: if this is an auto-repair re-run, merge preserved cases with new draft cases
      if (checkpointNum === 2) {
        const draftCases = state.draftTestCases ?? [];
        const preserved = state.preservedCases;
        if (preserved && preserved.length > 0) {
          // Auto-repair path: merge previously-reviewed cases with newly generated ones
          const mergedCases = [...preserved, ...draftCases];
          // Restore the full condition list for Quality's coverage matrix
          const allConditions = state.allApprovedConditions ?? state.approvedConditions ?? state.testConditions ?? [];
          log.info(`AUTO repair merge: ${preserved.length} preserved + ${draftCases.length} new = ${mergedCases.length} total cases`);
          return new Command({
            goto: NEXT_AGENT[checkpointNum],
            update: {
              approvedDraftCases: mergedCases,
              approvedConditions: allConditions,
              humanReviewFeedback: '',
              phase: 'quality' as Phase,
            },
          });
        }
        return new Command({
          goto: NEXT_AGENT[checkpointNum],
          update: {
            approvedDraftCases: draftCases,
            humanReviewFeedback: '',
            phase: 'quality' as Phase,
          },
        });
      }
      // checkpoint_3: auto-repair loop — if coverage gaps detected, route back to Designer
      // with ONLY the missing conditions (incremental patch, not full re-run)
      if (checkpointNum === 3) {
        const matrix = state.coverageMatrix;
        const missingCount = (matrix as any)?.summary?.missingConditions ?? 0;
        const retryCount = state.designerRetryCount ?? 0;

        if (missingCount > 0 && retryCount < 1) {
          // Extract missing condition IDs from coverage matrix rows
          const missingRows = ((matrix as any)?.rows ?? []).filter(
            (r: any) => r.coverageStatus === 'missing',
          );
          const missingIds = missingRows.map((r: any) => r.conditionId).filter(Boolean);
          const missingSummary = missingRows
            .map((r: any) => `${r.conditionId}: ${r.conditionSummary ?? ''}`)
            .slice(0, 10)
            .join('\n');

          // Filter conditions to ONLY missing ones — Designer will generate cases only for these
          const allConditions = state.approvedConditions ?? state.testConditions ?? [];
          const missingConditions = allConditions.filter(c => missingIds.includes(c.id));
          // Preserve already-reviewed cases for merging after Designer re-run
          const existingCases = state.finalTestCases ?? [];

          log.warn(`AUTO gate: ${missingCount} conditions uncovered — routing to designer for INCREMENTAL patch (only ${missingConditions.length} missing conditions, ${existingCases.length} cases preserved)`);

          return new Command({
            goto: 'designer',
            update: {
              approvedConditions: missingConditions,
              preservedCases: existingCases,
              allApprovedConditions: allConditions,
              humanReviewFeedback: `Auto-gate: ${missingCount} condition(s) have no covering test case. You MUST design test cases for ONLY these missing conditions:\n${missingSummary}`,
              designerRetryCount: retryCount + 1,
            },
          });
        }

        if (missingCount > 0 && retryCount >= 1) {
          log.warn(`AUTO gate: ${missingCount} conditions still uncovered after ${retryCount} retry — proceeding to complete (will be visible in coverage report)`);
        }
      }
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