# 08 · 统一测试设计标准 —— 需求到自动用例的全链路词表

> 状态：设计定稿，分阶段实施
> 关联：[07-nl-to-suite-conversion-pipeline.md](07-nl-to-suite-conversion-pipeline.md)、[06-ai-test-generation-strategy.md](06-ai-test-generation-strategy.md)
> 域词汇表：[CONTEXT.md](../CONTEXT.md)
>
> **词表基准**：以 Test Design 执行面的**全量 42 个关键字**为准（StepList 动作下拉 = 执行引擎 switch = 本词表映射目标），确保功能零缺失。

---

## 1. 目标与问题

**终极目标**：需求 → AI Test Gen（NL 用例）→ AI Recorder（结构化录制）→ **落盘测试设计**，全链路自动化。测试设计自动化，最终产物就是 Test Builder 里的确定性用例。

**现状断点**：四层之间只有自由文本这一种"普通话"。

```
NlTestCaseStep = { sequence, action: string, expected: string }   ← 全靠猜
```

| 断点 | 实测后果（Happy Path 案例） |
|---|---|
| Test Gen 不知道录制器**能录什么** | 生成"Query the session store"→ 无 DOM 动作可录 → 步骤在 Draft 里消失，期望丢失 |
| Test Gen 不知道什么**可断言** | 生成"button enters a disabled loading state"（瞬时态）→ 验证必败 → 无断言 |
| 期望是 API 级（"HTTP 200 + token"） | UI 断言体系无法表达 → 只能靠 waitForNetwork 兜一半 |
| Recorder 拿到自由文本要先**猜意图** | Stagehand act() 猜错目标/方式的成本全部转嫁到录制质量 |

**方案核心**：定义**共享词表**（生成动词 + 期望分类 + 全量映射表），四层各自消费同一份定义。前端（Test Gen）按词表生成，后端（Recorder/Confirm/落盘）按词表执行——**解析和猜测变成查表**。

---

## 2. 统一词表

### 2.0 三层结构

```
生成动词 (ActionVerb, Test Gen 使用)
    │  确定性映射（查表）
    ▼
执行关键字 (case_steps.action, Test Design 全量 42 个)
    │  期望分类 (ExpectationKind) → 断言 source/动作
    ▼
StepAssertion / waitForNetwork（断言面）
```

**一致性铁律**：词表常量、映射表、执行引擎 switch 三处以单测锁死——新增关键字必须三处同改。

### 2.1 生成动词 → 执行关键字 全量映射表

**状态图例**：✅ 生成可用 ｜ 🔶 预留（词表已定，生成端暂拒） ｜ ⛔ 排除（附理由）

#### A. 导航与输入

| ActionVerb | 执行关键字 | 说明 | 状态 |
|---|---|---|---|
| `navigate` | `goto`（别名 `navigate`/`pageLoad`） | data 必填合法 URL | ✅ |
| `fill` | `fill` | data 必填输入值 | ✅ |
| `clear` | `clear` | 清空输入框 | ✅ |
| `select` | `selectOption` | data=选项值 | ✅ |
| `press` | `press` | data=键名（Enter/Tab…） | ✅ |

#### B. 指针与手势

| ActionVerb | 执行关键字 | 说明 | 状态 |
|---|---|---|---|
| `click` | `click` | 主交互 | ✅ |
| `doubleClick` | `dblclick` | | ✅ |
| `rightClick` | `rightClick` | | ✅ |
| `hover` | `hover` | | ✅ |
| `drag` | `dragTo` | targetHint 需含源+目标 | ✅ |
| `toggle` | `toggle` | 开关类控件 | ✅ |

#### C. 复选与文件

| ActionVerb | 执行关键字 | 说明 | 状态 |
|---|---|---|---|
| `check` | `check` | | ✅ |
| `uncheck` | `uncheck` | | ✅ |
| `upload` | `setInputFiles` | data=文件路径/变量 | ✅ |

#### D. 页面与视图

| ActionVerb | 执行关键字 | 说明 | 状态 |
|---|---|---|---|
| `scroll` | `scrollIntoView` | targetHint=目标元素 | ✅ |
| `switchTo` | `switchToWindow` / `switchToFrame` | targetHint 区分窗口/iframe | ✅ |
| `dialog` | `acceptDialog` / `dismissDialog` | data=accept 或 dismiss | ✅ |

#### E. 等待

