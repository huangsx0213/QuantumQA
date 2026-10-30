# QuantumQA 源码辅助 Web UI／API 测试平台重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `executing-plans` 按任务实施。默认由当前实现者 inline 执行；未经用户新增授权，不派生额外模型，不运行真实业务／付费模型／目标源码脚本。所有 checkbox 当前均未执行。

**Goal:** 输入需求文档与目标源码，输出经过审核、覆盖可追溯、环境受控、运行期零 LLM 的 Web UI／API 测试包。

**Architecture:** 将现有录制主链替换为需求驱动的结构化设计、源码／浏览器绑定、纯代码编译、不可变发布与统一执行。保留 legacy 明确兼容，复用通过行为验证的 UI／HTTP 工具；持久 Job 是阶段权威，录制降为辅助证据。

**Tech Stack:** TypeScript、Zod、现有 React／Express／SQLite／Vitest／Playwright；Stagehand／OpenAI／可选 LangGraph 只在作者平面。建议部署 Node 24 LTS 的已验证补丁版本，不在本次文档任务升级。

**Spec:** [终极蓝图 v1.0](../specs/2026-10-30-quantumqa-source-aware-ui-api-blueprint.md)

## 本计划的使用方式

这是重构指导，不是开工指令，也不是“已经全绿”的记录。先审核蓝图；实施前核实目标技术栈、环境、账号、数据权限、预算与现有工作树。仅文档产出不授权提交／推送、依赖安装、源码执行或删除旧系统。

建议分五个可独立评审的实施包：

1. **保护与运行骨架：任务 0–6。** 先用人工批准设计证明无模型执行。
2. **环境与持久作业：任务 7–8。** 修数据和恢复，避免作者平台扩大不可靠性。
3. **源码、设计与编译：任务 9–12。** 打通第一功能切片。
4. **校准、发布与产品：任务 13–14。** 形成真正可用的闭环。
5. **迁移与验证：任务 15–16。** 通过三轴实验后扩大范围。

影响分析和退役是后续独立实施包：任务 17–18，不是第一切片上线的开工前提。

每个任务遵循：写失败测试 → 确认因目标行为失败 → 最小实现 → 运行同一测试 → 回归检查 → 审核。提交只在用户明确授权后逐任务进行，本次没有提交。

## Global Constraints

- G01：正确答案来自批准的需求或人工决策；源码／DOM／响应不可静默成为业务真值。
- G02：先有测试设计，再自动化实现；审批和契约分开。
- G03：结构化设计为唯一语义真源，NL 派生；编辑产生 revision。
- G04：动作、断言对象和观察时刻分别表达，不跨状态变化合并。
- G05：运行期零 LLM、Stagehand、模型 SDK、实时源码解释或自愈生成。
- G06：失败不能删预期、换实际值或把适用条件移出覆盖分母。
- G07：输入与产物版本化不可变；作者不能覆盖发布／正在执行副本。
- G08：草稿、业务批准、绑定、校准和发布独立。
- G09：literal／parameter／secret／extracted 明确；空字符串合法，缺失引用报错。
- G10：动作目标严格唯一；无默认 first、force、JS fallback、evaluate。
- G11：等待和观察窗口有界，不能无限等或以固定 sleep 替代所有状态。
- G12：unsupported／unbound／blocked／not_exercised 必须可见。
- G13：源码读取不授权安装、构建、执行或真实数据重置。
- G14：Job／证据持久化；至少一次传递不宣称副作用恰好一次。
- G15：旧数据明确兼容，不自动批准 V2、不丢用户编辑。
- G16：模型预算和权限在程序侧约束，不相信源码／页面中的指令。
- G17：闭环验收包含正确 AUT、已知缺陷 AUT、缺陷 AUT 作者期。
- G18：仅 Web UI／API；不建立单元／组件测试生成执行器。
- ExecutableBundle.schemaVersion=2；DesignCase.channel=`ui|api|mixed`。
- Job.status=`queued|running|waiting_review|succeeded|failed|cancelled`，phase 独立。
- Run.completion=`completed|cancelled|blocked|infra_error`；verdict=`passed|failed|unknown`。
- PredicateResult.status=`passed|failed|error|not_exercised`；collect 失败仍使 verdict=failed。
- 首批 operator：`eq, ne, contains, notContains, exists, notExists, matches, gt, gte, lt, lte`。
- 建议默认 eventually timeout=5000ms、interval=100ms；HTTP timeout=30000ms。
- 建议默认 Job lease=60000ms、heartbeat=20000ms；每模型阶段最多 2 次请求。
- 建议 intake 上限：压缩 100MiB、解压 500MiB、20000 文件、单文件 2MiB；不静默截断。
- 新运行／Compiler／契约使用独立 strict TypeScript 配置验证，不一次性要求整个旧仓库 strict 迁移。

## Review Focus

五项高风险输入／条件必须有任务测试，不能留到最终手工点页面：

1. **源码与部署不同、条件目标当前不存在：**保留需求预期，区分绑定证据与业务状态；任务 9／11／13。
2. **false、0、null、空串、missing、读取 error：**不字符串化混淆，不把读取错误变成布尔默认；任务 2／4／5。
3. **多匹配、窗口／frame、异步及 no-request：**严格解析，动作前观察，断言不挪时刻；任务 5／6／12。
4. **校准中编辑、lease 过期、外部写操作已发出：**旧 attempt 不覆盖新版本，副作用不盲目重跑；任务 7／8／13。
5. **legacy 缺失预期来源与不可信源码指令：**不自动批准，不执行源码，不删用户数据；任务 9／10／15。

---

## 文件组织与共同契约

### 当前事实

- 现有迁移最高编号是 014，注册在 `server/migrations/index.ts`；以下 015–018 是**拟定编号**，实施时先复核并追加，不覆盖其他人的迁移。
- `vitest.config.node.ts` 是 node 环境，默认 `vitest.config.ts` 是 jsdom。
- `server/migrate.ts` 会执行真实迁移，迁移入口还可能 seed。测试不能调用它操作工作目录的 database.sqlite。
- Agent 当前从 `server/modules/execution/` import 执行实现；V2 将运行依赖下沉共享，不带入 Server 仓库和作者依赖。
- 根数据库和所有既有修改保持；本计划不授权清理 `.opencode/` 等既有删除。

