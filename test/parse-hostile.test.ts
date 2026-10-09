import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgcNode } from '../src/xd/agc.ts';
import { XdDocument } from '../src/xd/parse.ts';
import type { GroupNode, ShapeNode, TextNode } from '../src/scene/scene.ts';
import { ZipArchive } from '../src/zip.ts';
import { buildXd, rgb } from './support/xdFixture.ts';
import { writeZip, type ZipInput } from './support/zipWriter.ts';

const BOUNDS = { x: 0, y: 0, width: 100, height: 100 };

function open(files: ZipInput[]): XdDocument {
  return XdDocument.open(ZipArchive.open(writeZip(files)));
}

function manifestWith(artboards: { name: string; path: string; bounds?: typeof BOUNDS }[]): ZipInput {
  return {
    name: 'manifest',
    data: JSON.stringify({ children: [{ name: 'artwork', path: 'artwork', children: artboards.map((a) => ({ name: a.name, path: a.path, 'uxdesign#bounds': a.bounds })) }] }),
  };
}

function sceneOf(children: AgcNode[], resources: AgcNode[] = []) {
  return buildXd({ artboards: [{ id: 'artboard-a', name: 'A', bounds: BOUNDS, children }], resources }).scene('artboard-a');
}

describe('malformed XD archives', () => {
  it('fails on a manifest that is not JSON', () => {
    assert.throws(() => open([{ name: 'manifest', data: '{not json' }]), SyntaxError);
  });

  it('lists artboards found anywhere in the manifest and ignores entries without bounds', () => {
    const doc = open([
      {
        name: 'manifest',
        data: JSON.stringify({
          children: [
            { name: 'artwork', path: 'artwork', children: [{ name: 'Nested', path: 'group', children: [{ name: 'Deep', path: 'artboard-deep', 'uxdesign#bounds': BOUNDS }] }] },
            { name: 'No bounds', path: 'artboard-nobounds' },
            { name: 'Not an artboard', path: 'pasteboard', 'uxdesign#bounds': BOUNDS },
          ],
        }),
      },
    ]);
    assert.deepEqual(
      doc.artboards.map((a) => a.id),
      ['artboard-deep'],
    );
  });

  it('names the missing graphics file when an artboard has no AGC', () => {
    const doc = open([manifestWith([{ name: 'Ghost', path: 'artboard-ghost', bounds: BOUNDS }])]);
    assert.throws(() => doc.scene('artboard-ghost'), /ZIP entry not found: artwork\/artboard-ghost\/graphics\/graphicContent\.agc/);
  });

  it('fails clearly when the AGC has no artboard node', () => {
    const doc = open([
      manifestWith([{ name: 'Empty', path: 'artboard-e', bounds: BOUNDS }]),
      { name: 'artwork/artboard-e/graphics/graphicContent.agc', data: JSON.stringify({ children: [{ type: 'group', group: { children: [] } }] }) },
    ]);
    assert.throws(() => doc.scene('artboard-e'), /Artboard graphics missing: Empty/);
  });

  it('fails on an AGC that is not JSON', () => {
    const doc = open([manifestWith([{ name: 'Bad', path: 'artboard-b', bounds: BOUNDS }]), { name: 'artwork/artboard-b/graphics/graphicContent.agc', data: '[[[' }]);
    assert.throws(() => doc.scene('artboard-b'), SyntaxError);
  });

  it('still opens files without a resources AGC and finds linked layers in other artboards', () => {
    const shared: AgcNode = { type: 'shape', id: 'shared', name: 'Shared', shape: { type: 'rect', width: 5, height: 5 } };
    const doc = open([
      manifestWith([
        { name: 'One', path: 'artboard-1', bounds: BOUNDS },
        { name: 'Two', path: 'artboard-2', bounds: { ...BOUNDS, x: 200 } },
      ]),
      { name: 'artwork/artboard-1/graphics/graphicContent.agc', data: JSON.stringify({ children: [{ type: 'artboard', artboard: { children: [{ type: 'syncRef', syncSourceGuid: 'shared' }] } }] }) },
      { name: 'artwork/artboard-2/graphics/graphicContent.agc', data: JSON.stringify({ children: [{ type: 'artboard', artboard: { children: [shared] } }] }) },
    ]);
    const scene = doc.scene('artboard-1');
    assert.deepEqual(scene.warnings, []);
    assert.equal(scene.children[0]?.name, 'Shared');
    assert.equal(scene.background, null);
  });
});

