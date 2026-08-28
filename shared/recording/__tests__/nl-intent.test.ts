import { describe, it, expect } from 'vitest';
import {
  ALL_EXECUTION_KEYWORDS,
  GENERATABLE_EXECUTION_KEYWORDS,
  RESERVED_EXECUTION_KEYWORDS,
  EXCLUDED_EXECUTION_KEYWORDS,
  ALL_ACTION_VERBS,
  GENERATABLE_ACTION_VERBS,
  ALL_EXPECTATION_KINDS,
  ASSERTABLE_EXPECTATION_KINDS,
  VERB_TO_EXECUTION,
  EXPECTATION_MAPPING,
  isGeneratableActionVerb,
  isGeneratableExpectation,
  getVerbExecutionActions,
  getExpectationMapping,
  nlStepIntentSchema,
  actionVerbSchema,
  expectationKindSchema,
  generatableIntentSchema,
  resolveIntentData,
  parseActionVerb,
  validateStepContract,
  ACTION_WEB_VERBS,
  ACTION_WAIT_VERBS,
  ACTION_VERIFY_VERBS,
  ACTION_EXTRACT_VERBS,
  categorizeActionVerb,
} from '../nl-intent';

/**
 * 三处一致性铁律（docs/08 §2.0）：
 * 词表常量 ↔ VERB_TO_EXECUTION/EXPECTATION_MAPPING 映射表 ↔ 执行引擎 switch。
 * 本文件锁定前两者的完备性；执行面基准 = StepList 动作下拉 42 项（硬编码快照）。
 * 新增关键字：三处同改 + 本快照同改。
 */

const STEPLIST_DROPDOWN_42: readonly string[] = [
  // Web Actions (16)
  'goto', 'click', 'dblclick', 'rightClick', 'fill', 'clear', 'hover', 'highlight',
  'scrollIntoView', 'selectOption', 'check', 'uncheck', 'toggle', 'dragTo', 'setInputFiles', 'press',
  // Assertions (12)
  'assertVisible', 'assertInvisible', 'assertNotExist', 'assertAttribute', 'assertText',
  'assertValue', 'assertUrl', 'assertTitle', 'assertDisabled', 'assertEnabled',
  'assertChecked', 'assertUnchecked',
  // Browser & Alert (4)
  'switchToWindow', 'switchToFrame', 'acceptDialog', 'dismissDialog',
  // Logic & Modules (6)
  'waitForTimeout', 'waitForVisible', 'waitForHidden', 'extractVar', 'evaluate', 'runModule',
  // API (4)
  'apiGet', 'apiPost', 'apiPut', 'apiDelete',
];

describe('nl-intent · 执行关键字完备性（42 基准）', () => {
  it('ALL_EXECUTION_KEYWORDS 与 StepList 下拉 42 项完全一致', () => {
    expect([...ALL_EXECUTION_KEYWORDS].sort()).toEqual([...STEPLIST_DROPDOWN_42].sort());
  });

  it('生成可用/预留/排除三类划分恰好覆盖 42 且互斥', () => {
    const all = [
      ...GENERATABLE_EXECUTION_KEYWORDS,
      ...RESERVED_EXECUTION_KEYWORDS,
      ...EXCLUDED_EXECUTION_KEYWORDS,
    ];
    expect(all.length).toBe(42);
    expect(new Set(all).size).toBe(42);
    expect(new Set(all)).toEqual(new Set(STEPLIST_DROPDOWN_42));
    expect(GENERATABLE_EXECUTION_KEYWORDS.length).toBe(35);
    expect(RESERVED_EXECUTION_KEYWORDS.length).toBe(5);
    expect(EXCLUDED_EXECUTION_KEYWORDS).toEqual(['highlight', 'evaluate']);
  });
});

