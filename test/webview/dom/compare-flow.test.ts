import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type * as vscode from 'vscode';
import { CompareSession, type DesignSource } from '../../../src/compareSession.ts';
import type { DesignDocument } from '../../../src/document.ts';
import type { HostMessage, WebviewMessage } from '../../../src/protocol.ts';
import { buildSearchIndex } from '../../../src/search.ts';
import type { AgcNode } from '../../../src/xd/agc.ts';
import { buildXd, rgb } from '../../support/xdFixture.ts';
import { bootWebview, type FakeHost } from './env.ts';

const rect = (id: string, name: string, x: number, y: number): AgcNode => ({
  type: 'shape',
  id,
  name,
  transform: { tx: x, ty: y },
  shape: { type: 'rect', width: 100, height: 40 },
  style: { fill: { type: 'solid', color: rgb(255, 255, 255) } },
});
const title = (content: string): AgcNode => ({
  type: 'text',
  id: 'title',
  name: 'Title',
  transform: { tx: 16, ty: 20 },
  style: { font: { family: 'Noto Sans', style: 'Bold', size: 20 }, fill: { type: 'solid', color: rgb(0, 0, 0) } },
  text: { rawText: content, frame: { type: 'area', width: 300, height: 30 }, paragraphs: [{ lines: [[{ from: 0, to: content.length, x: 0, y: 20 }]] }] },
});
const card = (x: number): AgcNode => ({ type: 'group', id: 'card', name: 'Card', transform: { tx: x, ty: 100 }, group: { children: [rect('card-bg', 'Card background', 0, 0), rect('card-photo', 'Photo', 0, 50)] } });
const about = (x: number) => ({ id: 'artboard-about', name: 'About', bounds: { x, y: 0, width: 400, height: 600 }, children: [rect('logo', 'Logo', 10, 10)] });

const earlier = buildXd({
  artboards: [
    { id: 'artboard-home', name: 'Home', bounds: { x: 0, y: 0, width: 400, height: 600 }, children: [title('Old <title>'), card(10), rect('badge', 'Badge', 300, 10)] },
    about(500),
    { id: 'artboard-faq', name: 'FAQ', bounds: { x: 1000, y: 0, width: 400, height: 600 }, children: [] },
  ],
});
const current = buildXd({
  artboards: [
    { id: 'artboard-home', name: 'Home', bounds: { x: 0, y: 0, width: 400, height: 600 }, children: [title('New <title>'), card(30), rect('ribbon', 'Ribbon', 0, 500)] },
    about(500),
  ],
});

const uri = (path: string) => ({ path, fsPath: path, scheme: 'file' }) as unknown as vscode.Uri;
const source = (name: string, design: DesignDocument): DesignSource => ({ name, design, searchIndex: () => buildSearchIndex(design) });

