import { z } from 'zod';

/**
 * Coerce any value to a string. Handles the LLM's common mistakes:
 * - nested arrays: ["a", "b"] → "a, b"
 * - objects: {key: "val"} → '{"key":"val"}'
 * - numbers/booleans: 123 → "123"
 * This is a schema-level coercion, not a post-hoc auto-fix.
 */
export const coercedStringSchema = z.preprocess((v) => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(', ');
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}, z.string());

export function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value == null ? undefined : value;
}

export function nullToEmptyArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

export function arrayFromRecordValues<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, T>);
  }
  return [];
}

export function wrapSingleObjectInArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') return [value as T];
  return [];
}

export function coerceNumber(value: unknown): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}

/**
 * NlStepIntent 容错：LLM 常把可选字段（data / targetHint / expectation.value /
 * expression / method / urlPattern）输出为 null 而非省略。删除 null 值字段，
 * 使 nlStepIntentSchema 的 optional() 能通过——否则一整条步骤报错会让
 * Phase 1.5/Phase 2 重跑整个 agent（既费时又费 token）。
 * expectation 缺失 kind 时整段移除（语义不明，交由后续校验/推断处理）。
 */
/** ExpectationKind 合规枚举（与 shared 词表一致） */
const VALID_EXPECTATION_KINDS: readonly string[] = [
  'url', 'title', 'text-visible', 'element-visible', 'element-hidden',
  'value', 'element-state', 'attribute', 'network', 'api-body', 'transient',
];

/**
 * LLM 常见的 ExpectationKind 变体 → 规范枚举（大小写不敏感 + 下划线/空格/camelCase/同义别名归一化）。
 * 确定性、零 LLM。无法 1:1 映射时返回 null（调用方删除整个 expectation，避免 schema 拒整批）。
 */
const EXPECTATION_KIND_ALIASES: Readonly<Record<string, string>> = {
  url: 'url', 'page-url': 'url', 'pageurl': 'url',
  title: 'title',
  'text-visible': 'text-visible', 'textvisible': 'text-visible', 'text visible': 'text-visible',
  text: 'text-visible', 'text-visibility': 'text-visible',
  'element-visible': 'element-visible', 'elementvisible': 'element-visible', 'element visible': 'element-visible',
  visible: 'element-visible', visibility: 'element-visible', 'is-visible': 'element-visible',
  'element-hidden': 'element-hidden', 'elementhidden': 'element-hidden', 'element hidden': 'element-hidden',
  hidden: 'element-hidden', invisible: 'element-hidden', 'not-visible': 'element-hidden',
  value: 'value', 'input-value': 'value', 'inputvalue': 'value',
  'element-state': 'element-state', 'elementstate': 'element-state', 'element state': 'element-state',
  state: 'element-state', 'element-state-value': 'element-state',
  attribute: 'attribute', 'attribute-value': 'attribute', 'attr': 'attribute',
  network: 'network', 'networkcall': 'network', 'network-call': 'network',
  'network-response': 'network', 'httpstatus': 'network', 'http-status': 'network', response: 'network',
  'api-body': 'api-body', 'apibody': 'api-body', 'api body': 'api-body', 'json-body': 'api-body',
  json: 'api-body', 'response-body': 'api-body', 'responsebody': 'api-body',
  transient: 'transient', loading: 'transient', focus: 'transient',
  animation: 'transient', 'in-transition': 'transient',
};

/**
 * 将 LLM 产出的 ExpectationKind 归一化为规范格式（大小写不敏感）。
 * - 已是规范枚举 → 原样（含 transient —— 是否可落盘由调用方决定）
 * - 变体（大小写/下划线/空格/camelCase/同义）→ 映射到规范枚举
 * - 无法识别 → 返回 null（调用方删 expectation，避免整批重试）
 */
