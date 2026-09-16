import type { TestGenState, CrossEpicDependency } from '../state';
import type { AgentObserver } from './types';
import { requirementRepo } from '../../../requirements/repository.ts';
import { Log } from '../../../../shared/services/logger.ts';
import { requirementsFromHtmlSnapshot } from '../../html-knowledge/requirement-snapshot.ts';
import {
  requireMatchingHtmlKnowledgeRuntime,
  type ResolvedHtmlKnowledgeRuntime,
} from '../skills/html-knowledge.ts';

export interface PreparationNodeOptions {
  observer?: AgentObserver;
  htmlKnowledge?: ResolvedHtmlKnowledgeRuntime;
}

export function makePreparationNode(opts: PreparationNodeOptions) {
  const { observer } = opts;
  const agentName = 'preparation';
  const log = Log.for(agentName);

  return async (state: TestGenState): Promise<Partial<TestGenState>> => {
    const startTime = Date.now();
    const htmlKnowledge = requireMatchingHtmlKnowledgeRuntime(
      state.projectId,
      state.htmlKnowledgeReference,
      opts.htmlKnowledge,
    );
    observer?.onStart?.(agentName);

    const reqCount = state.currentBatch?.length ?? 0;
    const batchInfo = `${state.batchContext?.currentBatch ?? 1}/${state.batchContext?.totalBatches ?? 1}`;
    const flowCount = state.businessFlowBlueprints?.length ?? 0;
    const selectedFlowCount = state.selectedFlowIds?.length ?? 0;

    observer?.onStep?.(agentName, 0, `Preparing: ${reqCount} requirements, ${flowCount} flows, ${selectedFlowCount} user-selected (${batchInfo})`);

    log.info(`ENTER ── batch ${batchInfo}, ${reqCount} requirements, ${flowCount} flows, ${selectedFlowCount} user-selected`);
    log.kv('mode', state.mode);
    log.kv('userSelectedFlows', selectedFlowCount);

    // ── L2 Association Layer Precomputation ──
    const currentReqIds = new Set((state.currentBatch ?? []).map(r => r.id));
    const allReqs = htmlKnowledge
      ? requirementsFromHtmlSnapshot(htmlKnowledge.snapshot)
      : requirementRepo.listByProject(state.projectId);
    const epicTitleMap = new Map<string, string>();
    const epicIdSet = new Set<string>();
    if (state.globalEpicIndex) {
      for (const e of state.globalEpicIndex) {
        epicTitleMap.set(e.epicId, e.title);
        epicIdSet.add(e.epicId);
      }
    }
    // Dynamically build reqId → epicId: walk up from each requirement to find the root, which is the epicId
    const parentMap = new Map<string, string | null>();
    for (const r of allReqs) parentMap.set(r.id, r.parentId ?? null);
    const reqEpicMap = new Map<string, { epicId: string; epicTitle: string }>();
    for (const r of allReqs) {
      let current: string | null = r.id;
      for (let depth = 0; depth < 20 && current; depth++) {
        if (epicIdSet.has(current)) {
          reqEpicMap.set(r.id, {
            epicId: current,
            epicTitle: epicTitleMap.get(current) ?? current,
          });
          break;
        }
        current = parentMap.get(current) ?? null;
      }
    }
    // Current Epic ID: inferred from the epicId of any requirement in the batch
    let currentEpicId: string | null = null;
    for (const reqId of currentReqIds) {
      const m = reqEpicMap.get(reqId);
      if (m) { currentEpicId = m.epicId; break; }
    }

    const crossEpicDependencies: CrossEpicDependency[] = [];
    if (currentEpicId && currentReqIds.size > 0) {
      // Cross-epic relationships are now derived from AC-level
      // relatedRequirementIds (flow ACs reference component stories in other
      // epics). The legacy `dependencies` field has been removed.
      // Build an adjacency: requirementId → set of referenced requirementIds.
      const refAdjacency = new Map<string, Set<string>>();
      const reverseRef = new Map<string, Set<string>>();
      for (const r of allReqs) {
        if (r.level !== 'ac') continue;
        for (const refId of r.relatedRequirementIds ?? []) {
          if (!refAdjacency.has(r.id)) refAdjacency.set(r.id, new Set());
          refAdjacency.get(r.id)!.add(refId);
          if (!reverseRef.has(refId)) reverseRef.set(refId, new Set());
          reverseRef.get(refId)!.add(r.id);
        }
      }
      // Pre-build indexes once instead of filter/find inside the loop (O(batch×N×refs) → O(N+batch×refs)).
      const childACsByParent = new Map<string, (typeof allReqs)[number][]>();
      const reqById = new Map<string, (typeof allReqs)[number]>();
      for (const r of allReqs) {
        if (r.level === 'ac') {
          if (!childACsByParent.has(r.parentId)) childACsByParent.set(r.parentId, []);
          childACsByParent.get(r.parentId)!.push(r);
        }
        reqById.set(r.id, r);
      }
      // For each requirement in the current batch, walk up to its AC children
      // and check whether their relatedRequirementIds point to requirements in
      // other epics (outgoing cross-epic refs).
      for (const reqId of currentReqIds) {
        const childACs = childACsByParent.get(reqId) ?? [];
        for (const ac of childACs) {
          for (const refId of ac.relatedRequirementIds ?? []) {
            if (currentReqIds.has(refId)) continue; // same batch
            const refReq = reqById.get(refId);
            const refEpic = reqEpicMap.get(refId);
            if (refReq && refEpic && refEpic.epicId !== currentEpicId) {
              crossEpicDependencies.push({
                fromRequirementId: reqId,
                toRequirementId: refId,
                toEpicId: refEpic.epicId,
                toEpicTitle: refEpic.epicTitle,
                toRequirementTitle: refReq.title,
                relationType: 'referenced-by',
              });
            }
          }
        }
        // Incoming: other epics' ACs reference current batch requirements.
        const referencingACIds = reverseRef.get(reqId);
        if (referencingACIds) {
          for (const acId of referencingACIds) {
            const acReq = reqById.get(acId);
            if (!acReq) continue;
            // The referencing AC's parent story is the cross-epic source.
            const sourceStoryId = acReq.parentId;
            if (!sourceStoryId || currentReqIds.has(sourceStoryId)) continue;
            const sourceEpic = reqEpicMap.get(sourceStoryId);
            if (sourceEpic && sourceEpic.epicId !== currentEpicId) {
              crossEpicDependencies.push({
                fromRequirementId: reqId,
                toRequirementId: sourceStoryId,
                toEpicId: sourceEpic.epicId,
                toEpicTitle: sourceEpic.epicTitle,
                toRequirementTitle: acReq.title,
                relationType: 'references',
              });
            }
          }
        }
      }
    }

    // L2 association layer: filter flow blueprints relevant to the current batch requirements
    // Preferentially include user-explicitly-selected flows (strong signal for integration tests),
    // then supplement with other flows that share requirementId overlap with the current batch as additional integration scenarios
    const allBlueprints = state.businessFlowBlueprints ?? [];
    const selectedFlowIdSet = new Set(state.selectedFlowIds ?? []);
    const relevantFlowBlueprints = allBlueprints.filter(f => {
      if (selectedFlowIdSet.has(f.id)) return true; // User-selected flows are always retained
      return f.steps?.some((s: any) =>
        (s.requirementIds ?? []).some((rid: string) => currentReqIds.has(rid))
      );
    });
    // Mark which flows were explicitly selected by the user, so the prompt can distinguish strong signals vs. derived ones
    const relevantFlowsWithFlag = relevantFlowBlueprints.map(f => ({
      ...f,
      userSelected: selectedFlowIdSet.has(f.id),
    }));

    log.kv('crossEpicDeps', crossEpicDependencies.length);
    log.kv('relevantFlows', `${relevantFlowBlueprints.length}/${allBlueprints.length} (user-selected: ${selectedFlowIdSet.size})`);

    const avgTokensPerReq = 1000;
    const estimated = reqCount * avgTokensPerReq;
    log.kv('tokenBudget.estimated', estimated);

    observer?.onStep?.(agentName, 1, `Token estimation: ~${estimated} tokens; cross-epic deps: ${crossEpicDependencies.length}`);

    if (flowCount > 0) {
      log.kv('flows', flowCount);
    }

    const latencyMs = Date.now() - startTime;
    observer?.onComplete?.(agentName, { input: 0, output: 0, reasoning: 0 }, latencyMs);
    log.success(`EXIT ── environment ready (${latencyMs}ms)`);

    return {
      crossEpicDependencies,
      relevantFlowBlueprints: relevantFlowsWithFlag,
      phase: 'analysis',
    };
  };
}
