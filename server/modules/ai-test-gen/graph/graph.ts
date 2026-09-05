import { StateGraph, START, END, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { AIProvider } from '../infra/provider.ts';
import { AGENT_NODE_TIMEOUT_MS } from './timing.ts';
import { TestGenStateAnnotation, type TestGenState } from './state.ts';
import { makePreparationNode } from './nodes/preparation.ts';
import { makeAnalystNode } from './nodes/analyst.ts';
import { makeDesignerNode } from './nodes/designer.ts';
import { makeQualityNode } from './nodes/quality.ts';
import { makeCheckpoint } from './nodes/checkpoints.ts';
import { makeCompleteNode } from './nodes/complete.ts';
import type { AgentObserver } from './nodes/types.ts';
import { Log } from '../../../shared/services/logger.ts';
import type { ResolvedHtmlKnowledgeRuntime } from './skills/html-knowledge.ts';

export interface BuildGraphOptions {
  provider: AIProvider;
  observer?: AgentObserver;
  modelName?: string;
  tokenLimit?: number | null;
  timeoutMs?: number;
  useCache?: boolean;
  signal?: AbortSignal;
  checkpointer?: BaseCheckpointSaver;
  htmlKnowledge?: ResolvedHtmlKnowledgeRuntime;
}

export function buildTestGenGraph(opts: BuildGraphOptions) {
  const { observer, timeoutMs = AGENT_NODE_TIMEOUT_MS, signal, checkpointer } = opts;

  const log = Log.for('graph');
  log.info('Building LangGraph state graph with 8 nodes...');

  // Create each node
  const preparationNode = makePreparationNode({
    observer,
    htmlKnowledge: opts.htmlKnowledge,
  });
  const analystNode = makeAnalystNode({
    provider: opts.provider,
    observer,
    timeoutMs,
    signal,
    htmlKnowledge: opts.htmlKnowledge,
  });
  const designerNode = makeDesignerNode({
    provider: opts.provider,
    observer,
    timeoutMs,
    signal,
    htmlKnowledge: opts.htmlKnowledge,
  });
  const qualityNode = makeQualityNode({
    provider: opts.provider,
    observer,
    timeoutMs,
    signal,
    htmlKnowledge: opts.htmlKnowledge,
  });
  const checkpoint1 = makeCheckpoint(1);
  const checkpoint2 = makeCheckpoint(2);
  const checkpoint3 = makeCheckpoint(3);
  const completeNode = makeCompleteNode({ observer });

  const graph = new StateGraph(TestGenStateAnnotation)
    .addNode('preparation', preparationNode)
    .addNode('analyst', analystNode)
    .addNode('checkpoint_1', checkpoint1, { ends: ['analyst', 'designer'] })
    .addNode('designer', designerNode)
    .addNode('checkpoint_2', checkpoint2, { ends: ['designer', 'quality'] })
    .addNode('quality', qualityNode)
    .addNode('checkpoint_3', checkpoint3, { ends: ['quality', 'designer', 'complete'] })
    .addNode('complete', completeNode);

  graph.addEdge(START, 'preparation');
  graph.addEdge('preparation', 'analyst');
  graph.addEdge('analyst', 'checkpoint_1');
  graph.addEdge('designer', 'checkpoint_2');
  graph.addEdge('quality', 'checkpoint_3');
  graph.addEdge('complete', END);

  log.info(`Compiling graph${checkpointer ? ' with checkpointer' : ''}...`);
  const compiled = graph.compile({ checkpointer });
  log.success('Graph compiled');

  return compiled;
}
