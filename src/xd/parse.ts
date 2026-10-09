import type { DesignDocument, DesignImage } from '../document.ts';
import type { BoardLayout } from '../scene/board.ts';
import { sniffImageMime } from '../image.ts';
import { fontWeight } from '../scene/text.ts';
import type { ZipArchive } from '../zip.ts';
import type {
  AgcArtboardNode,
  AgcFill,
  AgcFilter,
  AgcGraphicContent,
  AgcGroupNode,
  AgcNode,
  AgcRangedStyle,
  AgcShape,
  AgcShapeNode,
  AgcStroke,
  AgcStyle,
  AgcTextNode,
  AgcTransform,
  XdBounds,
  XdManifestNode,
} from './agc.ts';
import { BLACK } from '../scene/color.ts';
import { parseAgcColor } from './color.ts';
import { multiply, translate } from '../scene/matrix.ts';
import type {
  ArtboardScene,
  ArtboardSummary,
  Geometry,
  GradientStop,
  GroupNode,
  Matrix,
  Paint,
  SceneNode,
  Shadow,
  ShapeNode,
  Stroke,
  TextLine,
  TextNode,
  TextRun,
  TextStyle,
  TextTransform,
} from '../scene/scene.ts';

const RESOURCES_AGC = 'resources/graphics/graphicContent.agc';

/** Caps that keep a hostile file from exhausting the extension host; real XD files stay far below them. */
export const SCENE_LIMITS = {
  /** Layers converted per artboard. */
  maxNodes: 50_000,
  /** Nesting of groups and linked layers. */
  maxDepth: 256,
  /** Text runs per artboard. */
  maxTextRuns: 200_000,
  shadowsPerLayer: 16,
  warnings: 200,
};

const STROKE_CAPS = new Set(['butt', 'round', 'square']);
const STROKE_JOINS = new Set(['miter', 'round', 'bevel']);
const STROKE_ALIGNS = new Set(['inside', 'center', 'outside']);
const TEXT_ALIGNS = new Set(['left', 'center', 'right', 'justify']);

interface ArtboardEntry extends ArtboardSummary {
  bounds: XdBounds;
}

/** An opened .xd file: lists artboards and converts one artboard at a time into a scene. */
export class XdDocument implements DesignDocument {
  readonly artboards: readonly ArtboardSummary[];
  readonly board: BoardLayout;
  /** Problems found while reading the manifest, shown with every artboard. */
  readonly warnings: readonly string[];
  private readonly zip: ZipArchive;
  private readonly entries: ReadonlyMap<string, ArtboardEntry>;
  private sources: Map<string, AgcNode> | null = null;
  private sourcesIncludeArtwork = false;

  private constructor(zip: ZipArchive, entries: ArtboardEntry[], warnings: string[]) {
    this.zip = zip;
    this.entries = new Map(entries.map((entry) => [entry.id, entry]));
    this.artboards = entries.map(({ id, name, width, height }) => ({ id, name, width, height }));
    this.board = {
      pages: ['Canvas'],
      placements: entries.map(({ id, name, bounds }) => ({ id, page: 0, x: bounds.x, y: bounds.y, title: name })),
    };
    this.warnings = warnings;
  }

  static open(zip: ZipArchive): XdDocument {
    if (!zip.has('manifest')) {
      throw new Error('Not an Adobe XD file (manifest missing)');
    }
    const manifest = JSON.parse(zip.readText('manifest')) as XdManifestNode;
    const entries: ArtboardEntry[] = [];
    const warnings: string[] = [];
    const pending: XdManifestNode[] = [manifest];
    for (let node = pending.pop(); node; node = pending.pop()) {
      const path = node.path;
      if (typeof path === 'string' && path.startsWith('artboard-') && node['uxdesign#bounds']) {
        const name = typeof node.name === 'string' ? node.name.trim() : path;
        const bounds = toBounds(node['uxdesign#bounds']);
        if (bounds) {
          entries.push({ id: path, name, width: bounds.width, height: bounds.height, bounds });
        } else {
          warnings.push(`Artboard "${name}" skipped: invalid bounds in the manifest`);
        }
      }
      if (Array.isArray(node.children)) {
        pending.push(...[...node.children].reverse());
      }
    }
    entries.sort((p, q) => p.bounds.y - q.bounds.y || p.bounds.x - q.bounds.x);
    return new XdDocument(zip, entries, warnings);
  }

