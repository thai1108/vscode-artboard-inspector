// What changed between two versions of one artboard, on the scene model. Values are written the way the inspector
// shows them and compared after the same rounding, so a change is only reported when the inspector shows it.
import { backgroundValue, borderRadius, shadowValue } from '../render/css.ts';
import { fmt, type Box } from '../render/geometry.ts';
import { layerBoxes, pathSignature, type LayerBox } from '../render/layerBoxes.ts';
import { roundAlpha, toCssColor } from '../scene/color.ts';
import type { ArtboardScene, Paint, Rgba, SceneNode, Stroke, TextNode } from '../scene/scene.ts';
import { displayName } from '../webview/layers.ts';
import { matchLayers } from './match.ts';

/** Caps that keep the diff of a huge or hostile artboard small enough to post to the webview; all changes are counted. */
export const DIFF_LIMITS = {
  /** Layer changes listed per artboard. */
  changes: 1_000,
  /** Characters kept of one value (text contents can be long). */
  valueLength: 300,
  /** Characters kept of all values of one artboard. */
  artboardChars: 300_000,
};

export type DiffLimits = typeof DIFF_LIMITS;

/** Lengths, angles and percentages closer than the 0.01 the inspector rounds to are equal. */
const TOLERANCE = 0.01 - 1e-9;
const UNIT_BOX: Box = { x: 0, y: 0, width: 1, height: 1 };

export type ChangeStatus = 'added' | 'removed' | 'changed';

/** One property as before → after, formatted like the inspector. */
export interface PropertyChange {
  label: string;
  before: string;
  after: string;
}

export interface LayerChange {
  status: ChangeStatus;
  /** Key of the layer in the earlier version's scene; null when it is not drawn there (added, or was hidden). */
  beforeKey: string | null;
  afterKey: string | null;
  name: string;
  /** Artboard pixels on each side, for outlines; the width of positioned text is estimated (see layerBoxes.ts). */
  beforeBox: Box | null;
  afterBox: Box | null;
  props: PropertyChange[];
}

export interface LayerCounts {
  added: number;
  removed: number;
  changed: number;
}

export interface SceneDiff {
  /** The artboard's own name, size and background. */
  props: PropertyChange[];
  /** Layer changes, topmost layer first, then removed layers; at most DIFF_LIMITS.changes. */
  changes: LayerChange[];
  /** Every change, also those beyond the cap. */
  counts: LayerCounts;
  truncated: boolean;
  /** Matched layers as [before key, after key], so a selection can follow the Before/After toggle. */
  pairs: [string, string][];
  matched: { byId: number; byName: number };
}

export type ImageKey = (side: 'before' | 'after', uid: string) => string;

export interface DiffOptions {
  /** Identity of an image's content; the uid itself when not given. */
  imageKey?: ImageKey;
  limits?: DiffLimits;
}

interface Shift {
  dx: number;
  dy: number;
}

const NO_SHIFT: Shift = { dx: 0, dy: 0 };

/**
 * Compares two versions of an artboard. Positions are compared in artboard pixels, but a layer that moved by the
 * same amount as its parent is not marked: a group whose matched layers all moved by the same amount counts as
 * moved itself (frames, which have a box of their own, by that box), and its layers count as moved only where they
 * moved by a different amount. A group sized by its layers reports no size of its own; its layers do.
 * Layers inside an added or removed layer are part of that change, not changes of their own.
 */
