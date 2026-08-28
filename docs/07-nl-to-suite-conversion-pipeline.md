# 07 · NL → 生产级结构化用例转化管线（设计方案）

> 状态：已实施（M1–M5 完成；编译管线由 `options.enableCompilePipeline` 开关隔离，默认走旧路径）
> 关联：[05-AIDrivenRecordingEngine.md](05-AIDrivenRecordingEngine.md)、[06-ai-test-generation-strategy.md](06-ai-test-generation-strategy.md)、[08-unified-test-standard.md](08-unified-test-standard.md)（统一词表——Test Gen 生成端按词表出牌后，本方案 C 阶段的推断/裁决链路将简化为查表）
> 域词汇表：[CONTEXT.md](../CONTEXT.md)

---

## 1. 目标与核心原则

把 NL 用例（`NlTestCase`）转化为**生产级确定性结构化用例**（Draft Suite）：

1. **LLM 只在作者期当编译器** —— 参与转化，不参与运行。产物落库后回放零 AI。
2. **AI 说的不算数，实测通过才算数** —— 所有 AI 提议必须经真实无头回放确认。
3. **不确定就降级，绝不硬塞** —— 无法证实的提议进审核队列（日志 + 人审），不进入可执行断言。
4. **期望结果是假设不是真理** —— `expected` 由上游 ai-test-gen 生成，同样要被检验。

---

## 2. 现状与问题诊断

现有链路：`agent/recorder/ai-recording-session.ts` 单文件承担录制、验证、断言生成；`refiner.ts` 仅做枚举校验后挂载。

| # | 问题 | 位置 |
|---|------|------|
| P1 | **元素依托缺失**：断言 proposal 无目标元素字段，靠"组内最后一条 payload"位置挂载（`findWithPayloads`），回放却用步骤 target 读值——两者不一致即错绑 | ai-recording-session.ts:143-154, 525-578; ui-executor.ts:924 |
| P2 | **判断与生成混在一次 extract() 调用**：验证 success 和"顺手"提断言互相绑架质量；未达成时提议静默丢弃 | ai-recording-session.ts:773-939 |
| P3 | **规则兜底散落三处**，语义互有出入（`ruleBasedAssertion` / 内联 field-navigation 兜底 / `lastFilledValue`） | 同文件 :179-189, 235-242, 921-933 |
| P4 | **步骤种类靠英文正则推断 NL 文本**，中文步骤失效→强制错误 source | :199-229 |
| P5 | **无置信度/无确认机制**：非法建议静默丢弃，合法建议未经实测直接落库 | refiner.ts:117-135 |
| P6 | auto-replay 基础设施已存在但被禁用，未参与断言确认 | auto-replay.ts |

---

## 3. 管线总览

```
NL Case ─► A Record ─► B Ground ─► C Compile ─► D Confirm ─► E Emit ─► Draft Suite(落库)
            已有,不动    证据包      规则层+AI层     无头回放≤2次    三态标签
                                      │                                 ▲
                                      └─ 未过编译门/未确认 ─► reviewAssertions┘
```

每条 NL 步骤边界的处理是独立的；D 阶段以整条 case 为单位跑。

---

## 4. 阶段详细设计

### A. Record（现状保留）

Playwright recorder 捕获 action + locatorCandidates（`RecorderStepPayload`）。不改。

### B. Ground —— 证据包采集模块

新文件 `agent/recorder/ground.ts`。在 NL 步骤边界处采集：

