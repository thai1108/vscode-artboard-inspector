import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
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
});
