import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FigDocument } from '../src/fig/parse.ts';
import { artboardMessage, scenesMessage } from '../src/payload.ts';
import type { HostMessage, ImagePayload } from '../src/protocol.ts';
import { at, buildFig, documentNodes, node, solid } from './support/figFixture.ts';
import { deserializeInWebview, serializeForWebview } from './support/vscodeWebviewSerializer.ts';
import { buildXd, PNG_BYTES } from './support/xdFixture.ts';

const XD_IMAGE = Buffer.concat([PNG_BYTES, Buffer.alloc(500, 7)]);
const FIG_HASH = 'cd'.repeat(20);
const FIG_IMAGE = Buffer.concat([PNG_BYTES.subarray(0, 8), Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 32]), Buffer.alloc(300, 9)]);

function xdDocument() {
  return buildXd({
    artboards: [
      {
        id: 'artboard-a',
        name: 'A',
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        children: [
          {
            type: 'shape',
            id: 'img',
            shape: { type: 'rect', width: 40, height: 20 },
            style: { fill: { type: 'pattern', pattern: { width: 800, height: 600, meta: { ux: { uid: 'xdimage1', scaleBehavior: 'fill' } } } } },
          },
        ],
      },
      { id: 'artboard-b', name: 'B', bounds: { x: 200, y: 0, width: 100, height: 100 }, children: [] },
    ],
    images: { xdimage1: XD_IMAGE },
  });
}

function figDocument() {
  return FigDocument.open(
    buildFig(
      documentNodes([
        node(10, 1, 'FRAME', { name: 'Screen', size: { x: 390, y: 800 }, transform: at(0, 0), fillPaints: [solid(1, 1, 1)] }),
        node(11, 10, 'RECTANGLE', {
          size: { x: 40, y: 40 },
          fillPaints: [{ type: 'IMAGE', visible: true, opacity: 1, image: { hash: Buffer.from(FIG_HASH, 'hex') }, imageScaleMode: 'FILL' }],
        }),
      ]),
      { images: { [FIG_HASH]: FIG_IMAGE } },
    ),
  );
}

/** What the webview receives after VS Code's serializer, plus the buffers that crossed the boundary. */
function roundTrip(message: HostMessage) {
  const serialized = serializeForWebview(message);
  return { received: deserializeInWebview(serialized) as HostMessage, transferred: serialized.buffers };
}

function imagesOf(message: HostMessage): ImagePayload[] {
  return message.type === 'artboard' || message.type === 'scenes' ? message.images : [];
}

function assertImagesSurvive(message: HostMessage, expected: Record<string, Buffer>) {
  const { received, transferred } = roundTrip(message);
  const images = imagesOf(received);
  assert.deepEqual(images.map((image) => image.uid).sort(), Object.keys(expected).sort());
  for (const image of images) {
    const bytes = expected[image.uid];
    assert.ok(image.data instanceof Uint8Array, `${image.uid} arrived as ${JSON.stringify(image.data).slice(0, 40)}`);
    assert.ok(bytes && Buffer.from(image.data).equals(bytes), `${image.uid} bytes differ`);
  }
  // Each image crosses as its own buffer of exactly its size, never as a view into the whole design file.
  assert.deepEqual(transferred.map((buffer) => buffer.byteLength).sort(), Object.values(expected).map((bytes) => bytes.length).sort());
}

describe('image payloads through the VS Code webview serializer', () => {
  it('delivers XD images from loadArtboard and loadArtboards as exactly-sized Uint8Arrays', () => {
    const doc = xdDocument();
    assertImagesSurvive(artboardMessage(doc, 'artboard-a', new Set()), { xdimage1: XD_IMAGE });
    assertImagesSurvive(scenesMessage(doc, ['artboard-a', 'artboard-b'], new Set()), { xdimage1: XD_IMAGE });
  });

  it('delivers Figma images the same way', () => {
    const doc = figDocument();
    assertImagesSurvive(artboardMessage(doc, '1:10', new Set()), { [FIG_HASH]: FIG_IMAGE });
    assertImagesSurvive(scenesMessage(doc, ['1:10'], new Set()), { [FIG_HASH]: FIG_IMAGE });
  });

  it('sends each image once per batch and skips images the webview already has', () => {
    const doc = figDocument();
    const twice = scenesMessage(doc, ['1:10', '1:10'], new Set());
    assert.equal(imagesOf(twice).length, 1);
    assert.equal(imagesOf(scenesMessage(doc, ['1:10'], new Set([FIG_HASH]))).length, 0);
  });

  it('reports artboards that fail to convert instead of dropping the batch', () => {
    const message = scenesMessage(xdDocument(), ['artboard-a', 'artboard-missing'], new Set());
    assert.equal(message.type, 'scenes');
    if (message.type === 'scenes') {
      assert.deepEqual(message.scenes.map((scene) => scene.id), ['artboard-a']);
      assert.deepEqual(message.failed, [{ id: 'artboard-missing', message: 'Unknown artboard: artboard-missing' }]);
    }
  });

  it('would catch a raw Node Buffer (toJSON runs before the replacer) and a view into a larger buffer', () => {
    const file = Buffer.concat([Buffer.alloc(1000), XD_IMAGE]);
    const asBuffer = roundTrip({ type: 'artboard', scene: xdDocument().scene('artboard-a'), images: [{ uid: 'x', mime: 'image/png', data: XD_IMAGE }] });
    assert.ok(!(imagesOf(asBuffer.received)[0]?.data instanceof Uint8Array));
    assert.deepEqual(asBuffer.transferred, []);

    const view = new Uint8Array(file.buffer, file.byteOffset + 1000, XD_IMAGE.length);
    const asView = roundTrip({ type: 'artboard', scene: xdDocument().scene('artboard-a'), images: [{ uid: 'x', mime: 'image/png', data: view }] });
    assert.ok(imagesOf(asView.received)[0]?.data instanceof Uint8Array);
    assert.ok((asView.transferred[0]?.byteLength ?? 0) > XD_IMAGE.length, 'the whole underlying buffer is transferred');
  });
});