```ts
interface EvidencePack {
  nlStepIndex: number;
  pageUrl: string;
  pageTitle: string;
  /** aria snapshot 摘录，有界截断（如 4000 字符），控制 token */
  ariaExcerpt?: string;
  /** 本边界内被操作元素的 post-action 状态（关键！断言依托的来源） */
  actedElements: ActedElement[];
  /** 页面输入框实际值（升级自 collectVerificationText） */
  inputValues: Array<{ name: string; value: string }>;
  /** 本边界期间捕获的 XHR/Fetch */
  networkCalls: Array<{ method: string; url: string; pathname: string; status: number }>;
}
interface ActedElement {
  payloadId: string;              // 对应 RecorderStepPayload 的稳定标识
  action: string;                 // click/fill/selectOption/goto...
  locator?: LocatorRef;
  locatorCandidates: LocatorRef[];// 菜单化供 AI 选择，杜绝幻觉选择器
  tag: string;                    // INPUT/SELECT/BUTTON/A...
  elementType?: 'text'|'checkbox'|'radio'|'select'|...;
  text?: string;                  // post-action textContent
  value?: string;                 // post-action input value
  visible: boolean;
}
```

要点：
- **AI 只能从 `locatorCandidates` 菜单里选依托，不能自己发明选择器** —— 从根上消灭"选错元素"。
- 替换现有 `collectVerificationText()`（保留其 input 采集逻辑作为 adapter 之一）。
- 失败不阻断录制（延续现有 try/catch 风格）。

### C. Compile —— 两层编译器 + 编译门

新目录 `agent/recorder/compile/`，三个纯逻辑模块 + 一个 Seam：

#### C1. 规则层（`compile/rules.ts`，零 LLM）

由**录制事实推导**（不再解析 NL 文本，P3/P4 一并解决）：

| 边界内事实 | 产出提议 | confidence |
|---|---|---|
| 有 fill/selectOption 且 value 非空 | `UI_VALUE CONTAINS <实际输入值>`，target=该 payload 元素 | 1.0 |
| 有 goto | `UI_PAGE_URL CONTAINS <实际URL>` | 1.0 |
| 有网络调用 | `waitForNetwork{method,urlPattern(pathname),expectedStatus}` | 1.0 |
| check/uncheck | `UI_ELEMENT_CHECKED EQUALS true/false`，target=该元素 | 1.0 |

#### C2. 覆盖裁决（expected 是否已被规则覆盖）

1. **确定性比对**（可单测）：field 步骤且 expected 含输入值关键词 / navigation 步骤且 expected 含 URL 关键词 → 已覆盖。
2. **比对不上 → 一次专用 AI 裁决调用**（Seam：`compile/proposer.ts`，adapter 为 Stagehand extract，schema 强约束）：

```ts
const ProposalSchema = z.object({
  verdict: z.enum(['covered', 'propose', 'unverifiable']),
  bindsRuleCandidate: z.number().optional(),   // verdict=covered 时指向规则候选序号
  proposal: z.object({                          // verdict=propose 时必填
    source: z.enum([...UI_SOURCES]),
    operator: z.enum([...OPERATORS]),
    expectedValue: z.string().optional(),
    elementRefId: z.string().optional(),        // 必须是 actedElements[].payloadId
  }).optional(),
  rationale: z.string(),
});
```

Prompt 要素：expected 原文 + EvidencePack + 规则候选清单。要求：
- 断言必须溯源到 expected（写明对应哪句话）；
- 元素依托只能引用证据里的 payloadId；
- 页面状态不足以支撑可靠断言时，必须答 `unverifiable`（这就是"不确定只记日志"的机制入口）。
- `verdict=unverifiable` 或 schema 解析失败 → 不产出提议，记入步骤日志。

#### C3. 编译门（`compile/gate.ts`，纯代码，逐条校验）

```
枚举合法 ∧ expectedValue 必备(EXISTS 类除外) ∧ confidence ≥ 阈值(默认0.7)
∧ targetRef 在当前页唯一解析(page.count()===1)   ← 此刻浏览器还开着，真查
∧ source 与元素类型相容（见下矩阵）
任一不过 → 丢弃并记日志（含失败原因）
```

相容性矩阵（P1 的另一半修复）：

