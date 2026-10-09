import type { WebviewMessage } from '../protocol.ts';

export interface ViewerState {
  artboardId?: string;
  sidebarHidden?: boolean;
  mode?: 'artboard' | 'board';
  boardPage?: number;
}

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): ViewerState | undefined;
  setState(state: ViewerState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();
