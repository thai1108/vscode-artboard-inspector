import { toHex } from '../scene/color.ts';
import { isIdentity } from '../scene/matrix.ts';
import type {
  ArtboardScene,
  FrameStyle,
  Geometry,
  GroupNode,
  Matrix,
  Paint,
  Rgba,
  SceneNode,
  Shadow,
  ShapeNode,
  Stroke,
  TextNode,
  TextStyle,
  TextTransform,
} from '../scene/scene.ts';

export type ImageUrlResolver = (uid: string) => string | undefined;

/** Fallbacks for Japanese glyphs that XD's Latin-only fonts (e.g. Noto Sans) do not contain. */
const FONT_FALLBACKS = "'Noto Sans JP', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', Meiryo, sans-serif";
const MISSING_IMAGE_FILL = '#D9D9D9';
/**
 * Windows UI fonts (Yu Gothic UI, Meiryo UI) have proportional kana, so XD lays Japanese out narrower than the
 * fallbacks available here; runs drawn with them get class `dv-palt` (proportional alternates, see viewer.css).
 */
const PROPORTIONAL_UI_FONT = /\bUI\b/;
const HUGE = 100000;

/**
 * Renders an artboard as a standalone SVG string. Every layer becomes `<g data-key="…">` so the webview can map
 * DOM hits back to scene nodes; the element carrying the layer's own geometry has class `dv-geom`.
 * Gradient/clip/filter ids start with `idPrefix`, which must differ between SVGs placed in the same page.
 */
export function renderArtboardSvg(scene: ArtboardScene, imageUrl: ImageUrlResolver, idPrefix = 'dv'): string {
  const writer = new SvgWriter(imageUrl, idPart(idPrefix));
  const body = scene.children.map((node) => writer.node(node)).join('');
  const width = num(scene.width);
  const height = num(scene.height);
  const background = scene.background
    ? `<rect class="dv-bg" width="${width}" height="${height}" ${colorAttrs('fill', scene.background)}/>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="dv-artboard" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs>${writer.defs.join('')}</defs>${background}${body}</svg>`
  );
}

class SvgWriter {
  readonly defs: string[] = [];
  private readonly imageUrl: ImageUrlResolver;
  private readonly idPrefix: string;

  constructor(imageUrl: ImageUrlResolver, idPrefix: string) {
    this.imageUrl = imageUrl;
    this.idPrefix = idPrefix;
  }

  node(node: SceneNode): string {
    const attrs = [`data-key="${escapeAttr(node.key)}"`];
    if (!isIdentity(node.transform)) {
      attrs.push(`transform="${matrix(node.transform)}"`);
    }
    if (node.opacity < 1) {
      attrs.push(`opacity="${num(node.opacity)}"`);
    }
    const isLine = node.kind === 'shape' && node.geometry.type === 'line';
    if (node.shadows.length && !isLine) {
      attrs.push(`filter="url(#${this.shadowFilter(node.key, node.shadows)})"`);
    }
    return `<g ${attrs.join(' ')}>${this.body(node)}</g>`;
  }

  private body(node: SceneNode): string {
    switch (node.kind) {
      case 'shape':
        return this.shape(node);
      case 'text':
        return text(node);
      case 'group':
        return this.group(node);
    }
  }

  private shape(node: ShapeNode, className = 'dv-geom'): string {
    const { geometry, stroke } = node;
    const primary = [this.fill(node.fill, node.key)];
    let auxiliary = '';
    if (stroke && node.strokeOutline) {
      auxiliary = `<path d="${escapeAttr(node.strokeOutline)}" ${colorAttrs('fill', stroke.color)}/>`;
    } else if (stroke?.sides && geometry.type === 'rect') {
      auxiliary = sideBorders(geometry, stroke, stroke.sides);
    } else if (stroke) {
      if (stroke.align === 'center' || geometry.type === 'line') {
        primary.push(strokeAttrs(stroke, stroke.width));
      } else if (geometry.type === 'path') {
        auxiliary = this.alignedPathStroke(node.key, geometry.d, geometry.fillRule ?? 'evenodd', stroke);
      } else {
        const offset = stroke.align === 'inside' ? -stroke.width / 2 : stroke.width / 2;
        auxiliary = geometryElement(grow(geometry, offset), `fill="none" ${strokeAttrs(stroke, stroke.width)}`);
      }
    }
    return geometryElement(geometry, `class="${className}" ${primary.join(' ')}`) + auxiliary;
  }

