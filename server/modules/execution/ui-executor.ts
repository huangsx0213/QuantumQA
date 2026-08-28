import { Log } from '../../shared/services/logger';
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright';
import { JSONPath } from 'jsonpath-plus';
import type { TestStep, LogLevel, StepAssertion } from '../../shared/contracts/index.ts';
import type { ExecutionContext } from './context.ts';
import type { UIElement } from '../../shared/contracts/index.ts';
import type { IExecutionLogger } from '../../shared/contracts/index.ts';
import { evaluateAssertions, buildUiAssertionContext, hasFailedAssertions } from './assertions.ts';
import type { AssertionContext } from './assertions.ts';
import { randomUUID } from 'crypto';

const BUILTIN_ASSERTION_ACTIONS = new Set([
  'assertVisible', 'assertHidden', 'assertInvisible', 'assertAttribute',
  'assertEnabled', 'assertDisabled',
  'assertChecked', 'assertUnchecked',
  'assertText', 'assertValue',
  'assertUrl', 'assertTitle',
]);

function builtinActionToAssertion(action: string, data: string | undefined, target: string): StepAssertion | null {
  switch (action) {
    case 'assertVisible':
      return { id: randomUUID(), source: 'UI_ELEMENT_VISIBLE', operator: 'EQUALS', expectedValue: 'true' };
    case 'assertHidden':
    case 'assertInvisible':
      return { id: randomUUID(), source: 'UI_ELEMENT_VISIBLE', operator: 'EQUALS', expectedValue: 'false' };
    case 'assertEnabled':
      return { id: randomUUID(), source: 'UI_ELEMENT_ENABLED', operator: 'EQUALS', expectedValue: 'true' };
    case 'assertDisabled':
      return { id: randomUUID(), source: 'UI_ELEMENT_ENABLED', operator: 'EQUALS', expectedValue: 'false' };
    case 'assertChecked':
      return { id: randomUUID(), source: 'UI_ELEMENT_CHECKED', operator: 'EQUALS', expectedValue: 'true' };
    case 'assertUnchecked':
      return { id: randomUUID(), source: 'UI_ELEMENT_CHECKED', operator: 'EQUALS', expectedValue: 'false' };
    case 'assertText':
      if (data === undefined) return null;
      return { id: randomUUID(), source: 'UI_TEXT', operator: 'EQUALS', expectedValue: data };
    case 'assertValue':
      if (data === undefined) return null;
      return { id: randomUUID(), source: 'UI_VALUE', operator: 'EQUALS', expectedValue: data };
    case 'assertUrl':
      if (data === undefined) return null;
      return { id: randomUUID(), source: 'UI_PAGE_URL', operator: 'EQUALS', expectedValue: data };
    case 'assertTitle':
      if (data === undefined) return null;
      return { id: randomUUID(), source: 'UI_PAGE_TITLE', operator: 'EQUALS', expectedValue: data };
    case 'assertAttribute': {
      if (!data || !data.includes('=')) return null;
      const eqIdx = data.indexOf('=');
      const attrName = data.slice(0, eqIdx).trim();
      const expectedValue = data.slice(eqIdx + 1).trim();
      if (!attrName) return null;
      return { id: randomUUID(), source: 'UI_ATTRIBUTE', expression: attrName, operator: 'EQUALS', expectedValue };
    }
    default:
      return null;
  }
}

export interface UIExecutionResult {
  durationMs: number;
  screenshot?: string;
  extractedValue?: string;
  assertionDetails?: {
    expected: string;
    actual: string;
    target?: string;
  };
  logs: { status: string; level: LogLevel; message: string }[];
}

// Constants for better maintainability
const DEFAULT_TIMEOUT = 10000;
const SCREENSHOT_QUALITY = 50;
const HIGHLIGHT_ITERATIONS = 4;
const HIGHLIGHT_DURATION = 250;

export class UIExecutor {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private dialogHandler: ((dialog: any) => Promise<void>) | null = null;
  private logger?: IExecutionLogger;

