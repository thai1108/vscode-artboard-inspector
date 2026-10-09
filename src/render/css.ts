import { toCssColor } from '../scene/color.ts';
import type { GradientStop, Paint, SceneNode, Shadow, Stroke, TextNode, TextStyle } from '../scene/scene.ts';
import { fmt, type Box } from './geometry.ts';

export interface CssBlock {
  /** Shown above the declarations when a text layer has several styles. */
  label: string | null;
  declarations: string[];
}

export function cssForNode(node: SceneNode, box: Box): CssBlock[] {
  if (node.kind === 'text') {
    return textCss(node);
  }
  const declarations = [`width: ${px(box.width)};`, `height: ${px(box.height)};`];
  if (node.kind === 'shape') {
    const { geometry, fill, stroke } = node;
    if (geometry.type === 'line') {
      const side = Math.abs(geometry.y2 - geometry.y1) > Math.abs(geometry.x2 - geometry.x1) ? 'left' : 'top';
      if (stroke) {
        declarations.push(`border-${side}: ${borderValue(stroke)};`);
      }
    } else {
      if (fill) {
        declarations.push(`background: ${backgroundValue(fill, box)};`);
      }
      if (stroke) {
        declarations.push(...borderDeclarations(stroke));
      }
      const radius = borderRadius(node);
      if (radius) {
        declarations.push(`border-radius: ${radius};`);
      }
    }
  }
  if (node.kind === 'group' && node.frame) {
    const { fill, stroke } = node.frame;
    if (fill) {
      declarations.push(`background: ${backgroundValue(fill, box)};`);
    }
    if (stroke) {
      declarations.push(...borderDeclarations(stroke));
    }
    const radius = borderRadius(node);
    if (radius) {
      declarations.push(`border-radius: ${radius};`);
    }
  }
  if (node.shadows.length) {
    declarations.push(`box-shadow: ${node.shadows.map(shadowValue).join(', ')};`);
  }
  if (node.opacity < 1) {
    declarations.push(`opacity: ${fmt(node.opacity)};`);
  }
  return [{ label: null, declarations }];
}

function textCss(node: TextNode): CssBlock[] {
  const multiple = node.styles.length > 1;
  return node.styles.map((style, index) => ({
    label: multiple ? sampleOf(node, index) : null,
    declarations: textDeclarations(node, style),
  }));
}

function textDeclarations(node: TextNode, style: TextStyle): string[] {
  const declarations = [
    `font-family: "${style.family}";`,
    `font-size: ${px(style.size)};`,
    `font-weight: ${style.weight}; /* ${style.fontStyle} */`,
  ];
  if (style.italic) {
    declarations.push('font-style: italic;');
  }
  if (node.lineHeight !== null) {
    declarations.push(`line-height: ${px(node.lineHeight)};`);
  }
  if (style.letterSpacing) {
    declarations.push(`letter-spacing: ${px((style.letterSpacing / 1000) * style.size)};`);
  }
  declarations.push(`color: ${toCssColor(style.color)};`);
  if (node.align !== 'left') {
    declarations.push(`text-align: ${node.align};`);
  }
  const decorations = [style.underline ? 'underline' : '', style.strikethrough ? 'line-through' : ''].filter(Boolean);
  if (decorations.length) {
    declarations.push(`text-decoration: ${decorations.join(' ')};`);
  }
  if (style.textTransform !== 'none') {
    declarations.push(`text-transform: ${style.textTransform === 'titlecase' ? 'capitalize' : style.textTransform};`);
  }
  if (node.opacity < 1) {
    declarations.push(`opacity: ${fmt(node.opacity)};`);
  }
  return declarations;
}

/** The first characters drawn with the given style, to tell multi-style CSS blocks apart. */
function sampleOf(node: TextNode, styleIndex: number): string {
  const text = node.lines
    .flatMap((line) => line.runs)
    .filter((run) => run.style === styleIndex)
    .map((run) => run.text)
    .join('');
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

export function backgroundValue(paint: Paint, box: Box): string {
  switch (paint.kind) {
    case 'solid':
      return toCssColor(paint.color);
    case 'linear': {
      const dx = (paint.x2 - paint.x1) * box.width;
      const dy = (paint.y2 - paint.y1) * box.height;
      const angle = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
      return `linear-gradient(${fmt(angle)}deg, ${gradientStops(paint.stops)})`;
    }
    case 'radial':
      return `radial-gradient(circle at ${fmt(paint.cx * 100)}% ${fmt(paint.cy * 100)}%, ${gradientStops(paint.stops)})`;
    case 'image':
      return `url("image.png") center / ${paint.fit} no-repeat`;
  }
}

function gradientStops(stops: GradientStop[]): string {
  return stops.map((stop) => `${toCssColor(stop.color)} ${fmt(stop.offset * 100)}%`).join(', ');
}

export function borderValue(stroke: Stroke, width = stroke.width): string {
  return `${px(width)} ${stroke.dash.length ? 'dashed' : 'solid'} ${toCssColor(stroke.color)}`;
}

/** `border: …` declarations, one per side when the sides differ. */
function borderDeclarations(stroke: Stroke): string[] {
  const note = stroke.align === 'inside' ? '' : ` /* ${stroke.align} stroke */`;
  if (!stroke.sides) {
    return [`border: ${borderValue(stroke)};${note}`];
  }
  const names = ['top', 'right', 'bottom', 'left'];
  return stroke.sides.flatMap((width, i) => (width ? [`border-${names[i]}: ${borderValue(stroke, width)};${note}`] : []));
}

export function shadowValue(shadow: Shadow): string {
  return `${px(shadow.x)} ${px(shadow.y)} ${px(shadow.blur)} ${toCssColor(shadow.color)}`;
}

/** CSS border-radius for a rect or circle, or null when the shape has square corners. */
export function borderRadius(node: SceneNode): string | null {
  let rect: { width: number; height: number; radii: [number, number, number, number] };
  if (node.kind === 'group' && node.frame) {
    rect = node.frame;
  } else if (node.kind === 'shape' && node.geometry.type === 'rect') {
    rect = node.geometry;
  } else {
    return node.kind === 'shape' && node.geometry.type === 'ellipse' ? '50%' : null;
  }
  const radii = rect.radii.map((r) => Math.min(r, rect.width / 2, rect.height / 2));
  if (radii.every((r) => r === 0)) {
    return null;
  }
  return radii.every((r) => r === radii[0]) ? px(radii[0] ?? 0) : radii.map(px).join(' ');
}

function px(value: number): string {
  return value === 0 ? '0' : `${fmt(value)}px`;
}
