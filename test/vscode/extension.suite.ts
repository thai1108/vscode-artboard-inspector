// Runs inside a real VS Code extension host (pnpm test:vscode): the custom editors must open the sample files.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CompareSession } from '../../src/compareSession.ts';
import { readDesign, vscodeCompareDeps, vscodeSaveDeps } from '../../src/designEditorProvider.ts';
import { readScreenshot } from '../../src/openScreenshot.ts';
import { parseWebviewMessage, type HostMessage } from '../../src/protocol.ts';
import { saveExport } from '../../src/saveExport.ts';
import { buildSearchIndex } from '../../src/search.ts';

// Mocha's TDD globals, provided by @vscode/test-cli inside the extension host.
declare function suite(name: string, body: () => void): void;
declare function test(name: string, body: () => Promise<void>): void;
declare function teardown(body: () => Thenable<unknown>): void;

/** .vscode-test.mjs opens dist-test/vscode/workspace, written by make-fixtures.ts. */
function workspacePath(file: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the test workspace folder is open');
  return path.join(folder.uri.fsPath, file);
}

async function waitFor<T>(read: () => T | undefined, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}; open tabs: ${describeTabs()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function describeTabs(): string {
  return JSON.stringify(
    vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs.map((tab) => ({
        label: tab.label,
        active: tab.isActive && group.isActive,
        input: tab.input instanceof vscode.TabInputCustom ? `custom:${tab.input.viewType}` : tab.input instanceof vscode.TabInputText ? 'text' : String((tab.input as { constructor?: { name?: string } } | undefined)?.constructor?.name),
      })),
    ),
  );
}

function activeCustomTab(): vscode.TabInputCustom | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom ? input : undefined;
}

/**
 * Opens `uri` with VS Code's default editor resolution. On a cold first start the workbench can still be restoring
 * and swallow the first open, so a second attempt is made before failing.
 */
