import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import type * as vscode from 'vscode';
import { parseWebviewMessage, type SaveRequest } from '../src/protocol.ts';
import { saveExport, type SaveDeps } from '../src/saveExport.ts';
import { receivedFromWebview } from './support/vscodeWebviewSerializer.ts';
import { PNG_BYTES } from './support/xdFixture.ts';

const DESIGN = '/work/designs/shop.xd';
const uri = (fsPath: string) => ({ fsPath, scheme: 'file' }) as unknown as vscode.Uri;
const request: SaveRequest = { type: 'save', fileName: 'Hero image@2x.png', data: new Uint8Array(PNG_BYTES) };

/** Fake VS Code: the dialog answers with `choose(defaultUri)`, files land in `written`. */
function fakeHost(choose: (suggested: vscode.Uri) => vscode.Uri | undefined | Promise<vscode.Uri | undefined>, writeError?: Error) {
  const calls = {
    dialogs: [] as vscode.SaveDialogOptions[],
    written: new Map<string, Uint8Array>(),
    info: [] as string[],
    errors: [] as string[],
  };
  const deps: SaveDeps = {
    defaultUri: (fileName) => uri(path.posix.join(path.posix.dirname(DESIGN), fileName)),
    showSaveDialog: async (options) => {
      calls.dialogs.push(options);
      return choose(options.defaultUri as vscode.Uri);
    },
    writeFile: async (target, data) => {
      if (writeError) {
        throw writeError;
      }
      calls.written.set(target.fsPath, data);
    },
    showInformationMessage: (message) => calls.info.push(message),
    showErrorMessage: (message) => calls.errors.push(message),
  };
  return { deps, calls };
}

describe('saveExport', () => {
  it('suggests the file in the design folder with a filter for its type, writes it and reports the path', async () => {
    const { deps, calls } = fakeHost((suggested) => suggested);
    const saved = await saveExport(request, deps);
    assert.equal(saved?.fsPath, '/work/designs/Hero image@2x.png');
    assert.equal(calls.dialogs.length, 1);
    assert.equal(calls.dialogs[0]?.defaultUri?.fsPath, '/work/designs/Hero image@2x.png');
    assert.deepEqual(calls.dialogs[0]?.filters, { 'PNG image': ['png'] });
    assert.equal(calls.dialogs[0]?.saveLabel, 'Export');
    assert.deepEqual([...calls.written.keys()], ['/work/designs/Hero image@2x.png']);
    assert.equal(calls.written.get('/work/designs/Hero image@2x.png'), request.data);
    assert.deepEqual(calls.info, ['Saved /work/designs/Hero image@2x.png']);
    assert.deepEqual(calls.errors, []);
  });

  it('writes where the user chose instead', async () => {
    const { deps, calls } = fakeHost(() => uri('/elsewhere/hero.png'));
    await saveExport(request, deps);
    assert.deepEqual([...calls.written.keys()], ['/elsewhere/hero.png']);
    assert.deepEqual(calls.info, ['Saved /elsewhere/hero.png']);
  });

  it('offers both JPEG extensions and SVG on their own', async () => {
    const { deps, calls } = fakeHost(() => undefined);
    await saveExport({ ...request, fileName: 'photo.jpg' }, deps);
    await saveExport({ ...request, fileName: 'icon.svg' }, deps);
    assert.deepEqual(
      calls.dialogs.map((options) => options.filters),
      [{ 'JPEG image': ['jpg', 'jpeg'] }, { 'SVG image': ['svg'] }],
    );
  });

  it('does nothing when the dialog is cancelled', async () => {
    const { deps, calls } = fakeHost(() => undefined);
    assert.equal(await saveExport(request, deps), undefined);
    assert.equal(calls.written.size, 0);
    assert.deepEqual([calls.info, calls.errors], [[], []]);
  });

  it('reports a failed write or dialog instead of a success', async () => {
    const denied = fakeHost((suggested) => suggested, new Error('EACCES: permission denied'));
    assert.equal(await saveExport(request, denied.deps), undefined);
    assert.deepEqual(denied.calls.errors, ['Could not save Hero image@2x.png: EACCES: permission denied']);
    assert.deepEqual(denied.calls.info, []);

    const broken = fakeHost(() => Promise.reject(new Error('dialog unavailable')));
    assert.equal(await saveExport(request, broken.deps), undefined);
    assert.deepEqual(broken.calls.errors, ['Could not save Hero image@2x.png: dialog unavailable']);
  });

  it('writes the exact bytes a webview posted, after VS Code’s transport and validation', async () => {
    const posted = { type: 'save', fileName: 'Hero image.png', data: new Uint8Array(PNG_BYTES) };
    const message = parseWebviewMessage(receivedFromWebview(posted));
    assert.equal(message?.type, 'save');
    const { deps, calls } = fakeHost((suggested) => suggested);
    await saveExport(message as SaveRequest, deps);
    const written = calls.written.get('/work/designs/Hero image.png');
    assert.ok(written instanceof Uint8Array);
    assert.deepEqual(Buffer.from(written), PNG_BYTES);
  });
});
