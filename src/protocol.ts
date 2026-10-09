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

export const MESSAGE_LIMITS = {
  idLength: 512,
  knownImages: 10_000,
  copyTextLength: 1024 * 1024,
  labelLength: 200,
};

/** Validates a message from the webview at runtime; anything malformed or oversized is dropped. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const message = raw as Record<string, unknown>;
  const isString = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
  switch (message['type']) {
    case 'ready':
      return { type: 'ready' };
    case 'loadArtboard': {
      const { id, knownImages } = message;
      if (
        !isString(id, MESSAGE_LIMITS.idLength) ||
        !Array.isArray(knownImages) ||
        knownImages.length > MESSAGE_LIMITS.knownImages ||
        !knownImages.every((uid) => isString(uid, MESSAGE_LIMITS.idLength))
      ) {
        return null;
      }
      return { type: 'loadArtboard', id, knownImages };
    }
    case 'copy': {
      const { text, label } = message;
      if (!isString(text, MESSAGE_LIMITS.copyTextLength) || !isString(label, MESSAGE_LIMITS.labelLength)) {
        return null;
      }
      return { type: 'copy', text, label };
    }
    default:
      return null;
  }
}
