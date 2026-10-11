import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MESSAGE_LIMITS, parseWebviewMessage, type HostMessage } from '../src/protocol.ts';
import { assertScreenshotSize, SCREENSHOT_MAX_BYTES, screenshotMessage, screenshotMime, screenshotType } from '../src/screenshot.ts';
import { encodePng } from './support/png.ts';
import { deserializeInWebview, serializeForWebview } from './support/vscodeWebviewSerializer.ts';

const PNG = encodePng(4, 2, () => [255, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

describe('screenshot file checks', () => {
  it('recognises PNG, JPEG and WebP by their signature', () => {
    assert.equal(screenshotMime(PNG), 'image/png');
    assert.equal(screenshotMime(JPEG), 'image/jpeg');
    assert.equal(screenshotMime(WEBP), 'image/webp');
  });

  it('rejects other formats, text, truncated signatures and empty files', () => {
    for (const bytes of [
      Buffer.from('GIF89a'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVE'),
      PNG.subarray(0, 7),
      Buffer.from([0xff, 0xd8]),
      Buffer.alloc(0),
    ]) {
      assert.equal(screenshotMime(bytes), null, bytes.toString('latin1').slice(0, 20));
    }
    assert.throws(() => screenshotType('notes.png', Buffer.from('hello')), /^Error: notes\.png is not a PNG, JPEG or WebP image$/);
  });

  it('caps the size at 50 MB, before and after reading', () => {
    assert.doesNotThrow(() => assertScreenshotSize('a.png', SCREENSHOT_MAX_BYTES));
    assert.throws(() => assertScreenshotSize('big.png', SCREENSHOT_MAX_BYTES + 1), /big\.png is too large to overlay \(50 MB; limit 50 MB\)/);
    assert.throws(() => assertScreenshotSize('huge.png', 300 * 1024 * 1024), /\(300 MB; limit 50 MB\)/);
    const oversized = Buffer.alloc(SCREENSHOT_MAX_BYTES + 1);
    PNG.copy(oversized);
    assert.throws(() => screenshotType('big.png', oversized), /too large/);
  });
});

describe('screenshot message', () => {
  it('arrives in the webview as a plain, exactly-sized Uint8Array even from a Node Buffer view', () => {
    const file = Buffer.concat([Buffer.alloc(1000, 1), PNG]);
    const view = file.subarray(1000);
    const serialized = serializeForWebview(screenshotMessage('artboard-a', 'home@2x.png', view));
    const received = deserializeInWebview(serialized) as HostMessage;
    assert.equal(received.type, 'screenshot');
    if (received.type === 'screenshot') {
      assert.equal(received.artboardId, 'artboard-a');
      assert.equal(received.name, 'home@2x.png');
      assert.ok(received.data instanceof Uint8Array);
      assert.ok(Buffer.from(received.data).equals(PNG));
    }
    assert.deepEqual(
      serialized.buffers.map((buffer) => buffer.byteLength),
      [PNG.length],
    );
  });

  it('refuses bytes that are not an image', () => {
    assert.throws(() => screenshotMessage('artboard-a', 'shot.png', Buffer.from('%PDF-1.7')), /shot\.png is not a PNG, JPEG or WebP image/);
  });
});

describe('pickScreenshot message validation', () => {
  it('accepts an artboard id and drops anything else', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'pickScreenshot', artboardId: 'artboard-a', path: '/etc/passwd' }), { type: 'pickScreenshot', artboardId: 'artboard-a' });
    for (const raw of [
      { type: 'pickScreenshot' },
      { type: 'pickScreenshot', artboardId: 7 },
      { type: 'pickScreenshot', artboardId: ['a'] },
      { type: 'pickScreenshot', artboardId: 'a'.repeat(MESSAGE_LIMITS.idLength + 1) },
      { type: 'screenshot', artboardId: 'a', name: 'x.png', data: [] },
    ]) {
      assert.equal(parseWebviewMessage(raw), null, JSON.stringify(raw).slice(0, 60));
    }
  });
});
