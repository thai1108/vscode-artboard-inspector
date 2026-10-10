// Builds the browser preview (scripts/preview.ts) for a design file and serves it over HTTP for Playwright.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
};

export interface PreviewSite {
  url: string;
  dir: string;
  /** imageUids per artboard, in artboard-list order. */
  imageUidsByArtboard: string[][];
  artboardIds: string[];
  close(): Promise<void>;
}

/** Writes the synthetic demo design (scripts/sample-xd.ts) and returns its path. */
export function buildSampleXd(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'artboard-inspector-sample-'));
  const file = path.join(dir, 'sample-store.xd');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/sample-xd.ts'), file], { stdio: 'ignore' });
  return file;
}

export async function servePreview(designFile: string): Promise<PreviewSite> {
  const dir = mkdtempSync(path.join(tmpdir(), 'artboard-inspector-e2e-'));
  execFileSync(process.execPath, [path.join(ROOT, 'esbuild.mjs')], { cwd: ROOT, stdio: 'ignore' });
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/preview.ts'), designFile, dir], { cwd: ROOT, stdio: 'ignore' });
  const info = JSON.parse(readFileSync(path.join(dir, 'data', 'document.json'), 'utf8')) as { artboards: { id: string }[] };
  const imageUidsByArtboard = info.artboards.map((_, i) => {
    const stored = readFileSync(path.join(dir, 'data', `${i}.json`), 'utf8');
    const message = JSON.parse(stored) as { scene?: { imageUids?: string[] } };
    return message.scene?.imageUids ?? [];
  });

  const server: Server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    if (pathname === '/favicon.ico') {
      // Chrome asks for it on its own; a 404 would show up as a console error in every test.
      response.writeHead(204).end();
      return;
    }
    const file = path.join(dir, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(dir)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = readFileSync(file);
      response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/index.html`,
    dir,
    imageUidsByArtboard,
    artboardIds: info.artboards.map((artboard) => artboard.id),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}
