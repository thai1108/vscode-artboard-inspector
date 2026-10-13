// Layer boxes from the scene model alone, for the extension host (comparing versions). The webview measures the
// rendered SVG instead (webview/bounds.ts) with the same rules, so both give the same numbers, except for the width
// of positioned text: that depends on the fonts installed, so here it is estimated and marked as such.
import { IDENTITY, multiply } from '../scene/matrix.ts';
import type { ArtboardScene, Geometry, Matrix, SceneNode, TextNode } from '../scene/scene.ts';
import { WIDE_CHARACTER } from '../scene/text.ts';
import { intersect, union, type Box } from './geometry.ts';

// Noto Sans ascender/descender: XD sizes text boxes from the baseline with these, not from the glyphs drawn.
export const TEXT_ASCENT = 1.069;
export const TEXT_DESCENT = 0.293;

/** Glyph advance in em used to estimate positioned text widths; wide characters take a full em. */
const NARROW_ADVANCE = 0.55;

/**
 * `estimated`: what depends on glyph widths — the width of positioned text and of the groups around it, or the
 * whole box when such text is rotated or skewed. Only exact values are compared.
 */
export interface LayerBox extends Box {
  estimated: 'none' | 'width' | 'all';
}

const SEVERITY = { none: 0, width: 1, all: 2 } as const;

/** Every layer's box in artboard pixels, keyed by layer key; layers that draw nothing have none. */
export function layerBoxes(scene: ArtboardScene): Map<string, LayerBox> {
  const boxes = new Map<string, LayerBox>();
  const measure = (node: SceneNode, parent: Matrix): LayerBox | null => {
    const world = multiply(parent, node.transform);
    let box: LayerBox | null = null;
    switch (node.kind) {
      case 'shape': {
        const local = geometryBox(node.geometry);
        box = local ? { ...transformBox(world, local), estimated: 'none' } : null;
        break;
      }
      case 'text':
        box = textBox(node, world);
        break;
      case 'group': {
        const children = node.children.map((child) => measure(child, world)).filter((child): child is LayerBox => child !== null);
        const extent = union(children);
        const clip = extent && node.clip ? union(node.clip.map((shape) => transformBox(multiply(world, shape.transform), geometryBox(shape.geometry) ?? ZERO))) : null;
        const clipped = extent && clip ? intersect(extent, clip) : extent;
        if (clipped) {
          const estimated = children.reduce<LayerBox['estimated']>((worst, child) => (SEVERITY[child.estimated] > SEVERITY[worst] ? child.estimated : worst), 'none');
          box = { ...clipped, estimated };
        }
        break;
      }
    }
    if (node.layoutSize) {
      box = { ...transformBox(world, { x: 0, y: 0, width: node.layoutSize.width, height: node.layoutSize.height }), estimated: 'none' };
    }
    if (box) {
      boxes.set(node.key, box);
    }
    return box;
  };
  scene.children.forEach((node) => measure(node, IDENTITY));
  return boxes;
}

const ZERO: Box = { x: 0, y: 0, width: 0, height: 0 };

/** The local box of a shape's geometry, as the SVG getBBox() of its element gives it; null when a path is unreadable. */
export function geometryBox(geometry: Geometry): Box | null {
  switch (geometry.type) {
    case 'rect':
      return { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
    case 'ellipse':
      return { x: geometry.cx - geometry.rx, y: geometry.cy - geometry.ry, width: geometry.rx * 2, height: geometry.ry * 2 };
    case 'line': {
      const x = Math.min(geometry.x1, geometry.x2);
      const y = Math.min(geometry.y1, geometry.y2);
      return { x, y, width: Math.abs(geometry.x2 - geometry.x1), height: Math.abs(geometry.y2 - geometry.y1) };
    }
    case 'path':
      return pathBounds(geometry.d);
  }
}

function textBox(node: TextNode, world: Matrix): LayerBox {
  if (node.frame.type === 'area') {
    return { ...transformBox(world, { x: 0, y: 0, width: node.frame.width, height: node.frame.height }), estimated: 'none' };
  }
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const line of node.lines) {
    let size = 0;
    let cursor = line.x;
    left = Math.min(left, line.x);
    for (const run of line.runs) {
      const style = node.styles[run.style];
      const fontSize = style?.size ?? 0;
      const spacing = ((style?.letterSpacing ?? 0) / 1000) * fontSize;
      size = Math.max(size, fontSize);
      const chars = Array.from(run.text);
      const advance = (char: string) => (WIDE_CHARACTER.test(char) ? 1 : NARROW_ADVANCE) * fontSize + spacing;
      if (run.xs?.length) {
        left = Math.min(left, run.xs[0] ?? cursor);
        cursor = (run.xs[run.xs.length - 1] ?? cursor) + advance(chars[chars.length - 1] ?? ' ');
      } else {
        if (run.x !== undefined) {
          cursor = run.x;
          left = Math.min(left, run.x);
        }
        cursor += chars.reduce((sum, char) => sum + advance(char), 0);
      }
    }
    right = Math.max(right, cursor);
    top = Math.min(top, line.y - TEXT_ASCENT * size);
    bottom = Math.max(bottom, line.y + TEXT_DESCENT * size);
  }
  const local = Number.isFinite(left) && Number.isFinite(top) ? { x: left, y: top, width: Math.max(0, right - left), height: bottom - top } : ZERO;
  const axisAligned = world.b === 0 && world.c === 0 && world.a > 0 && world.d > 0;
  return { ...transformBox(world, local), estimated: axisAligned ? 'width' : 'all' };
}