describe('unexpected layer content', () => {
  it('warns about unknown layer types, fills and broken paints', () => {
    const scene = sceneOf([
      { type: 'hologram', id: 'h', name: 'Hologram' } as unknown as AgcNode,
      { type: 'shape', id: 'a', name: 'Angular', shape: { type: 'rect', width: 1, height: 1 }, style: { fill: { type: 'angular' } } },
      { type: 'shape', id: 'g', name: 'No stops', shape: { type: 'rect', width: 1, height: 1 }, style: { fill: { type: 'gradient', gradient: {} } } },
      { type: 'shape', id: 'p', name: 'No image', shape: { type: 'rect', width: 1, height: 1 }, style: { fill: { type: 'pattern', pattern: { width: 1, height: 1 } } } },
      { type: 'shape', id: 'poly', name: 'Empty polygon', shape: { type: 'polygon', points: [] } },
    ]);
    assert.deepEqual(scene.warnings, [
      'Unsupported layer type "hologram" ("Hologram")',
      'Unsupported fill "angular" ("Angular")',
      'Gradient without stops ("No stops")',
      'Image fill without image data ("No image")',
      'Unsupported shape "polygon" ("Empty polygon")',
    ]);
    assert.equal(scene.children.length, 3);
    assert.ok((scene.children as ShapeNode[]).every((node) => node.fill === null));
    assert.deepEqual(scene.imageUids, []);
  });

  it('labels unnamed layers by id in warnings', () => {
    const scene = sceneOf([{ type: 'shape', id: 'abc-123', shape: { type: 'path' } }]);
    assert.deepEqual(scene.warnings, ['Unsupported shape "path" (abc-123)']);
  });

  it('ignores hidden effects and drops zero-width or disabled strokes', () => {
    const scene = sceneOf([
      {
        type: 'shape',
        id: 's',
        shape: { type: 'rect', width: 1, height: 1, r: [3] },
        style: {
          stroke: { type: 'solid', width: 0, color: rgb(0, 0, 0) },
          filters: [{ type: 'dropShadow', visible: false, params: { dropShadows: [{ dx: 1, dy: 1, r: 1, color: rgb(0, 0, 0) }] } }],
        },
      },
      { type: 'shape', id: 'n', shape: { type: 'rect', width: 1, height: 1 }, style: { stroke: { type: 'none', width: 2 } } },
    ]);
    const [first, second] = scene.children as ShapeNode[];
    assert.equal(first?.stroke, null);
    assert.deepEqual(first?.shadows, []);
    assert.deepEqual(first?.geometry.type === 'rect' && first.geometry.radii, [3, 0, 0, 0]);
    assert.equal(second?.stroke, null);
    assert.deepEqual(scene.warnings, []);
  });

  it('lets a linked layer override its source children', () => {
    const master: AgcNode = { type: 'group', id: 'card', name: 'Card', group: { children: [{ type: 'shape', id: 'old', name: 'Old', shape: { type: 'rect', width: 1, height: 1 } }] } };
    const scene = sceneOf([{ type: 'syncRef', syncSourceGuid: 'card', group: { children: [{ type: 'shape', id: 'new', name: 'New', shape: { type: 'rect', width: 2, height: 2 } }] } }], [master]);
    const card = scene.children[0] as GroupNode;
    assert.equal(card.name, 'Card');
    assert.deepEqual(card.children.map((child) => child.name), ['New']);
  });
});

