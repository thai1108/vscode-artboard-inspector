import { toCssColor } from '../scene/color.ts';
import type { GradientStop, Paint, Rgba, SceneNode, Shadow, Stroke, TextNode, TextStyle } from '../scene/scene.ts';
import { fmt, type Box } from './geometry.ts';

export type BorderSide = 'top' | 'right' | 'bottom' | 'left';

/** Corner radii [topLeft, topRight, bottomRight, bottomLeft], or a rounded-off ellipse. */
export type Radius = [number, number, number, number] | 'circle' | 'ellipse';

/** One style property of a layer, kept as data so the CSS and the Tailwind classes are written from the same values. */
export type StyleProp =
  | { name: 'width' | 'height' | 'font-size' | 'line-height'; px: number }
  | { name: 'letter-spacing'; em: number; px: number }
  | { name: 'background'; paint: Paint; box: Box }
  /** `line`: drawn from a line layer, whose stroke has no inside or outside. */
  | { name: 'border'; side: BorderSide | null; width: number; stroke: Stroke; line: boolean }
  | { name: 'border-radius'; radius: Radius }
  | { name: 'box-shadow'; shadows: Shadow[] }
  | { name: 'opacity'; value: number }
  | { name: 'font-family'; family: string }
  | { name: 'font-weight'; weight: number; fontStyle: string }
  | { name: 'font-style'; value: 'italic' }
  | { name: 'color'; color: Rgba }
  | { name: 'text-align'; value: 'center' | 'right' | 'justify' }
  | { name: 'text-decoration'; lines: ('underline' | 'line-through')[] }
  | { name: 'text-transform'; value: 'uppercase' | 'lowercase' | 'capitalize' };

export interface StyleBlock {
  /** Shown above the properties when a text layer has several styles. */
  label: string | null;
  props: StyleProp[];
}

export interface CssBlock {
  /** Shown above the declarations when a text layer has several styles. */
  label: string | null;
  declarations: string[];
}

export function styleForNode(node: SceneNode, box: Box): StyleBlock[] {
  if (node.kind === 'text') {
    return textStyles(node);
  }
  const props: StyleProp[] = [
    { name: 'width', px: box.width },
    { name: 'height', px: box.height },
  ];
  if (node.kind === 'shape' && node.geometry.type === 'line') {
    const { geometry, stroke } = node;
    if (stroke) {
      const side = Math.abs(geometry.y2 - geometry.y1) > Math.abs(geometry.x2 - geometry.x1) ? 'left' : 'top';
      props.push({ name: 'border', side, width: stroke.width, stroke, line: true });
    }
  } else {
    const paints = node.kind === 'shape' ? node : node.kind === 'group' ? node.frame : null;
    if (paints?.fill) {
      props.push({ name: 'background', paint: paints.fill, box });
    }
    if (paints?.stroke) {
      props.push(...borderProps(paints.stroke));
    }
    const radius = radiusOf(node);
    if (radius) {
      props.push({ name: 'border-radius', radius });
    }
  }
  if (node.shadows.length) {
    props.push({ name: 'box-shadow', shadows: node.shadows });
  }
  if (node.opacity < 1) {
    props.push({ name: 'opacity', value: node.opacity });
  }
  return [{ label: null, props }];
}

export function cssForNode(node: SceneNode, box: Box): CssBlock[] {
  return styleForNode(node, box).map(({ label, props }) => ({ label, declarations: props.map(cssDeclaration) }));
}

function cssDeclaration(prop: StyleProp): string {
  switch (prop.name) {
    case 'width':
    case 'height':
    case 'font-size':
    case 'line-height':
    case 'letter-spacing':
      return `${prop.name}: ${px(prop.px)};`;
    case 'background':
      return `background: ${backgroundValue(prop.paint, prop.box)};`;
    case 'border': {
      const note = prop.line || prop.stroke.align === 'inside' ? '' : ` /* ${prop.stroke.align} stroke */`;
      return `border${prop.side ? `-${prop.side}` : ''}: ${borderValue(prop.stroke, prop.width)};${note}`;
    }
    case 'border-radius':
      return `border-radius: ${radiusValue(prop.radius)};`;
    case 'box-shadow':
      return `box-shadow: ${prop.shadows.map(shadowValue).join(', ')};`;
    case 'opacity':
      return `opacity: ${fmt(prop.value)};`;
    case 'font-family':
      return `font-family: "${prop.family}";`;
    case 'font-weight':
      return `font-weight: ${prop.weight}; /* ${prop.fontStyle} */`;
    case 'color':
      return `color: ${toCssColor(prop.color)};`;
    case 'text-decoration':
      return `text-decoration: ${prop.lines.join(' ')};`;
    case 'font-style':
    case 'text-align':
    case 'text-transform':
      return `${prop.name}: ${prop.value};`;
  }
}

