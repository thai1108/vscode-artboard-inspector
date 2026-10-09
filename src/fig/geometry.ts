// Figma stores precomputed outlines (fillGeometry / strokeGeometry) as binary command blobs:
// a command byte followed by little-endian float32 coordinates in the node's local space.

const CLOSE = 0;
const MOVE = 1;
const LINE = 2;
const QUAD = 3;
const CUBIC = 4;

/** Converts a command blob to SVG path data, or null when the blob is malformed. */
export function commandsToPath(blob: Uint8Array): string | null {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const parts: string[] = [];
  let offset = 0;
  const read = (count: number): number[] | null => {
    if (offset + count * 4 > blob.byteLength) {
      return null;
    }
    const values: number[] = [];
    for (let i = 0; i < count; i++) {
      values.push(round(view.getFloat32(offset, true)));
      offset += 4;
    }
    return values;
  };
  while (offset < blob.byteLength) {
    const command = blob[offset++];
    let values: number[] | null;
    switch (command) {
      case CLOSE:
        parts.push('Z');
        continue;
      case MOVE:
        values = read(2);
        if (values) parts.push(`M${values.join(' ')}`);
        break;
      case LINE:
        values = read(2);
        if (values) parts.push(`L${values.join(' ')}`);
        break;
      case QUAD:
        values = read(4);
        if (values) parts.push(`Q${values.join(' ')}`);
        break;
      case CUBIC:
        values = read(6);
        if (values) parts.push(`C${values.join(' ')}`);
        break;
      default:
        return null;
    }
    if (!values) {
      return null;
    }
  }
  return parts.join('');
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
