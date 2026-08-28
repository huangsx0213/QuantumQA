/**
 * execution-core · 断言求值引擎（纯逻辑，双端同源）
 *
 * 从 server/modules/execution/assertions.ts 迁出：server 运行期执行器与
 * agent 作者期编译器（编译门 / 确认运行）消费同一实现，保证断言语义不漂移。
 */
import { JSONPath } from 'jsonpath-plus';
import { XMLParser } from 'fast-xml-parser';
import Ajv from 'ajv';
import { StepAssertion, AssertionOperator } from '../contracts/index.ts';

export interface ApiAssertionContext {
  body: string;
  headers: Record<string, string>;
  status: number;
  durationMs?: number;
}

export interface UiAssertionContext {
  pageUrl?: string;
  pageTitle?: string;
  elementText?: string;
  elementValue?: string;
  elementAttributes?: Record<string, string>;
  elementCount?: number;
  elementVisible?: boolean;
  elementEnabled?: boolean;
  elementChecked?: boolean;
}

export type AssertionContext = ApiAssertionContext & { ui?: UiAssertionContext };

export interface AssertionResult {
  passed: boolean;
  message: string;
  actualValue?: any;
  assertion: StepAssertion;
}

const ajv = new Ajv({ allErrors: true });

function resolveApiSource(source: string, context: ApiAssertionContext, expression?: string): any {
  switch (source) {
    case 'API_STATUS':
      return context.status;
    case 'API_HEADER':
      if (!expression) throw new Error(`Expression (header name) is required for API_HEADER source.`);
      const headerKey = Object.keys(context.headers).find(k => k.toLowerCase() === expression.toLowerCase());
      return headerKey ? context.headers[headerKey] : undefined;
    case 'API_BODY_JSON':
      if (!expression) throw new Error(`Expression (JSONPath) is required for API_BODY_JSON source.`);
      try {
        const parsedBody = JSON.parse(context.body);
        const jsonPathResults = JSONPath({ path: expression, json: parsedBody });
        return jsonPathResults.length > 0 ? jsonPathResults[0] : undefined;
      } catch (e) {
        throw new Error(`Could not parse response body as JSON. ${e}`);
      }
    case 'API_BODY_XML':
      if (!expression) throw new Error(`Expression (JSONPath) is required for API_BODY_XML source.`);
      try {
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
        const parsedXml = parser.parse(context.body);
        const jsonPathResults = JSONPath({ path: expression, json: parsedXml });
        return jsonPathResults.length > 0 ? jsonPathResults[0] : undefined;
      } catch (e) {
        throw new Error(`Could not parse response body as XML. ${e}`);
      }
    case 'API_BODY_REGEX':
      if (!expression) throw new Error(`Expression (regex pattern) is required for API_BODY_REGEX source.`);
      try {
        const regex = new RegExp(expression);
        const match = context.body.match(regex);
        return match ? (match[1] !== undefined ? match[1] : match[0]) : undefined;
      } catch (e) {
        throw new Error(`Invalid regex pattern '${expression}': ${e}`);
      }
    case 'API_DURATION':
      return context.durationMs;
    default:
      return undefined;
  }
}

function resolveUiSource(source: string, ui: UiAssertionContext | undefined, expression?: string): any {
  if (!ui) throw new Error(`UI assertion context not available. UI assertions require a running browser.`);
  switch (source) {
    case 'UI_TEXT':
      return ui.elementText;
    case 'UI_VALUE':
      return ui.elementValue;
    case 'UI_ATTRIBUTE':
      if (!expression) return undefined;
      return ui.elementAttributes?.[expression];
    case 'UI_PAGE_URL':
      return ui.pageUrl;
    case 'UI_PAGE_TITLE':
      return ui.pageTitle;
    case 'UI_ELEMENT_COUNT':
      return ui.elementCount;
    case 'UI_ELEMENT_VISIBLE':
      return ui.elementVisible;
    case 'UI_ELEMENT_ENABLED':
      return ui.elementEnabled;
    case 'UI_ELEMENT_CHECKED':
      return ui.elementChecked;
    default:
      return undefined;
  }
}

function resolveActualValue(source: string, context: AssertionContext, expression?: string): any {
  if (source.startsWith('API_')) {
    return resolveApiSource(source, context, expression);
  }
  if (source.startsWith('UI_')) {
    return resolveUiSource(source, context.ui, expression);
  }
  throw new Error(`Unknown source: ${source}`);
}

