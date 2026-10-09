// Parses every artboard of the given design files and reports conversion warnings: `pnpm smoke <file.xd|file.fig>...`
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { openDesignDocument } from '../src/openDocument.ts';
import { renderArtboardSvg } from '../src/render/svg.ts';
import type { SceneNode } from '../src/scene/scene.ts';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: pnpm smoke <file.xd|file.fig>...');
  process.exit(2);
}

let failed = false;
for (const file of files) {
  const started = performance.now();
  const doc = openDesignDocument(file, readFileSync(file));
  console.log(`${file}: ${doc.artboards.length} artboards (opened in ${(performance.now() - started).toFixed(0)} ms)`);
  for (const artboard of doc.artboards) {
    try {
      const t0 = performance.now();
      const scene = doc.scene(artboard.id);
      const svg = renderArtboardSvg(scene, (uid) => `img:${uid}`);
      const ms = (performance.now() - t0).toFixed(0);
      const missing = scene.imageUids.filter((uid) => !doc.image(uid));
      console.log(`  ${artboard.name} ${artboard.width}x${artboard.height}: ${countNodes(scene.children)} layers, svg ${(svg.length / 1024).toFixed(0)} KB, ${ms} ms`);
      for (const warning of new Set(scene.warnings)) {
        console.log(`    warning: ${warning}`);
      }
      if (missing.length) {
        console.log(`    missing images: ${missing.join(', ')}`);
      }
    } catch (error) {
      failed = true;
      console.log(`  ${artboard.name}: ERROR ${(error as Error).stack}`);
    }
  }
}
process.exit(failed ? 1 : 0);

function countNodes(nodes: SceneNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + (node.kind === 'group' ? countNodes(node.children) : 0), 0);
}
