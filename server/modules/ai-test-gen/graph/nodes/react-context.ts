import type { ChatMessage } from '../../infra/provider.ts';

// ============================================================
// ReAct 上下文窗口压缩（避免 O(n²) token 膨胀）
// ============================================================

/**
 * 保留最近几轮完整消息的轮次数。更早轮次的工具结果被摘要化，
 * 防止 92 次工具调用 × 15 轮时每轮重发全部历史（实测 Designer 单 run
 * input 达 260k tokens，主因即此处）。
 */
const REACT_KEEP_RECENT_ROUNDS = 3;

/** 更早轮次工具结果保留的前缀字符数（摘要足够 LLM 回顾，无需完整重发） */
const OLD_TOOL_RESULT_PREVIEW = 200;

/**
 * 识别一条消息是否开启新的一轮（assistant 消息且携带 tool_calls）。
 * 轮次结构：base(system+user) + [assistant(toolCalls) + tool*] + [assistant + tool*] + ...
 */
function isRoundStart(m: ChatMessage): boolean {
  return m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0;
}

/**
 * 将全量 ReAct 对话压缩为有界上下文：
 * - base（system + user）原样保留
 * - 最近 REACT_KEEP_RECENT_ROUNDS 轮完整保留（LLM 需要最近声明/结果续写）
 * - 更早轮次：保留 assistant 推理消息（其携带综合结论），但把 tool 结果内容
 *   摘要化（前 OLD_TOOL_RESULT_PREVIEW 字符 + 长度标注）
 *
 * 关键约束：assistant(tool_calls) → tool 消息的配对必须保留，否则 OpenAI 兼容
 * API 会因 tool_call_id 不匹配而拒绝。因此只缩短 tool 消息的 content，不删除
 * assistant 消息，配对关系保持完整。
 *
 * @param allMessages  全量消息（含 base）
 * @param baseCount    base 消息条数（system + user，即 messages.length）
 */
export function compactReActConversation(allMessages: ChatMessage[], baseCount: number): ChatMessage[] {
  if (allMessages.length <= baseCount) return allMessages;

  // 先收集更早轮次的 (assistantIdx, toolIdx) 以便摘要化，同时保留最近几轮完整
  const base = allMessages.slice(0, baseCount);
  const history = allMessages.slice(baseCount);

  // 按轮分组：每轮 = 1 条 assistant(toolCalls) + 其后 N 条 tool（直到下一条 assistant）
  const rounds: Array<{ toolIdx: number[] }> = [];
  let currentRound = -1;
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (isRoundStart(m)) {
      rounds.push({ toolIdx: [] });
      currentRound = rounds.length - 1;
    } else if (m.role === 'tool' && currentRound >= 0) {
      rounds[currentRound].toolIdx.push(i);
    }
  }

  if (rounds.length <= REACT_KEEP_RECENT_ROUNDS) return allMessages;

  const keepFrom = rounds.length - REACT_KEEP_RECENT_ROUNDS;
  const oldRoundToolIdx = new Set<number>();
  for (let r = 0; r < keepFrom; r++) {
    for (const t of rounds[r].toolIdx) oldRoundToolIdx.add(t);
  }

  const compacted: ChatMessage[] = [...base];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (oldRoundToolIdx.has(i) && typeof m.content === 'string') {
      // 摘要化旧工具结果：保留短前缀 + 总长度，提示 LLM 已在更早上下文见过
      const full = m.content;
      const preview = full.length <= OLD_TOOL_RESULT_PREVIEW
        ? full
        : full.slice(0, OLD_TOOL_RESULT_PREVIEW) + `…(total ${full.length} chars — see earlier context)`;
      compacted.push({ ...m, content: `[earlier tool result] ${preview}` });
    } else {
      compacted.push(m);
    }
  }
  return compacted;
}