# QuantumQA 终极蓝图：需求与源码驱动的 Web UI／API 测试编译平台

日期：2026-10-30  
版本：提案 v1.0  
状态：待评审；不是已实现能力，不是实施授权  
评审代码基线：`622e1d72beca38a8833d385fb3ae367695c73a57`  
实施指导：[分阶段重构计划](../plans/2026-10-30-quantumqa-source-aware-ui-api-refactor.md)

## 阅读说明

本蓝图承接需求生成、NL Case、AI 驱动录制、确定性编译、源码辅助与覆盖率的全部讨论。用户已经明确：**只做 Web UI／API，不纳入单元／组件测试生成与执行。**

本文是终极目标及重构约束，不代表当前平台已经具备这些能力。除明确标注为“当前事实”外，结构、名称、状态、接口和默认值均为设计建议。后续工程必须先审核本蓝图，再分阶段实施；不能据此一次性删除旧系统。

本次仅新增设计与计划文档。没有修改业务代码、安装依赖、调用额外模型、运行测试、启动 AUT 或进行安全扫描。未知的成本、准确率、性能、真实部署与目标源码技术栈不以假设充当事实。

## 目录

1. 结论、目标与范围
2. 不可破坏的架构原则
3. 现状证据与重构决策
4. 总体架构与主流程
5. 核心领域模型和契约
6. 需求理解、测试设计与覆盖
7. 源码资产分析
8. 绑定、浏览器验证与录制
9. 确定性编译与执行
10. 环境、账号与数据隔离
11. 校准、审核与发布
12. 持久任务和运行恢复
13. 产品操作流程与接口
14. 存储、部署与技术选择
15. 变更影响和增量更新
16. 安全与成本控制
17. 迁移策略和代码组织
18. 质量验证与验收
19. 里程碑、风险与待确认事项
20. 最终决策及实施检查表

---

## 1. 结论、目标与范围

### 1.1 最终产品定位

**将 QuantumQA 从“AI 生成自然语言用例，再驱动浏览器录制”重构为“需求驱动、源码辅助、可审计的 Web UI／API 测试编译平台”。**

测试设计不能被省略；浏览器录制不再是所有用例必须通过的生产线。LLM 是作者期的分析和提议工具，不是运行期的裁判或修复器。

业务路径是：

> 需求和验收标准 → 审核后的测试条件 → 结构化用例设计 → 源码资产及运行证据绑定 → 编译与校准 → 发布冻结测试包 → 纯代码执行。

### 1.2 两个主要输入，不等于零运行配置

主要内容输入：

- **需求文档**：业务规则、验收标准、预期结果及范围。
- **目标源码快照**：指定版本的前端／后端源码，以及可选接口契约、现有控件资料、测试数据说明。

真正执行还需要一个经授权的 `ExecutionProfile`：AUT 地址、目标环境、执行 Agent、账号引用、准备／清理方式、允许的副作用及版本映射。这些是运维条件，不能从源码猜出生产账号或自动获得数据重置权限。

若只提供两个内容输入而没有运行条件，系统仍应产出测试条件、用例设计、候选绑定与缺口报告；不得伪称已经生成可可靠执行的正式测试。

### 1.3 终极输出

1. 版本化需求与 AC 快照、歧义及实现差异报告。
2. 审核后的测试条件基线与可读用例。
3. 结构化 TestDesignRevision 和 BindingPlan。
4. 版本化、可导出的 ExecutableBundle。
5. 需求覆盖、自动化落地覆盖、校准和缺陷检出证据。
6. 每次回放的动作、断言、实际值、环境及数据生命周期报告。
7. 需求／源码变化后的受影响用例清单及修订提案。

ExecutableBundle 不依赖作者会话、LLM、源码在线可用或 QuantumQA 的作者服务。它仍需要合法的 AUT、运行配置、密钥引用和支持其版本的执行器。

### 1.4 非目标

- 不生成或执行单元／组件测试；不把单页浏览器测试命名为组件测试。
- 不承诺所有语言、框架、动态页面、接口协议第一版全部支持。
- 不承诺“两个文件上传后，无人参与、任何业务都能全自动正确测试”。
- 不保证所有潜在缺陷或所有输入组合完全覆盖。
- 不以代码覆盖、两次 PASS、模型自评分替代需求正确性。
- 不自主修改 AUT、增加 testId、修复业务 bug、执行未知脚本或重置真实业务数据。
- 不以微服务、图数据库、向量库、Temporal 或 PostgreSQL 作为开工前提。

### 1.5 假设与建议初始范围

尚未收到真实目标源码；先建议以与仓库 AUT 接近的 **TS／JS、React、Express、REST／JSON** 为首个验证组合。源码解析器的覆盖清单必须公开。其他框架可以先使用人工资产／标准接口资料，或明确进入 unsupported；不能以“支持源码”笼统宣传所有技术栈可用。

首个业务切片建议为登录及一个 CRUD／筛选功能，覆盖 UI、负面 API、独立断言和数据准备。所有版本、语言与环境条件须在实施前核实。

## 2. 不可破坏的架构原则

以下 G 编号是后续实现计划的全局约束。

- **G01：正确答案来自批准的需求或人工决策。** 源码、DOM 和网络响应是实现／观察证据；不得静默升级为业务真值。
- **G02：先有测试设计，再自动化实现。** 两阶段可以在一次作者交互中生成提案，但审批与契约必须分开；不是必须保存两份自由文本。
- **G03：结构化设计是唯一语义真源。** NL 为派生视图；编辑视图必须转成结构化修订并使旧审批／绑定按影响失效。
- **G04：动作、断言对象和观察时刻分别表达。** 不把结果断言默认挂到最后一个被操作控件，不跨状态变化合并 verify。
- **G05：运行期零 LLM。** 不引入 Stagehand、模型 SDK、提示词、自愈生成或实时源码解释来决定回放行为。
- **G06：失败不能改善覆盖数字或削弱测试。** 不删期望、不换为实际值、不因编译失败把条件从分母移除。
- **G07：产物和输入不可变、可追溯。** 修改产生新 revision；已发布测试包和正在执行的副本不可被作者任务覆盖。
- **G08：草稿、业务批准、绑定证据、校准结果、发布状态相互独立。** 软件有已知缺陷不等于测试不合法；测试通过也不等于可发布。
- **G09：变量有类型和来源。** literal、parameter、secret、extracted 明确区分；空字符串合法，缺失引用报错。
- **G10：严格执行为默认。** 动作目标要求唯一；不默认 `.first()`、force、JS fallback 或任意 evaluate。
- **G11：异步可受控，不能无限等。** 明确 eventually／观察窗口语义、超时与结果；不能用固定 sleep 代替所有状态等待。
- **G12：unsupported、unbound、blocked 和未执行都必须可见。** 不降为“看起来成功”的空产物。
- **G13：运行环境与副作用必须经授权。** 源码只读索引不等于授权构建、启动、安装依赖或运行其中脚本。
- **G14：任务状态和证据以持久存储为准。** SSE／WS 是传输，不是最终状态；至少一次传递不宣称业务副作用恰好一次。
- **G15：旧产物只通过显式兼容路径运行。** 迁移不得自动提升为 V2 已批准测试，不可丢弃用户的手工步骤和预期。
- **G16：模型预算和权限必须在程序侧执行。** 页面／源码中的文本不能成为提高权限、改预期或执行命令的指令。
- **G17：重构验收必须包含正确 AUT 与已知缺陷 AUT。** 仅有 mock 测试或绿色回放不能宣布闭环可靠。
- **G18：只做 Web UI／API。** 产品层级标注为 UI、API 或混合；不建立单元／组件执行器。

## 3. 现状证据与重构决策

### 3.1 当前值得复用的能力

