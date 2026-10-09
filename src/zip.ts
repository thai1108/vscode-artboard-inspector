import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const ZIP64_MARKER = 0xffffffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

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

  static open(buffer: Buffer): ZipArchive {
    const eocd = findEndOfCentralDirectory(buffer);
    const count = buffer.readUInt16LE(eocd + 10);
    const directoryOffset = buffer.readUInt32LE(eocd + 16);
    if (directoryOffset === ZIP64_MARKER) {
      throw new Error('ZIP64 archives are not supported');
    }

    const entries = new Map<string, ZipEntry>();
    let offset = directoryOffset;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) {
        throw new Error(`Corrupt ZIP central directory at entry ${i}`);
      }
      const nameLength = buffer.readUInt16LE(offset + 28);
      const extraLength = buffer.readUInt16LE(offset + 30);
      const commentLength = buffer.readUInt16LE(offset + 32);
      const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
      entries.set(name, {
        name,
        method: buffer.readUInt16LE(offset + 10),
        compressedSize: buffer.readUInt32LE(offset + 20),
        size: buffer.readUInt32LE(offset + 24),
        localHeaderOffset: buffer.readUInt32LE(offset + 42),
      });
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
    const data = this.buffer.subarray(start, start + entry.compressedSize);
    switch (entry.method) {
      case METHOD_STORED:
        return data;
      case METHOD_DEFLATE:
        return inflateRawSync(data);
      default:
        throw new Error(`Unsupported ZIP compression method ${entry.method}: ${name}`);
    }
  }

  readText(name: string): string {
    return this.read(name).toString('utf8');
  }
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