### 目标代码责任

| 目录／文件 | 责任 |
|---|---|
| `shared/testing/contracts/` | G 约束对应的 schema、类型、输入／设计／绑定／包／结果／jobs |
| `shared/testing/planning/` | 条件、覆盖、影响分析的纯函数 |
| `shared/testing/compiler/` | 无 I/O 编译、规范化、校验与 legacy import |
| `shared/testing/runtime/` | 值、谓词、顺序、观察、fixture 协调和结果汇总 |
| `shared/testing/adapters/` | 共享 Playwright／HTTP I/O，不 import 作者或数据库 |
| `server/modules/source-assets/` | 安全 intake、只读 AST、快照、检索、路由 |
| `server/modules/test-design/` | 模型提案、修订、批准及条件基线存储 |
| `server/modules/test-authoring/` | binding、profiles、fixtures、calibration |
| `server/modules/test-artifacts/` | 编译入口、发布、导出、版本与迁移记录 |
| `server/modules/work-jobs/` | SQL jobs、lease、事件、outbox、恢复、取消 |
| `agent/execution-control.ts`／`binding-control.ts` | 不同权限和依赖面的运行／作者命令 |
| `client/features/source-assets/`／`test-design/`／`test-authoring/` | 输入、覆盖、结构化编辑、绑定、发布与恢复 |

所有下述新类型由 `shared/testing/contracts/index.ts` 导出，schema 在 `schemas.ts` 或同责文件定义。不在每个 controller 重写一份类型。

主要 Interface（详细字段以蓝图 §5 为准）：

```ts
compileDesign(design: TestDesignRevision, binding: BindingPlan,
  context: CompileContext): CompileResult;

runBundle(input: ExecutionInput, deps: RuntimeDeps,
  signal: AbortSignal): Promise<RunReportV2>;

proposeDesign(input: DesignInput, deps: DesignDeps,
  signal: AbortSignal): Promise<DesignProposal>;

proposeBindings(input: BindingInput, deps: BindingDeps,
  signal: AbortSignal): Promise<BindingProposal>;
```

新测试共用 `shared/testing/__tests__/fixtures.ts`：提供 `makeRequirementSnapshot()`、`makeCoverageBaseline()`、`makeDesignRevision()`、`makeBindingPlan()`、`makeCompileContext()`、`makeBundle()`、`makeExecutionProfile()`，各接受 `Partial<T>` 并返回对应完整类型；默认关联同一项目与匹配的 snapshot／revision，默认数据为非敏感 literal。相关任务扩展 fixture，不用全局生产 seed。

测试命令中的 `npx --no-install` 只使用已有依赖。没有本地工具／浏览器／原生库时记录 blocker，不能自动安装。AUT 或目标源码运行须另获授权，并满足隔离限制。

## Task 0：冻结基线、风险和兼容清单

**Files:**
- Create: `docs/testing-refactor/baseline.md`
- Create: `shared/testing/__tests__/legacy-inventory.test.ts`
- Read only: `package.json`、`package-lock.json`、现有 migrations、共享／Server／Agent 执行入口。

**Interfaces:**
- Consumes: 当前仓库状态与已有用例的只读导出。
- Produces: 支持动作／API、版本、模型调用入口、旧数据、部署未知项、回退范围清单。业务数据导出需要用户许可。

- [ ] 写 `legacyInventory_preservesUnknownActionsAndAssertions`：输入两条步骤，其中一条 unknown action，断言清单仍保留两条和原始 expected／metadata，不把 unknown 删掉。
- [ ] 运行 `npx --no-install vitest run --config vitest.config.node.ts shared/testing/__tests__/legacy-inventory.test.ts`，确认因清单行为未实现失败。
- [ ] 实现仅测试／迁移用只读清单 helper，保存支持／未知分类，不改数据；记录当前 ref、既有变更和本机工具缺口。
- [ ] 重跑同一测试；受许可时运行 `npm run lint` 记录基线，既有失败不能伪装为重构造成或被静默修复。
- [ ] 在隔离环境验证选定 Node／Playwright／SQLite 打包组合，未验证时保留 Node 24 补丁选择为部署 gate，不编造“已兼容”。

**验收：**开始写 V2 前，有可审计的旧数据清单和兼容未知项；没有执行／改动真实 AUT。

## Task 1：保护现有执行和草稿路径

**Files:**
- Modify: `shared/core/step-loop.ts`、`shared/core/case-executor.ts`
- Modify: `shared/execution-core/assert-normalizer.ts`
- Modify: `agent/recorder/ai-recording-session.ts`
- Modify: `server/modules/ai-driven-recorder/finalize-run.ts`、`recover.ts`
- Test: 以上路径现有测试，并 Create `shared/core/__tests__/legacy-result-semantics.test.ts`、`agent/recorder/__tests__/legacy-failure-semantics.test.ts`

**Interfaces:**
- Consumes: 现有 TestStep／RunResult／ActResult。
- Produces: 旧路径不假绿、不吞关键动作失败、不把部分产物当完整完成；V2 不依赖 legacy 的“实际值兜底预期”。

- [ ] 写失败测试：API status=401 且明确状态断言通过时 case 不因 HTTP 范围失败；soft 断言失败后仍继续，但最终 RunResult.status=`FAILED`。
- [ ] 写失败测试：fill→submit→assertValue 不把 assert 挪到 fill 后；ActResult.success=false 不发成功；缺捕获／关键失败的 run 只能保存不完整草稿；recover 不提升为 completed。
- [ ] 分别运行 `npx --no-install vitest run --config vitest.config.node.ts shared/core/__tests__/legacy-result-semantics.test.ts agent/recorder/__tests__/legacy-failure-semantics.test.ts`，确认针对目标行为失败。
- [ ] 最小修复上述行为，保留现有正确接口；无明确状态预期的 legacy HTTP 处理政策保持显式兼容，不一刀改变所有旧 API 用例。
- [ ] 重跑测试并运行对应现有 core／recorder 测试目录。每个改动应可独立审查，不顺带格式化大文件。

**验收：**已知危险结果被回归测试锁定；不宣称旧 oracle／确认信任矩阵已因此彻底修好。

## Task 2：建立 V2 类型化契约和固定测试 fixture

