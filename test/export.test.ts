import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSafeFileName, MESSAGE_LIMITS, utf8Length } from '../src/protocol.ts';
import {
  base64,
  dataUrl,
  exportFileName,
  extensionForType,
  imageExtension,
  imageFillOf,
  imageUidsOf,
  layerPath,
  layerSvgFile,
  paintedBox,
  pngSize,
} from '../src/render/export.ts';
import { renderArtboardSvg, renderLayerSvg } from '../src/render/svg.ts';
import type { Box } from '../src/render/geometry.ts';
import type { Matrix, Paint } from '../src/scene/scene.ts';
import { artboard, group, shape, stroke, text, textStyle } from './support/sceneBuilders.ts';
import { PNG_BYTES } from './support/xdFixture.ts';

const noImages = () => undefined;
const at = (e: number, f: number): Matrix => ({ a: 1, b: 0, c: 0, d: 1, e, f });
const red: Paint = { kind: 'solid', color: { r: 255, g: 0, b: 0, a: 1 } };
const image = (uid: string): Paint => ({ kind: 'image', uid, width: 800, height: 600, fit: 'cover' });
const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height });

/** Every id defined in the SVG, and every #id it refers to. */
function idsOf(svg: string) {
  return {
    defined: [...svg.matchAll(/ id="([^"]+)"/g)].map((match) => match[1] ?? ''),
    referenced: [...svg.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1] ?? ''),
  };
}

describe('renderLayerSvg', () => {
  it('draws one layer cropped to its box, placed by its ancestors, without their effects or the viewer hooks', () => {
    const child = shape({ key: 'c', transform: at(10, 5), geometry: { type: 'rect', x: 0, y: 0, width: 20, height: 10, radii: [0, 0, 0, 0] }, fill: red });
    const parent = group([child], {
      key: 'p',
      transform: at(100, 200),
      opacity: 0.5,
      shadows: [{ x: 0, y: 2, blur: 4, color: { r: 0, g: 0, b: 0, a: 0.2 } }],
      clip: [shape({ geometry: { type: 'ellipse', cx: 0, cy: 0, rx: 5, ry: 5 } })],
    });
    assert.equal(
      renderLayerSvg(child, [parent], box(110, 205, 20, 10), noImages, { idPrefix: 'ai1' }),
      '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="20" height="10" viewBox="110 205 20 10">' +
        '<g transform="matrix(1 0 0 1 100 200)"><g transform="matrix(1 0 0 1 10 5)"><rect x="0" y="0" width="20" height="10" fill="#FF0000"/></g></g></svg>',
    );
  });

  it('composes nested ancestor transforms and leaves an untransformed top-level layer unwrapped', () => {
    const leaf = shape({ key: 'leaf', fill: red });
    const inner = group([leaf], { key: 'inner', transform: { a: 2, b: 0, c: 0, d: 2, e: 5, f: 5 } });
    const outer = group([inner], { key: 'outer', transform: at(10, 20) });
    assert.match(renderLayerSvg(leaf, [outer, inner], box(0, 0, 1, 1), noImages, { idPrefix: 'x' }), /<g transform="matrix\(2 0 0 2 15 25\)"><rect /);
    assert.match(renderLayerSvg(leaf, [], box(0, 0, 100, 40), noImages, { idPrefix: 'x' }), /viewBox="0 0 100 40"><rect x="0"/);
  });

  it('keeps the layer’s own opacity, shadows, gradients, clips and images, with prefixed ids', () => {
    const photo = shape({ key: 'photo', fill: image('u1'), opacity: 0.8, shadows: [{ x: 0, y: 1, blur: 2, color: { r: 0, g: 0, b: 0, a: 1 } }] });
    const masked = group([photo], { key: 'mask', clip: [shape({ geometry: { type: 'ellipse', cx: 10, cy: 10, rx: 10, ry: 10 } })] });
    const svg = renderLayerSvg(masked, [], box(0, 0, 100, 40), (uid) => (uid === 'u1' ? 'data:image/png;base64,AAAA' : undefined), { idPrefix: 'ai7' });
    assert.match(svg, /<defs><filter id="ai7-photo-shadow"[^]*<pattern id="ai7-photo-fill"[^]*<image width="800" height="600" href="data:image\/png;base64,AAAA"[^]*<clipPath id="ai7-mask-clip">/);
    assert.match(svg, /<g clip-path="url\(#ai7-mask-clip\)"><g opacity="0.8" filter="url\(#ai7-photo-shadow\)"><rect [^>]*fill="url\(#ai7-photo-fill\)"\/>/);
    assert.doesNotMatch(svg, /data-key|class=/);
  });

  it('keeps text as text with its font, size and spacing, and Yu Gothic UI proportional spacing as a style', () => {
    const label = text({
      key: 't',
      styles: [textStyle({ family: 'Inter', size: 14, letterSpacing: 100 })],
      lines: [{ x: 0, y: 16, runs: [{ text: 'a  b', style: 0, glyphFont: 'Yu Gothic UI' }] }],
    });
    const svg = renderLayerSvg(label, [], box(0, 0, 40, 20), noImages, { idPrefix: 'x' });
    assert.match(svg, /xml:space="preserve"/);
    assert.match(
      svg,
      /<text x="0" y="16"><tspan font-family="'Inter', 'Yu Gothic UI', [^"]*" font-size="14" font-weight="500" fill="#333333" letter-spacing="1.4" style="font-feature-settings: 'palt'">a {2}b<\/tspan><\/text>/,
    );
    assert.doesNotMatch(svg, /pointer-events/);
  });

  it('writes the output size when given and keeps the viewBox on the box', () => {
    const svg = renderLayerSvg(shape(), [], box(4.5, 0, 10.25, 3), noImages, { idPrefix: 'x', size: { width: 31, height: 9 } });
    assert.match(svg, /width="31" height="9" viewBox="4.5 0 10.25 3"/);
  });

  it('leaves the viewer’s artboard rendering with its hooks', () => {
    const svg = renderArtboardSvg(artboard([shape({ key: 's' }), text({ key: 't', lines: [{ x: 0, y: 10, runs: [{ text: 'a', style: 0, glyphFont: 'Meiryo UI' }] }] })]), noImages);
    assert.match(svg, /<g data-key="s"><rect [^>]*class="dv-geom"/);
    assert.match(svg, /pointer-events="bounding-box"><tspan [^>]*class="dv-palt">/);
  });
});