| 当前事实 | 重构决定 |
|---|---|
| PRD 导入、源锚点、文件版本和成员关系已有实现 | 复用解析与存储经验，补不可变语义快照，不重写所有文档解析 |
| TestGen 三角色及人审检查点已接通 | 保留人审和 Provider，重构输出契约；角色不是固定三次模型链的产品要求 |
| NL intent 已保存，emit 输入有 verb／data／expectation | 用作迁移入口，不再从 action 首词恢复机器动作 |
| HTML knowledge 是可选静态索引并有快照绑定 | 作为一个资产来源，不冒充完整源码分析 |
| UI／API 执行与共享核心存在 | 复用浏览器会话、HTTP 传输和部分工具；结果及断言语义必须先验证再复用 |
| Agent／本地执行、WS、报告已存在 | 保留接入体验，逐步统一新任务／产物协议 |
| SQLite 已 WAL／外键／懒初始化 | 首期保留，补事务、不可变 revision、持久任务与并发条件更新 |

### 3.2 必须修复或替代的路径

| 证据 | 当前风险 | 新决策 |
|---|---|---|
| `agent/recorder/ai-recording-session.ts:936–1092,648–679` | 录制期判断不满足会跳过编译，再以实际值兜底 | 观察只能取证；不决定或删除业务预期 |
| 同文件 `1363–1389`；`agent/recorder/refiner.ts:269–280` | intent 变成 rule／confidence=1，rule 无条件保留 | 预期来源、编译方法、批准与回放证据分维度存储 |
| 同文件 `1318–1389,654–655` | 动作依托和 raw／consolidated 序号混用 | 稳定 ID 与独立断言目标，不按数组位置跨阶段绑定 |
| `shared/execution-core/assert-normalizer.ts:95–110,153–162` | 向前合并可能改变检查时刻 | V2 独立 assert；legacy 修复不得改变原始顺序 |
| `agent/recorder/ai-recording-session.ts:775–810,826–829,894–904` | 吞失败、忽略 ActResult、部分失败后继续 | 作者步骤、动作结果、捕获完整性分开；缺口不能发布 |
| `server/modules/execution/ui-executor.ts:337–368,491–541,941–987` | first／force／JS fallback、一次快照、soft 失败未正确汇总 | 严格绑定、有界重取、显式失败与类型化实际值 |
| `shared/core/step-loop.ts:121–164`；`case-executor.ts:47–64,102–108` | 负面 API 被 HTTP 范围判失败，soft 可显示通过 | completion 与 verdict 分离，按明确预期判业务结果 |
| `server/modules/ai-driven-recorder/finalize-run.ts:115–142` | completed 后内存触发确认 | durable author job，不可变校准副本和持久关联 |
| `confirmation.ts:137–157,141–142,181–188` | 环境首项、缺 Agent／fixture、共享 Suite 临时 soft 写回 | 明确 ExecutionProfile，执行副本不改发布数据 |
| `server/modules/nl-cases/repository.ts:86–129`；`schema.ts:3–9` | 覆盖字段未完整保存，intent 任意 record | V2 schema、revision、断言级追溯与条件基线 |
| `client/features/nl-cases/NlCasesPage.tsx:413–414`；`client/shared/testing/StepList.tsx:2139–2145` | 文本编辑保留旧 intent，批准只是复制 | 语义变更生成修订；审批包含人、版本、原因与校验结果 |
| `server/modules/ai-test-gen/graph/nodes/designer.ts:100–111` | component／flow 与测试层级混淆 | 条件类型与 UI／API 渠道分离 |

现有 `AiDrivenRecorderController` 已检查 NL Case 的 APPROVED 状态及同一 NL Case 的活动录制冲突（`controller.ts:106–134`）。不能说平台完全没有审批或并发控制；不足在于审批未绑定完整语义版本，确认／发布路径也没有统一的 durable 约束。

### 3.3 备选路线及选择

- **继续以录制为主，局部修补：**短期工作少，适合作为旧入口保底；长期仍受重复语义解释和浏览器探索限制。
- **直接让模型按源码写执行用例：**在成熟资产中有价值，但若没有独立设计、类型化编译与发布门，会把实现错误和幻觉固化。
- **本蓝图推荐的测试编译平台：**需求驱动设计为主干，源码／人工／HTML／浏览器统一提供绑定证据，规则设计用于特定业务，最后由纯代码编译并执行。

因此是 B 主干融合 C 快路与 D 设计技术，不是要求继续保留 A 的固定多 Agent＋强制录制链。用户已选择 UI／API 范围；此架构选择仍是提案，待蓝图评审后实施。

## 4. 总体架构与主流程

### 4.1 模块化单体，作者平面和运行平面分离

首期一个 Server、现有 Client、独立 Worker／Agent；共享领域与运行包。不要以模块数量推导微服务数量。

作者平面拥有需求理解、资产索引、模型调用、设计提案、绑定提案、校准与发布。运行平面只接受冻结 ExecutableBundle 和 ExecutionProfile，不读取模型配置、不需要源码、不修改设计。

### 4.2 深 Module 划分

| Module | 调用者必须了解的 Interface | Implementation 的职责 |
|---|---|---|
| Requirements | 输入文档快照，输出待审批的语义快照／歧义 | 格式解析、锚点、规则提取、人工确认和版本 |
| SourceAssets | 输入只读源码快照，输出有来源的资产快照及 unsupported 清单 | 安全读取、AST、索引、关系、检索和增量缓存 |
| TestDesign | 输入批准需求、条件基线及资产证据，输出设计提案／修订 | 测试技术、预算化模型提议、覆盖与交叉校验 |
| Binding | 输入设计修订与 profile，输出绑定方案及证据／缺口 | 资产匹配、浏览器观察、有限 AI 提议、条件目标验证 |
| Compiler | 输入批准设计、绑定及能力表，输出完整测试包或阻塞诊断 | 类型化映射、时序、引用、权限、覆盖、manifest |
| Runtime | 输入冻结包、profile、参数，输出完整运行报告 | 严格 UI／API 执行、变量、观察、断言、fixture、聚合 |
| Authoring／Publication | 输入明确阶段命令，输出 revision／job／发布结果 | 审批、校准关联、CAS、事务、幂等及过期判断 |
| DurableJobs | 领取、心跳、完成、重试，均带 attempt／lease | SQL 队列、事件、outbox、fencing、恢复及资源锁 |

Compiler 不做 I/O、不调用 LLM、不取当前页面作为答案。Binding 不替业务决定正确值。Runtime 不决定覆盖基线和发布资格。这些是 Module 的 Interface 约束，不是注释约定。

源码、人工资产、HTML 与浏览器确实是多个不同资产／证据来源，可以在同一个 Seam 上提供 Adapter。不要为每个文件或提示词增加抽象层。

### 4.3 单次业务流程

1. 创建项目，配置支持的源码类型与执行环境。
2. 导入需求和源码，保存不可变原始快照。
3. 解析需求，展示歧义；用户批准语义快照及测试范围。
4. 确定性提取源码资产；将源码独有规则列为候选，不自动补写需求。
5. 形成条件基线，生成设计提案，人工／规则门批准新 revision。
6. 对每个目标和接口优先使用资产绑定；不能确定的部分进入浏览器绑定作业。
7. 对绑定差异和条件目标进行验证／审核，记录 profile 和源码版本。
8. 编译；有错误则保留设计及全部覆盖缺口，不产生“部分可发布包”。
9. 使用冻结副本进行校准；记录通过、业务失败、环境阻塞和技术错误。
10. 按发布策略批准测试包；不要求在有已知 bug 的应用上把预期改到全绿。
11. 正式执行；结果关联包、profile、attempt 和所有 assertionId。
12. 文档／源码变化后创建受影响修订提案，旧版本继续可追溯。

## 5. 核心领域模型和契约

### 5.1 类型定义及单一来源

建议新契约位于 `shared/testing/contracts/`，使用 Zod schema 作为校验定义并导出 TypeScript 类型。以下是契约设计，不是本次添加的运行代码。

所有 ID 均为显式字符串标识：`SnapshotId`、`RevisionId`、`AssetId`、`ConditionId`、`PredicateId`、`ArtifactId`、`ProjectId`。身份与内容 hash 分开；业务 ID 保持稳定，内容变化创建新 revision。不要用时间／数组序号代替身份，不把 hash 当成权限或密码学签名。

`Diagnostic` 至少含 `code`、`level: error|warning|info`、`message`、`refs: string[]`、`requiresReview`，可选字段路径。诊断必须机器可判定，不能只输出一行模型解释。

