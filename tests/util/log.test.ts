import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// These tests set GUANACO_LOG_FILE to a temp path so they never touch the
// real ~/.guanaco/logs/debug.log. captureStderr mutates the global
// process.stderr.write; we restore it in afterEach.
let dir: string;
let logPath: string;
let savedStderrWrite: typeof process.stderr.write;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'guanaco-log-'));
  logPath = join(dir, 'debug.log');
  process.env.GUANACO_LOG_FILE = logPath;
  savedStderrWrite = process.stderr.write.bind(process.stderr);
});

afterEach(async () => {
  process.stderr.write = savedStderrWrite;
  delete process.env.GUANACO_LOG_FILE;
  await rm(dir, { recursive: true, force: true });
});

describe('file logger', () => {
  it('getLogFile resolves GUANACO_LOG_FILE to an absolute path and creates the dir', async () => {
    const { getLogFile } = await import('../../src/util/log.js');
    expect(getLogFile()).toBe(logPath);
  });

  it('logError always appends a timestamped line (independent of DEBUG)', async () => {
    const { logError } = await import('../../src/util/log.js');
    logError('test-scope', 'something broke', new Error('boom'));
    const content = await readFile(logPath, 'utf8');
    expect(content).toContain('[ERROR][test-scope]');
    expect(content).toContain('something broke');
    expect(content).toContain('Error: boom');
  });

  it('tailLog returns the last N lines in order', async () => {
    const { logError, tailLog } = await import('../../src/util/log.js');
    for (let i = 0; i < 5; i++) logError('scope', `line ${i}`);
    const tail = tailLog(3);
    expect(tail).toHaveLength(3);
    expect(tail[0]).toContain('line 2');
    expect(tail[2]).toContain('line 4');
  });

  it('captureStderr tees process.stderr writes into the log file', async () => {
    const { captureStderr, getLogFile } = await import('../../src/util/log.js');
    captureStderr();
    process.stderr.write('a stderr flash that the TUI overwrote\n');
    const content = await readFile(getLogFile()!, 'utf8');
    expect(content).toContain('[stderr]');
    expect(content).toContain('a stderr flash that the TUI overwrote');
  });

  it('debug() is gated by DEBUG (writes when enabled, silent when not)', async () => {
    // DEBUG unset → debug() is a no-op.
    delete process.env.DEBUG;
    vi.resetModules();
    const silent = await import('../../src/util/log.js');
    silent.debug('scope', 'should not appear');
    let content = await readFile(logPath, 'utf8').catch(() => '');
    expect(content).not.toContain('should not appear');

    // DEBUG=1 → debug() writes a line.
    process.env.DEBUG = '1';
    vi.resetModules();
    const loud = await import('../../src/util/log.js');
    loud.debug('scope', 'should appear');
    content = await readFile(logPath, 'utf8');
    expect(content).toContain('[scope]');
    expect(content).toContain('should appear');
  });

  it('logError does not throw when the log directory cannot be created', async () => {
    // Point the log path inside an existing *file* (not a dir) so mkdirSync
    // fails; the logger must swallow that and never throw.
    await writeFile(join(dir, 'blocker'), 'x');
    process.env.GUANACO_LOG_FILE = join(dir, 'blocker', 'log.log');
    vi.resetModules();
    const { logError, getLogFile } = await import('../../src/util/log.js');
    expect(getLogFile()).toBeUndefined();
    expect(() => logError('scope', 'no throw')).not.toThrow();
  });
});