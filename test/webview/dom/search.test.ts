import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { artboardMessage, searchMessage } from '../../../src/payload.ts';
import type { HostMessage } from '../../../src/protocol.ts';
import { buildSearchIndex, type SearchIndex } from '../../../src/search.ts';
import type { AgcNode } from '../../../src/xd/agc.ts';
import { buildXd } from '../../support/xdFixture.ts';
import { bootWebview, type FakeHost } from './env.ts';

function textLayer(id: string, name: string, content: string, y: number): AgcNode {
  return {
    type: 'text',
    id,
    name,
    transform: { tx: 16, ty: y },
    style: { font: { family: 'Noto Sans', style: 'Regular', size: 14 } },
    text: { rawText: content, frame: { type: 'positioned' }, paragraphs: [{ lines: [[{ from: 0, to: content.length, x: 0, y: 0 }]] }] },
  };
}

const CTA_NAME = '<b>Checkout</b> & "pay"';
const design = buildXd({
  artboards: [
    { id: 'artboard-home', name: 'Home', bounds: { x: 0, y: 0, width: 430, height: 600 }, children: [textLayer('welcome', 'Welcome', 'ようこそ', 40)] },
    {
      id: 'artboard-cart',
      name: 'Cart',
      bounds: { x: 500, y: 0, width: 430, height: 600 },
      children: [
        {
          type: 'group',
          id: 'summary',
          name: 'Summary',
          group: { children: [textLayer('total', 'Total label', 'お支払い合計', 20), textLayer('cta', CTA_NAME, 'ご注文を確定する', 60)] },
        },
      ],
    },
    {
      id: 'artboard-list',
      name: 'List',
      bounds: { x: 1000, y: 0, width: 430, height: 4000 },
      children: Array.from({ length: 205 }, (_, i) => textLayer(`item${i}`, `Item ${i}`, `Item ${i}`, 20 + i * 18)),
    },
  ],
});

