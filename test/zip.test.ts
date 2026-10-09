import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZipArchive } from '../src/zip.ts';
import { writeZip } from './support/zipWriter.ts';

describe('ZipArchive', () => {
  it('reads stored and deflated entries with UTF-8 names', () => {
    const zip = ZipArchive.open(
      writeZip([
        { name: 'mimetype', data: 'plain', store: true },
        { name: 'artwork/画面/data.json', data: JSON.stringify({ hello: 'world'.repeat(100) }) },
      ]),
    );
    assert.deepEqual(zip.names(), ['mimetype', 'artwork/画面/data.json']);
    assert.equal(zip.readText('mimetype'), 'plain');
    assert.deepEqual(JSON.parse(zip.readText('artwork/画面/data.json')), { hello: 'world'.repeat(100) });
  });

  it('finds the central directory behind an archive comment', () => {
    const zip = ZipArchive.open(writeZip([{ name: 'a.txt', data: 'A' }], 'a trailing comment'));
    assert.equal(zip.readText('a.txt'), 'A');
  });

  it('reports missing entries and non-ZIP input', () => {
    const zip = ZipArchive.open(writeZip([{ name: 'a.txt', data: 'A' }]));
    assert.equal(zip.has('b.txt'), false);
    assert.throws(() => zip.read('b.txt'), /ZIP entry not found: b\.txt/);
    assert.throws(() => ZipArchive.open(Buffer.from('not a zip file at all, just some text')), /Not a ZIP archive/);
    assert.throws(() => ZipArchive.open(Buffer.alloc(4)), /Not a ZIP archive/);
  });
});
