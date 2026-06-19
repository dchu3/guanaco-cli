# Performance Review Plan — Guanaco CLI

**Scope:** Review runtime performance, long-running / unbounded loops, and resource usage in the Mastra-based SDLC harness (`src/mastra/*`, `src/harness/runner.ts`, related CLI wiring).  The goal is a short, prioritized list of hotspots to instrument, reproduce, and fix.

**Assumptions:** The app runs against local Ollama (often small models on CPU) or Ollama Cloud, operating inside a single git repo.  Long agent turns and repeated repo scans are the dominant cost drivers.

---

## Status

Implemented on branch `feature/performance-review-impl`:

- ✅ P0: `HARNESS_MAX_TURN_OUTPUT_BYTES` cap in `callAgent` with array-based accumulation and truncation.
- ✅ P0: Shell tool is cancelable via `AbortSignal` (uses `spawn` instead of `exec`).
- ✅ P0: Default hard timeout raised from `0` to `600000` (10 min).
- ✅ P1: `walk()` ignores common build/output dirs (`dist`, `build`, `coverage`, `.next`, `.turbo`, `.cache`, `out`, `.vscode`, `.idea`).
- ✅ P1: Per-tool-set file-tree cache with 5 s TTL for repeated `glob`/`grep` calls.
- ✅ P1: `globToRegex` replaced with `picomatch`; compiled matchers cached per pattern.
- ✅ P1: `grep` early-aborts once `maxResults` is reached.
- ✅ Config-level: `HARNESS_MAX_WALL_CLOCK_MS` and per-run wall-clock check in `callAgent`.
- ✅ Default `HARNESS_MAX_AGENT_STEPS` lowered to `5` for local provider (remains `8` for cloud).
- ✅ Added `scripts/bench-tools.ts` synthetic benchmark for walk/glob/grep.
- ✅ Tests added for output cap, wall-clock budget, shell cancellation, build-dir filtering, and picomatch glob.

Still open / follow-up:

- 🔄 P2: Run reviewer and tester in parallel after implementation. Deferred because `git_diff` currently mutates the index via `git add -N .`; parallel calls would race. A read-only `git_diff` implementation (or a mutex) is a prerequisite.
- 🔄 P2: Detect non-progress in coder rewrites (e.g. identical diff twice) and break early.
- 🔄 P2/P3: Cache `routeAgentStream` route decision per model after first call.
- 🔄 P3: Bound legacy `OllamaClient` message growth / tool loop.

---

## 1. Current architecture recap (what can loop)

```
/feature
  └── runBody
        ├── plan(): product → architect
        ├── refinePlan() × HARNESS_MAX_PLAN_CYCLES
        ├── implement: coder (maxAgentSteps tool loop inside Mastra)
        ├── review loop: reviewer → coder  × (maxReviewCycles + 1)
        ├── test loop: tester → coder     × (maxTestCycles + 1)
        └── finalize: orchestrator
```

Each `callAgent` turn:
1. Streams text via `agents[role].stream()` (Mastra `Agent#stream()` or `streamLegacy()`).
2. If the role has tools, Mastra internally runs a tool-calling loop up to `maxAgentSteps`.
3. The harness itself accumulates every streamed delta in a string (`full += delta`).

Tool side (`src/mastra/tools.ts`):
- `glob`: recursive `walk()` over the repo, then regex filter.
- `grep`: recursive `walk()`, then line-by-line regex scan.
- `read_file`: reads whole file; optional offset/limit applied after reading.
- `edit_file`: reads whole file, applies edits sequentially, writes whole file.
- `shell`: `child_process.exec` with `maxBuffer: 4 MiB` and `toolTimeoutMs`.
- `git_diff`: runs `git add -N .` + `git diff`, returning up to 4× `maxOutputBytes` (default 200 KB).

---

## 2. Hypothesized hotspots & performance risks

### A. Repeated, unbounded repo scans
**Where:** `src/mastra/tools.ts` — `walk()` used by `glob` and `grep`.

**Risk:** Every architect/coder/reviewer/tester tool call that searches files re-walks the entire repo tree.  On a large repo this is `O(files)` per call, and agents often call `glob`/`grep` repeatedly in a single turn.  There is no caching of directory listings or file stats.

**What to look for:**
- Does `walk()` traverse into `node_modules`, `.git`, `.next`, `dist`, `.git`?  It skips `node_modules` and `.git` by name, but not other build/output dirs.
- Does it follow symlinks? `stat()` on a symlink returns the link itself (not followed), but nested symlinks can still create large trees.
- Does the agent call `glob '**/*'` frequently?  That materializes every file path.

