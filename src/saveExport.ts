import type * as vscode from 'vscode';
import { extensionOf, type ExportExtension, type SaveRequest } from './protocol.ts';

/** The VS Code calls a save makes, injected so the flow can be tested without a running editor. */
export interface SaveDeps {
  /** Where the dialog starts: the suggested name in the design file's folder. */
  defaultUri(fileName: string): vscode.Uri;
  showSaveDialog(options: vscode.SaveDialogOptions): Thenable<vscode.Uri | undefined>;
  writeFile(uri: vscode.Uri, data: Uint8Array): Thenable<void>;
  showInformationMessage(message: string): void;
  showErrorMessage(message: string): void;
}

const FILTERS: Record<ExportExtension, [string, string[]]> = {
  png: ['PNG image', ['png']],
  jpg: ['JPEG image', ['jpg', 'jpeg']],
  jpeg: ['JPEG image', ['jpeg', 'jpg']],
  gif: ['GIF image', ['gif']],
  webp: ['WebP image', ['webp']],
  svg: ['SVG image', ['svg']],
};

/** Asks where to save an export (a validated save message) and writes it; resolves to the file written, if any. */
export async function saveExport(request: SaveRequest, deps: SaveDeps): Promise<vscode.Uri | undefined> {
  const [filterName, extensions] = FILTERS[extensionOf(request.fileName)];
  let target: vscode.Uri | undefined;
  try {
    target = await deps.showSaveDialog({
      defaultUri: deps.defaultUri(request.fileName),
      filters: { [filterName]: extensions },
      saveLabel: 'Export',
      title: `Export ${request.fileName}`,
    });
    if (target) {
      await deps.writeFile(target, request.data);
    }
  } catch (error) {
    deps.showErrorMessage(`Could not save ${request.fileName}: ${(error as Error).message}`);
    return undefined;
  }
  if (target) {
    deps.showInformationMessage(`Saved ${target.fsPath}`);
  }
  return target;
}
