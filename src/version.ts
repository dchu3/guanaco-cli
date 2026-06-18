import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read the package version from package.json. Resolves relative to this file:
 * `dist/version.js` → `../package.json` and `src/version.ts` → `../package.json`
 * both work (the package root is one level up in either layout).
 */
export function getVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, '..', 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** True only for a bare `--version` / `-v` (no other args). */
export function wantsVersion(argv: string[]): boolean {
  return argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v');
}