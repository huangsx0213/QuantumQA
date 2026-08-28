/**
 * 统一测试标准 · 词表与映射表（docs/08）
 *
 * 四层共享的"普通话"：AI Test Gen 按词表生成 NlStepIntent，
 * Recorder 按映射表消费，落盘到 Test Design 执行关键字。
 *
 * 一致性铁律：词表常量、VERB_TO_EXECUTION 映射表、执行引擎 switch
 * 三处以单测锁死（shared/recording/__tests__/nl-intent.test.ts）；
 * 映射完备性以 StepList 动作下拉（42 项）为基准。
 * 新增关键字必须三处同改。
 */
import { z } from 'zod';

// === 执行关键字基准（StepList 动作下拉全量 42 项） ===

/** 排除项：AI 不生成（附理由见 docs/08 §2.1-I），人工可用 */
export const EXCLUDED_EXECUTION_KEYWORDS = ['highlight', 'evaluate'] as const;

/** 预留项：词表已定，生成端暂拒（依赖后续里程碑解锁） */
export const RESERVED_EXECUTION_KEYWORDS = ['runModule', 'apiGet', 'apiPost', 'apiPut', 'apiDelete'] as const;

/** 生成可用动词映射到的执行关键字全集（42 - 排除2 - 预留5 = 35） */
export const GENERATABLE_EXECUTION_KEYWORDS = [
  'goto', 'click', 'dblclick', 'rightClick', 'fill', 'clear', 'hover',
  'scrollIntoView', 'selectOption', 'check', 'uncheck', 'toggle', 'dragTo',
  'setInputFiles', 'press',
  'assertVisible', 'assertInvisible', 'assertNotExist', 'assertAttribute',
  'assertText', 'assertValue', 'assertUrl', 'assertTitle',
  'assertDisabled', 'assertEnabled', 'assertChecked', 'assertUnchecked',
  'switchToWindow', 'switchToFrame', 'acceptDialog', 'dismissDialog',
  'waitForTimeout', 'waitForVisible', 'waitForHidden', 'extractVar',
] as const;

/** 执行关键字全集（完备性基准） */
export const ALL_EXECUTION_KEYWORDS = [
  ...GENERATABLE_EXECUTION_KEYWORDS,
  ...RESERVED_EXECUTION_KEYWORDS,
  ...EXCLUDED_EXECUTION_KEYWORDS,
] as const;

export type ExecutionKeyword = (typeof ALL_EXECUTION_KEYWORDS)[number];

// === 动作词表（ActionVerb） ===

/** 生成可用动词（20 个） */
export const GENERATABLE_ACTION_VERBS = [
  'navigate', 'fill', 'clear', 'select', 'press',
  'click', 'doubleClick', 'rightClick', 'hover', 'drag', 'toggle',
  'check', 'uncheck', 'upload',
  'scroll', 'switchTo', 'dialog',
  'waitFor', 'verify', 'extract',
] as const;

/** 预留动词（词表已定，生成端暂拒） */
export const RESERVED_ACTION_VERBS = ['api', 'runModule'] as const;

/** 动作词表全集（22 个） */
export const ALL_ACTION_VERBS = [...GENERATABLE_ACTION_VERBS, ...RESERVED_ACTION_VERBS] as const;

export type ActionVerb = (typeof ALL_ACTION_VERBS)[number];
export type GeneratableActionVerb = (typeof GENERATABLE_ACTION_VERBS)[number];

// === 动词职责分类（docs/08 §2.1：操作 vs 校验，不能混用） ===

/** Web 操作类：真实 DOM 交互（用户点/填/选/拖/传…） */
export const ACTION_WEB_VERBS = [
  'navigate', 'fill', 'clear', 'select', 'press',
  'click', 'doubleClick', 'rightClick', 'hover', 'drag', 'toggle',
  'check', 'uncheck', 'upload',
  'scroll', 'switchTo', 'dialog',
] as const;

