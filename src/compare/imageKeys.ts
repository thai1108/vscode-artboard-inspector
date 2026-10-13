import { createHash } from 'node:crypto';
import type { DesignDocument } from '../document.ts';

/** Image bytes hashed per file; beyond it, images are told apart by their uid alone. */
export const IMAGE_HASH_BYTES = 512 * 1024 * 1024;

/**
 * Content identity of a file's embedded images, hashed on first use: XD gives a re-inserted image a new uid, and the
 * same uid in two files does not have to be the same image.
 */
export function imageKeys(design: Pick<DesignDocument, 'image'>, limit = IMAGE_HASH_BYTES): (uid: string) => string {
  const keys = new Map<string, string>();
  let hashed = 0;
  return (uid) => {
    let key = keys.get(uid);
    if (key === undefined) {
      const data = hashed < limit ? design.image(uid)?.data : undefined;
      if (data) {
        hashed += data.byteLength;
        key = createHash('sha256').update(data).digest('hex');
      } else {
        key = `uid:${uid}`;
      }
      keys.set(uid, key);
    }
    return key;
  };
}