describe('search panel in the webview (happy-dom)', () => {
  let host: FakeHost;
  let index: SearchIndex;

  const input = () => host.$<HTMLInputElement>('#search');
  const hits = () => host.$$('#search-results .search-hit');
  const searches = () => host.posted.filter((message) => message.type === 'search');
  const press = (target: EventTarget, key: string, init: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}) =>
    target.dispatchEvent(new host.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }) as unknown as Event);
  const type = (value: string) => {
    input().value = value;
    input().dispatchEvent(new host.window.Event('input', { bubbles: true }) as unknown as Event);
  };
  /** Types `query`, waits for the debounced request and answers it with the real index. */
  const searchFor = async (query: string) => {
    const before = searches().length;
    type(query);
    await host.until(() => searches().length > before, `search request for ${query}`);
    const request = host.last('search');
    assert.ok(request);
    host.deliver(searchMessage(index, request.query, request.seq));
  };
  const openedArtboard = async (id: string, title: string) => {
    await host.until(() => host.last('loadArtboard')?.id === id, `loadArtboard ${id}`);
    host.deliver(artboardMessage(design, id, new Set()));
    await host.until(() => host.$('#artboard-title').textContent?.startsWith(title) === true, `${title} shown`);
  };

  before(async () => {
    index = await buildSearchIndex(design);
    host = await bootWebview();
    host.deliver({ type: 'document', fileName: 'shop.xd', artboards: [...design.artboards], board: design.board });
    await host.until(() => host.last('loadArtboard') !== undefined, 'first loadArtboard');
    host.deliver(artboardMessage(design, 'artboard-home', new Set()));
    await host.until(() => host.$('#artboard-title').textContent?.startsWith('Home') === true, 'Home shown');
  });
  after(() => host.close());

  it('focuses the search box with Cmd/Ctrl+F, even from another input', () => {
    const mac = host.window.navigator.userAgent.includes('Mac');
    assert.match(input().placeholder, mac ? /⌘F/ : /Ctrl\+F/);
    host.$<HTMLInputElement>('#artboard-filter').focus();
    press(host.$('#artboard-filter'), 'f', mac ? { metaKey: true } : { ctrlKey: true });
    assert.equal(host.window.document.activeElement, input() as unknown);
    assert.equal(input().maxLength, 200);
  });

  it('sends one debounced query per pause in typing, then shows the hits', async () => {
    const before = searches().length;
    type('確');
    type('確定');
    await host.until(() => searches().length > before, 'search request');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(searches().length, before + 1);
    const request = host.last('search');
    assert.equal(request?.query, '確定');
    assert.equal(host.$('#search-status').textContent, 'Searching…');

    host.deliver(searchMessage(index, '確定', request?.seq ?? 0));
    await host.until(() => hits().length === 1, 'one hit');
    const hit = hits()[0] as HTMLElement;
    assert.equal(hit.dataset['artboard'], 'artboard-cart');
    assert.equal(hit.querySelector('.search-hit-name')?.textContent, CTA_NAME, 'layer name shown as text');
    assert.equal(hit.querySelector('.search-hit-text')?.textContent, 'ご注文を確定する');
    assert.equal(hit.querySelector('.search-hit-text mark')?.textContent, '確定');
    assert.equal(hit.querySelector('.search-hit-artboard')?.textContent, 'Cart');
    assert.equal(host.$$('#search-results b').length, 0, 'markup in layer names is escaped');
    assert.equal(host.$('#search-status').textContent, '1 result');
    assert.ok(hit.classList.contains('active'), 'the first hit is where Enter starts');
    assert.ok(!hit.classList.contains('opened'));
  });

  it('ignores answers to queries the user has typed past', () => {
    const seq = host.last('search')?.seq ?? 0;
    host.deliver(searchMessage(index, 'item', seq - 1));
    assert.equal(hits().length, 1);
  });

  it('opens the hit with Enter: loads its artboard, selects the layer and reveals it in the tree', async () => {
    press(input(), 'Enter');
    await openedArtboard('artboard-cart', 'Cart');
    assert.equal(host.$('.insp-title').textContent, CTA_NAME);
    const row = host.$('#layers .layer-row.selected');
    assert.equal(row.querySelector('.layer-name')?.textContent, CTA_NAME);
    assert.ok(!row.closest('li.layer.collapsed'), 'the Summary group is expanded');
    assert.equal(host.$('#artboards .artboard-item.active').getAttribute('data-id'), 'artboard-cart');
    assert.ok(hits()[0]?.classList.contains('opened'));
  });

  it('matches full-width input, caps the list at 200 and counts the rest', async () => {
    await searchFor('ＩＴＥＭ');
    await host.until(() => hits().length === 200, '200 hits');
    assert.equal(host.$('#search-results .search-more').textContent, '5 more — refine the search');
    assert.equal(host.$('#search-status').textContent, '205 results');
    assert.equal(hits()[0]?.querySelector('mark')?.textContent, 'Item');
  });

  it('moves through the hits with the arrow keys and Enter', async () => {
    press(input(), 'ArrowDown');
    assert.equal(hits()[1]?.getAttribute('aria-selected'), 'true');
    assert.equal(input().getAttribute('aria-activedescendant'), 'search-hit-1');
    press(input(), 'ArrowUp');
    press(input(), 'ArrowUp');
    assert.equal(hits()[0]?.getAttribute('aria-selected'), 'true');

    const name = (i: number) => hits()[i]?.querySelector('.search-hit-name')?.textContent;
    const first = name(0);
    press(input(), 'Enter');
    await openedArtboard('artboard-list', 'List');
    assert.equal(host.$('.insp-title').textContent, first);

    const loads = host.posted.filter((message) => message.type === 'loadArtboard').length;
    press(input(), 'Enter');
    assert.equal(host.$('.insp-title').textContent, name(1), 'Enter again goes to the next hit');
    assert.deepEqual(
      host.$$('#search-results .search-hit.opened').map((item) => item.id),
      ['search-hit-1'],
    );
    assert.equal(host.$('#layers .layer-row.selected').getAttribute('data-key'), (hits()[1] as HTMLElement).dataset['key']);
    press(input(), 'Enter', { shiftKey: true });
    assert.equal(host.$('.insp-title').textContent, first, 'Shift+Enter goes back');
    assert.equal(host.posted.filter((message) => message.type === 'loadArtboard').length, loads, 'same artboard, no reload');
  });

  it('clears with Escape, then leaves the box on a second Escape', () => {
    press(input(), 'Escape');
    assert.equal(input().value, '');
    assert.equal(host.$('#search-results').hidden, true);
    assert.equal(host.$('#search-status').hidden, true);
    assert.equal(host.window.document.activeElement, input() as unknown);
    press(input(), 'Escape');
    assert.notEqual(host.window.document.activeElement, input() as unknown);
  });

  it('opens the first hit when Enter is pressed before the answer arrives', async () => {
    input().focus();
    const before = searches().length;
    type('welcome');
    press(input(), 'Enter');
    assert.equal(searches().length, before + 1, 'the pending query is sent at once');
    const request = host.last('search');
    host.deliver(searchMessage(index, request?.query ?? '', request?.seq ?? 0));
    await openedArtboard('artboard-home', 'Home');
    assert.equal(host.$('.insp-title').textContent, 'Welcome');
  });

  it('switches from the board to the single view when a hit is chosen', async () => {
    host.click(host.$('#mode-board'));
    assert.ok(host.$('#app').classList.contains('board-mode'));
    await searchFor('合計');
    await host.until(() => hits().length === 1, 'one hit');
    host.click(hits()[0]?.querySelector('.search-hit-text') as Element);
    assert.ok(!host.$('#app').classList.contains('board-mode'));
    await openedArtboard('artboard-cart', 'Cart');
    assert.equal(host.$('.insp-title').textContent, 'Total label');
  });

  it('says when only part of the file was searched, or when the search failed', () => {
    const seq = host.last('search')?.seq ?? 0;
    const answer = (fields: Partial<Extract<HostMessage, { type: 'searchResults' }>>): HostMessage => ({ type: 'searchResults', seq, hits: [], total: 0, searched: 3, ...fields });
    host.deliver(answer({ searched: 2 }));
    assert.equal(host.$('#search-status').textContent, 'No results in 2 of 3 artboards');
    host.deliver(answer({ error: 'Out of memory' }));
    assert.equal(host.$('#search-status').textContent, 'Search failed: Out of memory');
  });

  it('runs the query again when the file changes on disk', async () => {
    const before = host.last('search');
    host.deliver({ type: 'document', fileName: 'shop.xd', artboards: [...design.artboards], board: design.board });
    await host.until(() => (host.last('search')?.seq ?? 0) > (before?.seq ?? 0), 'search after reload');
    assert.equal(host.last('search')?.query, '合計');
  });
});
