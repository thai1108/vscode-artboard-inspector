import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { backgroundValue, cssForNode } from '../src/render/css.ts';
import { group, shape, stroke, text, textStyle } from './support/sceneBuilders.ts';

const box = { x: 0, y: 0, width: 135, height: 124 };

describe('cssForNode', () => {
  it('describes a rectangle with fill, inside border, radius, shadow and opacity', () => {
    const node = shape({
      geometry: { type: 'rect', x: 0, y: 0, width: 135, height: 124, radii: [8, 8, 8, 8] },
      fill: { kind: 'solid', color: { r: 255, g: 255, b: 255, a: 1 } },
      stroke: stroke({ color: { r: 112, g: 112, b: 112, a: 1 }, align: 'inside' }),
      shadows: [{ x: 0, y: 3, blur: 6, color: { r: 0, g: 0, b: 0, a: 0.16 } }],
      opacity: 0.5,
    });
    assert.deepEqual(cssForNode(node, box), [
      {
        label: null,
        declarations: [
          'width: 135px;',
          'height: 124px;',
          'background: #FFFFFF;',
          'border: 1px solid #707070;',
          'border-radius: 8px;',
          'box-shadow: 0 3px 6px rgba(0, 0, 0, 0.16);',
          'opacity: 0.5;',
        ],
      },
    ]);
  });

  it('notes non-inside strokes, per-corner radii and circles', () => {
    const outside = shape({
      geometry: { type: 'rect', x: 0, y: 0, width: 20, height: 20, radii: [4, 4, 0, 0] },
      stroke: stroke({ width: 2, align: 'outside', dash: [2, 2] }),
    });
    assert.deepEqual(cssForNode(outside, box)[0]?.declarations.slice(2), ['border: 2px dashed #000000; /* outside stroke */', 'border-radius: 4px 4px 0 0;']);
    const circle = shape({ geometry: { type: 'ellipse', cx: 5, cy: 5, rx: 5, ry: 5 } });
    assert.deepEqual(cssForNode(circle, box)[0]?.declarations.slice(2), ['border-radius: 50%;']);
  });

  it('turns lines into a top or left border', () => {
    const line = stroke({ color: { r: 221, g: 221, b: 221, a: 1 } });
    const horizontal = shape({ geometry: { type: 'line', x1: 0, y1: 0, x2: 155, y2: 0 }, stroke: line });
    assert.deepEqual(cssForNode(horizontal, { x: 0, y: 0, width: 155, height: 0 })[0]?.declarations, ['width: 155px;', 'height: 0;', 'border-top: 1px solid #DDDDDD;']);
    const vertical = shape({ geometry: { type: 'line', x1: 0, y1: 0, x2: 0, y2: 30 }, stroke: line });
    assert.match(cssForNode(vertical, box)[0]?.declarations[2] ?? '', /^border-left:/);
  });

  it('describes text, with one block per style when the text is mixed', () => {
    const single = text({ align: 'center', styles: [textStyle({ letterSpacing: 50, underline: true })] });
    assert.deepEqual(cssForNode(single, box), [
      {
        label: null,
        declarations: [
          'font-family: "Noto Sans";',
          'font-size: 16px;',
          'font-weight: 500; /* Medium */',
          'line-height: 19px;',
          'letter-spacing: 0.8px;',
          'color: #333333;',
          'text-align: center;',
          'text-decoration: underline;',
        ],
      },
    ]);
    const mixed = text({
      lineHeight: null,
      styles: [textStyle(), textStyle({ weight: 700, fontStyle: 'Bold', textTransform: 'titlecase' })],
      lines: [{ x: 0, y: 16, runs: [{ text: 'Price ', style: 0 }, { text: 'abcdefghijklmnopqrstuvwxyz', style: 1 }] }],
    });
    const blocks = cssForNode(mixed, box);
    assert.deepEqual(blocks.map((block) => block.label), ['Price ', 'abcdefghijklmnopqrstuvwx…']);
    assert.ok(blocks[1]?.declarations.includes('text-transform: capitalize;'));
    assert.ok(!blocks[0]?.declarations.some((d) => d.startsWith('line-height')));
  });

  it('gives groups their size and effects only', () => {
    assert.deepEqual(cssForNode(group([], { opacity: 0.8 }), { x: 0, y: 0, width: 10.004, height: 20.5 })[0]?.declarations, ['width: 10px;', 'height: 20.5px;', 'opacity: 0.8;']);
  });
});

describe('backgroundValue', () => {
  const stops = [
    { offset: 0, color: { r: 255, g: 255, b: 255, a: 1 } },
    { offset: 1, color: { r: 223, g: 223, b: 223, a: 1 } },
  ];

  it('converts bounding-box gradient vectors to CSS angles', () => {
    assert.equal(backgroundValue({ kind: 'linear', x1: 0.5, y1: 0, x2: 0.5, y2: 1, stops }, box), 'linear-gradient(180deg, #FFFFFF 0%, #DFDFDF 100%)');
    assert.equal(backgroundValue({ kind: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops }, box), 'linear-gradient(90deg, #FFFFFF 0%, #DFDFDF 100%)');
    assert.equal(backgroundValue({ kind: 'linear', x1: 0.5, y1: 1, x2: 0.5, y2: 0, stops }, box), 'linear-gradient(0deg, #FFFFFF 0%, #DFDFDF 100%)');
  });

  it('describes radial gradients and images', () => {
    assert.equal(backgroundValue({ kind: 'radial', cx: 0.5, cy: 0.5, r: 0.5, fx: 0.5, fy: 0.5, stops }, box), 'radial-gradient(circle at 50% 50%, #FFFFFF 0%, #DFDFDF 100%)');
    assert.equal(backgroundValue({ kind: 'image', uid: 'u', width: 1, height: 1, fit: 'cover' }, box), 'url("image.png") center / cover no-repeat');
  });
});
