import type { ArtboardScene, GroupNode, Matrix, SceneNode, ShapeNode, Stroke, TextNode, TextStyle } from '../../src/scene/scene.ts';

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
let nextKey = 0;

function base(overrides: Partial<SceneNode>) {
  return { key: `k${nextKey++}`, id: '', name: '', transform: IDENTITY, opacity: 1, shadows: [], ...overrides };
}

export function shape(overrides: Partial<ShapeNode> = {}): ShapeNode {
  return {
    ...base(overrides),
    kind: 'shape',
    geometry: { type: 'rect', x: 0, y: 0, width: 100, height: 40, radii: [0, 0, 0, 0] },
    fill: null,
    stroke: null,
    ...overrides,
  };
}

export const textStyle = (overrides: Partial<TextStyle> = {}): TextStyle => ({
  family: 'Noto Sans',
  fontStyle: 'Medium',
  weight: 500,
  italic: false,
  size: 16,
  color: { r: 51, g: 51, b: 51, a: 1 },
  letterSpacing: 0,
  underline: false,
  strikethrough: false,
  textTransform: 'none',
  ...overrides,
});

export function text(overrides: Partial<TextNode> = {}): TextNode {
  return {
    ...base(overrides),
    kind: 'text',
    content: 'Hello',
    styles: [textStyle()],
    lines: [{ x: 0, y: 16, runs: [{ text: 'Hello', style: 0 }] }],
    align: 'left',
    lineHeight: 19,
    frame: { type: 'positioned', width: 0, height: 0 },
    ...overrides,
  };
}

export function group(children: SceneNode[], overrides: Partial<GroupNode> = {}): GroupNode {
  return { ...base(overrides), kind: 'group', role: 'group', frame: null, clip: null, children, ...overrides };
}

export function artboard(children: SceneNode[], overrides: Partial<ArtboardScene> = {}): ArtboardScene {
  return { id: 'artboard-a', name: 'Top', width: 430, height: 800, background: { r: 255, g: 255, b: 255, a: 1 }, children, imageUids: [], warnings: [], ...overrides };
}

export const stroke = (overrides: Partial<Stroke> = {}): Stroke => ({
  color: { r: 0, g: 0, b: 0, a: 1 },
  width: 1,
  align: 'center',
  dash: [],
  cap: 'butt',
  join: 'miter',
  ...overrides,
});