/** 等待类：非操作非校验，等待元素/网络/时间 */
export const ACTION_WAIT_VERBS = ['waitFor'] as const;

/** 校验类：纯断言，零 DOM 操作——只检查已发生的状态 */
export const ACTION_VERIFY_VERBS = ['verify'] as const;

/** 数据提取类：从页面取值 */
export const ACTION_EXTRACT_VERBS = ['extract'] as const;

/** 动词 → 职责类别（供 prompt/校验复用） */
export type ActionVerbCategory = 'web' | 'wait' | 'verify' | 'extract';

export function categorizeActionVerb(verb: ActionVerb): ActionVerbCategory {
  const g = verb as GeneratableActionVerb;
  if ((ACTION_WEB_VERBS as readonly string[]).includes(g)) return 'web';
  if ((ACTION_WAIT_VERBS as readonly string[]).includes(g)) return 'wait';
  if ((ACTION_VERIFY_VERBS as readonly string[]).includes(g)) return 'verify';
  if ((ACTION_EXTRACT_VERBS as readonly string[]).includes(g)) return 'extract';
  return 'web';
}

// === 期望分类（ExpectationKind） ===

export const ALL_EXPECTATION_KINDS = [
  'url', 'title', 'text-visible', 'element-visible', 'element-hidden',
  'value', 'element-state', 'attribute', 'network',
  'api-body',                       // U5: 响应体 JSON 断言（API_BODY_JSON + JSONPath expression）
  'transient',     // 不可断言——生成期即拒绝
] as const;

export type ExpectationKind = (typeof ALL_EXPECTATION_KINDS)[number];

/** 可断言期望分类（transient 永拒；api-body 已解锁——U5） */
export const ASSERTABLE_EXPECTATION_KINDS = [
  'url', 'title', 'text-visible', 'element-visible', 'element-hidden',
  'value', 'element-state', 'attribute', 'network', 'api-body',
] as const;

// === 映射表：生成动词 → 执行关键字 ===

export const VERB_TO_EXECUTION: Record<ActionVerb, readonly string[]> = {
  navigate: ['goto'],
  fill: ['fill'],
  clear: ['clear'],
  select: ['selectOption'],
  press: ['press'],
  click: ['click'],
  doubleClick: ['dblclick'],
  rightClick: ['rightClick'],
  hover: ['hover'],
  drag: ['dragTo'],
  toggle: ['toggle'],
  check: ['check'],
  uncheck: ['uncheck'],
  upload: ['setInputFiles'],
  scroll: ['scrollIntoView'],
  switchTo: ['switchToWindow', 'switchToFrame'],
  dialog: ['acceptDialog', 'dismissDialog'],
  waitFor: ['waitForVisible', 'waitForHidden', 'waitForTimeout'],
  verify: [
    'assertVisible', 'assertInvisible', 'assertNotExist', 'assertAttribute',
    'assertText', 'assertValue', 'assertUrl', 'assertTitle',
    'assertEnabled', 'assertDisabled', 'assertChecked', 'assertUnchecked',
  ],
  extract: ['extractVar'],
  api: ['apiGet', 'apiPost', 'apiPut', 'apiDelete'],
  runModule: ['runModule'],
};

// === 映射表：期望分类 → 断言 source 与 verify 落盘动作 ===

export interface ExpectationMapping {
  /** StepAssertion.source 取值（network 类为空——走 waitForNetwork 配置） */
  sources: readonly string[];
  /** verify 步骤落盘的执行关键字 */
  verifyActions: readonly string[];
}

