/**
 * POC: Does Stagehand v3 act() work with Playwright's _enableRecorder?
 *
 * HYPOTHESIS:
 *   Stagehand v3 operates at the CDP level (Input.dispatchMouseEvent).
 *   _enableRecorder monitors CDP DOM events and resolves selectors from
 *   the accessibility tree. Therefore, Stagehand's CDP-driven actions
 *   SHOULD be captured by _enableRecorder.
 *
 * ALTERNATIVE:
 *   If Stagehand uses its own CDP session (not the Playwright context's),
 *   _enableRecorder may not see the events, and recording will fail.
 *
 * ARCHITECTURE:
 *   Test 1: Stagehand launches browser → Playwright connects via CDP → _enableRecorder
 *   Test 2: Stagehand act() → _enableRecorder captures?
 *   Test 3: Stagehand observe() → what selector format?
 *   Test 4: Baseline — Playwright getByRole().click() → _enableRecorder
 *
 * PREREQUISITES:
 *   Set environment variables for your OpenAI-compatible provider:
 *     $env:MODEL_API_KEY="your-key"
 *     $env:MODEL_BASE_URL="https://your-endpoint/v1"   (optional, defaults to OpenAI)
 *     $env:MODEL_NAME="gpt-4o"                          (optional, defaults to openai/gpt-4o)
 *
 * USAGE:
 *   npx vitest run agent/recorder/__tests__/stagehand-recorder-poc.test.ts
 */
import { describe, it, expect, vi } from 'vitest';

const TEST_HTML = `
<html><body>
  <button id="btn" aria-label="Submit button">Submit</button>
  <input id="inp" type="text" aria-label="Username" />
  <button id="nav" aria-label="Navigate away">Go</button>
</body></html>`;

const TEST_HTML_RICH = `
<html><body>
  <input id="name" type="text" aria-label="Full name" />
  <select id="color" aria-label="Favorite color">
    <option value="">Pick a color</option>
    <option value="red">Red</option>
    <option value="blue">Blue</option>
    <option value="green">Green</option>
  </select>
  <a id="link" href="#target" aria-label="Go to target">Navigate</a>
  <div id="target">Target section</div>
</body></html>`;

// Build Stagehand model config from environment (compatible with project's provider)
// Stagehand v3 requires "provider/model" format and supports custom baseURL via modelClientOptions
function getStagehandConfig() {
  const apiKey = process.env.MODEL_API_KEY || process.env.OPENAI_API_KEY || process.env.AZURE_API_KEY || '';
  const baseURL = process.env.MODEL_BASE_URL || undefined;
  const rawModel = process.env.MODEL_NAME || 'openai/gpt-4o';

  // Ensure provider prefix (e.g. "openai/deepseek-v4-flash")
  const modelName = rawModel.includes('/') ? rawModel : `openai/${rawModel}`;

  // Use Playwright's Chromium executable (chrome-launcher may not find Chrome in CI/sandbox)
  let executablePath: string | undefined;
  try {
    executablePath = require('playwright').chromium.executablePath();
  } catch {
    // Fallback: let chrome-launcher find it
  }

  // Stagehand v3 model config
  const config: any = {
    env: 'LOCAL' as const,
    model: modelName,
    verbose: 1 as const,
    debugDom: true,
    localBrowserLaunchOptions: { headless: true, ...(executablePath ? { executablePath } : {}) },
  };

  // Pass API key and custom options via modelClientOptions
  const clientOptions: any = { apiKey };
  if (baseURL) {
    clientOptions.baseURL = baseURL;
  }

  // Azure-specific options
  const azureResourceName = process.env.AZURE_RESOURCE_NAME;
  const azureDeployment = process.env.AZURE_DEPLOYMENT;
  const azureApiVersion = process.env.AZURE_API_VERSION;
  if (azureResourceName) {
    clientOptions.resourceName = azureResourceName;
  }
  if (azureDeployment) {
    // Azure model name = deployment name
    config.model = `azure/${azureDeployment}`;
  }
  if (azureApiVersion) {
    clientOptions.apiVersion = azureApiVersion;
  }

  config.modelClientOptions = clientOptions;

  return config;
}

const hasApiKey = !!(
  process.env.MODEL_API_KEY
  || process.env.OPENAI_API_KEY
  || (process.env.AZURE_API_KEY && process.env.AZURE_DEPLOYMENT)
);
const aiIt = it.skipIf(!hasApiKey);

