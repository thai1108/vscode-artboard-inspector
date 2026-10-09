import type * as vscode from 'vscode';
import { DesignEditorProvider } from './designEditorProvider.ts';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(...DesignEditorProvider.register(context));
}

export function deactivate(): void {}