export function transformBox(m: Matrix, box: Box): Box {
  const corners = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height],
  ].map(([x = 0, y = 0]) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

const PATH_TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const ARGUMENT_COUNTS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/**
 * A path command in absolute coordinates: S/T become C/Q with the reflected control point, H/V become L.
 * Values: M/L x y; C x1 y1 x2 y2 x y; Q x1 y1 x y; A rx ry rotation large sweep x y; Z none.
 */
export interface PathCommand {
  type: 'M' | 'L' | 'C' | 'Q' | 'A' | 'Z';
  values: number[];
}

/** Parses SVG path data up to the first malformed command. */
export function parsePath(d: string): PathCommand[] {
  const tokens = d.match(PATH_TOKEN) ?? [];
  const commands: PathCommand[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // The previous curve's last control point, reflected by S/T.
  let controlX = 0;
  let controlY = 0;
  let previous = '';
  let command = '';
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] as string;
    if (/^[a-z]$/i.test(token)) {
      // Path data must start with a moveto; browsers draw nothing otherwise.
      if (!commands.length && token !== 'M' && token !== 'm') {
        break;
      }
      command = token;
      i++;
      if (command === 'z' || command === 'Z') {
        commands.push({ type: 'Z', values: [] });
        x = startX;
        y = startY;
        previous = 'z';
        continue;
      }
    } else if (!command || command === 'z' || command === 'Z') {
      break;
    }
    const lower = command.toLowerCase();
    const count = ARGUMENT_COUNTS[lower] ?? 0;
    const args = tokens.slice(i, i + count).map(Number);
    if (args.length < count || args.some((value) => !Number.isFinite(value))) {
      break;
    }
    i += count;
    const relative = command === lower;
    const ox = relative ? x : 0;
    const oy = relative ? y : 0;
    const [a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0, a6 = 0] = args;
    switch (lower) {
      case 'm':
        x = ox + a0;
        y = oy + a1;
        startX = x;
        startY = y;
        commands.push({ type: 'M', values: [x, y] });
        // Further pairs after a moveto are linetos.
        command = relative ? 'l' : 'L';
        break;
      case 'l':
        x = ox + a0;
        y = oy + a1;
        commands.push({ type: 'L', values: [x, y] });
        break;
      case 'h':
        x = ox + a0;
        commands.push({ type: 'L', values: [x, y] });
        break;
      case 'v':
        y = oy + a0;
        commands.push({ type: 'L', values: [x, y] });
        break;
      case 'c':
      case 's': {
        const reflect = previous === 'c' || previous === 's';
        const [c1x, c1y] = lower === 'c' ? [ox + a0, oy + a1] : reflect ? [2 * x - controlX, 2 * y - controlY] : [x, y];
        const [c2x, c2y, ex, ey] = lower === 'c' ? [ox + a2, oy + a3, ox + a4, oy + a5] : [ox + a0, oy + a1, ox + a2, oy + a3];
        commands.push({ type: 'C', values: [c1x, c1y, c2x, c2y, ex, ey] });
        controlX = c2x;
        controlY = c2y;
        x = ex;
        y = ey;
        break;
      }
      case 'q':
      case 't': {
        const reflect = previous === 'q' || previous === 't';
        const [cx, cy] = lower === 'q' ? [ox + a0, oy + a1] : reflect ? [2 * x - controlX, 2 * y - controlY] : [x, y];
        const [ex, ey] = lower === 'q' ? [ox + a2, oy + a3] : [ox + a0, oy + a1];
        commands.push({ type: 'Q', values: [cx, cy, ex, ey] });
        controlX = cx;
        controlY = cy;
        x = ex;
        y = ey;
        break;
      }
      case 'a':
        x = ox + a5;
        y = oy + a6;
        commands.push({ type: 'A', values: [a0, a1, a2, a3, a4, x, y] });
        break;
    }
    previous = lower;
  }
  return commands;
}

