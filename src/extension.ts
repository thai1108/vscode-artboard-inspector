import type * as vscode from 'vscode';
import { XdEditorProvider } from './xdEditorProvider.ts';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(XdEditorProvider.register(context));
}

export function deactivate(): void {}
