import { inflateRawSync, inflateSync, zstdDecompressSync } from 'node:zlib';
import { ZipArchive } from '../zip.ts';
import { decodeMessage, decodeSchema } from './kiwi.ts';
import type { FigMessage } from './types.ts';

const MiB = 1024 * 1024;

/** Size caps against decompression bombs in hostile files; real files stay far below them. */
export interface FigLimits {
  /** Any one entry of the ZIP container (canvas.fig, an image), unpacked. */
  maxEntryBytes: number;
  /** All ZIP entries together, unpacked. */
  maxTotalBytes: number;
  maxSchemaBytes: number;
  maxMessageBytes: number;
}

export const DEFAULT_FIG_LIMITS: FigLimits = {
  maxEntryBytes: 256 * MiB,
  maxTotalBytes: 1024 * MiB,
  maxSchemaBytes: 16 * MiB,
  maxMessageBytes: 512 * MiB,
};

export interface FigFile {
  message: FigMessage;
  /** Image bytes by lowercase hex SHA-1, from the ZIP's images/ folder. */
  image(hash: string): Uint8Array | undefined;
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/**
 * Reads a Figma "Save local copy" file: either a ZIP (canvas.fig, meta.json, thumbnail.png, images/<sha1>)
 * or the bare canvas, which is `fig-kiwi` (or `fig-jam.`) + u32 version + length-prefixed chunks:
 * the kiwi schema, then the document message.
 */
export function readFigFile(bytes: Buffer, limits: FigLimits = DEFAULT_FIG_LIMITS): FigFile {
  if (startsWith(bytes, ZIP_MAGIC)) {
    const zip = ZipArchive.open(bytes, { maxEntrySize: limits.maxEntryBytes, maxTotalSize: limits.maxTotalBytes });
    if (!zip.has('canvas.fig')) {
      throw new Error('Not a Figma file (canvas.fig missing)');
    }
    return {
      message: decodeCanvas(zip.read('canvas.fig'), limits),
      image: (hash) => {
        const path = `images/${hash}`;
        return /^[0-9a-f]+$/.test(hash) && zip.has(path) ? zip.read(path) : undefined;
      },
    };
  }
  return { message: decodeCanvas(bytes, limits), image: () => undefined };
}

function decodeCanvas(canvas: Buffer, limits: FigLimits): FigMessage {
  const magic = canvas.toString('latin1', 0, 8);
  if (magic !== 'fig-kiwi' && magic !== 'fig-jam.') {
    throw new Error('Not a Figma file (unknown header)');
  }
  const chunks: Buffer[] = [];
  let offset = 12;
  while (offset + 4 <= canvas.length && chunks.length < 2) {
    const length = canvas.readUInt32LE(offset);
    if (offset + 4 + length > canvas.length) {
      throw new Error('Corrupt Figma file (chunk past end of file)');
    }
    chunks.push(canvas.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  const [schemaChunk, messageChunk] = chunks;
  if (!schemaChunk || !messageChunk) {
    throw new Error('Corrupt Figma file (schema or document missing)');
  }
  const schema = decodeSchema(decompress(schemaChunk, limits.maxSchemaBytes));
  return decodeMessage(schema, 'Message', decompress(messageChunk, limits.maxMessageBytes)) as FigMessage;
}

function decompress(chunk: Buffer, maxOutputLength: number): Buffer {
  try {
    if (startsWith(chunk, ZSTD_MAGIC)) {
      return zstdDecompressSync(chunk, { maxOutputLength });
    }
    try {
      return inflateRawSync(chunk, { maxOutputLength });
    } catch (error) {
      // Some files wrap the deflate stream in a zlib header instead.
      if ((error as NodeJS.ErrnoException).code !== 'Z_DATA_ERROR') {
        throw error;
      }
      return inflateSync(chunk, { maxOutputLength });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error('Figma file section too large to decompress', { cause: error });
    }
    throw error;
  }
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((byte, i) => bytes[i] === byte);
}
