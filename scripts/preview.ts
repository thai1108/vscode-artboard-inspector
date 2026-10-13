// Builds a static copy of the webview for a given design file so the UI can be checked in a normal browser:
// `pnpm preview <file.xd|file.fig> <out-dir> [--compare <earlier.xd|earlier.fig>]` then serve <out-dir> over HTTP.
// The output contains the design data, so write it outside the repository.
//
// Host messages are built with the extension's own payload code and stored exactly as VS Code's serializer would
// send them (JSON + transferred buffers); the mock host revives them with the same deserializer, so payload bugs
// that only show up inside VS Code (e.g. Node Buffers) show up here too. Searches are answered in the page by the
// extension's own payload code, bundled for the browser, over the search index built here. With --compare, the
// other file is stored the same way and compared here; "Compare…" in the page then compares with it, and the
// compare code orients and summarizes the stored diff in the page like the extension host does.
import { buildSync } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { compareDocuments } from '../src/compare/compare.ts';
import { imageKeys } from '../src/compare/imageKeys.ts';
import type { DesignDocument } from '../src/document.ts';
import { openDesignDocument } from '../src/openDocument.ts';
import { artboardMessage } from '../src/payload.ts';
import { buildSearchIndex } from '../src/search.ts';
import { deserializeInWebview, serializeForWebview } from '../test/support/vscodeWebviewSerializer.ts';

