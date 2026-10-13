import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MESSAGE_LIMITS, parseWebviewMessage } from '../src/protocol.ts';
import { receivedFromWebview } from './support/vscodeWebviewSerializer.ts';

describe('parseWebviewMessage: comparing versions', () => {
  it('accepts the compare commands, dropping anything extra', () => {
    for (const type of ['pickCompare', 'swapCompare', 'exitCompare'] as const) {
      assert.deepEqual(parseWebviewMessage({ type }), { type });
      assert.deepEqual(parseWebviewMessage({ type, path: '/etc/passwd' }), { type });
      assert.deepEqual(parseWebviewMessage(receivedFromWebview({ type })), { type });
    }
  });

  it("asks for the earlier version's artboard only with side 'before'", () => {
    assert.deepEqual(parseWebviewMessage({ type: 'loadArtboard', id: 'a', knownImages: ['x'], side: 'before' }), { type: 'loadArtboard', id: 'a', knownImages: ['x'], side: 'before' });
    assert.deepEqual(parseWebviewMessage({ type: 'loadArtboard', id: 'a', knownImages: [] }), { type: 'loadArtboard', id: 'a', knownImages: [] });
    for (const side of ['after', 'other', '', null, 1, ['before'], { side: 'before' }]) {
      assert.equal(parseWebviewMessage({ type: 'loadArtboard', id: 'a', knownImages: [], side }), null, JSON.stringify(side));
    }
  });

  it('keeps the existing limits for artboard requests of either version', () => {
    const tooMany = Array.from({ length: MESSAGE_LIMITS.knownImages + 1 }, (_, i) => `u${i}`);
    assert.equal(parseWebviewMessage({ type: 'loadArtboard', id: 'a', knownImages: tooMany, side: 'before' }), null);
    assert.equal(parseWebviewMessage({ type: 'loadArtboard', id: 'x'.repeat(MESSAGE_LIMITS.idLength + 1), knownImages: [], side: 'before' }), null);
  });
});
