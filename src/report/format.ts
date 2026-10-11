import { sep } from 'node:path';

/** Show paths under the home folder as ~/…, so reports don't carry the user's name. */
export function tilde(path: string, home: string): string {
  return path === home || path.startsWith(home + sep) ? '~' + path.slice(home.length).split(sep).join('/') : path;
}

export const day = (d: Date) => d.toISOString().slice(0, 10);

/** 1234 → "1.2k", 48210000 → "48.2M". */
export function compact(n: number): string {
  for (const [size, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']] as const) {
    if (n >= size) return (n / size).toFixed(1).replace(/\.0$/, '') + unit;
  }
  return String(n);
}

/** "1 session", "1,204 sessions". */
export function count(n: number, one: string, many = one + 's'): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}