describe('layerSvgFile', () => {
  const gradient: Paint = { kind: 'linear', x1: 0, y1: 0, x2: 1, y2: 1, stops: [{ offset: 0, color: { r: 0, g: 0, b: 0, a: 1 } }] };
  const card = group([shape({ key: 'bg', fill: gradient, stroke: stroke({ align: 'inside' }) }), shape({ key: 'shade', shadows: [{ x: 0, y: 1, blur: 2, color: { r: 0, g: 0, b: 0, a: 1 } }] })], {
    key: 'card',
    clip: [shape({ key: 'clipper' })],
  });

  it('prefixes ids with a hash of the drawing: stable for the same layer, different for another', () => {
    const first = layerSvgFile(card, [], box(0, 0, 100, 40), noImages);
    assert.equal(layerSvgFile(card, [], box(0, 0, 100, 40), noImages), first);
    const { defined, referenced } = idsOf(first);
    assert.equal(defined.length, 3);
    assert.equal(new Set(defined).size, defined.length, 'ids are unique');
    assert.ok(referenced.every((id) => defined.includes(id)), 'every reference resolves inside the file');
    const prefix = /^(ai[0-9a-z]+)-/.exec(defined[0] ?? '')?.[1];
    assert.ok(prefix && defined.every((id) => id.startsWith(`${prefix}-`)), `ids share the prefix: ${defined.join(', ')}`);
    assert.ok(defined.every((id) => !id.startsWith('dv')), 'no ids that the viewer uses');

    const other = layerSvgFile(card, [], box(0, 0, 100, 41), noImages);
    const otherPrefix = /id="(ai[0-9a-z]+)-/.exec(other)?.[1];
    assert.notEqual(otherPrefix, prefix);
  });
});

