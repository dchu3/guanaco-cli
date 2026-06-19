import { createOllama } from 'ollama-ai-provider';
import type { OllamaProvider } from 'ollama-ai-provider';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { HarnessConfig, SdlcRole } from '../config.js';

/**
 * Default model per SDLC role. Aggressive local defaults put every role on a
 * capable coder-tuned model so small-model agents have enough capacity for
 * planning, implementation, review, and test. These are only defaults; any can
 * be overridden via HARNESS_MODEL_<ROLE> / --<role>-model.
 */
export const DEFAULT_ROLE_MODELS: Record<SdlcRole, string> = {
  orchestrator: 'qwen2.5-coder:7b',
  product: 'qwen2.5-coder:7b',
  architect: 'qwen2.5-coder:7b',
  coder: 'qwen2.5-coder:7b',
  reviewer: 'qwen2.5-coder:7b',
  tester: 'qwen2.5-coder:7b',
};

/**
 * A cached Ollama provider for local mode. Re-created per base URL so a
 * `/model`-style switch still picks up the right endpoint.
 */
const localProviderCache = new Map<string, OllamaProvider>();

function getLocalProvider(baseUrl: string): OllamaProvider {
  const normalized = baseUrl.replace(/\/+$/, '');
  // ollama-ai-provider expects the /api path for chat completions.
  const apiBase = normalized.endsWith('/api') ? normalized : `${normalized}/api`;
  let provider = localProviderCache.get(apiBase);
  if (!provider) {
    provider = createOllama({ baseURL: apiBase });
    localProviderCache.set(apiBase, provider);
  }
  return provider;
}

/**
 * Resolve the Mastra model config for a given SDLC role.
 *
 * - Local: returns a LanguageModelV1 from `ollama-ai-provider` pointed at
 *   OLLAMA_BASE_URL. Local Ollama doesn't stream tool-call deltas reliably, so
 *   we enable `simulateStreaming` to keep the harness's per-agent streaming
 *   panels working.
 * - Cloud: returns a model-router id string (`ollama-cloud/<model>`), which
 *   Mastra's model router resolves using OLLAMA_API_KEY.
 */
export function getOllamaModel(
  role: SdlcRole,
  cfg: HarnessConfig,
  ollamaBaseUrl: string,
): MastraModelConfig {
  const modelId = cfg.roleModels[role] ?? DEFAULT_ROLE_MODELS[role];

  if (cfg.provider === 'cloud') {
    // Mastra model-router id: "<provider>/<model>". Cloud models are prefixed
    // with `ollama-cloud/`. If the user already included the prefix, keep it.
    const id = modelId.startsWith('ollama-cloud/') ? modelId : `ollama-cloud/${modelId}`;
    return { id: id as `${string}/${string}`, apiKey: cfg.ollamaApiKey } as MastraModelConfig;
  }

  const settings = { simulateStreaming: true };
  return getLocalProvider(ollamaBaseUrl).chat(modelId, settings) as MastraModelConfig;
}