**Files:**
- Create: `shared/testing/contracts/base.ts`、`input.ts`、`design.ts`、`binding.ts`、`executable.ts`、`results.ts`、`jobs.ts`、`schemas.ts`、`index.ts`
- Create: `shared/testing/runtime/types.ts`
- Create: `shared/testing/__tests__/fixtures.ts`、`contracts.test.ts`
- Create: `tsconfig.testing.json`

**Interfaces:**
- Produces: 蓝图 §5 的 ID、JsonValue／ValueRef、Diagnostic、快照、基线、设计、绑定、ExecutableBundle、结果和 job 类型；RuntimeDeps 不含 AI／shell。
- Produces: `parseExecutableBundle(raw: unknown): ExecutableBundle`，schema 不合法抛校验错误；Compiler 的 blocked result 无可执行 bundle。

- [ ] 写 `valueRef_roundTripsTypedScalars`：literal 的 `""`、false、0、null 保存／读取相同类型；参数引用与同名 literal 不相等。
- [ ] 写 `bundle_rejectsTextActionUnknownKindAndWrongRevisionShape`：拒绝自由文本动作、非法 kind、缺 responseRef、非法 UI／API 渠道；未知字段按 schema 策略拒绝，不 silently strip 关键语义。
- [ ] 运行 `npx --no-install vitest run --config vitest.config.node.ts shared/testing/__tests__/contracts.test.ts` 验证失败。
- [ ] 实现 schema／类型、判别操作、独立 PredicateSpec、结果枚举和 fixture helper；`schemas.ts` 与类型保持单源，不用任意 record 躲开验证。
- [ ] 重跑测试；运行 `npx --no-install tsc --noEmit -p tsconfig.testing.json`，要求新契约 strict 检查通过，不全仓开 strict 清理旧代码。

**验收：**结构化协议可端到端 round-trip；组件／单元执行类型不进入产品协议。

## Task 3：不可变输入、设计 revision 与审批记录

**Files:**
- Create: `server/migrations/015_testing_snapshots_and_revisions.ts`
- Modify: `server/migrations/index.ts`
- Create: `server/modules/source-assets/snapshots.ts`、`repository.ts`
- Create: `server/modules/test-design/repository.ts`、`revisions.ts`、`approvals.ts`
- Modify: `server/modules/requirements/index.ts`、`repository.ts`，仅接入 snapshot，不重写格式解析。
- Create: `server/modules/test-design/__tests__/revisions.test.ts`

**Interfaces:**
- `saveRequirementSnapshot(snapshot: RequirementSnapshot): RequirementSnapshot`：相同 ID／hash 重复可幂等，内容改变不得覆盖。
- `appendDesignRevision(input: DesignRevisionWrite): TestDesignRevision`：input 明确 projectId、parentRevisionId、expectedCurrentRevisionId、payload、actor。
- `approveRevision(input: ApprovalWrite): ApprovalRecord`：input 明确 projectId、revisionId、contentHash、approvalKind、actor、reason。

- [ ] 写独立临时 SQLite 测试：旧快照不可改；两个编辑者使用同 expected revision 只有一个成功，另一个 409／Conflict；跨项目审批拒绝。
- [ ] 写 modified PRD 导入保留 origin 引用但新语义有新 snapshot；旧包仍能读取旧 AC，不靠当前 requirements 行重建。
- [ ] 运行 `npx --no-install vitest run --config vitest.config.node.ts server/modules/test-design/__tests__/revisions.test.ts` 验证目标失败。
- [ ] 实现追加存储、内容 hash、事务 CAS、批准的 actor／revision／原因；测试仅应用新 migration 到临时库，不运行 `server/migrate.ts`。
- [ ] 重跑测试，校验已存在 PRD 文件／版本成员能力仍保留；不把导入时 APPROVED 自动变成人工批准。

**验收：**DesignRevision、原始输入与审定语义有可重建的历史；撤回／修改不改旧 payload。

## Task 4：类型化值解析和谓词纯逻辑

**Files:**
- Create: `shared/testing/runtime/variables.ts`、`predicate.ts`
- Extend: `shared/testing/contracts/base.ts`、`results.ts`，增加 ObservationValue／ComparisonResult／ValueContext。
- Create: `shared/testing/__tests__/variables.test.ts`、`predicate.test.ts`

**Interfaces:**
- `resolveValue(ref: ValueRef, context: ValueContext): Promise<JsonValue>`；context 提供 parameters、extracted 和受控 resolveSecret，不猜字符串。
- `compareValues(operator: PredicateOperator, actual: ObservationValue, expected?: JsonValue): ComparisonResult`。
- ObservationValue=`value`（含 JsonValue）／`missing`（原因）／`error`（code／message）；实际读取 error 不能转成缺失。

- [ ] 写 `resolveValue_missingReferenceFails`／`literalMatchingParameterNameStaysLiteral`；secret 不出现在公共日志，参数缺失不能原样返回占位符。
- [ ] 写 `eq_isTypeStrict`：false 不等于 `"false"`；0 不等于 `"0"`；null 不等于 missing；空串 eq 空串通过。
- [ ] 写 `exists_distinguishesPresentNullAndMissing`：JSON 字段存在且值 null 是 present；missing 为不存在；read error 是 error，不可通过 notExists。
- [ ] 运行 `npx --no-install vitest run --config vitest.config.node.ts shared/testing/__tests__/variables.test.ts shared/testing/__tests__/predicate.test.ts`，确认失败。
- [ ] 实现类型相容矩阵、标量／集合比较和 missing／error；不直接复用 legacy String(actual) 的等式语义。
- [ ] 重跑；检查 contains 空 expected 由 Compiler 阻塞，而 eq 空串保持合法。

**验收：**所有 operator 通过表驱动测试，非法组合返回诊断或 error，而不是猜测强制转换。

## Task 5：严格 Playwright／HTTP Adapter

**Files:**
- Create: `shared/testing/adapters/playwright-ui.ts`、`http-api.ts`
- Extend: `shared/testing/runtime/types.ts`
- Read／selectively reuse: `server/modules/execution/ui-executor.ts`、`api-executor.ts`
- Create: `shared/testing/__tests__/playwright-ui.test.ts`、`http-api.test.ts`

