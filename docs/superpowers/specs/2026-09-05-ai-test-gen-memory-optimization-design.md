# AI Test Gen Memory Optimization Design

Date: 2026-09-05
Status: Proposed (pending review)
Owner: OpenCode

## 1. Problem

AI Test Gen 的 LangGraph 流水线（`preparation → analyst → designer → quality`）依赖一套**自制的"跨批次/跨运行记忆"**，与业界标准的长时记忆（keyed store）错位。具体表现：

1. **读侧每次全量重扫日志**：跨批次覆盖、组件条件引用、条件/用例明细查询，全部通过 `pipelineRepo.getAgentLogs()` 全量拉取后再内存过滤，散落在 5+ 处。
2. **同一份数据三处并存**：条件/用例同时落在 LangGraph checkpoint、`agent_logs.output_data`、`test_gen_runs.state`（JSON 序列化的覆盖 Map），存在漂移风险，靠 `retryFromAgentLogs` 重扫日志兜底才不崩。
3. **checkpoint 过胖**：图状态含 `globalEpicIndex` / `crossEpicDependencies` / `relevantFlowBlueprints` / `flowReferencedComponentContext` 等 preparation 的派生产物，反复进入每个快照。
4. **无界 reducer**：`skillCalls` channel 用 `[...current, ...update]` 无限追加，且与 `agent_logs.tool_history` 重复存。

根因可以概括为：**把长时记忆误装进了短时的图状态里，并用"回放日志"顶替了"键控检索"**。

## 2. 业界标准（对齐基线）

权威共识（LangGraph、Anthropic《Building Effective Agents》、OpenAI agent 工程）把 agent 记忆分四层：

| 层 | 介质 | 职责 | 铁律 |
|---|---|---|---|
| 上下文窗口 | `messages[]` | 本次推理工作台 | 易失，只放窗口内必需 |
| 短期记忆 | checkpointer（按 `thread_id`） | 中断恢复 / 失败重试 / 时间旅行 | 只放**可恢复的最小真值**，可序列化、有界 |
| 长期记忆 | keyed store（`(namespace, key, value)`） | 跨会话持久知识 | **键控、增量 upsert、按需检索**，不整表注入 |
| 语义记忆 | 向量库 + embedding | 按语义检索 | 只在需要"意思相近"时使用 |

本方案对齐其中三条核心铁律：

- **SSOT**：同一份数据唯一落点；状态类型与契约类型同源。
- **短期/长期分离**：图状态只留可恢复真值；跨批次知识进 keyed store。
- **有界 + 按需检索**：reducer 有上界；明细按 key 拉，只把摘要/计数注入 prompt。

## 3. 现状 vs 业界差异

| # | 业界 | 现状 | 性质 |
|---|---|---|---|
| 1 | keyed store + 增量 upsert | `loadCoverageFromLogs` / `loadComponentConditionsFromLogs` 全量扫 `agent_logs` + 内存过滤 | 核心 gap |
| 2 | 单一事实来源 | 条件/用例三处并存（checkpoint / agent_logs / run.state） | 漂移风险 |
| 3 | checkpoint 瘦 | 图状态 32 字段，`__start__` 即塞入大量派生物 | 偏胖 |
| 4 | reducer 有界 | `skillCalls` 无限 append + `tool_history` 冗余 | 无界增长 |
| 5 | 恢复与业务分离 | checkpoint 失效 → `retryFromAgentLogs` 重扫日志重建 state | 双轨恢复过重 |
| 6 | 按需检索，只注入计数/摘要 | 已实施 P2：只累积 `conditionCount`/`caseCountByLevel`，不累积标题 | ✅ 已对齐 |
| 7 | 跨运行引用内容寻址 | HTML 快照 `freezeSnapshot` + hash，防直播行漂移 | ✅ 已对齐（优于平均） |

## 4. Goals

1. 引入单一、键控、增量的 `CoverageIndex`，作为所有跨批次/跨运行覆盖读侧的唯一来源。
2. 用一个键控持久层替换 `test_gen_runs.state` JSON + 日志回放。
3. 把 preparation 的派生产物移出图状态，使 checkpoint 只承载可恢复真值。
4. 给 `skillCalls` 加上界，消除与 `agent_logs.tool_history` 的冗余。
5. 在记忆可靠的前提下，简化"checkpoint 失效 → 日志重建"的恢复链。
6. 保持行为语义不变（跨批次去重、resume/retry 后覆盖摘要、previous_batch 查询结果）。

## 5. Non-Goals

首个版本不做：

- 不引入向量库 / embedding / 语义检索（当前无"意思相近"检索需求）。
- 不做项目级可复用的知识库（记忆仍是 run 作用域）。
- 不改 TestCondition / NL Test Case / CoverageMatrix 的对外契约 schema。
- 不改变 checkpointer 本身（仍用 SQLite + thread_id）。
- 不把累积的明细标题预灌进 prompt（P2 已确立的按需拉取保持不变）。

