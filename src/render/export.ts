import { sniffImageMime } from '../image.ts';
import { MESSAGE_LIMITS, WINDOWS_RESERVED_NAME, utf8Length, type ExportExtension } from '../protocol.ts';
import type { ArtboardScene, ImagePaint, SceneNode, Shadow, Stroke } from '../scene/scene.ts';
import { union, type Box } from './geometry.ts';
import { renderLayerSvg, type ImageUrlResolver } from './svg.ts';

export const EXPORT_SCALES = [1, 2, 3] as const;
/** Chrome refuses larger canvases; the pixel cap keeps the bitmap (4 bytes per pixel) within reason. */
export const PNG_LIMITS = { side: 16384, pixels: 100_000_000 };

const EXTENSION_FOR_TYPE: Record<string, ExportExtension> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};
const PATH_CHARACTERS = /[\\/:*?"<>|]+/g;
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cs}‎‏‪-‮⁦-⁩]/gu;

/** The layers from the top level down to `key`, or null when the scene has no such layer. */
export function layerPath(scene: ArtboardScene, key: string): SceneNode[] | null {
  const walk = (nodes: SceneNode[]): SceneNode[] | null => {
    for (const node of nodes) {
      if (node.key === key) {
        return [node];
      }
      const below = node.kind === 'group' ? walk(node.children) : null;
      if (below) {
        return [node, ...below];
      }
    }
    return null;
  };
  return walk(scene.children);
}

/** The embedded image a layer is filled with: a shape's fill or a frame's own background. */
export function imageFillOf(node: SceneNode): ImagePaint | null {
  const fill = node.kind === 'shape' ? node.fill : node.kind === 'group' ? (node.frame?.fill ?? null) : null;
  return fill?.kind === 'image' ? fill : null;
}

/** Every embedded image drawn by the layer or its descendants. */
export function imageUidsOf(node: SceneNode, uids = new Set<string>()): Set<string> {
  const fill = imageFillOf(node);
  if (fill) {
    uids.add(fill.uid);
  }
  if (node.kind === 'group') {
    node.children.forEach((child) => imageUidsOf(child, uids));
  }
  return uids;
}

/** Extension for an image's declared content type, or null when the host would not write that type. */
export function extensionForType(mime: string): ExportExtension | null {
  return EXTENSION_FOR_TYPE[mime] ?? null;
}

/** Extension for embedded image bytes, from their magic bytes (which the host checks against the extension). */
export function imageExtension(data: Uint8Array): ExportExtension | null {
  return extensionForType(sniffImageMime(data));
}

/**
 * The suggested file name for an exported layer: the layer name with path separators turned into "-", invisible
 * characters and leading dots dropped, shortened to fit file systems, then `suffix` (e.g. "@2x") and the extension.
 */
export function exportFileName(layerName: string, extension: ExportExtension, suffix = ''): string {
  const tail = `${suffix}.${extension}`;
  const cleaned = layerName.normalize('NFC').replace(/\s+/g, ' ').replace(INVISIBLE_CHARACTERS, '').replace(PATH_CHARACTERS, '-').replace(/^[\s.-]+/, '');
  // One byte stays free for the "_" that defuses Windows device names.
  let base = truncateUtf8(cleaned, MESSAGE_LIMITS.fileNameBytes - utf8Length(tail) - 1).replace(/[\s.]+$/, '') || 'layer';
  if (WINDOWS_RESERVED_NAME.test(base + tail)) {
    base = `_${base}`;
  }
  return base + tail;
}

/**
 * What a layer paints, in artboard pixels: its measured box grown by strokes reaching outside the shape and by
 * shadows, so exports do not cut them off. The growth is axis-aligned, so rotated layers get a slightly loose box.
 */
export function paintedBox(node: SceneNode, boxes: ReadonlyMap<string, Box>): Box | null {
  const own = boxes.get(node.key) ?? null;
  let box = own;
  if (node.kind === 'shape') {
    box = own && grow(own, strokeOutset(node.stroke, node.geometry.type === 'line'));
  } else if (node.kind === 'group') {
    const frame = node.frame && own ? grow(own, strokeOutset(node.frame.stroke, false)) : null;
    // A clipped group's measured box already ends at the clip.
    const content = node.clip ? own : union(node.children.map((child) => paintedBox(child, boxes)).filter((child) => child !== null));
    box = union([frame, content].filter((part) => part !== null));
  }
  // The renderer draws no shadows on lines.
  const isLine = node.kind === 'shape' && node.geometry.type === 'line';
  return box && !isLine ? withShadows(box, node.shadows) : box;
}

/** Pixel size of a PNG of `box` at `scale`, at least 1 × 1. */
export function pngSize(box: Box, scale: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(box.width * scale)), height: Math.max(1, Math.round(box.height * scale)) };
}

/**
 * The SVG file of a layer. Gradient/clip/filter ids are prefixed with a hash of the drawing, so several exports
 * pasted into one page do not clash, while exporting the same layer again gives the same file.
 */
export function layerSvgFile(
  node: SceneNode,
  ancestors: readonly SceneNode[],
  box: Box,
  imageUrl: ImageUrlResolver,
  size?: { width: number; height: number },
): string {
  const draft = renderLayerSvg(node, ancestors, box, imageUrl, { idPrefix: 'ai', size });
  return renderLayerSvg(node, ancestors, box, imageUrl, { idPrefix: `ai${hash(draft)}`, size });
}

export function dataUrl(mime: string, data: Uint8Array): string {
  return `data:${mime};base64,${base64(data)}`;
}

export function base64(data: Uint8Array): string {
  const chunks: string[] = [];
  // Chunked: spreading a large array into fromCharCode overflows the call stack.
  for (let i = 0; i < data.length; i += 0x8000) {
    chunks.push(String.fromCharCode(...data.subarray(i, i + 0x8000)));
  }
  return btoa(chunks.join(''));
}

function strokeOutset(stroke: Stroke | null, isLine: boolean): number {
  if (!stroke) {
    return 0;
  }
  if (isLine || stroke.align === 'center') {
    return stroke.width / 2;
  }
  return stroke.align === 'outside' ? stroke.width : 0;
}

function grow(box: Box, amount: number): Box {
  return { x: box.x - amount, y: box.y - amount, width: box.width + amount * 2, height: box.height + amount * 2 };
}

/** The renderer blurs with a standard deviation of blur / 2, so the shadow fades out within `blur` of its edge. */
function withShadows(box: Box, shadows: Shadow[]): Box {
  const cast = shadows.map((shadow) => ({
    x: box.x + shadow.x - shadow.blur,
    y: box.y + shadow.y - shadow.blur,
    width: box.width + shadow.blur * 2,
    height: box.height + shadow.blur * 2,
  }));
  return union([box, ...cast]) ?? box;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > maxBytes) {
      break;
    }
    end += char.length;
  }
  return value.slice(0, end);
}

/** FNV-1a, base 36. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  }
  return (h >>> 0).toString(36);
}