function textStyles(node: TextNode): StyleBlock[] {
  const multiple = node.styles.length > 1;
  return node.styles.map((style, index) => ({
    label: multiple ? sampleOf(node, index) : null,
    props: textProps(node, style),
  }));
}

function textProps(node: TextNode, style: TextStyle): StyleProp[] {
  const props: StyleProp[] = [
    { name: 'font-family', family: style.family },
    { name: 'font-size', px: style.size },
    { name: 'font-weight', weight: style.weight, fontStyle: style.fontStyle },
  ];
  if (style.italic) {
    props.push({ name: 'font-style', value: 'italic' });
  }
  if (node.lineHeight !== null) {
    props.push({ name: 'line-height', px: node.lineHeight });
  }
  if (style.letterSpacing) {
    const em = style.letterSpacing / 1000;
    props.push({ name: 'letter-spacing', em, px: em * style.size });
  }
  props.push({ name: 'color', color: style.color });
  if (node.align !== 'left') {
    props.push({ name: 'text-align', value: node.align });
  }
  const lines: ('underline' | 'line-through')[] = [];
  if (style.underline) {
    lines.push('underline');
  }
  if (style.strikethrough) {
    lines.push('line-through');
  }
  if (lines.length) {
    props.push({ name: 'text-decoration', lines });
  }
  if (style.textTransform !== 'none') {
    props.push({ name: 'text-transform', value: style.textTransform === 'titlecase' ? 'capitalize' : style.textTransform });
  }
  if (node.opacity < 1) {
    props.push({ name: 'opacity', value: node.opacity });
  }
  return props;
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

/** One border for the whole box, or one per side when the sides differ. */
function borderProps(stroke: Stroke): StyleProp[] {
  if (!stroke.sides) {
    return [{ name: 'border', side: null, width: stroke.width, stroke, line: false }];
  }
  const sides: BorderSide[] = ['top', 'right', 'bottom', 'left'];
  return stroke.sides.flatMap((width, i): StyleProp[] => (width ? [{ name: 'border', side: sides[i] ?? null, width, stroke, line: false }] : []));
}

export function shadowValue(shadow: Shadow): string {
  return `${px(shadow.x)} ${px(shadow.y)} ${px(shadow.blur)} ${toCssColor(shadow.color)}`;
}

/** Radius of a rect, frame or ellipse (corners clamped to half the shorter side), or null when the corners are square. */
export function radiusOf(node: SceneNode): Radius | null {
  let rect: { width: number; height: number; radii: [number, number, number, number] };
  if (node.kind === 'group' && node.frame) {
    rect = node.frame;
  } else if (node.kind === 'shape' && node.geometry.type === 'rect') {
    rect = node.geometry;
  } else if (node.kind === 'shape' && node.geometry.type === 'ellipse') {
    return node.geometry.rx === node.geometry.ry ? 'circle' : 'ellipse';
  } else {
    return null;
  }
  const radii = rect.radii.map((r) => Math.min(r, rect.width / 2, rect.height / 2)) as [number, number, number, number];
  return radii.every((r) => r === 0) ? null : radii;
}

/** CSS border-radius for a rect or circle, or null when the shape has square corners. */
export function borderRadius(node: SceneNode): string | null {
  const radius = radiusOf(node);
  return radius && radiusValue(radius);
}

function radiusValue(radius: Radius): string {
  if (typeof radius === 'string') {
    return '50%';
  }
  return radius.every((r) => r === radius[0]) ? px(radius[0]) : radius.map(px).join(' ');
}

function px(value: number): string {
  return value === 0 ? '0' : `${fmt(value)}px`;
}