### 5.2 必须持久化的对象

| 对象 | 关键字段 | 约束 |
|---|---|---|
| RequirementSnapshot | projectId、documentSnapshotIds、AC、源锚点、语义 hash | 当前需求行不能替代历史语义快照 |
| SourceSnapshot | 文件 manifest／hash、声明 commit、解析范围、excluded／unsupported | 声明 commit 与内容 hash 同时保存；不假设源码与部署一致 |
| AssetSnapshot | sourceSnapshotId、提取器版本、UI／API／关系／规则事实 | 每项带文件／符号／行号或契约指针 |
| CoverageBaseline | requirementSnapshotId、审定条件、渠道义务、排除决策 | 在用例生成前批准，不能让模型自定分母 |
| TestDesignRevision | 条件引用、cases、操作、谓词、数据、源头、审批 | NL 派生；不是 action＋expected 的自由文本协议 |
| BindingPlan | designRevisionId、assetSnapshotId、profileRevisionId、targets、endpoints、fixtureRefs | 版本化；验证与批准分开 |
| ExecutableBundle | schemaVersion=2、manifest、cases、bindings、fixtureRefs、runtime 要求 | 编译后不可变；可导出；无提示词或运行期 AI 入口 |
| ApprovalRecord | actor、revision／hash、批准类型、时间、原因 | 状态 APPROVED 不足以替代审批记录 |
| JobRecord／JobEvent | status、phase、attempt、lease、input/output refs、event sequence | 服务重启不丢失校准／审核阶段 |
| RunReportV2 | 包／profile／fixture／attempt、completion、verdict、步骤与断言结果 | 不能从日志文本推断最终 verdict |
| EvidenceRecord | 所属 run、目标／断言、源版本、观察值、截图／网络引用 | 类型化、按权限脱敏、保留不可执行证据 |

### 5.3 值与引用

```ts
type JsonValue = null | boolean | number | string | JsonValue[]
  | { [key: string]: JsonValue };

type ValueRef =
  | { kind: 'literal'; value: JsonValue }
  | { kind: 'parameter'; key: string }
  | { kind: 'secret'; key: string }
  | { kind: 'extracted'; key: string };
```

规则：

- `literal: ""` 是空字符串，不是缺失，也不是两枚引号。
- 不对裸字符串尝试变量猜测；不混用 `${key}`、`{{key}}` 和键名作为内部协议。
- 复合请求数据以 JSON 模板节点表达，各节点可以引用 ValueRef；不能用无类型字符串拼接 JSON。
- 编译校验引用定义和可用顺序；运行校验实际参数、secret 和提取值。缺失返回明确错误，不原样发送占位符。
- secret 通过执行期授权存储解析；模型、测试包和默认日志不含明文。
- 数字、布尔和字符串不隐式相等。若需业务转换，转换规则必须被设计批准并编译冻结。

### 5.4 设计操作与独立谓词

`DesignCase.channel` 只允许 `ui|api|mixed`。条件可以是字段、流程、权限、异常或边界，不能借此宣称执行层级为组件测试。

设计操作使用判别联合，基本类别是：`navigate`、`ui`、`request`、`observe`、`wait`、`assert`、`extract`。UI 动作分别表达 click／fill／clear／select／check／uncheck／press 等；每种动作定义自己的必备字段。

每个 `PredicateSpec` 有稳定 `id`、`conditionIds`、`expectedOrigin`、`ObservationRef`、operator、可选 expected ValueRef 和 temporal。`expectedOrigin` 记录批准需求／人工决策／待确认推断，不能用编译方法覆盖。

ObservationRef 类型：

- `ui`：targetId、属性 text／value／attribute／visible／enabled／checked／count；attribute 要求属性名。
- `page`：pageRef、url／title。
- `response`：responseRef、status／body／header；JSON body 要求路径，header 要求名称。
- `network`：watchId、count／matched-response 等明确观察项。

首批 operator：`eq`、`ne`、`contains`、`notContains`、`exists`、`notExists`、`matches`、`gt`、`gte`、`lt`、`lte`。类型相容矩阵决定哪些组合合法，不能统一映射 CONTAINS。没有意义的空字符串 contains 必须阻塞，合法空值 eq 必须保留。

`exists` 检查路径／对象是否存在：JSON 字段值为 null 仍是存在，missing 才是不存在；读取 error 不能让 notExists 通过。首批 JSON 路径只支持明确的属性／数组索引，不启用脚本表达式或求值；正则、响应大小和解析时间在执行政策中受限。

一个 AC 可以要求多个谓词；一个操作可以后接独立 assert 组。每个谓词可以检查不同 target 或 response。`fill username → click submit → assert username unchanged` 必须保持提交后检查。

### 5.5 观察与时间

- `immediate`：在明确位置读取一次；适合已经确定完成的同步结果。
- `eventually`：有界重取实际值，直到匹配或超时；建议默认 timeout=5000ms、interval=100ms，由 Compiler 写入包。
- `throughout`：检查已启动观察器记录的指定窗口；需要动作前启动 `observe`，动作后明确关闭。
- 首批 HTTP 请求 timeout=30000ms；不得用这个技术默认值宣称 AUT 的业务 SLA。
- 否定网络条件，例如“空密码不得发登录请求”，必须动作前启用匹配 observer，在明确窗口内检查 count=0。刚点击后立刻看“没有响应”不是证明。
- UI 状态 throughout 若采用采样，报告采样间隔和窗口；不声称有限采样证明所有连续时刻。未实现的观察能力必须 unsupported。

### 5.6 BindingPlan

每个 TargetBinding 至少有 `targetId`、页面／frame、定位计划、`resolution: unique|collection`、`validationBasis: runtime|source-conditional`、证据引用与审批。

- 动作目标默认 unique，必须恰好一个可操作元素。
- count 谓词有意针对集合时允许 collection，不用 `.first()` 伪装唯一。
- LocatorPlan 优先批准的 testId、role＋exact name、label；其次稳定 CSS。XPath／结构选择器必须标明维护风险。
- 多候选只在批准后的显式策略下尝试；记录实际使用项。不得运行期让 LLM生成新候选。
- frame、窗口上下文和数据行身份明确，不能从最后一条 payload 推断。
- **绑定验证不能要求业务预期当前成立。** 条件渲染的错误提示可有源码定位但当前 count=0；通过已知正确场景验证或人工批准 source-conditional，不能因为 bug 没渲染它而删除预期。
- 正式 assert 的目标缺失按谓词语义处理：count=0、visible=false 或文本 eventually 失败；不能所有路径都先 wait attached。

API binding 保存 method、路由模板、参数／请求格式、环境 endpoint 引用、responseRef、认证引用；没有可证实的路由／协议则 unbound，不猜 URL。

### 5.7 编译与运行 Interface

以下名称同时用于重构计划，相关类型由 contracts 导出：

```ts
compileDesign(
  design: TestDesignRevision,
  binding: BindingPlan,
  context: CompileContext,
): CompileResult;

runBundle(
  input: ExecutionInput,
  deps: RuntimeDeps,
  signal: AbortSignal,
): Promise<RunReportV2>;
```

`CompileContext` 包含批准记录、profile、fixture 定义、版本和 RuntimeCapabilities；`CompileResult` 是 `status: compiled|blocked`、诊断及仅在 compiled 时存在的 bundle。

`ExecutionInput` 包含 bundle、profile、runId、attempt、显式参数。RuntimeDeps 提供 UI／HTTP Adapter、secret 解析、fixture 执行、时钟、证据和日志出口；不提供模型或任意 shell。

### 5.8 状态和结果不能混用

- DesignRevision：`draft|needs_review|approved|superseded`。
- BindingPlan：`unbound|proposed|validated|approved|stale|unsupported`。
- Artifact：`draft|compiled|ready_for_review|published|deprecated`。
- Job.status：`queued|running|waiting_review|succeeded|failed|cancelled`；phase 单独保存。
- Run.completion：`completed|cancelled|blocked|infra_error`。
- Run.verdict：`passed|failed|unknown`；没有完成有效检查不得判 passed。
- PredicateResult：`passed|failed|error|not_exercised`，保留实际值的类型和 missing 原因。