**Interfaces:**
- `createPlaywrightUiAdapter(options: UiAdapterOptions): RuntimeUiAdapter`；execute 操作、read ObservationRef、start／stop observer、cleanup 都有结构化结果。
- `executeHttp(operation: RequestOperation, context: HttpContext, signal: AbortSignal): Promise<ResponseRecord>`；ResponseRecord 保存 typed body／status／headers／responseRef，不在 transport 内以 2xx 决定业务 verdict。

- [ ] 写隔离 DOM 行为测试：两个同名控件操作报 `TARGET_AMBIGUOUS`；不可操作按钮不 force；缺失目标的 count 返回 0，visible 返回 false；读取异常保留 error。
- [ ] 写独立断言 target 与 action target 不同、frame／窗口归属正确、approved fallback 被使用时有证据的测试；未声明能力必须 unsupported。
- [ ] 写 HTTP fixture：401 被正常接收、JSON false／0／null 保留、超时不伪装 401、敏感 headers／body 脱敏。
- [ ] 写 JSON 路径只允许属性／索引、拒绝脚本求值和越界引用，响应／正则／解析时间受执行政策约束，错误不能当成成功缺值。
- [ ] 运行 `npx --no-install vitest run --config vitest.config.node.ts shared/testing/__tests__/playwright-ui.test.ts shared/testing/__tests__/http-api.test.ts` 验证失败；需要浏览器但本机无可用版本时记录 blocker，不安装。
- [ ] 实现最小共享 Adapter；复用会话／传输函数须经上述行为验证；不把 Server repository、Stagehand 或模型依赖带入。
- [ ] 重跑并核对 import 依赖面和实际浏览器行为，不只 mock Playwright 方法。

**验收：**严格动作与否定断言均可执行；未知控件能力不会被 first／JS 掩盖。

## Task 6：V2 Runtime、结果汇总和独立导出 runner

**Files:**
- Create: `shared/testing/runtime/run-case.ts`、`run-bundle.ts`
- Create: `scripts/run-testing-bundle.ts`
- Create: `agent/execution-control.ts`
- Modify: `agent/index.ts`、`server/modules/execution/runner.ts`，增加明确 V2 分发，保留 legacy。
- Modify later in this task: `package.json` 的 runner build 脚本；不添加本次文档执行命令。
- Create: `shared/testing/__tests__/runtime.test.ts`、`runtime-dependencies.test.ts`

**Interfaces:**
- Implements: `runBundle(input: ExecutionInput, deps: RuntimeDeps, signal: AbortSignal): Promise<RunReportV2>`。
- Produces: standalone runner 仅接受 bundle／profile／参数及合法 secretRef；不 import Server DB、源码解析器或作者 SDK。

- [ ] 写 `collect_failureKeepsRunningButVerdictFails`，至少两个谓词，第一失败、第二执行；断言报告 completion=completed、verdict=failed、两个结果都存在。
- [ ] 写 `submitThenAssert_keepsObservationOrder`；`eventually_rereadsUntilTimeout`；`networkObserverStartsBeforeAction`；观察窗口外事件不混计；取消后剩余谓词 not_exercised。
- [ ] 写导出依赖检查：从 runtime／runner 入口遍历本地 import，不包含 `@browserbasehq/stagehand`、`openai`、`@langchain/*`、`server/shared/db`、`source-assets`；执行桩若请求模型立即失败。
- [ ] 运行 `npx --no-install vitest run --config vitest.config.node.ts shared/testing/__tests__/runtime.test.ts shared/testing/__tests__/runtime-dependencies.test.ts` 验证失败。
- [ ] 实现严格顺序、每谓词独立读取、有限重试、observer、结果汇总和取消；fixture 暂用 RuntimeDeps 注入可信 fake，真实 profile 接任务 7。
- [ ] 重跑，使用人工构造且审定的 bundle 在隔离 DOM／HTTP fixture 运行，证明 UI／API 不需要模型才能闭环。

**验收：**M1 人工设计纵向切片成立。依赖检查不是全部零模型证明；后续隔离运行还必须验证实际模型网络请求=0。

## Task 7：版本化 Profile、授权 Fixture 和数据作用域

**Files:**
- Create: `server/migrations/016_testing_profiles_and_run_reports.ts`（编号按实际合入顺序复核）。
- Modify: `server/migrations/index.ts`
- Create: `server/modules/test-authoring/profiles.ts`、`fixtures.ts`、`repository.ts`
- Extend: `shared/testing/contracts/input.ts`、`executable.ts`
- Create: `server/modules/test-authoring/__tests__/fixtures.test.ts`

**Interfaces:**
- `prepareFixture(input: FixtureExecutionInput, deps: FixtureDeps, signal: AbortSignal): Promise<FixtureReceipt>`。
- `cleanupFixture(receipt: FixtureReceipt, deps: FixtureDeps, signal: AbortSignal): Promise<CleanupResult>`。
- ExecutionProfile 固定项目、revision、AUT origins、执行位置、角色／secretRef、fixture／副作用政策和部署版本证据。

- [ ] 写拒绝未授权 reset／外部 URL／未知脚本的测试；源码发现 reset route 不能获得权限。
- [ ] 写独立 runId 数据作用域、全局 reset 需独占 lease、prepare 失败不执行 case、cleanup 失败污染作用域的测试。
- [ ] 写 secret 解析仅发生于运行期，校准 profile 不默取第一个 environment，Agent 与网络位置明确。
- [ ] 运行 `npx --no-install vitest run --config vitest.config.node.ts server/modules/test-authoring/__tests__/fixtures.test.ts` 验证失败。
- [ ] 实现可信 fixture 注册／结构化允许操作、profile revision 和 receipts；不执行目标仓库函数／install 脚本。
- [ ] 重跑，接入任务 6 的 RuntimeDeps；非幂等 mutation 中断后进入 blocked／review，不能简单重发。

**验收：**新浏览器和新业务数据前提同时成立；没有真实重置权限不做 AUT 校准。

## Task 8：持久 Jobs、Outbox、SSE 与 Agent fencing

**Files:**
- Create: `server/migrations/017_testing_jobs_and_leases.ts`，编号实施时复核。
- Modify: `server/migrations/index.ts`
- Create: `server/modules/work-jobs/repository.ts`、`worker.ts`、`events.ts`、`outbox.ts`、`recovery.ts`、`router.ts`
- Modify: `server/app/startServer.ts`、`registerRoutes.ts`，仅注册新作业路径。
- Modify: `agent/execution-control.ts`；旧 `server/modules/execution/queue.ts` 不立即删除。
- Create: `server/modules/work-jobs/__tests__/durability.test.ts`、`events.test.ts`

