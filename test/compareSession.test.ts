import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type * as vscode from 'vscode';
import { CompareSession, type CompareDeps, type DesignSource } from '../src/compareSession.ts';
import type { DesignDocument } from '../src/document.ts';
import { openDesignDocument } from '../src/openDocument.ts';
import type { HostMessage } from '../src/protocol.ts';
import { buildSearchIndex } from '../src/search.ts';
import type { AgcNode } from '../src/xd/agc.ts';
import { deserializeInWebview, serializeForWebview } from './support/vscodeWebviewSerializer.ts';
import { buildXd, PNG_BYTES, rgb } from './support/xdFixture.ts';
import { writeZip } from './support/zipWriter.ts';

const label = (id: string, content: string): AgcNode => ({
  type: 'text',
  id,
  name: content,
  style: { font: { family: 'Noto Sans', style: 'Regular', size: 14 }, fill: { type: 'solid', color: rgb(0, 0, 0) } },
  text: { rawText: content, frame: { type: 'area', width: 100, height: 20 }, paragraphs: [{ lines: [[{ from: 0, to: content.length, x: 0, y: 14 }]] }] },
});
const photo = (uid: string): AgcNode => ({
  type: 'shape',
  id: 'photo',
  name: 'Photo',
  shape: { type: 'rect', width: 40, height: 40 },
  style: { fill: { type: 'pattern', pattern: { width: 40, height: 40, meta: { ux: { uid, scaleBehavior: 'fill' } } } } },
});

function design(title: string, artboardId: string, imageUid: string): DesignDocument {
  return buildXd({
    artboards: [{ id: artboardId, name: 'Home', bounds: { x: 0, y: 0, width: 300, height: 600 }, children: [label('title', title), photo(imageUid)] }],
    images: { [imageUid]: Buffer.concat([PNG_BYTES, Buffer.from(imageUid)]) },
  });
}

const uri = (path: string) => ({ path, fsPath: path, scheme: 'file' }) as unknown as vscode.Uri;
/** A ZIP archive that is not an XD file. */
const notAnXd = writeZip([{ name: 'readme.txt', data: 'hello' }]);

function session(options: { pick?: () => vscode.Uri | undefined; progress?: <T>(task: () => Promise<T>) => Promise<T> } = {}) {
  let opened: DesignDocument = design('Summer Sale', 'artboard-home', 'img-new');
  const openedSource = (): DesignSource => ({ name: 'shop.xd', design: opened, searchIndex: () => buildSearchIndex(opened) });
  const files = new Map<string, DesignDocument | Buffer>([
    ['/work/shop-v1.xd', design('Spring Sale', 'artboard-home', 'img-old')],
    ['/work/broken.xd', notAnXd],
  ]);
  const posted: HostMessage[] = [];
  const calls = { errors: [] as string[], progress: [] as string[] };
  const deps: CompareDeps = {
    pickFile: async () => (options.pick ? options.pick() : uri('/work/shop-v1.xd')),
    readDesign: async (target) => {
      const file = files.get(target.path);
      if (!file) {
        throw new Error('ENOENT');
      }
      return Buffer.isBuffer(file) ? openDesignDocument(target.path, file) : file;
    },
    withProgress: (title, task) => {
      calls.progress.push(title);
      return options.progress ? options.progress(task) : task();
    },
    showErrorMessage: (message) => calls.errors.push(message),
  };
  // Every message crosses VS Code's serializer, as it would on its way to the webview.
  const compare = new CompareSession(openedSource, deps, (message) => posted.push(deserializeInWebview(serializeForWebview(message)) as HostMessage));
  return {
    compare,
    posted,
    calls,
    files,
    reload: (title: string) => {
      opened = design(title, 'artboard-home', 'img-new');
    },
    types: () => posted.map((message) => (message.type === 'compare' ? `compare:${message.summary ? (message.summary.swapped ? 'swapped' : 'on') : 'off'}` : message.type === 'document' ? `document:${message.fileName}` : message.type)),
  };
}

/** The later text of the Text row in an artboard message's diff. */
function textAfter(message: HostMessage): string | undefined {
  const props = message.type === 'artboard' ? (message.diff?.changes.flatMap((change) => change.props) ?? []) : [];
  return props.find((prop) => prop.label === 'Text')?.after;
}

function summaryOf(message: HostMessage | undefined) {
  assert.equal(message?.type, 'compare');
  return message?.type === 'compare' ? message.summary : null;
}

