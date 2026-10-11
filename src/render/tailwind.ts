// Tailwind CSS v4 classes for a layer, written from the same style data as the CSS (see css.ts). Theme utilities are
// used only when they produce exactly the design's value with the default theme (16px root); everything else is an
// arbitrary value. A project's own theme is not read.
import { toCssColor } from '../scene/color.ts';
import type { Paint, Rgba, SceneNode } from '../scene/scene.ts';
import { backgroundValue, shadowValue, styleForNode, type Radius, type StyleProp } from './css.ts';
import { fmt, type Box } from './geometry.ts';

export interface TailwindBlock {
  /** Shown above the classes when a text layer has several styles. */
  label: string | null;
  classes: string[];
}

// Default theme values, keyed by `fmt(px)`.
const RADIUS: Record<string, string> = { 2: 'xs', 4: 'sm', 6: 'md', 8: 'lg', 12: 'xl', 16: '2xl', 24: '3xl', 32: '4xl' };
/** Font size → [name, the line height the size sets on its own]. */
const TEXT: Record<string, [string, number]> = {
  12: ['xs', 16],
  14: ['sm', 20],
  16: ['base', 24],
  18: ['lg', 28],
  20: ['xl', 28],
  24: ['2xl', 32],
  30: ['3xl', 36],
  36: ['4xl', 40],
  48: ['5xl', 48],
  60: ['6xl', 60],
  72: ['7xl', 72],
  96: ['8xl', 96],
  128: ['9xl', 128],
};
const FONT_WEIGHT: Record<string, string> = {
  100: 'thin',
  200: 'extralight',
  300: 'light',
  400: 'normal',
  500: 'medium',
  600: 'semibold',
  700: 'bold',
  800: 'extrabold',
  900: 'black',
};
/** Keyed by em. */
const TRACKING: Record<string, string> = { '-0.05': 'tighter', '-0.025': 'tight', '0.025': 'wide', '0.05': 'wider', '0.1': 'widest' };

export function tailwindForNode(node: SceneNode, box: Box): TailwindBlock[] {
  return styleForNode(node, box).map(({ label, props }) => ({ label, classes: [...new Set(props.flatMap((prop) => classesFor(prop, props)))] }));
}

function classesFor(prop: StyleProp, block: StyleProp[]): string[] {
  switch (prop.name) {
    case 'width':
      return [sameLength(prop.px, pxOf(block, 'height')) ? sized('size', prop.px) : sized('w', prop.px)];
    case 'height':
      return sameLength(prop.px, pxOf(block, 'width')) ? [] : [sized('h', prop.px)];
    case 'font-size':
      return [fontSize(prop.px, pxOf(block, 'line-height'))];
    case 'line-height':
      return [];
    case 'letter-spacing':
      return [`tracking-${TRACKING[String(Math.round(prop.em * 1e5) / 1e5)] ?? `[${fmt(prop.px)}px]`}`];
    case 'background':
      return backgroundClasses(prop.paint, prop.box);
    case 'border': {
      const root = prop.side ? `border-${prop.side.charAt(0)}` : 'border';
      const width = fmt(prop.width);
      const widthClass = width === '1' ? root : Number.isInteger(Number(width)) ? `${root}-${width}` : `${root}-[${width}px]`;
      return [widthClass, ...(prop.stroke.dash.length ? ['border-dashed'] : []), `border-${color(prop.stroke.color)}`];
    }
    case 'border-radius':
      return radiusClasses(prop.radius);
    case 'box-shadow':
      return [`shadow-[${arbitrary(prop.shadows.map(shadowValue).join(', '))}]`];
    case 'opacity':
      return [`opacity-${Math.round(Number(fmt(prop.value)) * 100)}`];
    case 'font-family':
      return [`font-['${prop.family.replaceAll('_', '\\_').replaceAll(' ', '_')}']`];
    case 'font-weight':
      return [`font-${FONT_WEIGHT[prop.weight] ?? `[${prop.weight}]`}`];
    case 'color':
      return [`text-${color(prop.color)}`];
    case 'text-align':
      return [`text-${prop.value}`];
    case 'text-decoration':
      // underline and line-through both set text-decoration-line, so together they need an arbitrary property.
      return prop.lines.length > 1 ? [`[text-decoration-line:${prop.lines.join('_')}]`] : prop.lines;
    case 'font-style':
    case 'text-transform':
      return [prop.value];
  }
}

