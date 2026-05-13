const enabled = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

export function debug(scope: string, ...args: unknown[]): void {
  if (!enabled) return;
  // eslint-disable-next-line no-console
  console.error(`[${scope}]`, ...args);
}
