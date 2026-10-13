import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { artboardDiffOf, compareDocuments, COMPARE_LIMITS, orientDiff, summarize, type ArtboardDiff, type DocumentDiff } from '../src/compare/compare.ts';
import type { DesignDocument } from '../src/document.ts';
import type { AgcNode } from '../src/xd/agc.ts';
import { buildXd, rgb } from './support/xdFixture.ts';

const rect = (id: string, name: string, x: number, color = rgb(255, 255, 255)): AgcNode => ({
  type: 'shape',
  id,
  name,
  transform: { tx: x, ty: 0 },
  shape: { type: 'rect', width: 50, height: 20 },
  style: { fill: { type: 'solid', color } },
});

const bounds = (x: number) => ({ x, y: 0, width: 300, height: 600 });

function designs() {
  const before = buildXd({
    artboards: [
      { id: 'artboard-home', name: 'Home', bounds: bounds(0), children: [rect('a', 'Button', 10), rect('gone', 'Old badge', 100)] },
      { id: 'artboard-old-cart', name: 'Cart', bounds: bounds(400), children: [rect('c', 'Total', 10)] },
      { id: 'artboard-same', name: 'About', bounds: bounds(800), children: [rect('d', 'Logo', 10)] },
      { id: 'artboard-removed', name: 'Wishlist', bounds: bounds(1200), children: [] },
    ],
  });
  const after = buildXd({
    artboards: [
      { id: 'artboard-home', name: 'Home', bounds: bounds(0), children: [rect('a', 'Button', 30, rgb(37, 99, 235)), rect('new', 'New badge', 100)] },
      { id: 'artboard-new-cart', name: 'Cart', bounds: bounds(400), children: [rect('c2', 'Total', 10)] },
      { id: 'artboard-same', name: 'About', bounds: bounds(800), children: [rect('d', 'Logo', 10)] },
      { id: 'artboard-added', name: 'Checkout', bounds: bounds(1200), children: [] },
    ],
  });
  return { before, after };
}

function brief(diff: DocumentDiff) {
  return diff.artboards.map(({ beforeId, afterId, status, matchedBy, counts }) => ({ beforeId, afterId, status, matchedBy, counts }));
}

/** Changes as a sorted list, independent of the order they were found in. */
function changeSet(diff: ArtboardDiff | undefined): string[] {
  return (diff?.changes ?? []).map((change) => `${change.status} ${change.name} ${JSON.stringify(change.props)} ${change.beforeKey}/${change.afterKey}`).sort();
}