describe('nl-intent · 动词映射表一致性', () => {
  it('每个动词都有非空映射，且映射目标全部是合法执行关键字', () => {
    for (const verb of ALL_ACTION_VERBS) {
      const targets = VERB_TO_EXECUTION[verb];
      expect(targets, `verb ${verb} missing from VERB_TO_EXECUTION`).toBeTruthy();
      expect(targets.length, `verb ${verb} maps to nothing`).toBeGreaterThan(0);
      for (const t of targets) {
        expect(ALL_EXECUTION_KEYWORDS, `${verb} → ${t} is not an execution keyword`).toContain(t);
      }
    }
  });

  it('生成可用动词的映射目标全部落在生成可用关键字内（预留动词除外）', () => {
    for (const verb of GENERATABLE_ACTION_VERBS) {
      for (const t of VERB_TO_EXECUTION[verb]) {
        expect(
          GENERATABLE_EXECUTION_KEYWORDS,
          `generatable verb ${verb} maps to non-generatable keyword ${t}`,
        ).toContain(t);
      }
    }
  });

  it('生成可用关键字的每一项都能由某个生成动词到达（无孤儿关键字）', () => {
    const reachable = new Set<string>();
    for (const verb of GENERATABLE_ACTION_VERBS) {
      for (const t of VERB_TO_EXECUTION[verb]) reachable.add(t);
    }
    for (const kw of GENERATABLE_EXECUTION_KEYWORDS) {
      expect(reachable, `execution keyword ${kw} unreachable by any generatable verb`).toContain(kw);
    }
  });

  it('getVerbExecutionActions 与映射表一致', () => {
    expect(getVerbExecutionActions('navigate')).toEqual(['goto']);
    expect(getVerbExecutionActions('verify')).toContain('assertUrl');
    expect(getVerbExecutionActions('api')).toContain('apiPost');
  });

  it('动词职责分类：web/verify/wait/extract 互斥且覆盖全部生成动词', () => {
    const web = ACTION_WEB_VERBS as readonly string[];
    const wait = ACTION_WAIT_VERBS as readonly string[];
    const verify = ACTION_VERIFY_VERBS as readonly string[];
    const extract = ACTION_EXTRACT_VERBS as readonly string[];
    const categories = [...web, ...wait, ...verify, ...extract];
    expect(categories.length).toBe(GENERATABLE_ACTION_VERBS.length);
    // 四类互斥
    expect(new Set(categories).size).toBe(GENERATABLE_ACTION_VERBS.length);
    // 覆盖全部生成动词
    expect(GENERATABLE_ACTION_VERBS.every(v => categories.includes(v))).toBe(true);
  });

  it('categorizeActionVerb 语义：click=navigate 属 web，verify 属校验-only，waitFor 属等待', () => {
    expect(categorizeActionVerb('click')).toBe('web');
    expect(categorizeActionVerb('fill')).toBe('web');
    expect(categorizeActionVerb('navigate')).toBe('web');
    expect(categorizeActionVerb('verify')).toBe('verify');
    expect(categorizeActionVerb('waitFor')).toBe('wait');
    expect(categorizeActionVerb('extract')).toBe('extract');
  });

  it('verify 是唯一纯校验动词（assert* 只能由 verify 表达），web 动词不映射 assert 关键字', () => {
    // 所有 assert* 执行关键字只能由 verify 到达（校验职责唯一归属）
    const assertKeywords = GENERATABLE_EXECUTION_KEYWORDS.filter(k => k.startsWith('assert'));
    expect(assertKeywords.length).toBeGreaterThan(0);
    for (const kw of assertKeywords) {
      expect(getVerbExecutionActions('verify')).toContain(kw);
    }
    // 任一 web 动词的映射目标都不得是 assert*（操作动词不校验）
    for (const verb of ACTION_WEB_VERBS) {
      const targets = getVerbExecutionActions(verb);
      expect(targets.some(t => t.startsWith('assert'))).toBe(false);
    }
  });
});

describe('nl-intent · 期望分类映射一致性', () => {
  it('每个期望分类都有映射条目', () => {
    for (const kind of ALL_EXPECTATION_KINDS) {
      expect(EXPECTATION_MAPPING[kind], `kind ${kind} missing mapping`).toBeTruthy();
    }
  });

  it('可断言分类（network/api-body 除外）都有 source 和 verify 动作，且动作合法', () => {
    for (const kind of ASSERTABLE_EXPECTATION_KINDS) {
      const m = EXPECTATION_MAPPING[kind];
      if (kind === 'network' || kind === 'api-body') {
        // network→waitForNetwork 配置型；api-body→API_BODY_JSON 断言（无 verify 动作，用 expression）
        if (kind === 'api-body') {
          expect(m.sources.length, `kind ${kind} has no assertion source`).toBeGreaterThan(0);
        }
        continue;
      }
      expect(m.sources.length, `kind ${kind} has no assertion source`).toBeGreaterThan(0);
      expect(m.verifyActions.length, `kind ${kind} has no verify action`).toBeGreaterThan(0);
      for (const a of m.verifyActions) {
        expect(GENERATABLE_EXECUTION_KEYWORDS, `${kind} → ${a} not generatable`).toContain(a);
      }
    }
  });

  it('transient 不可断言', () => {
    expect(EXPECTATION_MAPPING.transient.sources).toHaveLength(0);
    expect(EXPECTATION_MAPPING.transient.verifyActions).toHaveLength(0);
    expect(isGeneratableExpectation('transient')).toBe(false);
  });

  it('api-body 为可生成（U5 解锁），映射指向 API_BODY_JSON', () => {
    expect(isGeneratableExpectation('api-body')).toBe(true);
    expect(EXPECTATION_MAPPING['api-body'].sources).toContain('API_BODY_JSON');
  });

  it('getExpectationMapping 关键映射抽查', () => {
    expect(getExpectationMapping('url')).toEqual({ sources: ['UI_PAGE_URL'], verifyActions: ['assertUrl'] });
    expect(getExpectationMapping('element-hidden').verifyActions).toContain('assertNotExist');
    expect(getExpectationMapping('element-state').sources).toContain('UI_ELEMENT_CHECKED');
  });
});

