import type { AgcColor } from './agc.ts';
import type { Rgba } from './scene.ts';

export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

export function parseAgcColor(color: AgcColor | undefined, fallback: Rgba = BLACK): Rgba {
  const value = color?.value;
  if (value === undefined) {
    return fallback;
  }
  const rawAlpha = color?.alpha;
  const alpha = typeof rawAlpha === 'number' && Number.isFinite(rawAlpha) ? Math.min(1, Math.max(0, rawAlpha)) : 1;
  if (typeof value === 'number') {
    return {
      r: (value >>> 16) & 0xff,
      g: (value >>> 8) & 0xff,
      b: value & 0xff,
      a: (((value >>> 24) & 0xff) / 255) * alpha,
    };
  }
  if (typeof value !== 'object' || value === null) {
    return fallback;
  }
  const channel = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(255, Math.max(0, Math.round(n))) : 0);
  return { r: channel(value.r), g: channel(value.g), b: channel(value.b), a: alpha };
}

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
