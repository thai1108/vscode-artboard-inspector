import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { FigDocument } from '../../../src/fig/parse.ts';
import { artboardMessage, scenesMessage } from '../../../src/payload.ts';
import type { HostMessage } from '../../../src/protocol.ts';
import { at, buildFig, documentNodes, guid, node, solid } from '../../support/figFixture.ts';
import { PNG_BYTES } from '../../support/xdFixture.ts';
import { bootWebview, type FakeHost } from './env.ts';

const hash = 'cd'.repeat(20);
const png = Buffer.concat([PNG_BYTES.subarray(0, 8), Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 32])]);

const design = FigDocument.open(
  buildFig(
    [
      ...documentNodes(
        [
          node(10, 1, 'FRAME', { name: 'Login', size: { x: 390, y: 844 }, transform: at(0, 0), fillPaints: [solid(1, 1, 1)] }),
          node(11, 10, 'RECTANGLE', {
            name: 'Logo',
            size: { x: 64, y: 32 },
            transform: at(24, 40),
            fillPaints: [{ type: 'IMAGE', visible: true, opacity: 1, image: { hash: Buffer.from(hash, 'hex') }, imageScaleMode: 'FILL' }],
          }),
          node(12, 1, 'FRAME', { name: 'Home', size: { x: 390, y: 844 }, transform: at(500, 0), fillPaints: [solid(0.98, 0.98, 0.98)] }, 'b'),
        ],
        'Mobile',
      ),
      { guid: guid(50), parentIndex: { guid: { sessionID: 0, localID: 0 }, position: 'b' }, type: 'CANVAS', name: 'Desktop', visible: true },
      node(51, 50, 'FRAME', { name: 'Dashboard', size: { x: 1440, y: 900 }, transform: at(0, 0), fillPaints: [solid(1, 1, 1)] }),
    ],
    { images: { [hash]: png } },
  ),
);

describe('webview with a .fig document (happy-dom)', () => {
  let host: FakeHost;

  before(async () => {
    host = await bootWebview({ state: { mode: 'board' } });
  });
  after(() => host.close());

  it('opens straight into the remembered board mode with a page picker for both pages', async () => {
    host.deliver({ type: 'document', fileName: 'app.fig', artboards: [...design.artboards], board: design.board });
    assert.ok(host.$('#app').classList.contains('board-mode'));
    const picker = host.$<HTMLSelectElement>('#board-page');
    assert.equal(picker.hidden, false);
    assert.deepEqual(
      [...picker.options].map((option) => option.textContent),
      ['Mobile', 'Desktop'],
    );
    await host.until(() => host.last('loadArtboards') !== undefined, 'loadArtboards');
    const request = host.last('loadArtboards');
    assert.deepEqual([...(request?.ids ?? [])].sort(), ['1:10', '1:12']);
    host.deliver(scenesMessage(design, request?.ids ?? [], new Set()));
    await host.until(() => host.$$('#board-titles .dv-board-title').length === 2, 'board titles');
    assert.equal(host.blobs.length, 1, 'the logo image is turned into one blob');
    assert.equal(host.blobs[0]?.size, png.length);
    await host.until(() => host.$$('#canvas pattern image').length === 1, 'logo pattern on the board');
    assert.match(host.$('#canvas pattern image').getAttribute('href') ?? '', /^blob:/);
  });

  it('switches pages and remembers the page', async () => {
    const picker = host.$<HTMLSelectElement>('#board-page');
    picker.value = '1';
    picker.dispatchEvent(new host.window.Event('change', { bubbles: true }) as unknown as Event);
    assert.equal(host.state?.boardPage, 1);
    assert.match(host.$('#artboard-title').textContent ?? '', /^Desktop/);
    await host.until(() => host.last('loadArtboards')?.ids.includes('1:51') === true, 'Desktop scenes');
  });

  it('opens a single artboard from the list on the right page', async () => {
    host.key('b');
    assert.equal(host.state?.mode, 'artboard');
    const login = host.$$('#artboards .artboard-item').find((item) => item.getAttribute('data-id') === '1:10');
    assert.ok(login);
    host.click(login);
    await host.until(() => host.$('#artboard-title').textContent?.startsWith('Mobile / Login') === true, 'Login title');
    const row = host.$$('#layers .layer-row').find((element) => element.textContent?.includes('Logo'));
    assert.ok(row);
    host.click(row);
    assert.equal(host.$('.insp-title').textContent, 'Logo');
    assert.match(host.$('#inspector').textContent ?? '', /Image 64 × 32/);
  });

  it('flags an image that reaches the webview as a serialized Node Buffer instead of drawing it broken', async () => {
    const message = artboardMessage(design, '1:12', new Set()) as Extract<HostMessage, { type: 'artboard' }>;
    // What VS Code delivers when the host posts a raw Buffer: its toJSON() output.
    const broken: HostMessage = {
      ...message,
      scene: { ...message.scene, imageUids: ['ef'.repeat(20)] },
      images: [{ uid: 'ef'.repeat(20), mime: 'image/png', data: Buffer.from(png) }],
    };
    const blobsBefore = host.blobs.length;
    host.deliver(broken);
    await host.until(() => host.$('#warnings').hidden === false, 'warning badge');
    assert.equal(host.blobs.length, blobsBefore, 'no blob is made from the bogus payload');
    assert.match(host.$('#inspector').textContent ?? '', /could not be decoded/);
  });
});
