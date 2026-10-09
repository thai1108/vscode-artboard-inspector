import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgcNode } from '../src/xd/agc.ts';
import { fontWeight } from '../src/scene/text.ts';
import { effectiveRanges, XdDocument } from '../src/xd/parse.ts';
import type { GroupNode, ShapeNode, TextNode } from '../src/scene/scene.ts';
import { ZipArchive } from '../src/zip.ts';
import { buildXd, PNG_BYTES, rgb } from './support/xdFixture.ts';
import { writeZip } from './support/zipWriter.ts';

const BOUNDS = { x: 1000, y: 0, width: 430, height: 800 };

function sceneOf(children: AgcNode[], resources: AgcNode[] = [], images: Record<string, Buffer> = {}) {
  const doc = buildXd({ artboards: [{ id: 'artboard-a', name: 'Top', bounds: BOUNDS, children, background: { r: 255, g: 255, b: 255 } }], resources, images });
  return doc.scene('artboard-a');
}

describe('XdDocument', () => {
  it('lists artboards in canvas order (rows top to bottom, then left to right)', () => {
    const doc = buildXd({
      artboards: [
        { id: 'artboard-c', name: ' C ', bounds: { x: 0, y: 2000, width: 10, height: 10 }, children: [] },
        { id: 'artboard-b', name: 'B', bounds: { x: 500, y: 0, width: 10, height: 10 }, children: [] },
        { id: 'artboard-a', name: 'A', bounds: { x: 0, y: 0, width: 430, height: 900 }, children: [] },
      ],
    });
    assert.deepEqual(
      doc.artboards.map((a) => [a.id, a.name]),
      [
        ['artboard-a', 'A'],
        ['artboard-b', 'B'],
        ['artboard-c', 'C'],
      ],
    );
    assert.equal(doc.artboards[0]?.height, 900);
  });

  it('rejects archives without a manifest and unknown artboards', () => {
    assert.throws(() => XdDocument.open(ZipArchive.open(writeZip([{ name: 'other.json', data: '{}' }]))), /Not an Adobe XD file/);
    const doc = buildXd({ artboards: [] });
    assert.throws(() => doc.scene('artboard-x'), /Unknown artboard/);
  });

  it('makes top-level transforms relative to the artboard and keeps nested ones local', () => {
    const scene = sceneOf([
      {
        type: 'group',
        id: 'g1',
        name: 'Card',
        transform: { tx: 1016, ty: 40 },
        group: {
          children: [
            { type: 'shape', id: 's1', name: 'Bg', transform: { tx: 4, ty: 5 }, shape: { type: 'rect', width: 100, height: 50, r: 8 }, style: { fill: { type: 'solid', color: rgb(255, 0, 0) } } },
          ],
        },
      },
    ]);
    assert.deepEqual(scene.background, { r: 255, g: 255, b: 255, a: 1 });
    const group = scene.children[0] as GroupNode;
    assert.equal(group.kind, 'group');
    assert.deepEqual(group.transform, { a: 1, b: 0, c: 0, d: 1, e: 16, f: 40 });
    const rect = group.children[0] as ShapeNode;
    assert.deepEqual(rect.transform, { a: 1, b: 0, c: 0, d: 1, e: 4, f: 5 });
    assert.deepEqual(rect.geometry, { type: 'rect', x: 0, y: 0, width: 100, height: 50, radii: [8, 8, 8, 8] });
    assert.deepEqual(rect.fill, { kind: 'solid', color: { r: 255, g: 0, b: 0, a: 1 } });
    assert.notEqual(group.key, rect.key);
  });

  it('resolves linked layers from component masters, with a unique key per use', () => {
    const master: AgcNode = { type: 'shape', id: 'm1', name: 'Icon', shape: { type: 'circle', cx: 5, cy: 5, r: 5 }, style: { fill: { type: 'solid', color: rgb(0, 0, 255) } } };
    const scene = sceneOf(
      [
        { type: 'syncRef', syncSourceGuid: 'm1' },
        { type: 'syncRef', syncSourceGuid: 'm1' },
        { type: 'syncRef', syncSourceGuid: 'missing' },
      ],
      [{ type: 'group', id: 'component', group: { children: [master] } }],
    );
    assert.equal(scene.children.length, 2);
    const [first, second] = scene.children as ShapeNode[];
    assert.equal(first?.name, 'Icon');
    assert.deepEqual(first?.geometry, { type: 'ellipse', cx: 5, cy: 5, rx: 5, ry: 5 });
    assert.notEqual(first?.key, second?.key);
    assert.deepEqual(scene.warnings, ['Linked layer source not found (missing)']);
  });

  it('skips hidden layers and reports unsupported content instead of dropping it silently', () => {
    const scene = sceneOf([
      { type: 'shape', id: 'h', visible: false, shape: { type: 'rect', width: 1, height: 1 } },
      { type: 'shape', id: 'p', name: 'Broken', shape: { type: 'path' } },
      { type: 'shape', id: 'b', name: 'Blurred', shape: { type: 'rect', width: 1, height: 1 }, style: { filters: [{ type: 'uiBlur' }] } },
    ]);
    assert.equal(scene.children.length, 1);
    assert.deepEqual(scene.warnings, ['Unsupported shape "path" ("Broken")', 'Effect "uiBlur" not rendered ("Blurred")']);
  });

  it('converts strokes, shadows, gradients and image fills', () => {
    const scene = sceneOf(
      [
        {
          type: 'shape',
          id: 's',
          shape: { type: 'rect', width: 10, height: 10, r: [1, 2, 3, 4] },
          style: {
            fill: {
              type: 'gradient',
              gradient: { x1: 0.5, y1: 0, x2: 0.5, y2: 1, meta: { ux: { gradientResources: { type: 'linear', stops: [{ offset: 0, color: rgb(255, 255, 255) }, { offset: 1, color: { ...rgb(0, 0, 0), alpha: 0.5 } }] } } } },
            },
            stroke: { type: 'solid', color: rgb(112, 112, 112), width: 2, align: 'inside', dash: [3, 1] },
            filters: [{ type: 'dropShadow', params: { dropShadows: [{ dx: 0, dy: 3, r: 3, color: { ...rgb(0, 0, 0), alpha: 0.16 } }] } }],
          },
        },
        {
          type: 'shape',
          id: 'img',
          shape: { type: 'rect', width: 40, height: 20 },
          style: { fill: { type: 'pattern', pattern: { width: 800, height: 600, meta: { ux: { uid: 'abc123', scaleBehavior: 'fill' } } } }, stroke: { type: 'none' } },
        },
        { type: 'shape', id: 'line', shape: { type: 'line', x1: 0, y1: 0, x2: 155, y2: 0 }, style: { stroke: { type: 'solid', color: rgb(0, 0, 0) } } },
        { type: 'shape', id: 'poly', shape: { type: 'polygon', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 3 }] } },
      ],
      [],
      { abc123: PNG_BYTES },
    );
    const [rect, image, line, polygon] = scene.children as ShapeNode[];
    assert.deepEqual(rect?.geometry.type === 'rect' && rect.geometry.radii, [1, 2, 3, 4]);
    assert.deepEqual(rect?.fill, {
      kind: 'linear',
      x1: 0.5,
      y1: 0,
      x2: 0.5,
      y2: 1,
      stops: [
        { offset: 0, color: { r: 255, g: 255, b: 255, a: 1 } },
        { offset: 1, color: { r: 0, g: 0, b: 0, a: 0.5 } },
      ],
    });
    assert.deepEqual(rect?.stroke, { color: { r: 112, g: 112, b: 112, a: 1 }, width: 2, align: 'inside', dash: [3, 1], cap: 'butt', join: 'miter' });
    assert.deepEqual(rect?.shadows, [{ x: 0, y: 3, blur: 6, color: { r: 0, g: 0, b: 0, a: 0.16 } }]);
    assert.deepEqual(image?.fill, { kind: 'image', uid: 'abc123', width: 800, height: 600, fit: 'cover' });
    assert.equal(image?.stroke, null);
    assert.equal(line?.stroke?.align, 'center');
    assert.deepEqual(polygon?.geometry, { type: 'path', d: 'M0,0 L4,0 L2,3 Z' });
    assert.deepEqual(scene.imageUids, ['abc123']);
  });

  it('serves images by uid with a sniffed mime type and refuses path-like uids', () => {
    const doc = buildXd({ artboards: [], images: { abc123: PNG_BYTES } });
    assert.equal(doc.image('abc123')?.mime, 'image/png');
    assert.equal(doc.image('missing'), undefined);
    assert.equal(doc.image('../manifest'), undefined);
  });

  it('marks components, repeat grids and mask groups', () => {
    const scene = sceneOf([
      { type: 'group', id: 'c', meta: { ux: { symbolId: 'sym' } }, group: { children: [] } },
      { type: 'group', id: 'r', meta: { ux: { repeatGrid: {} } }, group: { children: [] } },
      {
        type: 'group',
        id: 'm',
        meta: { ux: { clipPathResources: { children: [{ type: 'shape', id: 'clip', transform: { tx: 2 }, shape: { type: 'rect', width: 5, height: 5 } }] } } },
        group: { children: [] },
      },
    ]);
    const [component, grid, mask] = scene.children as GroupNode[];
    assert.equal(component?.role, 'component');
    assert.equal(grid?.role, 'repeatGrid');
    assert.equal(mask?.role, 'group');
    assert.equal(mask?.clip?.[0]?.transform.e, 2);
  });
});

