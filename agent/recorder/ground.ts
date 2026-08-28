/**
 * Ground — 证据包采集（转化管线阶段 B，见 docs/07 §4-B）
 *
 * 在 NL 步骤边界处采集结构化页面状态（Evidence Pack），是后续编译的唯一事实来源：
 *   - 页面级：URL / title / 正文摘录 / aria snapshot 摘录
 *   - 输入级：页面输入框实际值（升级自原 collectVerificationText）
 *   - 元素级：边界内被操作元素的 post-action 状态（text/value/tag/visible）
 *
 * 设计约束：
 *   - 全程 try/catch + 有界采集，任何探测失败不阻断录制主流程
 *   - DOM 探测只在边界验证时刻进行（状态最新鲜）；payload 清单由调用方提供
 *     （consolidator 会缓冲 click/fill，session 需另存原始 payload 流）
 */
import type { Page } from 'playwright';
import type { LocatorRef, RecorderStepPayload } from './protocol.ts';

export interface ActedElementEvidence {
  /** 边界内原始 payload 的序号（0-based），作为断言依托的稳定引用键 */
  payloadIndex: number;
  action: string;
  selector?: string;
  tag?: string;
  value?: string;
  text?: string;
  visible?: boolean;
}

export interface EvidencePack {
  nlStepIndex: number;
  pageUrl: string;
  pageTitle?: string;
  /** body innerText 有界摘录，供验证期关键词兜底比对 */
  textExcerpt: string;
  inputValues: Array<{ name: string; value: string }>;
  ariaExcerpt?: string;
  actedElements: ActedElementEvidence[];
  /**
   * 本边界真实捕获的网络请求（Playwright requestfinished 捕获的 XHR/Fetch）。
   * API 相关断言必须以它为事实来源——AI intent 的 urlPattern 只能当候选，不能直接落库。
   */
  networkCalls: Array<{ method: string; url: string; pathname: string; status: number }>;
}

const MAX_TEXT_CHARS = 5000;
const MAX_ARIA_CHARS = 4000;
const MAX_ELEMENT_TEXT_CHARS = 300;
const MAX_PROBED_ELEMENTS = 3;

export interface ProbeTarget {
  payloadIndex: number;
  action: string;
  locator: LocatorRef;
}

/**
 * 纯函数：从边界 payload 选出值得 DOM 探测的元素目标。
 * - 跳过无元素依托的动作（goto）与缺 locator 的 payload
 * - 同一 selector 去重，保留最后一次操作（post-action 状态以最新为准）
 * - 取最近 N 条（MAX_PROBED_ELEMENTS），返回保持时间正序
 */
export function selectProbeTargets(payloads: RecorderStepPayload[]): ProbeTarget[] {
  const bySelector = new Map<string, ProbeTarget>();
  payloads.forEach((p, payloadIndex) => {
    if (p.action === 'goto' || !p.locator) return;
    bySelector.set(p.locator.selector, { payloadIndex, action: p.action, locator: p.locator });
  });
  const all = [...bySelector.values()];
  return all.slice(-MAX_PROBED_ELEMENTS);
}

/**
 * 纯函数：Evidence Pack → 旧版 enrichment 字符串（"name: value" 行 + 正文摘录）。
 * 保持现有验证逻辑（lastFilledValue / 关键词兜底 / 日志摘录）行为不变。
 */
export function formatLegacyEnrichment(pack: EvidencePack): string {
  const inputLines = pack.inputValues.map((i) => `${i.name}: ${i.value}`);
  return [...inputLines, pack.textExcerpt].filter(Boolean).join('\n');
}

/**
 * 单个元素的 post-action 状态探测。全部字段独立 try/catch + 短超时，
 * 任一失败只影响该字段（undefined），不抛出。
 */
async function probeElement(page: Page, ref: LocatorRef): Promise<Partial<ActedElementEvidence>> {
  const out: Partial<ActedElementEvidence> = {};
  try {
    const loc = page.locator(ref.selector).first();
    try { out.tag = await loc.evaluate((el) => el.tagName.toLowerCase(), undefined, { timeout: 1000 }); } catch {}
    try { out.value = await loc.inputValue({ timeout: 1000 }); } catch {}
    try { out.text = ((await loc.textContent({ timeout: 1000 })) || '').slice(0, MAX_ELEMENT_TEXT_CHARS) || undefined; } catch {}
    try { out.visible = await loc.isVisible(); } catch {}
  } catch {}
  return out;
}

/**
 * 采集一个 NL 步骤边界的证据包。永不抛出——采集失败的字段留空。
 */
export async function collectEvidencePack(
  page: Page,
  args: {
    nlStepIndex: number;
    payloads: RecorderStepPayload[];
    /** 本边界真实捕获的网络请求（与 capturedApis 一致，见证据包定义） */
    networkCalls?: Array<{ method: string; url: string; pathname?: string; status: number }>;
  },
): Promise<EvidencePack> {
  const pack: EvidencePack = {
    nlStepIndex: args.nlStepIndex,
    pageUrl: '',
    textExcerpt: '',
    inputValues: [],
    actedElements: [],
    networkCalls: (args.networkCalls ?? []).map((c) => {
      let pathname = c.url;
      try { pathname = new URL(c.url).pathname; } catch { /* keep raw */ }
      return { method: c.method, url: c.url, pathname, status: c.status };
    }),
  };
  try { pack.pageUrl = page.url(); } catch {}
  try { pack.pageTitle = await page.title(); } catch {}
  try {
    const result = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, textarea'))
        .slice(0, 50)
        .map((el) => {
          const iel = el as HTMLInputElement;
          const name = iel.name || iel.id || iel.type || 'input';
          return { name, value: iel.value || '' };
        });
      return { inputs, bodyText: (document.body?.innerText || '').slice(0, MAX_TEXT_CHARS) };
    });
    pack.inputValues = result.inputs;
    pack.textExcerpt = result.bodyText;
  } catch {}
  try {
    pack.ariaExcerpt = (await page.locator('body').ariaSnapshot()).slice(0, MAX_ARIA_CHARS);
  } catch {}
  for (const target of selectProbeTargets(args.payloads)) {
    const probed = await probeElement(page, target.locator);
    pack.actedElements.push({
      payloadIndex: target.payloadIndex,
      action: target.action,
      selector: target.locator.selector,
      ...probed,
    });
  }
  return pack;
}