function pxOf(block: StyleProp[], name: 'width' | 'height' | 'line-height'): number | null {
  for (const prop of block) {
    if (prop.name === name) {
      return prop.px;
    }
  }
  return null;
}

function sameLength(a: number, b: number | null): boolean {
  return b !== null && fmt(a) === fmt(b);
}

/**
 * The spacing-scale step (`4` for 16px) when the length is on the 4px grid, or one of the half steps below 4 that the
 * classic scale names; null otherwise. Tailwind v4 also accepts quarter steps, but `w-3.25` reads worse than `w-[13px]`.
 */
function spacingStep(px: number): string | null {
  const step = Number(fmt(px)) / 4;
  return Number.isInteger(step) || (step < 4 && Number.isInteger(step * 2)) ? String(step) : null;
}

function sized(root: string, px: number): string {
  return `${root}-${fmt(px) === '1' ? 'px' : (spacingStep(px) ?? `[${fmt(px)}px]`)}`;
}

function fontSize(size: number, lineHeight: number | null): string {
  const theme = TEXT[fmt(size)];
  if (lineHeight === null) {
    // A theme size also sets a line height, which the design leaves unset.
    return `text-[${fmt(size)}px]`;
  }
  if (theme && fmt(lineHeight) === String(theme[1])) {
    return `text-${theme[0]}`;
  }
  return `text-${theme ? theme[0] : `[${fmt(size)}px]`}/${spacingStep(lineHeight) ?? `[${fmt(lineHeight)}px]`}`;
}

function backgroundClasses(paint: Paint, box: Box): string[] {
  switch (paint.kind) {
    case 'solid':
      return [`bg-${color(paint.color)}`];
    case 'image':
      return ['bg-[url(image.png)]', 'bg-center', `bg-${paint.fit}`, 'bg-no-repeat'];
    case 'linear':
    case 'radial':
      return [`bg-[${arbitrary(backgroundValue(paint, box))}]`];
  }
}

function radiusClasses(radius: Radius): string[] {
  if (radius === 'circle') {
    return ['rounded-full'];
  }
  if (radius === 'ellipse') {
    return ['rounded-[50%]'];
  }
  const [tl, tr, br, bl] = radius;
  const same = (a: number, b: number): boolean => fmt(a) === fmt(b);
  if (same(tl, tr) && same(tr, br) && same(br, bl)) {
    return [rounded('rounded', tl)];
  }
  let corners: [string, number][];
  if (same(tl, tr) && same(br, bl)) {
    corners = [['t', tl], ['b', br]];
  } else if (same(tl, bl) && same(tr, br)) {
    corners = [['l', tl], ['r', tr]];
  } else {
    corners = [['tl', tl], ['tr', tr], ['br', br], ['bl', bl]];
  }
  return corners.filter(([, px]) => fmt(px) !== '0').map(([corner, px]) => rounded(`rounded-${corner}`, px));
}

function rounded(root: string, px: number): string {
  return `${root}-${RADIUS[fmt(px)] ?? `[${fmt(px)}px]`}`;
}

/** Same color text as the CSS, as an arbitrary value: never approximated to the palette. */
function color(c: Rgba): string {
  return `[${toCssColor(c).replaceAll(' ', '')}]`;
}

/** A CSS value as a Tailwind arbitrary value: Tailwind turns underscores back into spaces. */
function arbitrary(value: string): string {
  return value.replaceAll(', ', ',').replaceAll(' ', '_');
}