| source | 要求 |
|---|---|
| UI_VALUE | tag ∈ {INPUT, TEXTAREA} 或 SELECT |
| UI_TEXT | 非 input 类（input 的 text 恒空） |
| UI_ELEMENT_CHECKED | input[type=checkbox\|radio] |
| UI_ATTRIBUTE | expression 必填 |
| UI_PAGE_URL / UI_PAGE_TITLE | 无需依托 |
| UI_ELEMENT_VISIBLE / ENABLED / COUNT | 任意元素依托 |

#### C4. 产物

每个边界产出 `AssertionProposal[]`：

```ts
interface AssertionProposal {
  source: AssertionSource;
  operator: AssertionOperator;
  expectedValue?: string;
  expression?: string;
  targetPayloadId?: string;      // 显式元素依托（回放时用该 payload 的 allLocators 解析）
  origin: 'rule' | 'ai';
  confidence: number;
  rationale?: string;
  expectedText: string;          // 溯源 nlStep.expected 原文
}
```

### D. Confirm —— 确认运行（Server 端，复用生产执行引擎）

> 架构修订（2026-08-25）：确认运行从 Agent 会话内迁至 **Server 端**。原实现复用录制浏览器回放，
> 存在 cookie/登录态跨轮泄漏、双执行引擎漂移、过程不可观测三个缺陷。

流程：
1. Agent 录制完成 → 会话关闭（浏览器关闭）→ COMPLETE 事件携带带临时断言 + provenance 的 refined steps 落库
2. `finalize-run` 检测 run options 的 `enableCompilePipeline` → 触发 `confirmation.ts`（fire-and-forget）
3. Server 以**生产 case 执行管线**（`startExecutionAndWait`：buildPayload → executeSingleCase → finalizeRun）无头回放 ≤2 次：
   - 每次全新 UIExecutor = 全新浏览器上下文，零录制残留
   - 报告照常落库 → Runs/Reports 界面可直接查看确认运行过程与截图
   - 断言以临时 `soft` 策略执行；逐条结果经 ui-executor 日志的**结构化 metadata** 收割（`harvestAssertionResults`）
   - 引擎返回非 COMPLETED（动作失败）→ 该轮无效，重试一次
4. 判定矩阵（`decideConfirmationVerdict`）；完成后 `emitAssertions` 三态写回 suite，SSE 广播 `confirm:start/complete`（前端横幅）

判定矩阵：

| Run1 | Run2 | 判定 |
|---|---|---|
| PASS | PASS | `ai-confirmed` |
| PASS | FAIL | flaky → `needs-review` |
| FAIL | FAIL | 错误绑定或非幂等副作用 → `needs-review` |
| 引擎非 COMPLETED* | — | 该轮无效，重试 1 次；仍故障 → 全部保持 `needs-review` |

\* soft 策略下断言失败不会中止用例；非 COMPLETED 即动作/基础设施失败。

### E. Emit —— 落库三态

refiner 管道末端新增 `emitAssertions`：

- `rule` 与 `ai-confirmed` → 写入 `step.assertions`（message 带 expected 溯源 + 来源标签，如 `[rule] from expected: "..."` / `[ai-confirmed×2] ...`）；
- `needs-review` → 写入 `step.metadata.reviewAssertions[]`（**不可执行**），附完整证据：

```ts
interface ReviewAssertion {
  proposal: AssertionProposal;
  evidence: {
    runs: Array<{ passed: boolean; actualValue?: string; message?: string }>;
    dropReason?: string;      // 编译门拒绝原因 / unverifiable 理由
  };
}
```

同时记入步骤日志。Test Designer 增加审核面板展示 `reviewAssertions`，人审通过则提升为正式断言。

---

## 5. 共享执行核心抽取（依赖决议）

`server/modules/execution/assertions.ts` 的纯求值部分（`evaluateAssertions`、`buildUiAssertionContext`、上下文类型）迁移至 **`shared/execution-core/assertions.ts`**：

