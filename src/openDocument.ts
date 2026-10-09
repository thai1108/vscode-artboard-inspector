import type { DesignDocument } from './document.ts';
import { FigDocument } from './fig/parse.ts';
import { XdDocument } from './xd/parse.ts';
import { ZipArchive } from './zip.ts';

/** Opens a design file by extension: `.fig` (Figma local copy) or `.xd`. */
export function openDesignDocument(fileName: string, bytes: Buffer): DesignDocument {
  if (/\.fig$/i.test(fileName)) {
    return FigDocument.open(bytes);
  }
  return XdDocument.open(ZipArchive.open(bytes));
}
