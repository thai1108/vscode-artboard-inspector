import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CompareSession, type CompareDeps } from './compareSession.ts';
import type { DesignDocument } from './document.ts';
import { openDesignDocument } from './openDocument.ts';
import { pickScreenshot } from './openScreenshot.ts';
import { parseWebviewMessage, type HostMessage } from './protocol.ts';
import { saveExport, type SaveDeps } from './saveExport.ts';
import { buildSearchIndex, type SearchIndex } from './search.ts';

const RELOAD_DEBOUNCE_MS = 500;
const MAX_FILE_SIZE = 300 * 1024 * 1024;

/** Saves exports next to the design file by default, through VS Code's dialog and file system. */
export function vscodeSaveDeps(designUri: vscode.Uri): SaveDeps {
  return {
    defaultUri: (fileName) => vscode.Uri.joinPath(designUri, '..', fileName),
    showSaveDialog: (options) => vscode.window.showSaveDialog(options),
    writeFile: (uri, data) => vscode.workspace.fs.writeFile(uri, data),
    showInformationMessage: (message) => void vscode.window.showInformationMessage(message),
    showErrorMessage: (message) => void vscode.window.showErrorMessage(message),
  };
}

/** Compares with a file picked in VS Code's open dialog, read through VS Code's file system. */
export function vscodeCompareDeps(designUri: vscode.Uri): CompareDeps {
  return {
    pickFile: async () =>
      (
        await vscode.window.showOpenDialog({
          title: 'Compare with another version of this design',
          openLabel: 'Compare',
          canSelectMany: false,
          defaultUri: vscode.Uri.joinPath(designUri, '..'),
          filters: { 'Design files': ['xd', 'fig'] },
        })
      )?.[0],
    readDesign,
    withProgress: (title, task) => vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, task),
    showErrorMessage: (message) => void vscode.window.showErrorMessage(message),
  };
}

/** Reads and opens a design file, refusing files over the size limit before reading them. */
export async function readDesign(uri: vscode.Uri): Promise<DesignDocument> {
  const { size } = await vscode.workspace.fs.stat(uri);
  if (size > MAX_FILE_SIZE) {
    throw new Error(`File is too large to open (${Math.round(size / 1024 / 1024)} MB; limit ${MAX_FILE_SIZE / 1024 / 1024} MB)`);
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return openDesignDocument(uri.path, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

/** The opened .xd/.fig file; re-reads itself when the file changes on disk (e.g. a designer drops a new version). */
class DesignCustomDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri;
  private current: DesignDocument;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly watcher: vscode.FileSystemWatcher;
  private reloadTimer: NodeJS.Timeout | undefined;
  private index: Promise<SearchIndex> | undefined;

  private constructor(uri: vscode.Uri, design: DesignDocument) {
    this.uri = uri;
    this.current = design;
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), path.posix.basename(uri.path)),
    );
    this.watcher.onDidChange(() => this.scheduleReload());
    this.watcher.onDidCreate(() => this.scheduleReload());
  }

  static async load(uri: vscode.Uri): Promise<DesignCustomDocument> {
    return new DesignCustomDocument(uri, await readDesign(uri));
  }

  get design(): DesignDocument {
    return this.current;
  }

  /** Built on the first search and shared by every editor of the file until it changes on disk. */
  searchIndex(): Promise<SearchIndex> {
    this.index ??= buildSearchIndex(this.current);
    return this.index;
  }

  private scheduleReload(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), RELOAD_DEBOUNCE_MS);
  }

  private async reload(): Promise<void> {
    try {
      this.current = await readDesign(this.uri);
      this.index = undefined;
      this.changed.fire();
    } catch (error) {
      void vscode.window.showWarningMessage(
        `Could not reload ${path.posix.basename(this.uri.path)}: ${(error as Error).message}`,
      );
    }
  }

  dispose(): void {
    clearTimeout(this.reloadTimer);
    this.watcher.dispose();
    this.changed.dispose();
  }
}

export class DesignEditorProvider implements vscode.CustomReadonlyEditorProvider<DesignCustomDocument> {
  /** One provider serves both editors declared in package.json. */
  static readonly viewTypes = ['artboardInspector.xd', 'artboardInspector.fig'];
  private readonly extensionUri: vscode.Uri;

  private constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  static register(context: vscode.ExtensionContext): vscode.Disposable[] {
    const provider = new DesignEditorProvider(context.extensionUri);
    return DesignEditorProvider.viewTypes.map((viewType) =>
      vscode.window.registerCustomEditorProvider(viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }),
    );
  }

  openCustomDocument(uri: vscode.Uri): Promise<DesignCustomDocument> {
    return DesignCustomDocument.load(uri);
  }

  resolveCustomEditor(document: DesignCustomDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [dist, media] };
    webview.html = webviewHtml(webview, vscode.Uri.joinPath(dist, 'webview.js'), vscode.Uri.joinPath(media, 'viewer.css'));

    const post = (message: HostMessage) => void webview.postMessage(message);
    const name = path.posix.basename(document.uri.path);
    // Each editor compares on its own; the opened file is re-read from `document` because it reloads on change.
    const session = new CompareSession(() => ({ name, design: document.design, searchIndex: () => document.searchIndex() }), vscodeCompareDeps(document.uri), post);

    const subscriptions: vscode.Disposable[] = [
      document.onDidChange(() => void session.openedChanged()),
      webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseWebviewMessage(raw);
        switch (message?.type) {
          case 'ready':
            session.ready();
            break;
          case 'loadArtboard':
            post(session.artboard(message.id, new Set(message.knownImages), message.side));
            break;
          case 'loadArtboards':
            post(session.scenes(message.ids, new Set(message.knownImages)));
            break;
          case 'copy':
            void vscode.env.clipboard.writeText(message.text);
            vscode.window.setStatusBarMessage(`Copied ${message.label}`, 2000);
            break;
          case 'search':
            void session.search(message.query, message.seq).then(post);
            break;
          case 'pickCompare':
            void session.pick();
            break;
          case 'swapCompare':
            session.swap();
            break;
          case 'exitCompare':
            session.exit();
            break;
          case 'pickScreenshot':
            void pickScreenshot(message.artboardId).then(
              (reply) => {
                if (reply) {
                  post(reply);
                }
              },
              (error: unknown) => void vscode.window.showErrorMessage(`Could not overlay the screenshot: ${(error as Error).message}`),
            );
            break;
          case 'save':
            void saveExport(message, vscodeSaveDeps(document.uri));
            break;
        }
      }),
    ];
    panel.onDidDispose(() => {
      session.dispose();
      subscriptions.forEach((subscription) => subscription.dispose());
    });
  }
}

function webviewHtml(webview: vscode.Webview, script: vscode.Uri, style: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `img-src ${webview.cspSource} blob:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${webview.asWebviewUri(style).toString()}">
<title>Artboard Inspector</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${webview.asWebviewUri(script).toString()}"></script>
</body>
</html>`;
}
