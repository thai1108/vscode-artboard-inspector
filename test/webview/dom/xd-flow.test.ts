import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { artboardMessage, scenesMessage } from '../../../src/payload.ts';
import type { AgcNode } from '../../../src/xd/agc.ts';
import { buildXd, PNG_BYTES, rgb } from '../../support/xdFixture.ts';
import { bootWebview, type FakeHost } from './env.ts';

const card: AgcNode = {
  type: 'group',
  id: 'card',
  name: 'Card',
  transform: { tx: 16, ty: 40 },
  group: {
    children: [
      {
        type: 'shape',
        id: 'card-bg',
        name: 'Card background',
        shape: { type: 'rect', width: 200, height: 120, r: 12 },
        style: { fill: { type: 'solid', color: rgb(255, 255, 255) }, stroke: { type: 'solid', color: rgb(229, 231, 235), width: 1, align: 'inside' } },
      },
      {
        type: 'text',
        id: 'card-title',
        name: 'Card title',
        transform: { tx: 12, ty: 30 },
        style: { font: { family: 'Noto Sans', style: 'Bold', size: 16 }, fill: { type: 'solid', color: rgb(17, 24, 39) } },
        text: { rawText: 'Ceramic Mug', frame: { type: 'positioned' }, paragraphs: [{ lines: [[{ from: 0, to: 11, x: 0, y: 0 }]] }] },
      },
    ],
  },
};

const photo: AgcNode = {
  type: 'shape',
  id: 'photo',
  name: 'Photo',
  transform: { tx: 16, ty: 200 },
  shape: { type: 'rect', width: 100, height: 80 },
  style: { fill: { type: 'pattern', pattern: { width: 100, height: 80, meta: { ux: { uid: 'photo1', scaleBehavior: 'fill' } } } } },
};

const design = buildXd({
  artboards: [
    { id: 'artboard-home', name: 'Home', bounds: { x: 0, y: 0, width: 430, height: 600 }, children: [card, photo], background: { r: 255, g: 255, b: 255 } },
    { id: 'artboard-cart', name: 'Cart', bounds: { x: 530, y: 0, width: 430, height: 600 }, children: [], background: { r: 249, g: 250, b: 251 } },
  ],
  images: { photo1: PNG_BYTES },
});