**Improvements to consider:**
1. Add a global `.gitignore`-aware filter to `walk()` so `dist`, `coverage`, `.next`, etc. are skipped.
2. Cache the file tree for the duration of an agent turn (or a TTL, e.g. 5 s) so repeated `glob`/`grep` calls reuse the walk.
3. Bound `glob` results more defensively — already capped at 500, but the cap is applied *after* walking everything.
4. For `grep`, consider early-abort once `maxResults` is reached instead of reading remaining files.

### B. Unbounded string growth while streaming
**Where:** `src/harness/runner.ts` — `callAgent` accumulates `full += delta`.

**Risk:** A runaway model can stream megabytes of tokens.  Concatenation in a tight loop creates many intermediate strings and can exhaust memory.  There is no per-turn output cap before the loop finishes.

**What to look for:**
- Profile memory during a long streaming turn.
- Check whether `full` ever exceeds a sensible cap (e.g. 1–4 MB) and whether we should truncate and abort.

**Improvements to consider:**
1. Replace `full += delta` with a buffer/stream-friendly accumulator, or at least a `StringBuilder`-style array joined once.
2. Add `HARNESS_MAX_TURN_OUTPUT_BYTES` and truncate/abort when exceeded.
3. Ensure `truncate()` is applied to the final stored text so the log doesn't balloon.

### C. Mastra tool-loop depth (`maxAgentSteps`)
**Where:** `src/harness/runner.ts` passes `maxSteps: cfg.maxAgentSteps` to `stream()`.  Default is 8, max 50.

**Risk:** Each step is a full LLM round-trip + tool execution.  A misbehaving model can chain tool calls (e.g. `read_file` → `grep` → `glob` → `read_file` …) for many minutes.  The outer harness has no visibility into the inner loop and cannot stop individual tool calls.

**What to look for:**
- Does Mastra respect `maxSteps` exactly, or can a step spawn sub-steps?
- What is the empirical wall-clock for 8 steps on a slow local model?
- Are there degenerate patterns like repeated `glob '**/*'`?

**Improvements to consider:**
1. Lower the default `HARNESS_MAX_AGENT_STEPS` from 8 to something more conservative (e.g. 4–5) for local models.
2. Surface the current step number to the UI so the user sees progress and can abort.
3. Add per-tool-call telemetry (duration, bytes read, command executed) to identify looping tools.

### D. Shell tool: unbounded work, no cancellation
**Where:** `src/mastra/tools.ts` `shellTool`; also `gitDiffTool`.

**Risk:** `exec` runs the whole command; the timeout is the only guard.  A `npm test` that deadlocks or a build that never terminates consumes the full `HARNESS_TOOL_TIMEOUT_MS` (default 2 min).  There is no propagation of the runner's `AbortSignal` into the tool, so pressing Esc during a long shell call does nothing until the timeout.

**What to look for:**
- How does `exec` behave when the parent `AbortController` aborts?  Today it doesn't; `AbortSignal` is not passed to the tool.
- Are there commands that take most of the timeout?  `npm run build`, `npm test`, etc.

**Improvements to consider:**
1. Pass `turnController.signal` into tool execution and use `spawn` + kill instead of `exec` so the tool can be cancelled.
2. Keep `maxBuffer` but make it configurable.
3. Pre-emptively deny commands that are known to be long and non-interactive (e.g. `npm run dev`, `tsx watch`).

### E. Review / test outer loops can cascade
**Where:** `src/harness/runner.ts` review loop and test loop.

**Risk:** With default `maxReviewCycles=2`, `maxTestCycles=2`, a bad plan can trigger 2 coder rewrites after review and 2 after tests.  Combined with `maxAgentSteps=8` and `toolTimeoutMs=120s`, worst-case wall clock is many minutes.  The loops are sequential, not parallel, so the total time is additive.

**What to look for:**
- Empirical total duration for a realistic feature on a local 0.8b model.
- Whether reviewer/tester verdicts are parsed robustly (they are string-searched; a model that rambles can be misclassified).

**Improvements to consider:**
1. Add an overall `HARNESS_MAX_WALL_CLOCK_MS` cap independent of per-turn timeouts.
2. Consider running reviewer and tester in parallel after implementation (they both read the diff; no writes).  This halves a common path.
3. Detect non-progress: if the coder returns the same diff twice, break the loop early.

### F. `edit_file` — whole-file rewrite on each edit
**Where:** `src/mastra/tools.ts` `editFileTool.execute`.

**Risk:** For a large file, every edit re-reads and re-writes the entire file.  Multiple edits in one call are sequential, but the intermediate string is kept in memory.

