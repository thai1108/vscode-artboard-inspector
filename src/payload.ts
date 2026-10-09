import type { DesignDocument } from './document.ts';
import type { HostMessage, ImagePayload } from './protocol.ts';
import type { ArtboardScene } from './scene/scene.ts';

/** The answer to loadArtboard. */
export function artboardMessage(design: DesignDocument, id: string, knownImages: Set<string>): HostMessage {
  try {
    const scene = design.scene(id);
    return { type: 'artboard', scene, images: collectImages(design, [scene], knownImages) };
  } catch (error) {
    return { type: 'error', message: (error as Error).message };
  }
}

/** The answer to loadArtboards (board view); artboards that fail to convert are reported, not dropped. */
export function scenesMessage(design: DesignDocument, ids: string[], knownImages: Set<string>): HostMessage {
  const scenes: ArtboardScene[] = [];
  const failed: { id: string; message: string }[] = [];
  for (const id of ids) {
    try {
      scenes.push(design.scene(id));
    } catch (error) {
      failed.push({ id, message: (error as Error).message });
    }
  }
  return { type: 'scenes', scenes, images: collectImages(design, scenes, knownImages), failed };
}

/**
 * Image payloads the webview does not have yet, each sent once even when several scenes use it.
 *
 * The bytes are copied into a plain, exactly-sized Uint8Array: VS Code's webview serializer JSON.stringifies the
 * message with a replacer that turns typed arrays into transferred buffers, but a Node Buffer's toJSON() runs first
 * (it would arrive as `{ type: 'Buffer', data: [...] }`), and a view into the whole .xd/.fig file would transfer
 * the entire file once per image.
 */
export function collectImages(design: DesignDocument, scenes: ArtboardScene[], knownImages: Set<string>): ImagePayload[] {
  const sent = new Set(knownImages);
  const images: ImagePayload[] = [];
  for (const uid of scenes.flatMap((scene) => scene.imageUids)) {
    const image = sent.has(uid) ? undefined : design.image(uid);
    sent.add(uid);
    if (image) {
      images.push({ uid, mime: image.mime, data: new Uint8Array(image.data) });
    }
  }
  return images;
}