describe('text conversion', () => {
  const text = (node: Partial<Extract<AgcNode, { type: 'text' }>>) => sceneOf([{ type: 'text', id: 't', text: { rawText: '' }, ...node } as AgcNode]).children[0] as TextNode;

  it('takes the style from ranged styles and splits runs at range boundaries', () => {
    const node = text({
      style: { font: { family: 'Noto Sans', style: 'Regular', size: 18 }, fill: { type: 'solid', color: rgb(51, 51, 51) }, textAttributes: { lineHeight: 22, paragraphAlign: 'center' } },
      meta: {
        ux: {
          rangedStyles: [
            { length: 0, fontSize: 18 },
            { length: 3, fontFamily: 'Noto Sans', fontStyle: 'Regular', fontSize: 14, fill: { value: 0xff333333 } },
            { length: 2, fontFamily: 'Noto Sans', fontStyle: 'Bold', fontSize: 14, fill: { value: 0xffcc0000 }, underline: true },
          ],
        },
      },
      text: {
        rawText: 'abc\nde',
        paragraphs: [
          { lines: [[{ from: 0, to: 3, x: -10, y: 0, style: { font: { family: 'Yu Gothic UI' } } }]] },
          { lines: [[{ from: 4, to: 5, x: -8, y: 22 }, { from: 5, to: 6, y: 22 }]] },
        ],
      },
    });
    assert.equal(node.align, 'center');
    assert.equal(node.lineHeight, 22);
    assert.deepEqual(
      node.styles.map((s) => [s.size, s.weight, s.color.r, s.underline]),
      [
        [14, 400, 51, false],
        [14, 700, 204, true],
      ],
    );
    assert.deepEqual(node.lines, [
      { x: -10, y: 0, runs: [{ text: 'abc', style: 0, glyphFont: 'Yu Gothic UI' }] },
      {
        x: -8,
        y: 22,
        runs: [
          { text: 'd', style: 1 },
          { text: 'e', style: 1 },
        ],
      },
    ]);
  });

  it('keeps explicit x positions of later segments on a line', () => {
    const node = text({
      style: { font: { family: 'Noto Sans', size: 10 } },
      text: { rawText: 'a b', paragraphs: [{ lines: [[{ from: 0, to: 1, x: 0, y: 10 }, { from: 1, to: 2, x: 5, y: 10 }, { from: 2, to: 3, x: 20, y: 10 }]] }] },
    });
    assert.deepEqual(node.lines[0]?.runs, [
      { text: 'a', style: 0 },
      { text: ' ', style: 0, x: 5 },
      { text: 'b', style: 0, x: 20 },
    ]);
  });

  it('uses the frame for area text', () => {
    const node = text({ text: { rawText: 'x', frame: { type: 'area', width: 236, height: 105 }, paragraphs: [] } });
    assert.deepEqual(node.frame, { type: 'area', width: 236, height: 105 });
    assert.deepEqual(node.lines, []);
  });
});

