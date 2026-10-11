import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { artboardMessage } from '../../../src/payload.ts';
import { parseWebviewMessage, type SaveRequest } from '../../../src/protocol.ts';
import type { AgcNode } from '../../../src/xd/agc.ts';
import { receivedFromWebview } from '../../support/vscodeWebviewSerializer.ts';
import { buildXd, PNG_BYTES, rgb } from '../../support/xdFixture.ts';
import { bootWebview, type FakeHost } from './env.ts';

const photo: AgcNode = {
  type: 'shape',
  id: 'photo',
  name: 'Photo / Hero',
  transform: { tx: 16, ty: 200 },
  shape: { type: 'rect', width: 100, height: 80 },
  style: { fill: { type: 'pattern', pattern: { width: 100, height: 80, meta: { ux: { uid: 'photo1', scaleBehavior: 'fill' } } } } },
};

const title: AgcNode = {
  type: 'text',
  id: 'title',
  name: 'Title',
  transform: { tx: 16, ty: 40 },
  style: { font: { family: 'Noto Sans', style: 'Bold', size: 16 }, fill: { type: 'solid', color: rgb(17, 24, 39) } },
  text: { rawText: 'Hello', frame: { type: 'positioned' }, paragraphs: [{ lines: [[{ from: 0, to: 5, x: 0, y: 0 }]] }] },
};

const design = buildXd({
  artboards: [{ id: 'artboard-home', name: 'Home', bounds: { x: 0, y: 0, width: 430, height: 600 }, children: [title, photo], background: { r: 255, g: 255, b: 255 } }],
  images: { photo1: PNG_BYTES },
});

describe('export buttons in the webview (happy-dom)', () => {
  let host: FakeHost;
  const saves = () => host.posted.filter((message): message is SaveRequest => message.type === 'save');
  const text = (data: Uint8Array) => new TextDecoder().decode(data);
  const exportButton = (selector: string) => host.$(`#inspector button[data-export]${selector}`);

  async function selectLayer(name: string): Promise<void> {
    const row = host.$$('#layers .layer-row').find((element) => element.textContent?.includes(name));
    assert.ok(row, `layer row ${name}`);
    host.click(row);
    await host.until(() => host.$('.insp-title').textContent === name, `${name} in the inspector`);
  }

  async function nextSave(count: number): Promise<SaveRequest> {
    await host.until(() => saves().length === count, `save message #${count}`);
    const message = saves()[count - 1];
    assert.ok(message);
    // What the host would get, after VS Code's transport and validation.
    assert.deepEqual(parseWebviewMessage(receivedFromWebview(message)), message);
    return message;
  }

  before(async () => {
    host = await bootWebview();
    host.deliver({ type: 'document', fileName: 'shop.xd', artboards: [...design.artboards], board: design.board });
    await host.until(() => host.last('loadArtboard') !== undefined, 'loadArtboard');
    host.deliver(artboardMessage(design, 'artboard-home', new Set()));
    await host.until(() => host.$$('#canvas svg.dv-artboard').length === 1, 'artboard svg');
  });
  after(() => host.close());

  it('saves the embedded image with its original bytes, named after the layer', async () => {
    await selectLayer('Photo / Hero');
    assert.equal(exportButton('[data-export="image"]').textContent, 'Save image (PNG)');
    host.click(exportButton('[data-export="image"]'));
    const message = await nextSave(1);
    assert.equal(message.fileName, 'Photo - Hero.png');
    assert.ok(message.data instanceof Uint8Array);
    assert.deepEqual(Buffer.from(message.data), PNG_BYTES);
  });

  it('exports a standalone SVG with the image inlined', async () => {
    host.click(exportButton('[data-export="svg"]'));
    const message = await nextSave(2);
    assert.equal(message.fileName, 'Photo - Hero.svg');
    const svg = text(message.data);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" xml:space="preserve" /);
    assert.ok(svg.includes(`href="data:image/png;base64,${PNG_BYTES.toString('base64')}"`), svg.slice(0, 400));
    assert.doesNotMatch(svg, /blob:|data-key|class=/);
  });

  it('reports a PNG that cannot be drawn instead of posting it', async () => {
    host.click(exportButton('[data-export="png"][data-scale="2"]'));
    await host.until(() => (host.$('#toast').textContent ?? '').startsWith('Export failed'), 'failure toast');
    assert.match(host.$('#toast').textContent ?? '', /canvas/);
    assert.equal(saves().length, 2);
  });

  it('exports text layers with their font, without a Save image button', async () => {
    await selectLayer('Title');
    assert.equal(host.$$('#inspector [data-export="image"]').length, 0);
    host.click(exportButton('[data-export="svg"]'));
    const message = await nextSave(3);
    assert.equal(message.fileName, 'Title.svg');
    assert.match(text(message.data), /<text x="0" y="[\d.]+"><tspan font-family="'Noto Sans'[^"]*" font-size="16" font-weight="700"[^>]*>Hello<\/tspan><\/text>/);
  });

  it('exports the layer selected on the board', async () => {
    // The board reuses the scene the single view already has, so nothing new is requested.
    host.click(host.$('#mode-board'));
    await host.until(() => host.$$('#canvas .dv-board-item svg.dv-artboard').length === 1, 'artboard drawn on the board');
    assert.equal(host.last('loadArtboards'), undefined);
    host.click(host.$('#artboards .artboard-item[data-id="artboard-home"]'));
    await selectLayer('Photo / Hero');
    host.click(exportButton('[data-export="image"]'));
    const image = await nextSave(4);
    assert.equal(image.fileName, 'Photo - Hero.png');
    host.click(exportButton('[data-export="svg"]'));
    assert.match(text((await nextSave(5)).data), /href="data:image\/png;base64,/);
  });
});