export function diffScenes(before: ArtboardScene, after: ArtboardScene, options: DiffOptions = {}): SceneDiff {
  const limits = options.limits ?? DIFF_LIMITS;
  const imageKey: ImageKey = options.imageKey ?? ((_side, uid) => uid);
  const matches = matchLayers(before.children, after.children);
  const beforeBoxes = layerBoxes(before);
  const afterBoxes = layerBoxes(after);
  const beforeNodes = new Map<string, SceneNode>();
  const collect = (nodes: SceneNode[]) => {
    for (const node of nodes) {
      beforeNodes.set(node.key, node);
      if (node.kind === 'group') {
        collect(node.children);
      }
    }
  };
  collect(before.children);
  const hiddenBefore = new Set(before.hidden ?? []);
  const hiddenAfter = new Set(after.hidden ?? []);

  const result: SceneDiff = {
    props: artboardProps(before, after),
    changes: [],
    counts: { added: 0, removed: 0, changed: 0 },
    truncated: false,
    pairs: [...matches.afterOf],
    matched: { byId: matches.byId, byName: matches.byName },
  };
  let chars = 0;
  const record = (change: LayerChange) => {
    result.counts[change.status]++;
    const props = change.props.map(({ label, before: b, after: a }) => ({ label, before: clip(b, limits.valueLength), after: clip(a, limits.valueLength) }));
    const size = props.reduce((sum, prop) => sum + prop.before.length + prop.after.length, change.name.length);
    if (result.changes.length >= limits.changes || chars + size > limits.artboardChars) {
      result.truncated = true;
      return;
    }
    chars += size;
    result.changes.push({ ...change, name: clip(change.name, limits.valueLength), props });
  };

  const shifts = new Map<string, Shift | null>();
  const shiftOf = (node: SceneNode): Shift | null => {
    const children = node.kind === 'group' ? node.children.map((child) => ({ child, shift: shiftOf(child) })) : [];
    const beforeKey = matches.beforeOf.get(node.key);
    let shift: Shift | null = null;
    if (beforeKey !== undefined) {
      if (sizedByChildren(node)) {
        const votes = children.filter(({ child }) => matches.beforeOf.has(child.key)).map(({ shift: s }) => s);
        const first = votes[0];
        shift = first && votes.every((s) => s && sameShift(s, first)) ? first : null;
      } else {
        shift = boxShift(beforeBoxes.get(beforeKey), afterBoxes.get(node.key));
      }
    }
    shifts.set(node.key, shift);
    return shift;
  };
  after.children.forEach(shiftOf);

  const visitAfter = (nodes: SceneNode[], reference: Shift, insideAdded: boolean) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i] as SceneNode;
      const beforeKey = matches.beforeOf.get(node.key);
      const previous = beforeKey === undefined ? undefined : beforeNodes.get(beforeKey);
      if (!previous) {
        if (!insideAdded) {
          const wasHidden = !!node.id && hiddenBefore.has(node.id);
          record({
            status: wasHidden ? 'changed' : 'added',
            beforeKey: null,
            afterKey: node.key,
            name: displayName(node),
            beforeBox: null,
            afterBox: plainBox(afterBoxes.get(node.key)),
            props: wasHidden ? [{ label: 'Visible', before: 'Hidden', after: 'Visible' }] : [],
          });
        }
        if (node.kind === 'group') {
          visitAfter(node.children, reference, true);
        }
        continue;
      }
      const shift = shifts.get(node.key) ?? null;
      const beforeBox = beforeBoxes.get(previous.key);
      const afterBox = afterBoxes.get(node.key);
      const props = [...geometryProps(previous, node, beforeBox, afterBox, shift, reference), ...layerProps(previous, node, imageKey)];
      if (props.length) {
        record({ status: 'changed', beforeKey: previous.key, afterKey: node.key, name: displayName(node), beforeBox: plainBox(beforeBox), afterBox: plainBox(afterBox), props: order(props) });
      }
      if (node.kind === 'group') {
        visitAfter(node.children, shift ?? reference, false);
      }
    }
  };
  visitAfter(after.children, NO_SHIFT, false);

  const visitBefore = (nodes: SceneNode[], parentMatched: boolean) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i] as SceneNode;
      const matched = matches.afterOf.has(node.key);
      if (!matched && parentMatched) {
        const nowHidden = !!node.id && hiddenAfter.has(node.id);
        record({
          status: nowHidden ? 'changed' : 'removed',
          beforeKey: node.key,
          afterKey: null,
          name: displayName(node),
          beforeBox: plainBox(beforeBoxes.get(node.key)),
          afterBox: null,
          props: nowHidden ? [{ label: 'Visible', before: 'Visible', after: 'Hidden' }] : [],
        });
      }
      if (node.kind === 'group') {
        visitBefore(node.children, matched);
      }
    }
  };
  visitBefore(before.children, true);
  return result;
}

/** Groups whose box is the extent of their layers (XD groups, Figma groups and masks), unlike frames. */
function sizedByChildren(node: SceneNode): boolean {
  return node.kind === 'group' && (!node.layoutSize || node.role === 'group');
}

/** Rotated or skewed positioned text has no exact position here, so it is not compared. */
function boxShift(before: LayerBox | undefined, after: LayerBox | undefined): Shift | null {
  if (!before || !after || before.estimated === 'all' || after.estimated === 'all') {
    return null;
  }
  return { dx: after.x - before.x, dy: after.y - before.y };
}

function sameShift(a: Shift, b: Shift): boolean {
  return Math.abs(a.dx - b.dx) < TOLERANCE && Math.abs(a.dy - b.dy) < TOLERANCE;
}

function plainBox(box: LayerBox | undefined): Box | null {
  return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
}

/** A property value as shown, with the number or identity it is compared by. */
interface Value {
  text: string;
  number?: number;
  identity?: string;
}

function changed(before: Value, after: Value): boolean {
  if (before.identity !== undefined || after.identity !== undefined) {
    return before.identity !== after.identity;
  }
  if (before.number !== undefined && after.number !== undefined) {
    return Math.abs(before.number - after.number) >= TOLERANCE && before.text !== after.text;
  }
  return before.text !== after.text;
}

