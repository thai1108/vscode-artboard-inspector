import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseWebviewMessage } from '../src/protocol.ts';
import { renderArtboardSvg } from '../src/render/svg.ts';
import type { AgcNode } from '../src/xd/agc.ts';
import { parseAgcColor } from '../src/xd/color.ts';
import { SCENE_LIMITS, toStroke } from '../src/xd/parse.ts';
import type { GroupNode, SceneNode, Stroke, TextNode } from '../src/scene/scene.ts';
import { ZipArchive } from '../src/zip.ts';
import { artboard, shape, stroke } from './support/sceneBuilders.ts';
import { buildXd } from './support/xdFixture.ts';
import { writeZip } from './support/zipWriter.ts';

const BOUNDS = { x: 0, y: 0, width: 100, height: 100 };

function sceneOf(children: AgcNode[], resources: AgcNode[] = []) {
  return buildXd({ artboards: [{ id: 'artboard-a', name: 'A', bounds: BOUNDS, children }], resources }).scene('artboard-a');
}

function countNodes(nodes: SceneNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + (node.kind === 'group' ? countNodes(node.children) : 0), 0);
}

describe('hostile ZIP archives', () => {
  const limits = { maxEntrySize: 1000, maxTotalSize: 1500 };

  it('refuses entries and archives whose declared size exceeds the limits', () => {
    assert.throws(() => ZipArchive.open(writeZip([{ name: 'big', data: 'x'.repeat(1001) }]), limits), /ZIP entry too large: big/);
    assert.throws(
      () => ZipArchive.open(writeZip([{ name: 'a', data: 'x'.repeat(900) }, { name: 'b', data: 'x'.repeat(900) }]), limits),
      /ZIP archive too large when unpacked/,
    );
  });

  it('stops a deflate stream that inflates beyond its declared size (ZIP bomb)', () => {
    const zip = ZipArchive.open(writeZip([{ name: 'bomb', data: Buffer.alloc(5_000_000), declaredSize: 10 }]));
    assert.throws(() => zip.read('bomb'), /\(inflates beyond its declared size\): bomb/);
  });

  it('rejects size mismatches, truncated data and ZIP64 markers', () => {
    assert.throws(() => ZipArchive.open(writeZip([{ name: 'short', data: 'abc', declaredSize: 10 }])).read('short'), /\(size mismatch\): short/);
    assert.throws(() => ZipArchive.open(writeZip([{ name: 'cut', data: 'abc', store: true, declaredCompressedSize: 1_000_000 }])).read('cut'), /\(truncated data\): cut/);
    assert.throws(() => ZipArchive.open(writeZip([{ name: 'z64', data: 'abc', declaredSize: 0xffffffff }])), /ZIP64 archives are not supported/);
  });
});