describe('webview with an .xd document (happy-dom)', () => {
  let host: FakeHost;

  before(async () => {
    host = await bootWebview();
  });
  after(() => host.close());

  it('asks the host for the document, then for the first artboard', async () => {
    assert.deepEqual(host.posted[0], { type: 'ready' });
    host.deliver({ type: 'document', fileName: 'shop.xd', artboards: [...design.artboards], board: design.board });
    await host.until(() => host.last('loadArtboard') !== undefined, 'loadArtboard');
    assert.deepEqual(host.last('loadArtboard'), { type: 'loadArtboard', id: 'artboard-home', knownImages: [] });
    assert.deepEqual(
      host.$$('#artboards .artboard-item').map((item) => item.textContent),
      ['Home430×600', 'Cart430×600'],
    );
  });

  it('renders the artboard, its layer tree and the image delivered through the VS Code serializer', async () => {
    host.deliver(artboardMessage(design, 'artboard-home', new Set()));
    await host.until(() => host.$$('#canvas svg.dv-artboard').length === 1, 'artboard svg');
    assert.equal(host.$('#artboard-title').textContent, 'Home 430 × 600');
    assert.equal(host.$$('#canvas g[data-key]').length, 4);
    assert.equal(host.blobs.length, 1);
    assert.equal(host.blobs[0]?.size, PNG_BYTES.length);
    assert.equal(host.blobs[0]?.type, 'image/png');
    const href = host.$('#canvas pattern image').getAttribute('href') ?? '';
    assert.match(href, /^blob:/);
    assert.equal(host.$('#warnings').hidden, true);
    assert.deepEqual(
      host.$$('#layers .layer-name').map((name) => name.textContent),
      ['Photo', 'Card', 'Card title', 'Card background'],
    );
    assert.equal(host.$('.insp-kind').textContent, 'Artboard');
  });

  it('selects a layer from the tree, shows it in the inspector and expands nothing it does not need', () => {
    const row = host.$$('#layers .layer-row').find((element) => element.textContent?.includes('Card background'));
    assert.ok(row);
    host.click(row);
    assert.equal(host.$('.insp-title').textContent, 'Card background');
    assert.equal(host.$('.insp-kind').textContent, 'Rectangle');
    assert.ok(row.classList.contains('selected'));
    assert.ok(!row.closest('li.layer.collapsed'), 'ancestors of the selected row are expanded');
    assert.deepEqual(
      host.$$('.crumbs .crumb').map((crumb) => crumb.textContent),
      ['Home', 'Card'],
    );
  });

  it('toggles a group in the tree without changing the selection', () => {
    const group = host.$$('#layers li.layer').find((li) => li.querySelector(':scope > .layer-row')?.textContent?.includes('Card'));
    assert.ok(group);
    const twisty = group.querySelector('[data-toggle]');
    assert.ok(twisty);
    const collapsed = group.classList.contains('collapsed');
    host.click(twisty);
    assert.equal(group.classList.contains('collapsed'), !collapsed);
    assert.equal(host.$('.insp-title').textContent, 'Card background');
  });

  it('copies inspector values and CSS through the host, with a toast', () => {
    const color = host.$$('#inspector [data-copy]').find((button) => button.getAttribute('data-copy') === '#FFFFFF');
    assert.ok(color, 'fill color is copyable');
    host.click(color);
    assert.deepEqual(host.last('copy'), { type: 'copy', text: '#FFFFFF', label: '#FFFFFF' });
    assert.equal(host.$('#toast').hidden, false);

    const css = host.$$('#inspector [data-copy]').find((button) => button.getAttribute('data-label') === 'CSS');
    assert.ok(css);
    host.click(css);
    const copied = host.last('copy');
    assert.equal(copied?.label, 'CSS');
    assert.match(copied?.text ?? '', /border-radius: 12px;/);
    assert.match(copied?.text ?? '', /border: 1px solid #E5E7EB;/);
  });

  it('walks up with breadcrumbs and Escape', () => {
    const crumb = host.$$('.crumbs .crumb').find((element) => element.textContent === 'Card');
    assert.ok(crumb);
    host.click(crumb);
    assert.equal(host.$('.insp-title').textContent, 'Card');
    host.key('Escape');
    assert.equal(host.$('.insp-kind').textContent, 'Artboard');
  });

  it('opens another artboard from the list', async () => {
    const cart = host.$$('#artboards .artboard-item').find((item) => item.getAttribute('data-id') === 'artboard-cart');
    assert.ok(cart);
    host.click(cart);
    assert.deepEqual(host.last('loadArtboard'), { type: 'loadArtboard', id: 'artboard-cart', knownImages: ['photo1'] });
    host.deliver(artboardMessage(design, 'artboard-cart', new Set(['photo1'])));
    await host.until(() => host.$('#artboard-title').textContent === 'Cart 430 × 600', 'cart title');
    assert.equal(host.state?.artboardId, 'artboard-cart');
  });

  it('switches to the board, loads scenes in a batch and remembers the mode', async () => {
    host.click(host.$('#mode-board'));
    assert.equal(host.state?.mode, 'board');
    assert.ok(host.$('#app').classList.contains('board-mode'));
    assert.equal(host.$('#board-page').hidden, true, 'one canvas, no page picker');
    await host.until(() => host.last('loadArtboards') !== undefined, 'loadArtboards');
    const request = host.last('loadArtboards');
    assert.ok(request?.ids.includes('artboard-home'));
    host.deliver(scenesMessage(design, request?.ids ?? [], new Set(request?.knownImages)));
    await host.until(() => host.$$('#board-titles .dv-board-title').length === 2, 'board titles');
    assert.deepEqual(
      host.$$('#board-titles .dv-board-title').map((title) => title.textContent),
      ['Home', 'Cart'],
    );
    assert.match(host.$('#artboard-title').textContent ?? '', /2 artboards/);
  });

  it('goes back to the single view with B', async () => {
    host.key('b');
    assert.equal(host.state?.mode, 'artboard');
    assert.ok(!host.$('#app').classList.contains('board-mode'));
    await host.until(() => host.$$('#canvas svg.dv-artboard').length === 1, 'single artboard svg');
  });
});
