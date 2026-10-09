import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contains, fmt, intersect, union } from '../src/render/geometry.ts';
import { measureBetween } from '../src/render/measure.ts';

describe('measureBetween', () => {
  it('shows the four insets when the hovered box contains the selection', () => {
    const guides = measureBetween({ x: 16, y: 10, width: 100, height: 20 }, { x: 0, y: 0, width: 430, height: 50 });
    assert.deepEqual(
      guides.map((g) => g.value),
      [10, 20, 16, 314],
    );
    assert.deepEqual(guides[0], { x1: 66, y1: 0, x2: 66, y2: 10, value: 10 });
  });

  it('measures from the inner box when the selection contains the hovered box, skipping zero insets', () => {
    const guides = measureBetween({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 20, width: 50, height: 50 });
    assert.deepEqual(
      guides.map((g) => g.value),
      [20, 30, 50],
    );
  });

  it('measures the vertical gap through the shared columns', () => {
    const guides = measureBetween({ x: 0, y: 0, width: 100, height: 20 }, { x: 50, y: 52, width: 100, height: 10 });
    assert.deepEqual(guides, [{ x1: 75, y1: 20, x2: 75, y2: 52, value: 32 }]);
  });

  it('adds a dashed extension when the boxes do not line up on the other axis', () => {
    const guides = measureBetween({ x: 0, y: 0, width: 10, height: 10 }, { x: 30, y: 40, width: 10, height: 10 });
    assert.deepEqual(guides, [
      { x1: 10, y1: 5, x2: 30, y2: 5, value: 20 },
      { x1: 30, y1: 40, x2: 30, y2: 5 },
      { x1: 5, y1: 10, x2: 5, y2: 40, value: 30 },
      { x1: 30, y1: 40, x2: 5, y2: 40 },
    ]);
  });

  it('shows nothing for partially overlapping boxes', () => {
    assert.deepEqual(measureBetween({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }), []);
  });
});

describe('box helpers', () => {
  it('unions, intersects and tests containment', () => {
    assert.deepEqual(union([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: -5, width: 5, height: 5 }]), { x: 0, y: -5, width: 25, height: 15 });
    assert.equal(union([]), null);
    assert.deepEqual(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }), { x: 5, y: 5, width: 5, height: 5 });
    assert.equal(intersect({ x: 0, y: 0, width: 1, height: 1 }, { x: 5, y: 5, width: 1, height: 1 }), null);
    assert.ok(contains({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 }));
  });

  it('formats display values with at most two decimals', () => {
    assert.equal(fmt(12), '12');
    assert.equal(fmt(12.504), '12.5');
    assert.equal(fmt(1 / 3), '0.33');
    assert.equal(fmt(-0.001), '0');
  });
});