## 6. Terminology

### CoverageIndex

run 作用域的键控聚合，按 `requirementId` 索引三种信息：覆盖摘要（计数/类别/技术）、组件条件明细、用例明细。一次构建、批次后增量 upsert、O(1) 键查询。

### 覆盖摘要（coverage summary）

`PreviousBatchCoverageSummary`（`graph/state.ts`）：`{ requirementId, conditionCount, categories[], techniques[], caseCountByLevel }`。注入 prompt 的概要。

### 派生上下文（derived context）

`globalEpicIndex` / `crossEpicDependencies` / `relevantFlowBlueprints` / `flowReferencedComponentContext` —— 由 preparation 计算、仅供 prompt 组织使用的数据，非 graph 真值。

### 键控持久层（keyed store）

按 `(run_id, requirement_id)` 主键增量的持久化表，取代 `run.state` JSON 与日志回放，作为跨批次记忆的落地介质。

## 7. 目标架构

```
                      │ 一次构建 / 批次后 upsert
                      ▼
               ┌─ CoverageIndex（键控，run 作用域，增量） ─┐
               │   summary / componentConditions / cases    │
               └─────────────────┬──────────────────────────┘
                                 │
     覆盖摘要注入 prompt ◄────────┤
     previous_batch_conditions_query ◄── O(1) 键查
     previous_batch_cases_query ◄── O(1) 键查
     designerd 依赖引用（loadComponentConditionsFromLogs）◄── O(1) 键查
                                 │
                   持久化：test_gen_run_coverage（主键 run_id + requirement_id）

     （短时）LangGraph checkpoint 只留可恢复真值；
     派生上下文移出 graph state，由 orchestrator 侧重建。
```

## 8. 详细设计

### 8.1 CoverageIndex（纯模块，先孤立）

新增 `server/modules/ai-test-gen/coverage-index.ts`：

```ts
export class CoverageIndex {
  // 摘要：Map<requirementId, PreviousBatchCoverageSummary>
  // 明细：componentConditions: Map<requirementId, ComponentConditionLike[]>
  //      cases: Map<requirementId, Array<{title;testLevel;conditionId}>>
  addCondition(tc): void          // 消化 mergeCoverage 逻辑
  addCase(tc): void               // 消化 mergeCaseCoverage 逻辑
  summaryList(): PreviousBatchCoverageSummary[]
  componentConditionsFor(reqId): ComponentConditionLike[]
  casesFor(reqId): Array<…>
  serialize() / static deserialize(data)
}
```

- 将 `mergeCoverage`（`orchestrator.ts:70`）与 `mergeCaseCoverage`（`:98`）的 body 迁入 `addCondition`/`addCase`，保留原函数为薄转发，避免一步大动。
- 将 `loadComponentConditionsFromLogs`（`data-skills.ts:53`）的归类逻辑与 `CoverageIndex` 复用。

### 8.2 键控持久层

两个选项：

- **C1（推荐）新增表** `test_gen_run_coverage`：
  - `run_id`、`requirement_id`、`condition_count`、`categories`(JSON)、`techniques`(JSON)、`component_count`、`integration_count`，`PRIMARY KEY (run_id, requirement_id)`。
  - 明细（组件条件 ID/标题、用例标题+级别）用独立瘦表或 JSON 列，按需按 `requirement_id` 读。
  - 配套 `repository.ts` 增 `upsertCoverage` / `getCoverage(runId)` / `getCoverageByRequirement(runId, reqId)`。
- **C2（MVP）复用 `test_gen_runs.state`**：把 `JSON.stringify([...entries()])`（`persistRunStateCoverage`，`:1459`）改为结构化键控对象 `{ byRequirement: {...} }`（`readRunStateCoverage`，`:1443` 同步改）。

### 8.3 读侧增量化

- `RunContext` 持有单一 `CoverageIndex`（取代 `start` / `continueRemainingBatches` / `retry` 各自 new 的裸 `Map`）。
- `executeBatchLoop` 批次完成后调 `index.addCondition` / `index.addCase` 增量 upsert，替代对裸 `Map` 的就地 `mergeCoverage`。
- 三个站点的 `getAgentLogs` 全量扫改为读 index：
  - `loadCoverageFromLogs`（`orchestrator.ts:1420`）
  - `makePreviousBatchConditionsQuery`（`data-skills.ts:575`）
  - `makePreviousBatchCasesQuery`（`data-skills.ts:641`）
- `loadComponentConditionsFromLogs`→改读 index 的 `componentConditionsFor`。

### 8.4 checkpoint 瘦身