  scene(artboardId: string): ArtboardScene {
    const entry = this.entries.get(artboardId);
    if (!entry) {
      throw new Error(`Unknown artboard: ${artboardId}`);
    }
    const content = this.readAgc(`artwork/${artboardId}/graphics/graphicContent.agc`);
    const artboard = content.children?.find((child): child is AgcArtboardNode => child.type === 'artboard');
    if (!artboard) {
      throw new Error(`Artboard graphics missing: ${entry.name}`);
    }

    const builder = new SceneBuilder((guid) => this.findSource(guid));
    const origin = translate(-entry.bounds.x, -entry.bounds.y);
    const children = builder.children(artboard.artboard?.children ?? [], origin);
    const fill = artboard.style?.fill;
    return {
      id: entry.id,
      name: entry.name,
      width: entry.width,
      height: entry.height,
      background: fill?.type === 'solid' ? parseAgcColor(fill.color) : null,
      children,
      imageUids: [...builder.imageUids],
      warnings: [...this.warnings, ...builder.warnings],
    };
  }

  image(uid: string): DesignImage | undefined {
    const path = `resources/${uid}`;
    if (!/^[\w-]+$/.test(uid) || !this.zip.has(path)) {
      return undefined;
    }
    const data = this.zip.read(path);
    return { mime: sniffImageMime(data), data };
  }

  private readAgc(path: string): AgcGraphicContent {
    return JSON.parse(this.zip.readText(path)) as AgcGraphicContent;
  }

  private findSource(guid: string): AgcNode | undefined {
    if (!this.sources) {
      this.sources = new Map();
      if (this.zip.has(RESOURCES_AGC)) {
        indexSources(this.readAgc(RESOURCES_AGC), this.sources);
      }
    }
    const found = this.sources.get(guid);
    if (found || this.sourcesIncludeArtwork) {
      return found;
    }
    // Component masters normally live in resources; fall back to every artboard and the pasteboard once.
    this.sourcesIncludeArtwork = true;
    for (const name of this.zip.names()) {
      if (name.startsWith('artwork/') && name.endsWith('/graphicContent.agc')) {
        indexSources(this.readAgc(name), this.sources);
      }
    }
    return this.sources.get(guid);
  }
}