export const EXPECTATION_MAPPING: Record<ExpectationKind, ExpectationMapping> = {
  url: { sources: ['UI_PAGE_URL'], verifyActions: ['assertUrl'] },
  title: { sources: ['UI_PAGE_TITLE'], verifyActions: ['assertTitle'] },
  'text-visible': { sources: ['UI_TEXT'], verifyActions: ['assertText'] },
  'element-visible': { sources: ['UI_ELEMENT_VISIBLE'], verifyActions: ['assertVisible'] },
  'element-hidden': { sources: ['UI_ELEMENT_VISIBLE', 'UI_ELEMENT_COUNT'], verifyActions: ['assertInvisible', 'assertNotExist'] },
  value: { sources: ['UI_VALUE'], verifyActions: ['assertValue'] },
  'element-state': {
    sources: ['UI_ELEMENT_ENABLED', 'UI_ELEMENT_CHECKED'],
    verifyActions: ['assertEnabled', 'assertDisabled', 'assertChecked', 'assertUnchecked'],
  },
  attribute: { sources: ['UI_ATTRIBUTE'], verifyActions: ['assertAttribute'] },
  network: { sources: [], verifyActions: [] },
  'api-body': { sources: ['API_BODY_JSON'], verifyActions: [] }, // U5: 响应体断言，expression=JSONPath
  transient: { sources: [], verifyActions: [] },
};

// === 辅助判定 ===

export function isGeneratableActionVerb(verb: string): verb is GeneratableActionVerb {
  return (GENERATABLE_ACTION_VERBS as readonly string[]).includes(verb);
}

/** transient 永拒；api-body 已解锁（U5） */
export function isGeneratableExpectation(kind: string): boolean {
  return kind !== 'transient' && (ALL_EXPECTATION_KINDS as readonly string[]).includes(kind);
}

export function getVerbExecutionActions(verb: ActionVerb): readonly string[] {
  return VERB_TO_EXECUTION[verb] ?? [];
}

export function getExpectationMapping(kind: ExpectationKind): ExpectationMapping {
  return EXPECTATION_MAPPING[kind] ?? { sources: [], verifyActions: [] };
}

/**
 * 解析 intent.data 的 testData 引用（docs/08 §2.3 扩展）：
 *   - `${key}` 模板 → testData[key]
 *   - 裸键名精确匹配 testData → testData[key]（生成端常直接写键名）
 *   - 其余原样返回（字面值）
 */
export function resolveIntentData(raw: string | undefined, params: Record<string, string>): string | undefined {
  if (raw == null || raw === '') return raw;
  const templated = /^\$\{([^}]+)\}$/.exec(raw.trim());
  if (templated && params[templated[1]] != null) return params[templated[1]];
  if (params[raw] != null) return params[raw];
  // 模板内嵌（如 "prefix-${key}"）
  return raw.replace(/\$\{([^}]+)\}/g, (m, k) => (params[k] != null ? params[k] : m));
}

// === 步骤意图契约（NlStepIntent） ===

export const actionVerbSchema = z.enum(ALL_ACTION_VERBS as unknown as [string, ...string[]]);
export const generatableActionVerbSchema = z.enum(GENERATABLE_ACTION_VERBS as unknown as [string, ...string[]]);
export const expectationKindSchema = z.enum(ALL_EXPECTATION_KINDS as unknown as [string, ...string[]]);

/**
 * 从 action 文本解析动作类型（docs/08：action 首词即词表动词）。
 * 归一化：小写 + 去空格/连字符/标点；
 * 支持驼峰/空格两种写法（waitFor / wait for）与中文目标描述。
 */
export function parseActionVerb(action: string): GeneratableActionVerb | null {
  const head = String(action ?? '').trim().toLowerCase();
  if (!head) return null;
  // 全句归一（去空格/连字符/标点/中文）："wait for the response" / "waitFor..." 均 → waitfortheresponse。
  // 词表动词逐个归一后做前缀匹配，兼容驼峰（waitFor）与空格（wait for）两种写法。
  const norm = head.replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  if (!norm) return null;
  const candidates = [...GENERATABLE_ACTION_VERBS].sort((a, b) => b.length - a.length);
  return candidates.find(v => norm.startsWith(v.toLowerCase().replace(/[^a-z0-9]/g, ''))) ?? null;
}