**Interfaces:**
- `enqueueJob(request: JobRequest): JobRecord`。
- `claimJob(workerId: string, now: number, leaseMs: number): JobClaim | null`。
- `heartbeatJob(claim: JobClaim, now: number): boolean`。
- `completeJob(claim: JobClaim, result: JobResult): CompletionReceipt`；过期 claim 不能更新当前状态。
- `readJobEvents(projectId: string, jobId: string, after: number): JobEvent[]`。

- [ ] 写两 Worker 竞争只有一次 claim；同 command 去重；过期／旧 attempt 的结果不能覆盖新状态；输入／输出引用和 outbox 事务一起保存。
- [ ] 写进程重建后 queued／waiting_review／calibration 可恢复，部分 live steps 不算完整；非幂等已发副作用无法核实则阻塞。
- [ ] 写 SSE cursor／刷新续读、跨项目事件拒绝、持久取消和 cleanup 完成事件。
- [ ] 运行 `npx --no-install vitest run --config vitest.config.node.ts server/modules/work-jobs/__tests__/durability.test.ts server/modules/work-jobs/__tests__/events.test.ts` 验证失败。
- [ ] 实现 SQL 条件领取、lease、attempt／token、outbox ACK 和恢复；使用 60000ms／20000ms 初始值，不宣称物理副作用恰好一次。
- [ ] 重跑并做独立临时 SQLite 的重建／恢复测试，不依赖内存 Map 作为权威。

**验收：**M2 状态恢复成立，LangGraph 若保留必须映射 durable phase，不能出现第二权威状态。

## Task 9：安全源码 intake、TS／JS 资产和版本索引

**Files:**
- Create: `server/modules/source-assets/intake.ts`、`indexer.ts`、`ts-js.ts`、`retrieval.ts`、`router.ts`
- Extend: `server/modules/source-assets/snapshots.ts`、`repository.ts`
- Modify: `server/app/registerRoutes.ts`、Worker build 配置；AST parser 如需生产依赖须显式声明，不能暗用 devDependencies。
- Create: `server/modules/source-assets/__tests__/intake.test.ts`、`indexer.test.ts`
- Create: `server/modules/source-assets/__tests__/fixtures/` 下受控 React／Express 文本样本。

**Interfaces:**
- `ingestSourceSnapshot(input: SourceInput, limits: IngestLimits, deps: IntakeDeps): Promise<SourceSnapshot>`。
- `indexSource(snapshot: SourceSnapshot, deps: SourceIndexDeps, signal: AbortSignal): Promise<AssetSnapshot>`；deps 只读 blob／受限解析，不含执行器。
- `queryAssets(snapshotId: string, query: AssetQuery, budget: RetrievalBudget): AssetQueryResult`。

- [ ] 写 `intake_rejectsTraversalLinksCaseCollisionAndLimits`：拒绝 `../`、绝对路径、链接、冲突和超限；`.env` 等排除可见；不能截断后报完整。
- [ ] 写 JSX testId／label、Express router mount＋route 组合、JSON schema 引用和源位置提取测试；动态包装器明确 unsupported。
- [ ] 写源码含 fetch／throw／提示指令时只解析不执行；不同 source hash／提取器版本不复用旧索引；源码与部署版本未知不自动称匹配。
- [ ] 运行 `npx --no-install vitest run --config vitest.config.node.ts server/modules/source-assets/__tests__/intake.test.ts server/modules/source-assets/__tests__/indexer.test.ts` 验证失败。
- [ ] 实现受控读取、AST、确定性关系与有限检索；原始源码不变，SourceFact 不自动变成验收预期。
- [ ] 重跑；第一切片只声明真实支持的 TS／JS／React／Express 形式，未知框架走人工资产或 unsupported。

**验收：**源码资产在明确范围内可追溯，未执行目标代码，未把整个仓库作为模型默认上下文。

## Task 10：条件基线、测试设计提案和独立覆盖计算

**Files:**
- Create: `shared/testing/planning/conditions.ts`、`coverage.ts`
- Create: `server/modules/test-design/proposal.ts`、`router.ts`
- Extend: `server/modules/test-design/revisions.ts`、`approvals.ts`、`repository.ts`
- Modify: `server/modules/ai-test-gen/infra/provider.ts` 或其 Adapter，仅复用 Provider 接口；现有三角色图留 legacy。
- Create: `shared/testing/__tests__/coverage.test.ts`、`server/modules/test-design/__tests__/proposal.test.ts`

**Interfaces:**
- `buildCoverageBaseline(snapshot: RequirementSnapshot, candidates: TestCondition[]): CoverageBaselineDraft`；批准在 repository／approval，不由此纯函数代签。
- `computeCoverage(baseline: CoverageBaseline, designs: TestDesignRevision[], bundles: ExecutableBundle[], reports: RunReportV2[]): CoverageReport`。
- Implements: `proposeDesign(input: DesignInput, deps: DesignDeps, signal: AbortSignal): Promise<DesignProposal>`；input 包含快照／基线／资产引用，不能提供 secret。

- [ ] 写基线 4 项、批准设计 4 项、可自动化 3 项、实际执行 2 项：coverage 分别是 4/4、3/4、2/4；unsupported 不移出适用分母。
- [ ] 写 API 用例不能覆盖明确 UI 错误提示义务；只有 conditionId 没有有效谓词不计；未批准来源不计批准设计覆盖。
- [ ] 写批准边界可展开、源码独有上限只能候选／冲突、模型删否定／transient／错误 kind 必须诊断，不能删除后通过。
- [ ] 写预算最多 2 次请求、首次非法后一次定点修复、再失败 waiting_review；纯字段／覆盖校验不触发模型。
- [ ] 运行 `npx --no-install vitest run --config vitest.config.node.ts shared/testing/__tests__/coverage.test.ts server/modules/test-design/__tests__/proposal.test.ts` 验证失败，Provider 为受控 fake，不扣费。
- [ ] 实现条件／规则、结构化提案、跨字段校验与程序覆盖；不把 selfReview 默认分数用作准入。
- [ ] 重跑；需求歧义、排除、责任人和 scope revision 均可审计。

