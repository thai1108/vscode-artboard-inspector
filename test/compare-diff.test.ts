import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DIFF_LIMITS, diffScenes, type LayerChange, type PropertyChange, type SceneDiff } from '../src/compare/diff.ts';
import type { ArtboardScene, Paint, SceneNode } from '../src/scene/scene.ts';
import { artboard, group, shape, stroke, text, textStyle } from './support/sceneBuilders.ts';

const at = (x: number, y: number) => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });
const solid = (r: number, g: number, b: number, a = 1): Paint => ({ kind: 'solid', color: { r, g, b, a } });

/** The rows of every change, as "name: label before → after". */
function rows(diff: SceneDiff): string[] {
  return diff.changes.flatMap((change) => change.props.map((prop) => `${change.name}: ${prop.label} ${prop.before} → ${prop.after}`));
}

function only(diff: SceneDiff, name: string): LayerChange {
  const found = diff.changes.filter((change) => change.name === name);
  assert.equal(found.length, 1, `one change for ${name}: ${JSON.stringify(diff.changes.map((c) => c.name))}`);
  return found[0] as LayerChange;
}

function props(change: LayerChange): Record<string, Pick<PropertyChange, 'before' | 'after'>> {
  return Object.fromEntries(change.props.map(({ label, before, after }) => [label, { before, after }]));
}

/** Diffs one layer against an edited copy of it (same id). */
function diffLayer(before: SceneNode, after: SceneNode): SceneDiff {
  return diffScenes(artboard([before]), artboard([after]));
}