  async initialize(options: {
    headless: boolean;
    viewportWidth?: number;
    viewportHeight?: number;
    logger?: IExecutionLogger;
    recordVideo?: boolean;
  }): Promise<void> {
    this.logger = options.logger;
    if (!this.browser) {
      // Only use resolution in headless mode. 
      // In non-headless mode, we maximize the browser and disable resolution parameters.
      const useResolution = options.headless && !!options.viewportWidth && !!options.viewportHeight;

      this.browser = await chromium.launch({
        headless: options.headless,
        args: options.headless ? [] : ['--start-maximized'],
      });

      this.context = await this.browser.newContext({
        viewport: useResolution
          ? { width: options.viewportWidth!, height: options.viewportHeight! }
          : null, // null viewport allows the page to scale to the maximized window
        recordVideo: options.recordVideo !== false ? { dir: 'videos/' } : undefined,
      });
      this.page = await this.context.newPage();

      if (this.logger) {
        this.page.on('console', msg => {
          this.logger?.log({
            stepId: 'system-console',
            status: 'INFO',
            level: msg.type() === 'error' ? 'error' : msg.type() === 'warning' ? 'warn' : 'debug',
            message: `[Browser Console] ${msg.text()}`,
          });
        });

        this.page.on('request', request => {
          this.logger?.log({
            stepId: 'system-network',
            status: 'INFO',
            level: 'debug',
            message: `[Network Request] ${request.method()} ${request.url()}`,
            metadata: {
              network: {
                url: request.url(),
                method: request.method(),
                isMocked: false,
              }
            }
          });
        });

        this.page.on('response', async response => {
          const request = response.request();
          this.logger?.log({
            stepId: 'system-network',
            status: 'INFO',
            level: response.status() >= 400 ? 'warn' : 'debug',
            message: `[Network Response] ${request.method()} ${request.url()} - ${response.status()}`,
            metadata: {
              network: {
                url: request.url(),
                method: request.method(),
                status: response.status(),
                isMocked: false,
              }
            }
          });
        });
      }
    }
  }

