# Plan: Reposition README for local / small-model coding harness

**Branch:** `feature/readme-local-small-model-harness`
**Goal:** Rewrite the top-level README so `guanaco-cli` is positioned first and foremost as a **local or small-model coding harness** that uses a Mastra workflow to guide a team of smaller LLM agents through the SDLC. The documented defaults must stay aligned with the local Ollama settings in `.env.example` (not the personal overrides in the committed `.env`).

## 1. Positioning principles to bake into the README

1. **Lead with local/small models.** The first sentence should state that the harness is designed to run against Ollama-served models on modest hardware, with optional Ollama Cloud fallback.
2. **Mastra is the guide, not just a library.** Frame the Mastra workflow as the scaffold that keeps small agents on-task: each agent owns one SDLC step, the workflow enforces hand-offs, and human-in-the-loop gates compensate for weaker model reliability.
3. **Conservative defaults are features.** Highlight `HARNESS_HUMAN_IN_LOOP_INTAKE=1`, `HARNESS_AUTO_COMMIT=0`, low cycle counts, and repo-root jailing as intentional guardrails for smaller models.
4. **Per-role model sizing is explicit.** Explain why planning roles default to a tiny model (`qwen3.5:0.8b`) and coding roles default to a coder-tuned model (`qwen2.5-coder:7b`) so users know how to tune for their GPU/CPU budget.

## 2. Concrete README edits

### 2.1 Title + tagline
- Change subtitle from "interactive coding harness" to something like:
  > A local / small-model coding harness built on pi-tui and Mastra. It orchestrates a team of SDLC-role agents using Ollama models you can run on your own machine (or Ollama Cloud), with human-in-the-loop gates at every critical hand-off.

### 2.2 Features section
- Keep bullets, but re-order/reword to lead with the small-model story:
  - **Local-first, small-model SDLC harness**: Mastra workflow coordinates Product, Architect, Coder, Reviewer, and Tester agents running against Ollama.
  - **Human-in-the-loop guardrails**: default config pauses for plan confirmation and final commit approval because small models benefit from steering.
  - **Per-role model selection**: lightweight planning models and coder-tuned implementation models out of the box.
  - Keep existing CLI, repo-grounded tools, safe git flow, and tests bullets.

### 2.3 New "Why this harness?" / "Tuning for small models" short section
Add a brief paragraph before or after Features:
- Small local models are prone to drifting, looping, or producing malformed tool calls. The harness mitigates this by:
  - Giving each agent a narrow role and scoped tool set.
  - Bounding every loop (`HARNESS_MAX_*_CYCLES`) and every turn (`HARNESS_MAX_AGENT_STEPS`, `HARNESS_MAX_TURN_OUTPUT_BYTES`, timeouts).
  - Suspending at intake and finalize by default so the human can correct course.

### 2.4 Prerequisites / Setup
- Keep local-first setup:
  ```bash
  ollama pull qwen3.5:0.8b
  ollama pull qwen2.5-coder:7b
  ```
- Mention that cloud mode is available but secondary.

### 2.5 Environment variables table
Ensure all documented defaults match `.env.example` (local Ollama, conservative HITL). Specifically:

| Variable | Documented Default | Source in `.env.example` |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | exact |
| `OLLAMA_MODEL` | `qwen3.5:0.8b` | exact |
| `OLLAMA_PROVIDER` | `local` | exact |
| `HARNESS_MODEL_ORCHESTRATOR` | `qwen3.5:0.8b` | fallback default (commented in `.env.example`) |
| `HARNESS_MODEL_PRODUCT` | `qwen3.5:0.8b` | fallback default |
| `HARNESS_MODEL_ARCHITECT` | `qwen2.5-coder:7b` | fallback default |
| `HARNESS_MODEL_CODER` | `qwen2.5-coder:7b` | fallback default |
| `HARNESS_MODEL_REVIEWER` | `qwen2.5-coder:7b` | fallback default |
| `HARNESS_MODEL_TESTER` | `qwen2.5-coder:7b` | fallback default |
| `HARNESS_MAX_REVIEW_CYCLES` | `2` | exact |
| `HARNESS_MAX_TEST_CYCLES` | `2` | exact |
| `HARNESS_MAX_PLAN_CYCLES` | `0` | exact |
| `HARNESS_MAX_AGENT_STEPS` | `8` | exact |
| `HARNESS_AUTO_COMMIT` | `0` | exact |
| `HARNESS_HUMAN_IN_LOOP_INTAKE` | `1` | exact |
| `HARNESS_TOOL_TIMEOUT_MS` | `120000` | exact |
| `HARNESS_AGENT_TIMEOUT_MS` | `300000` | exact |
| `HARNESS_AGENT_HARD_TIMEOUT_MS` | `600000` | exact |
| `HARNESS_MAX_TURN_OUTPUT_BYTES` | `1000000` | exact |
| `HARNESS_MAX_WALL_CLOCK_MS` | `0` | exact |

Action: audit the README table line-by-line against `.env.example` and fix any drift. Add a note that `.env.example` is the canonical source of defaults and that the committed `.env` is only an example local override.

### 2.6 Running the harness section
- Keep the `/feature` walkthrough, but explicitly call out the default human-in-the-loop gates:
  1. **Intake** — orchestrator parses the prompt; default config (`HARNESS_HUMAN_IN_LOOP_INTAKE=1`) pauses for human confirmation.
  2. **Plan** — product + architect; model defaults keep this lightweight.
  3. **Implement** — coder with bounded tool loop.
  4. **Review / Test** — reviewer and tester loops bounded by `HARNESS_MAX_REVIEW_CYCLES` / `HARNESS_MAX_TEST_CYCLES`.
  5. **Finalize** — orchestrator summarizes; `HARNESS_AUTO_COMMIT=0` pauses for approval before creating `feature/harness-<slug>` and committing.

### 2.7 Optional: add a "Model sizing cheat sheet" subsection
Suggest model sizes per role for common hardware tiers (CPU-only, 8 GB VRAM, 16 GB VRAM). This reinforces the local/small-model positioning.

## 3. Files to touch / not touch

- **Edit:** `README.md`
- **Reference only (do not change unless asked):** `.env.example` — verify defaults match what we document.
- **Do not edit:** `.env` (it is a local override and already gitignored in spirit; it is committed in this repo but should not be treated as canonical defaults).
- **Do not edit:** source code; this plan is README-only.

## 4. Suggested commit message

```
docs: reposition README as local/small-model coding harness

- Lead with local Ollama / small-model story
- Highlight Mastra workflow and human-in-the-loop guardrails
- Align env-var defaults with .env.example
- Keep cloud mode documented as optional fallback
```

## 5. Verification checklist before merging

- [ ] `npm run lint` passes (no source changes, but good hygiene).
- [ ] `npm run build` still passes.
- [ ] README renders correctly in a Markdown preview.
- [ ] All env defaults in README match `.env.example` exactly.
- [ ] Local Ollama model names (`qwen3.5:0.8b`, `qwen2.5-coder:7b`) are used as defaults, not cloud-style IDs.
- [ ] Cloud mode is clearly framed as an optional override, not the primary use case.