| ActionVerb | 执行关键字 | 说明 | 状态 |
|---|---|---|---|
| `waitFor` | `waitForVisible` / `waitForHidden` / `waitForTimeout` | expectation.kind 区分；network → waitForNetwork 配置 | ✅ |

#### F. 验证（断言-only 步骤，无 DOM 操作）

| ActionVerb | 执行关键字（由 ExpectationKind 决定） | 状态 |
|---|---|---|
| `verify` | 见 §2.2 映射 | ✅ |

#### G. 数据

| ActionVerb | 执行关键字 | 说明 | 状态 |
|---|---|---|---|
| `extract` | `extractVar` | 从页面取值存变量（data=变量名） | ✅ |

#### H. API

| ActionVerb | 执行关键字 | 说明 | 状态 |
|---|---|---|---|
| `api` | `apiGet` / `apiPost` / `apiPut` / `apiDelete` | intent.data/method 区分；依赖 U5（api-body 期望） | 🔶 预留 |
| `runModule` | `runModule` | 模块复用，需模块选择交互 | 🔶 预留 |

#### I. 排除项（AI 不生成，人工可用）

| 执行关键字 | 排除理由 |
|---|---|
| `highlight` | 调试辅助，无测试语义 |
| `evaluate` | 原生 JS 注入——安全边界，AI 不生成代码 |
| `getby*` 系列 | 元素定位策略而非动作，由 targetHint→locator 链路承担 |
| `navigate`/`pageLoad` 别名 | 规范词为 `goto`，映射层兼容 |

### 2.2 期望分类（ExpectationKind）→ 断言面映射

| ExpectationKind | 含义 | StepAssertion source | verify 落盘动作 |
|---|---|---|---|
| `url` | 落点 URL | `UI_PAGE_URL` | `assertUrl` |
| `title` | 页面标题 | `UI_PAGE_TITLE` | `assertTitle` |
| `text-visible` | 页面出现文本 | `UI_TEXT` | `assertText` |
| `element-visible` | 元素可见 | `UI_ELEMENT_VISIBLE` | `assertVisible` |
| `element-hidden` | 元素不可见/不存在 | `UI_ELEMENT_VISIBLE`(false)/COUNT(0) | `assertInvisible` / `assertNotExist` |
| `value` | 输入框值 | `UI_VALUE` | `assertValue` |
| `element-state` | 启用/禁用/勾选/未勾选（value 四选一） | `UI_ELEMENT_ENABLED` / `UI_ELEMENT_CHECKED` | `assertEnabled`/`assertDisabled`/`assertChecked`/`assertUnchecked` |
| `attribute` | 元素属性值（expression=属性名） | `UI_ATTRIBUTE` | `assertAttribute` |
| `network` | 请求状态（method+urlPattern+status） | `waitForNetwork` | （配置型，非断言动作） |
| `api-body` | 响应体内容（JSONPath） | `API_BODY_JSON` | 预留（U5） |
| `transient` | 瞬时态（loading/动画/获焦） | **不可断言——生成期即拒绝** | — |

### 2.3 步骤意图契约（NlStepIntent）

```ts
type ActionVerb =
  | 'navigate' | 'fill' | 'clear' | 'select' | 'press'
  | 'click' | 'doubleClick' | 'rightClick' | 'hover' | 'drag' | 'toggle'
  | 'check' | 'uncheck' | 'upload'
  | 'scroll' | 'switchTo' | 'dialog'
  | 'waitFor' | 'verify' | 'extract'
  | 'api' | 'runModule';            // 🔶 预留：生成端暂拒

type ExpectationKind =
  | 'url' | 'title' | 'text-visible' | 'element-visible' | 'element-hidden'
  | 'value' | 'element-state' | 'attribute' | 'network'
  | 'api-body'                       // 🔶 预留
  | 'transient';                     // 生成期即拒绝

interface NlStepIntent {
  actionType: ActionVerb;
  /** 目标元素语义描述（"用户名输入框"），供录制器定位与断言依托 */
  targetHint?: string;
  /** 动作数据：输入值 / URL / 键名 / 文件路径 / 选项值 / accept|dismiss */
  data?: string;
  expectation?: {
    kind: ExpectationKind;
    /** 期望值（URL 片段/文本/输入值/状态名/状态码…） */
    value?: string;
    /** attribute 类：属性名；network 类附加： */
    expression?: string;
    method?: string;
    urlPattern?: string;
  };
}
```

