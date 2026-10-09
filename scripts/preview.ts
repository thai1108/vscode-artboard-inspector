// Builds a static copy of the webview for a given .xd file so the UI can be checked in a normal browser:
// `pnpm preview <file.xd> <out-dir>` then serve <out-dir> over HTTP. The output contains the design data,
// so write it outside the repository.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { XdDocument } from '../src/xd/parse.ts';
import { ZipArchive } from '../src/zip.ts';

const [file, outDir] = process.argv.slice(2);
if (!file || !outDir) {
  console.error('usage: pnpm preview <file.xd> <out-dir>');
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..');
const doc = XdDocument.open(ZipArchive.open(readFileSync(file)));
mkdirSync(path.join(outDir, 'data'), { recursive: true });
mkdirSync(path.join(outDir, 'img'), { recursive: true });

const mimes: Record<string, string> = {};
doc.artboards.forEach((artboard, i) => {
  const scene = doc.scene(artboard.id);
  writeFileSync(path.join(outDir, 'data', `${i}.json`), JSON.stringify(scene));
  for (const uid of scene.imageUids) {
    const image = doc.image(uid);
    if (image && !mimes[uid]) {
      mimes[uid] = image.mime;
      writeFileSync(path.join(outDir, 'img', uid), image.data);
    }
  }
});
writeFileSync(
  path.join(outDir, 'data', 'document.json'),
  JSON.stringify({ fileName: path.basename(file), artboards: doc.artboards, mimes }),
);
copyFileSync(path.join(root, 'dist', 'webview.js'), path.join(outDir, 'webview.js'));
copyFileSync(path.join(root, 'media', 'viewer.css'), path.join(outDir, 'viewer.css'));

const mock = `
const documentInfo = fetch('data/document.json').then((response) => response.json());
const post = (data) => window.dispatchEvent(new MessageEvent('message', { data }));
window.acquireVsCodeApi = () => ({
  async postMessage(message) {
    const info = await documentInfo;
    if (message.type === 'ready') {
      post({ type: 'document', fileName: info.fileName, artboards: info.artboards });
    } else if (message.type === 'loadArtboard') {
      const index = info.artboards.findIndex((artboard) => artboard.id === message.id);
      const scene = await (await fetch('data/' + index + '.json')).json();
      const images = await Promise.all(
        scene.imageUids
          .filter((uid) => info.mimes[uid] && !message.knownImages.includes(uid))
          .map(async (uid) => ({ uid, mime: info.mimes[uid], data: new Uint8Array(await (await fetch('img/' + uid)).arrayBuffer()) })),
      );
      post({ type: 'artboard', scene, images });
    } else if (message.type === 'copy') {
      console.log('[copy]', message.label, message.text);
    }
  },
  getState: () => JSON.parse(sessionStorage.getItem('dv-state') || 'null') ?? undefined,
  setState: (state) => sessionStorage.setItem('dv-state', JSON.stringify(state)),
});`;

writeFileSync(path.join(outDir, 'mock.js'), mock);
// Same policy as the real webview (see xdEditorProvider.ts), so CSP violations show up here too.
const csp = "default-src 'none'; base-uri 'none'; form-action 'none'; img-src 'self' blob:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'";
writeFileSync(
  path.join(outDir, 'index.html'),
  `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>XD Viewer preview</title>
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
