// Raw shapes of the JSON stored inside an .xd archive (manifest + AGC graphics trees).
// Only the fields the viewer reads are declared; everything is optional unless XD always writes it.

export interface XdManifestNode {
  id?: string;
  name?: string;
  path?: string;
  'uxdesign#bounds'?: XdBounds;
  children?: XdManifestNode[];
}

export interface XdBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AgcRgbValue {
  r: number;
  g: number;
  b: number;
}

export interface AgcColor {
  mode?: string;
  /** Either an RGB object or a packed 0xAARRGGBB integer (ranged text styles use the latter). */
  value?: AgcRgbValue | number;
  alpha?: number;
}

export interface AgcGradientStop {
  offset: number;
  color: AgcColor;
}

export interface AgcGradient {
  meta?: { ux?: { gradientResources?: { type?: 'linear' | 'radial'; stops?: AgcGradientStop[] } } };
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  cx?: number;
  cy?: number;
  r?: number;
  fx?: number;
  fy?: number;
  units?: string;
}

export interface AgcPattern {
  width: number;
  height: number;
  meta?: {
    ux?: {
      uid?: string;
      scaleBehavior?: string;
    };
  };
}

export interface AgcFill {
  type: string;
  color?: AgcColor;
  pattern?: AgcPattern;
  gradient?: AgcGradient;
}

export interface AgcStroke {
  type: string;
  color?: AgcColor;
  width?: number;
  align?: 'inside' | 'outside' | 'center';
  dash?: number[];
  cap?: 'butt' | 'round' | 'square';
  join?: 'miter' | 'round' | 'bevel';
}

export interface AgcDropShadow {
  dx: number;
  dy: number;
  /** XD stores half of the blur value shown in its UI. */
  r: number;
  color: AgcColor;
}

export interface AgcFilter {
  type: string;
  visible?: boolean;
  params?: { dropShadows?: AgcDropShadow[] };
}

export interface AgcFont {
  family?: string;
  style?: string;
  postscriptName?: string;
  size?: number;
}

export interface AgcTextAttributes {
  lineHeight?: number;
  paragraphAlign?: 'left' | 'center' | 'right' | 'justify';
  letterSpacing?: number;
}

export interface AgcStyle {
  fill?: AgcFill;
  stroke?: AgcStroke;
  filters?: AgcFilter[];
  opacity?: number;
  font?: AgcFont;
  textAttributes?: AgcTextAttributes;
}

export interface AgcTransform {
  a?: number;
  b?: number;
  c?: number;
  d?: number;
  tx?: number;
  ty?: number;
}

export interface AgcRectShape {
  type: 'rect';
  x?: number;
  y?: number;
  width: number;
  height: number;
  /** One radius for all corners, or [topLeft, topRight, bottomRight, bottomLeft]. */
  r?: number | number[];
}

export interface AgcCircleShape {
  type: 'circle';
  cx: number;
  cy: number;
  r: number;
}

export interface AgcEllipseShape {
  type: 'ellipse';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface AgcLineShape {
  type: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface AgcPathShape {
  type: 'path' | 'compound';
  path?: string;
}

export interface AgcPolygonShape {
  type: 'polygon';
  path?: string;
  points?: { x: number; y: number }[];
}

export type AgcShape = AgcRectShape | AgcCircleShape | AgcEllipseShape | AgcLineShape | AgcPathShape | AgcPolygonShape;

export interface AgcRangedStyle {
  length?: number;
  fontFamily?: string;
  fontStyle?: string;
  postscriptName?: string;
  fontSize?: number;
  charSpacing?: number;
  underline?: boolean;
  strikethrough?: boolean;
  textTransform?: string;
  fill?: AgcColor;
}

export interface AgcTextSegment {
  from: number;
  to: number;
  /** Missing when the segment continues right after the previous one on the same line. */
  x?: number;
  y?: number;
  /** The font XD actually drew the glyphs with (e.g. the system fallback for Japanese). */
  style?: { font?: AgcFont };
}

export interface AgcText {
  rawText: string;
  frame?: { type?: string; width?: number; height?: number };
  paragraphs?: { lines?: AgcTextSegment[][] }[];
}

export interface AgcMetaUx {
  rangedStyles?: AgcRangedStyle[];
  clipPathResources?: { children?: AgcNode[] };
  symbolId?: string;
  repeatGrid?: unknown;
}

interface AgcNodeBase {
  id?: string;
  name?: string;
  visible?: boolean;
  transform?: AgcTransform;
  style?: AgcStyle;
  meta?: { ux?: AgcMetaUx };
}

export interface AgcShapeNode extends AgcNodeBase {
  type: 'shape';
  shape: AgcShape;
}

export interface AgcTextNode extends AgcNodeBase {
  type: 'text';
  text: AgcText;
}

export interface AgcGroupNode extends AgcNodeBase {
  type: 'group';
  group?: { children?: AgcNode[] };
}

/** A linked copy of another node (usually a component master child); `group` overrides the source's children. */
export interface AgcSyncRefNode extends AgcNodeBase {
  type: 'syncRef';
  syncSourceGuid: string;
  group?: { children?: AgcNode[] };
}

export type AgcNode = AgcShapeNode | AgcTextNode | AgcGroupNode | AgcSyncRefNode;

export interface AgcArtboardNode {
  type: 'artboard';
  id?: string;
  style?: AgcStyle;
  artboard?: { children?: AgcNode[] };
}

export interface AgcGraphicContent {
  children?: (AgcArtboardNode | AgcNode)[];
}