`collect` 表示继续收集，失败仍使 case／run verdict=failed；`stop` 表示中止后续业务操作。legacy soft 显式映射 collect，不映射“忽略失败”。

业务缺陷分类与执行错误分开。动作目标缺失可能是版本漂移、页面 bug 或错误 fixture；系统保留具体错误和证据，不仅凭状态标签自动认定已检出业务 bug。

## 6. 需求理解、测试设计与覆盖

### 6.1 需求源头

原始文档文件、解析结果、人工修订和批准快照都保存。文档导入状态不是审批证据。必须能重建“这个测试包当时针对哪一版 AC”。

需求解析可以利用 LLM，但输出为待批准的结构化候选。遗漏／歧义、相互矛盾的规则、不支持的验收点都单独展示。用户可以修订 AC，系统不能为了自动化容易而把要求改弱。

### 6.2 条件基线早于用例生成

CoverageBaseline 将批准 AC 拆成可核算的义务：正常、异常、空值、数值边界、角色、流程状态、组合、接口／UI 渠道要求。

模型可以提议条件，规则可以展开条件，源码可以补充候选，但最后基线由规则校验和责任人批准。不能以模型生成多少条件作为“总共应该测多少”。

每项义务至少有：conditionId、AC 引用、业务描述、渠道 `ui|api|either`、风险、必需谓词语义、适用性、批准状态。需求明确要求页面错误提示时，API 拒绝用例不能代替 UI 义务；跨渠道重复可以是合理覆盖。

### 6.3 测试设计技术

- 等价类：有效／无效类别来源明确，不仅随机构造数据。
- 边界值：有批准的范围时展开边界邻域；源码限制只算候选，不能自创需求上限。
- 判定表：条件、规则和预期均可追溯；合并等价规则要保留原规则覆盖。
- 状态迁移：定义状态、事件、允许／禁止迁移及前提；源码路由不是业务状态模型的唯一来源。
- 组合覆盖：只有维度和覆盖强度被批准后使用；pairwise 不等于全部组合，也不替代已知高风险多因素条件。
- 风险／错误猜测：作为补充候选，并标示来源；不强制加一个独立 Agent。

规则密集需求可以建立轻量模型；普通登录／CRUD 不要求先建庞大形式化模型。

### 6.4 三种覆盖不能合成一个“准确率”

1. **设计覆盖**：基线义务中，有批准用例及符合语义的谓词的比例。
2. **自动化落地覆盖**：上述义务中，有完整、受支持、已批准绑定和可执行编译产物的比例。
3. **执行覆盖**：指定版本和环境中，这些谓词实际被执行的比例；not_exercised 不算覆盖。

PASS 率另算；源码语句／分支覆盖不属于本产品的默认目标。源码关系只帮助设计和影响分析，不声称静态阅读证明执行覆盖。

覆盖计算由程序遍历义务→case→predicate→binding→artifact→run 链。类型及追溯检查只能证明结构闭合；语义充分性仍需审核与缺陷实验，不由 assertionId 存在自动证明。

unsupported、未绑定、环境阻塞保持在适用基线分母。业务不适用／明确排除必须有 actor、原因和版本，另列排除数量，不能暗中提高覆盖率。

### 6.5 LLM 角色重构

不以三个角色必跑作为架构约束。建议任务型调用：

- 需求语义提案。
- 测试设计提案。
- 必要时的绑定提案。
- 高风险或明确请求时的独立质量意见。

机械字段校验、重复 ID、引用、能力匹配、覆盖计算与时序检查交给代码。质量意见输出诊断和建议，不可直接改写已批准预期。默认每个模型阶段最多 2 次请求（首次＋一次定点修复）；复杂任务需要显式提高预算或等待审核，不无界循环。

## 7. 源码资产分析

### 7.1 输入与安全读取

首期支持经用户授权的源码归档／快照导出。仓库 URL 拉取作为以后独立权限受控能力，不默认遍历用户整个磁盘或自动拉 submodule。

建议初始上限：压缩输入 100MiB、解压总量 500MiB、20000 个文件、单文件 2MiB；这些是保护性默认值，不是性能承诺。超限返回明确错误及可审批的范围调整，不静默截断后称“完整分析”。

拒绝路径逃逸、符号／硬链接、特殊文件、大小写冲突及解压炸弹。默认排除 `.env`、私钥、凭据、依赖目录、构建产物；排除范围要可见。解析在受限 Worker 中进行，单文件建议超时 30s；超时为 unsupported，不编造事实。

### 7.2 源码事实

首批 TS／JS 提取使用 TypeScript AST，不执行 import／装饰器／构建插件：

- UI：route、页面、React 控件、testId／id／role／label、表单数据路径、条件渲染、事件关联。
- API：Express route 和 router mount 组合、method／path、请求字段、schema 引用、认证／错误分支候选、response 字段。
- 关系：页面→控件、操作→请求、router→handler、规则→符号和源位置。
- 数据准备：候选 reset／seed／cleanup 入口、样例数据与现有文档；只输出候选，不执行。
- 标准契约：OpenAPI／JSON Schema 是可接入资产，注明版本与是否同部署；schema 正确不等于业务正确。

动态路由、复杂包装器、运行期配置、外部服务和无法解析的 schema 必须列 unsupported／uncertain。导入组合与框架 Adapter 的限制有契约测试；不能 grep 到一个字符串就认为已解析整个调用链。

### 7.3 资产不是业务规则

SourceFact 的 certainty 表达提取可靠性，不表达业务正确性。例如“源码有 username.length <= 20”是实现事实；要把 21 字符拒绝加入验收预期，必须关联需求或人工批准。

源码与需求矛盾进入 `IMPLEMENTATION_CONFLICT`：保留需求预期，列实现证据和受影响条件。系统不自动修 AUT，也不自动批准“按当前实现来测”。

### 7.4 检索与缓存

- 按页面、符号、接口和条件查询必要片段，不把全仓库反复发给模型。
- 首期 SQLite 索引／全文检索＋有限关系表即可；不先引入图数据库或向量库。
- 资产缓存键至少包含 source manifest hash、提取器版本、范围配置、框架 Adapter 版本。
- LLM 提案缓存包含需求／设计 revision、资产快照、模型／prompt／schema 版本和政策。
- 同文件内容不变可以复用提取结果；用户批准仍绑定具体 revision，不能因为缓存命中自动继承审批。

## 8. 绑定、浏览器验证与录制

### 8.1 优先级

1. 用户批准的现有控件／接口资产。
2. 源码／标准契约可确定的候选。
3. 运行 DOM、可访问性和网络证据。
4. 受限 LLM 绑定建议。
5. 人工补充；仍无法确定则 unbound／unsupported。

“源码先行”不是“只要源码出现 selector，就一定能发布”。需要根据对象是静态、条件渲染或集合，采用正确验证方式。

### 8.2 源码辅助的作者期动作

将批准设计中的动作映射为明确的 Playwright 操作。已知目标无需 Stagehand 再理解整句 action；必要时 AI 只返回结构化候选目标／动作，不持有修改预期的权限。

作者期执行保存 actionId、预期操作、实际操作、locator、before／after、frame／window、请求和结果。动作执行、证据采集、录制捕获是不同状态。ActResult success=false 是明确失败；缺捕获只表示证据不足，不能写“已验证”。

模型建议的 cleanup 或额外动作不能直接进入正式测试：与设计不一致就形成修订提案。重试不得偷偷改变用例前提或绕过业务阻塞。

### 8.3 新录制器的职责

从“自动制造整套执行步骤和业务断言”降为：

- 发现控件和交互路径。
- 记录绑定证据及操作观察。
- 帮助人工建立候选设计／绑定修订。
- 为失败诊断提供截图、网络和动作轨迹。

新主链不要求 `_enableRecorder` 可用；已知步骤可以直接编译。旧人工／AI 录制入口暂时保留，通过 LegacyImport Adapter 进入待审核设计，不能直接提升为正式 V2 包。

### 8.4 AI 探索约束

