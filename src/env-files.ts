import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve Node `--env-file=…` flags for the launcher, in override order:
 *   1. `~/.config/guanaco/.env`  (global config — applies in every repo)
 *   2. `<cwd>/.env`              (per-repo override; wins over the global)
 *
 * Flags are only emitted for files that exist, so Node never prints its
 * `.env not found. Continuing without it.` notice. Later flags override
 * earlier ones (Node 20.12+ / 22 applies multiple `--env-file` in order).
 *
 * Pure + injectable (`exists`) so it is unit-testable without touching disk.
 */
export interface ResolveEnvFilesOptions {
  home: string;
  cwd: string;
  exists?: (path: string) => boolean;
}

export function resolveEnvFiles(opts: ResolveEnvFilesOptions): string[] {
  const exists = opts.exists ?? existsSync;
  const flags: string[] = [];
  const globalEnv = join(opts.home, '.config', 'guanaco', '.env');
  if (exists(globalEnv)) flags.push(`--env-file=${globalEnv}`);
  const localEnv = join(opts.cwd, '.env');
  if (exists(localEnv)) flags.push(`--env-file=${localEnv}`);
  return flags;
}