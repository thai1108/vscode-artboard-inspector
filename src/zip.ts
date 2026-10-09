import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const ZIP64_MARKER = 0xffffffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** Guards against ZIP bombs: every entry is inflated to exactly its declared size, which these caps bound. */
export interface ZipLimits {
  maxEntrySize: number;
  maxTotalSize: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntrySize: 64 * 1024 * 1024,
  maxTotalSize: 512 * 1024 * 1024,
};

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localHeaderOffset: number;
}

/** Read-only view of a ZIP archive held in memory (stored and deflate entries, no ZIP64). */
export class ZipArchive {
  private readonly buffer: Buffer;
  private readonly entries: ReadonlyMap<string, ZipEntry>;

  private constructor(buffer: Buffer, entries: ReadonlyMap<string, ZipEntry>) {
    this.buffer = buffer;
    this.entries = entries;
  }

  static open(buffer: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipArchive {
    const eocd = findEndOfCentralDirectory(buffer);
    const count = buffer.readUInt16LE(eocd + 10);
    const directoryOffset = buffer.readUInt32LE(eocd + 16);
    if (directoryOffset === ZIP64_MARKER) {
      throw new Error('ZIP64 archives are not supported');
    }

    const entries = new Map<string, ZipEntry>();
    let totalSize = 0;
    let offset = directoryOffset;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) {
        throw new Error(`Corrupt ZIP central directory at entry ${i}`);
      }
      const nameLength = buffer.readUInt16LE(offset + 28);
      const extraLength = buffer.readUInt16LE(offset + 30);
      const commentLength = buffer.readUInt16LE(offset + 32);
      const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
      const entry: ZipEntry = {
        name,
        method: buffer.readUInt16LE(offset + 10),
        compressedSize: buffer.readUInt32LE(offset + 20),
        size: buffer.readUInt32LE(offset + 24),
        localHeaderOffset: buffer.readUInt32LE(offset + 42),
      };
      if (entry.compressedSize === ZIP64_MARKER || entry.size === ZIP64_MARKER || entry.localHeaderOffset === ZIP64_MARKER) {
        throw new Error('ZIP64 archives are not supported');
      }
      if (entry.size > limits.maxEntrySize) {
        throw new Error(`ZIP entry too large: ${name} (${formatMegabytes(entry.size)}; limit ${formatMegabytes(limits.maxEntrySize)})`);
      }
      totalSize += entry.size;
      if (totalSize > limits.maxTotalSize) {
        throw new Error(`ZIP archive too large when unpacked (limit ${formatMegabytes(limits.maxTotalSize)})`);
      }
      entries.set(name, entry);
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return new ZipArchive(buffer, entries);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  read(name: string): Buffer {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new Error(`ZIP entry not found: ${name}`);
    }
    const header = entry.localHeaderOffset;
    if (this.buffer.readUInt32LE(header) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error(`Corrupt ZIP local header: ${name}`);
    }
    const start = header + 30 + this.buffer.readUInt16LE(header + 26) + this.buffer.readUInt16LE(header + 28);
    if (start + entry.compressedSize > this.buffer.length) {
      throw new Error(`Corrupt ZIP entry (truncated data): ${name}`);
    }
    const data = this.buffer.subarray(start, start + entry.compressedSize);
    let output: Buffer;
    switch (entry.method) {
      case METHOD_STORED:
        output = data;
        break;
      case METHOD_DEFLATE:
        output = inflateExactly(data, entry);
        break;
      default:
        throw new Error(`Unsupported ZIP compression method ${entry.method}: ${name}`);
    }
    if (output.length !== entry.size) {
      throw new Error(`Corrupt ZIP entry (size mismatch): ${name}`);
    }
    return output;
  }

  readText(name: string): string {
    return this.read(name).toString('utf8');
  }
}

/** Inflates at most the declared size; a stream that would produce more is rejected instead of filling memory. */
function inflateExactly(data: Buffer, entry: ZipEntry): Buffer {
  try {
    return inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`Corrupt ZIP entry (inflates beyond its declared size): ${entry.name}`, { cause: error });
    }
    throw error;
  }
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= lowest; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new Error('Not a ZIP archive (end of central directory not found)');
}
