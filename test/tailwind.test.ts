import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cssForNode } from '../src/render/css.ts';
import type { Box } from '../src/render/geometry.ts';
import { tailwindForNode } from '../src/render/tailwind.ts';
import type { Paint, SceneNode, ShapeNode } from '../src/scene/scene.ts';
import { group, shape, stroke, text, textStyle } from './support/sceneBuilders.ts';

const box = { x: 0, y: 0, width: 135, height: 124 };
const black = { r: 0, g: 0, b: 0, a: 1 };

function classes(node: SceneNode, at: Box = box): string {
  const blocks = tailwindForNode(node, at);
  assert.equal(blocks.length, 1);
  return blocks[0]?.classes.join(' ') ?? '';
}

function sized(width: number, height: number): string {
  return classes(shape(), { x: 0, y: 0, width, height });
}

const rect = (width: number, height: number, radii: [number, number, number, number], overrides: Partial<ShapeNode> = {}): ShapeNode =>
  shape({ geometry: { type: 'rect', x: 0, y: 0, width, height, radii }, ...overrides });

const square = (side: number): Box => ({ x: 0, y: 0, width: side, height: side });

const radius = (radii: [number, number, number, number]): string => classes(rect(100, 100, radii), square(100)).replace(/^size-25 ?/, '');

const typography = (overrides: Parameters<typeof textStyle>[0] = {}, node: Parameters<typeof text>[0] = {}): string =>
  classes(text({ ...node, styles: [textStyle(overrides)] }));

describe('tailwindForNode boxes', () => {
  it('describes a rectangle with fill, border, radius, shadow and opacity like its CSS', () => {
    const node = rect(135, 124, [8, 8, 8, 8], {
      fill: { kind: 'solid', color: { r: 255, g: 255, b: 255, a: 1 } },
      stroke: stroke({ color: { r: 112, g: 112, b: 112, a: 1 }, align: 'inside' }),
      shadows: [{ x: 0, y: 3, blur: 6, color: { r: 0, g: 0, b: 0, a: 0.16 } }],
      opacity: 0.5,
    });
    assert.equal(classes(node), 'w-[135px] h-31 bg-[#FFFFFF] border border-[#707070] rounded-lg shadow-[0_3px_6px_rgba(0,0,0,0.16)] opacity-50');
  });

  it('uses the spacing scale on the 4px grid, px and the classic half steps', () => {
    assert.equal(sized(16, 24), 'w-4 h-6');
    assert.equal(sized(40, 40), 'size-10');
    assert.equal(sized(1, 0), 'w-px h-0');
    assert.equal(sized(2, 6), 'w-0.5 h-1.5');
    assert.equal(sized(10, 14), 'w-2.5 h-3.5');
    assert.equal(sized(430, 932), 'w-[430px] h-233');
    assert.equal(sized(432, 1), 'w-108 h-px');
  });

  it('falls back to arbitrary lengths off the grid', () => {
    assert.equal(sized(13, 18), 'w-[13px] h-[18px]');
    assert.equal(sized(22, 22), 'size-[22px]');
    assert.equal(sized(191, 3), 'w-[191px] h-[3px]');
  });

  it('rounds fractional pixels the way the CSS does before matching the scale', () => {
    assert.equal(sized(15.999, 13.333), 'w-4 h-[13.33px]');
    assert.equal(sized(10.004, 10), 'size-2.5');
    assert.deepEqual(cssForNode(shape(), { x: 0, y: 0, width: 15.999, height: 13.333 })[0]?.declarations, ['width: 16px;', 'height: 13.33px;']);
    assert.equal(radius([7.999, 7.999, 7.999, 7.999]), 'rounded-lg');
    assert.equal(classes(group([], { opacity: 0.333 })), 'w-[135px] h-31 opacity-33');
    assert.equal(classes(group([], { opacity: 0.125 })), 'w-[135px] h-31 opacity-13');
    assert.ok(cssForNode(group([], { opacity: 0.125 }), box)[0]?.declarations.includes('opacity: 0.13;'));
  });

  it('writes colors as the same hex or rgba as the CSS, never a palette color', () => {
    const translucent = { r: 202, g: 67, b: 67, a: 0.5 };
    const node = rect(16, 16, [0, 0, 0, 0], { fill: { kind: 'solid', color: translucent }, stroke: stroke({ color: { r: 239, g: 68, b: 68, a: 1 }, align: 'inside' }) });
    assert.equal(classes(node, square(16)), 'size-4 bg-[rgba(202,67,67,0.5)] border border-[#EF4444]');
    assert.equal(typography({ color: { r: 202, g: 67, b: 67, a: 1 } }).split(' ').at(-1), 'text-[#CA4343]');
    assert.equal(typography({ color: { r: 0, g: 0, b: 0, a: 0.04 } }).split(' ').at(-1), 'text-[rgba(0,0,0,0.04)]');
  });

  it('gives groups their size and effects only, and frames their own box styling', () => {
    assert.equal(classes(group([], { opacity: 0.8 }), { x: 0, y: 0, width: 10.004, height: 20.5 }), 'w-2.5 h-[20.5px] opacity-80');
    const frame = group([], {
      frame: { width: 100, height: 100, radii: [16, 16, 16, 16], fill: { kind: 'solid', color: { r: 249, g: 250, b: 251, a: 1 } }, stroke: null },
      shadows: [{ x: 1, y: 1, blur: 1, color: black }],
    });
    assert.equal(classes(frame), 'w-[135px] h-31 bg-[#F9FAFB] rounded-2xl shadow-[1px_1px_1px_#000000]');
  });
});