  /** SVG only strokes centered, so inside/outside path strokes are drawn twice as wide and clipped/masked. */
  private alignedPathStroke(key: string, d: string, fillRule: string, stroke: Stroke): string {
    const path = `d="${escapeAttr(d)}" fill-rule="${fillRule}"`;
    const doubled = `fill="none" ${strokeAttrs(stroke, stroke.width * 2)}`;
    if (stroke.align === 'inside') {
      const id = `${this.idPrefix}-${idPart(key)}-stroke-clip`;
      this.defs.push(`<clipPath id="${id}"><path ${path}/></clipPath>`);
      return `<path ${path} ${doubled} clip-path="url(#${id})"/>`;
    }
    const id = `${this.idPrefix}-${idPart(key)}-stroke-mask`;
    const area = `x="${-HUGE}" y="${-HUGE}" width="${HUGE * 2}" height="${HUGE * 2}"`;
    this.defs.push(
      `<mask id="${id}" maskUnits="userSpaceOnUse" ${area}><rect ${area} fill="white"/><path ${path} fill="black"/></mask>`,
    );
    return `<path ${path} ${doubled} mask="url(#${id})"/>`;
  }

  private group(node: GroupNode): string {
    const background = node.frame ? this.frameBackground(node, node.frame) : '';
    const children = node.children.map((child) => this.node(child)).join('');
    if (!node.clip) {
      return background + children;
    }
    const id = `${this.idPrefix}-${idPart(node.key)}-clip`;
    const shapes = node.clip
      .map((shape) => geometryElement(shape.geometry, isIdentity(shape.transform) ? '' : `transform="${matrix(shape.transform)}"`))
      .join('');
    this.defs.push(`<clipPath id="${id}">${shapes}</clipPath>`);
    return `${background}<g clip-path="url(#${id})">${children}</g>`;
  }

  /** A frame's own fill and border, drawn under its (clipped) children. */
  private frameBackground(node: GroupNode, frame: FrameStyle): string {
    return this.shape(
      {
        ...node,
        key: `${node.key}-frame`,
        kind: 'shape',
        geometry: { type: 'rect', x: 0, y: 0, width: frame.width, height: frame.height, radii: frame.radii },
        fill: frame.fill,
        stroke: frame.stroke,
      },
      'dv-frame',
    );
  }

  private fill(paint: Paint | null, key: string): string {
    if (!paint) {
      return 'fill="none"';
    }
    switch (paint.kind) {
      case 'solid':
        return colorAttrs('fill', paint.color);
      case 'linear': {
        const id = `${this.idPrefix}-${idPart(key)}-fill`;
        this.defs.push(
          `<linearGradient id="${id}" x1="${num(paint.x1)}" y1="${num(paint.y1)}" x2="${num(paint.x2)}" y2="${num(paint.y2)}">` +
            `${paint.stops.map(stopElement).join('')}</linearGradient>`,
        );
        return `fill="url(#${id})"`;
      }
      case 'radial': {
        const id = `${this.idPrefix}-${idPart(key)}-fill`;
        this.defs.push(
          `<radialGradient id="${id}" cx="${num(paint.cx)}" cy="${num(paint.cy)}" r="${num(paint.r)}" fx="${num(paint.fx)}" fy="${num(paint.fy)}">` +
            `${paint.stops.map(stopElement).join('')}</radialGradient>`,
        );
        return `fill="url(#${id})"`;
      }
      case 'image': {
        const url = this.imageUrl(paint.uid);
        if (!url) {
          return `fill="${MISSING_IMAGE_FILL}"`;
        }
        const id = `${this.idPrefix}-${idPart(key)}-fill`;
        const width = num(paint.width);
        const height = num(paint.height);
        const fit = paint.fit === 'contain' ? 'meet' : 'slice';
        this.defs.push(
          `<pattern id="${id}" patternUnits="objectBoundingBox" width="1" height="1" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid ${fit}">` +
            `<image width="${width}" height="${height}" href="${escapeAttr(url)}" preserveAspectRatio="none"/></pattern>`,
        );
        return `fill="url(#${id})"`;
      }
    }
  }

