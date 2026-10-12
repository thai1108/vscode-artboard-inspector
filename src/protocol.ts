import { sniffImageMime } from './image.ts';
import type { BoardLayout } from './scene/board.ts';
import type { ArtboardScene, ArtboardSummary } from './scene/scene.ts';

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
  /** Answer to pickScreenshot: an image checked by screenshot.ts, to overlay on `artboardId`. */
  | { type: 'screenshot'; artboardId: string; name: string; data: Uint8Array }
  | { type: 'error'; message: string };

/** Webview → extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'loadArtboard'; id: string; knownImages: string[] }
  | { type: 'loadArtboards'; ids: string[]; knownImages: string[] }
  | { type: 'copy'; text: string; label: string }
  | { type: 'pickScreenshot'; artboardId: string }
  /** An exported layer or embedded image; the host asks the user where to save it. */
  | { type: 'save'; fileName: string; data: Uint8Array };

export type SaveRequest = Extract<WebviewMessage, { type: 'save' }>;

export const MESSAGE_LIMITS = {
  idLength: 512,
  /** Artboards per loadArtboards request. */
  batchIds: 32,
  knownImages: 10_000,
  copyTextLength: 1024 * 1024,
  labelLength: 200,
  saveBytes: 64 * 1024 * 1024,
  /** In UTF-8 bytes; most file systems allow 255 per name. */
  fileNameBytes: 240,
};

/** File types the host writes, with the content type the bytes must sniff as. */
export const EXPORT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
} as const;

export type ExportExtension = keyof typeof EXPORT_TYPES;

/** Path separators, characters Windows reserves, control and bidi characters, unpaired surrogates. */
const UNSAFE_FILE_NAME_CHARACTERS = /[\\/:*?"<>|\p{Cc}\p{Cs}\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
/** Device names Windows reserves, also when followed by an extension ("NUL.txt.png"). */
export const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

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
    case 'pickScreenshot': {
      const { artboardId } = message;
      if (!isString(artboardId, MESSAGE_LIMITS.idLength)) {
        return null;
      }
      return { type: 'pickScreenshot', artboardId };
    }
    case 'save': {
      const { fileName, data } = message;
      if (!isSafeFileName(fileName) || !(data instanceof Uint8Array) || !data.byteLength || data.byteLength > MESSAGE_LIMITS.saveBytes) {
        return null;
      }
      // The bytes must be what the extension says, so a name like "icon.svg" never carries something else.
      return sniffImageMime(data) === EXPORT_TYPES[extensionOf(fileName)] ? { type: 'save', fileName, data } : null;
    }
    default:
      return null;
  }
}

/**
 * A bare file name the host may suggest in a save dialog: a known export extension in lower case, no path
 * separators or traversal, not hidden (leading dot), nothing Windows would strip (trailing dot/space) or treat as a device.
 */
export function isSafeFileName(value: unknown): value is string {
  if (typeof value !== 'string' || utf8Length(value) > MESSAGE_LIMITS.fileNameBytes || UNSAFE_FILE_NAME_CHARACTERS.test(value)) {
    return false;
  }
  const [, base = '', extension = ''] = /^(.+)\.([a-z]+)$/.exec(value) ?? [];
  return Object.hasOwn(EXPORT_TYPES, extension) && !base.startsWith('.') && !/[. ]$/.test(base) && !WINDOWS_RESERVED_NAME.test(value);
}

/** The extension of a name that passed isSafeFileName. */
export function extensionOf(fileName: string): ExportExtension {
  return fileName.slice(fileName.lastIndexOf('.') + 1) as ExportExtension;
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isStringList(value: unknown, maxItems: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === 'string' && item.length <= MESSAGE_LIMITS.idLength)
  );
}