describe('tailwindForNode borders', () => {
  it('maps widths to border, border-<n> or an arbitrary width, and dashes to border-dashed', () => {
    const border = (width: number, dash: number[] = []) => classes(rect(16, 16, [0, 0, 0, 0], { stroke: stroke({ width, dash, align: 'outside' }) }), square(16)).replace('size-4 ', '');
    assert.equal(border(1), 'border border-[#000000]');
    assert.equal(border(2, [2, 2]), 'border-2 border-dashed border-[#000000]');
    assert.equal(border(3), 'border-3 border-[#000000]');
    assert.equal(border(0.5), 'border-[0.5px] border-[#000000]');
    assert.equal(border(1.5), 'border-[1.5px] border-[#000000]');
    assert.equal(border(1.0001), 'border border-[#000000]');
  });

  it('writes one class per side that has a width, with the color once', () => {
    const node = rect(16, 16, [0, 0, 0, 0], { stroke: stroke({ width: 2, sides: [1, 0, 2, 0.5], color: { r: 229, g: 231, b: 235, a: 1 } }) });
    assert.equal(classes(node, square(16)), 'size-4 border-t border-[#E5E7EB] border-b-2 border-l-[0.5px]');
  });

  it('turns lines into a top or left border', () => {
    const line = stroke({ color: { r: 221, g: 221, b: 221, a: 1 } });
    const horizontal = shape({ geometry: { type: 'line', x1: 0, y1: 0, x2: 155, y2: 0 }, stroke: line });
    assert.equal(classes(horizontal, { x: 0, y: 0, width: 155, height: 0 }), 'w-[155px] h-0 border-t border-[#DDDDDD]');
    const vertical = shape({ geometry: { type: 'line', x1: 0, y1: 0, x2: 0, y2: 32 }, stroke: stroke({ width: 2 }) });
    assert.equal(classes(vertical, { x: 0, y: 0, width: 0, height: 32 }), 'w-0 h-8 border-l-2 border-[#000000]');
    assert.equal(classes(shape({ geometry: { type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 } }), { x: 0, y: 0, width: 10, height: 0 }), 'w-2.5 h-0');
  });
});

