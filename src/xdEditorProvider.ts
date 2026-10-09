import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { HostMessage, ImagePayload, WebviewMessage } from './protocol.ts';
import { XdDocument } from './xd/parse.ts';
import { ZipArchive } from './zip.ts';

const RELOAD_DEBOUNCE_MS = 500;

async function readXd(uri: vscode.Uri): Promise<XdDocument> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return XdDocument.open(ZipArchive.open(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
}

/** The opened .xd file; re-reads itself when the file changes on disk (e.g. a designer drops a new version). */
class XdCustomDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri;
  private current: XdDocument;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly watcher: vscode.FileSystemWatcher;
  private reloadTimer: NodeJS.Timeout | undefined;

  private constructor(uri: vscode.Uri, xd: XdDocument) {
    this.uri = uri;
    this.current = xd;
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), path.posix.basename(uri.path)),
    );
    this.watcher.onDidChange(() => this.scheduleReload());
    this.watcher.onDidCreate(() => this.scheduleReload());
  }

  static async load(uri: vscode.Uri): Promise<XdCustomDocument> {
    return new XdCustomDocument(uri, await readXd(uri));
  }

  get xd(): XdDocument {
    return this.current;
  }

  private scheduleReload(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), RELOAD_DEBOUNCE_MS);
  }

  private async reload(): Promise<void> {
    try {
      this.current = await readXd(this.uri);
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

export class XdEditorProvider implements vscode.CustomReadonlyEditorProvider<XdCustomDocument> {
  static readonly viewType = 'designViewer.xd';
  private readonly extensionUri: vscode.Uri;

  private constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(XdEditorProvider.viewType, new XdEditorProvider(context.extensionUri), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    });
  }

  openCustomDocument(uri: vscode.Uri): Promise<XdCustomDocument> {
    return XdCustomDocument.load(uri);
  }

  resolveCustomEditor(document: XdCustomDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [dist, media] };
    webview.html = webviewHtml(webview, vscode.Uri.joinPath(dist, 'webview.js'), vscode.Uri.joinPath(media, 'viewer.css'));

    const post = (message: HostMessage) => void webview.postMessage(message);
    const postDocument = () =>
      post({ type: 'document', fileName: path.posix.basename(document.uri.path), artboards: [...document.xd.artboards] });

    const subscriptions: vscode.Disposable[] = [
      document.onDidChange(postDocument),
      webview.onDidReceiveMessage((message: WebviewMessage) => {
        switch (message.type) {
          case 'ready':
            postDocument();
            break;
          case 'loadArtboard':
            post(loadArtboard(document.xd, message.id, new Set(message.knownImages)));
            break;
          case 'copy':
            void vscode.env.clipboard.writeText(message.text);
            vscode.window.setStatusBarMessage(`Copied ${message.label}`, 2000);
            break;
        }
      }),
    ];
    panel.onDidDispose(() => subscriptions.forEach((subscription) => subscription.dispose()));
  }
}

function loadArtboard(xd: XdDocument, id: string, knownImages: Set<string>): HostMessage {
  try {
    const scene = xd.scene(id);
    const images: ImagePayload[] = [];
    for (const uid of scene.imageUids) {
      const image = knownImages.has(uid) ? undefined : xd.image(uid);
      if (image) {
        images.push({ uid, mime: image.mime, data: image.data });
      }
    }
    return { type: 'artboard', scene, images };
  } catch (error) {
    return { type: 'error', message: (error as Error).message };
  }
}

function webviewHtml(webview: vscode.Webview, script: vscode.Uri, style: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} blob: data:`,
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
<title>Design Viewer</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${webview.asWebviewUri(script).toString()}"></script>
</body>
</html>`;
}
