import { describe, it, expect, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { compilePrdGate, computePrdDiff, parsePrdDocument } from '../prd-parser.ts';
import type { Requirement, PrdParsedPreviewItem } from '../../../../shared/contracts/index.ts';
import { providerConfigRepo } from '../../provider-configs/repository.ts';
import * as providerModule from '../../ai-test-gen/infra/provider.ts';

describe('prd-parser compilePrdGate', () => {
  it('validates hierarchy and ensures epics have parentId = null', () => {
    const raw = [
      { tempId: 'e1', level: 'epic', title: 'Auth Epic', description: 'Authentication module', parentTempId: 'some-dummy' },
      { tempId: 's1', level: 'story', title: 'Login Story', description: 'User login', parentTempId: 'e1' },
      { tempId: 'a1', level: 'ac', title: 'Valid AC', description: 'Given valid credentials\nWhen user clicks login\nThen user is authenticated', parentTempId: 's1' },
    ];

    const result = compilePrdGate(raw);
    expect(result.items).toHaveLength(3);
    expect(result.items[0].level).toBe('epic');
    expect(result.items[0].parentId).toBeNull();
    expect(result.items[1].level).toBe('story');
    expect(result.items[1].parentId).toBe(result.items[0].id);
    expect(result.items[2].level).toBe('ac');
    expect(result.items[2].parentId).toBe(result.items[1].id);
    expect(result.warnings).toHaveLength(0);
  });

  it('handles out-of-order parent-child definitions in two passes', () => {
    // Child (s1) appears BEFORE parent (e1) in array
    const raw = [
      { tempId: 's1', level: 'story', title: 'Out of order Story', description: 'Child first', parentTempId: 'e1' },
      { tempId: 'e1', level: 'epic', title: 'Parent Epic', description: 'Parent second' },
    ];

    const result = compilePrdGate(raw);
    expect(result.items).toHaveLength(2);
    const story = result.items.find((i) => i.title === 'Out of order Story');
    const epic = result.items.find((i) => i.title === 'Parent Epic');
    expect(story).toBeDefined();
    expect(epic).toBeDefined();
    expect(story!.parentId).toBe(epic!.id);
  });

  it('handles orphan items with invalid parentTempId and emits warnings', () => {
    const raw = [
      { tempId: 'e1', level: 'epic', title: 'Main Epic' },
      { tempId: 'a1', level: 'ac', title: 'Orphan AC', description: 'Given x\nWhen y\nThen z', parentTempId: 'non-existent-temp-id' },
    ];

    const result = compilePrdGate(raw);
    expect(result.items).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes('Orphan item'))).toBe(true);
    // Attaches to preceding epic context rather than creating unhandled orphan
    expect(result.items[1].parentId).toBe(result.items[0].id);
  });

  it('warns when AC does not strictly adhere to Gherkin format', () => {
    const raw = [
      { tempId: 'a1', level: 'ac', title: 'Non-Gherkin AC', description: 'User clicks submit and sees success alert' },
    ];

    const result = compilePrdGate(raw);
    expect(result.warnings.some((w) => w.includes('does not strictly follow Given/When/Then'))).toBe(true);
  });

  it('normalizes invalid level strings to story and warns', () => {
    const raw = [
      { tempId: 'x1', level: 'super-epic', title: 'Weird level' },
    ];

    const result = compilePrdGate(raw);
    expect(result.items[0].level).toBe('story');
    expect(result.warnings.some((w) => w.includes('invalid level'))).toBe(true);
  });

  it('preserves caller-supplied diffStatus and defaults to added', () => {
    // The commit flow re-runs the gate on preview output that already carries
    // diff annotations; dropping them would stamp every row APPROVED on the
    // new version and resurrect rows that should stay DEPRECATED.
    const raw = [
      { tempId: 'a1', level: 'epic', title: 'E', diffStatus: 'unchanged' },
      { tempId: 'a2', level: 'ac', title: 'M', parentTempId: 'a1', diffStatus: 'deprecated' },
      { tempId: 'a3', level: 'ac', title: 'N', parentTempId: 'a1', diffStatus: 'garbage' },
      { tempId: 'a4', level: 'ac', title: 'O', parentTempId: 'a1' },
    ];

    const result = compilePrdGate(raw);
    expect(result.items.map((i) => i.diffStatus)).toEqual(['unchanged', 'deprecated', 'added', 'added']);
  });
});

