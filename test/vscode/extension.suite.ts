// Runs inside a real VS Code extension host (pnpm test:vscode): the custom editors must open the sample files.
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

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
});