function compareNumeric(actual: any, expected: string, operator: AssertionOperator): void {
  const numActual = Number(actual);
  const numExpected = Number(expected);
  if (isNaN(numActual)) throw new Error(`Cannot compare numerically: actual value '${actual}' is not a number.`);
  if (isNaN(numExpected)) throw new Error(`Cannot compare numerically: expected value '${expected}' is not a number.`);
  switch (operator) {
    case 'GREATER_THAN':
      if (!(numActual > numExpected)) throw new Error(`Expected ${numActual} to be greater than ${numExpected}`);
      break;
    case 'LESS_THAN':
      if (!(numActual < numExpected)) throw new Error(`Expected ${numActual} to be less than ${numExpected}`);
      break;
    case 'GREATER_THAN_OR_EQUAL':
      if (!(numActual >= numExpected)) throw new Error(`Expected ${numActual} to be greater than or equal to ${numExpected}`);
      break;
    case 'LESS_THAN_OR_EQUAL':
      if (!(numActual <= numExpected)) throw new Error(`Expected ${numActual} to be less than or equal to ${numExpected}`);
      break;
    default: break;
  }
}

function evaluateOperator(operator: AssertionOperator, actualValue: any, assertion: StepAssertion): void {
  const expected = assertion.expectedValue;
  const actualStr = actualValue !== undefined && actualValue !== null ? String(actualValue) : '';
  const expectedStr = expected !== undefined && expected !== null ? String(expected) : '';
  const customMsg = assertion.message;

  function fail(defaultMsg: string): never {
    throw new Error(customMsg ? `${customMsg} (${defaultMsg})` : defaultMsg);
  }

  switch (operator) {
    case 'EQUALS':
      if (actualStr !== expectedStr) fail(`Expected '${expectedStr}', but got '${actualStr}'`);
      break;
    case 'NOT_EQUALS':
      if (actualStr === expectedStr) fail(`Expected not to equal '${expectedStr}'`);
      break;
    case 'CONTAINS':
      if (!actualStr.includes(expectedStr)) fail(`Expected '${actualStr}' to contain '${expectedStr}'`);
      break;
    case 'NOT_CONTAINS':
      if (actualStr.includes(expectedStr)) fail(`Expected '${actualStr}' not to contain '${expectedStr}'`);
      break;
    case 'EXISTS':
      if (actualValue === undefined || actualValue === null) fail(`Expected value to exist at expression '${assertion.expression}'`);
      break;
    case 'NOT_EXISTS':
      if (actualValue !== undefined && actualValue !== null) fail(`Expected value not to exist at expression '${assertion.expression}', but found '${actualStr}'`);
      break;
    case 'MATCHES_REGEX': {
      if (!expected) throw new Error(`Expected value (regex pattern) is required for MATCHES_REGEX.`);
      const flags = assertion.flags || '';
      const regex = new RegExp(expected, flags);
      if (!regex.test(actualStr)) fail(`Expected '${actualStr}' to match regex /${expected}/${flags}`);
      break;
    }
    case 'GREATER_THAN':
    case 'LESS_THAN':
    case 'GREATER_THAN_OR_EQUAL':
    case 'LESS_THAN_OR_EQUAL':
      compareNumeric(actualValue, expected || '0', operator);
      break;
    case 'IS_TYPE': {
      if (!expected) throw new Error(`Expected value (type name) is required for IS_TYPE.`);
      const type = expected.toLowerCase();
      let matches = false;
      if (type === 'array') matches = Array.isArray(actualValue);
      else if (type === 'object' && actualValue !== null) matches = typeof actualValue === 'object' && !Array.isArray(actualValue);
      else if (type === 'null') matches = actualValue === null;
      else matches = typeof actualValue === type;
      if (!matches) {
        const actualType = Array.isArray(actualValue) ? 'array' : actualValue === null ? 'null' : typeof actualValue;
        fail(`Expected type '${expected}', but got '${actualType}'`);
      }
      break;
    }
    case 'HAS_LENGTH': {
      if (!expected) throw new Error(`Expected value (length number) is required for HAS_LENGTH.`);
      let len: number | undefined;
      if (typeof actualValue === 'string' || Array.isArray(actualValue)) len = actualValue.length;
      else if (actualValue && typeof actualValue === 'object') len = Object.keys(actualValue).length;
      if (len === undefined) fail(`Value does not have a length property (type: ${typeof actualValue})`);
      const expectedLen = Number(expected);
      if (isNaN(expectedLen)) throw new Error(`Expected length '${expected}' is not a valid number.`);
      if (len! !== expectedLen) fail(`Expected length ${expectedLen}, but got ${len}`);
      break;
    }
    case 'CONTAINS_KEY': {
      if (!expected) throw new Error(`Expected value (key name) is required for CONTAINS_KEY.`);
      if (actualValue === null || actualValue === undefined || typeof actualValue !== 'object') {
        fail(`Value is not an object, cannot check for key '${expected}'`);
      }
      if (!(expected in actualValue)) fail(`Expected object to contain key '${expected}'`);
      break;
    }
    case 'MATCHES_JSON_SCHEMA': {
      if (!expected) throw new Error(`Expected value (JSON Schema) is required for MATCHES_JSON_SCHEMA.`);
      let schema: object;
      try {
        schema = JSON.parse(expected);
      } catch {
        throw new Error(`Expected value is not valid JSON Schema: ${expected}`);
      }
      const validate = ajv.compile(schema);
      const valueToValidate = typeof actualValue === 'string' ? JSON.parse(actualValue) : actualValue;
      if (!validate(valueToValidate)) {
        const errors = validate.errors?.map(e => `${e.instancePath || '/'} ${e.message}`).join('; ') || 'Schema validation failed';
        fail(`JSON Schema validation failed: ${errors}`);
      }
      break;
    }
    case 'LESS_THAN_DURATION': {
      if (!expected) throw new Error(`Expected value (duration in ms) is required for LESS_THAN_DURATION.`);
      const maxMs = Number(expected);
      if (isNaN(maxMs)) throw new Error(`Expected duration '${expected}' is not a valid number.`);
      const actualMs = Number(actualValue);
      if (isNaN(actualMs)) throw new Error(`Actual duration '${actualValue}' is not a number.`);
      if (actualMs >= maxMs) fail(`Expected duration < ${maxMs}ms, but took ${actualMs}ms`);
      break;
    }
    case 'GREATER_THAN_DURATION': {
      if (!expected) throw new Error(`Expected value (duration in ms) is required for GREATER_THAN_DURATION.`);
      const minMs = Number(expected);
      if (isNaN(minMs)) throw new Error(`Expected duration '${expected}' is not a valid number.`);
      const actualMs = Number(actualValue);
      if (isNaN(actualMs)) throw new Error(`Actual duration '${actualValue}' is not a number.`);
      if (actualMs <= minMs) fail(`Expected duration > ${minMs}ms, but took ${actualMs}ms`);
      break;
    }
    default:
      throw new Error(`Unknown operator ${operator}`);
  }
}