探索只在授权环境、预算和可接受动作范围内运行。涉及数据写入／上传／删除／外部通知时必须使用已批准 fixture。默认一次未解决目标最多 2 次模型请求；预算用尽保留缺口，不改预期、不无限 self-heal。

运行期没有该探索 Adapter；执行失败只返回证据和修订建议入口。

## 9. 确定性编译与执行

### 9.1 Compiler 的职责

输入同样的设计、绑定、profile、fixture、能力和版本，除独立的发布时间／ID 外，应得到规范化相同的语义包与 content hash。

校验清单：

- 所有业务期望已批准且指向需求／人工决策。
- conditionId／targetId／responseRef／watchId／变量定义存在，顺序正确。
- 操作和 operator 在运行能力表中；属性／JSON 路径／值类型合法。
- 条件渲染和集合目标使用正确定位／断言语义。
- 等待、窗口观察和断言发生位置明确。
- API path／body／headers 类型化，method 与契约一致。
- 所有负面 API 有显式状态／契约谓词，不依赖默认 2xx 判定。
- fixture 和 secret 是授权引用，不含明文、shell、任意 evaluate 或外部 URL 猜测。
- 覆盖义务的有效谓词没有在生成／编译／修复中消失。
- Profile、源码、设计与 binding revision 一致；版本不明要求审核或阻塞。

有 error 只输出阻塞诊断及不可执行预览。不能产生“去掉错误断言后成功”的测试包。warning 是否能发布由显式策略决定，不依赖 LLM 自报 confidence。

### 9.2 RuntimeCapabilities

能力表由运行器实现及行为测试维护，列操作、值类型、观察语义、frame／window、API 格式与导出版本。

首个纵向切片支持 navigate、click、fill、clear、select、check、uncheck、press、独立 assert／wait／extract、REST 请求和 network observe。PATCH／HEAD 等必须按 HTTP Adapter 的真实支持声明，不受旧 42 个 UI 下拉项限制。

拖拽、上传、多窗口、frame、自定义控件、XML 和复杂 API 格式按真实实现逐项解锁。未支持的旧关键字保持在 legacy 通道，不假冒支持，不丢弃条件。

### 9.3 UI 执行

- 操作目标严格唯一，等待可操作状态；歧义返回 `TARGET_AMBIGUOUS`。
- 不默认 force／JS fallback；特殊操作必须在设计和发布策略中明确批准。
- 每个谓词解析自己的 ObservationRef，不统一使用 action.target。
- eventually 每次重读，不复用一次快照。实际读取失败不替换成方便通过的 false／true。
- 缺失节点与隐藏节点分别报告；visible=false 和 count=0 可以合法检查不存在。
- 网络 observer 在动作前注册，以 watchId 和 responseRef 关联；不能等动作结束才监听已发生的响应。
- frame／window 上下文与定位策略冻结，运行器记录实际使用候选和漂移。

### 9.4 API 执行

transport success、HTTP status 和业务契约 verdict 分开。401／404 可以是成功接收的响应，并且符合负面用例预期；连接失败／超时不是预期 401。

响应命名并保存到 responseRef，status／JSON body／headers 各有谓词。JSON 路径 missing 与 null、false、0、空串区分；类型错配不能通过字符串转换掩盖。请求／响应敏感字段按 profile 脱敏。

### 9.5 执行包导出

导出物建议是 `bundle.json`＋执行器版本说明＋参数／secret 引用说明＋profile 模板。包可以由本地、Agent 或 CI 的可信 runner 运行；不要求打开作者 UI。

V2 runner 的依赖面不包含数据库仓库、Stagehand、LLM SDK 或源码解析器。执行策略默认禁止 provider 凭据和模型出口；AUT 允许的业务网络依 profile 放行。

### 9.6 兼容策略

V2 是唯一目标运行协议，不长期维护 NL、raw payload、legacy Step 和第三种脚本的多个真源。现有 TestSuite／TestCase 的产品身份可保留，增加 artifact revision 指针；旧 TestStep 经显式 Adapter 解释。

不能无损表达的旧步骤原样保留在 legacy，或进入需审核迁移报告。V2 与 legacy 的结果都对外给出 completion／verdict；旧 UI 的 status 映射不能再次把 collect 失败变成绿色成功。

## 10. 环境、账号与数据隔离

### 10.1 ExecutionProfile

必须版本化保存：

- AUT UI／API origins、环境和部署版本证据。
- 指定本地／Agent 执行位置及能力要求；不能默认环境列表首项。
- 浏览器／viewport／locale／timezone，以及 headless／证据保留。
- 账号角色与 secretRef，不把口令写进模型 prompt 或包。
- fixture 的 prepare／cleanup、数据作用域、允许的请求和副作用。
- 并发资源锁、重试政策和数据重置权限。
- Mock／外部依赖策略；mock 必须在报告显著标明，不把 mock 通过称为真实集成通过。

若无法核实部署 commit，保存未知状态，不说已与源码匹配；重要差异触发需审核。版本漂移不会自动修改批准绑定。

### 10.2 Fixture 生命周期

建议流程：授权检查 → 获取环境／数据作用域 lease → prepare → browser／API session → case → cleanup → 释放 lease。

优先 runId 前缀的独立数据和专用测试环境。全局 reset 只能在明确独占环境使用；不因源码出现 `/test/reset` 就执行它。

prepare／cleanup 由结构化允许操作或可信注册函数实现，不运行目标仓库任意脚本。cleanup 失败必须报告，污染作用域隔离后才能重试。写入请求重试是否安全由 fixture／幂等能力决定，不默认自动重放。

新浏览器只隔离 cookie／storage，不隔离数据库。每次校准和正式重跑都要重新取得正确的数据前提，不能拿两次连续写入当成独立重复验证。

## 11. 校准、审核与发布

### 11.1 替代旧 Confirm／Emit 信任矩阵

保留使用生产执行器校准的优点，但淘汰“AI 两次通过即真、rule 直接保留”的判定方式。

校准回答：目标绑定是否有效、步骤能否在指定前提下运行、哪些业务谓词通过／失败、哪些未执行。它不回答：业务预期本身是否正确。

默认可以做 2 次隔离校准作为初步证据；这不是可靠性统计保证。校准用 immutable bundle 和执行副本 collect 策略，不将临时 soft 写回共享 Suite。

### 11.2 失败处理

| 校准情况 | 处理 |
|---|---|
| 正确环境全部有效谓词通过 | 记录可重复性证据，进入发布审核 |
| 已批准预期失败，绑定及前提成立 | 保留测试和失败证据；可能 AUT 有缺陷，责任人分类 |
| locator 歧义／版本不符 | 修改 BindingPlan 提案，旧包不被自动覆盖 |
| 数据、认证或网络环境不成立 | blocked／infra_error，不给通过结论，不降低覆盖分母 |
| 部分谓词未执行 | not_exercised；完整性不足时阻止自动发布 |
| 预算耗尽／任务中断 | 保留阶段状态及缺口，不能 finalize completed 后丢确认 |

### 11.3 发布策略

发布检查至少包含：批准需求和范围、批准设计、预期来源、完整绑定及能力、fixture 授权、包完整性、校准关联、剩余诊断、版本一致性。

已知业务缺陷可在责任人明确批准并关联缺陷时发布保留该失败预期的回归测试；不能为了发布要求作者把断言改绿。普通自动发布只适用于已定义低风险政策，并留下完整审批记录。

允许发布某个明确范围的完整包，不允许将失败条件静默裁剪。范围改变产生 CoverageBaseline revision，保留被排除条件和批准原因。

所有批准／撤回／发布必须使用 expected revision 条件更新。作者修改与校准并发时，旧 job 只能关联其原 revision，不可覆盖新编辑。

## 12. 持久任务和运行恢复

### 12.1 状态以数据库为准

Job 记录包含 type、phase、输入快照、输出 revision、预算、attempt、worker、lease 到期、取消请求、最后进度、错误及父子 job。

关键事务：

- 创建 job 与 outbox command 原子提交。
- 领取 queued job 使用条件更新，不能先读后无条件写。
- 完成使用 jobId＋attempt＋leaseToken 的 fencing 条件。
- phase 输出 revision、事件和下一 phase 的任务一起提交。
- 发布与审批验证事务化；报告保存成功才能声明最终状态。