describe('prd-parser computePrdDiff', () => {
  const existingReqs: Requirement[] = [
    {
      id: 'req-auth-epic',
      projectId: 'proj-1',
      parentId: null,
      title: 'Auth Epic',
      description: 'Original Auth Epic Description',
      level: 'epic',
      status: 'APPROVED',
      position: 0,
      sourceAnchor: 'Row 2',
    },
    {
      id: 'req-login-story',
      projectId: 'proj-1',
      parentId: 'req-auth-epic',
      title: 'Login Story',
      description: 'Original Story Description',
      level: 'story',
      status: 'APPROVED',
      position: 1,
      sourceAnchor: 'Row 3',
    },
    {
      id: 'req-deleted-feature',
      projectId: 'proj-1',
      parentId: 'req-auth-epic',
      title: 'Removed Feature',
      description: 'Feature present in v1 but removed in v2',
      level: 'story',
      status: 'APPROVED',
      position: 2,
      sourceAnchor: 'Row 4',
    },
  ];

  it('detects unchanged, modified, added, and deprecated items', () => {
    const newItems: PrdParsedPreviewItem[] = [
      // 1. Unchanged item (matching anchor and identical content)
      {
        id: 'temp-1',
        title: 'Auth Epic',
        description: 'Original Auth Epic Description',
        level: 'epic',
        sourceAnchor: 'Row 2',
      },
      // 2. Modified item (matching title, changed description)
      {
        id: 'temp-2',
        title: 'Login Story',
        description: 'Updated Story Description in v2',
        level: 'story',
      },
      // 3. Newly added item
      {
        id: 'temp-3',
        title: 'New OAuth Feature',
        description: 'OAuth 2.0 login with Google',
        level: 'story',
        sourceAnchor: 'Row 5',
      },
    ];

    const { items, deprecatedCount } = computePrdDiff(newItems, existingReqs);

    const unchangedItem = items.find((i) => i.title === 'Auth Epic');
    expect(unchangedItem?.diffStatus).toBe('unchanged');
    expect(unchangedItem?.id).toBe('req-auth-epic'); // Preserved stable ID

    const modifiedItem = items.find((i) => i.title === 'Login Story');
    expect(modifiedItem?.diffStatus).toBe('modified');
    expect(modifiedItem?.id).toBe('req-login-story');

    const addedItem = items.find((i) => i.title === 'New OAuth Feature');
    expect(addedItem?.diffStatus).toBe('added');

    // 4. Deprecated item detected
    expect(deprecatedCount).toBe(1);
    const deprecatedItem = items.find((i) => i.title === 'Removed Feature');
    expect(deprecatedItem).toBeDefined();
    expect(deprecatedItem?.diffStatus).toBe('deprecated');
    expect(deprecatedItem?.id).toBe('req-deleted-feature');
  });

  it('prioritizes sourceAnchor match over title match when renaming occurs', () => {
    const existingWithAnchor: Requirement[] = [
      {
        id: 'req-stable-1',
        projectId: 'proj-1',
        parentId: null,
        title: 'Old Title Before Rename',
        description: 'Description',
        level: 'story',
        status: 'APPROVED',
        position: 0,
        sourceAnchor: 'Row 14',
      },
    ];

    const incomingItems: PrdParsedPreviewItem[] = [
      {
        id: 'temp-renamed',
        title: 'New Renamed Title',
        description: 'Description',
        level: 'story',
        sourceAnchor: 'Row 14', // Exact anchor match
      },
    ];

    const { items } = computePrdDiff(incomingItems, existingWithAnchor);
    const matched = items.find((i) => i.sourceAnchor === 'Row 14');
    expect(matched).toBeDefined();
    expect(matched?.id).toBe('req-stable-1'); // Correctly preserves stable ID across rename!
    expect(matched?.diffStatus).toBe('modified');
  });

  it('handles multi-version Excel PRDs with shared row anchors without cross-level collision or false deprecation', () => {
    // In Excel, Epic, Story, and AC often come from the same row ("Row 2")
    const v1Existing: Requirement[] = [
      {
        id: 'req-epic-auth',
        projectId: 'proj-1',
        parentId: null,
        title: 'Authentication Module',
        description: 'User authentication',
        level: 'epic',
        status: 'APPROVED',
        position: 0,
        sourceAnchor: 'Row 2',
      },
      {
        id: 'req-story-login',
        projectId: 'proj-1',
        parentId: 'req-epic-auth',
        title: 'User Login',
        description: 'Standard login with email and password',
        level: 'story',
        status: 'APPROVED',
        position: 1,
        sourceAnchor: 'Row 2',
      },
      {
        id: 'req-ac-valid-login',
        projectId: 'proj-1',
        parentId: 'req-story-login',
        title: 'Valid Credentials Login',
        description: 'Given valid user\nWhen submits credentials\nThen token issued',
        level: 'ac',
        status: 'APPROVED',
        position: 2,
        sourceAnchor: 'Row 2',
      },
      {
        id: 'req-ac-invalid-login',
        projectId: 'proj-1',
        parentId: 'req-story-login',
        title: 'Invalid Credentials Login',
        description: 'Given invalid credentials\nWhen submits\nThen error displayed',
        level: 'ac',
        status: 'APPROVED',
        position: 3,
        sourceAnchor: 'Row 3',
      },
    ];

    // Version 2:
    // - New row inserted before Login (Row 2 is now a new story "User Registration")
    // - Login is shifted to Row 3
    // - "Valid Credentials Login" has slightly updated description
    // - "Invalid Credentials Login" is unchanged
    const v2Incoming: PrdParsedPreviewItem[] = [
      {
        id: 'temp-epic',
        title: 'Authentication Module',
        description: 'User authentication',
        level: 'epic',
        parentId: null,
        sourceAnchor: 'Row 2',
      },
      {
        id: 'temp-story-reg',
        title: 'User Registration',
        description: 'New user signs up',
        level: 'story',
        parentId: 'temp-epic',
        sourceAnchor: 'Row 2',
      },
      {
        id: 'temp-story-login',
        title: 'User Login',
        description: 'Standard login with email and password',
        level: 'story',
        parentId: 'temp-epic',
        sourceAnchor: 'Row 3', // Shifted row
      },
      {
        id: 'temp-ac-valid',
        title: 'Valid Credentials Login',
        description: 'Given valid user\nWhen submits credentials\nThen token and refresh cookie issued', // Modified
        level: 'ac',
        parentId: 'temp-story-login',
        sourceAnchor: 'Row 3',
      },
      {
        id: 'temp-ac-invalid',
        title: 'Invalid Credentials Login',
        description: 'Given invalid credentials\nWhen submits\nThen error displayed', // Unchanged
        level: 'ac',
        parentId: 'temp-story-login',
        sourceAnchor: 'Row 4',
      },
    ];

    const { items, deprecatedCount } = computePrdDiff(v2Incoming, v1Existing);

    // ZERO false deprecations!
    expect(deprecatedCount).toBe(0);

    const epic = items.find((i) => i.title === 'Authentication Module');
    expect(epic).toBeDefined();
    expect(epic?.id).toBe('req-epic-auth');
    expect(epic?.diffStatus).toBe('unchanged');

    const loginStory = items.find((i) => i.title === 'User Login');
    expect(loginStory).toBeDefined();
    expect(loginStory?.id).toBe('req-story-login');
    expect(loginStory?.parentId).toBe('req-epic-auth');
    expect(loginStory?.diffStatus).toBe('unchanged');

    const regStory = items.find((i) => i.title === 'User Registration');
    expect(regStory).toBeDefined();
    expect(regStory?.diffStatus).toBe('added');
    expect(regStory?.parentId).toBe('req-epic-auth');

    const validAc = items.find((i) => i.title === 'Valid Credentials Login');
    expect(validAc).toBeDefined();
    expect(validAc?.id).toBe('req-ac-valid-login');
    expect(validAc?.parentId).toBe('req-story-login');
    expect(validAc?.diffStatus).toBe('modified');

    const invalidAc = items.find((i) => i.title === 'Invalid Credentials Login');
    expect(invalidAc).toBeDefined();
    expect(invalidAc?.id).toBe('req-ac-invalid-login');
    expect(invalidAc?.parentId).toBe('req-story-login');
    expect(invalidAc?.diffStatus).toBe('unchanged');
  });

  it('handles multi-version Markdown/Word with section number changes without breaking stable IDs', () => {
    const v1Existing: Requirement[] = [
      {
        id: 'req-epic-1',
        projectId: 'proj-1',
        parentId: null,
        title: '1.0 Overview & Setup',
        description: '',
        level: 'epic',
        status: 'APPROVED',
        position: 0,
        sourceAnchor: 'Heading: 1.0 Overview & Setup',
      },
      {
        id: 'req-story-1',
        projectId: 'proj-1',
        parentId: 'req-epic-1',
        title: '1.1 Initial Configuration',
        description: '',
        level: 'story',
        status: 'APPROVED',
        position: 1,
        sourceAnchor: 'Heading: 1.1 Initial Configuration',
      },
    ];

    // In v2, the section numbers are renumbered to 2.0 and 2.1
    const v2Incoming: PrdParsedPreviewItem[] = [
      {
        id: 'temp-epic',
        title: '2.0 Overview & Setup',
        description: '',
        level: 'epic',
        parentId: null,
        sourceAnchor: 'Heading: 2.0 Overview & Setup',
      },
      {
        id: 'temp-story',
        title: '2.1 Initial Configuration',
        description: '',
        level: 'story',
        parentId: 'temp-epic',
        sourceAnchor: 'Heading: 2.1 Initial Configuration',
      },
    ];

    const { items, deprecatedCount } = computePrdDiff(v2Incoming, v1Existing);

    expect(deprecatedCount).toBe(0);
    const matchedEpic = items.find((i) => i.title.includes('Overview & Setup'));
    expect(matchedEpic?.id).toBe('req-epic-1');
    const matchedStory = items.find((i) => i.title.includes('Initial Configuration'));
    expect(matchedStory?.id).toBe('req-story-1');
  });

  it('correctly detects genuine deprecations when an item is truly removed in v2', () => {
    const v1Existing: Requirement[] = [
      {
        id: 'req-epic-1',
        projectId: 'proj-1',
        parentId: null,
        title: 'Checkout',
        description: '',
        level: 'epic',
        status: 'APPROVED',
        position: 0,
      },
      {
        id: 'req-story-1',
        projectId: 'proj-1',
        parentId: 'req-epic-1',
        title: 'Payment Methods',
        description: '',
        level: 'story',
        status: 'APPROVED',
        position: 1,
      },
      {
        id: 'req-ac-crypto',
        projectId: 'proj-1',
        parentId: 'req-story-1',
        title: 'Pay with Bitcoin',
        description: 'Given user chooses crypto\nWhen pays\nThen order approved',
        level: 'ac',
        status: 'APPROVED',
        position: 2,
      },
    ];

    // In v2, Bitcoin payment was discontinued and removed
    const v2Incoming: PrdParsedPreviewItem[] = [
      {
        id: 'temp-epic',
        title: 'Checkout',
        description: '',
        level: 'epic',
        parentId: null,
      },
      {
        id: 'temp-story',
        title: 'Payment Methods',
        description: '',
        level: 'story',
        parentId: 'temp-epic',
      },
    ];

    const { items, deprecatedCount } = computePrdDiff(v2Incoming, v1Existing);

    expect(deprecatedCount).toBe(1);
    const deprecatedAc = items.find((i) => i.title === 'Pay with Bitcoin');
    expect(deprecatedAc).toBeDefined();
    expect(deprecatedAc?.diffStatus).toBe('deprecated');
    expect(deprecatedAc?.id).toBe('req-ac-crypto');
    expect(deprecatedAc?.parentId).toBe('req-story-1');
  });
});

