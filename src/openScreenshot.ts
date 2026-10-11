import * as path from 'node:path';
import * as vscode from 'vscode';
import type { HostMessage } from './protocol.ts';
import { assertScreenshotSize, SCREENSHOT_EXTENSIONS, screenshotMessage } from './screenshot.ts';

/** Reads an image to overlay on `artboardId`; oversized files are refused before they are read. */
export async function readScreenshot(uri: vscode.Uri, artboardId: string): Promise<HostMessage> {
  const name = path.posix.basename(uri.path);
  assertScreenshotSize(name, (await vscode.workspace.fs.stat(uri)).size);
  return screenshotMessage(artboardId, name, await vscode.workspace.fs.readFile(uri));
}

/** Asks for a screenshot to overlay on `artboardId`; undefined when the dialog is cancelled. */
export async function pickScreenshot(artboardId: string): Promise<HostMessage | undefined> {
  const picked = await vscode.window.showOpenDialog({
    title: 'Overlay a screenshot on the artboard',
    openLabel: 'Overlay',
    canSelectMany: false,
    filters: { Images: SCREENSHOT_EXTENSIONS },
  });
  const uri = picked?.[0];
  return uri ? readScreenshot(uri, artboardId) : undefined;
}
