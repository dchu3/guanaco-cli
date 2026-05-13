import { describe, it, expect } from 'vitest';
import { HistoryStore } from '../src/history.js';

describe('HistoryStore', () => {
  it('starts empty without a system prompt', () => {
    const h = new HistoryStore({ maxMessages: 10 });
    expect(h.get(1)).toEqual([]);
  });

  it('seeds the log with the system prompt when provided', () => {
    const h = new HistoryStore({ maxMessages: 10, systemPrompt: 'be nice' });
    expect(h.get(1)).toEqual([{ role: 'system', content: 'be nice' }]);
  });

  it('keeps per-user logs isolated', () => {
    const h = new HistoryStore({ maxMessages: 10 });
    h.push(1, { role: 'user', content: 'hi from 1' });
    h.push(2, { role: 'user', content: 'hi from 2' });
    expect(h.get(1)).toEqual([{ role: 'user', content: 'hi from 1' }]);
    expect(h.get(2)).toEqual([{ role: 'user', content: 'hi from 2' }]);
  });

  it('clears one user without affecting others', () => {
    const h = new HistoryStore({ maxMessages: 10, systemPrompt: 'sys' });
    h.push(1, { role: 'user', content: 'a' });
    h.push(2, { role: 'user', content: 'b' });
    h.clear(1);
    expect(h.get(1)).toEqual([{ role: 'system', content: 'sys' }]);
    expect(h.get(2)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'b' },
    ]);
  });

  it('trims to maxMessages while preserving the leading system prompt', () => {
    const h = new HistoryStore({ maxMessages: 3, systemPrompt: 'sys' });
    for (let i = 0; i < 6; i++) {
      h.push(1, { role: 'user', content: `m${i}` });
    }
    const log = h.get(1);
    // 1 system + last 3 user messages
    expect(log).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'm3' },
      { role: 'user', content: 'm4' },
      { role: 'user', content: 'm5' },
    ]);
  });

  it('trims correctly with no system prompt', () => {
    const h = new HistoryStore({ maxMessages: 2 });
    h.push(1, { role: 'user', content: 'a' });
    h.push(1, { role: 'assistant', content: 'b' });
    h.push(1, { role: 'user', content: 'c' });
    // Trim drops oldest "a"; would leave [assistant b, user c], but
    // alternation rule drops the orphan leading assistant too.
    expect(h.get(1)).toEqual([{ role: 'user', content: 'c' }]);
  });

  it('drops orphan leading assistant after trimming to preserve alternation', () => {
    const h = new HistoryStore({ maxMessages: 2, systemPrompt: 'sys' });
    h.push(1, { role: 'user', content: 'u1' });
    h.push(1, { role: 'assistant', content: 'a1' });
    h.push(1, { role: 'user', content: 'u2' });
    // Raw count would yield [sys, a1, u2]; we drop the orphan a1 too.
    expect(h.get(1)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u2' },
    ]);
  });
});
