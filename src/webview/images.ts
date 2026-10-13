import type { ImagePayload } from '../protocol.ts';
import { extensionForType } from '../render/export.ts';
import type { ArtboardScene } from '../scene/scene.ts';

/** Embedded images of one design file, as blob: URLs. Two versions being compared each have their own. */
export class ImageStore {
  private readonly urls = new Map<string, string>();
  /** The blobs behind the URLs, kept for exports (the CSP blocks fetching blob: URLs). */
  readonly blobs = new Map<string, Blob>();
  /** Images whose bytes did not arrive as a Uint8Array; shown as a layer warning instead of a silent broken image. */
  private readonly undecodable = new Set<string>();

  add(images: ImagePayload[]): void {
    for (const image of images) {
      if (this.urls.has(image.uid)) {
        continue;
      }
      if (!(image.data instanceof Uint8Array)) {
        this.undecodable.add(image.uid);
        continue;
      }
      const blob = new Blob([image.data as Uint8Array<ArrayBuffer>], { type: image.mime });
      this.blobs.set(image.uid, blob);
      this.urls.set(image.uid, URL.createObjectURL(blob));
    }
  }

  url(uid: string): string | undefined {
    return this.urls.get(uid);
  }

  /** Uids to tell the host, so it sends only images not held yet. */
  known(): string[] {
    return [...this.urls.keys()];
  }

  /** File extension of an image held, for "Save image". */
  format(uid: string): string | undefined {
    return extensionForType(this.blobs.get(uid)?.type ?? '') ?? undefined;
  }

  noteUndecodable(scenes: ArtboardScene[]): void {
    for (const target of scenes) {
      for (const uid of target.imageUids) {
        const warning = `Image ${uid} could not be decoded`;
        if (this.undecodable.has(uid) && !target.warnings.includes(warning)) {
          target.warnings.push(warning);
        }
      }
    }
  }

  clear(): void {
    for (const url of this.urls.values()) {
      URL.revokeObjectURL(url);
    }
    this.urls.clear();
    this.blobs.clear();
    this.undecodable.clear();
  }
}
