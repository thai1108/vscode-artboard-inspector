import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateRawSync, zstdCompressSync } from 'node:zlib';
import { DEFAULT_FIG_LIMITS, readFigFile } from '../src/fig/container.ts';
import { commandsToPath } from '../src/fig/geometry.ts';
import { encodeSchema } from './support/kiwiWriter.ts';
import { FigDocument } from '../src/fig/parse.ts';
import type { GroupNode, ShapeNode, TextNode } from '../src/scene/scene.ts';
import { at, buildFig, commands, documentNodes, encodeCanvas, FIG_SCHEMA, guid, node, solid } from './support/figFixture.ts';
import { writeZip } from './support/zipWriter.ts';
import { PNG_BYTES } from './support/xdFixture.ts';

const open = (nodes: Parameters<typeof documentNodes>[0], options?: Parameters<typeof buildFig>[1]) => FigDocument.open(buildFig(documentNodes(nodes), options));

/** One artboard frame (id 10) with the given children, converted to a scene. */
function sceneOf(children: Parameters<typeof documentNodes>[0], frame: Record<string, unknown> = {}, options?: Parameters<typeof buildFig>[1]) {
  const doc = open([node(10, 1, 'FRAME', { name: 'Screen', size: { x: 390, y: 800 }, transform: at(100, 50), fillPaints: [solid(1, 1, 1)], ...frame }), ...children], options);
  return { doc, scene: doc.scene('1:10') };
}

describe('commandsToPath', () => {
  it('decodes move, line, quadratic, cubic and close commands', () => {
    const blob = commands([1, 0, 0], [2, 10, 0], [3, 10, 5, 5, 10], [4, 1, 2, 3, 4, 5, 6], [0]);
    assert.equal(commandsToPath(blob), 'M0 0L10 0Q10 5 5 10C1 2 3 4 5 6Z');
  });

  it('returns null for unknown commands or truncated coordinates', () => {
    assert.equal(commandsToPath(Uint8Array.from([9])), null);
    assert.equal(commandsToPath(commands([1, 0, 0]).subarray(0, 5)), null);
  });
});

describe('readFigFile', () => {
  it('reads a bare canvas as well as the ZIP container', () => {
    const nodes = documentNodes([]);
    assert.equal(readFigFile(encodeCanvas(nodes)).message.nodeChanges?.length, 2);
    assert.equal(readFigFile(buildFig(nodes)).message.nodeChanges?.length, 2);
  });

  it('rejects files that are not Figma canvases', () => {
    assert.throws(() => readFigFile(Buffer.from('not a figma file at all')), /unknown header/);
    assert.throws(() => readFigFile(writeZip([{ name: 'other.txt', data: 'x' }])), /canvas\.fig missing/);
  });

  it('caps decompressed sizes against decompression bombs', () => {
    const header = Buffer.alloc(12);
    header.write('fig-kiwi', 0, 'latin1');
    const chunk = (data: Buffer) => Buffer.concat([Buffer.from(Uint32Array.of(data.length).buffer), data]);
    const bomb = Buffer.concat([header, chunk(deflateRawSync(encodeSchema(FIG_SCHEMA))), chunk(zstdCompressSync(Buffer.alloc(4 * 1024 * 1024)))]);
    assert.throws(() => readFigFile(bomb, { ...DEFAULT_FIG_LIMITS, maxMessageBytes: 1024 * 1024 }), /too large to decompress/);
    const zipped = writeZip([{ name: 'canvas.fig', data: Buffer.alloc(2 * 1024 * 1024) }]);
    assert.throws(() => readFigFile(zipped, { ...DEFAULT_FIG_LIMITS, maxEntryBytes: 1024 * 1024 }), /ZIP entry too large: canvas\.fig/);
  });
});

