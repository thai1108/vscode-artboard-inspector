import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ArtboardDiff, ArtboardDiffSummary, CompareSummary } from '../../src/compare/compare.ts';
import type { LayerChange } from '../../src/compare/diff.ts';
import { artboardBadge, artboardChangesSection, changeOf, Comparison, counterpartKey, diffMarks, layerChangesSection, layerStatuses, summaryText } from '../../src/webview/compare.ts';

const entry = (overrides: Partial<ArtboardDiffSummary> = {}): ArtboardDiffSummary => ({
  beforeId: 'a',
  afterId: 'a',
  name: 'Home',
  width: 390,
  height: 800,
  status: 'changed',
  matchedBy: 'id',
  counts: { added: 1, removed: 1, changed: 2 },
  ...overrides,
});

const summary = (artboards: ArtboardDiffSummary[]): CompareSummary => ({
  beforeName: 'v1 <old>.xd',
  afterName: 'v2.xd',
  swapped: false,
  generation: 1,
  artboards,
  truncated: false,
  matched: { byId: 10, byName: 2 },
});

const box = (x: number) => ({ x, y: 0, width: 10, height: 10 });
const changes: LayerChange[] = [
  { status: 'changed', beforeKey: 'b1', afterKey: 'a1', name: 'Title <h1>', beforeBox: box(0), afterBox: box(5), props: [{ label: 'Text', before: 'Old & <b>', after: 'New' }] },
  { status: 'added', beforeKey: null, afterKey: 'a2', name: 'Ribbon', beforeBox: null, afterBox: box(20), props: [] },
  { status: 'removed', beforeKey: 'b3', afterKey: null, name: 'Badge', beforeBox: box(40), afterBox: null, props: [] },
];
const diff: ArtboardDiff = {
  ...entry(),
  beforeIndex: 0,
  afterIndex: 0,
  props: [{ label: 'H', before: '800', after: '900' }],
  changes,
  truncated: false,
  pairs: [
    ['b1', 'a1'],
    ['b9', 'a9'],
  ],
  matched: { byId: 2, byName: 0 },
};

describe('compare view helpers', () => {
  it('outlines changes where they are drawn and ghosts the rest where they were', () => {
    const measured = new Map([['a1', box(6)]]);
    assert.deepEqual(diffMarks(diff, 'after', measured), [
      { box: box(6), status: 'changed', ghost: false },
      { box: box(20), status: 'added', ghost: false },
      { box: box(40), status: 'removed', ghost: true },
    ]);
    assert.deepEqual(
      diffMarks(diff, 'before', new Map()).map((mark) => [mark.box.x, mark.status, mark.ghost]),
      [
        [0, 'changed', false],
        [20, 'added', true],
        [40, 'removed', false],
      ],
    );
    assert.deepEqual(diffMarks(undefined, 'after', measured), []);
  });

  it('finds a layer’s change and its key in the other version', () => {
    assert.equal(changeOf(diff, 'after', 'a1')?.name, 'Title <h1>');
    assert.equal(changeOf(diff, 'before', 'b3')?.status, 'removed');
    assert.equal(changeOf(diff, 'after', 'a9'), undefined);
    assert.equal(counterpartKey(diff, 'after', 'a9'), 'b9');
    assert.equal(counterpartKey(diff, 'before', 'b1'), 'a1');
    assert.equal(counterpartKey(diff, 'after', 'a2'), null);
    assert.deepEqual([...layerStatuses(diff, 'before')], [['b1', 'changed'], ['b3', 'removed']]);
  });

  it('badges artboards by status, escaping what came from the file', () => {
    assert.match(artboardBadge(entry()), /class="diff-badge diff-changed" title="2 changed, 1 added, 1 removed layers">4</);
    assert.match(artboardBadge(entry({ status: 'added' })), />New</);
    assert.match(artboardBadge(entry({ status: 'removed' })), />Removed</);
    assert.match(artboardBadge(entry({ status: 'skipped', note: 'Not compared: "<x>"' })), /title="Not compared: &quot;&lt;x&gt;&quot;"/);
    assert.equal(artboardBadge(entry({ status: 'unchanged' })), '');
    assert.equal(artboardBadge(undefined), '');
  });

  it('writes the Changes rows of a layer with every value escaped', () => {
    const html = layerChangesSection(changes[0], summary([entry()]));
    assert.match(html, /<h3>Changes<\/h3>/);
    assert.match(html, /<div class="change-status diff-changed">Changed<\/div>/);
    assert.match(html, /<span class="change-before" title="Old &amp; &lt;b&gt;">Old &amp; &lt;b&gt;<\/span><span class="change-arrow">→<\/span><span class="change-after" title="New">New<\/span>/);
    assert.doesNotMatch(html, /<b>/);
    assert.match(layerChangesSection(changes[1], summary([])), /Added <span class="dim">— not in v1 &lt;old&gt;\.xd/);
    assert.match(layerChangesSection(undefined, summary([])), />Unchanged</);
    const long = layerChangesSection({ ...changes[0], props: [{ label: 'Text', before: 'a'.repeat(30), after: 'b' }] } as LayerChange, summary([]));
    assert.match(long, /class="change-row stacked"/);
  });

  it('lists the changed layers of an artboard, marking those only in the other version', () => {
    const html = artboardChangesSection(entry(), diff, 'after');
    assert.match(html, /2 changed, 1 added, 1 removed layers/);
    assert.match(html, /<span class="change-label">H<\/span>/);
    assert.equal(html.match(/data-change="\d"/g)?.length, 3);
    assert.match(html, /class="change-layer diff-removed elsewhere" data-change="2"/);
    assert.match(html, /Title &lt;h1&gt;/);
    assert.match(artboardChangesSection(entry({ counts: { added: 0, removed: 0, changed: 250 } }), diff, 'after'), /247 more not listed/);
    assert.match(artboardChangesSection(entry({ status: 'unchanged' }), undefined, 'after'), />Unchanged</);
    assert.match(artboardChangesSection(entry(), undefined, 'after'), />Loading…</);
    assert.match(artboardChangesSection(entry({ status: 'removed', afterId: null }), undefined, 'before'), /only in the earlier version/);
    assert.equal(artboardChangesSection(undefined, undefined, 'after'), '');
  });

  it('summarizes artboard statuses', () => {
    const text = summaryText(summary([entry(), entry({ status: 'added' }), entry({ status: 'unchanged' }), entry({ status: 'skipped' })]));
    assert.equal(text, 'Artboards: 1 changed · 1 added · 0 removed · 1 unchanged · 1 not compared');
  });

  it('keeps the diffs of one comparison, found by either version’s artboard id', () => {
    const removed = entry({ beforeId: 'gone', afterId: null, status: 'removed', name: 'Old' });
    const comparison = new Comparison(summary([entry({ beforeId: 'old-a', afterId: 'a' }), removed]));
    assert.equal(comparison.entry('a', 'after')?.beforeId, 'old-a');
    assert.equal(comparison.entry('old-a', 'before')?.afterId, 'a');
    assert.equal(comparison.entry('old-a', 'after'), undefined);
    assert.deepEqual(comparison.removed, [removed]);
    comparison.addDiff({ ...diff, beforeId: 'old-a', afterId: 'a' });
    assert.equal(comparison.diff(comparison.entry('old-a', 'before'))?.changes.length, 3);
    assert.ok(comparison.sameAs(summary([])));
    assert.ok(!comparison.sameAs({ ...summary([]), swapped: true }));
    assert.ok(!comparison.sameAs({ ...summary([]), generation: 2 }));
  });
});
