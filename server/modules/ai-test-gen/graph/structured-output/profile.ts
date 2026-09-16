export interface StructuredOutputProfile<T> {
  toolSchema: Record<string, unknown>;
  normalize(raw: unknown): unknown;
  parse(normalized: unknown): T;
  formatValidationError(error: unknown): string;
  shouldAttemptPhase1Extraction?: (raw: unknown) => boolean;
  /**
   * Optional hints appended to the Phase 2 extraction prompt to remind the
   * LLM of constraints that cannot be expressed in JSON Schema alone (e.g.
   * step atomicity rules). When omitted, the extraction prompt only contains
   * the raw schema.
   */
  extractionHints?: string;
  /**
   * Optional compact fact block (F5) appended to the extraction prompt:
   * the ground-truth table (e.g. current batch conditions) that runtime
   * cross-field validation checks against. Phase 2 condenses the conversation
   * and drops tool results — without this block the strict validation facts
   * are absent from the extraction context.
   */
  extractionContext?: string;
  /**
   * Optional Tool-Use emit extraction (Mode A). When the agent's ReAct loop
   * emits entities via tools (declared through emit_* skills) instead of a
   * single JSON block, this hook collects the tool-call records and assembles
   * a raw candidate for `normalize`/`parse`. Return null when no emit tools
   * were called (or the content text holds a fuller JSON) — the caller then
   * falls back to JSON extraction. Omit for agents that only emit JSON.
   */
  emitExtract?: (toolCallRecords: import('../nodes/types').ToolCallRecord[], contentText: string, agentName: string) => Record<string, unknown> | null;
}
