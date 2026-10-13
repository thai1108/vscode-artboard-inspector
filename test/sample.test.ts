import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { compareDocuments, type DocumentDiff } from '../src/compare/compare.ts';
import { imageKeys } from '../src/compare/imageKeys.ts';
import { renderArtboardSvg } from '../src/render/svg.ts';
import { XdDocument } from '../src/xd/parse.ts';
import type { SceneNode } from '../src/scene/scene.ts';
import { ZipArchive } from '../src/zip.ts';

const root = path.resolve(import.meta.dirname, '..');

function keys(nodes: SceneNode[]): string[] {
  return nodes.flatMap((node) => [node.key, ...(node.kind === 'group' ? keys(node.children) : [])]);
}

describe('demo design written by scripts/sample-xd.ts', () => {
  let dir = '';
  let doc: XdDocument;

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'artboard-inspector-sample-'));
    const file = path.join(dir, 'demo.xd');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'sample-xd.ts'), file], { stdio: 'pipe' });
    doc = XdDocument.open(ZipArchive.open(readFileSync(file)));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens three artboards in canvas order', () => {
    assert.deepEqual(
      doc.artboards.map((a) => [a.name, a.width, a.height]),
      [
        ['Home', 430, 932],
        ['Product detail', 430, 932],
        ['Cart', 430, 932],
      ],
    );
  });

  it('converts every artboard without warnings and with the expected layer counts', () => {
    const counts = doc.artboards.map((artboard) => {
      const scene = doc.scene(artboard.id);
      assert.deepEqual(scene.warnings, [], artboard.name);
      return keys(scene.children).length;
    });
    assert.deepEqual(counts, [35, 12, 20]);
  });

  it('puts top-level layers in artboard coordinates', () => {
    const detail = doc.scene(doc.artboards[1]?.id ?? '');
    const header = detail.children[0];
    assert.equal(header?.name, 'Header');
    assert.deepEqual(header?.transform, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  });

  it('resolves the hero image as a PNG', () => {
    const home = doc.scene(doc.artboards[0]?.id ?? '');
    assert.deepEqual(home.imageUids, ['demohero']);
    const image = doc.image('demohero');
    assert.equal(image?.mime, 'image/png');
    assert.ok((image?.data.length ?? 0) > 1000);
  });

  it('renders a keyed group for every layer', () => {
    for (const artboard of doc.artboards) {
      const scene = doc.scene(artboard.id);
      const svg = renderArtboardSvg(scene, (uid) => `blob:${uid}`);
      const rendered = new Set([...svg.matchAll(/data-key="([^"]+)"/g)].map((match) => match[1]));
      assert.deepEqual([...rendered].sort(), keys(scene.children).sort(), artboard.name);
    }
  });

  describe('its earlier version (--earlier), compared with it', () => {
    let earlier: XdDocument;
    let diff: DocumentDiff;

    before(async () => {
      const file = path.join(dir, 'demo-v1.xd');
      execFileSync(process.execPath, [path.join(root, 'scripts', 'sample-xd.ts'), file, '--earlier'], { stdio: 'pipe' });
      earlier = XdDocument.open(ZipArchive.open(readFileSync(file)));
      const beforeKey = imageKeys(earlier);
      const afterKey = imageKeys(doc);
      diff = await compareDocuments(earlier, doc, { imageKey: (side, uid) => (side === 'before' ? beforeKey : afterKey)(uid) });
    });

    it('has a wishlist instead of the cart, and the product detail under another artboard id', () => {
      assert.deepEqual(
        earlier.artboards.map((a) => [a.id, a.name]),
        [
          ['artboard-demo-0', 'Home'],
          ['artboard-old-1', 'Product detail'],
          ['artboard-old-2', 'Wishlist'],
        ],
      );
      for (const artboard of earlier.artboards) {
        assert.deepEqual(earlier.scene(artboard.id).warnings, [], artboard.name);
      }
    });

    it('reports the artboards changed, matched by name, added and removed', () => {
      assert.deepEqual(
        diff.artboards.map((a) => [a.name, a.status, a.matchedBy, a.counts.added, a.counts.removed, a.counts.changed]),
        [
          ['Home', 'changed', 'id', 1, 1, 8],
          ['Product detail', 'unchanged', 'name', 0, 0, 0],
          ['Cart', 'added', null, 0, 0, 0],
          ['Wishlist', 'removed', null, 0, 0, 0],
        ],
      );
      assert.deepEqual(diff.artboards[1]?.matched, { byId: 0, byName: 12 }, 'every product detail layer matched by its name path');
    });

    it('reports exactly the planted differences on the home artboard, the moved card once', () => {
      const home = diff.artboards[0];
      const hash = (data: Uint8Array | undefined) => createHash('sha256').update(data ?? new Uint8Array()).digest('hex').slice(0, 7);
      assert.deepEqual(home?.props, [{ label: 'Background', before: '#FFFFFF', after: '#F9FAFB' }]);
      assert.deepEqual(
        home?.changes.map((change) => `${change.status} ${change.name}: ${change.props.map((p) => `${p.label} ${p.before} → ${p.after}`).join(', ')}`),
        [
          'changed Home tab: Fill #9CA3AF → #2563EB',
          'changed Button background: Radius 8px → 26px',
          'added Shipping banner: ',
          'changed Card / Linen Tote: X 231 → 223',
          'changed $18.00: Y 538.9 → 542.9',
          'changed See all: Visible Hidden → Visible',
          'changed Popular: Y 304.76 → 302.62, H 24.52 → 27.24, Size 18 → 20',
          'changed Weekend Sale: Text Summer Sale → Weekend Sale',
          `changed Hero image: Image 600 × 300 · ${hash(earlier.image('demohero-v1')?.data)} → 600 × 300 · ${hash(doc.image('demohero')?.data)}`,
          'removed Promo badge: ',
        ],
      );
    });
  });
});