describe('tailwindForNode radius', () => {
  it('uses the v4 radius scale only for exact values', () => {
    const scale = [2, 4, 6, 8, 12, 16, 24, 32].map((r) => radius([r, r, r, r]));
    assert.deepEqual(scale, ['rounded-xs', 'rounded-sm', 'rounded-md', 'rounded-lg', 'rounded-xl', 'rounded-2xl', 'rounded-3xl', 'rounded-4xl']);
    assert.equal(radius([3, 3, 3, 3]), 'rounded-[3px]');
    assert.equal(radius([10, 10, 10, 10]), 'rounded-[10px]');
    assert.equal(radius([0, 0, 0, 0]), '');
  });

  it('groups equal corners by side, otherwise writes each rounded corner', () => {
    assert.equal(radius([4, 4, 0, 0]), 'rounded-t-sm');
    assert.equal(radius([0, 0, 8, 8]), 'rounded-b-lg');
    assert.equal(radius([3, 3, 5, 5]), 'rounded-t-[3px] rounded-b-[5px]');
    assert.equal(radius([12, 0, 0, 12]), 'rounded-l-xl');
    assert.equal(radius([0, 6, 6, 0]), 'rounded-r-md');
    assert.equal(radius([2, 4, 6, 8]), 'rounded-tl-xs rounded-tr-sm rounded-br-md rounded-bl-lg');
    assert.equal(radius([4, 0, 4, 0]), 'rounded-tl-sm rounded-br-sm');
    assert.equal(radius([0, 0, 0, 5]), 'rounded-bl-[5px]');
  });

  it('clamps radii like the CSS and rounds circles off', () => {
    assert.equal(classes(rect(100, 20, [999, 999, 999, 999]), { x: 0, y: 0, width: 100, height: 20 }), 'w-25 h-5 rounded-[10px]');
    const circle = shape({ geometry: { type: 'ellipse', cx: 5, cy: 5, rx: 5, ry: 5 } });
    assert.equal(classes(circle, square(10)), 'size-2.5 rounded-full');
    const ellipse = shape({ geometry: { type: 'ellipse', cx: 10, cy: 5, rx: 10, ry: 5 } });
    assert.equal(classes(ellipse, { x: 0, y: 0, width: 20, height: 10 }), 'w-5 h-2.5 rounded-[50%]');
    assert.equal(classes(shape({ geometry: { type: 'path', d: 'M0,0 L1,1' } }), square(8)), 'size-2');
  });
});

describe('tailwindForNode effects and fills', () => {
  it('writes every shadow as one arbitrary value with underscores for spaces', () => {
    const node = shape({
      shadows: [
        { x: 0, y: 1, blur: 2, color: { r: 0, g: 0, b: 0, a: 0.2 } },
        { x: -4, y: 0, blur: 0, color: { r: 255, g: 0, b: 0, a: 1 } },
      ],
    });
    assert.equal(classes(node).split(' ').at(-1), 'shadow-[0_1px_2px_rgba(0,0,0,0.2),-4px_0_0_#FF0000]');
  });

  it('writes gradients as arbitrary background images and images with position, size and repeat', () => {
    const stops = [
      { offset: 0, color: { r: 255, g: 255, b: 255, a: 1 } },
      { offset: 1, color: { r: 223, g: 223, b: 223, a: 0.5 } },
    ];
    const fill = (paint: Paint) => classes(shape({ fill: paint })).replace('w-[135px] h-31 ', '');
    assert.equal(fill({ kind: 'linear', x1: 0.5, y1: 0, x2: 0.5, y2: 1, stops }), 'bg-[linear-gradient(180deg,#FFFFFF_0%,rgba(223,223,223,0.5)_100%)]');
    assert.equal(fill({ kind: 'radial', cx: 0.5, cy: 0.5, r: 0.5, fx: 0.5, fy: 0.5, stops }), 'bg-[radial-gradient(circle_at_50%_50%,#FFFFFF_0%,rgba(223,223,223,0.5)_100%)]');
    assert.equal(fill({ kind: 'image', uid: 'u', width: 1, height: 1, fit: 'cover' }), 'bg-[url(image.png)] bg-center bg-cover bg-no-repeat');
    assert.equal(fill({ kind: 'image', uid: 'u', width: 1, height: 1, fit: 'contain' }), 'bg-[url(image.png)] bg-center bg-contain bg-no-repeat');
  });

  it('writes opacity as a percentage', () => {
    assert.equal(classes(group([], { opacity: 0 })), 'w-[135px] h-31 opacity-0');
    assert.equal(classes(group([], { opacity: 0.05 })), 'w-[135px] h-31 opacity-5');
  });
});

