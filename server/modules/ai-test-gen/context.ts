import { Semaphore } from './infra/semaphore.ts';
import { createAIProvider } from './infra/provider.ts';
import { computePromptVersion } from './infra/prompt-version.ts';
import { pipelineRepo, decryptApiKey } from './repository.ts';
import { SSEGateway } from './sse-gateway.ts';
import { RunScope } from './scope.ts';
import { TestGenSession } from './session.ts';
import type { AgentObserver } from './graph/nodes/types.ts';
import type { AIProvider } from './infra/provider.ts';
import { AGENT_NODE_TIMEOUT_MS } from './graph/timing.ts';
import { Log } from '../../shared/services/logger.ts';
import {
  HtmlKnowledgeRepository,
  type BoundHtmlKnowledgeData,
} from './html-knowledge/repository.ts';
import {
  hashHtmlRequirementSnapshot,
  requirementsFromHtmlSnapshot,
} from './html-knowledge/requirement-snapshot.ts';
import {
  HTML_KNOWLEDGE_INDEX_VERSION,
  type HtmlKnowledgeReference,
  type HtmlRequirementSnapshot,
} from './html-knowledge/types.ts';
import {
  createHtmlKnowledgeQueryCache,
  type HtmlKnowledgeBoundSetRepository,
  type ResolvedHtmlKnowledgeRuntime,
} from './graph/skills/html-knowledge.ts';
import { RunCacheRegistry, runCacheRegistry } from './run-cache-registry.ts';
import { ConflictError } from '../../shared/http/errors.ts';

export interface RunContext {
  runId: string;
  projectId: string;
  mode: 'auto' | 'interactive';
  provider: AIProvider;
  promptVersion: string;
  modelName: string;
  tokenLimit: number | null;
  scope: RunScope;
  session: TestGenSession;
  htmlKnowledge?: ResolvedHtmlKnowledgeRuntime;
  abortSignal: AbortSignal;
  sendEvent: (event: string, data: unknown) => void;
  isAborted: () => boolean;
  releaseSlot: () => void;
}

export interface StartParams {
  requirementIds: string[];
  providerConfigName?: string;
  model?: string;
  mode: 'auto' | 'interactive';
  flowIds?: string[];
  useCache?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high';
  reasoningSummary?: 'auto' | 'detailed' | 'concise';
  textVerbosity?: 'low' | 'medium' | 'high';
  referenceRunIds?: string[];
  htmlKnowledgeSetId?: string;
}

export class RunCancelledError extends Error {
  constructor() {
    super('Test gen run cancelled');
    this.name = 'RunCancelledError';
  }
}

export class HtmlKnowledgeRuntimeError extends Error {
  readonly code = 'HTML_KNOWLEDGE_UNAVAILABLE';
  readonly recoverable = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HtmlKnowledgeRuntimeError';
  }
}

export interface ContextBuildConfig {
  providerConfigName?: string;
  model?: string;
  useCache?: boolean;
  currentBatch?: number;
  reasoningEffort?: string;
  reasoningSummary?: string;
  textVerbosity?: string;
  htmlKnowledgeSetId?: string;
}

interface RunLifecycle {
  readonly released: Promise<void>;
  readonly resolveReleased: () => void;
  slotAcquired: boolean;
  finished: boolean;
}

interface ExternalRunOperation {
  readonly released: Promise<void>;
  readonly release: () => void;
}

export class ContextBuilder {
  private readonly abortedRuns = new Set<string>();
  private readonly deletionTombstones = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly lifecycles = new Map<string, RunLifecycle>();
  private readonly externalOperations = new Map<string, Set<ExternalRunOperation>>();
  private readonly concurrencySlot: Semaphore;

  constructor(
    private readonly sseGateway: SSEGateway,
    maxConcurrent = 3,
    private readonly htmlKnowledgeRepository: HtmlKnowledgeBoundSetRepository = new HtmlKnowledgeRepository(),
    private readonly cacheRegistry: RunCacheRegistry = runCacheRegistry,
  ) {
    this.concurrencySlot = new Semaphore(maxConcurrent);
  }

  abort(runId: string): void {
    this.abortedRuns.add(runId);
    this.abortControllers.get(runId)?.abort();
    if (!this.lifecycles.has(runId) && !this.deletionTombstones.has(runId)) {
      this.abortedRuns.delete(runId);
    }
  }