  private shadowFilter(key: string, shadows: Shadow[]): string {
    const id = `${this.idPrefix}-${idPart(key)}-shadow`;
    const layers = shadows
      .map(
        (shadow, i) =>
          `<feGaussianBlur in="SourceAlpha" stdDeviation="${num(shadow.blur / 2)}" result="b${i}"/>` +
          `<feOffset in="b${i}" dx="${num(shadow.x)}" dy="${num(shadow.y)}" result="o${i}"/>` +
          `<feFlood flood-color="${toHex(shadow.color)}" flood-opacity="${num(shadow.color.a)}" result="f${i}"/>` +
          `<feComposite in="f${i}" in2="o${i}" operator="in" result="s${i}"/>`,
      )
      .join('');
    const merge = shadows.map((_, i) => `<feMergeNode in="s${i}"/>`).join('');
    this.defs.push(
      `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">` +
        `${layers}<feMerge>${merge}<feMergeNode in="SourceGraphic"/></feMerge></filter>`,
    );
    return id;
  }
}

function text(node: TextNode): string {
  return node.lines
    .map((line) => {
      const runs = line.runs
        .map((run) => {
          const style = node.styles[run.style];
          const position = run.xs ? `x="${run.xs.map(num).join(' ')}"` : run.x === undefined ? '' : `x="${num(run.x)}"`;
          const attrs = [position, style ? textStyleAttrs(style, run.glyphFont) : ''];
          if (run.glyphFont && PROPORTIONAL_UI_FONT.test(run.glyphFont)) {
            attrs.push('class="dv-palt"');
          }
          return `<tspan ${attrs.filter(Boolean).join(' ')}>${escapeText(applyTextTransform(run.text, style?.textTransform ?? 'none'))}</tspan>`;
        })
        .join('');
      // white-space: pre comes from viewer.css; the webview CSP blocks inline style attributes.
      return `<text x="${num(line.x)}" y="${num(line.y)}" pointer-events="bounding-box">${runs}</text>`;
    })
    .join('');
}

function textStyleAttrs(style: TextStyle, glyphFont: string | undefined): string {
  const attrs = [
    `font-family="${escapeAttr(fontFamilyList(style.family, glyphFont))}"`,
    `font-size="${num(style.size)}"`,
    `font-weight="${style.weight}"`,
    colorAttrs('fill', style.color),
  ];
  if (style.italic) {
    attrs.push('font-style="italic"');
  }
  if (style.letterSpacing) {
    attrs.push(`letter-spacing="${num((style.letterSpacing / 1000) * style.size)}"`);
  }
  const decorations = [style.underline ? 'underline' : '', style.strikethrough ? 'line-through' : ''].filter(Boolean);
  if (decorations.length) {
    attrs.push(`text-decoration="${decorations.join(' ')}"`);
  }
  return attrs.join(' ');
}

export function fontFamilyList(family: string, glyphFont?: string): string {
  const quote = (name: string) => `'${name.replace(/['"]/g, '')}'`;
  return [quote(family), ...(glyphFont ? [quote(glyphFont)] : []), FONT_FALLBACKS].join(', ');
}

export function applyTextTransform(value: string, transform: TextTransform): string {
  switch (transform) {
    case 'uppercase':
      return value.toUpperCase();
    case 'lowercase':
      return value.toLowerCase();
    case 'titlecase':
      return value.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
    case 'none':
      return value;
  }
}