describe('effectiveRanges', () => {
  it('drops empty ranges and stretches the last one to the end of the text', () => {
    assert.deepEqual(
      effectiveRanges([{ length: 0, fontSize: 1 }, { length: 2, fontSize: 2 }, { length: 1, fontSize: 3 }], 5).map((r) => [r.from, r.to, r.style.fontSize]),
      [
        [0, 2, 2],
        [2, 5, 3],
      ],
    );
  });

  it('covers the whole text when every range is empty or there are none', () => {
    assert.deepEqual(effectiveRanges([{ length: 0, fontSize: 9 }], 4).map((r) => [r.from, r.to, r.style.fontSize]), [[0, 4, 9]]);
    assert.deepEqual(effectiveRanges([], 4).map((r) => [r.from, r.to]), [[0, 4]]);
  });
});

describe('fontWeight', () => {
  it('maps XD style names to CSS weights', () => {
    const cases: [string, number][] = [
      ['Thin', 100],
      ['ExtraLight', 200],
      ['Light', 300],
      ['Regular', 400],
      ['Medium', 500],
      ['SemiBold', 600],
      ['Semibold', 600],
      ['Bold', 700],
      ['ExtraBold', 800],
      ['Black', 900],
      ['Bold Italic', 700],
      ['W3', 300],
      ['W6', 600],
    ];
    for (const [style, weight] of cases) {
      assert.equal(fontWeight(style), weight, style);
    }
  });
});