  async executeStep(
    step: TestStep,
    executionContext: ExecutionContext,
    pages: import('../../shared/contracts/index.ts').Page[],
    environment: string,
    onEnvVarExtracted?: (name: string, value: string) => void,
  ): Promise<UIExecutionResult> {
    if (!this.page) {
      throw new Error('UIExecutor not initialized. Call initialize() first.');
    }

    const startTime = Date.now();
    let extractedValue: string | undefined;
    let assertionDetails: UIExecutionResult['assertionDetails'] = undefined;
    const logs: { status: string; level: LogLevel; message: string }[] = [];

    // Resolve element locator if target exists
    let candidateLocators: { selectorType: string; value: string }[] = [];

    if (step.target) {
      const interpolated = executionContext.interpolate(step.target);

      // Try to resolve "PageName.ElementName" or plain element name
      let elementDef: UIElement | undefined;

      if (interpolated.includes('.')) {
        const dotIdx = interpolated.indexOf('.');
        const pageName = interpolated.slice(0, dotIdx).trim().toLowerCase();
        const elName = interpolated.slice(dotIdx + 1).trim().toLowerCase();
        const page = pages.find(p => p.name.toLowerCase() === pageName);
        if (page) {
          elementDef = (page.elements || []).find(e => e.name.toLowerCase() === elName);
        }
      }

      // Fall back to flat search by id or name across all pages (case-insensitive)
      if (!elementDef) {
        const flatInterp = interpolated.toLowerCase();
        for (const p of pages) {
          elementDef = (p.elements || []).find(e =>
            e.id === interpolated || e.name.toLowerCase() === flatInterp
          );
          if (elementDef) break;
        }
      }

      if (elementDef) {
        // Collect all available locators, prioritizing the primary one
        candidateLocators = [{ selectorType: elementDef.selectorType, value: elementDef.value }];
        if (elementDef.locators && elementDef.locators.length > 0) {
          for (const loc of elementDef.locators) {
            if (loc.value !== elementDef.value) {
              candidateLocators.push(loc);
            }
          }
        }
      } else {
        // Not a repo element — treat interpolated value as-is (raw selector or URL)
        candidateLocators = [{ selectorType: 'css', value: interpolated }];
      }
    }

    // Resolve data payload
    let data = step.data;
    if (data) {
      data = executionContext.interpolate(data);
    }

    const framePath = Array.isArray((step.metadata as any)?.recorder?.framePath)
      ? (step.metadata as any).recorder.framePath.filter((value: unknown) => typeof value === 'string' && value.trim().length > 0)
      : [];
    let locatorRoot: any = this.page!;
    for (const frameSelector of framePath) {
      locatorRoot = locatorRoot.frameLocator(frameSelector);
    }

    // Helper: get a Playwright Locator from a formal locator definition
    const createLocator = (loc: { selectorType: string; value: string }): { locator: Locator; methodInfo: string } => {
      const st = loc.selectorType.toLowerCase();
      const val = executionContext.interpolate(loc.value);

      if (st === 'css') {
        return { locator: locatorRoot.locator(val), methodInfo: `css(${val})` };
      } else if (st === 'official') {
        return { locator: locatorRoot.locator(val), methodInfo: `official(${val})` };
      } else if (st === 'xpath') {
        return { locator: locatorRoot.locator(`xpath=${val}`), methodInfo: `xpath(${val})` };
      } else if (st === 'text') {
        return { locator: locatorRoot.locator(`text=${val}`), methodInfo: `text(${val})` };
      } else if (st === 'testid' || st === 'getbytestid' || st === 'data-test') {
        return { locator: locatorRoot.getByTestId(val), methodInfo: `getByTestId(${val})` };
      }

      // Legacy support: getBy* kinds from previously recorded/edited steps
      if (['getbylabel', 'getbytext', 'getbyplaceholder', 'getbyalttext', 'getbytitle'].includes(st)) {
        switch (st) {
          case 'getbylabel':
            return { locator: locatorRoot.getByLabel(val), methodInfo: `getByLabel(${val})` };
          case 'getbytext':
            return { locator: locatorRoot.getByText(val), methodInfo: `getByText(${val})` };
          case 'getbyplaceholder':
            return { locator: locatorRoot.getByPlaceholder(val), methodInfo: `getByPlaceholder(${val})` };
          case 'getbyalttext':
            return { locator: locatorRoot.getByAltText(val), methodInfo: `getByAltText(${val})` };
          case 'getbytitle':
            return { locator: locatorRoot.getByTitle(val), methodInfo: `getByTitle(${val})` };
        }
      }

      if (st === 'getbyrole') {
        let role = val;
        let options: any = {};

        // Format: "button, {name: 'Login', exact: true}"
        if (val.includes('{')) {
          const parts = val.split(/,(?=\s*\{)/);
          role = parts[0].trim();
          const optionsStr = parts[1]?.trim();
          if (optionsStr) {
            const nameMatch = optionsStr.match(/(?:['"]?name['"]?)\s*:\s*(['"])(.*?)\1/);
            if (nameMatch) options.name = nameMatch[2];
            const exactMatch = optionsStr.match(/(?:['"]?exact['"]?)\s*:\s*(true|false)/);
            if (exactMatch) options.exact = exactMatch[1] === 'true';
          }
        }
        // Format: "button[name='Login']"
        else if (val.includes('[name=')) {
          const bracketMatch = val.match(/^(\w+)\[name=['"](.+)['"]\]$/);
          if (bracketMatch) {
            role = bracketMatch[1];
            options.name = bracketMatch[2];
          }
        }

        return { locator: locatorRoot.getByRole(role as any, options), methodInfo: `getByRole(${role}, ${JSON.stringify(options)})` };
      }

      // Default fallback
      return { locator: locatorRoot.locator(val), methodInfo: `locator(${val})` };
    };

    /**
         * Convert a LocatorRef (simplified: only official/css) to a legacy-style locator info
         * for use by createLocator. Also handles legacy kinds for backward compatibility
         * with previously recorded steps.
         */
    const locatorInfoFromRef = (ref: any): { selectorType: string; value: string } | null => {
      if (!ref) return null;
      // Simplified LocatorRef (official/css)
      if (ref.kind === 'official' || ref.kind === 'css') {
        return { selectorType: ref.kind, value: ref.selector };
      }
      // Legacy LocatorRef kinds (for backward compatibility with stored steps)
      if (ref.kind === 'getByRole') {
        const parts = [`${ref.role}`];
        const options: string[] = [];
        if (ref.name !== undefined) options.push(`name: '${String(ref.name).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
        if (ref.exact !== undefined) options.push(`exact: ${ref.exact ? 'true' : 'false'}`);
        if (options.length) parts.push(`{ ${options.join(', ')} }`);
        return { selectorType: 'getByRole', value: parts.join(', ') };
      }
      if (['getByLabel', 'getByPlaceholder', 'getByText', 'getByAltText', 'getByTitle', 'getByTestId'].includes(ref.kind)) {
        return { selectorType: ref.kind, value: ref.text };
      }
      return null;
    };

    const filePayloadsFromRecorder = (files: any): Array<{ name: string; mimeType: string; buffer: Buffer }> | null => {
      if (!Array.isArray(files) || files.length === 0) return null;
      const payloads = files
        .filter((file) => file && typeof file.name === 'string' && typeof file.bufferBase64 === 'string')
        .map((file) => ({
          name: file.name,
          mimeType: typeof file.mimeType === 'string' && file.mimeType ? file.mimeType : 'application/octet-stream',
          buffer: Buffer.from(file.bufferBase64, 'base64'),
        }));
      return payloads.length > 0 ? payloads : null;
    };

    // Helper: Safely get the best single locator with smart waiting and actionability checks
    const getSmartLocator = async (options?: { skipActionabilityCheck?: boolean }): Promise<Locator> => {
      let lastError: any = null;

      // Try each candidate locator in sequence
      for (const locInfo of candidateLocators) {
        const { locator: base, methodInfo } = createLocator(locInfo);

        try {
          // Quick wait to see if this locator works
          await base.first().waitFor({ state: 'attached', timeout: lastError ? 2000 : 5000 });

          let finalLocator = base;
          const count = await base.count();
          if (count > 1) {
            // Prefer visible elements when multiple matches exist
            const visibleFilter = base.filter({ visible: true });
            const visibleCount = await visibleFilter.count();
            if (visibleCount > 0) {
              finalLocator = visibleFilter;
            }
          }

          const target = finalLocator.first();
          if (!options?.skipActionabilityCheck) {
            await target.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {
              Log.for('ui-exec').warn(`Element found via ${methodInfo} but not visible.`);
            });
          }

          Log.for('ui-exec').info(`Successfully resolved element via: ${methodInfo}`);
          return target;
        } catch (e) {
          lastError = e;
          Log.for('ui-exec').warn(`Locator failed: ${methodInfo}. Trying next...`);
          continue;
        }
      }

      throw new Error(`Element not found after trying ${candidateLocators.length} locators for: ${step.target}. Last error: ${lastError?.message}`);
    };

    // Helper: Perform action with fallback to JS evaluation
    const performActionWithFallback = async (
      locator: Locator,
      action: () => Promise<void>,
      fallbackEval?: (node: any, ...args: any[]) => void,
      ...fallbackArgs: any[]
    ): Promise<void> => {
      try {
        await action();
      } catch (e: any) {
        if (fallbackEval) {
          await locator.evaluate(fallbackEval, ...fallbackArgs);
        } else {
          throw e;
        }
      }
    };

    // Setup Network Mocks
    if (step.networkMocks && step.networkMocks.some(m => m.enabled)) {
      for (const mock of step.networkMocks) {
        if (!mock.enabled || !mock.urlPattern) continue;

        const resolvedUrlPattern = executionContext.interpolate(mock.urlPattern);
        const pattern = new RegExp(resolvedUrlPattern);
        await this.page.route(pattern, async (route, request) => {
          if (mock.method && mock.method !== 'ANY' && request.method().toUpperCase() !== mock.method.toUpperCase()) {
            return route.fallback();
          }

          if (mock.delayMs) {
            await new Promise(resolve => setTimeout(resolve, mock.delayMs));
          }

          logs.push({
            status: 'INFO',
            level: 'info',
            message: `[Mock Hit] ${request.method()} ${request.url()} -> ${mock.status || 200}`,
          });

          await route.fulfill({
            status: mock.status || 200,
            contentType: 'application/json',
            body: executionContext.interpolate(mock.body || '{}'),
          });
        });
      }
    }

    // Execute the action
    let waitPromise: Promise<import('playwright').Response> | undefined;
    // U5: captured network response for API_BODY_JSON assertions
    let capturedResponseBody: string | undefined;
    let capturedResponseStatus: number = 0;
    let capturedResponseHeaders: Record<string, string> = {};
    if (step.waitForNetwork?.enabled && step.waitForNetwork.urlPattern) {
      const { urlPattern, method, expectedStatus, timeoutMs = 10000 } = step.waitForNetwork;
      const resolvedUrlPattern = executionContext.interpolate(urlPattern);

      waitPromise = this.page.waitForResponse((response) => {
        const urlMatch = response.url().includes(resolvedUrlPattern) || new RegExp(resolvedUrlPattern).test(response.url());
        const methodMatch = !method || method === 'ANY' || response.request().method().toUpperCase() === method.toUpperCase();
        const statusMatch = !expectedStatus || response.status() === expectedStatus;

        return urlMatch && methodMatch && statusMatch;
      }, { timeout: timeoutMs });
    }

    const resolvedSelector = step.target ? executionContext.interpolate(step.target) : '';

    // Convert built-in assertion actions to step-level assertions for unified handling
    if (BUILTIN_ASSERTION_ACTIONS.has(step.action)) {
      const assertion = builtinActionToAssertion(step.action, data, resolvedSelector);
      if (assertion) {
        step.assertions = [assertion, ...(step.assertions || [])];
      }
    }

    const actionPromise = (async () => {
      switch (step.action) {
        case 'goto':
        case 'navigate':
        case 'pageLoad':
          {
            const navigationUrl = data || resolvedSelector;
            if (!navigationUrl) throw new Error('A URL is required for navigation steps');
            await this.page.goto(navigationUrl, { waitUntil: 'domcontentloaded' });
          }
          break;

        case 'waitForTimeout':
          if (data) {
            const waitTime = parseInt(data, 10);
            if (!isNaN(waitTime)) {
              await this.page.waitForTimeout(waitTime);
            }
          }
          break;

        case 'waitForVisible': {
          const locator = await getSmartLocator({ skipActionabilityCheck: true });
          await locator.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
          break;
        }

        case 'waitForHidden': {
          const locator = await getSmartLocator({ skipActionabilityCheck: true });
          await locator.waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT });
          break;
        }

        case 'click': {
          const locator = await getSmartLocator();
          await performActionWithFallback(
            locator,
            () => locator.click({ timeout: DEFAULT_TIMEOUT, force: true }),
            (node: any) => node.click()
          );
          break;
        }

        case 'dblclick': {
          const locator = await getSmartLocator();
          await locator.dblclick({ timeout: DEFAULT_TIMEOUT, force: true });
          break;
        }

        case 'rightClick': {
          const locator = await getSmartLocator();
          await locator.click({ button: 'right', timeout: DEFAULT_TIMEOUT, force: true });
          break;
        }



        case 'fill': {
          if (data === undefined) throw new Error('Data is required for TYPE step');
          const locator = await getSmartLocator();
          await performActionWithFallback(
            locator,
            () => locator.fill(data, { timeout: DEFAULT_TIMEOUT, force: true }),
            (node: any, val: string) => {
              node.value = val;
              node.dispatchEvent(new Event('input', { bubbles: true }));
              node.dispatchEvent(new Event('change', { bubbles: true }));
            },
            data
          );
          break;
        }

        case 'clear': {
          const locator = await getSmartLocator();
          await performActionWithFallback(
            locator,
            () => locator.clear({ timeout: DEFAULT_TIMEOUT, force: true }),
            (node: any) => {
              node.value = '';
              node.dispatchEvent(new Event('input', { bubbles: true }));
              node.dispatchEvent(new Event('change', { bubbles: true }));
            }
          );
          break;
        }

        case 'hover':
          await (await getSmartLocator()).hover({ timeout: DEFAULT_TIMEOUT, force: true });
          break;

        case 'highlight': {
          const locator = await getSmartLocator({ skipActionabilityCheck: true });
          await locator.evaluate(async (node: HTMLElement) => {
            if (node.scrollIntoView) {
              node.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            await new Promise(r => setTimeout(r, 100));

            const originalBorder = node.style.border;
            const originalBackground = node.style.backgroundColor;

            for (let i = 0; i < 4; i++) {
              node.style.border = '3px solid red';
              node.style.backgroundColor = 'yellow';
              await new Promise(r => setTimeout(r, 250));

              node.style.border = originalBorder;
              node.style.backgroundColor = originalBackground;
              await new Promise(r => setTimeout(r, 250));
            }
          });
          break;
        }

        case 'scrollIntoView': {
          const locator = await getSmartLocator();
          await locator.scrollIntoViewIfNeeded({ timeout: DEFAULT_TIMEOUT });
          break;
        }

        case 'check': {
          const locator = await getSmartLocator();
          await locator.check({ timeout: DEFAULT_TIMEOUT, force: true });
          break;
        }

        case 'uncheck': {
          const locator = await getSmartLocator();
          await locator.uncheck({ timeout: DEFAULT_TIMEOUT, force: true });
          break;
        }

        case 'toggle': {
          const locator = await getSmartLocator();
          const isChecked = await locator.isChecked();
          if (isChecked) {
            await locator.uncheck({ timeout: DEFAULT_TIMEOUT, force: true });
          } else {
            await locator.check({ timeout: DEFAULT_TIMEOUT, force: true });
          }
          break;
        }

        case 'selectOption': {
          if (data === undefined) throw new Error('Data is required for SELECT_OPTION step');
          const locator = await getSmartLocator();
          await locator.selectOption(data, { timeout: DEFAULT_TIMEOUT });
          break;
        }

        case 'press':
          if (data) {
            // If there's a target element, focus it first
            if (step.target && resolvedSelector) {
              const locator = await getSmartLocator();
              await locator.focus({ timeout: DEFAULT_TIMEOUT });
            }
            await this.page.keyboard.press(data);
          } else if (resolvedSelector) {
            await this.page.keyboard.press(resolvedSelector);
          } else {
            throw new Error('Either data (key name) or target (element) is required for PRESS_KEY step');
          }
break;

        case 'extractVar':
          if (!data) throw new Error('Data (variable key) is required for EXTRACT_VAR step');
          {
            const locator = await getSmartLocator({ skipActionabilityCheck: true });
            const text = await locator.textContent({ timeout: DEFAULT_TIMEOUT });
            extractedValue = text?.trim() || '';
            executionContext.setRuntimeVar(data, extractedValue);
          }
          break;

        case 'evaluate':
          if (data) {
            const jsResult = await this.page.evaluate(data);
            extractedValue = String(jsResult);
          }
          break;

        case 'switchToWindow': {
          const target = data || resolvedSelector;
          if (!target) throw new Error('Target URL or title is required for SWITCH_TO_WINDOW step');
          if (this.context) {
            const pages = this.context.pages();
            let found = false;
            for (const page of pages) {
              const url = page.url();
              const title = await page.title();
              if (url.includes(target) || url === target || title.includes(target)) {
                this.page = page;
                found = true;
                break;
              }
            }
            if (!found) {
              throw new Error(`Window with URL or title matching "${target}" not found`);
            }
          }
          break;
        }

        case 'switchToFrame': {
          if (!resolvedSelector) throw new Error('Frame selector is required for SWITCH_TO_FRAME step');
          const locator = await getSmartLocator();
          const frameElement = await locator.elementHandle({ timeout: DEFAULT_TIMEOUT });
          if (!frameElement) throw new Error(`Frame element not found: ${resolvedSelector}`);
          const frame = await frameElement.contentFrame();
          if (!frame) throw new Error(`Could not access frame content: ${resolvedSelector}`);
          this.page = frame as any;
          break;
        }

        case 'acceptDialog':
          // Set up dialog handler for next dialog
          if (this.dialogHandler) {
            this.page.off('dialog', this.dialogHandler);
          }
          this.dialogHandler = async (dialog) => {
            await dialog.accept(data || '');
          };
          this.page.once('dialog', this.dialogHandler);
          break;

        case 'dismissDialog':
          // Set up dialog handler for next dialog
          if (this.dialogHandler) {
            this.page.off('dialog', this.dialogHandler);
          }
          this.dialogHandler = async (dialog) => {
            await dialog.dismiss();
          };
          this.page.once('dialog', this.dialogHandler);
          break;

        case 'setInputFiles': {
          const locator = await getSmartLocator();
          const recorder = (step.metadata as any)?.recorder || {};
          const filePayloads = filePayloadsFromRecorder(recorder.files || recorder.raw?.metadata?.files);
          if (filePayloads) {
            await locator.setInputFiles(filePayloads, { timeout: DEFAULT_TIMEOUT });
            break;
          }
          if (!data) throw new Error('Data (file path) or recorded file payloads are required for ATTACH_FILE step');
          const filePaths = data.split(',').map(p => p.trim());
          await locator.setInputFiles(filePaths, { timeout: DEFAULT_TIMEOUT });
          break;
        }

        case 'dragTo': {
          const recorder = (step.metadata as any)?.recorder || {};
          const targetRef = recorder.secondaryLocator || recorder.raw?.secondaryLocator;
          const targetLocInfo = locatorInfoFromRef(targetRef) || (data ? { selectorType: 'css', value: data } : null);
          if (!targetLocInfo) throw new Error('Data (target selector) is required for DRAG_AND_DROP step');
          const sourceLocator = await getSmartLocator();

          // Also wait for target element
          const targetLocator = createLocator(targetLocInfo).locator;
          await targetLocator.first().waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT });

          await sourceLocator.dragTo(targetLocator, { timeout: DEFAULT_TIMEOUT });
          break;
        }

        case 'UPLOAD_FILE': {
          // Alias for ATTACH_FILE for backward compatibility
          if (!data) throw new Error('Data (file path) is required for UPLOAD_FILE step');
          const locator = await getSmartLocator();
          const filePaths = data.split(',').map(p => p.trim());
          await locator.setInputFiles(filePaths, { timeout: DEFAULT_TIMEOUT });
          break;
        }

        case 'uiExtract':
          // Do nothing, just wait for the element if there is a target
          if (resolvedSelector) {
            await getSmartLocator({ skipActionabilityCheck: true });
          }
          break;

        case 'assertVisible':
        case 'assertHidden':
        case 'assertInvisible':
        case 'assertEnabled':
        case 'assertDisabled':
        case 'assertChecked':
        case 'assertUnchecked':
        case 'assertText':
        case 'assertValue':
        case 'assertUrl':
        case 'assertTitle':
        case 'assertAttribute':
          break;

        case 'assertNotExist': {
          if (!resolvedSelector) break;
          let found = false;
          try {
            await getSmartLocator({ skipActionabilityCheck: true });
            found = true;
          } catch {
            found = false;
          }
          if (found) {
            throw new Error(`Element exists but was expected to not exist: ${resolvedSelector}`);
          }
          break;
        }

        default:
          if (step.action.startsWith('assert')) break;
          throw new Error(`Unsupported UI action: ${step.action}`);
      }
    })();

    if (waitPromise) {
      try {
        const [apiResponse] = await Promise.all([waitPromise, actionPromise]);

      let responseText: string | undefined;
      try { responseText = await apiResponse.text(); } catch (e) { /* ignore */ }
      // U5: stash for assertion context (API_BODY_JSON / API_STATUS / API_HEADER)
      capturedResponseBody = responseText;
      capturedResponseStatus = apiResponse.status();
      try { capturedResponseHeaders = apiResponse.headers(); } catch { /* ignore */ }

      // Process API Extractors if any
        if (step.waitForNetwork?.extractors && step.waitForNetwork.extractors.length > 0) {
          let responseBody: any;
          let jsonParsed = false;

          try {
            if (responseText) {
              responseBody = JSON.parse(responseText);
              jsonParsed = true;
            }
          } catch (e) {
            if (responseText && responseText.trim().startsWith('<')) {
              try {
                const { XMLParser } = await import('fast-xml-parser');
                const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
                responseBody = parser.parse(responseText);
                jsonParsed = true;
              } catch (xmlErr) {
                // ignore
              }
            }
          }

          for (const ext of step.waitForNetwork.extractors) {
            if (!ext.name) continue;
            let extVal: string | undefined;

            try {
              if ((ext.source === 'API_BODY_JSON' || ext.source === 'API_BODY_XML') && jsonParsed && responseBody && ext.expression) {
                const result = JSONPath({ path: ext.expression, json: responseBody });
                extVal = result && result.length > 0 ? String(result[0]) : undefined;
              } else if (ext.source === 'API_BODY_REGEX' && responseText && ext.expression) {
                const match = new RegExp(ext.expression).exec(responseText);
                if (match && match[1]) {
                  extVal = match[1];
                } else if (match && match[0]) {
                  extVal = match[0];
                }
              } else if (ext.source === 'API_HEADER' && ext.expression) {
                const headers = apiResponse.headers();
                extVal = headers[ext.expression.toLowerCase()];
              }

              if (extVal !== undefined) {
                executionContext.setRuntimeVar(ext.name, extVal, ext.scope);
                if (ext.scope === 'ENVIRONMENT' && onEnvVarExtracted) {
                  onEnvVarExtracted(ext.name, extVal);
                }
                if (!extractedValue) extractedValue = extVal;

                logs.push({
                  status: 'INFO',
                  level: 'info',
                  message: `    📥 Smart Wait Extracted Variable: ${ext.name} = ${extVal.length > 50 ? extVal.substring(0, 50) + '...' : extVal}`
                });
              } else {
                logs.push({
                  status: 'WARN',
                  level: 'warn',
                  message: `    ⚠️ Smart Wait Extractor failed to find value for: ${ext.name}`
                });
              }
            } catch (err) {
              Log.for('ui-exec').error(`Network Extractor ${ext.name} failed: ${err}`);
              logs.push({
                status: 'WARN',
                level: 'warn',
                message: `    ⚠️ Smart Wait Extractor error for ${ext.name}: ${err instanceof Error ? err.message : String(err)}`
              });
            }
          }
        }
      } catch (error: any) {
        if (error.message.includes('Timeout') || error.name === 'TimeoutError') {
          throw new Error(`UI Action executed, but expected API (${step.waitForNetwork.urlPattern}) did not respond or status did not match within ${step.waitForNetwork.timeoutMs || 10000}ms.`);
        }
        throw error;
      }
    } else {
      await actionPromise;
    }

    // ─── Process Extractors ───
    if (step.extractors && step.extractors.length > 0) {
      for (const extractor of step.extractors) {
        if (!extractor.name) continue;
        let extVal: string | undefined;

        try {
          if (extractor.source === 'UI_PAGE_URL') {
            extVal = this.page.url();
          } else if (extractor.source === 'UI_PAGE_TITLE') {
            extVal = await this.page.title();
          } else {
            // For element-based extractors, we need a target
            if (!resolvedSelector) {
              Log.for('ui-exec').warn(`Extractor ${extractor.name} requires a target element.`);
              continue;
            }
            const locator = await getSmartLocator({ skipActionabilityCheck: true });

            if (extractor.source === 'UI_TEXT') {
              extVal = await locator.textContent({ timeout: DEFAULT_TIMEOUT }) || undefined;
            } else if (extractor.source === 'UI_VALUE') {
              extVal = await locator.inputValue({ timeout: DEFAULT_TIMEOUT });
            } else if (extractor.source === 'UI_ATTRIBUTE' && extractor.expression) {
              extVal = await locator.getAttribute(extractor.expression, { timeout: DEFAULT_TIMEOUT }) || undefined;
            }
          }

          if (extVal !== undefined) {
            executionContext.setRuntimeVar(extractor.name, extVal, extractor.scope);
            if (extractor.scope === 'ENVIRONMENT' && onEnvVarExtracted) {
              onEnvVarExtracted(extractor.name, extVal);
            }
            // If it's the only extractor and we don't have extractedValue yet, set it for the result
            if (!extractedValue) extractedValue = extVal;

            logs.push({
              status: 'INFO',
              level: 'info',
              message: `  📥 Extracted Variable: ${extractor.name} = ${extVal.length > 50 ? extVal.substring(0, 50) + '...' : extVal}`
            });
          } else {
            logs.push({
              status: 'WARN',
              level: 'warn',
              message: `  ⚠️ Extractor failed to find value for: ${extractor.name}`
            });
          }
        } catch (err) {
          Log.for('ui-exec').error(`UI Extractor ${extractor.name} failed: ${err}`);
          logs.push({
            status: 'WARN',
            level: 'warn',
            message: `  ⚠️ Extractor error for ${extractor.name}: ${err instanceof Error ? err.message : String(err)}`
          });
        }
      }
    }

    // ─── Process Step-Level Assertions ───
    if (step.assertions && step.assertions.length > 0) {
      // 断言值（expectedValue / expression / UI_ATTRIBUTE 属性名）在运行期插值：
      // AI 编译器落库的参数化断言（如 {{username}}）必须在此解析为真实值。
      const resolveAssertion = (a: StepAssertion): StepAssertion => ({
        ...a,
        ...(a.expectedValue !== undefined ? { expectedValue: executionContext.interpolate(a.expectedValue) } : {}),
        ...(a.expression ? { expression: executionContext.interpolate(a.expression) } : {}),
      });
      const resolvedAssertions = step.assertions.map(resolveAssertion);
      const attributeNames = resolvedAssertions
        .filter(a => a.source === 'UI_ATTRIBUTE' && a.expression)
        .map(a => a.expression!);
      const uiCtx = await buildUiAssertionContext(this.page, resolvedSelector ? await getSmartLocator({ skipActionabilityCheck: true }) : null, attributeNames);
      const context: AssertionContext = {
        body: capturedResponseBody ?? '',
        headers: capturedResponseHeaders,
        status: capturedResponseStatus,
        ui: uiCtx,
      };
const results = evaluateAssertions(context, resolvedAssertions, step.failureStrategy || 'fail-fast');
      for (const res of results) {
        const { assertion, actualValue, passed, message } = res;
        const source = assertion.source;
        const expr = assertion.expression ? ` ${assertion.expression}` : '';
        const op = assertion.operator;
        const expectedStr = assertion.expectedValue !== undefined ? `Expected: '${assertion.expectedValue}'` : '';
        const actualStr = actualValue !== undefined ? `Actual: '${typeof actualValue === 'object' ? JSON.stringify(actualValue) : actualValue}'` : '';
        const detailParts = [expectedStr, actualStr].filter(Boolean);
        const logSuffix = detailParts.length > 0 ? ` (${detailParts.join(', ')})` : '';

        if (passed) {
          logs.push({
            status: 'PASS',
            level: 'success',
            message: ` ✅ Assertion Passed: [${source}]${expr} ${op}${logSuffix}`,
            // 结构化断言结果：编译期确认运行（docs/07 阶段 D）据此收割，避免解析日志文本
            metadata: { assertionId: assertion.id, passed: true, actualValue: actualStr },
          } as any);
        } else {
          const isMismatch = message.includes('Expected') && message.includes('but got');
          const errorDetail = isMismatch ? '' : ` — ${message}`;
          logs.push({
            status: 'FAIL',
            level: 'error',
            message: ` ❌ Assertion Failed: [${source}]${expr} ${op}${logSuffix}${errorDetail}`,
            metadata: { assertionId: assertion.id, passed: false, actualValue: actualStr },
          } as any);
        }
      }

const anyFailed = hasFailedAssertions(results);
      if (anyFailed) {
        const failure = results.find(r => !r.passed);
        const err = new Error(failure?.message || 'UI Assertion Failed');
        (err as any).isAssertionFailure = true;
        if (step.failureStrategy !== 'soft') {
          throw err;
        }
      }
    }

    const durationMs = Date.now() - startTime;
    let screenshotBase64: string | undefined;

    if (step.screenshot) {
      screenshotBase64 = await this.takeScreenshot();
    }

    return {
      durationMs,
      screenshot: screenshotBase64,
      extractedValue,
      assertionDetails,
      logs,
    };
  }

  async takeScreenshot(): Promise<string> {
    if (!this.page) return '';
    try {
      // Wait for 0.5s to allow animations/renders to settle before screenshot
      await this.page.waitForTimeout(500);
      const buffer = await this.page.screenshot({ type: 'jpeg', quality: SCREENSHOT_QUALITY });
      return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    } catch (e) {
      Log.for('ui-exec').error(`Screenshot failed: ${e}`);
      return '';
    }
  }

  async captureStateScreenshot(): Promise<string> {
    return this.takeScreenshot();
  }

  async cleanup(): Promise<void> {
    try {
      // Remove dialog handler if exists
      if (this.dialogHandler && this.page) {
        this.page.off('dialog', this.dialogHandler);
        this.dialogHandler = null;
      }

      if (this.page) {
        await this.page.close().catch(() => { });
      }
      if (this.context) {
        await this.context.close().catch(() => { });
      }
      if (this.browser) {
        await this.browser.close().catch(() => { });
      }
    } finally {
      this.page = null;
      this.context = null;
      this.browser = null;
    }
  }
}
