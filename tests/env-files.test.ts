import { describe, it, expect } from 'vitest';
import { resolveEnvFiles } from '../src/env-files.js';

const set = (files: Set<string>) => (p: string) => files.has(p);

describe('resolveEnvFiles', () => {
  const home = '/home/user';
  const cwd = '/repo';

  it('returns no flags when neither global nor local .env exists', () => {
    expect(resolveEnvFiles({ home, cwd, exists: () => false })).toEqual([]);
  });

  it('returns only the global flag when only the global .env exists', () => {
    const exists = set(new Set(['/home/user/.config/guanaco/.env']));
    expect(resolveEnvFiles({ home, cwd, exists })).toEqual([
      '--env-file=/home/user/.config/guanaco/.env',
    ]);
  });

  it('returns only the local flag when only the local .env exists', () => {
    const exists = set(new Set(['/repo/.env']));
    expect(resolveEnvFiles({ home, cwd, exists })).toEqual(['--env-file=/repo/.env']);
  });

  it('emits global before local so the local .env overrides the global', () => {
    const exists = set(new Set(['/home/user/.config/guanaco/.env', '/repo/.env']));
    expect(resolveEnvFiles({ home, cwd, exists })).toEqual([
      '--env-file=/home/user/.config/guanaco/.env',
      '--env-file=/repo/.env',
    ]);
  });

  it('uses the injected home/cwd to build paths', () => {
    const exists = set(new Set(['/custom/home/.config/guanaco/.env', '/custom/repo/.env']));
    expect(resolveEnvFiles({ home: '/custom/home', cwd: '/custom/repo', exists })).toEqual([
      '--env-file=/custom/home/.config/guanaco/.env',
      '--env-file=/custom/repo/.env',
    ]);
  });
});