function row(label: string, before: Value, after: Value): PropertyChange[] {
  return changed(before, after) ? [{ label, before: before.text, after: after.text }] : [];
}

const num = (value: number, suffix = ''): Value => ({ text: `${fmt(value)}${suffix}`, number: value });

function geometryProps(before: SceneNode, after: SceneNode, beforeBox: LayerBox | undefined, afterBox: LayerBox | undefined, shift: Shift | null, reference: Shift): PropertyChange[] {
  const props: PropertyChange[] = [];
  if (beforeBox && afterBox && shift) {
    // Moved with the parent: no change of its own.
    if (Math.abs(shift.dx - reference.dx) >= TOLERANCE) {
      props.push(...row('X', num(beforeBox.x), num(afterBox.x)));
    }
    if (Math.abs(shift.dy - reference.dy) >= TOLERANCE) {
      props.push(...row('Y', num(beforeBox.y), num(afterBox.y)));
    }
  }
  if (beforeBox && afterBox && !sizedByChildren(after)) {
    if (beforeBox.estimated === 'none' && afterBox.estimated === 'none') {
      props.push(...row('W', num(beforeBox.width), num(afterBox.width)));
    }
    if (beforeBox.estimated !== 'all' && afterBox.estimated !== 'all') {
      props.push(...row('H', num(beforeBox.height), num(afterBox.height)));
    }
  }
  props.push(...row('Rotate', num(rotation(before), '°'), num(rotation(after), '°')));
  return props;
}

function rotation(node: SceneNode): number {
  return (Math.atan2(node.transform.b, node.transform.a) * 180) / Math.PI;
}

/** Inspector order: layout, appearance, text, then the rest. */
const LABEL_ORDER = ['Visible', 'X', 'Y', 'W', 'H', 'Rotate', 'Opacity', 'Text', 'Font', 'Weight', 'Size', 'Line height', 'Letter spacing', 'Align', 'Color', 'Decoration', 'Fill', 'Image', 'Border', 'Radius', 'Shadow', 'Shape', 'Name'];

function order(props: PropertyChange[]): PropertyChange[] {
  return [...props].sort((p, q) => LABEL_ORDER.indexOf(p.label) - LABEL_ORDER.indexOf(q.label));
}

function layerProps(before: SceneNode, after: SceneNode, imageKey: ImageKey): PropertyChange[] {
  const props: PropertyChange[] = [];
  // XD and Figma name text layers after their content (Figma with line breaks as spaces) until they are renamed.
  const flat = (value: string) => value.replace(/\s+/g, ' ').trim();
  const autoNamed = (node: SceneNode) => node.kind === 'text' && flat(node.name) === flat(node.content);
  if (!(autoNamed(before) && autoNamed(after))) {
    props.push(...row('Name', { text: before.name }, { text: after.name }));
  }
  props.push(...row('Opacity', num(before.opacity * 100, '%'), num(after.opacity * 100, '%')));
  if (before.kind === 'text' && after.kind === 'text') {
    props.push(...textProps(before, after));
  }
  const beforePaints = paintsOf(before);
  const afterPaints = paintsOf(after);
  if (beforePaints || afterPaints) {
    props.push(...row('Fill', fillValue(beforePaints?.fill ?? null), fillValue(afterPaints?.fill ?? null)));
    props.push(...imageRow(beforePaints?.fill ?? null, afterPaints?.fill ?? null, imageKey));
    props.push(...row('Border', strokeValue(beforePaints?.stroke ?? null), strokeValue(afterPaints?.stroke ?? null)));
    props.push(...row('Radius', { text: borderRadius(before) ?? '0' }, { text: borderRadius(after) ?? '0' }));
  }
  props.push(...row('Shadow', shadowsValue(before), shadowsValue(after)));
  if (before.kind === 'shape' && after.kind === 'shape') {
    props.push(...row('Shape', shapeValue(before), shapeValue(after)));
  }
  return props;
}

function paintsOf(node: SceneNode): { fill: Paint | null; stroke: Stroke | null } | null {
  if (node.kind === 'shape') {
    return node;
  }
  return node.kind === 'group' ? (node.frame ?? { fill: null, stroke: null }) : null;
}

function fillValue(paint: Paint | null): Value {
  if (!paint) {
    return { text: 'none' };
  }
  switch (paint.kind) {
    case 'image':
      return { text: `Image (${paint.fit})` };
    case 'solid':
      return { text: colorText(paint.color) };
    default:
      // Directions are compared as drawn in a square, so resizing a layer does not read as a new gradient.
      return { text: backgroundValue({ ...paint, stops: paint.stops.map((stop) => ({ ...stop, color: shown(stop.color) })) }, UNIT_BOX) };
  }
}

