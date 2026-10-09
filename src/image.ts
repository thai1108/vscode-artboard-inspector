export function sniffImageMime(data: Uint8Array): string {
  const ascii = (start: number, end: number) => String.fromCharCode(...data.subarray(start, end));
  if (data[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 3) === 'GIF') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (/^\s*<(\?xml|svg)/.test(ascii(0, 64))) return 'image/svg+xml';
  return 'application/octet-stream';
}

/** Pixel size of a PNG or baseline/progressive JPEG, or null for other formats. */
export function imageSize(data: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (sniffImageMime(data) === 'image/png' && data.length >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (sniffImageMime(data) === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        return null;
      }
      const marker = data[offset + 1] as number;
      const length = view.getUint16(offset + 2);
      // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return null;
}
