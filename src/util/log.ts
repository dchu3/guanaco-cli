const enabled = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

export function maskPii(val: string | number | undefined | null): string {
  if (val === undefined || val === null) return 'null';
  const s = String(val);
  if (s.length <= 4) return '****';
  return s.slice(0, 2) + '***' + s.slice(-2);
}

export function debug(scope: string, ...args: unknown[]): void {
  if (!enabled) return;
  // eslint-disable-next-line no-console
  console.error(`[${scope}]`, ...args);
}
