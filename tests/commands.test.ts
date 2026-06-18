import { describe, it, expect } from 'vitest';
import { COMMANDS, formatCommandList, isBareSlash } from '../src/commands.js';

describe('COMMANDS catalogue', () => {
  it('contains the expected command names', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        '/feature',
        '/agents',
        '/harness-status',
        '/help',
        '/clear',
        '/model',
        '/exit',
        '/quit',
      ]),
    );
  });

  it('every entry has a non-empty name and description', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.name.startsWith('/')).toBe(true);
      expect(cmd.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('formatCommandList', () => {
  const body = formatCommandList();

  it('includes every command name', () => {
    for (const cmd of COMMANDS) {
      expect(body).toContain(cmd.name);
    }
  });

  it('includes the shell-command tip', () => {
    expect(body).toContain('!<command>');
  });

  it('starts with a heading', () => {
    expect(body.startsWith('Available commands:')).toBe(true);
  });
});

describe('isBareSlash', () => {
  it('returns true for a bare slash', () => {
    expect(isBareSlash('/')).toBe(true);
  });

  it('returns true for a slash with trailing whitespace', () => {
    expect(isBareSlash('/   ')).toBe(true);
  });

  it('returns false for a real command', () => {
    expect(isBareSlash('/help')).toBe(false);
    expect(isBareSlash('/feature do something')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(isBareSlash('')).toBe(false);
  });

  it('returns false for plain text', () => {
    expect(isBareSlash('hello')).toBe(false);
  });
});