function imageRow(before: Paint | null, after: Paint | null, imageKey: ImageKey): PropertyChange[] {
  const describe = (paint: Paint | null, side: 'before' | 'after') =>
    paint?.kind === 'image' ? { text: `${fmt(paint.width)} × ${fmt(paint.height)}`, identity: imageKey(side, paint.uid) } : { text: 'none', identity: '' };
  const b = describe(before, 'before');
  const a = describe(after, 'after');
  if (!changed(b, a)) {
    return [];
  }
  // Same size, other pixels: tell the two apart by their content.
  const tag = (value: Value) => (b.text === a.text && value.identity ? `${value.text} · ${value.identity.slice(0, 7)}` : value.text);
  return [{ label: 'Image', before: tag(b), after: tag(a) }];
}

function strokeValue(stroke: Stroke | null): Value {
  if (!stroke) {
    return { text: 'none' };
  }
  const width = stroke.sides ? stroke.sides.map(fmt).join(' ') : fmt(stroke.width);
  const dash = stroke.dash.length ? ` dashed ${stroke.dash.map(fmt).join(' ')}` : '';
  return { text: `${width} ${stroke.align} ${colorText(stroke.color)}${dash}` };
}

function shadowsValue(node: SceneNode): Value {
  return { text: node.shadows.map((shadow) => shadowValue({ ...shadow, color: shown(shadow.color) })).join(', ') || 'none' };
}

/** A color as the inspector shows it: whole channels, alpha to 0.01. */
function shown(color: Rgba): Rgba {
  return { r: Math.round(color.r), g: Math.round(color.g), b: Math.round(color.b), a: roundAlpha(color.a) };
}

function colorText(color: Rgba): string {
  return toCssColor(shown(color));
}

const GEOMETRY_LABELS = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', path: 'Path' } as const;

/** Rects, ellipses and lines differ only in size, which W/H report; paths also in their outline. */
function shapeValue(node: Extract<SceneNode, { kind: 'shape' }>): Value {
  const { geometry } = node;
  const label = GEOMETRY_LABELS[geometry.type];
  if (geometry.type !== 'path') {
    return { text: label, identity: label };
  }
  const signature = pathSignature(geometry.d);
  return { text: `${label} (${signature.split(/[MLCQAZ]/).length - 1} segments)`, identity: `${label}:${signature}` };
}

function textProps(before: TextNode, after: TextNode): PropertyChange[] {
  const styles = (node: TextNode, value: (style: TextNode['styles'][number]) => string): Value => ({ text: [...new Set(node.styles.map(value))].join(', ') });
  return [
    ...row('Text', { text: before.content }, { text: after.content }),
    ...row('Font', styles(before, (s) => s.family), styles(after, (s) => s.family)),
    ...row('Weight', styles(before, (s) => `${s.weight} (${s.fontStyle})`), styles(after, (s) => `${s.weight} (${s.fontStyle})`)),
    ...row('Size', styles(before, (s) => fmt(s.size)), styles(after, (s) => fmt(s.size))),
    ...row('Line height', before.lineHeight === null ? { text: 'auto' } : num(before.lineHeight), after.lineHeight === null ? { text: 'auto' } : num(after.lineHeight)),
    ...row('Letter spacing', styles(before, (s) => fmt(s.letterSpacing)), styles(after, (s) => fmt(s.letterSpacing))),
    ...row('Align', { text: before.align }, { text: after.align }),
    ...row('Color', styles(before, (s) => colorText(s.color)), styles(after, (s) => colorText(s.color))),
    ...row('Decoration', styles(before, decoration), styles(after, decoration)),
  ];
}

function decoration(style: TextNode['styles'][number]): string {
  const parts = [style.underline ? 'underline' : '', style.strikethrough ? 'line-through' : '', style.italic ? 'italic' : '', style.textTransform !== 'none' ? style.textTransform : ''];
  return parts.filter(Boolean).join(' ') || 'none';
}

function artboardProps(before: ArtboardScene, after: ArtboardScene): PropertyChange[] {
  const background = (scene: ArtboardScene): Value => ({ text: scene.background ? colorText(scene.background) : 'none' });
  return [
    ...row('Name', { text: before.name }, { text: after.name }),
    ...row('W', num(before.width), num(after.width)),
    ...row('H', num(before.height), num(after.height)),
    ...row('Background', background(before), background(after)),
  ];
}

/** Shortens a value to `max` characters (not splitting a surrogate pair), marking the cut with "…". */
function clip(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  let end = max - 1;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end--;
  }
  return `${value.slice(0, end)}…`;
}

