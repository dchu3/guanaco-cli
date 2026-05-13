import type { ChatMessage } from './ollama.js';

export interface HistoryStoreOptions {
  maxMessages: number;
  systemPrompt?: string;
}

export class HistoryStore {
  private readonly maxMessages: number;
  private readonly systemPrompt?: string;
  private readonly perUser = new Map<number, ChatMessage[]>();

  constructor(opts: HistoryStoreOptions) {
    this.maxMessages = Math.max(0, opts.maxMessages);
    this.systemPrompt = opts.systemPrompt;
  }

  get(userId: number): ChatMessage[] {
    let log = this.perUser.get(userId);
    if (!log) {
      log = this.systemPrompt ? [{ role: 'system', content: this.systemPrompt }] : [];
      this.perUser.set(userId, log);
    }
    return log;
  }

  push(userId: number, msg: ChatMessage): void {
    const log = this.get(userId);
    log.push(msg);
    this.trim(log);
  }

  clear(userId: number): void {
    this.perUser.delete(userId);
  }

  private trim(log: ChatMessage[]): void {
    if (this.maxMessages <= 0) return;
    const hasSystem = log.length > 0 && log[0].role === 'system';
    const keepHead = hasSystem ? 1 : 0;
    const overflow = log.length - keepHead - this.maxMessages;
    if (overflow > 0) {
      log.splice(keepHead, overflow);
    }
    // Preserve alternation: if trimming left a leading assistant message
    // (with no preceding user turn), drop it so the model never sees an
    // orphaned assistant reply at the start of the window. Also drop any
    // orphan `tool` messages whose preceding assistant tool_call was trimmed
    // away — without the call, providers reject the tool result.
    while (
      log.length > keepHead &&
      (log[keepHead].role === 'assistant' || log[keepHead].role === 'tool')
    ) {
      log.splice(keepHead, 1);
    }
  }
}