describe('FigDocument artboards', () => {
  it('lists visible top-level frames per page, with section names, in canvas order', () => {
    const doc = FigDocument.open(
      buildFig([
        ...documentNodes([
          node(10, 1, 'FRAME', { name: 'Lower', size: { x: 10, y: 10 }, transform: at(0, 500) }, 'a'),
          node(11, 1, 'SECTION', { name: 'Flow', transform: at(0, 0) }, 'b'),
          node(12, 11, 'FRAME', { name: 'Right', size: { x: 20, y: 20 }, transform: at(300, 0) }),
          node(13, 11, 'FRAME', { name: 'Left', size: { x: 20, y: 20 }, transform: at(0, 0) }, 'b'),
          node(14, 1, 'FRAME', { name: 'Hidden', visible: false }, 'c'),
          node(15, 1, 'RECTANGLE', { name: 'Loose shape' }, 'd'),
        ]),
        { guid: guid(2), parentIndex: { guid: { sessionID: 0, localID: 0 }, position: 'b' }, type: 'CANVAS', name: 'Internal', internalOnly: true },
        node(20, 2, 'FRAME', { name: 'Library frame' }),
      ]),
    );
    assert.deepEqual(
      doc.artboards.map((a) => [a.id, a.name, a.width]),
      [
        ['1:13', 'Page 1 / Flow / Left', 20],
        ['1:12', 'Page 1 / Flow / Right', 20],
        ['1:10', 'Page 1 / Lower', 10],
      ],
    );
    assert.throws(() => doc.scene('1:99'), /Unknown artboard/);
  });
});