describe('nl-intent · 辅助判定与 schema', () => {
  it('isGeneratableActionVerb 区分生成/预留/未知', () => {
    expect(isGeneratableActionVerb('click')).toBe(true);
    expect(isGeneratableActionVerb('api')).toBe(false);
    expect(isGeneratableActionVerb('noSuchVerb')).toBe(false);
  });

  it('schema 接受合法 intent（含中文 targetHint，无 actionType）', () => {
    const parsed = nlStepIntentSchema.safeParse({
      targetHint: '用户名输入框',
      data: 'admin',
      expectation: { kind: 'value', value: 'admin' },
    });
    expect(parsed.success).toBe(true);
  });

  it('parseActionVerb 从 action 首词解析动作类型（含驼峰/空格两种写法）', () => {
    expect(parseActionVerb('fill the username field')).toBe('fill');
    expect(parseActionVerb('click the button')).toBe('click');
    expect(parseActionVerb('wait for the network response')).toBe('waitFor');
    expect(parseActionVerb('waitFor the network response')).toBe('waitFor');
    expect(parseActionVerb('double click the row')).toBe('doubleClick');
    expect(parseActionVerb('确认登录成功')).toBeNull();
  });

  it('validateStepContract：navigate 接受相对路径', () => {
    expect(validateStepContract('navigate to /login', { data: '/login', expectation: { kind: 'url', value: '/login' } })).toEqual([]);
  });

  it('validateStepContract：element-state 缺 value 被拒（空串不可逃逸）', () => {
    const issues = validateStepContract('verify the toggle', { targetHint: 'toggle button', expectation: { kind: 'element-state', value: '' } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some(i => i.includes('element-state'))).toBe(true);
  });

  it('validateStepContract：verify/waitFor 缺 expectation 被拒', () => {
    expect(validateStepContract('verify the page', {}).some(i => i.includes('expectation'))).toBe(true);
    expect(validateStepContract('wait for the response', {}).some(i => i.includes('expectation'))).toBe(true);
  });

  it('validateStepContract：fill 缺 data 被拒；click 不要求 data', () => {
    expect(validateStepContract('fill the username', {}).some(i => i.includes('intent.data'))).toBe(true);
    expect(validateStepContract('click the button', {})).toEqual([]);
  });

  it('validateStepContract：非词表动词报错', () => {
    expect(validateStepContract('Enter the username', {}).some(i => i.includes('vocabulary verb'))).toBe(true);
  });

  it('枚举 schema 与词表常量同源', () => {
    for (const v of ALL_ACTION_VERBS) expect(actionVerbSchema.safeParse(v).success).toBe(true);
    for (const k of ALL_EXPECTATION_KINDS) expect(expectationKindSchema.safeParse(k).success).toBe(true);
  });
});

describe('nl-intent · resolveIntentData（testData 引用解析）', () => {
  const params = { username: 'admin', password: 'admin123', url: 'http://localhost:3000/aut/login' };

  it('${key} 模板解析为 testData 值', () => {
    expect(resolveIntentData('${username}', params)).toBe('admin');
    expect(resolveIntentData('${password}', params)).toBe('admin123');
  });

  it('裸键名精确匹配 testData 也解析', () => {
    expect(resolveIntentData('username', params)).toBe('admin');
  });

  it('键名不存在时原样返回', () => {
    expect(resolveIntentData('${nope}', params)).toBe('${nope}');
    expect(resolveIntentData('nope', params)).toBe('nope');
  });

  it('字面值直接返回', () => {
    expect(resolveIntentData('admin', params)).toBe('admin');
    expect(resolveIntentData('/login', params)).toBe('/login');
  });

  it('undefined/空串返回原值', () => {
    expect(resolveIntentData(undefined, params)).toBeUndefined();
    expect(resolveIntentData('', params)).toBe('');
  });

  it('模板内嵌（prefix-${key}）', () => {
    expect(resolveIntentData('http://${url}/dashboard', { url: 'localhost:3000/aut/login' })).toBe('http://localhost:3000/aut/login/dashboard');
  });
});
