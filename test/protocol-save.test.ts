import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSafeFileName, MESSAGE_LIMITS, parseWebviewMessage } from '../src/protocol.ts';
import { receivedFromWebview } from './support/vscodeWebviewSerializer.ts';
import { PNG_BYTES } from './support/xdFixture.ts';

const png = new Uint8Array(PNG_BYTES);
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const save = (fileName: unknown, data: unknown) => parseWebviewMessage({ type: 'save', fileName, data });

describe('parseWebviewMessage: save', () => {
  it('accepts a file name with a known extension and bytes of that type', () => {
    assert.deepEqual(save('Hero image@2x.png', png), { type: 'save', fileName: 'Hero image@2x.png', data: png });
    assert.ok(save('Logo.svg', svg));
    assert.ok(save('写真.jpg', jpeg));
    assert.ok(save('写真.jpeg', jpeg));
    assert.equal(parseWebviewMessage({ type: 'save', fileName: 'a.png', data: png, extra: 'x' })?.type, 'save');
  });

  it('accepts the bytes as the extension host receives them from a webview', () => {
    const message = receivedFromWebview({ type: 'save', fileName: 'Icon.svg', data: svg }) as { data: unknown };
    assert.ok(message.data instanceof Uint8Array);
    const parsed = parseWebviewMessage(message);
    assert.equal(parsed?.type, 'save');
    if (parsed?.type === 'save') {
      assert.deepEqual([...parsed.data], [...svg]);
      assert.equal(parsed.data.byteLength, svg.byteLength);
    }
  });

  it('drops data that is not a non-empty Uint8Array within the size cap', () => {
    const jsonOnly = JSON.parse(JSON.stringify({ type: 'save', fileName: 'a.png', data: png }));
    assert.equal(parseWebviewMessage(jsonOnly), null, 'a webview serializer without buffer support sends an object');
    for (const data of [[...png], 'iVBORw0KGgo=', png.buffer, new Uint8ClampedArray(png), new Int8Array(png), new DataView(png.buffer), new Uint8Array(), null, undefined, { length: 8 }]) {
      assert.equal(save('a.png', data), null, Object.prototype.toString.call(data));
    }
    const huge = new Uint8Array(MESSAGE_LIMITS.saveBytes + 1);
    huge.set(png);
    assert.equal(save('a.png', huge), null);
    const atCap = new Uint8Array(MESSAGE_LIMITS.saveBytes);
    atCap.set(png);
    assert.ok(save('a.png', atCap));
  });

  it('drops bytes that do not match the extension', () => {
    assert.equal(save('a.svg', png), null);
    assert.equal(save('a.png', svg), null);
    assert.equal(save('a.gif', jpeg), null);
    assert.equal(save('a.png', new TextEncoder().encode('<html><script>alert(1)</script></html>')), null);
    assert.equal(save('a.svg', new TextEncoder().encode('<!DOCTYPE html><svg>')), null);
  });

  it('drops file names that leave the folder, hide, carry control or bidi characters, or have other extensions', () => {
    const hostile = [
      '../a.png',
      '..\\a.png',
      'a/b.png',
      '/etc/a.png',
      'C:\\a.png',
      'C:a.png',
      '..',
      '.png',
      '.hidden.png',
      '..png',
      'a\u0000.png',
      'a\n.png',
      'a\u007f.png',
      'a\u202egnp.svg',
      'a\u2066.png',
      'a\ud800.png',
      'a.exe',
      'a.png.exe',
      'a.html',
      'a.PNG',
      'a.svgz',
      'a',
      'png',
      'name .png',
      'name..png',
      'con.png',
      'NUL.txt.png',
      'lpt1.svg',
      'a?.png',
      'a*.png',
      'a|b.png',
      '"a".png',
      '<a>.png',
      'x'.repeat(MESSAGE_LIMITS.fileNameBytes - 3) + '.png',
      '漢'.repeat(80) + '.png',
      42,
      null,
      ['a.png'],
    ];
    for (const fileName of hostile) {
      assert.equal(save(fileName, png), null, JSON.stringify(fileName));
      assert.equal(isSafeFileName(fileName), false, JSON.stringify(fileName));
    }
  });

  it('allows ordinary names, including spaces, dots inside, @2x, Unicode and the longest allowed name', () => {
    for (const fileName of ['a.png', 'Card - Ceramic Mug@3x.png', 'v1.2 final.png', 'ヘッダー 画像.png', '😀.png', 'console.png', 'x'.repeat(MESSAGE_LIMITS.fileNameBytes - 4) + '.png']) {
      assert.ok(isSafeFileName(fileName), fileName);
    }
  });
});
