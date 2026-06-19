# Plan: Reposition README for local / small-model coding harness

**Status:** In progress — code defaults, `.env.example`, `.env`, and README are being aligned to aggressive-but-local values.

**Branch:** `feature/readme-local-small-model-harness`
**Goal:** Rewrite the top-level README so `guanaco-cli` is positioned first and foremost as a **local or small-model coding harness** that uses a Mastra workflow to guide a team of smaller LLM agents through the SDLC. The aggressive harness settings from `.env` should become the new defaults, but expressed with **local Ollama model names** rather than cloud-style IDs.

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

| Variable | Documented Default | Source |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | `.env.example` |
| `OLLAMA_MODEL` | `qwen3.5:0.8b` | `.env.example` |
| `OLLAMA_PROVIDER` | `local` | `.env.example` |
| `HARNESS_MODEL_ORCHESTRATOR` | `qwen2.5-coder:7b` | `src/mastra/models.ts` `DEFAULT_ROLE_MODELS` |
| `HARNESS_MODEL_PRODUCT` | `qwen2.5-coder:7b` | `src/mastra/models.ts` `DEFAULT_ROLE_MODELS` |
| `HARNESS_MODEL_ARCHITECT` | `qwen2.5-coder:7b` | `src/mastra/models.ts` `DEFAULT_ROLE_MODELS` |
| `HARNESS_MODEL_CODER` | `qwen2.5-coder:7b` | `src/mastra/models.ts` `DEFAULT_ROLE_MODELS` |
| `HARNESS_MODEL_REVIEWER` | `qwen2.5-coder:7b` | `src/mastra/models.ts` `DEFAULT_ROLE_MODELS` |
| `HARNESS_MODEL_TESTER` | `qwen2.5-coder:7b` | `src/mastra/models.ts` `DEFAULT_ROLE_MODELS` |
| `HARNESS_MAX_REVIEW_CYCLES` | `4` | `src/config.ts` |
| `HARNESS_MAX_TEST_CYCLES` | `4` | `src/config.ts` |
| `HARNESS_MAX_PLAN_CYCLES` | `0` | `src/config.ts` |
| `HARNESS_MAX_AGENT_STEPS` | `12` | `src/config.ts` |
| `HARNESS_AUTO_COMMIT` | `1` | `src/config.ts` |
| `HARNESS_HUMAN_IN_LOOP_INTAKE` | `0` | `src/config.ts` |
| `HARNESS_TOOL_TIMEOUT_MS` | `300000` | `src/config.ts` |
| `HARNESS_AGENT_TIMEOUT_MS` | `300000` | `src/config.ts` |
| `HARNESS_AGENT_HARD_TIMEOUT_MS` | `600000` | `src/config.ts` |
| `HARNESS_MAX_TURN_OUTPUT_BYTES` | `1000000` | `src/config.ts` |
| `HARNESS_MAX_WALL_CLOCK_MS` | `0` | `src/config.ts` |

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
- **Edit:** `src/config.ts` — change code defaults to aggressive values.
- **Edit:** `src/mastra/models.ts` — change `DEFAULT_ROLE_MODELS` to local `qwen2.5-coder:7b` for all roles.
- **Edit:** `.env.example` — align template with new aggressive-but-local defaults.
- **Edit:** `.env` — replace cloud-style model IDs with local names while keeping aggressive non-model settings.
- **Reference only (do not change unless asked):** `.env.example` / `.env` are kept in sync.
- **Do not edit:** other source code; this README/default-alignment pass is limited to config/models.

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
