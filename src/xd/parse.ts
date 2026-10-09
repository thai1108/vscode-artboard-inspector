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
import { BLACK, parseAgcColor } from './color.ts';
import { multiply, translate } from './matrix.ts';
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
} from './scene.ts';

const RESOURCES_AGC = 'resources/graphics/graphicContent.agc';
const MAX_SYNC_DEPTH = 32;

export interface XdImage {
  mime: string;
  data: Uint8Array;
}

interface ArtboardEntry extends ArtboardSummary {
  bounds: XdBounds;
}

/** An opened .xd file: lists artboards and converts one artboard at a time into a scene. */
export class XdDocument {
  readonly artboards: readonly ArtboardSummary[];
  private readonly zip: ZipArchive;
  private readonly entries: ReadonlyMap<string, ArtboardEntry>;
  private sources: Map<string, AgcNode> | null = null;
  private sourcesIncludeArtwork = false;

  private constructor(zip: ZipArchive, entries: ArtboardEntry[]) {
    this.zip = zip;
    this.entries = new Map(entries.map((entry) => [entry.id, entry]));
    this.artboards = entries.map(({ id, name, width, height }) => ({ id, name, width, height }));
  }

  static open(zip: ZipArchive): XdDocument {
    if (!zip.has('manifest')) {
      throw new Error('Not an Adobe XD file (manifest missing)');
    }
    const manifest = JSON.parse(zip.readText('manifest')) as XdManifestNode;
    const entries: ArtboardEntry[] = [];
    const walk = (node: XdManifestNode): void => {
      const bounds = node['uxdesign#bounds'];
      if (node.path?.startsWith('artboard-') && bounds) {
        entries.push({
          id: node.path,
          name: (node.name ?? node.path).trim(),
          width: bounds.width,
          height: bounds.height,
          bounds,
        });
      }
      node.children?.forEach(walk);
    };
    walk(manifest);
    entries.sort((p, q) => p.bounds.y - q.bounds.y || p.bounds.x - q.bounds.x);
    return new XdDocument(zip, entries);
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
      warnings: builder.warnings,
    };
  }

  image(uid: string): XdImage | undefined {
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

function indexSources(value: unknown, into: Map<string, AgcNode>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      indexSources(item, into);
    }
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  const node = value as Partial<AgcNode>;
  if (typeof node.id === 'string' && (node.type === 'group' || node.type === 'shape' || node.type === 'text')) {
    if (!into.has(node.id)) {
      into.set(node.id, node as AgcNode);
    }
  }
  for (const child of Object.values(value)) {
    indexSources(child, into);
  }
}

function sniffImageMime(data: Uint8Array): string {
  const ascii = (start: number, end: number) => String.fromCharCode(...data.subarray(start, end));
  if (data[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 3) === 'GIF') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (/^\s*<(\?xml|svg)/.test(ascii(0, 64))) return 'image/svg+xml';
  return 'application/octet-stream';
}

class SceneBuilder {
  readonly warnings: string[] = [];
  readonly imageUids = new Set<string>();
  private nextKey = 0;
  private readonly findSource: (guid: string) => AgcNode | undefined;

  constructor(findSource: (guid: string) => AgcNode | undefined) {
    this.findSource = findSource;
  }

  children(nodes: AgcNode[], parentTransform?: Matrix): SceneNode[] {
    const out: SceneNode[] = [];
    for (const node of nodes) {
      const converted = this.node(node, 0);
      if (converted) {
        if (parentTransform) {
          converted.transform = multiply(parentTransform, converted.transform);
        }
        out.push(converted);
      }
    }
    return out;
  }

