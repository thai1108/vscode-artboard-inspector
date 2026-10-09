import type { ArtboardScene, ArtboardSummary } from './xd/scene.ts';

export interface ImagePayload {
  uid: string;
  mime: string;
  data: Uint8Array;
}

/** Extension host → webview. */
export type HostMessage =
  | { type: 'document'; fileName: string; artboards: ArtboardSummary[] }
  | { type: 'artboard'; scene: ArtboardScene; images: ImagePayload[] }
  | { type: 'error'; message: string };

/** Webview → extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'loadArtboard'; id: string; knownImages: string[] }
  | { type: 'copy'; text: string; label: string };
