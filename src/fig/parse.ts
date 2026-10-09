import type { DesignDocument, DesignImage } from '../document.ts';
import type { BoardLayout } from '../scene/board.ts';
import { imageSize, sniffImageMime } from '../image.ts';
import type {
  ArtboardScene,
  ArtboardSummary,
  FrameStyle,
  Geometry,
  GradientStop,
  GroupNode,
  Matrix,
  Paint,
  Rgba,
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
import { fontWeight } from '../scene/text.ts';
import { DEFAULT_FIG_LIMITS, readFigFile, type FigFile, type FigLimits } from './container.ts';
import { commandsToPath } from './geometry.ts';
import type { FigColor, FigEffect, FigGuid, FigMatrix, FigNode, FigOverride, FigPaint, FigPath, FigTextStyle } from './types.ts';

/** Caps that keep hostile or pathological files from exhausting the extension host (same values as for XD). */
export const FIG_SCENE_LIMITS = {
  /** Layers converted per artboard. */
  maxNodes: 50_000,
  /** Nesting of frames and groups. */
  maxDepth: 256,
  /** Nesting of instances inside component instances. */
  maxInstanceDepth: 32,
  /** Text runs per artboard. */
  maxTextRuns: 200_000,
  shadowsPerLayer: 16,
  warnings: 200,
  /** Node records in the whole file. */
  maxDocumentNodes: 2_000_000,
};

const CONTAINER_TYPES = new Set(['FRAME', 'GROUP', 'SECTION', 'SYMBOL', 'INSTANCE']);
const ARTBOARD_TYPES = new Set(['FRAME', 'SYMBOL', 'INSTANCE']);
const PATH_TYPES = new Set(['VECTOR', 'STAR', 'REGULAR_POLYGON', 'BOOLEAN_OPERATION', 'BRUSH', 'CONNECTOR', 'HIGHLIGHT', 'WASHI_TAPE']);
/** Layers that never paint anything on the canvas. */
const SILENT_TYPES = new Set(['SLICE', 'VARIABLE', 'VARIABLE_SET']);

interface FigArtboard extends ArtboardSummary {
  pageIndex: number;
  x: number;
  y: number;
  /** Name without the page prefix. */
  title: string;
}

export function guidKey(guid: FigGuid | undefined): string {
  return guid ? `${guid.sessionID}:${guid.localID}` : '';
}

/** An opened .fig file ("Save local copy" in Figma): pages' top-level frames are the artboards. */
export class FigDocument implements DesignDocument {
  readonly artboards: readonly ArtboardSummary[];
  readonly board: BoardLayout;
  private readonly file: FigFile;
  readonly nodes: ReadonlyMap<string, FigNode>;
  private readonly childLists: ReadonlyMap<string, FigNode[]>;
  readonly blobs: readonly Uint8Array[];
  private readonly entries: ReadonlyMap<string, FigArtboard>;
  /** Raw (non-ZIP) files embed image bytes in blobs; remembered per hash while converting. */
  readonly blobImages = new Map<string, number>();

  private constructor(file: FigFile) {
    this.file = file;
    const nodes = new Map<string, FigNode>();
    const childLists = new Map<string, FigNode[]>();
    const changes = file.message.nodeChanges ?? [];
    if (changes.length > FIG_SCENE_LIMITS.maxDocumentNodes) {
      throw new Error(`Figma file has too many layers (${changes.length}; limit ${FIG_SCENE_LIMITS.maxDocumentNodes})`);
    }
    for (const node of changes) {
      const key = guidKey(node.guid);
      nodes.set(key, node);
      const parent = guidKey(node.parentIndex?.guid);
      if (node.parentIndex && parent !== key) {
        const list = childLists.get(parent) ?? [];
        list.push(node);
        childLists.set(parent, list);
      }
    }
    for (const list of childLists.values()) {
      list.sort((p, q) => comparePositions(p.parentIndex?.position ?? '', q.parentIndex?.position ?? ''));
    }
    this.nodes = nodes;
    this.childLists = childLists;
    this.blobs = (file.message.blobs ?? []).map((blob) => blob.bytes ?? new Uint8Array());
    const { pages, artboards: entries } = this.collectArtboards();
    this.entries = new Map(entries.map((entry) => [entry.id, entry]));
    this.artboards = entries.map(({ id, name, width, height }) => ({ id, name, width, height }));
    this.board = {
      pages,
      placements: entries.map(({ id, pageIndex, x, y, title }) => ({ id, page: pageIndex, x, y, title })),
    };
  }

  static open(bytes: Buffer, limits: FigLimits = DEFAULT_FIG_LIMITS): FigDocument {
    return new FigDocument(readFigFile(bytes, limits));
  }

  childrenOf(node: FigNode): FigNode[] {
    return this.childLists.get(guidKey(node.guid)) ?? [];
  }

  scene(artboardId: string): ArtboardScene {
    const entry = this.entries.get(artboardId);
    const node = this.nodes.get(artboardId);
    if (!entry || !node) {
      throw new Error(`Unknown artboard: ${artboardId}`);
    }
    return new SceneBuilder(this).artboard(node, entry);
  }

  image(uid: string): DesignImage | undefined {
    const blobIndex = this.blobImages.get(uid);
    const data = blobIndex === undefined ? this.file.image(uid) : this.blobs[blobIndex];
    return data ? { mime: sniffImageMime(data), data } : undefined;
  }

  imageBytes(uid: string): Uint8Array | undefined {
    return this.image(uid)?.data;
  }

  private collectArtboards(): { pages: string[]; artboards: FigArtboard[] } {
    const root = this.nodes.get('0:0') ?? [...this.nodes.values()].find((node) => node.type === 'DOCUMENT');
    if (!root) {
      throw new Error('Not a Figma design file (document root missing)');
    }
    const artboards: FigArtboard[] = [];
    const pages = this.childrenOf(root).filter((page) => page.type === 'CANVAS' && !page.internalOnly && page.visible !== false);
    const visit = (parent: FigNode, path: string[], originX: number, originY: number, pageIndex: number, depth: number) => {
      if (depth > FIG_SCENE_LIMITS.maxDepth) {
        return;
      }
      for (const child of this.childrenOf(parent)) {
        if (child.visible === false) {
          continue;
        }
        const x = originX + fin(child.transform?.m02);
        const y = originY + fin(child.transform?.m12);
        const name = (child.name ?? '').trim();
        if (child.type === 'SECTION') {
          visit(child, [...path, name], x, y, pageIndex, depth + 1);
        } else if (child.type && ARTBOARD_TYPES.has(child.type)) {
          artboards.push({
            id: guidKey(child.guid),
            name: [...path, name].join(' / '),
            title: [...path.slice(1), name].join(' / '),
            ...sizeOf(child),
            pageIndex,
            x,
            y,
          });
        }
      }
    };
    const pageNames = pages.map((page, index) => (page.name ?? '').trim() || `Page ${index + 1}`);
    pages.forEach((page, index) => visit(page, [(page.name ?? '').trim()], 0, 0, index, 0));
    return { pages: pageNames, artboards: artboards.sort((p, q) => p.pageIndex - q.pageIndex || p.y - q.y || p.x - q.x) };
  }
}

/** Figma orders siblings by fractional-index strings; plain code-unit order is what it uses too. */
function comparePositions(p: string, q: string): number {
  return p < q ? -1 : p > q ? 1 : 0;
}

/** Overrides of the instance being expanded, with guid paths relative to its component. */
interface InstanceScope {
  overrides: FigOverride[];
  derived: FigOverride[];
  depth: number;
  /** Components being expanded, to stop a component that contains an instance of itself. */
  symbols: string[];
}

class SceneBuilder {
  private readonly doc: FigDocument;
  private readonly warnings = new Set<string>();
  private readonly imageUids = new Set<string>();
  private nextKey = 0;
  private nodeCount = 0;
  private textRuns = 0;

  constructor(doc: FigDocument) {
    this.doc = doc;
  }

  artboard(node: FigNode, entry: ArtboardSummary): ArtboardScene {
    const converted = this.node(node, null, 0);
    let children: SceneNode[] = [];
    let background: Rgba | null = null;
    if (converted?.kind === 'group') {
      converted.transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
      const frame = converted.frame;
      const plain = !frame || (frame.fill?.kind === 'solid' && !frame.stroke && frame.radii.every((r) => r === 0));
      if (plain && !converted.shadows.length && converted.opacity === 1) {
        // A plain artboard: its fill becomes the background and its children the top-level layers.
        background = frame?.fill?.kind === 'solid' ? frame.fill.color : null;
        children = converted.children;
      } else {
        children = [converted];
      }
    }
    return {
      id: entry.id,
      name: entry.name,
      width: entry.width,
      height: entry.height,
      background,
      children,
      imageUids: [...this.imageUids],
      warnings: [...this.warnings],
    };
  }

  private warn(message: string): void {
    if (this.warnings.size < FIG_SCENE_LIMITS.warnings) {
      this.warnings.add(message);
    }
  }

  private node(raw: FigNode, scope: InstanceScope | null, depth: number): SceneNode | null {
    if (this.nodeCount >= FIG_SCENE_LIMITS.maxNodes) {
      this.warn(`Frame has more than ${FIG_SCENE_LIMITS.maxNodes} layers; the rest is not drawn`);
      return null;
    }
    if (depth > FIG_SCENE_LIMITS.maxDepth) {
      this.warn('Layers nested too deeply; the deepest ones are not drawn');
      return null;
    }
    const node = applyOverrides(raw, scope);
    if (node.visible === false) {
      return null;
    }
    this.nodeCount++;
    const type = node.type ?? '';
    if (CONTAINER_TYPES.has(type)) {
      return this.container(node, scope, depth);
    }
    switch (type) {
      case 'RECTANGLE':
      case 'ROUNDED_RECTANGLE':
        return this.shape(node, { type: 'rect', x: 0, y: 0, ...sizeOf(node), radii: cornerRadii(node) });
      case 'ELLIPSE': {
        const { width, height } = sizeOf(node);
        const arc = node.arcData;
        const partial = arc && ((arc.startingAngle ?? 0) !== 0 || Math.abs((arc.endingAngle ?? 2 * Math.PI) - 2 * Math.PI) > 1e-4 || (arc.innerRadius ?? 0) > 0);
        const ellipse: Geometry = { type: 'ellipse', cx: width / 2, cy: height / 2, rx: width / 2, ry: height / 2 };
        return this.shape(node, partial ? (this.path(node.fillGeometry) ?? ellipse) : ellipse);
      }
      case 'LINE':
        return this.shape(node, { type: 'line', x1: 0, y1: 0, x2: sizeOf(node).width, y2: 0 });
      case 'TEXT':
        return this.text(node);
      default:
        break;
    }
    if (PATH_TYPES.has(type)) {
      const fill = this.path(node.fillGeometry);
      const outline = this.path(node.strokeGeometry);
      const geometry = fill ?? outline;
      if (!geometry) {
        this.warn(`Vector without outline data not drawn ("${node.name ?? ''}")`);
        return null;
      }
      const shape = this.shape(node, geometry);
      if (!fill) {
        shape.fill = null;
      }
      if (outline && shape.stroke) {
        shape.strokeOutline = outline.d;
      }
      return shape;
    }
    if (!SILENT_TYPES.has(type)) {
      this.warn(`Unsupported layer type "${type}" ("${node.name ?? ''}")`);
    }
    return null;
  }

  private base(node: FigNode) {
    return {
      key: `n${this.nextKey++}`,
      id: guidKey(node.guid),
      name: node.name ?? '',
      transform: toMatrix(node.transform),
      opacity: clamp01(fin(node.opacity, 1)),
      shadows: this.shadows(node.effects, node),
    };
  }

  private container(node: FigNode, scope: InstanceScope | null, depth: number): GroupNode {
    let childNodes = this.doc.childrenOf(node);
    let childScope = scope;
    let own = node;
    if (node.type === 'INSTANCE') {
      const expanded = this.expandInstance(node, scope);
      own = expanded.root;
      childNodes = expanded.children;
      childScope = expanded.scope;
    }
    const { width, height } = sizeOf(own);
    const radii = cornerRadii(own);
    const fill = this.paint(own.fillPaints, own);
    const stroke = this.stroke(own);
    const frame: FrameStyle | null = fill || stroke ? { width, height, radii, fill, stroke } : null;
    const isGroup = own.type === 'GROUP' || own.resizeToFit === true;
    const clips = own.type !== 'GROUP' && own.type !== 'SECTION' && own.frameMaskDisabled !== true;
    const role: GroupNode['role'] = own.type === 'SYMBOL' ? 'component' : own.type === 'INSTANCE' ? 'instance' : isGroup ? 'group' : 'frame';
    return {
      ...this.base(own),
      kind: 'group',
      role,
      frame,
      clip: clips ? [this.clipRect(width, height, radii)] : null,
      children: this.children(childNodes, childScope, depth + 1),
      layoutSize: { width, height },
    };
  }

  /** Converts siblings; a mask layer clips the siblings above it, like in Figma. */
  private children(nodes: FigNode[], scope: InstanceScope | null, depth: number): SceneNode[] {
    const out: SceneNode[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const raw = nodes[i] as FigNode;
      const node = applyOverrides(raw, scope);
      if (node.mask && node.visible !== false) {
        const mask = this.node(raw, scope, depth);
        const rest = this.children(nodes.slice(i + 1), scope, depth);
        if (mask?.kind === 'shape') {
          out.push({ ...this.base(node), shadows: [], opacity: 1, transform: identity(), name: `${node.name ?? ''} (mask)`, kind: 'group', role: 'group', frame: null, clip: [mask], children: rest });
        } else {
          this.warn(`Mask "${node.name ?? ''}" is not a simple shape; content drawn unmasked`);
          out.push(...rest);
        }
        return out;
      }
      const converted = this.node(raw, scope, depth);
      if (converted) {
        out.push(converted);
      }
    }
    return out;
  }

  private expandInstance(instance: FigNode, outer: InstanceScope | null): { root: FigNode; children: FigNode[]; scope: InstanceScope | null } {
    const symbolKey = guidKey(instance.overriddenSymbolID ?? instance.symbolData?.symbolID);
    const symbol = this.doc.nodes.get(symbolKey);
    if (!symbol) {
      this.warn(`Component of instance "${instance.name ?? ''}" not found in the file`);
      return { root: instance, children: [], scope: outer };
    }
    if (outer && (outer.depth >= FIG_SCENE_LIMITS.maxInstanceDepth || outer.symbols.includes(symbolKey))) {
      this.warn(`Component "${symbol.name ?? ''}" contains an instance of itself; not expanded`);
      return { root: { ...symbol, ...instance }, children: [], scope: outer };
    }
    const instanceKey = guidKey(instance.overrideKey ?? instance.guid);
    const passed = (list: FigOverride[]) =>
      list.filter((o) => (o.guidPath?.guids?.length ?? 0) > 1 && guidKey(o.guidPath?.guids?.[0]) === instanceKey).map((o) => ({ ...o, guidPath: { guids: o.guidPath?.guids?.slice(1) } }));
    const scope: InstanceScope = {
      // Later entries win: the outer instance's overrides beat the nested instance's own ones.
      overrides: [...(instance.symbolData?.symbolOverrides ?? []), ...(outer ? passed(outer.overrides) : [])],
      derived: [...(instance.derivedSymbolData ?? []), ...(outer ? passed(outer.derived) : [])],
      depth: (outer?.depth ?? 0) + 1,
      symbols: [...(outer?.symbols ?? []), symbolKey],
    };
    // The instance keeps its own size/position/name; the component supplies everything it does not set.
    const root = applyOverrides({ ...symbol, ...instance, type: 'INSTANCE' }, scope, guidKey(symbol.overrideKey ?? symbol.guid));
    return { root, children: this.doc.childrenOf(symbol), scope };
  }

  private clipRect(width: number, height: number, radii: [number, number, number, number]): ShapeNode {
    return {
      key: `n${this.nextKey++}`,
      id: '',
      name: 'clip',
      transform: identity(),
      opacity: 1,
      shadows: [],
      kind: 'shape',
      geometry: { type: 'rect', x: 0, y: 0, width, height, radii },
      fill: null,
      stroke: null,
    };
  }

  private shape(node: FigNode, geometry: Geometry): ShapeNode {
    return {
      ...this.base(node),
      kind: 'shape',
      geometry,
      fill: this.paint(node.fillPaints, node),
      stroke: this.stroke(node),
      layoutSize: sizeOf(node),
    };
  }

  private path(paths: FigPath[] | undefined): Extract<Geometry, { type: 'path' }> | null {
    const parts: string[] = [];
    for (const path of paths ?? []) {
      const blob = path.commandsBlob === undefined ? undefined : this.doc.blobs[path.commandsBlob];
      const d = blob ? commandsToPath(blob) : null;
      if (d) {
        parts.push(d);
      } else if (blob) {
        this.warn('Some vector outlines could not be decoded');
      }
    }
    if (!parts.length) {
      return null;
    }
    return { type: 'path', d: parts.join(' '), fillRule: paths?.[0]?.windingRule === 'ODD' ? 'evenodd' : 'nonzero' };
  }

  private text(node: FigNode): TextNode {
    const characters = Array.from(typeof node.textData?.characters === 'string' ? node.textData.characters : '');
    const size = positive(node.fontSize, 12);
    const styles: TextStyle[] = [];
    const styleKeys = new Map<string, number>();
    const indexOf = (style: TextStyle) => {
      const key = JSON.stringify(style);
      let index = styleKeys.get(key);
      if (index === undefined) {
        index = styles.push(style) - 1;
        styleKeys.set(key, index);
      }
      return index;
    };
    const baseIndex = indexOf(this.textStyle(node, {}));
    const overrideIndex = new Map<number, number>();
    for (const override of node.textData?.styleOverrideTable ?? []) {
      if (override.styleID !== undefined) {
        overrideIndex.set(override.styleID, indexOf(this.textStyle(node, override)));
      }
    }
    const styleIds = node.textData?.characterStyleIDs ?? [];
    const styleAt = (i: number) => overrideIndex.get(styleIds[i] ?? 0) ?? baseIndex;

    const derived = node.derivedTextData;
    const offsets = derived?.logicalIndexToCharacterOffsetMap;
    const exact = offsets?.length === characters.length;
    const baselines = derived?.baselines ?? [];
    const lines: TextLine[] = [];
    for (const baseline of baselines) {
      const x = fin(baseline.position?.x);
      const runs: TextRun[] = [];
      const end = Math.min(fin(baseline.endCharacter, characters.length), characters.length);
      for (let i = Math.max(0, fin(baseline.firstCharacter)); i < end; i++) {
        const char = characters[i] as string;
        if (char === '\n' || char === '\r' || char === ' ') {
          continue;
        }
        const style = styleAt(i);
        let run = runs[runs.length - 1];
        if (!run || run.style !== style) {
          if (this.textRuns >= FIG_SCENE_LIMITS.maxTextRuns) {
            this.warn(`Artboard has more than ${FIG_SCENE_LIMITS.maxTextRuns} text runs; the rest are not shown`);
            break;
          }
          this.textRuns++;
          run = { text: '', style, ...(exact ? { xs: [] } : {}) };
          runs.push(run);
        }
        run.text += char;
        run.xs?.push(x + fin(offsets?.[i]));
      }
      if (runs.length) {
        lines.push({ x, y: fin(baseline.position?.y), runs });
      }
    }
    if (!baselines.length && characters.length) {
      this.warn(`Text layout missing; drawn on one line ("${node.name ?? ''}")`);
      lines.push({ x: 0, y: size, runs: [{ text: characters.filter((c) => c !== '\n').join(''), style: baseIndex }] });
    }
    return {
      ...this.base(node),
      kind: 'text',
      content: characters.join(''),
      styles,
      lines,
      align: toAlign(node.textAlignHorizontal),
      lineHeight: lineHeightPx(node.lineHeight, size),
      frame: { type: 'area', ...sizeOf(node) },
      layoutSize: sizeOf(node),
    };
  }

  private textStyle(node: FigNode, override: FigTextStyle): TextStyle {
    const font = override.fontName ?? node.fontName ?? {};
    const size = positive(override.fontSize ?? node.fontSize, 12);
    const fontStyle = typeof font.style === 'string' ? font.style : 'Regular';
    const fill = this.paint(override.fillPaints ?? node.fillPaints, node);
    const spacing = override.letterSpacing ?? node.letterSpacing;
    const decoration = override.textDecoration ?? node.textDecoration;
    return {
      family: typeof font.family === 'string' ? font.family : 'sans-serif',
      fontStyle,
      weight: fontWeight(fontStyle),
      italic: /italic|oblique/i.test(fontStyle),
      size,
      color: fill?.kind === 'solid' ? fill.color : { r: 0, g: 0, b: 0, a: 1 },
      letterSpacing: !spacing ? 0 : spacing.units === 'PERCENT' ? fin(spacing.value) * 10 : (fin(spacing.value) / size) * 1000,
      underline: decoration === 'UNDERLINE',
      strikethrough: decoration === 'STRIKETHROUGH',
      textTransform: toTextTransform(override.textCase ?? node.textCase),
    };
  }

  /** The topmost visible paint (Figma lists paints bottom to top). */
  private paint(paints: FigPaint[] | undefined, node: FigNode): Paint | null {
    const visible = (Array.isArray(paints) ? paints : []).filter((paint) => paint.visible !== false && fin(paint.opacity, 1) > 0);
    const paint = visible[visible.length - 1];
    if (!paint) {
      return null;
    }
    if (visible.length > 1) {
      this.warn('Layers with several fills show only the top one');
    }
    const opacity = clamp01(fin(paint.opacity, 1));
    switch (paint.type) {
      case 'SOLID':
        return { kind: 'solid', color: toRgba(paint.color, opacity) };
      case 'GRADIENT_LINEAR':
      case 'GRADIENT_RADIAL':
      case 'GRADIENT_ANGULAR':
      case 'GRADIENT_DIAMOND': {
        const stops: GradientStop[] = (paint.stops ?? []).map((stop) => ({ offset: clamp01(fin(stop.position)), color: toRgba(stop.color, opacity) }));
        if (!stops.length) {
          return null;
        }
        const inverse = invert(paint.transform);
        const start = applyFig(inverse, 0, 0.5);
        const end = applyFig(inverse, 1, 0.5);
        if (paint.type === 'GRADIENT_LINEAR') {
          return { kind: 'linear', x1: fin(start.x), y1: fin(start.y), x2: fin(end.x, 1), y2: fin(end.y), stops };
        }
        if (paint.type !== 'GRADIENT_RADIAL') {
          this.warn('Angular and diamond gradients are drawn as radial gradients');
        }
        const center = applyFig(inverse, 0.5, 0.5);
        const cx = fin(center.x, 0.5);
        const cy = fin(center.y, 0.5);
        return { kind: 'radial', cx, cy, r: fin(Math.hypot(end.x - center.x, end.y - center.y), 0.5), fx: cx, fy: cy, stops };
      }
      case 'IMAGE': {
        const hash = paint.image?.hash;
        if (!(hash instanceof Uint8Array) || !hash.length) {
          this.warn(`Image fill without image data ("${node.name ?? ''}")`);
          return null;
        }
        const uid = Buffer.from(hash).toString('hex');
        if (typeof paint.image?.dataBlob === 'number' && !this.doc.blobImages.has(uid)) {
          this.doc.blobImages.set(uid, paint.image.dataBlob);
        }
        let width = positive(paint.originalImageWidth, 0);
        let height = positive(paint.originalImageHeight, 0);
        if (!width || !height) {
          const bytes = this.doc.imageBytes(uid);
          const measured = bytes ? imageSize(bytes) : null;
          width = measured?.width ?? 100;
          height = measured?.height ?? 100;
        }
        if (!this.doc.imageBytes(uid)) {
          this.warn('Some images are missing from the file');
        }
        if (paint.imageScaleMode === 'TILE') {
          this.warn('Tiled image fills are drawn stretched to fill');
        }
        this.imageUids.add(uid);
        return { kind: 'image', uid, width, height, fit: paint.imageScaleMode === 'FIT' ? 'contain' : 'cover' };
      }
      default:
        this.warn(`Unsupported fill "${paint.type ?? ''}" ("${node.name ?? ''}")`);
        return null;
    }
  }

  private stroke(node: FigNode): Stroke | null {
    const paint = this.paint(node.strokePaints, node);
    const sides: [number, number, number, number] | undefined = node.borderStrokeWeightsIndependent
      ? [nonNegative(node.borderTopWeight), nonNegative(node.borderRightWeight), nonNegative(node.borderBottomWeight), nonNegative(node.borderLeftWeight)]
      : undefined;
    const uniform = sides?.every((side) => side === sides[0]);
    const width = sides ? Math.max(...sides) : nonNegative(node.strokeWeight, 1);
    if (!paint || width <= 0) {
      return null;
    }
    let color: Rgba;
    if (paint.kind === 'solid') {
      color = paint.color;
    } else {
      this.warn('Gradient and image borders are drawn with their first color');
      color = paint.kind === 'image' ? { r: 128, g: 128, b: 128, a: 1 } : (paint.stops[0]?.color ?? { r: 0, g: 0, b: 0, a: 1 });
    }
    return {
      color,
      width,
      ...(sides && !uniform ? { sides } : {}),
      align: node.strokeAlign === 'INSIDE' ? 'inside' : node.strokeAlign === 'OUTSIDE' ? 'outside' : 'center',
      dash: (Array.isArray(node.dashPattern) ? node.dashPattern : []).map((value) => nonNegative(value)).slice(0, 64),
      cap: node.strokeCap === 'ROUND' ? 'round' : node.strokeCap === 'SQUARE' ? 'square' : 'butt',
      join: node.strokeJoin === 'ROUND' ? 'round' : node.strokeJoin === 'BEVEL' ? 'bevel' : 'miter',
    };
  }

  private shadows(effects: FigEffect[] | undefined, node: FigNode): Shadow[] {
    const shadows: Shadow[] = [];
    for (const effect of Array.isArray(effects) ? effects : []) {
      if (effect.visible === false) {
        continue;
      }
      if (effect.type !== 'DROP_SHADOW') {
        this.warn(`Effect "${effect.type ?? ''}" not rendered ("${node.name ?? ''}")`);
        continue;
      }
      if (shadows.length >= FIG_SCENE_LIMITS.shadowsPerLayer) {
        this.warn(`More than ${FIG_SCENE_LIMITS.shadowsPerLayer} shadows on one layer; the rest are not rendered ("${node.name ?? ''}")`);
        break;
      }
      if (effect.spread) {
        this.warn('Shadow spread is not rendered');
      }
      shadows.push({ x: fin(effect.offset?.x), y: fin(effect.offset?.y), blur: nonNegative(effect.radius), color: toRgba(effect.color, 1) });
    }
    return shadows;
  }
}

/**
 * Merges the overrides addressed to this node (by its override key, or its guid) into it. Overrides only carry
 * the fields they change, so a shallow merge is enough; identity fields always come from the node.
 */
function applyOverrides(node: FigNode, scope: InstanceScope | null, key = guidKey(node.overrideKey ?? node.guid)): FigNode {
  if (!scope) {
    return node;
  }
  let merged = node;
  for (const override of [...scope.overrides, ...scope.derived]) {
    const path = override.guidPath?.guids;
    if (path?.length === 1 && guidKey(path[0]) === key) {
      const fields = Object.fromEntries(Object.entries(override).filter(([name]) => name !== 'guidPath')) as Partial<FigNode>;
      merged = { ...merged, ...fields, guid: node.guid, type: node.type, parentIndex: node.parentIndex };
    }
  }
  return merged;
}

function identity(): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function toMatrix(t: FigMatrix | undefined): Matrix {
  return t ? { a: fin(t.m00, 1), b: fin(t.m10), c: fin(t.m01), d: fin(t.m11, 1), e: fin(t.m02), f: fin(t.m12) } : identity();
}

/** Decoded floats can be NaN/Infinity in a corrupt or hostile file; nothing non-finite reaches the scene. */
function fin(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: unknown, fallback = 0): number {
  return Math.max(0, fin(value, fallback));
}

function positive(value: unknown, fallback: number): number {
  const number = fin(value, fallback);
  return number > 0 ? number : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function sizeOf(node: FigNode): { width: number; height: number } {
  return { width: nonNegative(node.size?.x), height: nonNegative(node.size?.y) };
}

function invert(t: FigMatrix | undefined): FigMatrix {
  const m = t ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  const det = m.m00 * m.m11 - m.m01 * m.m10;
  if (!det) {
    return { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  }
  return {
    m00: m.m11 / det,
    m01: -m.m01 / det,
    m02: (m.m01 * m.m12 - m.m11 * m.m02) / det,
    m10: -m.m10 / det,
    m11: m.m00 / det,
    m12: (m.m10 * m.m02 - m.m00 * m.m12) / det,
  };
}

function applyFig(m: FigMatrix, x: number, y: number): { x: number; y: number } {
  return { x: m.m00 * x + m.m01 * y + m.m02, y: m.m10 * x + m.m11 * y + m.m12 };
}

function toRgba(color: FigColor | undefined, opacity: number): Rgba {
  const channel = (value: unknown) => Math.round(clamp01(fin(value)) * 255);
  return { r: channel(color?.r), g: channel(color?.g), b: channel(color?.b), a: clamp01(fin(color?.a, 1)) * opacity };
}

function cornerRadii(node: FigNode): [number, number, number, number] {
  if (node.rectangleCornerRadiiIndependent) {
    return [
      nonNegative(node.rectangleTopLeftCornerRadius),
      nonNegative(node.rectangleTopRightCornerRadius),
      nonNegative(node.rectangleBottomRightCornerRadius),
      nonNegative(node.rectangleBottomLeftCornerRadius),
    ];
  }
  const r = nonNegative(node.cornerRadius);
  return [r, r, r, r];
}

function toAlign(value: string | undefined): TextNode['align'] {
  return value === 'CENTER' ? 'center' : value === 'RIGHT' ? 'right' : value === 'JUSTIFIED' ? 'justify' : 'left';
}

function toTextTransform(value: string | undefined): TextTransform {
  return value === 'UPPER' ? 'uppercase' : value === 'LOWER' ? 'lowercase' : value === 'TITLE' ? 'titlecase' : 'none';
}

function lineHeightPx(lineHeight: FigTextStyle['lineHeight'], size: number): number | null {
  if (!lineHeight) {
    return null;
  }
  const value = fin(lineHeight.value);
  switch (lineHeight.units) {
    case 'PIXELS':
      return value;
    case 'PERCENT':
      return (value / 100) * size;
    case 'RAW':
      return value * size;
    default:
      return null;
  }
}
