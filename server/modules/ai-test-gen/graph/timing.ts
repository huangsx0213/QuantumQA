/**
 * Agent 节点单次执行的最大时长（Phase 1 ReAct + Phase 1.5 + Phase 2 提取）。
 *
 * 慢推理模型（如 gpt-5.6-terra + textVerbosity=high / reasoningSummary=detailed）
 * 的 Phase 1 分析正文生成可能超过 10 分钟。600s 节点超时会导致 `AbortSignal.timeout`
 * 在 Phase 2 首个 attempt 触发 abort，抛 `Aborted`，整个 run 失败（实测 gpt-5.6-terra
 * 在 designer 阶段 Phase 1 生成耗时 ~9.4 分钟）。
 */
export const AGENT_NODE_TIMEOUT_MS = 1_200_000;