/** Collects every group/shape/text node by id, depth-first in document order; iterative so deep JSON cannot overflow the stack. */
function indexSources(root: unknown, into: Map<string, AgcNode>): void {
  const pending: unknown[] = [root];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const children = Array.isArray(value) ? value : Object.values(value);
    if (!Array.isArray(value)) {
      const node = value as Partial<AgcNode>;
      if (typeof node.id === 'string' && (node.type === 'group' || node.type === 'shape' || node.type === 'text') && !into.has(node.id)) {
        into.set(node.id, node as AgcNode);
      }
    }
    for (let i = children.length - 1; i >= 0; i--) {
      pending.push(children[i]);
    }
  }
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toBounds(raw: unknown): XdBounds | null {
  const bounds = raw as Partial<Record<keyof XdBounds, unknown>> | null;
  const x = finite(bounds?.x);
  const y = finite(bounds?.y);
  const width = finite(bounds?.width);
  const height = finite(bounds?.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

class SceneBuilder {
  readonly warnings: string[] = [];
  readonly imageUids = new Set<string>();
  private nextKey = 0;
  private textRuns = 0;
  private readonly warned = new Set<string>();
  /** Linked-layer sources being expanded on the current branch, to stop cycles. */
  private readonly expanding = new Set<string>();
  private readonly findSource: (guid: string) => AgcNode | undefined;

  constructor(findSource: (guid: string) => AgcNode | undefined) {
    this.findSource = findSource;
  }

  children(nodes: unknown, parentTransform?: Matrix, depth = 0): SceneNode[] {
    const out: SceneNode[] = [];
    if (!Array.isArray(nodes)) {
      return out;
    }
    for (const node of nodes as AgcNode[]) {
      const converted = this.node(node, depth);
      if (converted) {
        if (parentTransform) {
          converted.transform = multiply(parentTransform, converted.transform);
        }
        out.push(converted);
      }
    }
    return out;
  }

  private node(node: AgcNode, depth: number): SceneNode | null {
    if (typeof node !== 'object' || node === null) {
      return null;
    }
    if (this.nextKey >= SCENE_LIMITS.maxNodes) {
      this.warn(`Artboard has more than ${SCENE_LIMITS.maxNodes} layers; the rest are not shown`);
      return null;
    }
    if (depth > SCENE_LIMITS.maxDepth) {
      this.warn(`Layers nested deeper than ${SCENE_LIMITS.maxDepth} levels are not shown`);
      return null;
    }
    if (node.type === 'syncRef') {
      const guid = node.syncSourceGuid;
      const source = typeof guid === 'string' ? this.findSource(guid) : undefined;
      if (!source) {
        this.warn(`Linked layer source not found (${String(guid)})`);
        return null;
      }
      if (this.expanding.has(guid)) {
        this.warn(`Linked layer refers to itself (${guid})`);
        return null;
      }
      const merged: AgcNode = node.group && source.type === 'group' ? { ...source, group: node.group } : source;
      this.expanding.add(guid);
      try {
        return this.node(merged, depth + 1);
      } finally {
        this.expanding.delete(guid);
      }
    }
    if (node.visible === false) {
      return null;
    }
    switch (node.type) {
      case 'shape':
        return this.shape(node);
      case 'text':
        return this.text(node);
      case 'group':
        return this.group(node, depth);
      default:
        this.warn(`Unsupported layer type "${String((node as { type?: unknown }).type)}" (${layerLabel(node)})`);
        return null;
    }
  }

  /** Records a warning once; a hostile file could otherwise produce millions of identical ones. */
  private warn(message: string): void {
    if (this.warned.has(message) || this.warned.size >= SCENE_LIMITS.warnings) {
      return;
    }
    this.warned.add(message);
    this.warnings.push(message);
  }

  private base(node: AgcNode) {
    return {
      key: `n${this.nextKey++}`,
      id: typeof node.id === 'string' ? node.id : '',
      name: typeof node.name === 'string' ? node.name : '',
      transform: toMatrix(node.transform),
      opacity: node.style?.opacity ?? 1,
      shadows: this.shadows(node.style?.filters, node),
    };
  }

  private shape(node: AgcShapeNode): ShapeNode | null {
    const geometry = toGeometry(node.shape);
    if (!geometry) {
      this.warn(`Unsupported shape "${String(node.shape?.type)}" (${layerLabel(node)})`);
      return null;
    }
    return {
      ...this.base(node),
      kind: 'shape',
      geometry,
      fill: this.paint(node.style?.fill, node),
      stroke: toStroke(node.style?.stroke),
    };
  }

  private group(node: AgcGroupNode, depth: number): GroupNode {
    const ux = node.meta?.ux;
    const clipChildren = ux?.clipPathResources?.children;
    const clip: ShapeNode[] = [];
    for (const child of Array.isArray(clipChildren) ? clipChildren : []) {
      if (child?.type === 'shape' && this.nextKey < SCENE_LIMITS.maxNodes) {
        const shape = this.shape(child);
        if (shape) {
          clip.push(shape);
        }
      }
    }
    return {
      ...this.base(node),
      kind: 'group',
      role: ux?.symbolId ? 'component' : ux?.repeatGrid ? 'repeatGrid' : 'group',
      frame: null,
      clip: clip.length ? clip : null,
      children: this.children(node.group?.children, undefined, depth + 1),
    };
  }

  private text(node: AgcTextNode): TextNode {
    const rawText = typeof node.text?.rawText === 'string' ? node.text.rawText : '';
    const frame = node.text?.frame;
    const paragraphs = Array.isArray(node.text?.paragraphs) ? node.text.paragraphs : [];
    const style = node.style ?? {};
    const rangedStyles = node.meta?.ux?.rangedStyles;
    const ranges = effectiveRanges(Array.isArray(rangedStyles) ? rangedStyles : [], rawText.length);
    const styles: TextStyle[] = [];
    const styleKeys = new Map<string, number>();
    const rangeStyleIndex = ranges.map((range) => {
      const textStyle = toTextStyle(style, range.style);
      const key = JSON.stringify(textStyle);
      let index = styleKeys.get(key);
      if (index === undefined) {
        index = styles.push(textStyle) - 1;
        styleKeys.set(key, index);
      }
      return index;
    });

    const lines: TextLine[] = [];
    for (const paragraph of paragraphs) {
      for (const segments of Array.isArray(paragraph?.lines) ? paragraph.lines : []) {
        const first = Array.isArray(segments) ? segments[0] : undefined;
        if (!first) {
          continue;
        }
        const runs: TextRun[] = [];
        let pendingX: number | undefined;
        segments.forEach((segment, index) => {
          const segmentX = finite(segment?.x);
          if (index > 0 && segmentX !== undefined) {
            pendingX = segmentX;
          }
          const segmentFrom = finite(segment?.from) ?? 0;
          const segmentTo = finite(segment?.to) ?? 0;
          // Ranges are contiguous and ascending, so start at the first one that ends after this segment starts.
          for (let rangeIndex = firstRangeEndingAfter(ranges, segmentFrom); rangeIndex < ranges.length; rangeIndex++) {
            const range = ranges[rangeIndex];
            if (!range || range.from >= segmentTo) {
              break;
            }
            const from = Math.max(segmentFrom, range.from);
            const to = Math.min(segmentTo, range.to);
            const text = rawText.slice(from, to).replace(/\n/g, '');
            if (from >= to || !text) {
              continue;
            }
            if (this.textRuns >= SCENE_LIMITS.maxTextRuns) {
              this.warn(`Artboard has more than ${SCENE_LIMITS.maxTextRuns} text runs; the rest are not shown`);
              return;
            }
            this.textRuns++;
            const run: TextRun = { text, style: rangeStyleIndex[rangeIndex] ?? 0 };
            const glyphFont = segment.style?.font?.family;
            if (typeof glyphFont === 'string' && glyphFont && glyphFont !== styles[run.style]?.family) {
              run.glyphFont = glyphFont;
            }
            if (pendingX !== undefined) {
              run.x = pendingX;
              pendingX = undefined;
            }
            runs.push(run);
          }
        });
        if (runs.length) {
          lines.push({ x: finite(first.x) ?? 0, y: finite(first.y) ?? 0, runs });
        }
      }
    }

    const area = frame?.type === 'area' || frame?.type === 'autoHeight';
    return {
      ...this.base(node),
      kind: 'text',
      content: rawText,
      styles,
      lines,
      align: TEXT_ALIGNS.has(style.textAttributes?.paragraphAlign as string) ? (style.textAttributes?.paragraphAlign as TextNode['align']) : 'left',
      lineHeight: finite(style.textAttributes?.lineHeight) ?? null,
      frame: area
        ? { type: 'area', width: finite(frame?.width) ?? 0, height: finite(frame?.height) ?? 0 }
        : { type: 'positioned', width: 0, height: 0 },
    };
  }

  private paint(fill: AgcFill | undefined, node: AgcNode): Paint | null {
    if (!fill || fill.type === 'none') {
      return null;
    }
    switch (fill.type) {
      case 'solid':
        return { kind: 'solid', color: parseAgcColor(fill.color) };
      case 'gradient': {
        const gradient = fill.gradient;
        const resource = gradient?.meta?.ux?.gradientResources;
        const stops: GradientStop[] = (resource?.stops ?? []).map((stop) => ({
          offset: stop.offset,
          color: parseAgcColor(stop.color),
        }));
        if (!gradient || !stops.length) {
          this.warn(`Gradient without stops (${layerLabel(node)})`);
          return null;
        }
        if (resource?.type === 'radial') {
          const cx = gradient.cx ?? 0.5;
          const cy = gradient.cy ?? 0.5;
          return { kind: 'radial', cx, cy, r: gradient.r ?? 0.5, fx: gradient.fx ?? cx, fy: gradient.fy ?? cy, stops };
        }
        return {
          kind: 'linear',
          x1: gradient.x1 ?? 0,
          y1: gradient.y1 ?? 0,
          x2: gradient.x2 ?? 0,
          y2: gradient.y2 ?? 1,
          stops,
        };
      }
      case 'pattern': {
        const pattern = fill.pattern;
        const uid = pattern?.meta?.ux?.uid;
        if (!pattern || typeof uid !== 'string' || !uid) {
          this.warn(`Image fill without image data (${layerLabel(node)})`);
          return null;
        }
        this.imageUids.add(uid);
        return {
          kind: 'image',
          uid,
          width: finite(pattern.width) ?? 1,
          height: finite(pattern.height) ?? 1,
          fit: pattern.meta?.ux?.scaleBehavior === 'fit' ? 'contain' : 'cover',
        };
      }
      default:
        this.warn(`Unsupported fill "${String(fill.type)}" (${layerLabel(node)})`);
        return null;
    }
  }

  private shadows(filters: AgcFilter[] | undefined, node: AgcNode): Shadow[] {
    const shadows: Shadow[] = [];
    for (const filter of Array.isArray(filters) ? filters : []) {
      if (filter.visible === false) {
        continue;
      }
      if (filter.type !== 'dropShadow') {
        this.warn(`Effect "${String(filter.type)}" not rendered (${layerLabel(node)})`);
        continue;
      }
      const dropShadows = filter.params?.dropShadows;
      for (const shadow of Array.isArray(dropShadows) ? dropShadows : []) {
        if (shadows.length >= SCENE_LIMITS.shadowsPerLayer) {
          this.warn(`More than ${SCENE_LIMITS.shadowsPerLayer} shadows on one layer; the rest are not rendered (${layerLabel(node)})`);
          break;
        }
        shadows.push({ x: shadow.dx, y: shadow.dy, blur: shadow.r * 2, color: parseAgcColor(shadow.color) });
      }
    }
    return shadows;
  }
}

function layerLabel(node: AgcNode): string {
  if (typeof node.name === 'string' && node.name) {
    return `"${node.name.slice(0, 80)}"`;
  }
  return typeof node.id === 'string' ? node.id.slice(0, 80) : 'unnamed layer';
}

/** Index of the first range whose end lies after `position` (ranges are sorted and contiguous). */
function firstRangeEndingAfter(ranges: TextRange[], position: number): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((ranges[mid]?.to ?? 0) <= position) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function toMatrix(t: AgcTransform | undefined): Matrix {
  return { a: t?.a ?? 1, b: t?.b ?? 0, c: t?.c ?? 0, d: t?.d ?? 1, e: t?.tx ?? 0, f: t?.ty ?? 0 };
}

function toGeometry(shape: AgcShape | undefined): Geometry | null {
  if (typeof shape !== 'object' || shape === null) {
    return null;
  }
  switch (shape.type) {
    case 'rect': {
      const r = shape.r;
      const radii: [number, number, number, number] = Array.isArray(r)
        ? [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 0]
        : [r ?? 0, r ?? 0, r ?? 0, r ?? 0];
      return { type: 'rect', x: shape.x ?? 0, y: shape.y ?? 0, width: shape.width, height: shape.height, radii };
    }
    case 'circle':
      return { type: 'ellipse', cx: shape.cx, cy: shape.cy, rx: shape.r, ry: shape.r };
    case 'ellipse':
      return { type: 'ellipse', cx: shape.cx, cy: shape.cy, rx: shape.rx, ry: shape.ry };
    case 'line':
      return { type: 'line', x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2 };
    case 'polygon': {
      if (typeof shape.path === 'string' && shape.path) {
        return { type: 'path', d: shape.path };
      }
      const points = Array.isArray(shape.points) ? shape.points : [];
      return points.length ? { type: 'path', d: `M${points.map((p) => `${finite(p?.x) ?? 0},${finite(p?.y) ?? 0}`).join(' L')} Z` } : null;
    }
    case 'path':
    case 'compound':
      return typeof shape.path === 'string' && shape.path ? { type: 'path', d: shape.path } : null;
    default:
      return null;
  }
}

export function toStroke(stroke: AgcStroke | undefined): Stroke | null {
  const width = stroke?.width === undefined ? 1 : finite(stroke.width);
  if (!stroke || stroke.type !== 'solid' || !width) {
    return null;
  }
  // These values are written into SVG attributes, so only the known keywords are accepted.
  return {
    color: parseAgcColor(stroke.color),
    width,
    align: STROKE_ALIGNS.has(stroke.align as string) ? (stroke.align as Stroke['align']) : 'center',
    dash: Array.isArray(stroke.dash) ? stroke.dash.filter((value): value is number => finite(value) !== undefined) : [],
    cap: STROKE_CAPS.has(stroke.cap as string) ? (stroke.cap as Stroke['cap']) : 'butt',
    join: STROKE_JOINS.has(stroke.join as string) ? (stroke.join as Stroke['join']) : 'miter',
  };
}

interface TextRange {
  from: number;
  to: number;
  style: AgcRangedStyle;
}

/**
 * XD writes zero-length leftover ranges and sometimes ranges that stop short of the text end;
 * keep the non-empty ones in order and stretch the last one to cover the whole text.
 */
export function effectiveRanges(ranges: AgcRangedStyle[], textLength: number): TextRange[] {
  const nonEmpty = ranges.filter((range) => (finite(range?.length) ?? 0) > 0);
  if (!nonEmpty.length) {
    return [{ from: 0, to: textLength, style: ranges[0] ?? {} }];
  }
  const out: TextRange[] = [];
  let position = 0;
  for (const range of nonEmpty) {
    const length = finite(range.length) ?? 0;
    out.push({ from: position, to: position + length, style: range });
    position += length;
  }
  const last = out[out.length - 1];
  if (last && last.to < textLength) {
    last.to = textLength;
  }
  return out;
}

function toTextTransform(value: string | undefined): TextTransform {
  return value === 'uppercase' || value === 'lowercase' || value === 'titlecase' ? value : 'none';
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toTextStyle(style: AgcStyle, range: AgcRangedStyle): TextStyle {
  const font = style.font ?? {};
  const fontStyle = asString(range.fontStyle) ?? asString(font.style) ?? 'Regular';
  const nodeFill = style.fill?.type === 'solid' ? parseAgcColor(style.fill.color) : BLACK;
  return {
    family: asString(range.fontFamily) ?? asString(font.family) ?? 'sans-serif',
    fontStyle,
    weight: fontWeight(fontStyle),
    italic: /italic|oblique/i.test(fontStyle),
    size: finite(range.fontSize) ?? finite(font.size) ?? 12,
    color: range.fill ? parseAgcColor(range.fill) : nodeFill,
    letterSpacing: range.charSpacing ?? style.textAttributes?.letterSpacing ?? 0,
    underline: range.underline ?? false,
    strikethrough: range.strikethrough ?? false,
    textTransform: toTextTransform(range.textTransform),
  };
}