**验收：**需求→条件→用例的设计阶段成立，源码辅助没有省掉测试设计。

## Task 11：源码优先 Binding、运行证据与受限 AI 补缺

**Files:**
- Create: `server/modules/test-authoring/binding.ts`
- Create: `agent/binding-control.ts`
- Extend: `server/modules/test-authoring/repository.ts`、`profiles.ts`
- Modify: `agent/index.ts`，新增独立作者命令。
- Keep isolated: `agent/recorder/ai-recording-session.ts`，新 binding 不调用其预期兜底。
- Create: `server/modules/test-authoring/__tests__/binding.test.ts`

**Interfaces:**
- Implements: `proposeBindings(input: BindingInput, deps: BindingDeps, signal: AbortSignal): Promise<BindingProposal>`。
- `validateBindings(plan: BindingPlan, context: BindingValidationContext): BindingValidation`；context 提供 profile、源／运行证据与能力，不提供替代业务预期值。

- [ ] 写已知 testId／API route 无模型绑定；候选不唯一需 review；action target 和 predicate target 不互相覆盖。
- [ ] 写条件错误提示在缺陷 AUT 上缺失，仍保留批准谓词，可建立需人工确认的 source-conditional binding；不能因 count=0 删除断言。
- [ ] 写 ActResult false、捕获不足、额外 cleanup 动作、模型建议改变 expected 均不能默认为设计成功。
- [ ] 写源码／profile revision 不一致不能自动继承批准；未知目标预算最多 2 次模型请求，超限保留 unbound。
- [ ] 运行 `npx --no-install vitest run --config vitest.config.node.ts server/modules/test-authoring/__tests__/binding.test.ts` 验证失败。
- [ ] 实现资产→运行观察→有限提案→人工确认优先级，证据记录 actionId／targetId／时刻／版本；不要求 `_enableRecorder` 才能走已知步骤。
- [ ] 重跑，确认新绑定产物仅包含 BindingPlan／Evidence，不暗中从页面生成业务答案。

**验收：**AI 录制退为辅助，源码确实减少探索，而不是重新引入文本动作协议。

## Task 12：纯 Compiler、能力表与 NL 派生视图

**Files:**
- Create: `shared/testing/compiler/compile.ts`、`validate.ts`
- Extend: `shared/testing/contracts/executable.ts`、`schemas.ts`，能力表同源。
- Create: `server/modules/test-artifacts/compile.ts`、`repository.ts`、`router.ts`
- Create: `server/modules/test-design/nl-view.ts`
- Create: `shared/testing/__tests__/compiler.test.ts`、`server/modules/test-design/__tests__/nl-view.test.ts`

**Interfaces:**
- Implements: `compileDesign(design: TestDesignRevision, binding: BindingPlan, context: CompileContext): CompileResult`。
- `renderNlView(design: TestDesignRevision): NlDesignView`：可读内容与结构化内容使用同一个 revision。
- `validateRuntimeCapabilities(bundle: ExecutableBundle, capabilities: RuntimeCapabilities): Diagnostic[]`。

- [ ] 写同输入相同语义 hash；createdAt／随机发布 ID 不参与语义 hash；绑定／预期／profile 改变使 hash 改变。
- [ ] 写 disabled→enabled eq false、checked→checked eq true、空值 eq 保留；attribute／body 缺 expression 阻塞；未知动作阻塞。
- [ ] 写 fill→submit→assert 的顺序不变，raw／consolidated 不按数组位置绑定；network observer 先于动作；未定义 responseRef／变量报错。
- [ ] 写业务预期不满足当前页面仍可编译批准语义；缺审批／能力／fixture 时 blocked 且无 executable bundle；义务不可被 compiler 删除。
- [ ] 写 NL 展示与机器意图来自同一 revision，文本修订不能保留过期 intent／绑定审批。
- [ ] 运行 `npx --no-install vitest run --config vitest.config.node.ts shared/testing/__tests__/compiler.test.ts server/modules/test-design/__tests__/nl-view.test.ts` 验证失败。
- [ ] 实现纯转换、canonical hash、能力／权限／时序／覆盖门；不 I/O、不 LLM、不执行当前页面 expected 检查。
- [ ] 重跑并 strict 类型检查；检验 blocked 输出不可被导出／执行接口误接收。

**验收：**M3 第一设计／源码切片可生成完整包或明确诊断，不出现“删断言后编译成功”。

## Task 13：冻结校准、审批发布与导出

**Files:**
- Create: `server/migrations/018_testing_artifacts_and_legacy_imports.ts`，编号复核。
- Modify: `server/migrations/index.ts`
- Create: `server/modules/test-authoring/calibration.ts`、`controller.ts`、`router.ts`
- Create: `server/modules/test-artifacts/publication.ts`、`export.ts`
- Modify: `server/modules/execution/runner.ts`，接 V2 Job 和 profile，不改共享 Suite 为 soft。
- Keep legacy isolated: `server/modules/ai-driven-recorder/confirmation.ts`、`finalize-run.ts`
- Create: `server/modules/test-artifacts/__tests__/publication.test.ts`、`server/modules/test-authoring/__tests__/calibration.test.ts`

**Interfaces:**
- `requestCalibration(input: CalibrationRequest): JobRecord`；input 含 artifactId、profileRevisionId、expected revision、idempotency key。
- `publishArtifact(input: PublishRequest, deps: PublicationDeps): PublishedArtifact`；input 含 actor、审批 hash、expected revision、政策及可选已知缺陷引用。
- `exportArtifact(projectId: string, artifactId: string): ExportedBundle`，仅 published 或明确授权的不可发布预览，不混淆。

- [ ] 写两次 PASS 但业务审批缺失不能发布；rule 编译来源不绕过审批；not_exercised／unbound 阻止自动发布。
- [ ] 写批准语义在绑定成立的 AUT 中失败，保留原断言；有责任人／缺陷引用／有效前提时允许明确人工发布，不自动改绿。
- [ ] 写校准中编辑产生新 revision；旧 job 只关联原 artifact，不覆盖当前设计或软化共享 Suite；重启按 job／fixture 恢复。
- [ ] 写 wrong profile／Agent／source mapping 不能默取环境首项；临时 collect 策略只在副本；跨项目导出拒绝。
- [ ] 运行 `npx --no-install vitest run --config vitest.config.node.ts server/modules/test-artifacts/__tests__/publication.test.ts server/modules/test-authoring/__tests__/calibration.test.ts` 验证失败。
- [ ] 实现事务 gate、冻结副本、报告关联、发布审计与导出，不复用旧 Emit 的来源三态信任判断。
- [ ] 重跑并检查 Job.phase 与 Artifact.state 正交；报告先持久化再声明完成。

