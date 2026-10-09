import { BLACK } from '../scene/color.ts';
import type { Rgba } from '../scene/scene.ts';
import type { AgcColor } from './agc.ts';

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
