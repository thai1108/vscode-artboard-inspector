import type { Rgba } from './scene.ts';

export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

function hex2(n: number): string {
  return Math.round(n).toString(16).padStart(2, '0').toUpperCase();
}

/** "#RRGGBB", ignoring alpha. */
export function toHex(c: Rgba): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

export function roundAlpha(a: number): number {
  return Math.round(a * 100) / 100;
}

/** Hex when opaque, rgba() otherwise. */
export function toCssColor(c: Rgba): string {
  if (c.a >= 1) {
    return toHex(c);
  }
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${roundAlpha(c.a)})`;
}