describe('comparing versions in the webview (happy-dom)', () => {
  let host: FakeHost;
  let session: CompareSession;
  /** Answers the webview's artboard requests the way the extension host does. */
  let answered = 0;

  const label = (selector: string) => host.$$(selector).map((element) => element.textContent?.trim());
  const answerArtboards = async (count = 1) => {
    await host.until(() => host.posted.filter((message) => message.type === 'loadArtboard').length >= answered + count, 'loadArtboard');
    const requests = host.posted.filter((message): message is Extract<WebviewMessage, { type: 'loadArtboard' }> => message.type === 'loadArtboard').slice(answered);
    answered += requests.length;
    for (const request of requests) {
      host.deliver(session.artboard(request.id, new Set(request.knownImages), request.side));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  };

  before(async () => {
    host = await bootWebview();
    session = new CompareSession(
      () => source('shop.xd', current),
      {
        pickFile: async () => uri('/work/shop-v1.xd'),
        readDesign: async () => earlier,
        withProgress: (_title, task) => task(),
        showErrorMessage: (message) => assert.fail(message),
      },
      (message: HostMessage) => host.deliver(message),
    );
    session.ready();
    await answerArtboards();
    await host.until(() => host.$('#artboard-title').textContent === 'Home 400 × 600', 'home');
  });
  after(() => host.close());

  it('offers Compare… in the toolbar and asks the host for the other file', () => {
    assert.equal(host.$('#compare-start').hidden, false);
    assert.equal(host.$('#compare-bar').hidden, true);
    host.click(host.$('#compare-start'));
    assert.deepEqual(host.last('pickCompare'), { type: 'pickCompare' });
  });

  it('shows the compare bar and badges every artboard, removed ones after the current ones', async () => {
    await session.pick();
    await answerArtboards();
    assert.equal(host.$('#compare-bar').hidden, false);
    assert.equal(host.$('#compare-start').hidden, true);
    assert.deepEqual(label('#compare-files .compare-file'), ['shop-v1.xd', 'shop.xd']);
    assert.equal(host.$('#compare-summary').textContent, 'Artboards: 1 changed · 0 added · 1 removed · 1 unchanged');
    assert.deepEqual(label('#artboards .artboard-item'), ['Home4400×600', 'About400×600', 'FAQRemoved400×600']);
    assert.equal(host.$('#artboards .artboard-item .diff-badge').getAttribute('title'), '2 changed, 1 added, 1 removed layers');
    assert.ok(host.$('#artboards .artboard-item[data-id="artboard-faq"]').classList.contains('removed'));
    assert.equal(host.$('#version-tag').textContent, 'After');
  });

  it('filters the list to changed artboards', () => {
    host.$<HTMLInputElement>('#compare-changed-only').checked = true;
    host.$('#compare-changed-only').dispatchEvent(new host.window.Event('change', { bubbles: true }) as unknown as Event);
    assert.deepEqual(label('#artboards .artboard-item .artboard-name'), ['Home', 'FAQ']);
    host.$<HTMLInputElement>('#compare-changed-only').checked = false;
    host.$('#compare-changed-only').dispatchEvent(new host.window.Event('change', { bubbles: true }) as unknown as Event);
    assert.equal(host.$$('#artboards .artboard-item').length, 3);
  });

  it('outlines added and changed layers and ghosts the removed one; colours them in the layer tree', () => {
    const marks = host.$$('#overlay .ov-diff').map((mark) => mark.getAttribute('class'));
    assert.deepEqual(marks.sort(), ['ov-diff ov-diff-added', 'ov-diff ov-diff-changed', 'ov-diff ov-diff-changed', 'ov-diff ov-diff-removed ov-diff-ghost']);
    const rows = Object.fromEntries(host.$$('#layers .layer-row').map((row) => [row.querySelector('.layer-name')?.textContent, row.getAttribute('class')]));
    assert.match(rows['Ribbon'] ?? '', /diff-added/);
    assert.match(rows['Card'] ?? '', /diff-changed/);
    assert.doesNotMatch(rows['Card background'] ?? '', /diff-/, 'moved with its group');
  });

  it('lists the changes in the artboard inspector and selects a layer from there', () => {
    assert.deepEqual(label('#inspector .change-layer .change-name'), ['Ribbon', 'Card', 'Title', 'Badge']);
    const titleRow = host.$$('#inspector .change-layer').find((row) => row.textContent?.includes('Title'));
    assert.ok(titleRow);
    host.click(titleRow);
    assert.equal(host.$('.insp-title').textContent, 'Title');
    assert.deepEqual(label('#inspector .change-row .change-label'), ['Text']);
    assert.deepEqual(label('#inspector .change-row .change-before'), ['Old <title>']);
    assert.deepEqual(label('#inspector .change-row .change-after'), ['New <title>']);
    assert.equal(host.$$('#inspector .change-row b, #inspector .change-row title').length, 0, 'values are text, not markup');
  });

  it('switches to the earlier version with ` and keeps the same layer selected', async () => {
    host.key('`');
    const request = host.last('loadArtboard');
    assert.deepEqual(request, { type: 'loadArtboard', id: 'artboard-home', knownImages: [], side: 'before' });
    await answerArtboards();
    await host.until(() => host.$('#version-tag').textContent === 'Before', 'before tag');
    assert.ok(host.$('#compare-before').classList.contains('active'));
    assert.match(host.$('#canvas').textContent ?? '', /Old <title>/);
    assert.equal(host.$('.insp-title').textContent, 'Title');
    const marks = host.$$('#overlay .ov-diff').map((mark) => mark.getAttribute('class'));
    assert.ok(marks.includes('ov-diff ov-diff-removed'), 'the removed layer is drawn here');
    assert.ok(marks.includes('ov-diff ov-diff-added ov-diff-ghost'), 'the added one is a ghost');
  });

  it('goes back to the current version without asking the host again', async () => {
    const before = host.posted.length;
    host.click(host.$('#compare-after'));
    await host.until(() => host.$('#version-tag').textContent === 'After', 'after tag');
    assert.equal(host.posted.length, before);
    assert.match(host.$('#canvas').textContent ?? '', /New <title>/);
    assert.equal(host.$('.insp-title').textContent, 'Title', 'the selection follows');
  });

  it('opens a removed artboard as the earlier version, with After unavailable', async () => {
    host.click(host.$('#artboards .artboard-item[data-id="artboard-faq"]'));
    assert.deepEqual(host.last('loadArtboard'), { type: 'loadArtboard', id: 'artboard-faq', knownImages: [], side: 'before' });
    await answerArtboards();
    await host.until(() => host.$('#artboard-title').textContent === 'FAQ 400 × 600', 'faq');
    assert.equal(host.$<HTMLButtonElement>('#compare-after').disabled, true);
    assert.ok(host.$('#artboards .artboard-item[data-id="artboard-faq"]').classList.contains('active'));
    assert.match(host.$('#inspector').textContent ?? '', /only in the earlier version/);
  });

  it('swaps the versions: the other file is shown and the removed artboard becomes new', async () => {
    host.click(host.$('#artboards .artboard-item[data-id="artboard-home"]'));
    await answerArtboards();
    host.click(host.$('#compare-swap'));
    assert.deepEqual(host.last('swapCompare'), { type: 'swapCompare' });
    session.swap();
    await answerArtboards();
    await host.until(() => host.$('#canvas').textContent?.includes('Old <title>') === true, 'other file shown');
    assert.deepEqual(label('#compare-files .compare-file'), ['shop.xd', 'shop-v1.xd']);
    assert.deepEqual(label('#artboards .artboard-item .artboard-name'), ['Home', 'About', 'FAQ']);
    assert.match(host.$('#artboards .artboard-item[data-id="artboard-faq"]').textContent ?? '', /New/);
    assert.equal(host.$('#version-tag').textContent, 'After');
  });

  it('badges artboard titles on the board', async () => {
    host.click(host.$('#mode-board'));
    await host.until(() => host.last('loadArtboards') !== undefined, 'loadArtboards');
    const request = host.last('loadArtboards');
    host.deliver(session.scenes(request?.ids ?? [], new Set(request?.knownImages)));
    await host.until(() => host.$$('#board-titles .dv-board-title').length === 3, 'board titles');
    assert.deepEqual(label('#board-titles .dv-board-title'), ['Home4', 'About', 'FAQNew']);
    assert.equal(host.$<HTMLButtonElement>('#compare-before').disabled, true, 'no Before view on the board');
    host.key('b');
    await host.until(() => !host.$('#app').classList.contains('board-mode') && host.$$('#canvas svg.dv-artboard').length === 1, 'single view');
    assert.equal(host.$$('#overlay .ov-diff').length, 4, 'the diff is still at hand');
  });

  it('exits compare mode back to the opened file', async () => {
    host.click(host.$('#compare-exit'));
    assert.deepEqual(host.last('exitCompare'), { type: 'exitCompare' });
    session.exit();
    await answerArtboards();
    await host.until(() => host.$('#canvas').textContent?.includes('New <title>') === true, 'opened file shown');
    assert.equal(host.$('#compare-bar').hidden, true);
    assert.equal(host.$('#compare-start').hidden, false);
    assert.equal(host.$('#compare-filter').hidden, true);
    assert.equal(host.$('#version-tag').hidden, true);
    assert.equal(host.$$('#artboards .diff-badge').length, 0);
    assert.equal(host.$$('#overlay .ov-diff').length, 0);
    assert.deepEqual(label('#artboards .artboard-item .artboard-name'), ['Home', 'About']);
  });
});