describe('tailwindForNode typography', () => {
  it('describes a text style in CSS order', () => {
    assert.equal(typography(), "font-['Noto_Sans'] text-base/[19px] font-medium text-[#333333]");
    const node = text({ align: 'center', opacity: 0.4, styles: [textStyle({ italic: true, letterSpacing: 50, underline: true, textTransform: 'uppercase' })] });
    assert.equal(classes(node), "font-['Noto_Sans'] text-base/[19px] font-medium italic tracking-wider text-[#333333] text-center underline uppercase opacity-40");
  });

  it('quotes font families and keeps their underscores', () => {
    assert.match(typography({ family: 'M PLUS 1p' }), /^font-\['M_PLUS_1p'\] /);
    assert.match(typography({ family: 'Brand_Sans Display' }), /^font-\['Brand\\_Sans_Display'\] /);
  });

  it('uses a theme font size only when its own line height matches the design', () => {
    const size = (px: number, lineHeight: number | null) => typography({ size: px }, { lineHeight }).split(' ')[1];
    assert.equal(size(14, 20), 'text-sm');
    assert.equal(size(12, 16), 'text-xs');
    assert.equal(size(16, 24), 'text-base');
    assert.equal(size(18, 28), 'text-lg');
    assert.equal(size(20, 28), 'text-xl');
    assert.equal(size(24, 32), 'text-2xl');
    assert.equal(size(30, 36), 'text-3xl');
    assert.equal(size(36, 40), 'text-4xl');
    assert.equal(size(48, 48), 'text-5xl');
    assert.equal(size(128, 128), 'text-9xl');
    assert.equal(size(14, 24), 'text-sm/6');
    assert.equal(size(14, 22), 'text-sm/[22px]');
    assert.equal(size(14, 19.996), 'text-sm');
    assert.equal(size(13, 20), 'text-[13px]/5');
    assert.equal(size(13, 18), 'text-[13px]/[18px]');
    assert.equal(size(13.5, 19.5), 'text-[13.5px]/[19.5px]');
  });

  it('writes the bare font size when the line height is auto, since theme sizes bring their own', () => {
    const node = text({ lineHeight: null, styles: [textStyle({ size: 14 })] });
    assert.equal(classes(node), "font-['Noto_Sans'] text-[14px] font-medium text-[#333333]");
    assert.ok(!cssForNode(node, box)[0]?.declarations.some((d) => d.startsWith('line-height')));
  });

  it('maps every named weight and keeps other weights arbitrary', () => {
    const weight = (value: number) => typography({ weight: value }).split(' ')[2];
    assert.deepEqual(
      [100, 200, 300, 400, 500, 600, 700, 800, 900].map(weight),
      ['font-thin', 'font-extralight', 'font-light', 'font-normal', 'font-medium', 'font-semibold', 'font-bold', 'font-extrabold', 'font-black'],
    );
    assert.equal(weight(450), 'font-[450]');
  });

  it('uses the tracking scale for exact em values and the CSS pixels otherwise', () => {
    const tracking = (letterSpacing: number, size = 16) => typography({ letterSpacing, size }).split(' ').find((c) => c.startsWith('tracking-'));
    assert.equal(tracking(-50), 'tracking-tighter');
    assert.equal(tracking(-25), 'tracking-tight');
    assert.equal(tracking(25), 'tracking-wide');
    assert.equal(tracking(50, 13), 'tracking-wider');
    assert.equal(tracking(100), 'tracking-widest');
    assert.equal(tracking(30), 'tracking-[0.48px]');
    assert.equal(tracking(-20, 14), 'tracking-[-0.28px]');
    assert.equal(tracking(35.714285, 14), 'tracking-[0.5px]');
    assert.equal(typography({ letterSpacing: 0 }).includes('tracking'), false);
  });

  it('maps alignment, decorations and transforms', () => {
    const last = (style: Parameters<typeof textStyle>[0], node: Parameters<typeof text>[0] = {}) => typography(style, node).split(' ').slice(4).join(' ');
    assert.equal(last({}, { align: 'right' }), 'text-right');
    assert.equal(last({}, { align: 'justify' }), 'text-justify');
    assert.equal(last({ strikethrough: true }), 'line-through');
    assert.equal(last({ underline: true, strikethrough: true }), '[text-decoration-line:underline_line-through]');
    assert.equal(last({ textTransform: 'titlecase' }), 'capitalize');
    assert.equal(last({ textTransform: 'lowercase' }), 'lowercase');
  });

  it('writes one block per style of mixed text, labelled like the CSS', () => {
    const node = text({
      lineHeight: 24,
      styles: [textStyle(), textStyle({ weight: 700, fontStyle: 'Bold', color: { r: 202, g: 67, b: 67, a: 1 } })],
      lines: [{ x: 0, y: 16, runs: [{ text: 'Price ', style: 0 }, { text: 'abcdefghijklmnopqrstuvwxyz', style: 1 }] }],
    });
    const blocks = tailwindForNode(node, box);
    assert.deepEqual(
      blocks.map((block) => block.label),
      cssForNode(node, box).map((block) => block.label),
    );
    assert.deepEqual(blocks, [
      { label: 'Price ', classes: ["font-['Noto_Sans']", 'text-base', 'font-medium', 'text-[#333333]'] },
      { label: 'abcdefghijklmnopqrstuvwx…', classes: ["font-['Noto_Sans']", 'text-base', 'font-bold', 'text-[#CA4343]'] },
    ]);
  });
});