- server 运行期与 agent 编译期（编译门 + 确认运行）双端消费同一实现 → 断言语义永不漂移；
- server 侧原路径 re-export，存量引用零改动；
- 该文件仅依赖 jsonpath-plus / fast-xml-parser / ajv / shared-contracts，迁移即移动文件。

---

## 6. 模块划分总览

```
agent/recorder/
  ai-recording-session.ts      瘦身为管线编排器（录制+取证+编译；Confirm 已迁出）
  ground.ts                    [新] Evidence Pack
  compile/
    rules.ts                   [新] 规则断言（纯函数）
    proposer.ts                [新] AI 裁决/提议（Seam，Stagehand adapter）
    gate.ts                    [新] 编译门（纯函数 + page 探测）
  refiner.ts                   emitAssertions / 判定矩阵 / 日志收割 并入管道
shared/execution-core/
  assertions.ts                [移] 求值引擎
server/modules/execution/      re-export 兼容层 + startExecutionAndWait（确认运行入口）
server/modules/ai-driven-recorder/
  confirmation.ts              [新] Server 端确认服务（复用生产 case 执行管线）
  finalize-run.ts              [改] COMPLETE 后按 run options 触发确认
client/ Test Designer          reviewAssertions 审核面板 + confirm 阶段横幅
```

## 7. 边界情况与降级策略

| 场景 | 行为 |
|---|---|
| 中文 NL 步骤 | 种类由 payload 动作集合推导，正则仅作最后回退 |
| 非幂等副作用（二次下单等） | Confirm FAIL+FAIL → needs-review（设计使然，非缺陷） |
| expected 多句/复合断言 | 上游 quality gate 已禁分号复合；仍出现则按单句处理并在日志标注 |
| Stagehand extract 重载陷阱 | proposer 固定 `(instruction, schema)` 两参形态（沿用现有注释约定） |
| 录制中途 abort | 不 flush、不编译、不落库（现状保留） |
| token 成本 | 每 uncovered 步骤恰一次 AI 调用；ariaExcerpt 有界截断 |

## 8. 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `confirmRuns` | 2 | 确认运行次数上限 |
| `minConfidence` | 0.7 | 编译门置信度阈值 |
| `confirmTimeoutPerStepMs` | 15000 | 确认运行单步超时 |
| `enableConfirmPhase` | true | 可整体关闭（调试用） |

## 9. 测试策略

- **纯函数层**（rules / coverage 比对 / gate 判定 / emit）：vitest 单测，无需浏览器——Interface 即测试面。
- **proposer Seam**：mock adapter 测 schema 校验、unverifiable 路径、重试与日志降级。
- **confirm runner**：注入 fake 执行结果的 ReplayReport fixture，覆盖判定矩阵全部分支（含基础设施重试）。
- **集成**：沿用 enable-recorder-poc 模式对本地 fixture 站点跑端到端录制→编译→确认。

## 10. 实施里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | 抽取 shared/execution-core + server re-export | 存量测试全绿 |
| M2 | ground.ts 替换 collectVerificationText，Evidence 落 metadata | 单测 + 录制回归 |
| M3 | compile/（rules + proposer + gate），特性开关下并行运行 | 门校验单测全绿；日志对比新旧断言产出 |
| M4 | confirm/run.ts 解禁改造 + 判定矩阵 | 矩阵分支测试全绿 |
| M5 | Emit + reviewAssertions + Test Designer 审核面板 | 端到端演示 |
| M6 | 配置项、指标埋点、文档收尾 | 生产灰度 |

M1–M2 可先行合入，风险低；M3 起新旧行为以开关隔离，可灰度对比。

## 11. 风险与开放问题

- 确认运行的登录态/前置数据依赖：沿用 startUrl + preconditions 约定，复杂前置暂走 needs-review。
- Stagehand 升级可能改变 extract 行为：proposer 是唯一受影响点（Seam 收敛）。
- 待定：reviewAssertions 是否需要在 suite 级聚合视图（Test Designer 侧 UX 细节，实施 M5 时定）。