export const nlStepIntentSchema = z.object({
  /** 目标元素语义描述（"用户名输入框"），供录制器定位与断言依托 */
  targetHint: z.string().min(1).max(200).optional(),
  /** 动作数据：输入值 / URL / 键名 / 文件路径 / 选项值 / accept|dismiss */
  data: z.string().max(500).optional(),
  expectation: z
    .object({
      kind: expectationKindSchema,
      /** 期望值（URL 片段/文本/输入值/状态名/状态码…） */
      value: z.string().max(500).optional(),
      /** attribute 类：属性名 */
      expression: z.string().max(200).optional(),
      /** network 类：请求方法 */
      method: z.string().max(20).optional(),
      /** network 类：URL 模式 */
      urlPattern: z.string().max(300).optional(),
    })
    .optional(),
});

export interface NlStepIntent {
  targetHint?: string;
  data?: string;
  expectation?: {
    kind: ExpectationKind;
    value?: string;
    expression?: string;
    method?: string;
    urlPattern?: string;
  };
}

// === 生成级校验（AI Test Gen 质量门，docs/08 §3.1） ===

const ELEMENT_STATE_VALUES = ['enabled', 'disabled', 'checked', 'unchecked'] as const;

export interface IntentContractIssue {
  message: string;
}

/**
 * 生成端可出牌的步骤契约校验：动作类型由 action 首词解析（parseActionVerb），
 * 与 intent 的 data/expectation 交叉校验。designer 与 recorder 两端复用同一实现，门规永不漂移。
 * 返回违规消息列表；空数组即合法。
 */
export function validateStepContract(action: string, intent: NlStepIntent | undefined): string[] {
  const issues: string[] = [];
  const verb = parseActionVerb(action);
  if (!verb) {
    issues.push(`action must start with a vocabulary verb (${GENERATABLE_ACTION_VERBS.join(', ')}), but starts with "${String(action ?? '').trim().slice(0, 40)}".`);
    return issues;
  }

  const exp = intent?.expectation;
  if (exp) {
    if (!isGeneratableExpectation(exp.kind)) {
      issues.push(
        exp.kind === 'transient'
          ? `expectation.kind "transient" (loading states, animations, focus) is NOT assertable — rewrite the expectation as an observable end state (e.g. element-visible / text-visible / url).`
          : `expectation.kind "${exp.kind}" is reserved and not yet generatable.`,
      );
    }
    if (exp.kind === 'element-state' && !ELEMENT_STATE_VALUES.includes((exp.value ?? '') as any)) {
      issues.push(`expectation.value for element-state must be one of: ${ELEMENT_STATE_VALUES.join(', ')}. Got "${exp.value ?? ''}".`);
    }
  }

  if ((verb === 'verify' || verb === 'waitFor') && !exp) {
    issues.push(`action "${verb}" produces no DOM action — it MUST carry expectation (otherwise the step has nothing to verify and will vanish from the draft suite).`);
  }

  const dataRequired: readonly string[] = ['fill', 'select', 'navigate', 'upload', 'press'];
  if (dataRequired.includes(verb) && !intent?.data) {
    issues.push(`action "${verb}" requires intent.data (input value / URL / key name / file path).`);
  }

  if (verb === 'navigate' && intent?.data && /\s/.test(intent.data.trim())) {
    issues.push(`intent.data for navigate must be a URL or app-relative path without spaces (e.g. "https://app.example.com/login" or "/login"). Got "${intent.data}".`);
  }

  if (verb === 'dialog' && intent?.data && !['accept', 'dismiss'].includes(intent.data)) {
    issues.push(`intent.data for dialog must be "accept" or "dismiss". Got "${intent.data}".`);
  }

  return issues;
}

/**
 * 生成级 intent schema（结构层）：不校验动作——动作自 action 文本解析，
 * 业务门由 validateStepContract 承担（需 action+intent 交叉）。
 */
export const generatableIntentSchema = nlStepIntentSchema;
