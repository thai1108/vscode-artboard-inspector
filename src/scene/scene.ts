// Normalized, renderer-friendly scene built from an XD artboard or a Figma frame. Shared by the extension host and the webview,
// so it must stay plain JSON (it is posted to the webview as-is).

/** 2D affine matrix in SVG order: [a c e; b d f]. */
export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** r/g/b are 0–255, a is 0–1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface GradientStop {
  offset: number;
  color: Rgba;
}

export interface SolidPaint {
  kind: 'solid';
  color: Rgba;
}

/** Coordinates are fractions of the shape's bounding box. */
export interface LinearGradientPaint {
  kind: 'linear';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stops: GradientStop[];
}

/** Coordinates are fractions of the shape's bounding box. */
export interface RadialGradientPaint {
  kind: 'radial';
  cx: number;
  cy: number;
  r: number;
  fx: number;
  fy: number;
  stops: GradientStop[];
}

export interface ImagePaint {
  kind: 'image';
  uid: string;
  width: number;
  height: number;
  fit: 'cover' | 'contain';
}

export type Paint = SolidPaint | LinearGradientPaint | RadialGradientPaint | ImagePaint;

export type StrokeAlign = 'inside' | 'center' | 'outside';

export interface Stroke {
  color: Rgba;
  /** The widest side when `sides` is set. */
  width: number;
  /** Per-side widths [top, right, bottom, left] for boxes whose sides differ (Figma frames). */
  sides?: [number, number, number, number];
  align: StrokeAlign;
  dash: number[];
  cap: 'butt' | 'round' | 'square';
  join: 'miter' | 'round' | 'bevel';
}

/** Blur is the value XD shows in its UI, which equals the CSS box-shadow blur radius. */
export interface Shadow {
  x: number;
  y: number;
  blur: number;
  color: Rgba;
}

export interface RectGeometry {
  type: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  /** [topLeft, topRight, bottomRight, bottomLeft] */
  radii: [number, number, number, number];
}

export interface EllipseGeometry {
  type: 'ellipse';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface LineGeometry {
  type: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PathGeometry {
  type: 'path';
  d: string;
  /** Defaults to evenodd, which is what XD outlines expect. */
  fillRule?: 'nonzero' | 'evenodd';
}

export type Geometry = RectGeometry | EllipseGeometry | LineGeometry | PathGeometry;

export type TextTransform = 'none' | 'uppercase' | 'lowercase' | 'titlecase';

export interface TextStyle {
  family: string;
  /** Style name as written in XD, e.g. "Medium", "SemiBold". */
  fontStyle: string;
  weight: number;
  italic: boolean;
  size: number;
  color: Rgba;
  /** In 1/1000 em, like XD's character spacing. */
  letterSpacing: number;
  underline: boolean;
  strikethrough: boolean;
  textTransform: TextTransform;
}

export interface TextRun {
  text: string;
  /** Index into TextNode.styles. */
  style: number;
  /** Explicit start x; when absent the run continues after the previous one. */
  x?: number;
  /** Explicit x of every character (one per code point), when the source laid the glyphs out itself. */
  xs?: number[];
  /** Font XD fell back to for these glyphs, when it differs from the style's family. */
  glyphFont?: string;
}

export interface TextLine {
  x: number;
  /** Baseline. */
  y: number;
  runs: TextRun[];
}

interface NodeBase {
  /** Unique within the artboard scene (XD ids repeat when a component is reused). */
  key: string;
  id: string;
  name: string;
  /** Local transform relative to the parent (top-level nodes are relative to the artboard's top-left). */
  transform: Matrix;
  opacity: number;
  shadows: Shadow[];
  /** Size of the layer's own box (Figma); bounds use it instead of measuring the drawn geometry. */
  layoutSize?: { width: number; height: number };
}

export interface ShapeNode extends NodeBase {
  kind: 'shape';
  geometry: Geometry;
  fill: Paint | null;
  stroke: Stroke | null;
  /** Precomputed outline of the stroke (Figma), drawn filled with the stroke color instead of stroking. */
  strokeOutline?: string;
}

export interface TextNode extends NodeBase {
  kind: 'text';
  content: string;
  styles: TextStyle[];
  lines: TextLine[];
  align: 'left' | 'center' | 'right' | 'justify';
  lineHeight: number | null;
  frame: { type: 'positioned' | 'area'; width: number; height: number };
}

/** Own box styling of a container that paints itself (a Figma frame). */
export interface FrameStyle {
  width: number;
  height: number;
  /** [topLeft, topRight, bottomRight, bottomLeft] */
  radii: [number, number, number, number];
  fill: Paint | null;
  stroke: Stroke | null;
}

export interface GroupNode extends NodeBase {
  kind: 'group';
  role: 'group' | 'frame' | 'component' | 'instance' | 'repeatGrid';
  /** Set for frames: they paint their own box and have a fixed size, unlike groups sized by their children. */
  frame: FrameStyle | null;
  /** Mask shapes in the group's local space. */
  clip: ShapeNode[] | null;
  children: SceneNode[];
}

export type SceneNode = ShapeNode | TextNode | GroupNode;

export interface ArtboardSummary {
  id: string;
  name: string;
  width: number;
  height: number;
}

export interface ArtboardScene extends ArtboardSummary {
  background: Rgba | null;
  children: SceneNode[];
  imageUids: string[];
  /** Layers that could not be converted, reported to the user instead of being dropped silently. */
  warnings: string[];
}