describe('hostile XD content', () => {
  it('stops linked layers that refer back to themselves', () => {
    const loop: AgcNode = { type: 'group', id: 'loop', group: { children: [{ type: 'syncRef', syncSourceGuid: 'loop' }] } };
    const scene = sceneOf([{ type: 'syncRef', syncSourceGuid: 'loop' }], [loop]);
    assert.equal(countNodes(scene.children), 1);
    assert.deepEqual(scene.warnings, ['Linked layer refers to itself (loop)']);
  });

  it('caps exponential linked-layer expansion ("billion laughs")', () => {
    const levels: AgcNode[] = [];
    for (let i = 0; i < 30; i++) {
      const next = { type: 'syncRef', syncSourceGuid: `level${i + 1}` } as const;
      levels.push({ type: 'group', id: `level${i}`, group: { children: [next, next] } });
    }
    levels.push({ type: 'shape', id: 'level30', shape: { type: 'rect', width: 1, height: 1 } });
    const scene = sceneOf([{ type: 'syncRef', syncSourceGuid: 'level0' }], levels);
    assert.ok(countNodes(scene.children) <= SCENE_LIMITS.maxNodes);
    assert.ok(scene.warnings.includes(`Artboard has more than ${SCENE_LIMITS.maxNodes} layers; the rest are not shown`));
  });

  it('stops expanding groups nested deeper than the limit', () => {
    let node: AgcNode = { type: 'shape', id: 'leaf', shape: { type: 'rect', width: 1, height: 1 } };
    for (let i = 0; i < SCENE_LIMITS.maxDepth + 50; i++) {
      node = { type: 'group', id: `g${i}`, group: { children: [node] } };
    }
    const scene = sceneOf([node]);
    let depth = 0;
    for (let current: SceneNode | undefined = scene.children[0]; current?.kind === 'group'; current = (current as GroupNode).children[0]) {
      depth++;
    }
    assert.equal(depth, SCENE_LIMITS.maxDepth + 1);
    assert.deepEqual(scene.warnings, [`Layers nested deeper than ${SCENE_LIMITS.maxDepth} levels are not shown`]);
  });

  it('caps text runs when segments and styled ranges multiply', () => {
    const rawText = 'x'.repeat(2000);
    const rangedStyles = Array.from({ length: 2000 }, () => ({ length: 1, fontSize: 12 }));
    const line = Array.from({ length: 200 }, () => ({ from: 0, to: 2000, x: 0, y: 0 }));
    const scene = sceneOf([{ type: 'text', id: 't', meta: { ux: { rangedStyles } }, text: { rawText, paragraphs: [{ lines: [line] }] } } as AgcNode]);
    const runs = (scene.children[0] as TextNode).lines.flatMap((l) => l.runs).length;
    assert.equal(runs, SCENE_LIMITS.maxTextRuns);
    assert.ok(scene.warnings.includes(`Artboard has more than ${SCENE_LIMITS.maxTextRuns} text runs; the rest are not shown`));
  });

  it('skips artboards with invalid manifest bounds and reports them', () => {
    const doc = buildXd({
      artboards: [
        { id: 'artboard-ok', name: 'Ok', bounds: BOUNDS, children: [] },
        { id: 'artboard-bad', name: 'Bad', bounds: { x: 0, y: 0, width: '<a href=x>' as unknown as number, height: 10 }, children: [] },
      ],
    });
    assert.deepEqual(doc.artboards.map((a) => a.id), ['artboard-ok']);
    assert.deepEqual(doc.scene('artboard-ok').warnings, ['Artboard "Bad" skipped: invalid bounds in the manifest']);
  });

  it('accepts only known stroke keywords and drops non-numeric dashes', () => {
    const hostile = toStroke({ type: 'solid', width: 1, cap: 'round" onload="x' as 'round', join: '<script>' as 'round', align: 'evil' as 'inside', dash: [2, 'x' as unknown as number] });
    assert.deepEqual([hostile?.cap, hostile?.join, hostile?.align, hostile?.dash], ['butt', 'miter', 'center', [2]]);
    assert.equal(toStroke({ type: 'solid', width: 'wide' as unknown as number }), null);
  });

  it('falls back on malformed colors', () => {
    assert.deepEqual(parseAgcColor({ value: null as unknown as number }), { r: 0, g: 0, b: 0, a: 1 });
    assert.deepEqual(parseAgcColor({ value: { r: 999, g: -5, b: 'x' as unknown as number }, alpha: '1" x="' as unknown as number }), { r: 255, g: 0, b: 0, a: 1 });
  });
});

describe('markup escaping', () => {
  it('escapes layer keys and stroke keywords that reach SVG attributes', () => {
    const svg = renderArtboardSvg(
      artboard([shape({ key: 'k"><x', stroke: stroke({ cap: 'round"><x' as Stroke['cap'] }), shadows: [{ x: 0, y: 1, blur: 2, color: { r: 0, g: 0, b: 0, a: 1 } }] })]),
      () => undefined,
    );
    assert.doesNotMatch(svg, /"><x/);
    assert.match(svg, /data-key="k&quot;&gt;&lt;x"/);
    assert.match(svg, /stroke-linecap="round&quot;&gt;&lt;x"/);
    assert.match(svg, /filter="url\(#dv-k___x-shadow\)"/);
  });
});

describe('parseWebviewMessage', () => {
  it('accepts well-formed messages', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'ready' }), { type: 'ready' });
    assert.deepEqual(parseWebviewMessage({ type: 'loadArtboard', id: 'artboard-a', knownImages: ['u1'] }), { type: 'loadArtboard', id: 'artboard-a', knownImages: ['u1'] });
    assert.deepEqual(parseWebviewMessage({ type: 'copy', text: 'x', label: 'CSS', extra: 1 }), { type: 'copy', text: 'x', label: 'CSS' });
  });

  it('drops malformed or oversized messages', () => {
    for (const raw of [
      null,
      'ready',
      { type: 'eval' },
      { type: 'loadArtboard', id: 1, knownImages: [] },
      { type: 'loadArtboard', id: 'a', knownImages: 'u1' },
      { type: 'loadArtboard', id: 'a', knownImages: [1] },
      { type: 'loadArtboard', id: 'a'.repeat(513), knownImages: [] },
      { type: 'loadArtboard', id: 'a', knownImages: Array.from({ length: 10_001 }, () => 'u') },
      { type: 'copy', text: 'x'.repeat(1024 * 1024 + 1), label: 'big' },
      { type: 'copy', text: 'x', label: 'l'.repeat(201) },
      { type: 'copy', text: 42, label: 'x' },
    ]) {
      assert.equal(parseWebviewMessage(raw), null, JSON.stringify(raw)?.slice(0, 60));
    }
  });
});