export function geometryElement(geometry: Geometry, attrs: string): string {
  switch (geometry.type) {
    case 'rect': {
      const { x, y, width, height, radii } = geometry;
      const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(r, width / 2, height / 2))) as [number, number, number, number];
      if (tl === tr && tr === br && br === bl) {
        const rx = tl ? ` rx="${num(tl)}"` : '';
        return `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}"${rx} ${attrs}/>`;
      }
      const d =
        `M${num(x + tl)},${num(y)} H${num(x + width - tr)} A${num(tr)},${num(tr)} 0 0 1 ${num(x + width)},${num(y + tr)} ` +
        `V${num(y + height - br)} A${num(br)},${num(br)} 0 0 1 ${num(x + width - br)},${num(y + height)} ` +
        `H${num(x + bl)} A${num(bl)},${num(bl)} 0 0 1 ${num(x)},${num(y + height - bl)} ` +
        `V${num(y + tl)} A${num(tl)},${num(tl)} 0 0 1 ${num(x + tl)},${num(y)} Z`;
      return `<path d="${d}" ${attrs}/>`;
    }
    case 'ellipse':
      return `<ellipse cx="${num(geometry.cx)}" cy="${num(geometry.cy)}" rx="${num(geometry.rx)}" ry="${num(geometry.ry)}" ${attrs}/>`;
    case 'line':
      return `<line x1="${num(geometry.x1)}" y1="${num(geometry.y1)}" x2="${num(geometry.x2)}" y2="${num(geometry.y2)}" ${attrs}/>`;
    case 'path':
      return `<path d="${escapeAttr(geometry.d)}" fill-rule="${geometry.fillRule ?? 'evenodd'}" ${attrs}/>`;
  }
}

/** Borders whose width differs per side, drawn as filled strips (corner radii are ignored). */
function sideBorders(rect: { x: number; y: number; width: number; height: number }, stroke: Stroke, [top, right, bottom, left]: [number, number, number, number]): string {
  // How far each strip extends outside the box: none for inside, half for center, all for outside.
  const out = (width: number) => (stroke.align === 'inside' ? 0 : stroke.align === 'center' ? width / 2 : width);
  const x0 = rect.x - out(left);
  const x1 = rect.x + rect.width + out(right);
  const y0 = rect.y - out(top);
  const y1 = rect.y + rect.height + out(bottom);
  const strips = [
    top ? [x0, y0, x1 - x0, top] : null,
    bottom ? [x0, y1 - bottom, x1 - x0, bottom] : null,
    left ? [x0, y0, left, y1 - y0] : null,
    right ? [x1 - right, y0, right, y1 - y0] : null,
  ].filter((strip): strip is number[] => strip !== null);
  return strips
    .map(([x = 0, y = 0, width = 0, height = 0]) => `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" ${colorAttrs('fill', stroke.color)}/>`)
    .join('');
}

/** Offsets a rect/ellipse outline by `amount` on every side (negative shrinks). */
function grow(geometry: Geometry, amount: number): Geometry {
  switch (geometry.type) {
    case 'rect':
      return {
        ...geometry,
        x: geometry.x - amount,
        y: geometry.y - amount,
        width: Math.max(0, geometry.width + amount * 2),
        height: Math.max(0, geometry.height + amount * 2),
        radii: geometry.radii.map((r) => (r > 0 ? Math.max(0, r + amount) : 0)) as [number, number, number, number],
      };
    case 'ellipse':
      return { ...geometry, rx: Math.max(0, geometry.rx + amount), ry: Math.max(0, geometry.ry + amount) };
    default:
      return geometry;
  }
}

function strokeAttrs(stroke: Stroke, width: number): string {
  const attrs = [colorAttrs('stroke', stroke.color), `stroke-width="${num(width)}"`];
  if (stroke.dash.length) {
    attrs.push(`stroke-dasharray="${stroke.dash.map(num).join(' ')}"`);
  }
  if (stroke.cap !== 'butt') {
    attrs.push(`stroke-linecap="${escapeAttr(stroke.cap)}"`);
  }
  if (stroke.join !== 'miter') {
    attrs.push(`stroke-linejoin="${escapeAttr(stroke.join)}"`);
  }
  return attrs.join(' ');
}

function stopElement(stop: { offset: number; color: Rgba }): string {
  const opacity = stop.color.a < 1 ? ` stop-opacity="${num(stop.color.a)}"` : '';
  return `<stop offset="${num(stop.offset)}" stop-color="${toHex(stop.color)}"${opacity}/>`;
}

function colorAttrs(property: 'fill' | 'stroke', color: Rgba): string {
  const opacity = color.a < 1 ? ` ${property}-opacity="${num(color.a)}"` : '';
  return `${property}="${toHex(color)}"${opacity}`;
}

function matrix(m: Matrix): string {
  return `matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map(num).join(' ')})`;
}

export function num(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** Layer keys are generated (`n123`), but ids built from them must never break out of an attribute or url(#…). */
function idPart(key: string): string {
  return String(key).replace(/[^\w-]/g, '_');
}

function escapeText(value: string): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}