describe('compareDocuments', () => {
  it('pairs artboards by id, then by name, and diffs each pair', async () => {
    const { before, after } = designs();
    const diff = await compareDocuments(before, after);
    assert.deepEqual(brief(diff), [
      { beforeId: 'artboard-home', afterId: 'artboard-home', status: 'changed', matchedBy: 'id', counts: { added: 1, removed: 1, changed: 1 } },
      { beforeId: 'artboard-old-cart', afterId: 'artboard-new-cart', status: 'unchanged', matchedBy: 'name', counts: { added: 0, removed: 0, changed: 0 } },
      { beforeId: 'artboard-same', afterId: 'artboard-same', status: 'unchanged', matchedBy: 'id', counts: { added: 0, removed: 0, changed: 0 } },
      { beforeId: null, afterId: 'artboard-added', status: 'added', matchedBy: null, counts: { added: 0, removed: 0, changed: 0 } },
      { beforeId: 'artboard-removed', afterId: null, status: 'removed', matchedBy: null, counts: { added: 0, removed: 0, changed: 0 } },
    ]);
    assert.deepEqual(diff.matched, { byId: 2, byName: 1 });
    assert.equal(diff.truncated, false);
    assert.deepEqual(diff.artboards[0]?.changes.find((change) => change.status === 'changed')?.props, [
      { label: 'X', before: '10', after: '30' },
      { label: 'Fill', before: '#FFFFFF', after: '#2563EB' },
    ]);
  });

  it('leaves artboards out once the layer cap is reached, and reports artboards that fail to convert', async () => {
    const { before, after } = designs();
    const capped = await compareDocuments(before, after, { compareLimits: { ...COMPARE_LIMITS, layers: 2 } });
    assert.deepEqual(
      capped.artboards.map((artboard) => artboard.status),
      ['changed', 'skipped', 'skipped', 'added', 'removed'],
    );
    assert.equal(capped.truncated, true);
    assert.match(capped.artboards[1]?.note ?? '', /more than 2 layers/);

    const broken: Pick<DesignDocument, 'artboards' | 'scene'> = {
      artboards: after.artboards,
      scene: (id) => {
        if (id === 'artboard-same') {
          throw new Error('Artboard graphics missing: About');
        }
        return after.scene(id);
      },
    };
    const failed = await compareDocuments(before, broken);
    assert.equal(failed.artboards[2]?.status, 'skipped');
    assert.equal(failed.artboards[2]?.note, 'Not compared: Artboard graphics missing: About');
  });

  it('caps the changes listed and the characters kept over the whole file, still counting every change', async () => {
    const screens = (color: number) =>
      buildXd({
        artboards: Array.from({ length: 4 }, (_, i) => ({
          id: `artboard-${i}`,
          name: `Screen ${i}`,
          bounds: bounds(i * 400),
          children: Array.from({ length: 3 }, (_, k) => rect(`r${k}`, `Layer ${k}`, 10, rgb(color, 0, 0))),
        })),
      });
    const listed = await compareDocuments(screens(0), screens(255), { compareLimits: { ...COMPARE_LIMITS, changes: 5 } });
    assert.deepEqual(listed.artboards.map((artboard) => artboard.changes.length), [3, 2, 0, 0]);
    assert.deepEqual(listed.artboards.map((artboard) => artboard.counts.changed), [3, 3, 3, 3]);
    assert.deepEqual(listed.artboards.map((artboard) => artboard.truncated), [false, true, true, true]);
    const kept = await compareDocuments(screens(0), screens(255), { compareLimits: { ...COMPARE_LIMITS, chars: 60 } });
    const chars = kept.artboards.flatMap((artboard) => artboard.changes).reduce((sum, change) => sum + change.name.length + change.props.reduce((n, p) => n + p.before.length + p.after.length, 0), 0);
    assert.ok(chars <= 60, `${chars} characters kept`);
    assert.equal(kept.artboards.at(-1)?.changes.length, 0);
  });

  it('reads the same the other way round once oriented', async () => {
    const { before, after } = designs();
    const forward = await compareDocuments(before, after);
    const backward = orientDiff(await compareDocuments(after, before), true);
    assert.deepEqual(brief(backward), brief(forward));
    for (const [i, artboard] of forward.artboards.entries()) {
      assert.deepEqual(changeSet(backward.artboards[i]), changeSet(artboard), artboard.name);
      assert.deepEqual(backward.artboards[i]?.props, artboard.props);
      assert.deepEqual(new Set(backward.artboards[i]?.pairs.map((pair) => pair.join())), new Set(artboard.pairs.map((pair) => pair.join())));
    }
    assert.equal(orientDiff(forward, false), forward);
  });

  it('summarizes without layer details and finds an artboard by either version id', async () => {
    const { before, after } = designs();
    const diff = await compareDocuments(before, after);
    const summary = summarize(diff, { before: 'v1.xd', after: 'v2.xd' }, false, 7);
    assert.equal(summary.beforeName, 'v1.xd');
    assert.equal(summary.generation, 7);
    assert.deepEqual(summary.artboards[1], {
      beforeId: 'artboard-old-cart',
      afterId: 'artboard-new-cart',
      name: 'Cart',
      width: 300,
      height: 600,
      status: 'unchanged',
      matchedBy: 'name',
      counts: { added: 0, removed: 0, changed: 0 },
    });
    assert.ok(!('changes' in (summary.artboards[0] ?? {})));
    assert.equal(artboardDiffOf(diff, 'artboard-old-cart', 'before')?.afterId, 'artboard-new-cart');
    assert.equal(artboardDiffOf(diff, 'artboard-old-cart', 'after'), undefined);
    const swapped = orientDiff(diff, true);
    assert.equal(artboardDiffOf(swapped, 'artboard-removed', 'after')?.status, 'added');
    assert.deepEqual(
      swapped.artboards.map((artboard) => artboard.afterId),
      ['artboard-home', 'artboard-old-cart', 'artboard-same', 'artboard-removed', null],
      'in the order of the file shown as the later version',
    );
  });
});
