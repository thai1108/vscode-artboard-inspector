import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZipArchive } from '../src/zip.ts';
import { writeZip } from './support/zipWriter.ts';

const EOCD_SIZE = 22;

function sample(): Buffer {
  return writeZip([{ name: 'a.txt', data: 'hello', store: true }]);
}

function centralOffset(zip: Buffer): number {
  return zip.readUInt32LE(zip.length - EOCD_SIZE + 16);
}

describe('ZipArchive with broken archives', () => {
  it('refuses ZIP64 archives', () => {
    const zip = sample();
    zip.writeUInt32LE(0xffffffff, zip.length - EOCD_SIZE + 16);
    assert.throws(() => ZipArchive.open(zip), /ZIP64 archives are not supported/);
  });

  it('reports a central directory that points at the wrong place', () => {
    const zip = sample();
    zip.writeUInt32LE(0, zip.length - EOCD_SIZE + 16);
    assert.throws(() => ZipArchive.open(zip), /Corrupt ZIP central directory at entry 0/);
  });

  it('reports a central directory that runs past the end of the file', () => {
    const zip = sample();
    zip.writeUInt16LE(5, zip.length - EOCD_SIZE + 10);
    assert.throws(() => ZipArchive.open(zip), /Corrupt ZIP central directory at entry 1/);
  });

  it('reports a damaged local header when the entry is read', () => {
    const zip = sample();
    zip.writeUInt32LE(0, 0);
    const archive = ZipArchive.open(zip);
    assert.throws(() => archive.read('a.txt'), /Corrupt ZIP local header: a\.txt/);
  });

  it('reports compression methods other than stored and deflate', () => {
    const zip = sample();
    zip.writeUInt16LE(12, centralOffset(zip) + 10);
    const archive = ZipArchive.open(zip);
    assert.throws(() => archive.read('a.txt'), /Unsupported ZIP compression method 12: a\.txt/);
  });

  it('reports truncated archives as not ZIP', () => {
    const zip = writeZip([{ name: 'a.txt', data: 'x'.repeat(1000) }]);
    assert.throws(() => ZipArchive.open(zip.subarray(0, zip.length - 30)), /Not a ZIP archive/);
  });

  it('opens an empty archive', () => {
    const archive = ZipArchive.open(writeZip([]));
    assert.deepEqual(archive.names(), []);
  });

  it('reads binary stored entries unchanged', () => {
    const bytes = Buffer.from([0, 255, 1, 254, 0x50, 0x4b, 0x05, 0x06]);
    const archive = ZipArchive.open(writeZip([{ name: 'bin', data: bytes, store: true }]));
    assert.deepEqual([...archive.read('bin')], [...bytes]);
  });
});