const args = process.argv.slice(2);
const compareAt = args.indexOf('--compare');
const earlierFile = compareAt >= 0 ? args[compareAt + 1] : undefined;
const [file, outDir] = args.filter((_, i) => compareAt < 0 || (i !== compareAt && i !== compareAt + 1));
if (!file || !outDir || (compareAt >= 0 && !earlierFile)) {
  console.error('usage: pnpm preview <file.xd|file.fig> <out-dir> [--compare <earlier.xd|earlier.fig>]');
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..');
const doc = openDesignDocument(file, readFileSync(file));

/** Writes a design's document info, every artboard message and its search index into `dir`. */
async function writeDesign(design: DesignDocument, name: string, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const bufferCounts: number[] = [];
  design.artboards.forEach((artboard, i) => {
    const { message, buffers } = serializeForWebview(artboardMessage(design, artboard.id, new Set()));
    writeFileSync(path.join(dir, `${i}.json`), message);
    buffers.forEach((bytes, k) => writeFileSync(path.join(dir, `${i}-${k}.bin`), bytes));
    bufferCounts.push(buffers.length);
  });
  writeFileSync(path.join(dir, 'document.json'), JSON.stringify({ fileName: name, artboards: design.artboards, board: design.board, bufferCounts }));
  writeFileSync(path.join(dir, 'search.json'), JSON.stringify(await buildSearchIndex(design)));
}

await writeDesign(doc, path.basename(file), path.join(outDir, 'data'));
if (earlierFile) {
  const earlier = openDesignDocument(earlierFile, readFileSync(earlierFile));
  await writeDesign(earlier, path.basename(earlierFile), path.join(outDir, 'data', 'compare'));
  const beforeKey = imageKeys(earlier);
  const afterKey = imageKeys(doc);
  const diff = await compareDocuments(earlier, doc, { imageKey: (side, uid) => (side === 'before' ? beforeKey : afterKey)(uid) });
  writeFileSync(path.join(outDir, 'data', 'compare', 'diff.json'), JSON.stringify(diff));
}
for (const [entry, globalName] of [
  ['payload.ts', 'previewPayload'],
  ['compare/compare.ts', 'previewCompare'],
]) {
  buildSync({
    entryPoints: [path.join(root, 'src', entry ?? '')],
    outfile: path.join(outDir, `${globalName}.js`),
    bundle: true,
    format: 'iife',
    globalName,
    platform: 'browser',
    target: 'chrome120',
    logLevel: 'warning',
  });
}
copyFileSync(path.join(root, 'dist', 'webview.js'), path.join(outDir, 'webview.js'));
copyFileSync(path.join(root, 'media', 'viewer.css'), path.join(outDir, 'viewer.css'));

const mock = `
${serializeForWebview.toString()}
${deserializeInWebview.toString()}
const json = (url) => fetch(url).then((response) => response.json());
const source = (dir) => {
  let info;
  return { dir, get info() { return (info ??= json(dir + '/document.json')); } };
};
const opened = source('data');
const other = source('data/compare');
const canCompare = ${earlierFile ? 'true' : 'false'};
const searchIndexes = new Map();
// Stands in for the extension host's CompareSession: the other file is the earlier version unless swapped.
let comparing = null;
let generation = 0;
const post = (data) => {
  const revived = deserializeInWebview(serializeForWebview(data));
  window.dispatchEvent(new MessageEvent('message', { data: revived }));
};
const after = () => (comparing?.swapped ? other : opened);
const before = () => (comparing?.swapped ? opened : other);
async function postDocument() {
  const source = after();
  const info = await source.info;
  post({ type: 'document', fileName: info.fileName, artboards: info.artboards, board: info.board });
}
async function postSummary() {
  const names = { before: (await before().info).fileName, after: (await after().info).fileName };
  post({ type: 'compare', summary: previewCompare.summarize(comparing.oriented, names, comparing.swapped, comparing.generation) });
}
async function storedArtboard(source, id) {
  const info = await source.info;
  const index = info.artboards.findIndex((artboard) => artboard.id === id);
  if (index < 0) {
    return { type: 'error', message: 'Unknown artboard: ' + id };
  }
  const message = await (await fetch(source.dir + '/' + index + '.json')).text();
  const buffers = await Promise.all(
    Array.from({ length: info.bufferCounts[index] }, async (_, k) => new Uint8Array(await (await fetch(source.dir + '/' + index + '-' + k + '.bin')).arrayBuffer())),
  );
  return deserializeInWebview({ message, buffers });
}
async function exitCompare() {
  const wasSwapped = comparing?.swapped;
  comparing = null;
  generation++;
  post({ type: 'compare', summary: null });
  if (wasSwapped) {
    await postDocument();
  }
}
window.acquireVsCodeApi = () => ({
  async postMessage(message) {
    if (message.type === 'ready') {
      await postDocument();
      if (comparing) {
        await postSummary();
      }
    } else if (message.type === 'loadArtboard') {
      const side = message.side === 'before' ? 'before' : 'after';
      const stored = await storedArtboard(side === 'before' ? before() : after(), message.id);
      if (stored.type === 'artboard') {
        stored.images = stored.images.filter((image) => !message.knownImages.includes(image.uid));
        const diff = comparing && previewCompare.artboardDiffOf(comparing.oriented, message.id, side);
        if (side === 'before') {
          stored.side = 'before';
        }
        if (diff) {
          stored.diff = diff;
        }
      }
      post(stored);
    } else if (message.type === 'loadArtboards') {
      const known = new Set(message.knownImages);
      const reply = { type: 'scenes', scenes: [], images: [], failed: [] };
      for (const id of message.ids) {
        const stored = await storedArtboard(after(), id);
        if (stored.type !== 'artboard') {
          reply.failed.push({ id, message: stored.message });
          continue;
        }
        reply.scenes.push(stored.scene);
        for (const image of stored.images) {
          if (!known.has(image.uid)) {
            known.add(image.uid);
            reply.images.push(image);
          }
        }
      }
      post(reply);
    } else if (message.type === 'search') {
      const dir = after().dir;
      if (!searchIndexes.has(dir)) {
        searchIndexes.set(dir, json(dir + '/search.json'));
      }
      post(previewPayload.searchMessage(await searchIndexes.get(dir), message.query, message.seq));
    } else if (message.type === 'pickCompare') {
      // Stands in for the open dialog: compares with the file given to --compare.
      if (!canCompare) {
        console.log('[compare] the preview was built without --compare');
        return;
      }
      const diff = await json('data/compare/diff.json');
      if (comparing) {
        await exitCompare();
      }
      comparing = { swapped: false, diff, oriented: diff, generation: ++generation };
      await postSummary();
    } else if (message.type === 'swapCompare') {
      if (comparing) {
        comparing.swapped = !comparing.swapped;
        comparing.oriented = previewCompare.orientDiff(comparing.diff, comparing.swapped);
        await postSummary();
        await postDocument();
      }
    } else if (message.type === 'exitCompare') {
      if (comparing) {
        await exitCompare();
      }
    } else if (message.type === 'copy') {
      console.log('[copy]', message.label, message.text);
    } else if (message.type === 'save') {
      // What the extension host would receive (structured clone out of the webview, then VS Code's serializer);
      // collected for the browser tests instead of opening a save dialog.
      const received = deserializeInWebview(serializeForWebview(structuredClone(message)));
      (window.previewSaves ??= []).push(received);
      console.log('[save]', received.fileName, received.data?.byteLength);
    } else if (message.type === 'pickScreenshot') {
      // Stands in for the host's open dialog; the bytes are checked by the webview, as for a paste.
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/webp';
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (file) {
          post({ type: 'screenshot', artboardId: message.artboardId, name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
        }
      });
      input.click();
    }
  },
  getState: () => JSON.parse(sessionStorage.getItem('dv-state') || 'null') ?? undefined,
  setState: (state) => sessionStorage.setItem('dv-state', JSON.stringify(state)),
});`;

writeFileSync(path.join(outDir, 'mock.js'), mock);
// Same policy as the real webview (see designEditorProvider.ts), so CSP violations show up here too.
const csp = "default-src 'none'; base-uri 'none'; form-action 'none'; img-src 'self' blob:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'";
writeFileSync(
  path.join(outDir, 'index.html'),
  `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Artboard Inspector preview</title>
<link rel="stylesheet" href="viewer.css">
</head>
<body>
<div id="app"></div>
<script src="previewPayload.js"></script>
<script src="previewCompare.js"></script>
<script src="mock.js"></script>
<script src="webview.js"></script>
</body>
</html>
`,
);
console.log(`Wrote ${doc.artboards.length} artboards to ${outDir}${earlierFile ? `, compared with ${path.basename(earlierFile)}` : ''}`);
