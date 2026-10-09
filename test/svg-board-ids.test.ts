import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderArtboardSvg } from '../src/render/svg.ts';
import { artboard, group, shape } from './support/sceneBuilders.ts';

describe('renderArtboardSvg id prefix', () => {
  it('prefixes every defs id and reference so several artboards can share one page', () => {
    const scene = artboard([
      group([shape({ key: 'c' })], { key: 'g', clip: [shape({ key: 'clip' })] }),
      shape({ key: 's', fill: { kind: 'linear', x1: 0, y1: 0, x2: 0, y2: 1, stops: [{ offset: 0, color: { r: 0, g: 0, b: 0, a: 1 } }] }, shadows: [{ x: 0, y: 1, blur: 2, color: { r: 0, g: 0, b: 0, a: 1 } }] }),
    ]);
    const svg = renderArtboardSvg(scene, () => undefined, 'dv7');
    const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    const refs = [...svg.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1]);
    assert.ok(ids.length >= 3);
    assert.ok(ids.every((id) => id?.startsWith('dv7-')), ids.join());
    assert.deepEqual([...new Set(refs)].sort(), [...ids].sort());
    assert.match(renderArtboardSvg(scene, () => undefined, 'x"><script>'), / id="x___script_-g-clip"/);
  });
});