迁移 preparation 的派生产物出图状态（复刻 `htmlKnowledge` 的既有模式：不进 state、走闭包/工具注入，`graph-compile.test.ts` 已断言该模式）：

- 移出 channels：`globalEpicIndex`、`crossEpicDependencies`、`relevantFlowBlueprints`、`flowReferencedComponentContext`、`previousBatchCoverageSummary`。
- 这些改在 `buildBatchInputState`（orchestrator 进入 graph 前）就绪，挂到 `RunContext` 外部上下文，由 preparation/analyst/designer/quality 节点按需读取。
- 恢复时由 orchestrator 重建 batch input（它本就负责重建），checkpoint 不再承载。

### 8.5 有界化 skillCalls

- 将 `skillCalls` reducer（`state.ts:197`）改为有界（保留最近 N=200），或整体移出持久 channel（真值已存 `agent_logs.tool_history`，state 侧仅服务前端实时展示）。
- `scope.recordAgentToolCall`（`scope.ts:176`）同步截断，避免内存与 DB 双膨胀。

### 8.6 简化恢复链

依赖 8.1–8.4 完成后（checkpoint 瘦且可靠、记忆键控落盘）：

- `selectAgentLogRecoveryPrefix`（`orchestrator.ts:225`）+ `retryFromAgentLogs`（`session.ts`）这套日志重建降级为：仅老数据迁移场景保留，否则 checkpoint 失效直接报错请用户重跑。
- 这是判定语义变更，放最后一期，配合判定矩阵测试。

## 9. 分阶段实施

依赖关系：

```
A CoverageIndex（纯重构） ──► B 增量化读 ──► C 键控持久化 ──► F 简化恢复
                                                        ▲
E 有界 skillCalls（独立，随时）    D 瘦 checkpoint ──────┘
```

| 阶段 | 内容 | 风险 | 验证 |
|---|---|---|---|
| A | 抽 `CoverageIndex` 纯类 + 迁 merge 逻辑 | 低 | 新单测；现有 621 测试保持绿 |
| E | 有界 `skillCalls` | 低 | `graph-state.test` channel 用例改断言有界 |
| B | 读侧改读 index，stop 全量扫日志 | 中 | `data-skills.test`（断言不再调 getAgentLogs）、service/html-knowledge-recovery 同步改 mock |
| C | 键控持久化（C1 表 / C2 结构化 state） | 中 | `repository.test` 补 CRUD；service.test 的 run.state 用例改写 |
| D | 派生产物移出 checkpoint | 中 | `graph-state.test` 补"字段不在 channels"断言；`graph-compile.test` 回归 |
| F | 简化恢复链 | 高 | 判定矩阵测试 + 迁移兜底 |

### 实施状态（2026-09-05）

| 阶段 | 状态 | 落地摘要 |
|---|---|---|
| A | ✅ | `coverage-index.ts` 新增（`CoverageIndex` 纯类 + `mergeConditionSummary`/`mergeCaseSummary`），621+6 测试绿 |
| E | ✅ | `skillCalls` reducer 有界（保留最近 200 条），`graph-state.test` 加守界用例 |
| B | ✅ | orchestrator 写侧换 `CoverageIndex`；读写侧全部改读 index，`previous_batch_*_query`/`loadComponentConditions` 不再扫日志 |
| C | ✅ | `CoverageIndex.serialize()`（摘要+明细）写入 `run.state`；`readRunStateCoverage` 兼容旧数组与新对象格式 |
| D | ✅（轻量版） | 移除死字段 `flowReferencedComponentContext`（唯一消费方是 orchestrator 侧 `buildAnalystInput`，state 版从无节点读取；本未进 graph input，清理类型层宣称）。其余派生上下文（`globalEpicIndex`/`businessFlowBlueprints` 等）因有真实 consumers 且变化不大，**保留** —— 完整移出需闭包化重写 prompts 层，收益 < 破坏面 |
| F | ⚠️ 核心已达成，删除动作放弃 | B+C 已让记忆持久化到 `run.state`，恢复即使走"从头 rebuild"也能经 `loadCoverageIndex` 拿到记忆，不再依赖日志重建。`retryFromAgentLogs`/`selectAgentLogRecoveryPrefix` 是 checkpoint 失效时**保留已付费 LLM 调用的兜底**，删除为纯破坏性（丢可靠性 + 重写 20 恢复测试），故保留现状 |

**结论**：`CoverageIndex` + 键控持久化已对齐业界"长时记忆 = keyed store + 按需检索"；短时 checkpoint 保持庞大但健康的可恢复真值；日志回放已从"常态读路径"降为"checkpoint 失效兜底"。

## 10. 测试策略