export function normalizeExpectationKind(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (VALID_EXPECTATION_KINDS.includes(trimmed)) return trimmed;
  const normalized = trimmed.toLowerCase();
  if (VALID_EXPECTATION_KINDS.includes(normalized)) return normalized;
  return EXPECTATION_KIND_ALIASES[normalized] ?? null;
}

/**
 * 将 testLevel 归一化为小写 "component"/"integration"。
 * 返回 null 表示无法识别（保留原样，交给 schema 拒绝）。
 */
export function normalizeTestLevel(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const t = raw.trim().toLowerCase();
  if (t === 'component' || t === 'integration') return t;
  return raw;
}

/**
 * 剥离 expected 中的分号拼接断言：LLM 频繁把两个相关断言用 ";" / "；" 拼在
 * 一个 expected 里（Quality 评审时尤其常见），schema 的 atomicExpected 会拒掉
 * 整批。这里确定性保留主断言（第一段），丢弃后段——避免 Phase 2 三次重跑。
 * 返回剥离后的单断言字符串。
 */
export function normalizeAtomicExpected(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const segments = raw.split(/[;；]/).map((s) => s.trim()).filter(Boolean);
  if (segments.length <= 1) return raw;
  return segments[0];
}

export function normalizeNlStepIntent(intent: unknown): unknown {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return intent;
  const o = intent as Record<string, unknown>;
  for (const key of ['targetHint', 'data']) {
    if (o[key] === null) delete o[key];
  }
  // expectation 为 null/空/非对象（LLM 高频写 "expectation": null）——删除，
  // 否则 nlStepIntentSchema 的 expectation: z.object().optional() 会拒掉整批
  // （expected object, received null）。
  if (o.expectation === null || o.expectation === undefined) {
    delete o.expectation;
  } else if (typeof o.expectation === 'object' && !Array.isArray(o.expectation)) {
    const e = o.expectation as Record<string, unknown>;
    for (const key of ['kind', 'value', 'expression', 'method', 'urlPattern']) {
      if (e[key] === null) delete e[key];
    }
    if (typeof e.kind === 'string' && e.kind !== '') {
      const normalized = normalizeExpectationKind(e.kind);
      if (normalized == null) {
        // 无法映射的非法 kind —— 删除整个 expectation，避免 schema 拒整批（重试仍失败）。
        // 语义上：不可断言的期望无意义，宁可不带也不硬塞（对应 docs/08 对 transient 的处理）。
        delete o.expectation;
      } else {
        e.kind = normalized;
        // transient 在生成层不可断言：删除整个 expectation（docs/08 §3.1：生成期即拒绝）
        if (normalized === 'transient') {
          delete o.expectation;
        }
      }
    } else {
      delete o.expectation;
    }
  } else {
    // expectation 是数组/字符串等其他非法类型——删除
    delete o.expectation;
  }
  return o;
}

export function formatZodValidationError(
  error: unknown,
  fieldHints: Record<string, string> = {},
): string {
  const issues = (error as { issues?: Array<{ path?: Array<string | number>; message?: string }> })?.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return (error as Error)?.message || 'Schema validation failed.';
  }

  const details = issues.map((issue) => {
    const pathParts = Array.isArray(issue.path) ? issue.path : [];
    const path = pathParts.length > 0
      ? pathParts.join('.')
      : '(root)';
    const normalizedPath = pathParts
      .filter((part) => typeof part !== 'number')
      .join('.');
    const parentPaths = normalizedPath
      ? normalizedPath.split('.').map((_, index, all) => all.slice(0, all.length - index).join('.'))
      : [];
    const hint = [path, normalizedPath, ...parentPaths, path.split('.').slice(0, 1)[0] || '']
      .map((candidate) => fieldHints[candidate])
      .find(Boolean);
    return hint
      ? `- ${path}: ${issue.message}. ${hint}`
      : `- ${path}: ${issue.message}`;
  });
  return `Schema validation failed with ${issues.length} error(s):\n${details.join('\n')}`;
}
