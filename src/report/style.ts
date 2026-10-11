type Paint = (s: string | number) => string;

export interface Style {
  bold: Paint;
  dim: Paint;
  amber: Paint;
}

/** Terminal colours, as in rookery: bold headings, dim detail, amber for the brand's one accent. */
export function style(color: boolean): Style {
  const c = (code: string): Paint => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { bold: c('1'), dim: c('2'), amber: c('38;5;214') };
}

/** Colour on a terminal; --no-color and NO_COLOR turn it off, FORCE_COLOR turns it on. */
export function useColor(noColorFlag: boolean, env = process.env, isTTY = process.stdout.isTTY === true): boolean {
  if (noColorFlag || env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return isTTY;
}

/** A bar of up to `width` blocks, scaled to the largest value in its section. */
export const bar = (value: number, max: number, width = 18) => '█'.repeat(Math.max(1, Math.round((value / Math.max(max, 1)) * width)));