- **纯函数层**（CoverageIndex 合并去重 / 序列化 / 键查询）：vitest 单测，无 IO。
- **持久层**：`repository.test.ts` 锁 `test_gen_run_coverage` 的 upsert/按键读/删除级联。
- **读侧替换**：`data-skills.test.ts` 注入 fake index，断言 `historyRepository.getAgentLogs` 不再被常态调用；行为语义（跨批次去重、previous_batch 结果）以既有用例为锚点。
- **恢复语义**：`service.test.ts` / `html-knowledge-recovery.test.ts` 从"mock 返回日志"改为"mock 返回 index 快照"，验证 resume/retry 后覆盖摘要一致。
- **checkpoint 瘦身**：`graph-state.test.ts` 仿照 `htmlKnowledge` 排除断言，锁派生字段不落 channels。

## 11. 取舍与开放问题

1. **C1 新表 vs C2 复用 state 列**：C1 更正确（键控、部分读、可并发 upsert），C2 改动小。建议 C1，可先 C2 落地演进。
2. **是否彻底删除日志回放**：建议 C 完成后把 `loadCoverageFromLogs` 降为"旧数据迁移工具"，运行路径不再依赖；彻底删除留待 F。
3. **明细查询是否键控**：建议"是"，否则 B 阶段三个站点仍各自全表扫、优化不彻底。
4. **skillCalls 移出 channel vs 有界保留**：若前端依赖 state 里的即时 tool-call 展示，倾向"有界保留"；否则"移出持久 channel"更干净。

## 12. Definition of Done

- 每个阶段前后 `npx tsc --noEmit` 干净，`server/modules/ai-test-gen` 621 测试绿（改动的 mock 面同步更新）。
- 三大行为锚点语义不变：跨批次去重、resume/retry 后覆盖摘要、previous_batch 明细查询。
- `skillCalls` 在 checkpoint 有上界；派生产物不再出现在 graph channels。
- `loadCoverageFromLogs` 不再是常态读路径（或已删除）。

## 13. 延展：结构化输出 schema 校验失败的修复阶梯（2026-09-05）

> 用户指出的独立问题："schema 校验不成功时，对 JSON 格式校验不成功就整体重新生成，很浪费 token"。三个 agent（analyst/designer/quality）共用 `callLLMWithStructuredOutput`，故一处改、三处受益。

### 业界基线

Anthropic/OpenAI 主流做法是**用 API 层 constrained decoding（`json_schema + strict`）从根上消灭 schema 违规**，重试只是异常兜底，而非"手写 JSON 提取 + 整体重生成重试"。查证结论：官方文档明确 "No retries needed for schema violations"。

### 本项目 provider 现实

`infra/provider.ts` 里三种 provider 对 Phase 2 的约束不一致：

- `azure-openai` / `openai-responses`：`jsonSchema` → `json_schema + strict:true`（真约束）。
- `openai-compatible`：`jsonSchema` → **故意降级 `json_object`**（无 schema 约束，注释说明兼容 API 用 strict 会静默返回空）。

因此 `openai-compatible` 下 schema 校验失败是常态，靠「prompt 内嵌 schema + zod 后校验 + 整体重生成重试」兜底，浪费 token。

### 修复阶梯（repair ladder）与落地

| 层 | 做法 | 落地状态 |
|---|---|---|
| L1 确定性修复 | 代码层 coercion/归一/结构重组（`normalize()`） | 已覆盖"该修的"：`conditionType` 小写、`testLevel` 归一、`coerceNumber`、`nullToUndefined`/`nullToEmptyArray`（可选字段）、`rewriteNonVerbAction`、`extractDataFromAction`、`normalizeAtomicExpected`（仅 quality 层）等 |
| **L2 定点修复** | 校验失败只反馈「出错字段 path + 原因 + 最小改动指令」，在上一份 JSON 上修，不整体重生成 | ✅ 已实现（`utils.ts` `buildSchemaRepairFeedback`/`extractRepairIssues`，去重截断 8 条 path） |
| L3 兜底 | 整体重生成 | ✅ 次数 3 → 2（`MAX_PHASE2_RETRIES`） |

### 关键边界（踩坑结论）

- **L1 只做"语义等价、无需 LLM 判断"的修复**；"必填缺失 / 语义违规"（如 designer 的 expected 分号 F18、analyst 必填数组为 null）**必须拒绝，交给 L2 让 LLM 补**，不可在 normalize 兜底掩盖缺陷。
- 这条边界由 `structured-output-profiles.test.ts`（160 用例）锁死。曾尝试把必填 null 兜底 / designer 分号剥离，被测试拒绝后**撤销**——正确路径是让 L2 定点修复承接。该结论与 docs/08「不确定就降级，绝不硬塞」一致。

### 验证

- `tsc --noEmit` 干净；`server/modules/ai-test-gen` 629 测试绿（含 1 个定点修复新用例：断言反馈仅含出错字段 path + "Fix ONLY the fields"、不重发完整 schema、且只重试 2 次）。