**兼容原则**：`action`/`expected` 自由文本保留（人类可读性不动摇），`intent` 为可选字段。Recorder 优先消费 `intent`，缺省时回退现有推断链路——新旧 NL 用例都能跑。

---

## 3. 各层改造点

### 3.1 AI Test Gen（生成端按词表出牌）

- `DesignerRuntimeSchema` 的 steps 增加 `intent` 字段（zod 强约束，枚举校验）
- **新增质量门**（quality.ts / designer.ts superRefine）：
  - `actionType` 必须在生成可用词表内（🔶 预留项生成期即拒）
  - `expectation.kind = 'transient'` → **直接拒绝**，要求改写为可观测终态
  - `verify`/`waitFor` 类步骤必须带 `expectation`（否则该步骤无意义）
  - `fill`/`select` 的 `data` 必填；`navigate` 的 `data` 必须是合法 URL；`upload` 的 `data` 必填
  - `element-state` 的 `expectation.value` ∈ {enabled, disabled, checked, unchecked}
- Prompt 注入词表说明与正反例（复用 06 号文档的 prompt 模式）

### 3.2 AI Recorder（消费意图，停止猜测）

- `executeNlStep` 分派策略：
  - `click/fill/select/check/uncheck/press/hover/doubleClick/rightClick/drag/toggle/upload/clear` → 现有 act() 链路（不变）
  - `navigate` → 直接 page.goto(intent.data)，不经过 Stagehand act（省一次 LLM 调用且确定性）
  - `waitFor` + kind=`network` → `page.waitForResponse(urlPattern)` 后继续
  - `dialog`/`switchTo`/`scroll` → act + 录制（payload 动作映射已有）
  - `verify` → 跳过 act，直接进入取证+编译
- `compileAssertions`：有 `intent.expectation.kind` 时**查 §2.2 映射表定 source**（零猜测），AI 裁决仅在"kind 对应证据不足"时兜底；无 intent 时走现有推断链路
- `verify`/`waitFor`/`extract` 步骤落盘为**断言-only/配置步骤**（不再从 Draft 消失）

### 3.3 Confirm / Emit（不变）

07 号方案的确认运行与三态落盘逻辑与词表正交，无需改动。收益自动兑现：期望分类正确 → 提议质量提高 → 确认通过率提高。

### 3.4 测试设计落盘（确定性映射）

`ActionVerb → case_steps.action` 即 §2.1 映射表——**落盘即合法**，Test Builder 打开就能跑；反向（人工在 Test Builder 用的任何关键字）都能在词表找到生成来源或明确排除理由，功能零缺失。

---

## 4. 实施里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| U1 | shared 契约：`NlStepIntent` 类型 + zod schema + **词表常量与全量映射表**（含三处一致性单测） | 单测：schema 校验全分支；映射表覆盖执行面 42 关键字（排除项有理由） |
| U2 | Test Gen：designer schema + 质量门 + prompt 词表 | 生成样例全过新门；transient/预留项被拒 |
| U3 | Recorder 分派：navigate/waitFor/verify/dialog/switchTo 新策略 + 映射表编译 | 录制回归；verify 步骤落盘可见 |
| U4 | 端到端：需求 → NL → 录制 → 落盘全链路演示 | Happy Path 级用例断言覆盖 100%（可断言期望零丢失） |
| U5 | `api-body` 期望类 + `api` 动词解锁 | 登录 token 类期望可验证 |

U1–U2 独立可交付（生成质量立刻受益）；U3 起录制端消费；U5 独立增量。

---

## 5. 风险与边界

- **NL 用例存量兼容**：无 intent 的旧用例走现有推断链路，零破坏（已在 07 号方案 M3 验证过开关隔离模式）
- **词表膨胀控制**：新增关键字必须三处同改（词表常量、映射表、执行面 switch），以单测锁死一致——映射表以 StepList 下拉 42 项为完备性基准
- **LLM 遵从度**：intent 由 zod 强约束 + 质量门拒绝，不合规即重试/降级——与 06 号文档的结构化输出策略一致
- **人的书写习惯**：NL 用例的 action 文本仍是自然语言（人审友好），intent 是附加结构——两全而非取舍
- **排除项回归通道**：`evaluate`/`highlight`/`runModule` 若未来需要 AI 生成，须先过安全评审并补三处一致性单测