**What to look for:**
- Latency and memory when an agent applies many edits to a large file (e.g. `package-lock.json`, generated fixtures).

**Improvements to consider:**
1. Write once after all edits are applied in memory (already done; good).
2. Skip editing files that exceed a size threshold (return an error asking the model to use `write_file` instead).
3. Normalize overlapping edits before applying them.

### G. `globToRegex` — correctness and performance
**Where:** `src/mastra/tools.ts`.

**Risk:** The current implementation first escapes special regex chars globally, then maps over the original pattern character-by-character.  The escape pass is effectively overwritten for `*`, `?`, and brackets, but it still runs and could be simplified.  More importantly, `<<GLOBSTAR>>/?` replacement produces `.*` which matches across directory separators — correct for `**`, but the non-star handling escapes `/` to `\/`, so the regex is tested against forward-slash paths.  Verify it doesn't create pathological regexes (e.g. `**` with many alternatives).

**What to look for:**
- Fuzz-test glob patterns against a known glob library for large repos.
- Measure regex compile time and match time.

**Improvements to consider:**
1. Replace custom glob implementation with `minimatch` or `picomatch` (already common in Node toolchains) for correctness and speed.
2. Cache compiled regexes per pattern during an agent turn.

### H. `routeAgentStream` fallback retries
**Where:** `src/mastra/agents.ts`.

**Risk:** For cloud models that report v4 only at call time, `routeAgentStream` calls `stream()`, catches the error, then calls `streamLegacy()`.  The first call may already have initiated a network request; aborting on the second path is fine, but the error path doubles latency on the first attempt for those models.

**What to look for:**
- How often does the fallback trigger in practice?
- Can we detect v4 vs v5 more cheaply (e.g. by inspecting the model object earlier)?

**Improvements to consider:**
1. Cache the resolved route per model after the first successful/failed attempt so subsequent turns skip the failed path.
2. Ensure the first request is fully aborted before starting the legacy request.

### I. Legacy `OllamaClient.chat` tool loop
**Where:** `src/ollama.ts`.

**Risk:** The legacy chat mode has its own tool loop (`maxToolSteps`, default 3).  It is separate from the harness but shares the same `ToolRegistry`.  The loop appends tool results to `working` messages, so context grows with each step and can exceed the model's context window, causing slow or degenerate responses.

**What to look for:**
- Does the legacy `/chat` mode stream tool deltas properly?
- Does the message history grow unbounded across turns?  It is local to `chat()`.

**Improvements to consider:**
1. Keep legacy mode bounded; ensure `maxToolSteps` is respected and that final-step tool suppression works.
2. Summarize or drop old tool results if they exceed a token budget.

### J. Timeout semantics in `callAgent`
**Where:** `src/harness/runner.ts`.

**Risk:** The inactivity timer resets on *every* streamed token.  A model that emits a token every 299 s with a 300 s inactivity timeout will never trigger the timeout, even though the turn is effectively stalled.  The hard timeout (`agentTurnHardTimeoutMs`) is off by default.

**What to look for:**
- Real-world token inter-arrival times for local models.
- Whether the hard timeout should be on by default.

**Improvements to consider:**
1. Add a default hard timeout (e.g. 10 min) so a runaway but technically-active stream is capped.
2. Validate `agentTurnTimeoutMs > toolTimeoutMs` more strictly and warn the user if not.

---

## 3. Recommended measurement plan

### 3.1 Add lightweight telemetry
Before optimizing, add timing/logs to confirm the hotspots:

| Area | Metric |
|------|--------|
| `callAgent` | start/end wall-clock, total streamed bytes, token count, abort reason |
| `walk` | files scanned, duration, cache hit/miss |
| `glob`/`grep` | pattern, matched count, duration |
| `shell` | command, duration, exit code, stdout/stderr bytes |
| `edit_file`/`write_file` | file size, edit count, duration |
| Mastra internal | if Mastra exposes step events, log per step duration |

**Suggested implementation:** Add an optional `onToolStart`/`onToolEnd` style telemetry callback in `buildSdlcTools`, or reuse `debug()` with structured tags.  Keep it cheap; do not mutate files unless `DEBUG=1`.

### 3.2 Synthetic benchmarks
Create a few small scripts (or Vitest perf tests) to establish baselines:

1. **Repo walk benchmark** — `walk()` on repos of 1k, 10k, 50k files.  Compare with/without ignore rules.
2. **Glob benchmark** — common patterns (`src/**/*.ts`, `**/*.md`) and degenerate ones (`**/*`).
3. **Streaming accumulation benchmark** — simulate 100k tokens and measure memory/time for `full += delta` vs array-join.
4. **Timeout benchmark** — simulate a token every 295 s and confirm hard vs inactivity timeout behavior.
5. **Tool-loop benchmark** — mock Mastra to call `glob` 20 times in one turn; measure total time.

### 3.3 Real-run profiling
Run `/feature` on a real repo with `DEBUG=1` and a local model, then:
- Inspect the debug log for repeated `glob`/`grep`/`shell` calls.
- Use `node --inspect` / Chrome DevTools to capture a CPU/memory profile of a full harness run.
- Identify which phase consumes the most wall-clock.

---

## 4. Prioritized action items

### P0 — Fix unbounded / unsafe behavior
1. Add `HARNESS_MAX_TURN_OUTPUT_BYTES` and truncate/abort streaming when exceeded.
2. Pass `AbortSignal` to `shellTool` so Esc can cancel long commands; switch to `spawn` if needed.
3. Add a default hard timeout (`agentTurnHardTimeoutMs`) in config or strongly document enabling it.

### P1 — Reduce repeated work
4. Add `.gitignore`/common-output-dir filtering to `walk()`.
5. Cache repo file tree for the duration of an agent turn (or short TTL).
6. Replace custom `globToRegex` with `minimatch` or `picomatch` and cache compiled patterns.

### P2 — Improve harness loop efficiency
7. Lower default `maxAgentSteps` for local provider; allow role-specific overrides.
8. Run reviewer and tester in parallel after implementation (they are read-only).
9. Detect non-progress in coder rewrites and break early.

### P3 — Harden edge cases
10. Cache `routeAgentStream` route decision per model after first call.
11. Bound legacy `OllamaClient` message growth / tool loop.
12. Add an overall `HARNESS_MAX_WALL_CLOCK_MS` cap.

---

## 5. Suggested code changes to start with

These are the smallest, highest-confidence wins:

1. **In `src/harness/runner.ts`:**
   - Replace `full += delta` with `const chunks: string[] = []` and `chunks.push(delta)`; join at the end.
   - After each delta, if accumulated bytes exceed a cap, abort the turn with a clear message.

2. **In `src/mastra/tools.ts`:**
   - Expand `walk()` skip list to include common build dirs (`dist`, `build`, `coverage`, `.next`, `.turbo`, `.cache`, `out`).
   - Stop reading files in `grep` once `hits.length >= cap` (already partially true; ensure the outer `for` loop exits immediately, not just the inner line loop).
   - Add a `Set` cache of `readdir`+`stat` results keyed by directory mtime (or per-turn cache) and use it for `glob`/`grep`.

3. **In `src/config.ts`:**
   - Add `HARNESS_MAX_TURN_OUTPUT_BYTES` env var (default e.g. 1 MB).
   - Consider lowering `HARNESS_MAX_AGENT_STEPS` default from 8 to 5 for `provider === 'local'`.

4. **In `src/harness/runner.ts`:**
   - Add a run-level `startTime` and check `Date.now() - startTime` against a configurable max wall-clock before each agent turn.

---

## 6. Acceptance criteria for this review

- [x] Telemetry added to `callAgent` and all tools (at least debug logging).
- [x] At least one synthetic benchmark committed for repo-walk/glob/streaming accumulation.
- [x] A decision recorded on whether to add `HARNESS_MAX_TURN_OUTPUT_BYTES` and default hard timeout.
- [x] `walk()` ignores common build/dependency/output directories.
- [x] `shellTool` is cancelable via `AbortSignal`.
- [ ] reviewer + tester parallelization designed (and either implemented or ticketed).
- [x] `globToRegex` replaced or hardened and patterns cached.

*(Reviewer/tester parallelization is ticketed as a follow-up; it requires making `git_diff` read-only first.)*

---

## 7. Quick risk matrix

| Risk | Impact | Likelihood | Owner file |
|------|--------|------------|------------|
| Runaway streaming / OOM | High | Medium | `src/harness/runner.ts` |
| Long, uncancelable shell calls | High | High | `src/mastra/tools.ts` |
| Repeated repo scans slow every turn | High | High | `src/mastra/tools.ts` |
| Mastra tool loop too deep | Medium | Medium | `src/harness/runner.ts` |
| Review/test loops cascade | Medium | Medium | `src/harness/runner.ts` |
| `globToRegex` pathologies | Low | Low | `src/mastra/tools.ts` |

---

*Prepared for branch `feature/product-architect-planning` after pulling latest `main` (0c4546f).*