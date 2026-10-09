import { fmt, type Box } from '../render/geometry.ts';
import type { Guide } from '../render/measure.ts';
import type { Viewport } from './viewport.ts';

export interface OverlayState {
  hovered: Box | null;
  selected: Box | null;
  guides: Guide[];
}

const LABEL_HEIGHT = 18;
const CHAR_WIDTH = 7;

/** Draws hover/selection outlines and redlines in screen space, so strokes stay 1px at any zoom. */
export function drawOverlay(svg: SVGSVGElement, viewport: Viewport, state: OverlayState): void {
  const parts: string[] = [];
  const screenBox = (box: Box) => {
    const topLeft = viewport.toScreen(box.x, box.y);
    return { x: topLeft.x, y: topLeft.y, width: box.width * viewport.zoom, height: box.height * viewport.zoom };
  };

  if (state.hovered) {
    const box = screenBox(state.hovered);
    parts.push(rect(box, 'ov-hover'));
  }
  if (state.selected) {
    const box = screenBox(state.selected);
    parts.push(rect(box, 'ov-selected'));
  }
  // The size label would sit on top of the redline labels while measuring.
  if (state.selected && !state.guides.length) {
    const box = screenBox(state.selected);
    parts.push(label(`${fmt(state.selected.width)} × ${fmt(state.selected.height)}`, box.x + box.width / 2, box.y + box.height + 4 + LABEL_HEIGHT / 2, 'ov-size'));
  }
  for (const guide of state.guides) {
    const from = viewport.toScreen(guide.x1, guide.y1);
    const to = viewport.toScreen(guide.x2, guide.y2);
    if (guide.value === undefined) {
      parts.push(`<line class="ov-extension" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"/>`);
      continue;
    }
    parts.push(`<line class="ov-guide" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"/>`);
    parts.push(...endCaps(from, to));
    parts.push(label(fmt(guide.value), (from.x + to.x) / 2, (from.y + to.y) / 2, 'ov-distance'));
  }
  svg.innerHTML = parts.join('');
}

function rect(box: Box, className: string): string {
  return `<rect class="${className}" x="${box.x + 0.5}" y="${box.y + 0.5}" width="${Math.max(0, box.width - 1)}" height="${Math.max(0, box.height - 1)}"/>`;
}

function endCaps(from: { x: number; y: number }, to: { x: number; y: number }): string[] {
  const horizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
  return [from, to].map((p) =>
    horizontal
      ? `<line class="ov-guide" x1="${p.x}" y1="${p.y - 4}" x2="${p.x}" y2="${p.y + 4}"/>`
      : `<line class="ov-guide" x1="${p.x - 4}" y1="${p.y}" x2="${p.x + 4}" y2="${p.y}"/>`,
  );
}

function label(text: string, cx: number, cy: number, className: string): string {
  const width = text.length * CHAR_WIDTH + 10;
  return (
    `<g class="${className}"><rect x="${cx - width / 2}" y="${cy - LABEL_HEIGHT / 2}" width="${width}" height="${LABEL_HEIGHT}" rx="3"/>` +
    `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central">${text}</text></g>`
  );
}
