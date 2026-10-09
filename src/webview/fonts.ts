import type { ArtboardScene, SceneNode } from '../xd/scene.ts';

const SAMPLE = 'mmmmmmmmmmlli WW 0123 日本語テキスト';
const availability = new Map<string, boolean>();
let context: CanvasRenderingContext2D | null = null;

/** Detects a locally installed font by comparing its metrics against two generic families. */
export function isFontAvailable(family: string): boolean {
  const cached = availability.get(family);
  if (cached !== undefined) {
    return cached;
  }
  context ??= document.createElement('canvas').getContext('2d');
  if (!context) {
    return true;
  }
  const ctx = context;
  const width = (font: string) => {
    ctx.font = font;
    return ctx.measureText(SAMPLE).width;
  };
  const name = `"${family.replace(/"/g, '')}"`;
  const available = ['monospace', 'serif'].some((generic) => width(`72px ${name}, ${generic}`) !== width(`72px ${generic}`));
  availability.set(family, available);
  return available;
}

export interface FontUsage {
  family: string;
  /** True when XD only used it as a fallback for some glyphs. */
  fallback: boolean;
  available: boolean;
}

export function fontsUsed(scene: ArtboardScene): FontUsage[] {
  const families = new Map<string, boolean>();
  const walk = (nodes: SceneNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'text') {
        node.styles.forEach((style) => families.set(style.family, false));
        for (const run of node.lines.flatMap((line) => line.runs)) {
          if (run.glyphFont && !families.has(run.glyphFont)) {
            families.set(run.glyphFont, true);
          }
        }
      } else if (node.kind === 'group') {
        walk(node.children);
      }
    }
  };
  walk(scene.children);
  return [...families]
    .map(([family, fallback]) => ({ family, fallback, available: isFontAvailable(family) }))
    .sort((a, b) => Number(a.fallback) - Number(b.fallback) || a.family.localeCompare(b.family));
}