export function evaluateAssertions(
  context: AssertionContext,
  assertions: StepAssertion[],
  failureStrategy: 'fail-fast' | 'soft' = 'fail-fast',
): AssertionResult[] {
  const results: AssertionResult[] = [];
  for (const assertion of assertions) {
    let actualValue: any;
    try {
      actualValue = resolveActualValue(assertion.source, context, assertion.expression);
      evaluateOperator(assertion.operator, actualValue, assertion);
      results.push({ passed: true, message: assertion.message || 'Passed', actualValue, assertion });
    } catch (e: any) {
      results.push({ passed: false, message: e.message, actualValue, assertion });
      if (failureStrategy === 'fail-fast' && !assertion.continueOnFailure) {
        break;
      }
    }
  }
  return results;
}

export function hasFailedAssertions(results: AssertionResult[]): boolean {
  return results.some(r => !r.passed);
}

export function buildApiAssertionContext(
  body: string,
  headers: Record<string, string>,
  status: number,
  durationMs: number,
): ApiAssertionContext {
  return { body, headers, status, durationMs };
}

export async function buildUiAssertionContext(
  page: any,
  locator: any | null,
  attributeNames: string[] = [],
): Promise<UiAssertionContext> {
  const ctx: UiAssertionContext = {};
  try { ctx.pageUrl = page.url(); } catch {}
  try { ctx.pageTitle = await page.title(); } catch {}
  if (locator) {
    try { ctx.elementText = await locator.textContent({ timeout: 3000 }) || undefined; } catch {}
    try { ctx.elementValue = await locator.inputValue({ timeout: 3000 }).catch(() => undefined); } catch {}
    if (attributeNames.length > 0) {
      const attrs: Record<string, string> = {};
      for (const name of attributeNames) {
        try {
          const val = await locator.getAttribute(name, { timeout: 3000 });
          if (val !== null) attrs[name] = val;
        } catch {}
      }
      if (Object.keys(attrs).length > 0) ctx.elementAttributes = attrs;
    }
    try { ctx.elementCount = await locator.count(); } catch {}
    try { ctx.elementVisible = await locator.isVisible().catch(() => false); } catch {}
    try { ctx.elementEnabled = await locator.isEnabled().catch(() => true); } catch {}
    try { ctx.elementChecked = await locator.isChecked().catch(() => false); } catch {}
  }
  return ctx;
}
