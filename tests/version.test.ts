import { describe, it, expect } from 'vitest';
import { getVersion, wantsVersion } from '../src/version.js';
import { readFileSync } from 'node:fs';

describe('wantsVersion', () => {
  it('matches --version', () => {
    expect(wantsVersion(['--version'])).toBe(true);
  });

  it('matches -v', () => {
    expect(wantsVersion(['-v'])).toBe(true);
  });

  it('does not match when other args are present', () => {
    expect(wantsVersion(['--version', 'extra'])).toBe(false);
    expect(wantsVersion(['extra', '--version'])).toBe(false);
  });

  it('does not match unrelated flags', () => {
    expect(wantsVersion(['--model', 'foo'])).toBe(false);
    expect(wantsVersion(['--provider', 'cloud'])).toBe(false);
  });

  it('does not match empty argv', () => {
    expect(wantsVersion([])).toBe(false);
  });
});

describe('getVersion', () => {
  it('returns the package.json version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(getVersion()).toBe(pkg.version);
  });

  it('returns a non-empty string', () => {
    expect(getVersion().length).toBeGreaterThan(0);
  });
});