/** The tight bounds of SVG path data (curve extrema included, like getBBox), or null when it draws nothing readable. */
export function pathBounds(d: string): Box | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (px: number, py: number) => {
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  };
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  for (const { type, values } of parsePath(d)) {
    const [v0 = 0, v1 = 0, v2 = 0, v3 = 0, v4 = 0, v5 = 0, v6 = 0] = values;
    switch (type) {
      case 'M':
        startX = v0;
        startY = v1;
        add(v0, v1);
        break;
      case 'L':
        add(v0, v1);
        break;
      case 'C':
        cubicExtent(x, y, v0, v1, v2, v3, v4, v5, add);
        break;
      case 'Q':
        quadraticExtent(x, y, v0, v1, v2, v3, add);
        break;
      case 'A':
        arcExtent(x, y, v0, v1, v2, v3 !== 0, v4 !== 0, v5, v6, add);
        break;
      case 'Z':
        x = startX;
        y = startY;
        continue;
    }
    x = values[values.length - 2] ?? x;
    y = values[values.length - 1] ?? y;
  }
  if (!Number.isFinite(minX)) {
    return null;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Path data reduced to what it draws, wherever it sits and however it was written (absolute or relative commands,
 * number formatting): coordinates relative to the first point, to 0.01.
 */
export function pathSignature(d: string): string {
  const commands = parsePath(d);
  const [originX = 0, originY = 0] = commands[0]?.values ?? [];
  const round = (value: number) => String(Math.round(value * 100) / 100);
  return commands
    .map(({ type, values }) => {
      // Arc radii, rotation and flags are not coordinates.
      const coordinates = type === 'A' ? values.slice(5) : values;
      const shifted = coordinates.map((value, i) => value - (i % 2 === 0 ? originX : originY));
      return type + [...(type === 'A' ? values.slice(0, 5) : []), ...shifted].map(round).join(' ');
    })
    .join('');
}

type AddPoint = (x: number, y: number) => void;

function cubicExtent(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, add: AddPoint): void {
  add(x3, y3);
  const at = (t: number, p0: number, p1: number, p2: number, p3: number) => {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  };
  for (const [p0, p1, p2, p3] of [
    [x0, x1, x2, x3],
    [y0, y1, y2, y3],
  ] as const) {
    // Roots of the derivative: a·t² + b·t + c = 0.
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const c = p1 - p0;
    for (const t of quadraticRoots(a, b, c)) {
      if (t > 0 && t < 1) {
        add(at(t, x0, x1, x2, x3), at(t, y0, y1, y2, y3));
      }
    }
  }
}

function quadraticExtent(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, add: AddPoint): void {
  add(x2, y2);
  for (const [p0, p1, p2] of [
    [x0, x1, x2],
    [y0, y1, y2],
  ] as const) {
    const denominator = p0 - 2 * p1 + p2;
    const t = denominator === 0 ? -1 : (p0 - p1) / denominator;
    if (t > 0 && t < 1) {
      const u = 1 - t;
      add(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2);
    }
  }
}

function quadraticRoots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < 1e-12) {
    return Math.abs(b) < 1e-12 ? [] : [-c / b];
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    return [];
  }
  const root = Math.sqrt(discriminant);
  return [(-b + root) / (2 * a), (-b - root) / (2 * a)];
}

/** Extent of an SVG elliptical arc, via its center parameterization (SVG 1.1, appendix F.6.5). */
function arcExtent(x1: number, y1: number, rxIn: number, ryIn: number, degrees: number, large: boolean, sweep: boolean, x2: number, y2: number, add: AddPoint): void {
  add(x2, y2);
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (!rx || !ry || (x1 === x2 && y1 === y2)) {
    return;
  }
  const phi = (degrees * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const px = cos * dx + sin * dy;
  const py = -sin * dx + cos * dy;
  const scale = (px * px) / (rx * rx) + (py * py) / (ry * ry);
  if (scale > 1) {
    rx *= Math.sqrt(scale);
    ry *= Math.sqrt(scale);
  }
  const numerator = rx * rx * ry * ry - rx * rx * py * py - ry * ry * px * px;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / (rx * rx * py * py + ry * ry * px * px)));
  const cxp = (factor * rx * py) / ry;
  const cyp = (-factor * ry * px) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number) => Math.atan2(uy, ux);
  const start = angle((px - cxp) / rx, (py - cyp) / ry);
  let delta = angle((-px - cxp) / rx, (-py - cyp) / ry) - start;
  if (sweep && delta < 0) {
    delta += 2 * Math.PI;
  } else if (!sweep && delta > 0) {
    delta -= 2 * Math.PI;
  }
  const point = (theta: number) => ({
    x: cx + rx * cos * Math.cos(theta) - ry * sin * Math.sin(theta),
    y: cy + rx * sin * Math.cos(theta) + ry * cos * Math.sin(theta),
  });
  // Where dx/dθ or dy/dθ is zero, and the opposite side of the ellipse.
  const thetaX = Math.atan2(-ry * sin, rx * cos);
  const thetaY = Math.atan2(ry * cos, rx * sin);
  for (const theta of [thetaX, thetaX + Math.PI, thetaY, thetaY + Math.PI]) {
    const offset = ((((theta - start) * (delta < 0 ? -1 : 1)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (offset < Math.abs(delta)) {
      const p = point(theta);
      add(p.x, p.y);
    }
  }
}
