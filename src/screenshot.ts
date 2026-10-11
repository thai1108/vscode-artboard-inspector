// Screenshot overlays: the same checks run in the extension host (file picker) and in the webview (paste), so a
// non-image or oversized file is refused wherever it comes from.
import type { HostMessage } from './protocol.ts';

export const SCREENSHOT_MAX_BYTES = 50 * 1024 * 1024;
/** Offered by the file picker; the content is still checked by its signature. */
export const SCREENSHOT_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];

export type ScreenshotMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** The image type from the file signature, or null for anything but PNG, JPEG and WebP. */
export function screenshotMime(bytes: Uint8Array): ScreenshotMime | null {
  const has = (signature: number[], offset = 0) => signature.every((byte, i) => bytes[offset + i] === byte);
  if (has([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (has([0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  return null;
}

/** Throws when a file of `size` bytes is too large to overlay; checked before the file is read. */
export function assertScreenshotSize(name: string, size: number): void {
  if (size > SCREENSHOT_MAX_BYTES) {
    throw new Error(`${name} is too large to overlay (${Math.round(size / 1024 / 1024)} MB; limit ${SCREENSHOT_MAX_BYTES / 1024 / 1024} MB)`);
  }
}

/** The image type of screenshot bytes; throws a message for the user when they cannot be overlaid. */
export function screenshotType(name: string, bytes: Uint8Array): ScreenshotMime {
  assertScreenshotSize(name, bytes.byteLength);
  const mime = screenshotMime(bytes);
  if (!mime) {
    throw new Error(`${name} is not a PNG, JPEG or WebP image`);
  }
  return mime;
}

/** The answer to pickScreenshot; the bytes are copied into a plain Uint8Array for the webview serializer (see payload.ts). */
export function screenshotMessage(artboardId: string, name: string, bytes: Uint8Array): HostMessage {
  screenshotType(name, bytes);
  return { type: 'screenshot', artboardId, name, data: new Uint8Array(bytes) };
}