describe('prd-parser parsePrdDocument', () => {
  it('parses markdown PRDs and assigns content-based Heading anchors', async () => {
    const markdown = `# User Management
## User Registration
Given new user details
When registration submitted
Then account created`;

    const result = await parsePrdDocument({
      fileName: 'spec.md',
      buffer: Buffer.from(markdown, 'utf-8'),
      projectId: 'proj-1',
      documentTitle: 'User Spec',
    });

    expect(result.fileType).toBe('markdown');
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].sourceAnchor).toMatch(/^Heading: .+$/);
    expect(result.versionTag).toBe('v1.0');
  });

  it('parses XLSX PRDs with robust header sniffing and row anchors', async () => {
    const wb = XLSX.utils.book_new();
    const wsData = [
      ['模块 (Epic)', '功能点 (Story)', '验收标准 (AC)'],
      ['Billing', 'Invoice Generation', 'Given order completed\nWhen monthly cycle triggers\nThen invoice is emitted'],
      ['Billing', 'Invoice PDF Download', 'Given invoice exists\nWhen user clicks download\nThen PDF is served'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const result = await parsePrdDocument({
      fileName: 'requirements.xlsx',
      buffer,
      projectId: 'proj-1',
      documentTitle: 'Billing Specs',
      existingVersionsCount: 2,
    });

    expect(result.fileType).toBe('xlsx');
    expect(result.versionTag).toBe('v1.2'); // Dynamic versioning
    expect(result.stats.epics).toBe(1);
    expect(result.stats.stories).toBe(2);
    expect(result.stats.acs).toBe(2);
    expect(result.items.every((i) => i.sourceAnchor?.startsWith('Row'))).toBe(true);
  });

  it('calls AI provider when providerConfigId is provided for Markdown PRD', async () => {
    vi.spyOn(providerConfigRepo, 'get').mockReturnValue({
      id: 'prov-mock',
      projectId: 'proj-1',
      name: 'Mock Provider',
      type: 'openai-compatible',
      endpoint: 'https://api.openai.com/v1',
      encryptedApiKey: 'dummy',
      deployment: '',
      apiVersion: '',
      model: 'gpt-4o',
      models: ['gpt-4o'],
      fallbackConfigIds: [],
      monthlyTokenLimit: 1000,
      isActive: true,
      createdAt: '2026-10-27',
    });

    const mockAiResponse = JSON.stringify({
      items: [
        { tempId: 'e1', level: 'epic', title: 'AI Epic', description: 'Parsed by AI' },
        { tempId: 's1', parentTempId: 'e1', level: 'story', title: 'AI Story', description: 'Parsed by AI' },
        { tempId: 'a1', parentTempId: 's1', level: 'ac', title: 'AI AC', description: 'Given AI precondition\nWhen action happens\nThen result verified' },
      ],
    });

    vi.spyOn(providerModule, 'createAIProvider').mockReturnValue({
      streamChat: async function* () {
        yield { type: 'content', content: mockAiResponse };
      },
    } as any);

    const markdown = `# Raw Text PRD
Some free-form requirement content here.`;

    const result = await parsePrdDocument({
      fileName: 'spec.md',
      buffer: Buffer.from(markdown, 'utf-8'),
      projectId: 'proj-1',
      documentTitle: 'AI Spec',
      providerConfigId: 'prov-mock',
      model: 'gpt-4o',
    });

    expect(result.items).toHaveLength(3);
    expect(result.items[0].title).toBe('AI Epic');
    expect(result.items[1].title).toBe('AI Story');
    expect(result.items[2].title).toBe('AI AC');
  });

  it('gracefully falls back to heuristic regex parser when AI structuring call fails', async () => {
    vi.spyOn(providerConfigRepo, 'get').mockReturnValue({
      id: 'prov-mock',
      projectId: 'proj-1',
      name: 'Mock Provider',
      type: 'openai-compatible',
      endpoint: 'https://api.openai.com/v1',
      encryptedApiKey: 'dummy',
      deployment: '',
      apiVersion: '',
      model: 'gpt-4o',
      models: ['gpt-4o'],
      fallbackConfigIds: [],
      monthlyTokenLimit: 1000,
      isActive: true,
      createdAt: '2026-10-27',
    });

    vi.spyOn(providerModule, 'createAIProvider').mockReturnValue({
      streamChat: async function* () {
        throw new Error('Connection timeout to AI gateway');
      },
    } as any);

    const markdown = `# Fallback Epic
## Fallback Story
Given pre
When act
Then res`;

    const result = await parsePrdDocument({
      fileName: 'spec.md',
      buffer: Buffer.from(markdown, 'utf-8'),
      projectId: 'proj-1',
      documentTitle: 'Fallback Spec',
      providerConfigId: 'prov-mock',
    });

    // Should have parsed via heuristic fallback
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].title).toBe('Fallback Epic');
    // Warning emitted about AI failure
    expect(result.warnings.some((w) => w.includes('AI structuring call failed') && w.includes('Fell back to heuristic parser'))).toBe(true);
  });

  it('calls AI provider when providerConfigId is provided for XLSX PRD and preserves Row anchors', async () => {
    vi.spyOn(providerConfigRepo, 'get').mockReturnValue({
      id: 'prov-mock',
      projectId: 'proj-1',
      name: 'Mock Provider',
      type: 'openai-compatible',
      endpoint: 'https://api.openai.com/v1',
      encryptedApiKey: 'dummy',
      deployment: '',
      apiVersion: '',
      model: 'gpt-4o',
      models: ['gpt-4o'],
      fallbackConfigIds: [],
      monthlyTokenLimit: 1000,
      isActive: true,
      createdAt: '2026-10-27',
    });

    const mockAiResponse = JSON.stringify({
      items: [
        { tempId: 'e1', level: 'epic', title: 'Payment Epic', description: 'Epic', sourceAnchor: 'Row 2' },
        { tempId: 's1', parentTempId: 'e1', level: 'story', title: 'WeChat Pay', description: 'As a user I want WeChat Pay', sourceAnchor: 'Row 2' },
        { tempId: 'a1', parentTempId: 's1', level: 'ac', title: 'QR Scan Success', description: 'Given user is on checkout\nWhen QR is scanned\nThen order paid', sourceAnchor: 'Row 2' },
      ],
    });

    vi.spyOn(providerModule, 'createAIProvider').mockReturnValue({
      streamChat: async function* () {
        yield { type: 'content', content: mockAiResponse };
      },
    } as any);

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['模块', '功能', '验收标准'],
      ['支付模块', '微信支付', '用户扫码微信支付成功后更新订单'],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const result = await parsePrdDocument({
      fileName: 'payment.xlsx',
      buffer,
      projectId: 'proj-1',
      documentTitle: 'Payment Spec',
      providerConfigId: 'prov-mock',
      model: 'gpt-4o',
    });

    expect(result.items).toHaveLength(3);
    expect(result.items[0].title).toBe('Payment Epic');
    expect(result.items[0].sourceAnchor).toBe('Row 2');
    expect(result.items[1].title).toBe('WeChat Pay');
    expect(result.items[2].sourceAnchor).toBe('Row 2');
  });
});
