import { MESSAGE_LIMITS } from '../protocol.ts';
import {
  dataUrl,
  exportFileName,
  imageExtension,
  imageFillOf,
  imageUidsOf,
  layerPath,
  layerSvgFile,
  paintedBox,
  PNG_LIMITS,
  pngSize,
} from '../render/export.ts';
import type { Box } from '../render/geometry.ts';
import { renderLayerSvg } from '../render/svg.ts';
import type { ArtboardScene, SceneNode } from '../scene/scene.ts';
import { displayName } from './layers.ts';

export type ExportFormat = 'image' | 'svg' | 'png';

/** A layer to export, with the layer boxes measured for its artboard. */
export interface ExportTarget {
  scene: ArtboardScene;
  key: string;
  boxes: ReadonlyMap<string, Box>;
}

export interface ExportedFile {
  fileName: string;
  data: Uint8Array;
}

/** Builds the file behind an inspector export button; rejects with a message meant for the user. */
export async function exportLayer(target: ExportTarget, format: ExportFormat, scale: number, images: ReadonlyMap<string, Blob>): Promise<ExportedFile> {
  const path = layerPath(target.scene, target.key);
  const node = path?.at(-1);
  if (!path || !node) {
    throw new Error('the layer is no longer in this artboard');
  }
  const file = format === 'image' ? await embeddedImage(node, images) : await drawing(node, path.slice(0, -1), target.boxes, format, scale, images);
  if (file.data.byteLength > MESSAGE_LIMITS.saveBytes) {
    const mb = (bytes: number) => Math.ceil(bytes / 1024 / 1024);
    throw new Error(`${file.fileName} is too large to save (${mb(file.data.byteLength)} MB; limit ${mb(MESSAGE_LIMITS.saveBytes)} MB)`);
  }
  return file;
}

async function embeddedImage(node: SceneNode, images: ReadonlyMap<string, Blob>): Promise<ExportedFile> {
  const fill = imageFillOf(node);
  const blob = fill ? images.get(fill.uid) : undefined;
  if (!blob) {
    throw new Error('this layer has no embedded image');
  }
  const data = new Uint8Array(await blob.arrayBuffer());
  const extension = imageExtension(data);
  if (!extension) {
    throw new Error('the embedded image is not a PNG, JPEG, GIF, WebP or SVG file');
  }
  return { fileName: exportFileName(displayName(node), extension), data };
}

async function drawing(
  node: SceneNode,
  ancestors: SceneNode[],
  boxes: ReadonlyMap<string, Box>,
  format: 'svg' | 'png',
  scale: number,
  images: ReadonlyMap<string, Blob>,
): Promise<ExportedFile> {
  const box = paintedBox(node, boxes);
  if (!box) {
    throw new Error('this layer draws nothing');
  }
  // A file (and an SVG loaded as an image) cannot reach the webview's blob: URLs, so images go inline.
  const urls = new Map<string, string>();
  for (const uid of imageUidsOf(node)) {
    const blob = images.get(uid);
    if (blob) {
      urls.set(uid, dataUrl(blob.type, new Uint8Array(await blob.arrayBuffer())));
    }
  }
  const imageUrl = (uid: string) => urls.get(uid);
  if (format === 'svg') {
    return { fileName: exportFileName(displayName(node), 'svg'), data: new TextEncoder().encode(layerSvgFile(node, ancestors, box, imageUrl)) };
  }
  const size = pngSize(box, scale);
  if (size.width > PNG_LIMITS.side || size.height > PNG_LIMITS.side || size.width * size.height > PNG_LIMITS.pixels) {
    throw new Error(`${size.width} × ${size.height} px is too large for a PNG`);
  }
  // Only ever drawn on its own, so the ids need no file-unique prefix.
  const data = await rasterize(renderLayerSvg(node, ancestors, box, imageUrl, { idPrefix: 'ai', size }), size);
  return { fileName: exportFileName(displayName(node), 'png', scale === 1 ? '' : `@${scale}x`), data };
}

/**
 * Draws an SVG document on a canvas and encodes it as PNG. The SVG is loaded from a blob: URL (which the webview
 * CSP allows) and carries its images as data: URIs, so it is same-origin and the canvas is not tainted.
 */
export async function rasterize(svg: string, size: { width: number; height: number }): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('no canvas is available to draw the PNG');
  }
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    context.drawImage(image, 0, 0, size.width, size.height);
  } finally {
    URL.revokeObjectURL(url);
  }
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!png) {
    throw new Error('the PNG could not be encoded');
  }
  return new Uint8Array(await png.arrayBuffer());
}