建议 lease=60000ms，heartbeat=20000ms，Worker 要支持取消和资源清理。具体值是初始工程默认，不是吞吐／恢复 SLA。

### 12.2 不宣称恰好一次

outbox／WS command 是至少一次传递；commandId＋attempt＋artifact hash 去重。旧 attempt 的迟到报告保存为历史证据，但不能提升当前 job 状态。

数据库 fencing 不能阻止已经发出的外部写操作。环境隔离、runId 数据作用域、幂等接口、Worker 终止与恢复前 reconciliation 共同处理副作用。无法确认 prepare／mutation 是否完成时进入 waiting_review／blocked，不重放整个流程赌运气。

### 12.3 恢复策略

- 纯解析／编译可从不可变输入重跑。
- 等待人审保持 waiting_review，不自动替用户 approve。
- 浏览器绑定中断：清理／隔离环境，重新开始该可安全作业；不把 live steps 当完整产物。
- 校准中断：重建执行副本与 fixture，保存原 attempt 未完成结果。
- 服务端重启：领取过期 lease 后先 reconciliation，禁止只因有部分步骤而标 completed。
- 运行取消：持久取消请求，经 heartbeat／WS 传达；清理结果也进入报告。

### 12.4 SSE／WS

事件存储单调 sequence；SSE 支持 Last-Event-ID／cursor，GET snapshot 后从 cursor 续读。断线不丢真实状态。WS command 有 ACK、attempt 和输入引用，不靠广播正文承载永久状态。

报告事件和截图等大对象只传引用。权限检查 project／job／artifact 归属，不以“知道一个 runId”作为访问许可。

## 13. 产品操作流程与接口

### 13.1 页面重构

保留 Requirements、Test Design、Execution、Reports 的产品入口，新增或整合：

1. **输入基线页**：文档、源码、部署版本、解析范围、支持／未支持。
2. **覆盖工作台**：AC／条件、批准状态、用例、自动化缺口、执行证据，不只有总百分比。
3. **设计编辑页**：可读句子与结构化字段同时展示；修改操作／预期触发 revision。
4. **绑定工作台**：源码位置、候选、运行观察、条件目标、fixture／profile，支持人工确认。
5. **校准与发布页**：展示每条谓词、not_exercised、业务失败、环境问题、版本、批准人。
6. **执行与变更页**：冻结包运行、历史报告、受影响关系和待修订用例。

AI Recorder 入口改为“辅助绑定／探索”，保留 legacy 标识。不能以黄色 warning 被动呈现关键缺口后仍默认允许发布。

### 13.2 建议命令接口

新接口统一位于 `/api/projects/:projectId/testing/`，采用项目授权、revision、请求幂等键。接口名称是建议，不是当前已存在路由：

- `POST input-baselines`：绑定已上传的文档／源码，创建 ingest job。
- `POST coverage-baselines/:id/approve`：按 expected revision 批准条件范围。
- `POST designs`：创建设计提案 job，返回 jobId，不同步等待模型。
- `POST designs/:id/revisions`：结构化修订；冲突返回 409。
- `POST bindings`：创建 source／browser binding job。
- `POST artifacts/compile`：编译指定设计／绑定 revision。
- `POST artifacts/:id/calibrations`：冻结包＋明确 profile 创建校准 job。
- `POST artifacts/:id/publish`：审批／完整性验证；返回发布 revision。
- `POST artifacts/:id/runs`：创建正式执行 job。
- `POST jobs/:id/cancel`、`GET jobs/:id`、`GET jobs/:id/events?after=`。
- `GET coverage-baselines/:id/coverage`、`GET artifacts/:id/export`。

接口只接收对象引用，不重复粘贴大量源码或 secret。上传资源的完整性、ownership 与内容 hash 在 intake 校验。

### 13.3 审批角色

区分需求／设计批准、环境副作用批准、发布与运行操作。小团队可由同一个人兼任，但审批类型和 actor 仍要记录。身份与项目权限实现应复用现有机制并在实施前核实；本蓝图不假设当前认证已经满足所有要求。

## 14. 存储、部署与技术选择

### 14.1 建议表

增加 V2 命名空间，不直接覆盖旧表：

- `testing_input_baselines`、`testing_requirement_snapshots`、`testing_source_snapshots`。
- `testing_asset_snapshots`、`testing_assets`、`testing_asset_edges`。
- `testing_coverage_baselines`、`testing_conditions`。
- `testing_design_revisions`、`testing_binding_revisions`。
- `testing_artifact_revisions`、`testing_approvals`。
- `testing_execution_profiles`、`testing_fixture_definitions`、`testing_fixture_receipts`。
- `testing_jobs`、`testing_job_events`、`testing_outbox`、`testing_resource_leases`。
- `testing_run_reports`、`testing_evidence_refs`、`testing_legacy_imports`。

核心语义对象可使用校验后的 JSON payload＋revision／hash／项目索引；条件、关系和 job 领取字段建立真实索引。不是每个小字段都必须新表，也不是把全部数据藏在任意 metadata 中。

文件／源码／截图以内容寻址 blob 存储，DB 保存引用、大小、项目、保留策略和来源。首期受控本地持久卷，后来可换对象存储 Adapter。hash 共享不等于跨项目授予访问。

### 14.2 部署

首期：一个模块化 Server、现有 Web Client、受限索引 Worker、可指定的浏览器／API Agent、SQLite WAL 和持久卷。

索引 Worker 不运行源码。AUT 构建／启动若以后支持，应是单独明确授权的沙箱作业，不能顺带在 Server 进程 npm install／执行脚本。

数据库路径应显式配置，不依赖任意 cwd；迁移、备份、blob 保留和恢复手册先完成。多实例写入、HA、长任务规模或实测锁争用明确后再选择 PostgreSQL／成熟队列；lease 和事务协议不能因为换库省略。

### 14.3 版本策略

当前评审锁定：TS 5.8.3、Zod 4.3.6、LangGraph 1.4.15、SQLite checkpointer 1.0.1、Stagehand 3.5.0、Playwright/core 1.58.2、better-sqlite3 12.8.0、OpenAI 6.44.0、React 19.2.4、Vite 6.4.3、Vitest 1.6.1。

建议保留这些作为兼容评估基线，而不是锁死未来升级。新部署建议 Node 24 LTS 的组织验证补丁版本；Node 20 已过官方支持期，但当前实际部署 Node 版本尚未核实。第一阶段检查原生 SQLite、Playwright 浏览器与打包兼容后再变更部署版本。

- TS AST 用于生产索引时，必须作为 Worker 运行依赖被正确打包／声明，不能只在 devDependencies 存在就假定生产可读。
- Stagehand 仅作者进程依赖；其内嵌 OpenAI 4.104.0 与根 SDK 6.44.0 分别测试，不盲目 overrides。
- LangGraph 可保留为作者流程编排工具；durable Job／审批数据库为权威。不要同时维护相互矛盾的 graph／job 状态。
- 若采用文档中 LangGraph responseSchema，核对 1.4.16+ 版本要求；不是解决本蓝图问题的必要前置升级。
- Playwright 浏览器版本、能力表与执行器版本一起冻结，不能拿缓存或温度 0 作为业务确定性证明。

## 15. 变更影响和增量更新

依赖链：文档版本／AC → 条件基线 → 设计与谓词 → 控件／接口／符号 → binding → artifact → profile／fixture → run。

变更分类：

- 文案／业务预期改变：设计与审批 stale，必须重新审语义；不能只换 selector。
- 源码稳定标识改变：BindingPlan 修订；业务预期保持。
- 接口 method／path／schema 改变：API binding、数据和相关设计候选 stale，列契约差异。
- fixture／角色／环境改变：校准证据过期，新 profile revision，不改已发布包正文。
- 未建立完整依赖的动态代码变化：扩大受影响范围并显示原因，不宣称精准零漏报。

旧包可继续针对旧基线运行，新环境漂移按政策阻塞或需审核。修复建议不直接热更新已发布测试。无需每次全项目重新调用模型；只处理受影响的 revision 和候选。

