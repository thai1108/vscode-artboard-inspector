// Encodes synthetic RGB PNGs, e.g. screenshots to overlay in tests.
import { crc32, deflateSync } from 'node:zlib';

export type Rgb = [number, number, number];

export function encodePng(width: number, height: number, pixel: (x: number, y: number) => Rgb): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      row.set(pixel(x, y), 1 + x * 3);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Horizontal bands, so a misplaced or wrongly scaled overlay is easy to spot in a screenshot. */
export function bandedPng(width: number, height: number, band = 40): Buffer {
  const colors: Rgb[] = [
    [37, 99, 235],
    [249, 250, 251],
    [244, 63, 94],
    [17, 24, 39],
  ];
  return encodePng(width, height, (_x, y) => colors[Math.floor(y / band) % colors.length] ?? [0, 0, 0]);
}