  beginDeletion(runId: string): boolean {
    const wasActive = this.lifecycles.has(runId);
    this.deletionTombstones.add(runId);
    this.abort(runId);
    return wasActive;
  }

  async waitForQuiescence(runId: string): Promise<void> {
    const lifecycle = this.lifecycles.get(runId)?.released;
    const externalOperations = [...(this.externalOperations.get(runId) ?? [])]
      .map((operation) => operation.released);
    await Promise.all([
      ...(lifecycle ? [lifecycle] : []),
      ...externalOperations,
    ]);
  }

  registerExternalOperation(runId: string): () => void {
    if (this.deletionTombstones.has(runId)) {
      throw new ConflictError('Test gen run is being deleted');
    }

    let resolveReleased!: () => void;
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    let finished = false;
    const operation: ExternalRunOperation = {
      released,
      release: () => {
        if (finished) return;
        finished = true;
        const operations = this.externalOperations.get(runId);
        operations?.delete(operation);
        if (operations?.size === 0) this.externalOperations.delete(runId);
        resolveReleased();
      },
    };
    const operations = this.externalOperations.get(runId) ?? new Set();
    operations.add(operation);
    this.externalOperations.set(runId, operations);
    return operation.release;
  }

  finishDeletion(runId: string): void {
    this.deletionTombstones.delete(runId);
    this.abortedRuns.delete(runId);
    this.abortControllers.delete(runId);
  }

  isCancellationRequested(runId: string): boolean {
    return this.abortedRuns.has(runId);
  }

