// Builds a static copy of the webview for a given design file so the UI can be checked in a normal browser:
// `pnpm preview <file.xd|file.fig> <out-dir>` then serve <out-dir> over HTTP. The output contains the design data,
// so write it outside the repository.
//
// Host messages are built with the extension's own payload code and stored exactly as VS Code's serializer would
// send them (JSON + transferred buffers); the mock host revives them with the same deserializer, so payload bugs
// that only show up inside VS Code (e.g. Node Buffers) show up here too.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { openDesignDocument } from '../src/openDocument.ts';
import { artboardMessage } from '../src/payload.ts';
import { deserializeInWebview, serializeForWebview } from '../test/support/vscodeWebviewSerializer.ts';

const [file, outDir] = process.argv.slice(2);
if (!file || !outDir) {
  console.error('usage: pnpm preview <file.xd|file.fig> <out-dir>');
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..');
const doc = openDesignDocument(file, readFileSync(file));
mkdirSync(path.join(outDir, 'data'), { recursive: true });

const bufferCounts: number[] = [];
doc.artboards.forEach((artboard, i) => {
  const { message, buffers } = serializeForWebview(artboardMessage(doc, artboard.id, new Set()));
  writeFileSync(path.join(outDir, 'data', `${i}.json`), message);
  buffers.forEach((bytes, k) => writeFileSync(path.join(outDir, 'data', `${i}-${k}.bin`), bytes));
  bufferCounts.push(buffers.length);
});
writeFileSync(
  path.join(outDir, 'data', 'document.json'),
  JSON.stringify({ fileName: path.basename(file), artboards: doc.artboards, board: doc.board, bufferCounts }),
);
copyFileSync(path.join(root, 'dist', 'webview.js'), path.join(outDir, 'webview.js'));
copyFileSync(path.join(root, 'media', 'viewer.css'), path.join(outDir, 'viewer.css'));

const mock = `
${serializeForWebview.toString()}
${deserializeInWebview.toString()}
const documentInfo = fetch('data/document.json').then((response) => response.json());
const post = (data) => {
  const revived = deserializeInWebview(serializeForWebview(data));
  window.dispatchEvent(new MessageEvent('message', { data: revived }));
};
async function storedArtboard(info, id) {
  const index = info.artboards.findIndex((artboard) => artboard.id === id);
  if (index < 0) {
    return { type: 'error', message: 'Unknown artboard: ' + id };
  }
  const message = await (await fetch('data/' + index + '.json')).text();
  const buffers = await Promise.all(
    Array.from({ length: info.bufferCounts[index] }, async (_, k) => new Uint8Array(await (await fetch('data/' + index + '-' + k + '.bin')).arrayBuffer())),
  );
  return deserializeInWebview({ message, buffers });
}
window.acquireVsCodeApi = () => ({
  async postMessage(message) {
    const info = await documentInfo;
    if (message.type === 'ready') {
      post({ type: 'document', fileName: info.fileName, artboards: info.artboards, board: info.board });
    } else if (message.type === 'loadArtboard') {
      const stored = await storedArtboard(info, message.id);
      if (stored.type === 'artboard') {
        stored.images = stored.images.filter((image) => !message.knownImages.includes(image.uid));
      }
      post(stored);
    } else if (message.type === 'loadArtboards') {
      const known = new Set(message.knownImages);
      const reply = { type: 'scenes', scenes: [], images: [], failed: [] };
      for (const id of message.ids) {
        const stored = await storedArtboard(info, id);
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
    } else if (message.type === 'copy') {
      console.log('[copy]', message.label, message.text);
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
<script src="mock.js"></script>
<script src="webview.js"></script>
</body>
</html>
`,
);
console.log(`Wrote ${doc.artboards.length} artboards to ${outDir}`);
