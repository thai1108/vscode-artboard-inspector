import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { layerBoxes, parsePath, pathBounds, pathSignature } from '../src/render/layerBoxes.ts';
import type { Box } from '../src/render/geometry.ts';
import { artboard, group, shape, text, textStyle } from './support/sceneBuilders.ts';

function close(actual: Box | null | undefined, expected: Box, what = 'box'): void {
  assert.ok(actual, `${what} exists`);
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-6, `${what}.${key}: ${actual[key]} ≠ ${expected[key]}`);
  }
}

const at = (x: number, y: number) => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });

describe('pathBounds', () => {
  it('measures lines, including H/V and relative commands', () => {
    close(pathBounds('M10 20 L30 5 H50 V40 Z'), { x: 10, y: 5, width: 40, height: 35 });
    close(pathBounds('m10,20 l20,-15 h20 v35 z'), { x: 10, y: 5, width: 40, height: 35 });
    close(pathBounds('M0 0 10 10 20 0'), { x: 0, y: 0, width: 20, height: 10 }, 'implicit lineto after moveto');
  });

  it('includes cubic and quadratic extrema, not their control points', () => {
    // A symmetric bump: the curve peaks at 3/4 of the control point height.
    close(pathBounds('M0 0 C0 100 100 100 100 0'), { x: 0, y: 0, width: 100, height: 75 });
    close(pathBounds('M0 0 Q50 100 100 0'), { x: 0, y: 0, width: 100, height: 50 });
    close(pathBounds('M0 0 C0 100 100 100 100 0 S200 -100 200 0'), { x: 0, y: -75, width: 200, height: 150 }, 'smooth cubic reflects');
    close(pathBounds('M0 0 Q50 100 100 0 T200 0'), { x: 0, y: -50, width: 200, height: 100 }, 'smooth quadratic reflects');
  });

  it('includes the extremes of elliptical arcs', () => {
    // Half circle of radius 50 from (0,50) to (100,50) through the top.
    close(pathBounds('M0 50 A50 50 0 0 1 100 50'), { x: 0, y: 0, width: 100, height: 50 });
    close(pathBounds('M0 50 A50 50 0 0 0 100 50'), { x: 0, y: 50, width: 100, height: 50 }, 'the other sweep');
    // Radii too small are scaled up to reach the end point.
    close(pathBounds('M0 0 A1 1 0 0 1 20 0'), { x: 0, y: -10, width: 20, height: 10 });
    close(pathBounds('M0 0 a1 1 0 0 1 20 0'), { x: 0, y: -10, width: 20, height: 10 }, 'relative arc');
  });

  it('stops at malformed data and returns null when nothing is drawn', () => {
    assert.equal(pathBounds(''), null);
    assert.equal(pathBounds('L10 10'), null, 'no moveto');
    close(pathBounds('M0 0 L10 10 C1 2'), { x: 0, y: 0, width: 10, height: 10 }, 'truncated curve ignored');
    assert.deepEqual(parsePath('M0 0 Z 5 5').map((command) => command.type), ['M', 'Z']);
  });
});

describe('pathSignature', () => {
  it('is the same wherever the path sits and however it is written', () => {
    const absolute = pathSignature('M10 10 L20 10 L20 20 Z');
    assert.equal(pathSignature('M110 50 L120 50 L120 60 Z'), absolute);
    assert.equal(pathSignature('m10,10 l10,0 v10 z'), absolute);
    assert.equal(pathSignature('M10.001 10 L20 10 L20 20 Z'), absolute, 'under 0.01');
    assert.notEqual(pathSignature('M10 10 L20 10 L25 20 Z'), absolute);
  });
});

