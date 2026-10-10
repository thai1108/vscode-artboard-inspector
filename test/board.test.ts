import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FigDocument } from '../src/fig/parse.ts';
import { MESSAGE_LIMITS, parseWebviewMessage } from '../src/protocol.ts';
import { buildPages, DETAIL_MIN_SCREEN_PX, offsetBox, overlaps, planDetail, showsDetail, visibleRect, type BoardItem } from '../src/render/board.ts';
import type { ArtboardSummary } from '../src/scene/scene.ts';
import { at, buildFig, node, solid } from './support/figFixture.ts';
import { buildXd } from './support/xdFixture.ts';

const summary = (id: string, width = 100, height = 200): ArtboardSummary => ({ id, name: `Artboard ${id}`, width, height });
const item = (id: string, x: number, y: number, width = 100, height = 100): BoardItem => ({ id, title: id, x, y, width, height });

describe('board layout from design files', () => {
  it('places XD artboards at their manifest positions on one canvas', () => {
    const doc = buildXd({
      artboards: [
        { id: 'artboard-a', name: 'Home', bounds: { x: 1000, y: 0, width: 430, height: 900 }, children: [] },
        { id: 'artboard-b', name: 'Cart', bounds: { x: 1530, y: 120, width: 430, height: 700 }, children: [] },
      ],
    });
    assert.deepEqual(doc.board, {
      pages: ['Canvas'],
      placements: [
        { id: 'artboard-a', page: 0, x: 1000, y: 0, title: 'Home' },
        { id: 'artboard-b', page: 0, x: 1530, y: 120, title: 'Cart' },
      ],
    });
  });

  it('gives each Figma page its own board, with section offsets and titles without the page name', () => {
    const doc = FigDocument.open(
      buildFig([
        { guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT', name: 'Document' },
        { guid: { sessionID: 1, localID: 1 }, parentIndex: { guid: { sessionID: 0, localID: 0 }, position: 'a' }, type: 'CANVAS', name: 'Design', visible: true },
        { guid: { sessionID: 1, localID: 2 }, parentIndex: { guid: { sessionID: 0, localID: 0 }, position: 'b' }, type: 'CANVAS', name: '', visible: true },
        node(10, 1, 'FRAME', { name: 'Home', size: { x: 390, y: 800 }, transform: at(-50, 20), fillPaints: [solid(1, 1, 1)] }),
        node(11, 1, 'SECTION', { name: 'Flows', size: { x: 2000, y: 1000 }, transform: at(1000, 500) }, 'b'),
        node(12, 11, 'FRAME', { name: 'Login', size: { x: 390, y: 800 }, transform: at(100, 40), fillPaints: [solid(1, 1, 1)] }),
        node(20, 2, 'FRAME', { name: 'Icons', size: { x: 100, y: 100 }, transform: at(0, 0) }),
      ]),
    );
    assert.deepEqual(doc.board.pages, ['Design', 'Page 2']);
    assert.deepEqual(
      doc.board.placements.map(({ id, page, x, y, title }) => [id, page, x, y, title]),
      [
        ['1:10', 0, -50, 20, 'Home'],
        ['1:12', 0, 1100, 540, 'Flows / Login'],
        ['1:20', 1, 0, 0, 'Icons'],
      ],
    );
  });
});

describe('buildPages', () => {
  it('shifts every page so its top-left artboard corner is the origin and keeps sizes from the summaries', () => {
    const pages = buildPages([summary('a'), summary('b', 50, 50), summary('c')], {
      pages: ['One', 'Two'],
      placements: [
        { id: 'a', page: 0, x: -100, y: 40, title: 'A' },
        { id: 'b', page: 0, x: 300, y: -10, title: '' },
        { id: 'c', page: 1, x: 5, y: 5, title: 'C' },
      ],
    });
    assert.deepEqual(
      pages.map((page) => [page.name, page.originX, page.originY, page.width, page.height]),
      [
        ['One', -100, -10, 450, 250],
        ['Two', 5, 5, 100, 200],
      ],
    );
    assert.deepEqual(pages[0]?.items, [
      { id: 'a', title: 'A', x: 0, y: 50, width: 100, height: 200 },
      { id: 'b', title: 'Artboard b', x: 400, y: 0, width: 50, height: 50 },
    ]);
  });

  it('puts artboards without a usable position in a row under the first page and drops empty pages', () => {
    const pages = buildPages([summary('a'), summary('lost', 80, 80), summary('nan')], {
      pages: ['One', 'Empty'],
      placements: [
        { id: 'a', page: 0, x: 0, y: 0, title: 'A' },
        { id: 'nan', page: 0, x: Number.NaN, y: 0, title: 'N' },
      ],
    });
    assert.equal(pages.length, 1);
    assert.deepEqual(
      pages[0]?.items.map(({ id, x, y }) => [id, x, y]),
      [
        ['a', 0, 0],
        ['lost', 0, 300],
        ['nan', 180, 300],
      ],
    );
  });

  it('falls back to one canvas when the layout has no pages', () => {
    const pages = buildPages([summary('a')], { pages: [], placements: [] });
    assert.deepEqual(pages.map((page) => page.name), ['Canvas']);
  });
});

describe('viewport culling and level of detail', () => {
  it('converts the stage to a board rectangle, optionally grown by a margin', () => {
    assert.deepEqual(visibleRect({ x: -200, y: 100, zoom: 0.5 }, 800, 600), { x: 400, y: -200, width: 1600, height: 1200 });
    assert.deepEqual(visibleRect({ x: 0, y: 0, zoom: 1 }, 100, 100, 0.5), { x: -50, y: -50, width: 200, height: 200 });
  });

  it('detects overlap including touching edges', () => {
    assert.ok(overlaps(item('a', 0, 0), { x: 100, y: 100, width: 10, height: 10 }));
    assert.ok(!overlaps(item('a', 0, 0), { x: 101, y: 0, width: 10, height: 10 }));
  });

  it('draws in full only artboards large enough on screen', () => {
    const board = item('a', 0, 0, 400, 800);
    assert.ok(showsDetail(board, DETAIL_MIN_SCREEN_PX / 800));
    assert.ok(!showsDetail(board, DETAIL_MIN_SCREEN_PX / 800 - 0.01));
  });

  it('draws small artboards in full once zoomed to 100% or more (fly-to an icon frame)', () => {
    const icon = item('icon', 0, 0, 54, 54);
    assert.ok(!showsDetail(icon, 0.99));
    assert.ok(showsDetail(icon, 1));
    assert.ok(showsDetail(icon, 4));
    assert.deepEqual(planDetail([icon, item('off', 5000, 5000, 54, 54)], { x: 0, y: 0, width: 1000, height: 800 }, 1), ['icon']);
  });

  it('plans full rendering for visible, big-enough artboards nearest the centre first, capped', () => {
    // Below 100% zoom the on-screen size decides (200 × 0.9 = 180px is enough, 10 × 0.9 is not).
    const big = (id: string, x: number, y: number) => item(id, x, y, 200, 200);
    const items = [big('far', 900, 0), big('centre', 400, 400), big('near', 250, 250), big('off', 5000, 5000), item('tiny', 460, 460, 10, 10)];
    const area = { x: 0, y: 0, width: 1000, height: 1000 };
    assert.deepEqual(planDetail(items, area, 0.9), ['centre', 'near', 'far']);
    assert.deepEqual(planDetail(items, area, 0.9, 2), ['centre', 'near']);
    assert.deepEqual(planDetail(items, area, 0.1), []);
  });

  it('offsets artboard-local boxes into board coordinates', () => {
    assert.deepEqual(offsetBox({ x: 4, y: 5, width: 6, height: 7 }, 100, 200), { x: 104, y: 205, width: 6, height: 7 });
  });
});

describe('loadArtboards message validation', () => {
  it('accepts a batch of ids with known images', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'loadArtboards', ids: ['a', 'b'], knownImages: ['u'] }), { type: 'loadArtboards', ids: ['a', 'b'], knownImages: ['u'] });
  });

  it('rejects empty, oversized or malformed batches', () => {
    const ids = Array.from({ length: MESSAGE_LIMITS.batchIds + 1 }, (_, i) => `id${i}`);
    for (const message of [
      { type: 'loadArtboards', ids: [], knownImages: [] },
      { type: 'loadArtboards', ids, knownImages: [] },
      { type: 'loadArtboards', ids: ['x'.repeat(MESSAGE_LIMITS.idLength + 1)], knownImages: [] },
      { type: 'loadArtboards', ids: [1], knownImages: [] },
      { type: 'loadArtboards', ids: ['a'], knownImages: 'u' },
      { type: 'loadArtboards', ids: 'a', knownImages: [] },
    ]) {
      assert.equal(parseWebviewMessage(message), null, JSON.stringify(message).slice(0, 60));
    }
  });
});
