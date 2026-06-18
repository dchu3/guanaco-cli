import type { AppConfig } from '../config.js';
import { buildSdlcTools } from './tools.js';
import { createSdlcAgents, type SdlcAgents } from './agents.js';
import { getOllamaModel } from './models.js';

export * from './models.js';
export * from './tools.js';
export * from './agents.js';

/**
 * Build the six SDLC agents from an AppConfig: tools are jailed to the repo
 * root and each agent is wired to its Ollama model (local or cloud).
 */
export function buildSdlcAgentsFromConfig(cfg: AppConfig): SdlcAgents {
  const toolSet = buildSdlcTools({
    repoRoot: cfg.harness.repoRoot,
    toolTimeoutMs: cfg.harness.toolTimeoutMs,
  });
  return createSdlcAgents({
    getModel: (role) => getOllamaModel(role, cfg.harness, cfg.ollamaBaseUrl),
    toolSet,
  });
}