describe('Stagehand v3 + _enableRecorder compatibility POC', () => {
  /**
   * Test 1: Stagehand launches browser → Playwright connectOverCDP → _enableRecorder
   *
   * This is the recommended architecture:
   *   Stagehand owns the browser (LOCAL mode)
   *   Playwright connects via CDP to the same browser
   *   _enableRecorder is set up on the Playwright context
   *   Stagehand act() performs actions
   *   _enableRecorder should capture them
   */
  aiIt(
    'Test 1: Stagehand act() via CDP-connected Playwright + _enableRecorder',
    async () => {
      const { Stagehand } = await import('@browserbasehq/stagehand');
      const { chromium } = await import('playwright');
      const { PlaywrightRecorderAdapter } = await import('../adapter');

      const config = getStagehandConfig();
      console.log('[CONFIG] model:', config.model, 'baseURL:', config.modelClientOptions?.baseURL || '(default)');

      // 1. Initialize Stagehand (LOCAL mode — launches its own Chrome)
      const stagehand = new Stagehand(config);

      try {
        await stagehand.init();
        console.log('[STAGEHAND] initialized');

        // 2. Connect Playwright to Stagehand's browser via CDP
        const connectURL = stagehand.connectURL();
        console.log('[CDP] connectURL:', connectURL);

        const pwBrowser = await chromium.connectOverCDP({ wsEndpoint: connectURL });
        const pwContext = pwBrowser.contexts()[0];
        const pwPage = pwContext.pages()[0];

        // 3. Check _enableRecorder availability on the connected context
        const recorderAvailable = PlaywrightRecorderAdapter.isAvailable(pwContext as any);
        console.log('[RECORDER] available on CDP-connected context:', recorderAvailable);

        if (!recorderAvailable) {
          console.warn(
            '❌ _enableRecorder NOT available on CDP-connected context.\n' +
            '   This means Playwright cannot use _enableRecorder when connected via CDP.\n' +
            "   Falling back to Test 2 approach (Stagehand's own page)."
          );
          await stagehand.close();
          await pwBrowser.close();
          return;
        }

        // 4. Set up _enableRecorder
        const onActionAdded = vi.fn();
        const adapter = new PlaywrightRecorderAdapter({
          onActionAdded: onActionAdded as any,
        });
        adapter.start(pwContext as any);

        // 5. Navigate
        await pwPage.goto(`data:text/html,${encodeURIComponent(TEST_HTML)}`);
        await new Promise((r) => setTimeout(r, 1500));

        // 6. Perform action via Stagehand act() with the Playwright page
        onActionAdded.mockClear();
        console.log('[ACT] clicking the Submit button via Stagehand...');

        try {
          const result = await stagehand.act('click the Submit button', {
            page: pwPage as any,
          });
          console.log('[ACT RESULT]', JSON.stringify(result, null, 2));
        } catch (actErr: any) {
          console.log('[ACT ERROR]', actErr.message);
        }

        // 7. Wait and check
        await new Promise((r) => setTimeout(r, 3000));

        const fired = onActionAdded.mock.calls.length > 0;
        console.log('[RESULT] _enableRecorder captured:', fired);
        console.log('[RESULT] calls:', onActionAdded.mock.calls.length);

        if (fired) {
          for (let i = 0; i < onActionAdded.mock.calls.length; i++) {
            const aic = onActionAdded.mock.calls[i]?.[1];
            console.log(`[RESULT] call[${i}] action:`, aic?.action?.name, 'selector:', aic?.action?.selector);
            console.log(`[RESULT] call[${i}] ariaSnapshot:`, aic?.action?.ariaSnapshot?.slice(0, 200));
          }
        }

        console.log(
          fired
            ? '✅ COMPATIBLE: Stagehand act() + _enableRecorder works via CDP connection'
            : '❌ NOT COMPATIBLE: _enableRecorder did not capture Stagehand actions via CDP'
        );

        await adapter.stop();
        await pwBrowser.close();
      } finally {
        await stagehand.close().catch(() => {});
      }
    },
    120000
  );

  /**
   * Test 1b: Multiple operation types — fill, selectOption, navigate
   *
   * Click is proven. But fill and select go through different CDP paths.
   * This test validates that _enableRecorder captures them too.
   */
  aiIt(
    'Test 1b: Stagehand act() fill + select + navigate + _enableRecorder',
    async () => {
      const { Stagehand } = await import('@browserbasehq/stagehand');
      const { chromium } = await import('playwright');
      const { PlaywrightRecorderAdapter } = await import('../adapter');

      const config = getStagehandConfig();

      const stagehand = new Stagehand(config);

      try {
        await stagehand.init();
        const connectURL = stagehand.connectURL();
        const pwBrowser = await chromium.connectOverCDP({ wsEndpoint: connectURL });
        const pwContext = pwBrowser.contexts()[0];
        const pwPage = pwContext.pages()[0];

        if (!PlaywrightRecorderAdapter.isAvailable(pwContext as any)) {
          console.warn('[SKIP] _enableRecorder not available on CDP context');
          await stagehand.close();
          await pwBrowser.close();
          return;
        }

        const onActionAdded = vi.fn();
        const adapter = new PlaywrightRecorderAdapter({
          onActionAdded: onActionAdded as any,
        });
        adapter.start(pwContext as any);

        await pwPage.goto(`data:text/html,${encodeURIComponent(TEST_HTML_RICH)}`);
        await new Promise((r) => setTimeout(r, 1500));

        // --- Test fill ---
        onActionAdded.mockClear();
        console.log('[FILL] typing into Full name field...');
        try {
          await stagehand.act('type "John Doe" into the Full name field', { page: pwPage as any });
        } catch (e: any) { console.log('[FILL ERROR]', e.message); }
        await new Promise((r) => setTimeout(r, 2000));

        const fillCaptured = onActionAdded.mock.calls.length > 0;
        console.log('[FILL] _enableRecorder captured:', fillCaptured);
        if (fillCaptured) {
          const aic = onActionAdded.mock.calls[onActionAdded.mock.calls.length - 1]?.[1];
          console.log('[FILL] action:', aic?.action?.name, 'selector:', aic?.action?.selector);
        }

        // --- Test selectOption ---
        onActionAdded.mockClear();
        console.log('[SELECT] choosing Blue from Favorite color...');
        try {
          await stagehand.act('select "Blue" from the Favorite color dropdown', { page: pwPage as any });
        } catch (e: any) { console.log('[SELECT ERROR]', e.message); }
        await new Promise((r) => setTimeout(r, 2000));

        const selectCaptured = onActionAdded.mock.calls.length > 0;
        console.log('[SELECT] _enableRecorder captured:', selectCaptured);
        if (selectCaptured) {
          const aic = onActionAdded.mock.calls[onActionAdded.mock.calls.length - 1]?.[1];
          console.log('[SELECT] action:', aic?.action?.name, 'selector:', aic?.action?.selector);
        }

        // --- Test navigate (click link) ---
        onActionAdded.mockClear();
        console.log('[NAV] clicking the Navigate link...');
        try {
          await stagehand.act('click the Navigate link', { page: pwPage as any });
        } catch (e: any) { console.log('[NAV ERROR]', e.message); }
        await new Promise((r) => setTimeout(r, 2000));

        const navCaptured = onActionAdded.mock.calls.length > 0;
        console.log('[NAV] _enableRecorder captured:', navCaptured);
        if (navCaptured) {
          const aic = onActionAdded.mock.calls[onActionAdded.mock.calls.length - 1]?.[1];
          console.log('[NAV] action:', aic?.action?.name, 'selector:', aic?.action?.selector);
        }

        // Summary
        console.log('\n=== Multi-Operation POC Summary ===');
        console.log(`  fill:       ${fillCaptured ? '✅' : '❌'}`);
        console.log(`  select:     ${selectCaptured ? '✅' : '❌'}`);
        console.log(`  navigate:   ${navCaptured ? '✅' : '❌'}`);

        await adapter.stop();
        await pwBrowser.close();
      } finally {
        await stagehand.close().catch(() => {});
      }
    },
    180000
  );

  /**
   * Test 2: Stagehand act() on its own page — does it produce usable output?
   *
   * Even if _enableRecorder doesn't work, Stagehand act() returns
   * ActResult with selector info. Can we use that to build TestSteps?
   */
  aiIt(
    'Test 2: Stagehand act() on its own page — ActResult analysis',
    async () => {
      const { Stagehand } = await import('@browserbasehq/stagehand');

      const config = getStagehandConfig();

      const stagehand = new Stagehand(config);

      try {
        await stagehand.init();
        const page = stagehand.context.pages()[0];

        await page.goto(`data:text/html,${encodeURIComponent(TEST_HTML)}`);
        await new Promise((r) => setTimeout(r, 1500));

        // Test act()
        console.log('[ACT] clicking the Submit button...');
        const actResult = await stagehand.act('click the Submit button', { page });
        console.log('[ACT RESULT]', JSON.stringify(actResult, null, 2));

        // Analyze: what selector format does act() return?
        if (actResult?.actions) {
          for (const action of actResult.actions) {
            console.log('[ACT] selector:', action.selector);
            console.log('[ACT] method:', action.method);
            console.log('[ACT] description:', action.description);
          }
        }

        // Test fill
        await page.goto(`data:text/html,${encodeURIComponent(TEST_HTML)}`);
        await new Promise((r) => setTimeout(r, 1000));

        console.log('[ACT] filling the Username field...');
        const fillResult = await stagehand.act('type "hello" into the Username field', { page });
        console.log('[FILL RESULT]', JSON.stringify(fillResult, null, 2));
      } finally {
        await stagehand.close().catch(() => {});
      }
    },
    120000
  );

  /**
   * Test 3: Stagehand observe() — what selector format does it return?
   */
  aiIt(
    'Test 3: Stagehand observe() — selector format analysis',
    async () => {
      const { Stagehand } = await import('@browserbasehq/stagehand');

      const config = getStagehandConfig();

      const stagehand = new Stagehand(config);

      try {
        await stagehand.init();
        const page = stagehand.context.pages()[0];

        await page.goto(`data:text/html,${encodeURIComponent(TEST_HTML)}`);
        await new Promise((r) => setTimeout(r, 1500));

        const actions = await stagehand.observe('find all interactive elements', { page });
        console.log('[OBSERVE] found', actions.length, 'actions');

        for (const action of actions) {
          console.log('[OBSERVE]', JSON.stringify(action));
        }

        // Key question: are selectors XPath or CSS or role-based?
        if (actions.length > 0) {
          const selectorTypes = actions.map(a => {
            if (a.selector.startsWith('xpath=')) return 'xpath';
            if (a.selector.startsWith('internal:')) return 'internal';
            if (a.selector.startsWith('//')) return 'xpath-no-prefix';
            return 'other: ' + a.selector.slice(0, 30);
          });
          console.log('[OBSERVE] selector types:', [...new Set(selectorTypes)]);
        }
      } finally {
        await stagehand.close().catch(() => {});
      }
    },
    120000
  );

  /**
   * Test 4: Baseline — Playwright getByRole().click() captured by _enableRecorder
   *
   * This confirms _enableRecorder works with standard Playwright operations.
   */
  it(
    'Test 4: Baseline — Playwright getByRole().click() + _enableRecorder',
    async () => {
      const { chromium } = await import('playwright');
      const { PlaywrightRecorderAdapter } = await import('../adapter');

      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();

      if (!PlaywrightRecorderAdapter.isAvailable(context as any)) {
        console.warn('[SKIP] _enableRecorder not available');
        await browser.close();
        return;
      }

      const onActionAdded = vi.fn();
      const adapter = new PlaywrightRecorderAdapter({ onActionAdded: onActionAdded as any });
      adapter.start(context as any);

      const page = await context.newPage();
      await page.goto(`data:text/html,${encodeURIComponent(TEST_HTML)}`);
      await new Promise((r) => setTimeout(r, 1000));

      onActionAdded.mockClear();
      await page.getByRole('button', { name: 'Submit' }).click();
      await new Promise((r) => setTimeout(r, 2000));

      const fired = onActionAdded.mock.calls.length > 0;
      console.log('[BASELINE] _enableRecorder captured Playwright click:', fired);

      if (fired) {
        const call = onActionAdded.mock.calls[0];
        const aic = call?.[1];
        console.log('[BASELINE] selector:', aic?.action?.selector);
        console.log('[BASELINE] ariaSnapshot:', aic?.action?.ariaSnapshot?.slice(0, 200));
      }

      expect(fired).toBe(true);

      await adapter.stop();
      await browser.close();
    },
    60000
  );
});
