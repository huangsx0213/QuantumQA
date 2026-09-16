import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PHASE1_TEMPERATURE, PHASE2_TEMPERATURE } from '../graph/nodes/utils.ts';

/**
 * F6: anti-drift test — binds ARCHITECTURE.md's stated values to the code
 * constants so a future change to either side surfaces as a test failure.
 */
describe('ARCHITECTURE.md anti-drift (F6)', () => {
  const doc = readFileSync(
    resolve(__dirname, '..', 'ARCHITECTURE.md'),
    'utf8',
  );

  it('Phase 1 temperature matches the code constant', () => {
    expect(doc).toContain(`| Phase 1 temperature | ${PHASE1_TEMPERATURE} |`);
  });

  it('Phase 2 temperature matches the code constant', () => {
    expect(doc).toContain(`| Phase 2 temperature | ${PHASE2_TEMPERATURE} |`);
  });

  it('does not claim a fixed 32768 maxTokens (ladder is dynamic)', () => {
    expect(doc).not.toMatch(/Phase [12] maxTokens \| 32768/);
  });

  it('documents the provider-dependent structured-output mode', () => {
    expect(doc).toContain('json_schema');
    expect(doc).toContain('json_object');
    expect(doc).toContain('openai-compatible');
  });
});
