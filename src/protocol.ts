import type { BoardLayout } from './scene/board.ts';
import type { ArtboardScene, ArtboardSummary } from './scene/scene.ts';
import type { SearchHit } from './search.ts';

export interface ImagePayload {
  uid: string;
  mime: string;
  data: Uint8Array;
}

/** Extension host → webview. */
export type HostMessage =
  | { type: 'document'; fileName: string; artboards: ArtboardSummary[]; board: BoardLayout }
  | { type: 'artboard'; scene: ArtboardScene; images: ImagePayload[] }
  /** Answer to loadArtboards (board view); artboards that failed to convert are listed in `failed`. */
  | { type: 'scenes'; scenes: ArtboardScene[]; images: ImagePayload[]; failed: { id: string; message: string }[] }
  /** Answer to search; `seq` is the request's, so the webview can drop answers to queries it has moved past. */
  | { type: 'searchResults'; seq: number; hits: SearchHit[]; total: number; searched: number; error?: string }
  /** Answer to pickScreenshot: an image checked by screenshot.ts, to overlay on `artboardId`. */
  | { type: 'screenshot'; artboardId: string; name: string; data: Uint8Array }
  | { type: 'error'; message: string };

/** Webview → extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'loadArtboard'; id: string; knownImages: string[] }
  | { type: 'loadArtboards'; ids: string[]; knownImages: string[] }
  | { type: 'copy'; text: string; label: string }
  | { type: 'search'; query: string; seq: number }
  | { type: 'pickScreenshot'; artboardId: string };

export const MESSAGE_LIMITS = {
  idLength: 512,
  /** Artboards per loadArtboards request. */
  batchIds: 32,
  knownImages: 10_000,
  copyTextLength: 1024 * 1024,
  labelLength: 200,
  searchQueryLength: 200,
  /** Hits per searchResults answer. */
  searchResults: 200,
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
      if (!isString(id, MESSAGE_LIMITS.idLength) || !isStringList(knownImages, MESSAGE_LIMITS.knownImages)) {
        return null;
      }
      return { type: 'loadArtboard', id, knownImages };
    }
    case 'loadArtboards': {
      const { ids, knownImages } = message;
      if (!isStringList(ids, MESSAGE_LIMITS.batchIds) || !ids.length || !isStringList(knownImages, MESSAGE_LIMITS.knownImages)) {
        return null;
      }
      return { type: 'loadArtboards', ids, knownImages };
    }
    case 'copy': {
      const { text, label } = message;
      if (!isString(text, MESSAGE_LIMITS.copyTextLength) || !isString(label, MESSAGE_LIMITS.labelLength)) {
        return null;
      }
      return { type: 'copy', text, label };
    }
    case 'search': {
      const { query, seq } = message;
      if (!isString(query, MESSAGE_LIMITS.searchQueryLength) || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
        return null;
      }
      return { type: 'search', query, seq };
    }
    case 'pickScreenshot': {
      const { artboardId } = message;
      if (!isString(artboardId, MESSAGE_LIMITS.idLength)) {
        return null;
      }
      return { type: 'pickScreenshot', artboardId };
    }
    default:
      return null;
  }
}

function isStringList(value: unknown, maxItems: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === 'string' && item.length <= MESSAGE_LIMITS.idLength)
  );
}
