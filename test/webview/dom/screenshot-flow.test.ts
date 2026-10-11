import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { artboardMessage } from '../../../src/payload.ts';
import { screenshotMessage } from '../../../src/screenshot.ts';
import { encodePng } from '../../support/png.ts';
import { buildXd, rgb } from '../../support/xdFixture.ts';
import { bootWebview, type FakeHost } from './env.ts';

const design = buildXd({
  artboards: [
    {
      id: 'artboard-home',
      name: 'Home',
      bounds: { x: 0, y: 0, width: 430, height: 600 },
      children: [{ type: 'shape', id: 'button', name: 'Button', transform: { tx: 16, ty: 500 }, shape: { type: 'rect', width: 398, height: 52 }, style: { fill: { type: 'solid', color: rgb(37, 99, 235) } } }],
    },
    { id: 'artboard-cart', name: 'Cart', bounds: { x: 530, y: 0, width: 430, height: 600 }, children: [] },
  ],
});
const PNG = encodePng(8, 4, () => [37, 99, 235]);

describe('screenshot overlay in the webview (happy-dom)', () => {
  let host: FakeHost;
  /** happy-dom decodes no images; the size the overlay reads from the decoded image. */
  let natural = { width: 860, height: 1200 };
  let decodeFails = false;
  const revoked: string[] = [];

  const bar = () => host.$('#screenshot-bar');
  const image = () => host.$$('#canvas > img.dv-screenshot')[0] as HTMLImageElement | undefined;
  const text = (selector: string) => host.$(selector).textContent;
  const keydown = (key: string, init: { shiftKey?: boolean; target?: Element } = {}) =>
    (init.target ?? host.window).dispatchEvent(new host.window.KeyboardEvent('keydown', { key, shiftKey: init.shiftKey ?? false, bubbles: true }) as never);
  const input = (selector: string, value: string, type: 'input' | 'change') => {
    const element = host.$<HTMLInputElement>(selector);
    element.value = value;
    element.dispatchEvent(new host.window.Event(type, { bubbles: true }) as never);
  };
  const paste = (file: File | null, target: Element = host.$('body')) => {
    const clipboardData = new host.window.DataTransfer();
    if (file) {
      clipboardData.items.add(file as never);
    }
    target.dispatchEvent(new host.window.ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }) as never);
  };
  const toast = () => (host.$('#toast').hidden ? null : text('#toast'));

  async function showArtboard(id: string): Promise<void> {
    host.deliver(artboardMessage(design, id, new Set()));
    const name = id === 'artboard-home' ? 'Home' : 'Cart';
    await host.until(() => text('#artboard-title')?.startsWith(name) === true, `${name} shown`);
  }

  before(async () => {
    host = await bootWebview();
    const prototype = host.window.HTMLImageElement.prototype;
    Object.defineProperty(prototype, 'naturalWidth', { configurable: true, get: () => natural.width });
    Object.defineProperty(prototype, 'naturalHeight', { configurable: true, get: () => natural.height });
    const decode = prototype.decode;
    prototype.decode = function (this: HTMLImageElement) {
      return decodeFails ? Promise.reject(new Error('EncodingError')) : decode.call(this);
    };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
      revoke(url);
    };
  });
  after(() => host.close());

  it('offers the overlay once an artboard is shown and asks the host for a screenshot of that artboard', async () => {
    assert.equal(host.$('#screenshot-load').hidden, true);
    host.deliver({ type: 'document', fileName: 'shop.xd', artboards: [...design.artboards], board: design.board });
    await showArtboard('artboard-home');
    assert.equal(host.$('#screenshot-load').hidden, false);
    assert.equal(bar().hidden, true);
    host.click(host.$('#screenshot-load'));
    assert.deepEqual(host.last('pickScreenshot'), { type: 'pickScreenshot', artboardId: 'artboard-home' });
  });

  it('draws the picked screenshot over the artboard at the guessed retina scale', async () => {
    host.deliver(screenshotMessage('artboard-home', 'home@2x.png', PNG));
    await host.until(() => !bar().hidden, 'overlay bar');
    const img = image();
    assert.ok(img, 'the screenshot sits in the zoomed canvas');
    assert.ok(img.previousElementSibling?.matches('svg.dv-artboard'), 'drawn above the artboard');
    assert.match(img.getAttribute('src') ?? '', /^blob:/);
    assert.equal(host.blobs.at(-1)?.type, 'image/png');
    assert.equal(host.blobs.at(-1)?.size, PNG.length);
    assert.equal(img.style.transform, 'translate(0px, 0px) scale(0.5)');
    assert.equal(img.style.opacity, '0.5');
    assert.equal(host.$<HTMLSelectElement>('#screenshot-scale').value, '2');
    assert.equal(text('#screenshot-name'), 'home@2x.png');
    assert.equal(host.$('#screenshot-name').title, 'home@2x.png — 860 × 1200 px');
    assert.equal(text('#screenshot-opacity-value'), '50%');
    assert.equal(text('#screenshot-offset'), '0, 0');
  });

  it('changes scale, opacity, difference blend and visibility from the bar', () => {
    input('#screenshot-scale', '1', 'change');
    assert.equal(image()?.style.transform, 'translate(0px, 0px) scale(1)');
    input('#screenshot-scale', '2', 'change');
    input('#screenshot-opacity', '80', 'input');
    assert.equal(image()?.style.opacity, '0.8');
    assert.equal(text('#screenshot-opacity-value'), '80%');

    host.click(host.$('#screenshot-blend'));
    assert.ok(image()?.classList.contains('difference'));
    assert.equal(host.$('#screenshot-blend').getAttribute('aria-pressed'), 'true');

    host.click(host.$('#screenshot-visible'));
    assert.equal(image()?.hidden, true);
    assert.equal(text('#screenshot-visible'), 'Show');
    host.click(host.$('#screenshot-visible'));
    assert.equal(image()?.hidden, false);
    assert.equal(text('#screenshot-visible'), 'Hide');
  });

  it('nudges with the arrow keys (Shift: 10 px), but not while typing or while hidden', () => {
    keydown('ArrowRight');
    keydown('ArrowRight');
    keydown('ArrowLeft');
    keydown('ArrowDown', { shiftKey: true });
    keydown('ArrowUp');
    assert.equal(text('#screenshot-offset'), '1, 9');
    assert.equal(image()?.style.transform, 'translate(1px, 9px) scale(0.5)');

    keydown('ArrowRight', { target: host.$('#artboard-filter') });
    keydown('ArrowDown', { target: host.$('#search') });
    keydown('ArrowRight', { target: host.$('#screenshot-scale') });
    host.click(host.$('#screenshot-visible'));
    keydown('ArrowRight');
    host.click(host.$('#screenshot-visible'));
    assert.equal(text('#screenshot-offset'), '1, 9');
  });

  it('keeps one overlay per artboard while the editor is open', async () => {
    host.click(host.$('#artboards .artboard-item[data-id="artboard-cart"]'));
    await showArtboard('artboard-cart');
    assert.equal(bar().hidden, true);
    assert.equal(image(), undefined);
    keydown('ArrowRight');

    host.click(host.$('#artboards .artboard-item[data-id="artboard-home"]'));
    await showArtboard('artboard-home');
    assert.equal(bar().hidden, false);
    assert.equal(text('#screenshot-offset'), '1, 9');
    assert.equal(image()?.style.opacity, '0.8');
    assert.ok(image()?.classList.contains('difference'));
  });

  it('leaves the board view without overlays and restores the artboard overlay after it', async () => {
    host.click(host.$('#mode-board'));
    assert.equal(host.$('#screenshot-load').hidden, true);
    assert.equal(bar().hidden, true);
    assert.equal(image(), undefined);
    host.key('b');
    await host.until(() => image() !== undefined, 'overlay back on the single artboard');
    assert.equal(bar().hidden, false);
    assert.equal(host.state && JSON.stringify(host.state).includes('screenshot'), false, 'nothing is persisted');
  });

  it('replaces the screenshot, keeping its settings and re-guessing the scale', async () => {
    const before = image()?.getAttribute('src') ?? '';
    natural = { width: 430, height: 600 };
    host.deliver(screenshotMessage('artboard-home', 'home.png', PNG));
    await host.until(() => text('#screenshot-name') === 'home.png', 'replaced screenshot');
    assert.ok(revoked.includes(before), 'the previous image is released');
    assert.equal(host.$<HTMLSelectElement>('#screenshot-scale').value, '1');
    assert.equal(text('#screenshot-offset'), '1, 9');
    assert.equal(image()?.style.opacity, '0.8');
  });

  it('refuses non-image bytes, mangled payloads and images the browser cannot decode', async () => {
    host.deliver({ type: 'screenshot', artboardId: 'artboard-home', name: 'notes.png', data: new Uint8Array(Buffer.from('not an image')) });
    await host.until(() => toast() !== null, 'error toast');
    assert.equal(toast(), 'notes.png is not a PNG, JPEG or WebP image');

    host.deliver({ type: 'screenshot', artboardId: 'artboard-home', name: 'buffer.png', data: Buffer.from(PNG) });
    await host.until(() => toast() === 'buffer.png could not be read', 'mangled payload toast');

    decodeFails = true;
    const created = host.blobs.length;
    host.deliver(screenshotMessage('artboard-home', 'broken.png', PNG));
    await host.until(() => toast() === 'broken.png could not be decoded', 'decode error toast');
    decodeFails = false;
    assert.equal(host.blobs.length, created + 1);
    assert.equal(text('#screenshot-name'), 'home.png', 'the shown screenshot stays');
  });

  it('pastes an image from the clipboard onto the shown artboard, but not into a text field', async () => {
    natural = { width: 1290, height: 1800 };
    paste(new host.window.File([PNG], 'pasted.png', { type: 'image/png' }) as unknown as File, host.$('#artboard-filter'));
    paste(new host.window.File(['plain text'], 'notes.txt', { type: 'text/plain' }) as unknown as File);
    paste(null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(text('#screenshot-name'), 'home.png');

    paste(new host.window.File([PNG], 'image.png', { type: 'image/png' }) as unknown as File);
    await host.until(() => text('#screenshot-name') === 'image.png', 'pasted screenshot');
    assert.equal(host.$<HTMLSelectElement>('#screenshot-scale').value, '3');
  });

  it('takes an image file dropped on the canvas and refuses other dropped files', async () => {
    // happy-dom has no DragEvent; the handler only reads dataTransfer.
    const drag = (type: string, dataTransfer: { types: string[]; files?: File[]; dropEffect?: string }) => {
      const event = new host.window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { files: [], dropEffect: 'none', ...dataTransfer } });
      host.$('#canvas').dispatchEvent(event as never);
      return event;
    };
    const over = drag('dragover', { types: ['Files'] });
    assert.equal(over.defaultPrevented, true);
    assert.equal((over as unknown as DragEvent).dataTransfer?.dropEffect, 'copy');
    assert.equal(drag('dragover', { types: ['text/plain'] }).defaultPrevented, false);

    natural = { width: 430, height: 600 };
    assert.equal(drag('drop', { types: ['Files'], files: [new host.window.File([PNG], 'dropped.png', { type: 'image/png' }) as unknown as File] }).defaultPrevented, true);
    await host.until(() => text('#screenshot-name') === 'dropped.png', 'dropped screenshot');
    assert.equal(host.$<HTMLSelectElement>('#screenshot-scale').value, '1');

    assert.equal(drag('drop', { types: ['Files'], files: [new host.window.File(['x'], 'notes.txt', { type: 'text/plain' }) as unknown as File] }).defaultPrevented, true);
    assert.equal(toast(), 'Drop a PNG, JPEG or WebP image');
    assert.equal(text('#screenshot-name'), 'dropped.png');
  });

  it('removes the screenshot and releases it', () => {
    const url = image()?.getAttribute('src') ?? '';
    host.click(host.$('#screenshot-remove'));
    assert.equal(bar().hidden, true);
    assert.equal(image(), undefined);
    assert.ok(revoked.includes(url));
    assert.equal(host.$('#screenshot-load').hidden, false);
  });

  it('forgets overlays of artboards that are gone after the file changes', async () => {
    host.deliver(screenshotMessage('artboard-home', 'home.png', PNG));
    await host.until(() => !bar().hidden, 'overlay bar');
    const url = image()?.getAttribute('src') ?? '';
    const [, cart] = design.artboards;
    assert.ok(cart);
    host.deliver({ type: 'document', fileName: 'shop.xd', artboards: [cart], board: design.board });
    assert.ok(revoked.includes(url));
  });
});