describe('layerBoxes', () => {
  it('places shapes by their transforms and geometry, like the webview measures them', () => {
    const rect = shape({ key: 'r', transform: at(16, 40), geometry: { type: 'rect', x: 2, y: 3, width: 100, height: 40, radii: [0, 0, 0, 0] } });
    const circle = shape({ key: 'c', transform: at(0, 0), geometry: { type: 'ellipse', cx: 10, cy: 10, rx: 5, ry: 5 } });
    const line = shape({ key: 'l', geometry: { type: 'line', x1: 10, y1: 0, x2: 0, y2: 0 } });
    const icon = shape({ key: 'p', transform: at(5, 5), geometry: { type: 'path', d: 'M0 0 C0 100 100 100 100 0' } });
    const boxes = layerBoxes(artboard([rect, circle, line, icon]));
    close(boxes.get('r'), { x: 18, y: 43, width: 100, height: 40 });
    close(boxes.get('c'), { x: 5, y: 5, width: 10, height: 10 });
    close(boxes.get('l'), { x: 0, y: 0, width: 10, height: 0 });
    close(boxes.get('p'), { x: 5, y: 5, width: 100, height: 75 });
    assert.equal(boxes.get('r')?.estimated, 'none');
  });

  it('uses the box Figma reports when there is one', () => {
    const vector = shape({ key: 'v', transform: at(10, 10), geometry: { type: 'path', d: 'M2 2 L8 8' }, layoutSize: { width: 24, height: 24 } });
    close(layerBoxes(artboard([vector])).get('v'), { x: 10, y: 10, width: 24, height: 24 });
  });

  it('measures area text exactly and estimates only the width of positioned text', () => {
    const area = text({ key: 'a', transform: at(10, 20), frame: { type: 'area', width: 200, height: 48 } });
    const positioned = text({ key: 'p', transform: at(10, 100), styles: [textStyle({ size: 20 })], lines: [{ x: 0, y: 0, runs: [{ text: 'Hello', style: 0 }] }] });
    const boxes = layerBoxes(artboard([area, positioned]));
    close(boxes.get('a'), { x: 10, y: 20, width: 200, height: 48 });
    assert.equal(boxes.get('a')?.estimated, 'none');
    const box = boxes.get('p');
    assert.equal(box?.estimated, 'width');
    assert.ok(box && Math.abs(box.x - 10) < 1e-9 && Math.abs(box.y - (100 - 1.069 * 20)) < 1e-9, 'left and top come from the baseline');
    assert.ok(box && Math.abs(box.height - (1.069 + 0.293) * 20) < 1e-9);
    assert.ok(box && box.width > 40 && box.width < 80, `estimated width ${box?.width}`);
  });

  it('marks rotated positioned text as estimated everywhere', () => {
    const rotated = text({ key: 't', transform: { a: 0, b: 1, c: -1, d: 0, e: 50, f: 50 } });
    assert.equal(layerBoxes(artboard([rotated])).get('t')?.estimated, 'all');
  });

  it('sizes groups by their layers, cut by their mask, and passes estimates up', () => {
    const inner = group([shape({ key: 'a', transform: at(0, 0) }), shape({ key: 'b', transform: at(200, 100) })], {
      key: 'g',
      transform: at(10, 10),
      clip: [shape({ geometry: { type: 'rect', x: 0, y: 0, width: 150, height: 120, radii: [0, 0, 0, 0] } })],
    });
    const labelled = group([shape({ key: 'bg' }), text({ key: 'label', transform: at(4, 30) })], { key: 'h' });
    const empty = group([], { key: 'e' });
    const boxes = layerBoxes(artboard([inner, labelled, empty]));
    close(boxes.get('g'), { x: 10, y: 10, width: 150, height: 120 });
    assert.equal(boxes.get('g')?.estimated, 'none');
    assert.equal(boxes.get('h')?.estimated, 'width');
    assert.equal(boxes.has('e'), false, 'a group with nothing in it has no box');
  });

  it('gives a masked group without overlap no box, like the webview', () => {
    const outside = group([shape({ key: 'a', transform: at(500, 500) })], {
      key: 'g',
      clip: [shape({ geometry: { type: 'rect', x: 0, y: 0, width: 10, height: 10, radii: [0, 0, 0, 0] } })],
    });
    assert.equal(layerBoxes(artboard([outside])).has('g'), false);
  });
});
