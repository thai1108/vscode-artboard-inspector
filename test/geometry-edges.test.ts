import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bottom, contains, fmt, intersect, right, union } from '../src/render/geometry.ts';
import { measureBetween } from '../src/render/measure.ts';

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe('box edge cases', () => {
  it('computes edges', () => {
    assert.equal(right(box(10, 0, 5, 1)), 15);
    assert.equal(bottom(box(0, -4, 1, 10)), 6);
  });

  it('returns the box itself as the union of one box', () => {
    assert.deepEqual(union([box(3, 4, 5, 6)]), box(3, 4, 5, 6));
  });

  it('keeps zero-size intersections of touching boxes and rejects separated ones', () => {
    assert.deepEqual(intersect(box(0, 0, 10, 10), box(10, 0, 10, 10)), box(10, 0, 0, 10));
    assert.equal(intersect(box(0, 0, 10, 10), box(10.01, 0, 1, 1)), null);
  });

  it('does not treat a box sticking out on one side as contained', () => {
    assert.ok(!contains(box(0, 0, 10, 10), box(5, 5, 6, 1)));
    assert.ok(contains(box(0, 0, 10, 10), box(2, 2, 0, 0)));
  });

  it('rounds display values to two decimals', () => {
    assert.equal(fmt(1.005 + 1e-9), '1.01');
    assert.equal(fmt(-12.346), '-12.35');
    assert.equal(fmt(1e-7), '0');
  });
});

describe('measureBetween to the left and above', () => {
  it('measures a hovered box on the left, through the shared rows', () => {
    const guides = measureBetween(box(100, 0, 50, 20), box(0, 10, 40, 20));
    assert.deepEqual(guides, [{ x1: 40, y1: 15, x2: 100, y2: 15, value: 60 }]);
  });

  it('measures a hovered box above, through the shared columns', () => {
    const guides = measureBetween(box(0, 100, 50, 20), box(20, 0, 60, 30));
    assert.deepEqual(guides, [{ x1: 35, y1: 30, x2: 35, y2: 100, value: 70 }]);
  });

  it('extends the guide from a diagonal neighbour above-left', () => {
    const guides = measureBetween(box(50, 50, 10, 10), box(0, 0, 10, 10));
    assert.deepEqual(guides, [
      { x1: 10, y1: 55, x2: 50, y2: 55, value: 40 },
      { x1: 10, y1: 10, x2: 10, y2: 55 },
      { x1: 55, y1: 10, x2: 55, y2: 50, value: 40 },
      { x1: 10, y1: 10, x2: 55, y2: 10 },
    ]);
  });

  it('shows nothing for identical boxes', () => {
    assert.deepEqual(measureBetween(box(1, 1, 5, 5), box(1, 1, 5, 5)), []);
  });
});
