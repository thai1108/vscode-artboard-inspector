import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toCssColor, toHex } from '../src/scene/color.ts';
import { parseAgcColor } from '../src/xd/color.ts';

describe('colors', () => {
  it('parses RGB objects with alpha and packed ARGB integers', () => {
    assert.deepEqual(parseAgcColor({ mode: 'RGB', value: { r: 51, g: 51, b: 51 } }), { r: 51, g: 51, b: 51, a: 1 });
    assert.deepEqual(parseAgcColor({ value: { r: 0, g: 0, b: 0 }, alpha: 0.5 }), { r: 0, g: 0, b: 0, a: 0.5 });
    assert.deepEqual(parseAgcColor({ value: 4281545523 }), { r: 51, g: 51, b: 51, a: 1 });
    assert.deepEqual(parseAgcColor({ value: 0x80cc0000 }), { r: 204, g: 0, b: 0, a: 128 / 255 });
    assert.deepEqual(parseAgcColor(undefined), { r: 0, g: 0, b: 0, a: 1 });
  });

  it('formats hex and CSS colors', () => {
    assert.equal(toHex({ r: 10, g: 160, b: 251, a: 0.2 }), '#0AA0FB');
    assert.equal(toCssColor({ r: 10, g: 160, b: 251, a: 1 }), '#0AA0FB');
    assert.equal(toCssColor({ r: 0, g: 0, b: 0, a: 0.1607843 }), 'rgba(0, 0, 0, 0.16)');
  });
});
