import { describe, expect, it } from 'vitest';
import { parseStoryMarkdown, parseACMarkdown } from '../format-parser';

describe('frontend parseStoryMarkdown mirror', () => {
  it('parses three segments', () => {
    const result = parseStoryMarkdown('As a user\nI want to do x\nSo that y');
    expect(result.hasAllSegments).toBe(true);
    expect(result.role).toBe('user');
  });

  it('parses with colons', () => {
    const result = parseStoryMarkdown('As a: user\nI want: x\nSo that: y');
    expect(result.action).toBe('x');
  });

  it('parses standard single-sentence user story', () => {
    const result = parseStoryMarkdown('As a first-time user, I want to see a clear sign-in form so that I can identify how to authenticate.');
    expect(result.hasAllSegments).toBe(true);
    expect(result.role).toBe('first-time user');
    expect(result.action).toBe('see a clear sign-in form');
    expect(result.value).toBe('identify how to authenticate');
    expect(result.remainder).toBe('');
  });

  it('parses single-sentence story with additional context remainder', () => {
    const result = parseStoryMarkdown('As a registered administrator, I want to sign in with valid credentials so that I can access the protected application. Default credentials are admin / admin123, and successful login returns token "fake-jwt-token-12345".');
    expect(result.hasAllSegments).toBe(true);
    expect(result.role).toBe('registered administrator');
    expect(result.action).toBe('sign in with valid credentials');
    expect(result.value).toBe('access the protected application');
    expect(result.remainder).toBe('Default credentials are admin / admin123, and successful login returns token "fake-jwt-token-12345".');
  });
});

describe('frontend parseACMarkdown mirror', () => {
  it('parses Given/When/Then', () => {
    const result = parseACMarkdown('Given x\nWhen y\nThen z');
    expect(result.given).toBe('x');
    expect(result.when).toBe('y');
    expect(result.then).toBe('z');
    expect(result.hasAllSegments).toBe(true);
  });

  it('flags missing segments', () => {
    const result = parseACMarkdown('free-form');
    expect(result.hasAllSegments).toBe(false);
  });
});