describe('FigDocument scenes', () => {
  it('uses a plain frame fill as the background and its children as top-level layers', () => {
    const { scene } = sceneOf([node(11, 10, 'RECTANGLE', { size: { x: 50, y: 20 }, transform: at(16, 8), fillPaints: [solid(1, 0, 0, 0.5)] })]);
    assert.deepEqual(scene.background, { r: 255, g: 255, b: 255, a: 1 });
    assert.equal(scene.width, 390);
    const rect = scene.children[0] as ShapeNode;
    assert.equal(rect.kind, 'shape');
    assert.deepEqual(rect.transform, { a: 1, b: 0, c: 0, d: 1, e: 16, f: 8 });
    assert.deepEqual(rect.fill, { kind: 'solid', color: { r: 255, g: 0, b: 0, a: 0.5 } });
    assert.deepEqual(rect.layoutSize, { width: 50, height: 20 });
  });

  it('keeps a styled artboard frame as one layer so its radius and border are drawn', () => {
    const { scene } = sceneOf([], { cornerRadius: 12, strokePaints: [solid(0, 0, 0)], strokeWeight: 2, strokeAlign: 'INSIDE' });
    const frame = scene.children[0] as GroupNode;
    assert.equal(scene.background, null);
    assert.equal(frame.role, 'frame');
    assert.deepEqual(frame.frame?.radii, [12, 12, 12, 12]);
    assert.equal(frame.frame?.stroke?.align, 'inside');
    assert.deepEqual(frame.transform, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  });

  it('converts nested frames with clipping, per-corner radii and per-side borders', () => {
    const { scene } = sceneOf([
      node(11, 10, 'FRAME', {
        name: 'Card',
        size: { x: 100, y: 40 },
        fillPaints: [solid(0, 0, 1)],
        rectangleCornerRadiiIndependent: true,
        rectangleTopLeftCornerRadius: 8,
        rectangleBottomLeftCornerRadius: 2,
        strokePaints: [solid(0, 0, 0)],
        borderStrokeWeightsIndependent: true,
        borderBottomWeight: 1,
        strokeAlign: 'INSIDE',
      }),
      node(12, 10, 'FRAME', { name: 'Group-like', size: { x: 10, y: 10 }, frameMaskDisabled: true }, 'b'),
    ]);
    const [card, unclipped] = scene.children as GroupNode[];
    assert.deepEqual(card?.frame?.radii, [8, 0, 0, 2]);
    assert.deepEqual(card?.frame?.stroke?.sides, [0, 0, 1, 0]);
    assert.equal(card?.frame?.stroke?.width, 1);
    assert.deepEqual(card?.clip?.[0]?.geometry, { type: 'rect', x: 0, y: 0, width: 100, height: 40, radii: [8, 0, 0, 2] });
    assert.equal(unclipped?.clip, null);
    assert.equal(unclipped?.frame, null);
  });

  it('draws vectors from their outline blobs, with the stroke outline filled in the stroke color', () => {
    const { scene } = sceneOf(
      [
        node(11, 10, 'VECTOR', {
          size: { x: 10, y: 10 },
          fillPaints: [solid(0, 1, 0)],
          strokePaints: [solid(0, 0, 0)],
          fillGeometry: [{ windingRule: 'NONZERO', commandsBlob: 0 }],
          strokeGeometry: [{ windingRule: 'NONZERO', commandsBlob: 1 }],
        }),
        node(12, 10, 'VECTOR', { size: { x: 4, y: 4 }, strokePaints: [solid(0, 0, 0)], strokeGeometry: [{ commandsBlob: 1 }] }, 'b'),
        node(13, 10, 'VECTOR', { name: 'Empty vector' }, 'c'),
      ],
      {},
      { blobs: [commands([1, 0, 0], [2, 10, 0], [2, 10, 10], [0]), commands([1, 0, 0], [2, 1, 0], [0])] },
    );
    const [filled, lineOnly] = scene.children as ShapeNode[];
    assert.deepEqual(filled?.geometry, { type: 'path', d: 'M0 0L10 0L10 10Z', fillRule: 'nonzero' });
    assert.equal(filled?.strokeOutline, 'M0 0L1 0Z');
    assert.equal(lineOnly?.fill, null);
    assert.equal(lineOnly?.strokeOutline, 'M0 0L1 0Z');
    assert.equal(scene.children.length, 2);
    assert.ok(scene.warnings.includes('Vector without outline data not drawn ("Empty vector")'));
  });

  it('positions text glyphs from the derived layout and applies per-range styles', () => {
    const { scene } = sceneOf([
      node(11, 10, 'TEXT', {
        size: { x: 120, y: 36 },
        fontName: { family: 'Inter', style: 'Regular' },
        fontSize: 12,
        lineHeight: { value: 150, units: 'PERCENT' },
        letterSpacing: { value: 10, units: 'PERCENT' },
        fillPaints: [solid(0.2, 0.2, 0.2)],
        textAlignHorizontal: 'CENTER',
        textData: {
          characters: 'ab\ncd',
          characterStyleIDs: [0, 3, 0, 0, 3],
          styleOverrideTable: [{ styleID: 3, fontName: { family: 'Inter', style: 'Semi Bold' }, fillPaints: [solid(1, 0, 0)] }],
        },
        derivedTextData: {
          baselines: [
            { position: { x: 2, y: 13 }, firstCharacter: 0, endCharacter: 3 },
            { position: { x: 4, y: 31 }, firstCharacter: 3, endCharacter: 5 },
          ],
          logicalIndexToCharacterOffsetMap: [0, 6, 12, 0, 7],
        },
      }),
    ]);
    const text = scene.children[0] as TextNode;
    assert.equal(text.content, 'ab\ncd');
    assert.equal(text.align, 'center');
    assert.equal(text.lineHeight, 18);
    assert.deepEqual(text.frame, { type: 'area', width: 120, height: 36 });
    assert.deepEqual(
      text.styles.map((s) => [s.weight, s.color.r, s.letterSpacing]),
      [
        [400, 51, 100],
        [600, 255, 100],
      ],
    );
    assert.deepEqual(text.lines, [
      { x: 2, y: 13, runs: [{ text: 'a', style: 0, xs: [2] }, { text: 'b', style: 1, xs: [8] }] },
      { x: 4, y: 31, runs: [{ text: 'c', style: 0, xs: [4] }, { text: 'd', style: 1, xs: [11] }] },
    ]);
  });

  it('expands instances from their component and applies overrides by override key', () => {
    const { scene } = sceneOf([
      node(20, 10, 'SYMBOL', { name: 'Button', size: { x: 80, y: 30 }, fillPaints: [solid(0, 0, 1)], transform: at(0, 400) }, 'z'),
      node(21, 20, 'ROUNDED_RECTANGLE', { name: 'Bg', overrideKey: guid(900), size: { x: 80, y: 30 }, fillPaints: [solid(0, 0, 1)] }),
      node(22, 20, 'TEXT', { name: 'Label', overrideKey: guid(901), textData: { characters: 'OK' }, fontSize: 12 }, 'b'),
      node(11, 10, 'INSTANCE', {
        name: 'Button instance',
        size: { x: 80, y: 30 },
        transform: at(10, 10),
        symbolData: {
          symbolID: guid(20),
          symbolOverrides: [
            { guidPath: { guids: [guid(900)] }, fillPaints: [solid(1, 0, 0)] },
            { guidPath: { guids: [guid(901)] }, textData: { characters: 'Send' } },
          ],
        },
        derivedSymbolData: [{ guidPath: { guids: [guid(901)] }, derivedTextData: { baselines: [{ position: { x: 0, y: 12 }, firstCharacter: 0, endCharacter: 4 }] } }],
      }),
    ]);
    const instance = scene.children.find((child) => child.name === 'Button instance') as GroupNode;
    assert.equal(instance.role, 'instance');
    assert.deepEqual(instance.transform.e, 10);
    const [bg, label] = instance.children as [ShapeNode, TextNode];
    assert.deepEqual(bg.fill, { kind: 'solid', color: { r: 255, g: 0, b: 0, a: 1 } });
    assert.equal(label.content, 'Send');
    assert.equal(label.lines[0]?.runs[0]?.text, 'Send');
    const component = scene.children.find((child) => child.name === 'Button') as GroupNode;
    assert.equal(component.role, 'component');
    assert.deepEqual((component.children[0] as ShapeNode).fill, { kind: 'solid', color: { r: 0, g: 0, b: 255, a: 1 } });
  });

  it('stops at a component that contains an instance of itself', () => {
    const { scene } = sceneOf([
      node(20, 10, 'SYMBOL', { name: 'Loop', size: { x: 10, y: 10 } }, 'z'),
      node(21, 20, 'INSTANCE', { name: 'Inner', symbolData: { symbolID: guid(20) } }),
      node(11, 10, 'INSTANCE', { name: 'Outer', symbolData: { symbolID: guid(20) } }),
    ]);
    assert.ok(scene.warnings.includes('Component "Loop" contains an instance of itself; not expanded'));
  });

  it('survives a parent cycle and reports unsupported layers instead of dropping them silently', () => {
    const { scene } = sceneOf([
      node(30, 31, 'FRAME', { name: 'Cycle A' }),
      node(31, 30, 'FRAME', { name: 'Cycle B' }),
      node(11, 10, 'STICKY', { name: 'Note' }),
    ]);
    assert.ok(scene.warnings.includes('Unsupported layer type "STICKY" ("Note")'));
  });

  it('converts gradients, image fills and drop shadows', () => {
    const hash = 'ab'.repeat(20);
    const { doc, scene } = sceneOf(
      [
        node(11, 10, 'RECTANGLE', {
          size: { x: 100, y: 50 },
          fillPaints: [
            {
              type: 'GRADIENT_LINEAR',
              visible: true,
              opacity: 1,
              stops: [{ color: { r: 1, g: 1, b: 1, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 0, a: 1 }, position: 1 }],
              transform: { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 },
            },
          ],
          effects: [{ type: 'DROP_SHADOW', visible: true, offset: { x: 0, y: 4 }, radius: 8, color: { r: 0, g: 0, b: 0, a: 0.25 } }],
        }),
        node(12, 10, 'RECTANGLE', {
          size: { x: 40, y: 40 },
          fillPaints: [{ type: 'IMAGE', visible: true, opacity: 1, image: { hash: Buffer.from(hash, 'hex') }, imageScaleMode: 'FIT' }],
        }, 'b'),
      ],
      {},
      { images: { [hash]: Buffer.concat([PNG_BYTES.subarray(0, 8), Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 32])]) } },
    );
    const [gradient, image] = scene.children as ShapeNode[];
    assert.equal(gradient?.fill?.kind, 'linear');
    if (gradient?.fill?.kind === 'linear') {
      // Identity would run left→right; this transform turns it into top→bottom.
      assert.deepEqual([gradient.fill.x1, gradient.fill.y1, gradient.fill.x2, gradient.fill.y2].map((v) => Math.round(v * 100) / 100), [0.5, 0, 0.5, 1]);
    }
    assert.deepEqual(gradient?.shadows, [{ x: 0, y: 4, blur: 8, color: { r: 0, g: 0, b: 0, a: 0.25 } }]);
    assert.deepEqual(image?.fill, { kind: 'image', uid: hash, width: 64, height: 32, fit: 'contain' });
    assert.deepEqual(scene.imageUids, [hash]);
    assert.equal(doc.image(hash)?.mime, 'image/png');
    assert.equal(doc.image('../canvas.fig'), undefined);
  });

  it('clips the siblings above a mask layer', () => {
    const { scene } = sceneOf([
      node(11, 10, 'ELLIPSE', { name: 'Mask', size: { x: 20, y: 20 }, mask: true, fillPaints: [solid(0, 0, 0)] }, 'a'),
      node(12, 10, 'RECTANGLE', { name: 'Photo', size: { x: 40, y: 40 } }, 'b'),
    ]);
    const masked = scene.children[0] as GroupNode;
    assert.equal(masked.name, 'Mask (mask)');
    assert.deepEqual(masked.clip?.[0]?.geometry, { type: 'ellipse', cx: 10, cy: 10, rx: 10, ry: 10 });
    assert.deepEqual(masked.children.map((child) => child.name), ['Photo']);
  });

  it('replaces non-finite numbers from a corrupt file with safe defaults', () => {
    const { scene } = sceneOf([
      node(11, 10, 'RECTANGLE', {
        size: { x: Number.NaN, y: Number.POSITIVE_INFINITY },
        transform: { m00: Number.NaN, m01: 0, m02: Number.NaN, m10: 0, m11: 1, m12: Number.NEGATIVE_INFINITY },
        opacity: Number.NaN,
        cornerRadius: -5,
        fillPaints: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: Number.NaN, g: 2, b: -1, a: Number.NaN } }],
        strokePaints: [solid(0, 0, 0)],
        strokeWeight: Number.NaN,
      }),
    ]);
    const rect = scene.children[0] as ShapeNode;
    assert.doesNotMatch(JSON.stringify(rect), /null/, 'NaN would serialize as null');
    assert.deepEqual(rect.transform, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    assert.deepEqual(rect.layoutSize, { width: 0, height: 0 });
    assert.equal(rect.opacity, 1);
    assert.deepEqual(rect.fill, { kind: 'solid', color: { r: 0, g: 255, b: 0, a: 1 } });
    assert.equal(rect.stroke?.width, 1);
    assert.deepEqual(rect.geometry.type === 'rect' && rect.geometry.radii, [0, 0, 0, 0]);
  });

  it('stops expanding exponentially nested instances at the layer cap', () => {
    // Each component holds two instances of the next one: 2^24 layers if expanded fully.
    const nodes: ReturnType<typeof node>[] = [];
    for (let level = 0; level < 24; level++) {
      const id = 100 + level * 3;
      nodes.push(node(id, 10, 'SYMBOL', { name: `Level ${level}`, size: { x: 1, y: 1 } }, `z${level}`));
      if (level < 23) {
        nodes.push(node(id + 1, id, 'INSTANCE', { symbolData: { symbolID: guid(id + 3) } }, 'a'));
        nodes.push(node(id + 2, id, 'INSTANCE', { symbolData: { symbolID: guid(id + 3) } }, 'b'));
      }
    }
    const started = Date.now();
    const { scene } = sceneOf(nodes);
    assert.ok(Date.now() - started < 10_000);
    assert.ok(scene.warnings.some((warning) => /more than \d+ layers/.test(warning)));
  });
});

