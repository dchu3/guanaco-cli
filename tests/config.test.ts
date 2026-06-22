import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig · appTitle', () => {
  const original = process.env.APP_TITLE;

  afterEach(() => {
    if (original === undefined) delete process.env.APP_TITLE;
    else process.env.APP_TITLE = original;
  });

  it('defaults to "Guanaco CLI" when APP_TITLE is unset', () => {
    delete process.env.APP_TITLE;
    expect(loadConfig().appTitle).toBe('Guanaco CLI');
  });

  it('uses APP_TITLE when set', () => {
    process.env.APP_TITLE = 'My Custom App';
    expect(loadConfig().appTitle).toBe('My Custom App');
  });

  it('trims surrounding whitespace', () => {
    process.env.APP_TITLE = '  Spaced  ';
    expect(loadConfig().appTitle).toBe('Spaced');
  });

  it('falls back to default when APP_TITLE is empty', () => {
    process.env.APP_TITLE = '';
    expect(loadConfig().appTitle).toBe('Guanaco CLI');
  });

  it('falls back to default when APP_TITLE is only whitespace', () => {
    process.env.APP_TITLE = '   ';
    expect(loadConfig().appTitle).toBe('Guanaco CLI');
  });
});