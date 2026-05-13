const enabled = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

export function debug(scope: string, ...args: unknown[]): void {
  if (!enabled) return;
  // eslint-disable-next-line no-console
  console.error(`[${scope}]`, ...args);
}

/**
 * Masks sensitive information (like user IDs or tokens) for logging.
 */
export function maskPii(value: string | number | undefined): string {
  if (value === undefined) return 'undefined';
  const str = String(value);
  if (str.length <= 4) return '****';
  return str.slice(0, 2) + '*'.repeat(str.length - 4) + str.slice(-2);
}