describe('paintedBox', () => {
  const own = box(10, 20, 100, 40);
  const boxes = (entries: Record<string, Box>) => new Map(Object.entries(entries));

  it('is the measured box for plain shapes and inside strokes, grown for centered and outside strokes', () => {
    assert.deepEqual(paintedBox(shape({ key: 'a' }), boxes({ a: own })), own);
    assert.deepEqual(paintedBox(shape({ key: 'a', stroke: stroke({ width: 4, align: 'inside' }) }), boxes({ a: own })), own);
    assert.deepEqual(paintedBox(shape({ key: 'a', stroke: stroke({ width: 4, align: 'center' }) }), boxes({ a: own })), box(8, 18, 104, 44));
    assert.deepEqual(paintedBox(shape({ key: 'a', stroke: stroke({ width: 4, align: 'outside' }) }), boxes({ a: own })), box(6, 16, 108, 48));
  });

  it('gives lines their stroke width and no shadow, as they are drawn', () => {
    const divider = shape({
      key: 'l',
      geometry: { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0 },
      stroke: stroke({ width: 2, align: 'inside' }),
      shadows: [{ x: 0, y: 4, blur: 8, color: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    assert.deepEqual(paintedBox(divider, boxes({ l: box(0, 50, 100, 0) })), box(-1, 49, 102, 2));
  });

  it('adds drop shadows by their offset and blur', () => {
    const card = shape({ key: 'a', shadows: [{ x: 0, y: 2, blur: 4, color: { r: 0, g: 0, b: 0, a: 0.08 } }] });
    assert.deepEqual(paintedBox(card, boxes({ a: own })), box(6, 18, 108, 48));
    const offset = shape({ key: 'a', shadows: [{ x: 30, y: 0, blur: 0, color: { r: 0, g: 0, b: 0, a: 1 } }] });
    assert.deepEqual(paintedBox(offset, boxes({ a: own })), box(10, 20, 130, 40));
  });

  it('unions the children of a group, but stops at the clip of a masked group', () => {
    const children = [shape({ key: 'a' }), shape({ key: 'b', stroke: stroke({ width: 2, align: 'outside' }) })];
    const measured = boxes({ a: box(0, 0, 10, 10), b: box(50, 0, 10, 10), g: box(0, 0, 60, 10), m: box(0, 0, 20, 10) });
    assert.deepEqual(paintedBox(group(children, { key: 'g' }), measured), box(0, -2, 62, 14));
    assert.deepEqual(paintedBox(group(children, { key: 'm', clip: [shape()] }), measured), box(0, 0, 20, 10));
  });

  it('includes a frame’s own border and its unclipped children', () => {
    const frame = group([shape({ key: 'child' })], {
      key: 'f',
      frame: { width: 50, height: 50, radii: [0, 0, 0, 0], fill: red, stroke: stroke({ width: 2, align: 'outside' }) },
    });
    assert.deepEqual(paintedBox(frame, boxes({ f: box(0, 0, 50, 50), child: box(40, 40, 30, 5) })), box(-2, -2, 72, 54));
  });

  it('is null for layers that were not measured and for empty groups', () => {
    assert.equal(paintedBox(shape({ key: 'a' }), new Map()), null);
    assert.equal(paintedBox(group([], { key: 'g' }), new Map()), null);
  });
});

describe('export helpers', () => {
  it('sizes PNGs by rounding the box at the scale, at least one pixel', () => {
    assert.deepEqual(pngSize(box(0, 0, 199, 244), 1), { width: 199, height: 244 });
    assert.deepEqual(pngSize(box(0, 0, 100.4, 0.2), 3), { width: 301, height: 1 });
    assert.deepEqual(pngSize(box(0, 0, 0, 0), 2), { width: 1, height: 1 });
  });

  it('finds the path to a layer, its image fill and the images of a subtree', () => {
    const photo = shape({ key: 'photo', fill: image('u1') });
    const frame = group([photo, text({ key: 'caption' })], {
      key: 'frame',
      frame: { width: 10, height: 10, radii: [0, 0, 0, 0], fill: image('u2'), stroke: null },
    });
    const scene = artboard([shape({ key: 'top' }), group([frame], { key: 'outer' })]);
    assert.deepEqual(layerPath(scene, 'photo')?.map((node) => node.key), ['outer', 'frame', 'photo']);
    assert.deepEqual(layerPath(scene, 'top')?.map((node) => node.key), ['top']);
    assert.equal(layerPath(scene, 'missing'), null);
    assert.equal(imageFillOf(photo)?.uid, 'u1');
    assert.equal(imageFillOf(frame)?.uid, 'u2');
    assert.equal(imageFillOf(shape({ fill: red })), null);
    assert.equal(imageFillOf(text()), null);
    assert.deepEqual([...imageUidsOf(scene.children[1] ?? shape())].sort(), ['u1', 'u2']);
  });

  it('takes the image extension from the magic bytes, and maps declared types', () => {
    const bytes = (...values: (number | string)[]) => new Uint8Array(values.flatMap((value) => (typeof value === 'string' ? [...value].map((c) => c.charCodeAt(0)) : [value])));
    assert.equal(imageExtension(new Uint8Array(PNG_BYTES)), 'png');
    assert.equal(imageExtension(bytes(0xff, 0xd8, 0xff, 0xe0)), 'jpg');
    assert.equal(imageExtension(bytes('GIF89a')), 'gif');
    assert.equal(imageExtension(bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 ')), 'webp');
    assert.equal(imageExtension(bytes('  <svg xmlns="http://www.w3.org/2000/svg"/>')), 'svg');
    assert.equal(imageExtension(bytes('%PDF-1.7')), null);
    assert.equal(extensionForType('image/jpeg'), 'jpg');
    assert.equal(extensionForType('image/svg+xml'), 'svg');
    assert.equal(extensionForType('application/octet-stream'), null);
  });

  it('encodes base64 like Node, also beyond one chunk, and builds data URLs', () => {
    const data = new Uint8Array(100_000).map((_, i) => (i * 7919) % 256);
    assert.equal(base64(data), Buffer.from(data).toString('base64'));
    assert.equal(base64(new Uint8Array()), '');
    assert.equal(dataUrl('image/png', new Uint8Array([1, 2, 3])), 'data:image/png;base64,AQID');
  });
});

describe('exportFileName', () => {
  it('turns the layer name into a file name', () => {
    assert.equal(exportFileName('Card / Ceramic Mug', 'png'), 'Card - Ceramic Mug.png');
    assert.equal(exportFileName('Icon', 'png', '@2x'), 'Icon@2x.png');
    assert.equal(exportFileName('Hello\n\t  world', 'svg'), 'Hello world.svg');
    assert.equal(exportFileName('ヘッダー画像', 'jpg'), 'ヘッダー画像.jpg');
    assert.equal(exportFileName('name...', 'png'), 'name.png');
    assert.equal(exportFileName('a:b*c?"d"<e>|f\\g', 'png'), 'a-b-c-d-e-f-g.png');
  });

  it('neutralizes traversal, hidden names, control and bidi characters', () => {
    assert.equal(exportFileName('../../etc/passwd', 'svg'), 'etc-passwd.svg');
    assert.equal(exportFileName('..', 'png'), 'layer.png');
    assert.equal(exportFileName('.bashrc', 'png'), 'bashrc.png');
    assert.equal(exportFileName('', 'png', '@3x'), 'layer@3x.png');
    assert.equal(exportFileName('a\u0000b‮gnp.exe', 'png'), 'abgnp.exe.png');
    assert.equal(exportFileName('a\ud800b', 'png'), 'ab.png');
  });

  it('defuses Windows device names', () => {
    assert.equal(exportFileName('CON', 'png'), '_CON.png');
    assert.equal(exportFileName('nul.txt', 'svg'), '_nul.txt.svg');
    assert.equal(exportFileName('con .', 'png'), '_con.png');
    assert.equal(exportFileName('console', 'png'), 'console.png');
    assert.equal(exportFileName('com1', 'png', '@2x'), 'com1@2x.png');
  });

  it('shortens long names to fit file systems without splitting characters', () => {
    const japanese = exportFileName('あ'.repeat(200), 'png', '@2x');
    assert.ok(utf8Length(japanese) <= MESSAGE_LIMITS.fileNameBytes);
    assert.match(japanese, /^あ+@2x\.png$/);
    const emoji = exportFileName('😀'.repeat(100), 'svg');
    assert.ok(utf8Length(emoji) <= MESSAGE_LIMITS.fileNameBytes);
    assert.match(emoji, /^(😀)+\.svg$/u);
  });

  it('always produces a name the host accepts', () => {
    const names = ['', ' ', '.', '..', '...', '/', '\\', 'a/../../b', '-rf', 'COM¹', 'lpt9.png', ' .x. ', '‮', '\u0007bell', 'x'.repeat(1000), '漢'.repeat(1000)];
    for (const name of names) {
      for (const extension of ['png', 'jpg', 'gif', 'webp', 'svg'] as const) {
        for (const suffix of ['', '@2x']) {
          const fileName = exportFileName(name, extension, suffix);
          assert.ok(isSafeFileName(fileName), `${JSON.stringify(name)} → ${JSON.stringify(fileName)}`);
        }
      }
    }
  });
});