  async build(
    runId: string,
    projectId: string,
    mode: 'auto' | 'interactive',
    config: ContextBuildConfig = {},
  ): Promise<RunContext> {
    if (this.lifecycles.has(runId)) {
      throw new Error(`Test gen run ${runId} already has active work`);
    }
    let resolveReleased!: () => void;
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    const lifecycle: RunLifecycle = {
      released,
      resolveReleased,
      slotAcquired: false,
      finished: false,
    };
    this.lifecycles.set(runId, lifecycle);
    const abortController = new AbortController();
    this.abortControllers.set(runId, abortController);
    if (this.abortedRuns.has(runId)) abortController.abort();

    const isAborted = () => this.abortedRuns.has(runId) || abortController.signal.aborted;
    const sendEvent = (event: string, data: unknown) => {
      if (!isAborted()) this.sseGateway.emit(runId, event, data);
    };

    let htmlKnowledge: ResolvedHtmlKnowledgeRuntime | undefined;
    try {
      await this.concurrencySlot.acquire(undefined, abortController.signal);
      lifecycle.slotAcquired = true;
      if (isAborted()) throw new RunCancelledError();

      if (config.htmlKnowledgeSetId !== undefined) {
        if (typeof config.htmlKnowledgeSetId !== 'string' || !config.htmlKnowledgeSetId) {
          throw new HtmlKnowledgeRuntimeError(
            'Configured HTML knowledge set ID is invalid',
          );
        }
        htmlKnowledge = this.resolveHtmlKnowledge(
          runId,
          projectId,
          config.htmlKnowledgeSetId,
        );
      }

      const providerConfigRow = config.providerConfigName
        ? pipelineRepo.getProviderConfigByName(config.providerConfigName)
        : pipelineRepo.getActiveProviderConfig();
      if (!providerConfigRow) {
        throw new Error('No active AI provider configuration found. Go to Settings → AI Provider to configure one.');
      }

      const monthlyLimit = providerConfigRow.monthly_token_limit as number | null;
      if (monthlyLimit) {
        const used = pipelineRepo.getMonthlyTokenUsage(projectId);
        if (used >= monthlyLimit) {
          throw new Error(`Monthly token limit exceeded (${used}/${monthlyLimit}).`);
        }
      }

// Resolve model: explicit param > provider config models[0] > provider config model
      const resolvedModel = config.model
        || (providerConfigRow.models ? JSON.parse(providerConfigRow.models || '[]')[0] : undefined)
        || providerConfigRow.model
        || providerConfigRow.deployment;
      // For azure-openai, the deployment drives the actual call. When the user
      // explicitly selected a model, use it as the deployment name so intent
      // matches execution. Fall back to the stored deployment otherwise.
      const deployment = config.model || providerConfigRow.deployment;

      const provider = createAIProvider({
        type: providerConfigRow.type as any,
        endpoint: providerConfigRow.endpoint,
        apiKey: decryptApiKey(providerConfigRow.encrypted_api_key),
        deployment,
        apiVersion: providerConfigRow.api_version,
        model: resolvedModel,
        reasoningEffort: (config.reasoningEffort ?? providerConfigRow.reasoning_effort ?? undefined) as any,
        reasoningSummary: (config.reasoningSummary ?? providerConfigRow.reasoning_summary ?? undefined) as any,
        textVerbosity: (config.textVerbosity ?? providerConfigRow.text_verbosity ?? undefined) as any,
      });
      Log.for('context').info(`AI provider ready: type=${providerConfigRow.type}, model=${resolvedModel || providerConfigRow.deployment || 'unknown'}`);

      const promptVersion = computePromptVersion();
      const modelName = resolvedModel || providerConfigRow.deployment || 'unknown';
      pipelineRepo.updateProviderInfo(runId, {
        providerType: providerConfigRow.type,
        modelName,
        promptVersion,
        providerConfigName: providerConfigRow.name || null,
        tokenLimit: providerConfigRow.monthly_token_limit ?? null,
      });

      const scope = new RunScope(runId, projectId, mode, sendEvent);
      if (config.currentBatch != null) scope.restoreBatchState(config.currentBatch);

      const observer: AgentObserver = {
        onStep: (agentName, stepIndex, stepName) => {
          scope.recordAgentStep(agentName, stepIndex, stepName);
        },
        onThinking: (agentName, text, type, phase) => {
          scope.recordAgentThinking(agentName, text, type, phase);
        },
        onStart: (agentName) => {
          scope.recordAgentStart(agentName);
        },
        onToolCall: (agentName, toolCall) => {
          scope.recordAgentToolCall(agentName, toolCall);
        },
        onComplete: (agentName, tokenUsage, latencyMs, inputPrompt, outputData) => {
          scope.recordAgentComplete(agentName, {
            tokenUsage,
            latencyMs,
            inputPrompt: inputPrompt as any,
            outputData,
          });
        },
        onError: (agentName, error) => {
          scope.recordAgentError(agentName, error);
        },
      };

      const session = new TestGenSession({
        runId,
        projectId,
        provider,
        observer,
        modelName,
        tokenLimit: providerConfigRow.monthly_token_limit ?? null,
        timeoutMs: AGENT_NODE_TIMEOUT_MS,
        useCache: config.useCache ?? false,
        signal: abortController.signal,
        htmlKnowledge,
      });

      let releasedSlot = false;
      return {
        runId,
        projectId,
        mode,
        provider,
        promptVersion,
        modelName,
        tokenLimit: providerConfigRow.monthly_token_limit ?? null,
        scope,
        session,
        htmlKnowledge,
        abortSignal: abortController.signal,
        sendEvent,
        isAborted,
        releaseSlot: () => {
          if (releasedSlot) return;
          releasedSlot = true;
          try {
            htmlKnowledge?.dispose();
          } finally {
            try {
              scope.dispose();
            } finally {
              this.finishLifecycle(runId, lifecycle);
            }
          }
        },
      };
    } catch (error) {
      try {
        htmlKnowledge?.dispose();
      } catch {
        Log.for('context').error(`Failed to dispose HTML knowledge runtime: runId=${runId}`);
      }
      this.finishLifecycle(runId, lifecycle);
      if (isAborted()) throw new RunCancelledError();
      throw error;
    }
  }