describe('text edge cases', () => {
  const textNode = (node: Partial<Extract<AgcNode, { type: 'text' }>>) =>
    sceneOf([{ type: 'text', id: 't', text: { rawText: 'Hi', paragraphs: [{ lines: [[{ from: 0, to: 2, y: 0 }]] }] }, ...node } as AgcNode]).children[0] as TextNode;

  it('treats auto-height text as area text', () => {
    const node = textNode({ text: { rawText: 'Hi', frame: { type: 'autoHeight', width: 120 }, paragraphs: [] } });
    assert.deepEqual(node.frame, { type: 'area', width: 120, height: 0 });
  });

  it('falls back to node styles, detects italics and unknown transforms', () => {
    const node = textNode({
      style: { font: { family: 'Inter', style: 'Bold Italic', size: 13 }, fill: { type: 'solid', color: rgb(10, 20, 30) }, textAttributes: { letterSpacing: 25 } },
      meta: { ux: { rangedStyles: [{ length: 2, textTransform: 'smallcaps', fill: { value: 0x80ff0000 } }] } },
    });
    const [style] = node.styles;
    assert.equal(style?.family, 'Inter');
    assert.equal(style?.weight, 700);
    assert.equal(style?.italic, true);
    assert.equal(style?.size, 13);
    assert.equal(style?.letterSpacing, 25);
    assert.equal(style?.textTransform, 'none');
    assert.deepEqual(style?.color, { r: 255, g: 0, b: 0, a: 128 / 255 });
    assert.equal(node.lines[0]?.x, 0);
  });

  it('uses defaults when the text has no style at all', () => {
    const [style] = textNode({}).styles;
    assert.deepEqual(style, {
      family: 'sans-serif',
      fontStyle: 'Regular',
      weight: 400,
      italic: false,
      size: 12,
      color: { r: 0, g: 0, b: 0, a: 1 },
      letterSpacing: 0,
      underline: false,
      strikethrough: false,
      textTransform: 'none',
    });
  });

  it('drops empty lines and newline-only runs', () => {
    const node = sceneOf([
      { type: 'text', id: 't', text: { rawText: 'a\n\nb', paragraphs: [{ lines: [[{ from: 0, to: 2, x: 0, y: 0 }]] }, { lines: [[]] }, { lines: [[{ from: 2, to: 3, x: 0, y: 20 }], [{ from: 3, to: 4, x: 0, y: 40 }]] }] } },
    ]).children[0] as TextNode;
    assert.deepEqual(
      node.lines.map((line) => [line.y, line.runs.map((run) => run.text).join('')]),
      [
        [0, 'a'],
        [40, 'b'],
      ],
    );
  });

  it('carries a pending x past an empty segment to the next run', () => {
    const node = sceneOf([
      { type: 'text', id: 't', text: { rawText: 'a\nb', paragraphs: [{ lines: [[{ from: 0, to: 1, x: 0, y: 0 }, { from: 1, to: 2, x: 30, y: 0 }, { from: 2, to: 3, y: 0 }]] }] } },
    ]).children[0] as TextNode;
    assert.deepEqual(node.lines[0]?.runs, [
      { text: 'a', style: 0 },
      { text: 'b', style: 0, x: 30 },
    ]);
  });
});

describe('image sniffing', () => {
  const doc = buildXd({
    artboards: [],
    images: {
      jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]),
      gif: Buffer.from('GIF89a'),
      webp: Buffer.from('RIFF\0\0\0\0WEBPVP8 '),
      svg: Buffer.from('  <?xml version="1.0"?><svg/>'),
      other: Buffer.from('plain bytes'),
    },
  });

  it('detects common image types and falls back to octet-stream', () => {
    assert.deepEqual(
      ['jpeg', 'gif', 'webp', 'svg', 'other'].map((uid) => doc.image(uid)?.mime),
      ['image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'application/octet-stream'],
    );
  });
});
