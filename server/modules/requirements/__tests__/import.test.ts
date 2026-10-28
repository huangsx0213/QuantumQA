import { describe, it, expect } from 'vitest';
import { parseMarkdownRequirements, parseCsvRequirements } from '../import.ts';

describe('parseMarkdownRequirements', () => {
  it('parses simple hierarchy', () => {
    const md = '# Login Feature\nThis is the login epic.\n\n## Email Login\nUser logs in with email and password.\n\n### Verify email format\nThe email field must accept valid email addresses.';
    const result = parseMarkdownRequirements(md, 'proj-1');
    expect(result.imported).toBe(3);
    const epic = result.requirements.find(r => r.title.includes('Login Feature'));
    expect(epic?.level).toBe('epic');
    expect(epic?.parentId).toBeUndefined();
  });
  it('returns 0 for empty input', () => {
    const result = parseMarkdownRequirements('', 'proj-1');
    expect(result.imported).toBe(0);
    expect(result.warnings).toEqual([]);
  });
  it('warns when heading exceeds max depth', () => {
    const md = '##### Deep heading';
    const result = parseMarkdownRequirements(md, 'proj-1');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('exceeding max depth');
  });
  it('warns when a sub-heading has no parent', () => {
    const md = '### Orphan story';
    const result = parseMarkdownRequirements(md, 'proj-1');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('has no parent');
  });

  it('parses bullet acceptance criteria under a story', () => {
    const md = `# Auth Module
## User Login
As a registered user, I want to log in.

- AC 1: Given valid credentials, When clicking login, Then dashboard opens
- AC 2: Given wrong password, When clicking login, Then show error
- Given user token is expired, When making API call, Then return 401`;
    const result = parseMarkdownRequirements(md, 'proj-1');
    expect(result.imported).toBe(5); // 1 epic + 1 story + 3 ACs
    const acs = result.requirements.filter(r => r.level === 'ac');
    expect(acs.length).toBe(3);
    const story = result.requirements.find(r => r.level === 'story');
    expect(acs.every(ac => ac.parentId === story?.id)).toBe(true);
  });

  it('parses bullets under an Acceptance Criteria section header', () => {
    const md = `# Checkout
## Payment
### Acceptance Criteria
- Credit card must be validated with Luhn algorithm
- CVV must be 3 or 4 digits`;
    const result = parseMarkdownRequirements(md, 'proj-1');
    const acs = result.requirements.filter(r => r.level === 'ac');
    expect(acs.length).toBe(2);
    expect(acs[0].title).toContain('Luhn');
  });
});

describe('parseCsvRequirements', () => {
  it('parses CSV with parent titles', () => {
    const csv = 'title,description,parent_title\nLogin Epic,Main login functionality,,\nEmail Login,Login with email,Login Epic,';
    const result = parseCsvRequirements(csv, 'proj-1');
    expect(result.imported).toBe(2);
    expect(result.requirements[0].title).toBe('Login Epic');
    expect(result.requirements[1].parentId).toBe(result.requirements[0].id);
  });
  it('returns 0 for header-only CSV', () => {
    const result = parseCsvRequirements('title,description,parent_title', 'proj-1');
    expect(result.imported).toBe(0);
    expect(result.warnings).toEqual([]);
  });
  it('warns when parent_title is not found', () => {
    const csv = 'title,parent_title\nChild,NonExistentParent';
    const result = parseCsvRequirements(csv, 'proj-1');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('NonExistentParent');
  });
});