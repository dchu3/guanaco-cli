import type { SdlcRole } from '../config.js';

export type HarnessStep =
  | 'intake'
  | 'requirements'
  | 'design'
  | 'implement'
  | 'review'
  | 'test'
  | 'finalize';

export interface HarnessLogEntry {
  step: HarnessStep;
  agent: SdlcRole;
  text: string;
}

export interface HarnessHooks {
  /** A workflow step started/ended. */
  onStep?(step: HarnessStep, phase: 'start' | 'end'): void | Promise<void>;
  /** Incremental assistant text for an agent turn (streaming). */
  onAgentDelta?(agent: SdlcRole, delta: string, full: string): void | Promise<void>;
  /** Final assistant text for an agent turn. */
  onAgentMessage?(agent: SdlcRole, text: string): void | Promise<void>;
  /** Generic informational line (status, warnings, git output). */
  onInfo?(text: string): void | Promise<void>;
  /** Ask the human a question and await their textual answer (suspend gate). */
  onSuspend?(reason: string, prompt: string): Promise<string>;
}

export interface HarnessRunResult {
  ok: boolean;
  /** Branch the harness committed on, if it committed. */
  branch?: string;
  /** Commit sha, if committed. */
  commit?: string;
  /** Human-readable summary produced by the orchestrator at finalize. */
  summary: string;
  /** Every agent turn, in order. */
  log: HarnessLogEntry[];
  /** Why the run ended (e.g. 'completed', 'aborted', 'max-cycles'). */
  endReason: string;
}

export interface HarnessRunState {
  step: HarnessStep;
  feature: string;
  confirmedFeature?: string;
  reviewAttempts: number;
  testAttempts: number;
  lastReviewerVerdict?: 'APPROVE' | 'CHANGES_REQUESTED';
  lastTesterVerdict?: 'TESTS_PASSED' | 'TESTS_FAILED';
  log: HarnessLogEntry[];
}