import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { apply, IDENTITY, isIdentity, multiply, translate } from '../src/scene/matrix.ts';

describe('matrix helpers', () => {
  it('builds translations and recognizes the identity', () => {
    assert.deepEqual(translate(-1000, 20), { a: 1, b: 0, c: 0, d: 1, e: -1000, f: 20 });
    assert.ok(isIdentity(IDENTITY));
    assert.ok(isIdentity({ ...IDENTITY }));
    assert.ok(!isIdentity(translate(0, 1)));
    assert.ok(!isIdentity({ ...IDENTITY, b: 0.5 }));
  });

  it('multiplies with the right operand applied first', () => {
    const scale = { a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 };
    const moveThenScale = multiply(scale, translate(10, 10));
    assert.deepEqual(apply(moveThenScale, 0, 0), { x: 20, y: 30 });
    const scaleThenMove = multiply(translate(10, 10), scale);
    assert.deepEqual(apply(scaleThenMove, 1, 1), { x: 12, y: 13 });
  });

  it('keeps the identity neutral and composes rotations', () => {
    const quarter = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 };
    assert.deepEqual(multiply(IDENTITY, quarter), quarter);
    assert.deepEqual(multiply(quarter, IDENTITY), quarter);
    const half = multiply(quarter, quarter);
    assert.deepEqual(apply(half, 1, 0), { x: -1, y: 0 });
  });

  it('applies the full affine transform to a point', () => {
    assert.deepEqual(apply({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }, 1, 1), { x: 9, y: 12 });
  });
});