describe('diffScenes', () => {
  it('reports nothing for identical scenes and lists every matched pair', () => {
    const scene = () => artboard([group([shape({ id: 's', key: 'k1' }), text({ id: 't', key: 'k2' })], { id: 'g', key: 'k0' })]);
    const diff = diffScenes(scene(), scene());
    assert.deepEqual(diff.changes, []);
    assert.deepEqual(diff.counts, { added: 0, removed: 0, changed: 0 });
    assert.deepEqual(diff.props, []);
    assert.deepEqual(diff.pairs.sort(), [['k0', 'k0'], ['k1', 'k1'], ['k2', 'k2']]);
    assert.deepEqual(diff.matched, { byId: 3, byName: 0 });
  });

  it('reports the artboard name, size and background', () => {
    const diff = diffScenes(artboard([], { name: 'Home', width: 390, background: null }), artboard([], { name: 'Top', width: 430, background: { r: 255, g: 255, b: 255, a: 1 } }));
    assert.deepEqual(diff.props, [
      { label: 'Name', before: 'Home', after: 'Top' },
      { label: 'W', before: '390', after: '430' },
      { label: 'Background', before: 'none', after: '#FFFFFF' },
    ]);
  });

  it('compares geometry, opacity, fill, border, radius and shadow of shapes as the inspector shows them', () => {
    const before = shape({ id: 's', name: 'Card', transform: at(10, 20), opacity: 1, fill: solid(255, 255, 255), stroke: null });
    const after = shape({
      id: 's',
      name: 'Card',
      transform: at(16, 20),
      opacity: 0.5,
      fill: solid(17, 24, 39),
      stroke: stroke({ color: { r: 229, g: 231, b: 235, a: 1 }, align: 'inside', dash: [4, 2] }),
      geometry: { type: 'rect', x: 0, y: 0, width: 120, height: 40, radii: [8, 8, 8, 8] },
      shadows: [{ x: 0, y: 2, blur: 8, color: { r: 0, g: 0, b: 0, a: 0.08 } }],
    });
    assert.deepEqual(props(only(diffLayer(before, after), 'Card')), {
      X: { before: '10', after: '16' },
      W: { before: '100', after: '120' },
      Opacity: { before: '100%', after: '50%' },
      Fill: { before: '#FFFFFF', after: '#111827' },
      Border: { before: 'none', after: '1 inside #E5E7EB dashed 4 2' },
      Radius: { before: '0', after: '8px' },
      Shadow: { before: 'none', after: '0 2px 8px rgba(0, 0, 0, 0.08)' },
    });
  });

  it('compares gradients by their stops and direction, not by the layer size', () => {
    const gradient = (to: string): Paint => ({
      kind: 'linear',
      x1: 0.5,
      y1: 0,
      x2: 0.5,
      y2: 1,
      stops: [
        { offset: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
        { offset: 1, color: to === 'white' ? { r: 255, g: 255, b: 255, a: 1 } : { r: 255, g: 0, b: 0, a: 1 } },
      ],
    });
    const resized = { type: 'rect' as const, x: 0, y: 0, width: 300, height: 40, radii: [0, 0, 0, 0] as [number, number, number, number] };
    assert.deepEqual(rows(diffLayer(shape({ id: 's', name: 'G', fill: gradient('white') }), shape({ id: 's', name: 'G', fill: gradient('white'), geometry: resized }))), ['G: W 100 → 300']);
    assert.deepEqual(rows(diffLayer(shape({ id: 's', name: 'G', fill: gradient('white') }), shape({ id: 's', name: 'G', fill: gradient('red') }))), [
      'G: Fill linear-gradient(180deg, #000000 0%, #FFFFFF 100%) → linear-gradient(180deg, #000000 0%, #FF0000 100%)',
    ]);
  });

  it('tells images apart by content, so a re-inserted copy of the same picture is no change', () => {
    const image = (uid: string, width = 600): Paint => ({ kind: 'image', uid, width, height: 300, fit: 'cover' });
    const keys: Record<string, string> = { old: 'aaaaaaa1', copy: 'aaaaaaa1', other: 'bbbbbbb2' };
    const imageKey = (_side: 'before' | 'after', uid: string) => keys[uid] ?? uid;
    const diff = (before: string, after: string, width?: number) => diffScenes(artboard([shape({ id: 's', name: 'Photo', fill: image(before) })]), artboard([shape({ id: 's', name: 'Photo', fill: image(after, width) })]), { imageKey });
    assert.deepEqual(rows(diff('old', 'copy')), []);
    assert.deepEqual(rows(diff('old', 'other')), ['Photo: Image 600 × 300 · aaaaaaa → 600 × 300 · bbbbbbb']);
    assert.deepEqual(rows(diff('old', 'other', 800)), ['Photo: Image 600 × 300 → 800 × 300']);
    assert.deepEqual(rows(diffLayer(shape({ id: 's', name: 'Photo', fill: solid(0, 0, 0) }), shape({ id: 's', name: 'Photo', fill: image('x') }))), [
      'Photo: Fill #000000 → Image (cover)',
      'Photo: Image none → 600 × 300',
    ]);
  });

  it('compares text content and typography', () => {
    const before = text({ id: 't', content: 'Summer Sale', name: 'Summer Sale', align: 'left', lineHeight: 20, styles: [textStyle()] });
    const after = text({
      id: 't',
      content: 'Weekend <Sale>',
      name: 'Weekend <Sale>',
      align: 'center',
      lineHeight: null,
      styles: [textStyle({ family: 'Inter', weight: 700, fontStyle: 'Bold', size: 18, letterSpacing: 20, color: { r: 37, g: 99, b: 235, a: 1 }, underline: true })],
    });
    assert.deepEqual(props(only(diffLayer(before, after), 'Weekend <Sale>')), {
      Text: { before: 'Summer Sale', after: 'Weekend <Sale>' },
      Font: { before: 'Noto Sans', after: 'Inter' },
      Weight: { before: '500 (Medium)', after: '700 (Bold)' },
      Size: { before: '16', after: '18' },
      'Line height': { before: '20', after: 'auto' },
      'Letter spacing': { before: '0', after: '20' },
      Align: { before: 'left', after: 'center' },
      Color: { before: '#333333', after: '#2563EB' },
      Decoration: { before: 'none', after: 'underline' },
      // Positioned text: its top follows the font size; the width is only estimated, so it is not compared.
      Y: { before: '-1.1', after: '-3.24' },
      H: { before: '21.79', after: '24.52' },
    });
  });

  it('reports a rename, but not the automatic name of a text layer following its content', () => {
    assert.deepEqual(rows(diffLayer(shape({ id: 's', name: 'Old' }), shape({ id: 's', name: 'New' }))), ['New: Name Old → New']);
    const label = (content: string, name = content) => text({ id: 't', name, content, frame: { type: 'area', width: 100, height: 20 } });
    assert.deepEqual(rows(diffLayer(label('One'), label('Two'))), ['Two: Text One → Two']);
    assert.deepEqual(rows(diffLayer(label('One'), label('One\nTwo', 'One Two'))), ['One Two: Text One → One\nTwo'], 'Figma names a layer with its line breaks as spaces');
  });

  it('reports a path whose outline changed, not one that only moved', () => {
    const path = (d: string, x = 0) => shape({ id: 'p', name: 'Icon', transform: at(x, 0), geometry: { type: 'path', d }, layoutSize: { width: 10, height: 10 } });
    assert.deepEqual(rows(diffLayer(path('M0 0 L10 0 L10 10 Z'), path('M5 5 L15 5 L15 15 Z'))), []);
    assert.deepEqual(rows(diffLayer(path('M0 0 L10 0 L10 10 Z'), path('M0 0 L10 0 L5 10 Z'))), ['Icon: Shape Path (4 segments) → Path (4 segments)']);
    assert.deepEqual(rows(diffLayer(path('M0 0 L10 0 L10 10 Z'), shape({ id: 'p', name: 'Icon', layoutSize: { width: 10, height: 10 } }))), [
      'Icon: Shape Path (4 segments) → Rectangle',
    ]);
  });

  it('ignores differences the inspector rounds away: under 0.01 px, and colors to the same hex and alpha', () => {
    const at10 = shape({ id: 's', name: 'A', transform: at(10, 10), fill: solid(255, 0, 0, 0.5) });
    const nudged = shape({ id: 's', name: 'A', transform: at(10.004, 9.996), fill: solid(254.6, 0.3, 0, 0.501) });
    assert.deepEqual(rows(diffLayer(at10, nudged)), []);
    assert.deepEqual(rows(diffLayer(at10, shape({ id: 's', name: 'A', transform: at(10.01, 10), fill: solid(255, 0, 0, 0.5) }))), ['A: X 10 → 10.01']);
    assert.deepEqual(rows(diffLayer(at10, shape({ id: 's', name: 'A', transform: at(10, 10), fill: solid(255, 0, 0, 0.51) }))), ['A: Fill rgba(255, 0, 0, 0.5) → rgba(255, 0, 0, 0.51)']);
    assert.deepEqual(rows(diffLayer(shape({ id: 's', name: 'A', opacity: 0.5 }), shape({ id: 's', name: 'A', opacity: 0.50004 }))), []);
  });

  it('reports a layer hidden or shown, telling it apart from a deleted one', () => {
    const scene = (children: SceneNode[], hidden?: string[]): ArtboardScene => artboard(children, hidden ? { hidden } : {});
    const badge = () => shape({ id: 'badge', name: 'Badge' });
    const hidden = diffScenes(scene([badge()]), scene([], ['badge']));
    assert.deepEqual(hidden.changes.map(({ status, name, props: p, afterKey }) => ({ status, name, props: p, afterKey })), [
      { status: 'changed', name: 'Badge', props: [{ label: 'Visible', before: 'Visible', after: 'Hidden' }], afterKey: null },
    ]);
    const shown = diffScenes(scene([], ['badge']), scene([badge()]));
    assert.deepEqual(shown.changes[0]?.props, [{ label: 'Visible', before: 'Hidden', after: 'Visible' }]);
    assert.equal(diffScenes(scene([badge()]), scene([])).changes[0]?.status, 'removed');
  });

  it('lists an added or removed group once, with its layers inside it', () => {
    const before = artboard([shape({ id: 'keep', name: 'Keep' }), group([shape({ id: 'r1' }), shape({ id: 'r2' })], { id: 'gone', name: 'Old banner', transform: at(0, 300) })]);
    const after = artboard([shape({ id: 'keep', name: 'Keep' }), group([shape({ id: 'n1' }), shape({ id: 'n2', transform: at(10, 0) })], { id: 'new', name: 'New banner', transform: at(0, 300) })]);
    const diff = diffScenes(before, after);
    assert.deepEqual(diff.changes.map((change) => `${change.status} ${change.name}`), ['added New banner', 'removed Old banner']);
    assert.deepEqual(diff.counts, { added: 1, removed: 1, changed: 0 });
    const added = only(diff, 'New banner');
    assert.equal(added.beforeKey, null);
    assert.deepEqual(added.afterBox, { x: 0, y: 300, width: 110, height: 40 });
    assert.deepEqual(only(diff, 'Old banner').beforeBox, { x: 0, y: 300, width: 100, height: 40 });
  });

  it('still compares a layer that moved into a new group', () => {
    const before = artboard([shape({ id: 's', name: 'Icon', transform: at(10, 10) })]);
    const after = artboard([group([shape({ id: 's', name: 'Icon', transform: at(10, 10) })], { id: 'wrapper', name: 'Wrapper' })]);
    assert.deepEqual(diffScenes(before, after).changes.map((change) => `${change.status} ${change.name}`), ['added Wrapper']);
    const moved = artboard([group([shape({ id: 's', name: 'Icon', transform: at(30, 10) })], { id: 'wrapper', name: 'Wrapper' })]);
    assert.deepEqual(rows(diffScenes(before, moved)), ['Icon: X 10 → 30']);
  });
});

describe('diffScenes: a group that moves is reported once', () => {
  const card = (x: number, children: [number, number][]) =>
    group(
      children.map(([cx, cy], i) => shape({ id: `c${i}`, name: `Child ${i}`, transform: at(cx, cy) })),
      { id: 'card', name: 'Card', transform: at(x, 0) },
    );

  it('marks only the group when all its layers moved with it', () => {
    assert.deepEqual(rows(diffScenes(artboard([card(0, [[0, 0], [0, 50], [20, 100]])]), artboard([card(8, [[0, 0], [0, 50], [20, 100]])]))), ['Card: X 0 → 8']);
  });

  it('marks only the layer that moved inside an unmoved group', () => {
    assert.deepEqual(rows(diffScenes(artboard([card(0, [[0, 0], [0, 50]])]), artboard([card(0, [[0, 0], [0, 54]])]))), ['Child 1: Y 50 → 54']);
  });

  it('marks every layer when they moved by different amounts, as the group did not move as a whole', () => {
    const diff = diffScenes(artboard([card(0, [[0, 0], [0, 50], [20, 100]])]), artboard([card(8, [[0, 0], [0, 50], [22, 100]])]));
    assert.deepEqual(rows(diff), ['Child 2: X 20 → 30', 'Child 1: X 0 → 8', 'Child 0: X 0 → 8']);
  });

  it('passes a move down through nested groups', () => {
    const nested = (x: number) => group([card(0, [[0, 0], [10, 10]])], { id: 'outer', name: 'Outer', transform: at(x, 0) });
    assert.deepEqual(rows(diffScenes(artboard([nested(0)]), artboard([nested(5)]))), ['Outer: X 0 → 5']);
  });

  it("uses a frame's own box: layers that stayed in place while the frame moved are not marked", () => {
    const frame = (x: number, childX: number, width = 200) =>
      group([shape({ id: 'pinned', name: 'Pinned', transform: at(childX, 0) }), shape({ id: 'rides', name: 'Rides', transform: at(10, 40) })], {
        id: 'frame',
        name: 'Frame',
        role: 'frame',
        transform: at(x, 0),
        layoutSize: { width, height: 100 },
      });
    // The frame moves 20 px right; "Pinned" is moved back so it stays where it was on the artboard.
    assert.deepEqual(rows(diffScenes(artboard([frame(0, 10)]), artboard([frame(20, -10)]))), ['Frame: X 0 → 20']);
    assert.deepEqual(rows(diffScenes(artboard([frame(0, 10)]), artboard([frame(0, 10, 240)]))), ['Frame: W 200 → 240']);
  });

  it('reports no size for a group sized by its layers', () => {
    assert.deepEqual(rows(diffScenes(artboard([card(0, [[0, 0], [0, 50]])]), artboard([card(0, [[0, 0], [0, 80]])]))), ['Child 1: Y 50 → 80']);
  });
});

describe('diffScenes caps', () => {
  const many = (count: number, color: number) => artboard(Array.from({ length: count }, (_, i) => shape({ id: `s${i}`, name: `Layer ${i}`, fill: solid(color, 0, 0) })));

  it('lists at most the capped number of changes but counts all of them', () => {
    const diff = diffScenes(many(5, 0), many(5, 255), { limits: { ...DIFF_LIMITS, changes: 2 } });
    assert.equal(diff.changes.length, 2);
    assert.equal(diff.counts.changed, 5);
    assert.equal(diff.truncated, true);
  });

  it('shortens long values and stops listing once the artboard budget is spent', () => {
    const long = (content: string) => artboard([text({ id: 't', name: 'Text', content, frame: { type: 'area', width: 100, height: 20 } })]);
    const diff = diffScenes(long('a'.repeat(1000)), long('b'.repeat(1000)), { limits: { ...DIFF_LIMITS, valueLength: 50 } });
    const value = diff.changes[0]?.props[0];
    assert.equal(value?.before.length, 50);
    assert.ok(value?.before.endsWith('…'));
    const budget = diffScenes(many(10, 0), many(10, 255), { limits: { ...DIFF_LIMITS, artboardChars: 60 } });
    assert.ok(budget.changes.length < 10 && budget.changes.length > 0, `${budget.changes.length} listed`);
    assert.equal(budget.truncated, true);
    assert.equal(budget.counts.changed, 10);
  });

  it('does not split a surrogate pair when shortening', () => {
    const emoji = '😀'.repeat(40);
    const diff = diffScenes(artboard([shape({ id: 's', name: emoji })]), artboard([shape({ id: 's', name: `${emoji}!` })]), { limits: { ...DIFF_LIMITS, valueLength: 9 } });
    const name = diff.changes[0]?.props[0]?.before ?? '';
    assert.ok(!/[\ud800-\udbff]…$/.test(name), name);
  });
});
