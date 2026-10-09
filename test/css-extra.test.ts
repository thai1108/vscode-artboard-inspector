import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { backgroundValue, borderRadius, borderValue, cssForNode, shadowValue } from '../src/render/css.ts';
import { group, shape, stroke, text, textStyle } from './support/sceneBuilders.ts';

const box = { x: 0, y: 0, width: 200, height: 100 };

describe('cssForNode text details', () => {
  it('adds italic, both decorations, transforms and opacity', () => {
    const node = text({
      opacity: 0.4,
      align: 'right',
      styles: [textStyle({ italic: true, underline: true, strikethrough: true, textTransform: 'uppercase', color: { r: 0, g: 0, b: 0, a: 0.5 } })],
    });
    const [block] = cssForNode(node, box);
    assert.ok(block);
    assert.ok(block.declarations.includes('font-style: italic;'));
    assert.ok(block.declarations.includes('text-decoration: underline line-through;'));
    assert.ok(block.declarations.includes('text-transform: uppercase;'));
    assert.ok(block.declarations.includes('text-align: right;'));
    assert.ok(block.declarations.includes('color: rgba(0, 0, 0, 0.5);'));
    assert.equal(block.declarations.at(-1), 'opacity: 0.4;');
  });

  it('maps lowercase and leaves letter spacing out when it is zero', () => {
    const [block] = cssForNode(text({ styles: [textStyle({ textTransform: 'lowercase' })] }), box);
    assert.ok(block?.declarations.includes('text-transform: lowercase;'));
    assert.ok(!block?.declarations.some((d) => d.startsWith('letter-spacing')));
  });

  it('labels each style with the text it is used for, even across lines', () => {
    const node = text({
      styles: [textStyle(), textStyle({ weight: 700 })],
      lines: [
        { x: 0, y: 16, runs: [{ text: 'Total ', style: 0 }, { text: '$4', style: 1 }] },
        { x: 0, y: 36, runs: [{ text: '2.00', style: 1 }] },
      ],
    });
    assert.deepEqual(
      cssForNode(node, box).map((b) => b.label),
      ['Total ', '$42.00'],
    );
  });
});

describe('cssForNode shapes and groups', () => {
  it('lists every shadow and uses rgba for translucent colors', () => {
    const node = shape({
      shadows: [
        { x: 0, y: 1, blur: 2, color: { r: 0, g: 0, b: 0, a: 0.2 } },
        { x: -4, y: 0, blur: 0, color: { r: 255, g: 0, b: 0, a: 1 } },
      ],
    });
    assert.ok(cssForNode(node, box)[0]?.declarations.includes('box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2), -4px 0 0 #FF0000;'));
  });

  it('skips background and border for shapes without fill or stroke, and paths get no radius', () => {
    const path = shape({ geometry: { type: 'path', d: 'M0,0 L1,1' } });
    assert.deepEqual(cssForNode(path, box)[0]?.declarations, ['width: 200px;', 'height: 100px;']);
    assert.equal(borderRadius(path), null);
  });

  it('writes nothing for a line without a stroke', () => {
    const line = shape({ geometry: { type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 } });
    assert.deepEqual(cssForNode(line, box)[0]?.declarations, ['width: 200px;', 'height: 100px;']);
  });

  it('adds shadow and opacity to groups', () => {
    const node = group([], { opacity: 0.25, shadows: [{ x: 1, y: 1, blur: 1, color: { r: 0, g: 0, b: 0, a: 1 } }] });
    assert.deepEqual(cssForNode(node, box)[0]?.declarations.slice(2), ['box-shadow: 1px 1px 1px #000000;', 'opacity: 0.25;']);
  });
});

describe('css value helpers', () => {
  it('clamps radii to half the shorter side and treats square corners as none', () => {
    const pill = shape({ geometry: { type: 'rect', x: 0, y: 0, width: 100, height: 20, radii: [999, 999, 999, 999] } });
    assert.equal(borderRadius(pill), '10px');
    const square = shape({ geometry: { type: 'rect', x: 0, y: 0, width: 10, height: 10, radii: [0, 0, 0, 0] } });
    assert.equal(borderRadius(square), null);
    assert.equal(borderRadius(text()), null);
    assert.equal(borderRadius(group([])), null);
  });

  it('keeps translucent gradient stops and contain-fitted images', () => {
    const stops = [
      { offset: 0, color: { r: 0, g: 0, b: 0, a: 0 } },
      { offset: 0.5, color: { r: 255, g: 255, b: 255, a: 0.5 } },
    ];
    assert.equal(
      backgroundValue({ kind: 'linear', x1: 0, y1: 0, x2: 1, y2: 1, stops }, { x: 0, y: 0, width: 100, height: 100 }),
      'linear-gradient(135deg, rgba(0, 0, 0, 0) 0%, rgba(255, 255, 255, 0.5) 50%)',
    );
    assert.equal(backgroundValue({ kind: 'image', uid: 'u', width: 1, height: 1, fit: 'contain' }, box), 'url("image.png") center / contain no-repeat');
  });

  it('formats borders and shadows on their own', () => {
    assert.equal(borderValue(stroke({ width: 0.5, color: { r: 1, g: 2, b: 3, a: 1 } })), '0.5px solid #010203');
    assert.equal(shadowValue({ x: 0, y: 0, blur: 0, color: { r: 0, g: 0, b: 0, a: 1 } }), '0 0 0 #000000');
  });
});