  private node(node: AgcNode, syncDepth: number): SceneNode | null {
    if (node.type === 'syncRef') {
      const source = this.findSource(node.syncSourceGuid);
      if (!source) {
        this.warnings.push(`Linked layer source not found (${node.syncSourceGuid})`);
        return null;
      }
      if (syncDepth >= MAX_SYNC_DEPTH) {
        this.warnings.push(`Linked layer chain too deep (${node.syncSourceGuid})`);
        return null;
      }
      const merged: AgcNode = node.group && source.type === 'group' ? { ...source, group: node.group } : source;
      return this.node(merged, syncDepth + 1);
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
        return this.group(node);
      default:
        this.warnings.push(`Unsupported layer type "${(node as { type?: string }).type}" (${layerLabel(node)})`);
        return null;
    }
  }

  private base(node: AgcNode) {
    return {
      key: `n${this.nextKey++}`,
      id: node.id ?? '',
      name: node.name ?? '',
      transform: toMatrix(node.transform),
      opacity: node.style?.opacity ?? 1,
      shadows: this.shadows(node.style?.filters, node),
    };
  }

  private shape(node: AgcShapeNode): ShapeNode | null {
    const geometry = toGeometry(node.shape);
    if (!geometry) {
      this.warnings.push(`Unsupported shape "${node.shape.type}" (${layerLabel(node)})`);
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

  private group(node: AgcGroupNode): GroupNode {
    const ux = node.meta?.ux;
    const clip = ux?.clipPathResources?.children
      ?.filter((child): child is AgcShapeNode => child.type === 'shape')
      .map((child) => this.shape(child))
      .filter((child): child is ShapeNode => child !== null);
    return {
      ...this.base(node),
      kind: 'group',
      role: ux?.symbolId ? 'component' : ux?.repeatGrid ? 'repeatGrid' : 'group',
      clip: clip?.length ? clip : null,
      children: this.children(node.group?.children ?? []),
    };
  }

  private text(node: AgcTextNode): TextNode {
    const { rawText, frame, paragraphs } = node.text;
    const style = node.style ?? {};
    const ranges = effectiveRanges(node.meta?.ux?.rangedStyles ?? [], rawText.length);
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
    for (const paragraph of paragraphs ?? []) {
      for (const segments of paragraph.lines ?? []) {
        const first = segments[0];
        if (!first) {
          continue;
        }
        const runs: TextRun[] = [];
        let pendingX: number | undefined;
        segments.forEach((segment, index) => {
          if (index > 0 && segment.x !== undefined) {
            pendingX = segment.x;
          }
          ranges.forEach((range, rangeIndex) => {
            const from = Math.max(segment.from, range.from);
            const to = Math.min(segment.to, range.to);
            const text = rawText.slice(from, to).replace(/\n/g, '');
            if (from >= to || !text) {
              return;
            }
            const run: TextRun = { text, style: rangeStyleIndex[rangeIndex] ?? 0 };
            const glyphFont = segment.style?.font?.family;
            if (glyphFont && glyphFont !== styles[run.style]?.family) {
              run.glyphFont = glyphFont;
            }
            if (pendingX !== undefined) {
              run.x = pendingX;
              pendingX = undefined;
            }
            runs.push(run);
          });
        });
        if (runs.length) {
          lines.push({ x: first.x ?? 0, y: first.y ?? 0, runs });
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
      align: style.textAttributes?.paragraphAlign ?? 'left',
      lineHeight: style.textAttributes?.lineHeight ?? null,
      frame: area
        ? { type: 'area', width: frame?.width ?? 0, height: frame?.height ?? 0 }
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
          this.warnings.push(`Gradient without stops (${layerLabel(node)})`);
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
        if (!pattern || !uid) {
          this.warnings.push(`Image fill without image data (${layerLabel(node)})`);
          return null;
        }
        this.imageUids.add(uid);
        return {
          kind: 'image',
          uid,
          width: pattern.width,
          height: pattern.height,
          fit: pattern.meta?.ux?.scaleBehavior === 'fit' ? 'contain' : 'cover',
        };
      }
      default:
        this.warnings.push(`Unsupported fill "${fill.type}" (${layerLabel(node)})`);
        return null;
    }
  }

  private shadows(filters: AgcFilter[] | undefined, node: AgcNode): Shadow[] {
    const shadows: Shadow[] = [];
    for (const filter of filters ?? []) {
      if (filter.visible === false) {
        continue;
      }
      if (filter.type !== 'dropShadow') {
        this.warnings.push(`Effect "${filter.type}" not rendered (${layerLabel(node)})`);
        continue;
      }
      for (const shadow of filter.params?.dropShadows ?? []) {
        shadows.push({ x: shadow.dx, y: shadow.dy, blur: shadow.r * 2, color: parseAgcColor(shadow.color) });
      }
    }
    return shadows;
  }
}

function layerLabel(node: AgcNode): string {
  return node.name ? `"${node.name}"` : (node.id ?? 'unnamed layer');
}

function toMatrix(t: AgcTransform | undefined): Matrix {
  return { a: t?.a ?? 1, b: t?.b ?? 0, c: t?.c ?? 0, d: t?.d ?? 1, e: t?.tx ?? 0, f: t?.ty ?? 0 };
}

function toGeometry(shape: AgcShape): Geometry | null {
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
      if (shape.path) {
        return { type: 'path', d: shape.path };
      }
      const points = shape.points ?? [];
      return points.length ? { type: 'path', d: `M${points.map((p) => `${p.x},${p.y}`).join(' L')} Z` } : null;
    }
    case 'path':
    case 'compound':
      return shape.path ? { type: 'path', d: shape.path } : null;
    default:
      return null;
  }
}

function toStroke(stroke: AgcStroke | undefined): Stroke | null {
  if (!stroke || stroke.type !== 'solid' || !(stroke.width ?? 1)) {
    return null;
  }
  return {
    color: parseAgcColor(stroke.color),
    width: stroke.width ?? 1,
    align: stroke.align ?? 'center',
    dash: stroke.dash ?? [],
    cap: stroke.cap ?? 'butt',
    join: stroke.join ?? 'miter',
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
  const nonEmpty = ranges.filter((range) => (range.length ?? 0) > 0);
  if (!nonEmpty.length) {
    return [{ from: 0, to: textLength, style: ranges[0] ?? {} }];
  }
  const out: TextRange[] = [];
  let position = 0;
  for (const range of nonEmpty) {
    const length = range.length ?? 0;
    out.push({ from: position, to: position + length, style: range });
    position += length;
  }
  const last = out[out.length - 1];
  if (last && last.to < textLength) {
    last.to = textLength;
  }
  return out;
}

const WEIGHT_NAMES: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/(extra|ultra)[\s-]?light/i, 200],
  [/light/i, 300],
  [/(semi|demi)[\s-]?bold/i, 600],
  [/(extra|ultra)[\s-]?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
  [/medium/i, 500],
];

export function fontWeight(style: string): number {
  const hiragino = /^W(\d)$/i.exec(style.trim());
  if (hiragino) {
    return Math.max(100, Number(hiragino[1]) * 100);
  }
  return WEIGHT_NAMES.find(([pattern]) => pattern.test(style))?.[1] ?? 400;
}

function toTextTransform(value: string | undefined): TextTransform {
  return value === 'uppercase' || value === 'lowercase' || value === 'titlecase' ? value : 'none';
}

function toTextStyle(style: AgcStyle, range: AgcRangedStyle): TextStyle {
  const font = style.font ?? {};
  const fontStyle = range.fontStyle ?? font.style ?? 'Regular';
  const nodeFill = style.fill?.type === 'solid' ? parseAgcColor(style.fill.color) : BLACK;
  return {
    family: range.fontFamily ?? font.family ?? 'sans-serif',
    fontStyle,
    weight: fontWeight(fontStyle),
    italic: /italic|oblique/i.test(fontStyle),
    size: range.fontSize ?? font.size ?? 12,
    color: range.fill ? parseAgcColor(range.fill) : nodeFill,
    letterSpacing: range.charSpacing ?? style.textAttributes?.letterSpacing ?? 0,
    underline: range.underline ?? false,
    strikethrough: range.strikethrough ?? false,
    textTransform: toTextTransform(range.textTransform),
  };
}