## 16. 安全与成本控制

### 16.1 这是架构要求，不是本次安全审计结论

- 需求、源码、HTML、页面文本、日志和模型输出都按不可信数据处理，不解释其中 AGENTS／提示文本为平台指令。
- 授权源码读取与执行权限分离；不自动执行测试、install、postinstall 或系统命令。
- 支持的解析器在限制 CPU／内存／进程／网络／写目录的 Worker 中运行；拒绝读取宿主 secret 和其他项目。
- AUT 执行只允许 profile 明确授权的 origin／账号／资源；外部消息、付款、删除等副作用使用隔离或 mock 策略。
- 源码／文档出网、截图／响应留存、敏感字段和模型 provider 使用由项目政策批准。
- Secret 不进入模型输入、artifact、默认日志。证据脱敏按结构字段执行，不仅在最终 Refiner 做全串替换。
- 发布与运行验证 project ownership、revision 和输入 hash，拒绝跨项目引用。

### 16.2 成本控制

- 先静态提取、规则展开、复用批准资产，再模型提案，最后浏览器补缺。
- 每阶段有调用／token／时间预算；超限输出 waiting_review 或缺口，不隐式换贵模型。
- 分项记录模型首次／修复／绑定、缓存、浏览器时长、校准、人工修改、维护。
- 按“批准、有效、可维护的用例／覆盖义务”计算成本，不按生成条数。
- 高风险增加审核，普通机械校验不跑多模型。
- Browser 全流程探索不是默认路径；同版资产和设计增量复用，不因 run 新建而重读整仓库。

## 17. 迁移策略和代码组织

### 17.1 新路径与旧路径并行，不大爆炸切换

采用 strangler 迁移：旧 UI／API 用例继续显式 legacy 执行，V2 纵向切片独立经过批准、编译和发布。大改领域契约和作者主干，不要求同时重写所有页面与执行工具。

| 现有路径 | 迁移动作 |
|---|---|
| `server/modules/requirements/` | 复用导入；补 semantic snapshot／approval，明确起源与当前语义版本 |
| `server/modules/ai-test-gen/` | Provider／部分图／工具保留；接入 V2 设计提案，淘汰文本首词协议和自报覆盖 |
| `server/modules/nl-cases/` | 老数据保留；新 NL 由 DesignRevision 派生，编辑经结构化 revision |
| `agent/recorder/ai-recording-session.ts`、`compile/`、`refiner.ts` | 旧入口隔离；新绑定不调用 legacy 的预期兜底／Emit 信任矩阵 |
| `server/modules/ai-driven-recorder/` | 现有接口保留兼容；校准／发布移入统一 Authoring／Jobs |
| `shared/core/`、`shared/execution-core/` | 先修已知行为，再按测试证明可复用部分；引入 V2 typed runtime |
| `server/modules/execution/` | 传输／会话逻辑迁到共享 V2 Adapter；旧 runner 显式分发，不隐式转换 |
| `agent/index.ts`、`agent/recording-control.ts` | 新命令带 artifact/profile/attempt；作者绑定与正式执行依赖面分离 |
| `client/features/ai-test-gen/`、`nl-cases/`、`ai-driven-recorder/` | 渐进映射到设计／覆盖／绑定入口，保留历史标识 |
| `client/shared/testing/StepList.tsx` | legacy 编辑保留；V2 编辑不得直接更改已发布操作和审批 |

### 17.2 建议目标目录

以下为计划新建，不表示已存在；实际文件可以按同责合并，避免单次传递层：

```text
shared/testing/
  contracts/       base, input, design, binding, executable, results, jobs, schemas
  planning/        conditions, coverage, impact
  compiler/        compile, validate, legacy-import
  runtime/         variables, predicate, run-case, run-bundle, types
  adapters/        playwright-ui, http-api
server/modules/
  source-assets/   intake, snapshots, indexer, ts-js, retrieval, repository, router
  test-design/     proposal, revisions, approvals, repository, router
  test-authoring/  binding, profiles, fixtures, calibration, controller, router
  test-artifacts/  compile, publication, export, repository, router
  work-jobs/       repository, worker, events, outbox, recovery, router
agent/
  binding-control.ts
  execution-control.ts
client/features/
  source-assets/
  test-design/
  test-authoring/
```

V2 runtime 与 transport 不 import server repository，Agent 不需要打包作者 Provider 才能回放。索引器与模型也不放入 runtime exports。

### 17.3 旧数据迁移

1. 只读导出清单及 hash，保存套件、步骤、断言、变量、metadata 和用户编辑。
2. 将明确机器字段转换为待审核 V2 设计／绑定；`origin=rule` 不自动变成业务批准。
3. 文本-only 预期、模板歧义、evaluate、动态数据、丢失证据等生成诊断，不能猜。
4. 双路径 shadow 比较时使用安全环境和同一数据前提；不在生产双发写操作。
5. 分项目／套件切换 artifact 指针，可回切 legacy 版本，已执行报告保持。
6. 只有所有活跃依赖已迁移、有基准验收、导出和回退证据后，才提议删除具体旧文件／接口。

新设计取代旧“只让 NL 更适合 Stagehand”的目标。历史 docs/06／07／08 和相关 specs 保留为历史依据，不直接覆盖；正式采用后新增 ADR 说明哪些决策被取代，尤其强制录制、首词动作、独立断言和确认信任来源。

## 18. 质量验证与验收

### 18.1 验证层次

虽然不生成 AUT 单元／组件测试，QuantumQA 自身仍必须有单元、契约、集成与 UI 测试，这不违反 G18。

- 纯契约／Compiler：正确类型、empty／missing、引用、unsupported、时序、稳定 hash、覆盖义务不消失。
- Adapter 行为：真实隔离 DOM／HTTP fixture，不只 fake engine。
- 持久化／jobs：独立 SQLite 临时库、事务冲突、lease、重启、迟到消息、取消和 outbox。
- 人审流程：刷新恢复、冲突编辑、过期审批、版本和缺口展示。
- AUT 闭环：需求→设计→绑定→编译→校准→发布→无模型回放。

### 18.2 必测失败类别

1. 错误 AUT 仍保留业务期望，绝不编译成当前实际值。
2. 提交后状态不被挪到提交前；错误提示不绑定提交按钮。
3. disabled／checked／hidden／count、空值、false／0／null／missing 正确区分。
4. 预期 400／401／404 的负面 API 合法；网络超时不能伪装该状态。
5. collect 失败仍判 verdict failed，未执行不计覆盖。
6. 多匹配、缺失、frame／window、动态渲染均有可预期语义。
7. no-request 观察必须提前启动，窗口之外不乱算。
8. 部分录制、解析超限、未知规则、预算耗尽不被发布。
9. 源码与部署版本不符、条件目标当时未出现不会静默改变预期。
10. 校准重启、编辑并发、迟到 attempt 不覆盖新版本。
11. prepare／cleanup 失败、共享数据和非幂等写操作不能盲目重试。
12. 导出 runner 无 LLM 依赖、provider secret 和模型请求。

### 18.3 受控 AUT 与三轴验证

复用 `aut/requirements/AUT-Demo-Requirements-v1.0.md`／`v1.1.md`、`aut/client/LoginPage.tsx`、`aut/server/routes.ts`，但这些需求是从代码反推，先由独立负责人审定预期。

已有 `/aut-api/test/reset` 只在明确隔离授权下使用；角色／时间仍随机，不能把 reset 当作完全固定 seed。固定数量条件、可查询 fixture 真值和随机部分分别处理，避免同一错误接口同时成为期望和被检查结果。

实验三轴：

- 正确 AUT：冻结产物，多次独立前提回放，检查误报和有效谓词。
- 已知缺陷 AUT：在授权的隔离副本注入并独立确认 bug，用同一包检验目标谓词是否失败。
- 缺陷 AUT 作者期：生成／绑定时不删除／改写预期；无法绑定也应保留完整设计及缺口。

建议首轮 15–20 个审定条件，一轮作者生成、代表用例各 5 次隔离回放；这是控制试点规模，不构成统计准确率或置信度保证。预算及真实样本在实施前确认。