async function openByDefault(uri: vscode.Uri): Promise<vscode.TabInputCustom> {
  for (let attempt = 1; ; attempt++) {
    await vscode.commands.executeCommand('vscode.open', uri);
    try {
      return await waitFor(() => activeCustomTab(), 'custom editor tab', 15_000);
    } catch (error) {
      if (attempt >= 2) {
        throw error;
      }
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  }
}

suite('Artboard Inspector in VS Code', () => {
  teardown(() => vscode.commands.executeCommand('workbench.action.closeAllEditors'));

  test('opens .xd files in the Artboard Inspector editor by default and activates the extension', async () => {
    const uri = vscode.Uri.file(workspacePath('sample-store.xd'));
    const tab = await openByDefault(uri);
    assert.equal(tab.viewType, 'artboardInspector.xd');
    assert.equal(tab.uri.fsPath, uri.fsPath);
    const extension = vscode.extensions.getExtension('thai1108.artboard-inspector');
    assert.ok(extension, 'extension is installed in the test host');
    await waitFor(() => (extension.isActive ? true : undefined), 'extension activation');
  });

  test('opens .fig files in the Artboard Inspector editor by default', async () => {
    const uri = vscode.Uri.file(workspacePath('sample.fig'));
    const tab = await openByDefault(uri);
    assert.equal(tab.viewType, 'artboardInspector.fig');
    assert.equal(tab.uri.fsPath, uri.fsPath);
  });

  test('saves a file a webview posts as a Uint8Array next to the design file', async () => {
    // A webview of this extension posts the way the inspector's export buttons do, so the bytes take VS Code's
    // real webview → extension host path; only the save dialog is answered by the test.
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3];
    const panel = vscode.window.createWebviewPanel('artboardInspector.exportProbe', 'Export probe', vscode.ViewColumn.One, { enableScripts: true });
    const target = vscode.Uri.file(workspacePath('Probe@2x.png'));
    try {
      let received: unknown;
      panel.webview.onDidReceiveMessage((message: unknown) => {
        received = message;
      });
      panel.webview.html =
        `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-probe'"></head><body>` +
        `<script nonce="probe">acquireVsCodeApi().postMessage({ type: 'save', fileName: 'Probe@2x.png', data: new Uint8Array(${JSON.stringify(bytes)}) });</script>` +
        '</body></html>';
      const raw = await waitFor(() => received, 'the message from the webview');
      assert.ok((raw as { data?: unknown }).data instanceof Uint8Array, `data arrived as ${Object.prototype.toString.call((raw as { data?: unknown }).data)}`);
      const message = parseWebviewMessage(raw);
      assert.ok(message?.type === 'save', 'the save message passes validation');

      const dialogs: vscode.SaveDialogOptions[] = [];
      const shown: string[] = [];
      const saved = await saveExport(message, {
        ...vscodeSaveDeps(vscode.Uri.file(workspacePath('sample-store.xd'))),
        showSaveDialog: async (options) => {
          dialogs.push(options);
          return options.defaultUri;
        },
        showInformationMessage: (text) => shown.push(text),
      });
      assert.equal(dialogs[0]?.defaultUri?.fsPath, target.fsPath, 'the dialog starts in the design file folder');
      assert.equal(saved?.fsPath, target.fsPath);
      assert.deepEqual([...(await vscode.workspace.fs.readFile(target))], bytes);
      assert.deepEqual(shown, [`Saved ${target.fsPath}`]);
    } finally {
      panel.dispose();
      await Promise.resolve(vscode.workspace.fs.delete(target)).catch(() => undefined);
    }
  });

  test('reads a screenshot to overlay through the VS Code file system as a plain Uint8Array', async () => {
    const file = workspacePath('login@2x.png');
    const message = await readScreenshot(vscode.Uri.file(file), '1:10');
    assert.equal(message.type, 'screenshot');
    if (message.type === 'screenshot') {
      assert.equal(message.artboardId, '1:10');
      assert.equal(message.name, 'login@2x.png');
      // A Node Buffer would reach the webview as { type: 'Buffer', data: [...] } (see payload.ts).
      assert.equal(message.data.constructor, Uint8Array);
      assert.equal(message.data.buffer.byteLength, message.data.byteLength);
      assert.ok(Buffer.from(message.data).equals(readFileSync(file)));
    }
  });

  test('compares an open design with an earlier version picked in the dialog, read through VS Code', async () => {
    const cases = [
      { later: 'sample-store.xd', earlier: 'sample-store-v1.xd', artboard: 'artboard-demo-0', row: { label: 'X', before: '231', after: '223' } },
      { later: 'sample.fig', earlier: 'sample-v1.fig', artboard: '1:10', row: { label: 'Y', before: '580', after: '600' } },
    ];
    for (const { later, earlier, artboard, row } of cases) {
      const laterUri = vscode.Uri.file(workspacePath(later));
      const opened = await readDesign(laterUri);
      const posted: HostMessage[] = [];
      const errors: string[] = [];
      const session = new CompareSession(
        () => ({ name: later, design: opened, searchIndex: () => buildSearchIndex(opened) }),
        { ...vscodeCompareDeps(laterUri), pickFile: async () => vscode.Uri.file(workspacePath(earlier)), showErrorMessage: (message) => errors.push(message) },
        (message) => posted.push(message),
      );
      await session.pick();
      assert.deepEqual(errors, [], later);
      const summary = posted.find((message) => message.type === 'compare');
      assert.ok(summary?.type === 'compare' && summary.summary, later);
      assert.equal(summary.summary.beforeName, earlier);
      assert.equal(summary.summary.artboards.find((entry) => entry.afterId === artboard)?.status, 'changed', later);
      const reply = session.artboard(artboard, new Set());
      assert.ok(reply.type === 'artboard', later);
      assert.ok(reply.diff?.changes.some((change) => change.props.some((prop) => prop.label === row.label && prop.before === row.before && prop.after === row.after)), `${later}: ${JSON.stringify(reply.diff?.changes)}`);
      const previous = session.artboard(summary.summary.artboards.find((entry) => entry.afterId === artboard)?.beforeId ?? '', new Set(), 'before');
      assert.equal(previous.type === 'artboard' ? previous.side : previous.type, 'before', later);
    }
  });

  test('refuses to compare with a design file over the size limit, before reading it', async () => {
    const laterUri = vscode.Uri.file(workspacePath('sample-store.xd'));
    const opened = await readDesign(laterUri);
    const posted: HostMessage[] = [];
    const errors: string[] = [];
    const session = new CompareSession(
      () => ({ name: 'sample-store.xd', design: opened, searchIndex: () => buildSearchIndex(opened) }),
      { ...vscodeCompareDeps(laterUri), pickFile: async () => vscode.Uri.file(workspacePath('oversized.xd')), showErrorMessage: (message) => errors.push(message) },
      (message) => posted.push(message),
    );
    await session.pick();
    assert.deepEqual(posted, []);
    assert.deepEqual(errors, ['Could not open oversized.xd: File is too large to open (300 MB; limit 300 MB)']);
  });

  test('refuses screenshots that are not images or are too large', async () => {
    await assert.rejects(readScreenshot(vscode.Uri.file(workspacePath('notes.png')), '1:10'), /notes\.png is not a PNG, JPEG or WebP image/);
    await assert.rejects(readScreenshot(vscode.Uri.file(workspacePath('oversized.png')), '1:10'), /oversized\.png is too large to overlay \(50 MB; limit 50 MB\)/);
    await assert.rejects(readScreenshot(vscode.Uri.file(workspacePath('missing.png')), '1:10'));
  });
});