describe('CompareSession', () => {
  it('answers from the opened file and refuses earlier-version requests until comparing', () => {
    const { compare } = session();
    assert.equal(compare.after.name, 'shop.xd');
    assert.equal(compare.before, null);
    const message = compare.artboard('artboard-home', new Set());
    assert.equal(message.type, 'artboard');
    assert.ok(message.type === 'artboard' && !('diff' in message) && !('side' in message));
    assert.deepEqual(compare.artboard('artboard-home', new Set(), 'before'), { type: 'error', message: 'Not comparing with another version' });
  });

  it('does nothing when the dialog is cancelled, and reports a file it cannot open', async () => {
    const cancelled = session({ pick: () => undefined });
    await cancelled.compare.pick();
    assert.deepEqual(cancelled.posted, []);

    const broken = session({ pick: () => uri('/work/broken.xd') });
    await broken.compare.pick();
    assert.deepEqual(broken.posted, []);
    assert.deepEqual(broken.calls.errors, ['Could not open broken.xd: Not an Adobe XD file (manifest missing)']);
    assert.equal(broken.compare.before, null);
  });

  it('compares with the picked file and sends each artboard with its diff, for either version', async () => {
    const { compare, posted, calls } = session();
    await compare.pick();
    assert.deepEqual(calls.progress, ['Comparing with shop-v1.xd']);
    const summary = summaryOf(posted[0]);
    assert.equal(posted.length, 1);
    assert.equal(summary?.beforeName, 'shop-v1.xd');
    assert.equal(summary?.afterName, 'shop.xd');
    assert.equal(summary?.swapped, false);
    assert.deepEqual(summary?.artboards.map((artboard) => [artboard.afterId, artboard.status]), [['artboard-home', 'changed']]);

    const current = compare.artboard('artboard-home', new Set());
    assert.ok(current.type === 'artboard' && current.diff);
    const props = current.diff.changes.flatMap((change) => change.props);
    assert.deepEqual(props.find((prop) => prop.label === 'Text'), { label: 'Text', before: 'Spring Sale', after: 'Summer Sale' });
    // Two images of the same size, told apart by their content hashes.
    const image = props.find((prop) => prop.label === 'Image');
    assert.match(image?.before ?? '', /^40 × 40 · [0-9a-f]{7}$/);
    assert.match(image?.after ?? '', /^40 × 40 · [0-9a-f]{7}$/);
    assert.notEqual(image?.before, image?.after);
    const earlier = compare.artboard('artboard-home', new Set(), 'before');
    assert.ok(earlier.type === 'artboard');
    assert.equal(earlier.side, 'before');
    assert.equal(earlier.diff?.afterId, 'artboard-home');
    assert.deepEqual(earlier.images.map((image) => image.uid), ['img-old']);
    assert.equal(earlier.images[0]?.data.constructor, Uint8Array);
  });

  it('swaps: the other file becomes the later version, for artboards and search', async () => {
    const { compare, posted, types } = session();
    await compare.pick();
    posted.length = 0;
    compare.swap();
    assert.deepEqual(types(), ['compare:swapped', 'document:shop-v1.xd']);
    const summary = summaryOf(posted[0]);
    assert.equal(summary?.beforeName, 'shop.xd');
    assert.equal(summary?.afterName, 'shop-v1.xd');
    assert.equal(compare.after.name, 'shop-v1.xd');
    const current = compare.artboard('artboard-home', new Set());
    assert.ok(current.type === 'artboard');
    assert.deepEqual(current.images.map((image) => image.uid), ['img-old']);
    assert.equal(textAfter(current), 'Spring Sale');
    const hits = await compare.search('spring', 1);
    assert.ok(hits.type === 'searchResults' && hits.total === 1);
  });

  it('exits back to the opened file, and swaps it back first when it was the earlier version', async () => {
    const plain = session();
    await plain.compare.pick();
    plain.posted.length = 0;
    plain.compare.exit();
    assert.deepEqual(plain.types(), ['compare:off']);
    assert.equal(plain.compare.before, null);

    const swapped = session();
    await swapped.compare.pick();
    swapped.compare.swap();
    swapped.posted.length = 0;
    swapped.compare.exit();
    assert.deepEqual(swapped.types(), ['compare:off', 'document:shop.xd']);
    assert.equal(swapped.compare.after.name, 'shop.xd');
  });

  it('compares again when the opened file changes on disk, and when another file is picked', async () => {
    const { compare, posted, types, reload } = session();
    await compare.pick();
    const first = summaryOf(posted[0])?.generation ?? 0;
    posted.length = 0;
    reload('Autumn Sale');
    await compare.openedChanged();
    assert.deepEqual(types(), ['document:shop.xd', 'compare:on']);
    assert.ok((summaryOf(posted[1])?.generation ?? 0) > first);
    const current = compare.artboard('artboard-home', new Set());
    assert.equal(textAfter(current), 'Autumn Sale');

    compare.swap();
    posted.length = 0;
    await compare.pick();
    assert.deepEqual(types(), ['compare:off', 'document:shop.xd', 'compare:on'], 'leaves the swapped comparison first');
  });

  it('drops the result of a comparison that a newer one replaced, and sends nothing once disposed', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const slow = session({
      progress: async (task) => {
        if (first) {
          first = false;
          await gate;
        }
        return task();
      },
    });
    const stale = slow.compare.pick();
    await new Promise((resolve) => setImmediate(resolve));
    await slow.compare.pick();
    release();
    await stale;
    assert.deepEqual(slow.types(), ['compare:off', 'compare:on'], 'one summary, from the second pick');

    const closing = session();
    const running = closing.compare.pick();
    closing.compare.dispose();
    await running;
    assert.deepEqual(closing.posted, []);
  });
});