### 18.4 公平比较与退出门

保留 A 默认、A 开编译的真实基线；B／C／D 在相同批准需求、资产、模型、预算、审核与修复后的共享执行器上比较。公共执行器修复的收益单独记录，不都算到新生成方案名下。

上线硬门：G01–G18 在目标能力切片内都有行为证据；有完整版本／审批／覆盖链；错误 AUT 不导致预期削弱；关键已知缺陷被相关业务谓词检出；未支持部分透明列出；导出回放模型请求=0；刷新／重启不丢状态；旧数据可回退。

性能／质量百分比在实测后设项目目标。不得提前承诺 100% 需求理解、95% 成功率、固定费用或全语言自动化。

### 18.5 贯穿示例：错误密码不能登录

以下是假设已被业务批准的示例，用于说明契约；不是本次对真实 AUT 的验证结果。

批准规则：错误密码必须被拒绝；API 返回 401 和明确错误；UI 显示错误、不离开登录页，并保留用户名。

| 阶段 | 示例产物 | 不能做什么 |
|---|---|---|
| 条件基线 | `C-api-reject`、`C-ui-error`、`C-ui-stay`、`C-ui-preserve-user` 四项义务 | 一个正常登录 case 不能覆盖全部登录需求 |
| 源码资产 | 登录页、用户名／密码／按钮／错误区域定位，POST 登录路由和响应字段 | 源码若错误地返回 200，不能把需求 401 改成 200 |
| API 设计 | 请求 admin＋wrong-password；对 responseRef 断言 status eq 数字 401、`$.error` eq 批准错误文本 | 不能把接收到 HTTP 401 直接标 transport／case 失败 |
| UI 设计 | 填用户名／错误密码→提交→检查错误、完整 loginUrl、提交后的用户名值 | 保留用户名的断言不能移到 submit 前；错误文字不能绑定 submit 按钮 |
| Binding | 源码定位＋正确场景运行证据；错误区域条件渲染时可审核 source-conditional | 错误 AUT 未渲染错误区时不能删除 C-ui-error |
| 编译 | 分开的动作和 PredicateSpec，明确 ValueRef、responseRef、targetId、顺序、profile | 不从录制实际响应／页面状态重算预期 |
| 正确 AUT 回放 | response=401，UI 相关谓词成立；completion=completed、verdict=passed | 不把四项义务的有效性简化成一个“操作完成” |
| 缺陷 AUT 回放 | response=200 或 UI 跳转／清空用户名；对应谓词 failed，包内 expected 不变 | collect 可以继续收集，但最终 verdict 不能 passed |

API 和 UI 用例共用需求来源，但分别覆盖所需渠道。只有 API 拒绝成立不能算 UI 提示已覆盖；实际未执行的 UI 谓词仍是执行覆盖缺口。

这个例子的阶段信息、审批和最终断言都要能从报告回溯，不需要模型在运行时重新解释“不能登录”。

## 19. 里程碑、风险与待确认事项

### 19.1 路线图

| 阶段 | 交付 | 阶段退出门 |
|---|---|---|
| M0：保护与基线 | legacy 关键行为回归、兼容清单、数据清单 | 不再以部分成功／soft 假绿／错误 API 区间掩盖结果 |
| M1：V2 纵向骨架 | 契约、不可变 revision、typed runtime、strict Adapter、导出 | 人工设计的 UI／API 用例可无模型可靠回放 |
| M2：持久作者作业 | jobs、profile、fixture、校准副本、审批／发布 | 重启／刷新／并发／取消有可验证语义 |
| M3：源码与设计 | TS／JS 资产、条件基线、预算化提案、编译 | 登录＋CRUD 切片从输入到完整 artifact，缺口不隐藏 |
| M4：辅助绑定与产品 | 浏览器证据、受限 AI 补缺、工作台、覆盖 | 陌生控件可补绑定，不改变批准预期 |
| M5：评估与迁移 | 三轴实验、成本比较、legacy 迁移／回退 | 用有效缺陷检出和实际成本证明价值后扩大范围 |
| M6：增量与扩展 | 影响分析、新框架／控件能力、部署扩容 | 每项能力独立行为测试；只有真实需求才引入新基础设施 |

阶段可并行设计，但不能跳过顺序依赖或第一切片证明。不要先改完所有 UI，再发现核心语义仍不成立。

### 19.2 主要风险

- 源码与部署不一致：冻结版本映射、显示不确定性，不无声自愈。
- 没有独立需求预期：先修输入与审批，不用更多模型掩盖。
- 静态解析能力被过度宣传：公开 Adapter 覆盖，保留 unsupported 与人工路径。
- 异步／条件目标验证困难：明确观察能力、源条件绑定与正确场景校准。
- 数据隔离缺失：先做 fixture，不在共享环境追求并发。
- 大重构失去旧用例：保留 legacy、shadow、hash 清单与回切。
- 双状态机失配：durable job 权威，LangGraph 是执行机制而非第二真源。
- 发布门过度要求全绿：保留业务失败与缺陷批准路径，不删断言。
- 成本转移到人工审核：统计修订／维护，不只减少 token。

### 19.3 实施前必须核实

1. 真实目标源码语言、框架、规模、读取许可与版本定位。
2. 需求质量、AC 责任人、未知规则和排除批准方式。
3. 运行地址、网络位置、Agent、角色账号和部署 commit 可核实方式。
4. 允许的数据副作用、prepare／cleanup、专用测试环境及外部依赖。
5. 单实例／多实例、并发、持久卷、备份、恢复和保留要求。
6. 模型出网、文件／截图权限、实际预算及人工修订成本。
7. 首批必须支持的 UI 动作和 API 格式；其他部分的手工／unsupported 政策。

这些未知项不阻止用本蓝图讨论方向，但阻止将默认假设直接变成生产实施事实。

## 20. 最终决策及实施检查表

**保留需求管理、NL 审核体验、Provider、报告、Agent 和经过验证的执行工具；大改语义契约、作者主链、结果模型、发布／持久任务。**

**源码提供地图，不提供业务标准答案。录制提供证据，不决定预期。Compiler 保证明确表达，Runtime 保证按冻结表达执行；测试是否业务充分，由批准条件与缺陷验证证明。**

- [ ] 用户批准 UI／API 范围及首个目标技术组合。
- [ ] 需求、设计、绑定、校准、发布的责任人与独立状态明确。
- [ ] G01–G18 全部映射到实现任务与行为测试。
- [ ] 当前功能、设计提案和未验证事实不混写。
- [ ] 先实现一个无模型的人工设计纵向切片，再接源码／模型。
- [ ] 先修执行语义和数据隔离，再扩大自动生成／并发。
- [ ] 旧数据保留、迁移诊断、回退和退役门明确。
- [ ] 正确 AUT／已知缺陷／错误 AUT 作者期三轴验证获授权。
- [ ] 无额外模型、真实业务执行、安装依赖或提交推送被文档隐式授权。

### 官方依据和适用边界

- [ISTQB CTFL v4.0.1](https://istqb.org/?sdm_process_download=1&download_id=3345)：追溯、测试技术与层级；不背书固定 Agent 数、每动作一断言或两次通过认证。
- [Playwright 1.58.2 actionability](https://raw.githubusercontent.com/microsoft/playwright/v1.58.2/docs/src/actionability.md)：严格定位、可操作性和重试断言。
- [Stagehand act](https://docs.stagehand.dev/v3/basics/act)：作者期动作／观察，返回 ActResult；缓存不替代业务预期。
- [OpenAI Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)、[Zod JSON Schema](https://zod.dev/json-schema)：结构保证不等于答案正确。
- [LangGraph checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)、[interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)：状态与人审，不自动解决所有外部副作用。
- [better-sqlite3 12.8.0 编译说明](https://raw.githubusercontent.com/WiseLibs/better-sqlite3/v12.8.0/docs/compilation.md)：默认 SQLite 3.51.3 不是本机实测结果。
- [Node 官方发布计划](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json)：运行版本选择需结合原生依赖验证。

本蓝图不宣称标准认证、源码完整解析或生产闭环已被验证。