**验收：**真正发布闭环成立。测试全绿与“测试合法”不再混为一谈。

## Task 14：输入／覆盖／设计／绑定／发布工作台

**Files:**
- Create: `client/features/source-assets/SourceAssetsPage.tsx`
- Create: `client/features/test-design/TestDesignPage.tsx`、`CoverageTable.tsx`、`DesignEditor.tsx`
- Create: `client/features/test-authoring/TestAuthoringPage.tsx`、`BindingReview.tsx`、`PublicationReview.tsx`
- Create: `client/shared/testing-v2/api.ts`、`useJob.ts`
- Modify: `client/app/App.tsx`、`server/app/registerRoutes.ts`；现有 NL／Recorder 页面保留 legacy 标识。
- Create: `client/features/test-design/__tests__/DesignEditor.test.tsx`、`client/features/test-authoring/__tests__/JobRecovery.test.tsx`

**Interfaces:**
- Client 使用共享 V2 契约；`useJob(projectId: string, jobId: string)` 从 snapshot＋cursor 恢复，不以内存 SSE 替代状态。
- 编辑／批准／发布传 expected revision 和 idempotency key；按钮可用性以服务端 gate 为准。

- [ ] 写四条件设计覆盖／自动化／执行覆盖分别展示；unknown／unsupported／blocked 不被合并成通过。
- [ ] 写更改预期生成新 revision、旧绑定标 stale、冲突编辑显示 409，不静默覆盖。
- [ ] 写刷新时 calibration／waiting_review 可恢复；迟到 SSE／旧 revision 不覆盖当前界面；业务失败和 infra error 分开显示。
- [ ] 运行 `npx --no-install vitest run client/features/test-design/__tests__/DesignEditor.test.tsx client/features/test-authoring/__tests__/JobRecovery.test.tsx` 验证失败。
- [ ] 实现最小工作台，复用现有视觉模式；只显示有实际后端能力的状态，不以“AI 自动完成”隐藏剩余缺口。
- [ ] 重跑，结合服务端路由测试验证审批 actor／归属；手工 UI 验证仅在获授权的隔离环境进行。

**验收：**用户不用看模型日志也能知道测什么、缺什么、谁批准、为什么没发布。

## Task 15：Legacy 导入、迁移清单和回切

**Files:**
- Create: `shared/testing/compiler/legacy-import.ts`
- Create: `server/modules/test-artifacts/legacy-import.ts`
- Modify: `server/modules/nl-cases/repository.ts`、`server/modules/suites/repository.ts`，仅新增明确关联，不无条件改旧 payload。
- Create: `shared/testing/__tests__/legacy-import.test.ts`、`server/modules/test-artifacts/__tests__/legacy-switch.test.ts`

**Interfaces:**
- `importLegacyCase(input: LegacyCaseInput): LegacyImportResult`；结果含 draft、诊断、旧 ID／hash、requiresReview=true，不产生 PublishedArtifact。
- `switchSuiteArtifact(input: ArtifactSwitchRequest): ArtifactSwitchReceipt`；带 projectId、suiteId、expected current 指针、目标 artifact 或明确 legacy 版本、actor。

- [ ] 写 text-only expected、旧 rule 来源、模板歧义、evaluate、未知动作、丢失 evidence 全部原样保留并报诊断，不自动批准。
- [ ] 写旧 variables／metadata／手工步骤不丢；导入后旧 Suite 仍可 legacy 运行，V2 必须走新审批。
- [ ] 写 CAS 切换和回切、旧报告关联保留、跨项目拒绝；shadow 双路径不得在共享业务环境双发 mutation。
- [ ] 运行 `npx --no-install vitest run --config vitest.config.node.ts shared/testing/__tests__/legacy-import.test.ts server/modules/test-artifacts/__tests__/legacy-switch.test.ts` 验证失败。
- [ ] 实现 importer 和指针切换，记录迁移清单／hash／未支持项；不通过随机推断把所有老 case 变 V2。
- [ ] 重跑，在获授权的只读导出样本上核算 round-trip 与可回退，不改实际套件。

**验收：**可以逐套件迁移，不需要一次性停用平台；用户工作没有被清理掉。

## Task 16：受控 AUT 三轴评估和成本基准

**Files:**
- Create: `scripts/testing-blueprint-eval.ts`
- Create: `docs/testing-refactor/evaluation-protocol.md`
- Create: `aut/fixtures/testing-blueprint/` 下审定条件、预期、独立数据与缺陷说明。
- Create: `shared/testing/__tests__/known-defect-contract.test.ts`
- Read only until separately authorized: `aut/requirements/AUT-Demo-Requirements-v1.0.md`、`v1.1.md`、`aut/client/LoginPage.tsx`、`aut/server/routes.ts`。

**Interfaces:**
- `evaluateBlueprint(input: EvaluationInput, deps: EvaluationDeps, signal: AbortSignal): Promise<EvaluationReport>`；input 固定批准条件、AUT 正确／缺陷版本、产物、profile、预算和隔离授权。
- EvaluationReport 分别保存设计／自动化／执行覆盖、正确 AUT 误报、缺陷检出原因、作者期预期保留、模型消耗、浏览器／人工时间；不输出自造准确率。

- [ ] 先由责任人审定约 15–20 条业务条件；代码反推需求样本不能自行成为独立 oracle。
- [ ] 写纯合成测试：缺陷 AUT 的 actual 改变，Compiler 输出的 approved expected/hash 不变；相关业务谓词失败而不是靠无关超时计检出。
- [ ] 运行 `npx --no-install vitest run --config vitest.config.node.ts shared/testing/__tests__/known-defect-contract.test.ts`，确认目标失败并完成最小实现后重跑。
- [ ] 准备正确 AUT、预先确认的缺陷 AUT、缺陷 AUT 作者期三轴协议；独立临时数据、role／时间随机部分、reset 授权和 cleanup 明确。
- [ ] 保留 A 默认／开编译基线；B／C／D 使用同输入／资产／模型预算和修复后的公共执行器，公共修复收益单列。
- [ ] 另获授权后才运行隔离 AUT／模型实验；首轮建议一轮作者生成、代表用例 5 次隔离回放，统计规模不足不宣称置信度。
- [ ] 验证冻结导出包真实运行模型请求=0；校准／正式运行结果与对应 profile／artifact 相符；没有权限则报告 blocked，不填造数据。