  private resolveHtmlKnowledge(
    runId: string,
    projectId: string,
    expectedSetId: string,
  ): ResolvedHtmlKnowledgeRuntime {
    let bound: BoundHtmlKnowledgeData | undefined;
    try {
      bound = this.htmlKnowledgeRepository.loadBoundSetByRun(
        projectId,
        runId,
        expectedSetId,
      );
    } catch (error) {
      throw new HtmlKnowledgeRuntimeError(
        'Configured HTML knowledge is corrupt or unreadable',
        { cause: error },
      );
    }
    if (!bound) {
      throw new HtmlKnowledgeRuntimeError(
        'Configured HTML knowledge is unavailable for this run',
      );
    }

    let reference: HtmlKnowledgeReference;
    let snapshot: HtmlRequirementSnapshot;
    try {
      reference = validateBoundHtmlKnowledge(
        bound,
        runId,
        projectId,
        expectedSetId,
      );
      snapshot = freezeSnapshot(bound.requirementSnapshot);
      requirementsFromHtmlSnapshot(snapshot);
      this.htmlKnowledgeRepository.verifyBoundReference(runId, projectId, reference);
    } catch (error) {
      throw new HtmlKnowledgeRuntimeError(
        'Configured HTML knowledge failed integrity validation',
        { cause: error },
      );
    }

    const cache = createHtmlKnowledgeQueryCache();
    let disposed = false;
    let unregister = () => undefined;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      unregister();
      cache.dispose();
    };
    try {
      unregister = this.cacheRegistry.register(runId, dispose);
    } catch (error) {
      cache.dispose();
      throw new HtmlKnowledgeRuntimeError(
        'Configured HTML knowledge cache could not be initialized',
        { cause: error },
      );
    }

    return Object.freeze({
      projectId,
      reference,
      snapshot,
      repository: this.htmlKnowledgeRepository,
      cache,
      dispose,
    });
  }

  private finishLifecycle(runId: string, lifecycle: RunLifecycle): void {
    if (lifecycle.finished) return;
    lifecycle.finished = true;
    if (lifecycle.slotAcquired) this.concurrencySlot.release();
    this.lifecycles.delete(runId);
    this.abortControllers.delete(runId);
    if (!this.deletionTombstones.has(runId)) this.abortedRuns.delete(runId);
    lifecycle.resolveReleased();
  }
}

function validateBoundHtmlKnowledge(
  bound: BoundHtmlKnowledgeData,
  runId: string,
  projectId: string,
  expectedSetId: string,
): HtmlKnowledgeReference {
  const { set, pages, relations, requirementSnapshot } = bound;
  if (set.id !== expectedSetId
    || set.project_id !== projectId
    || set.run_id !== runId
    || set.status !== 'BOUND'
    || set.index_version !== HTML_KNOWLEDGE_INDEX_VERSION
    || !set.requirement_snapshot_hash
    || set.requirement_snapshot_hash !== hashHtmlRequirementSnapshot(requirementSnapshot)
    || set.page_count !== pages.length
    || !Number.isSafeInteger(set.total_bytes)
    || set.total_bytes < 0) {
    throw new Error('Bound HTML knowledge set metadata is inconsistent');
  }

  const pageIds = new Set<string>();
  const chunkIds = new Set<string>();
  for (const page of pages) {
    if (page.version !== HTML_KNOWLEDGE_INDEX_VERSION
      || pageIds.has(page.pageId)
      || !page.pageTitle) {
      throw new Error('Bound HTML knowledge page metadata is inconsistent');
    }
    pageIds.add(page.pageId);
    for (const chunk of page.chunks) {
      if (chunk.pageId !== page.pageId || chunkIds.has(chunk.id)) {
        throw new Error('Bound HTML knowledge chunk graph is inconsistent');
      }
      chunkIds.add(chunk.id);
    }
  }
  for (const relation of relations) {
    if (!pageIds.has(relation.fromPageId) || !pageIds.has(relation.toPageId)) {
      throw new Error('Bound HTML knowledge page graph references an unknown page');
    }
  }

  return Object.freeze({
    knowledgeSetId: set.id,
    pageCount: set.page_count,
    totalBytes: set.total_bytes,
    pageTitles: Object.freeze(pages.map((page) => page.pageTitle)),
    hasLowInformationPages: pages.some(
      (page) => page.informationLevel === 'LOW_INFORMATION',
    ),
    requirementSnapshotHash: set.requirement_snapshot_hash,
  });
}

function freezeSnapshot(snapshot: HtmlRequirementSnapshot): HtmlRequirementSnapshot {
  return Object.freeze({
    ...snapshot,
    selectedRequirementIds: Object.freeze([...snapshot.selectedRequirementIds]),
    selectedFlowIds: Object.freeze([...snapshot.selectedFlowIds]),
    records: Object.freeze(snapshot.records.map((record) => Object.freeze({
      ...record,
      relatedRequirementIds: Object.freeze([...record.relatedRequirementIds]),
    }))),
  });
}