**验收：**M5 用检出独立已知缺陷与实际成本证明价值。纯测试通过仅允许说合成契约通过，不允许说完整 AUT 闭环已验证。

## Task 17：按需求／源码／环境变化增量修订

**Files:**
- Create: `shared/testing/planning/impact.ts`
- Create: `server/modules/test-design/impact.ts`
- Extend: source assets 关系／快照、design revisions、binding repository。
- Create: `shared/testing/__tests__/impact.test.ts`

**Interfaces:**
- `computeImpact(input: ImpactInput): ImpactReport`；input 为旧／新文档、源／资产、profile 和依赖引用；输出受影响 ID、原因、证据、保守范围与修订建议，不热修改发布包。

- [ ] 写 selector 改变只建议 binding 修订、业务预期不变；AC 改变使设计／批准 stale；profile／fixture 改变使校准证据过期。
- [ ] 写动态依赖未知扩大范围并说明不确定性；未变源片段可复用提取，但新 revision 不自动继承全部审批。
- [ ] 运行 `npx --no-install vitest run --config vitest.config.node.ts shared/testing/__tests__/impact.test.ts` 验证失败。
- [ ] 实现关系遍历、版本 diff 和保守 fallback，不引入图数据库作为前置。
- [ ] 重跑；使用 v1.0／v1.1 审定快照验证旧包仍可重建，新提案可人工批准。

**验收：**变更不会无声重写测试；“精准影响分析”的不确定部分被诚实呈现。

## Task 18：扩大能力、文档纠偏和有条件退役

**Files:**
- Create: `docs/testing-refactor/rollout-and-retirement.md`
- Modify only after adoption: `CONTEXT.md`、`docs/02-Architecture.md`、`docs/06-ai-test-generation-strategy.md`、`docs/07-nl-to-suite-conversion-pipeline.md`、`docs/08-unified-test-standard.md`。
- 后续动作／框架 Adapter：每项建立自己的能力声明和 `shared/testing/__tests__/` 行为测试；不在此任务预先创造全语言框架。

**Interfaces:**
- Produces: 可运行、可回切的项目／套件 rollout 清单、能力版本、运维／备份／恢复／导出说明。
- 旧代码删除是单独批准的操作：须有活跃依赖=0、迁移及回退验证、能力覆盖、历史报告保存和具体文件清单。

- [ ] 对照 G01–G18 和 Task 0 清单列出已实现、unsupported、legacy 使用情况，不能以提案覆盖清单当实现覆盖。
- [ ] 对新增动作／框架先写失败行为测试，再实现，再解锁能力；单页／流程都仍是 UI／API，不增加组件层级标签。
- [ ] 运行对应测试、strict 类型检查和获授权的集成回归，记录实际命令、输出、失败和未运行项。
- [ ] 更新新架构文档和 ADR；历史 spec 保留，不篡改为“当时已完成”。
- [ ] 根据实测并发／可用性需求再决定 PostgreSQL／外部队列；不能因为蓝图长期目标先做基础设施大迁移。
- [ ] 提交具体退役 proposal 给用户批准后才删除其明确范围；不能 broad reset／delete 或清理既有用户修改。

**验收：**用户能清楚区分旧路、新路、覆盖缺口与支持范围；退役由证据驱动而非重构偏好。

---

## 依赖与阶段 Gate

| Gate | 必须完成 | 允许进入下一阶段的证据 |
|---|---|---|
| Gate A／M0 | Task 0–1 | 旧结果／时序／关键失败回归与只读清单 |
| Gate B／M1 | Task 2–6 | 人工审定 bundle 在隔离 UI／HTTP fixture 无模型运行；typed result、独立断言和导出成立 |
| Gate C／M2 | Task 7–8 | Profile／fixture 受授权，持久 job 重启／编辑／取消／迟到 attempt 语义成立 |
| Gate D／M3 | Task 9–12 | 首个受支持技术／业务切片从快照到完整编译包；覆盖分母独立，unsupported 不隐藏 |
| Gate E／M4 | Task 13–14 | 校准／发布／刷新／审批／版本 UI 与后端一致 |
| Gate F／M5 | Task 15–16 | 旧数据可迁移回退，三轴 AUT 验证与真实成本证据获授权完成 |
| 后续 M6 | Task 17–18 | 增量／新能力逐项测试，退役另批准，扩容有实际依据 |

Profile／fixture 的真实实现须在 AUT 校准前完成；durable job 须在自动作者／校准放大前完成。Task 6 可以使用可信 fake fixture 验证 Runtime，但不能据此越过 Gate C。

## 自审与交接清单

- [ ] 蓝图 §1–20 和 G01–G18 每项都有明确任务、Interface 和验收门。
- [ ] 新文件标注 Create，已存在文件标注 Modify；实施时复核最新 migrations／ref。
- [ ] 参数、PredicateSpec、BindingPlan、CompileContext、ExecutionInput、RunReportV2 名称前后一致。
- [ ] 所有未知类型在 contracts 定义后再被任务使用，不能以 `any` 或任意 metadata 绕过。
- [ ] Review Focus 五项分别有回归；不能以最终手工 smoke 替代。
- [ ] 每项测试因目标行为失败，再由实现通过；当前所有 checkbox 未执行。
- [ ] 模型／浏览器／AUT／部署／迁移／提交权限与实施授权分别确认。
- [ ] 未构建、不全绿、未进行真实缺陷实验的状态明确报告，不补造统计。
- [ ] 不把任务清单当作通过证明；阶段退出必须有命令和实际结果。
- [ ] 未批准蓝图／执行环境前，不开始产品代码重构。

**推荐起点：**先实施包 1，证明人工设计的一个 UI＋一个负面 API 用例能正确、独立、零模型运行。之后再接入源码和生成；否则只是把不可靠执行器包上一层更复杂的 AI 作者平台。
