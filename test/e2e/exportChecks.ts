// Export checks for viewer.spec.ts: what the preview's mock host was asked to save, and opening the exported files
// in the page the way another app would (parse the SVG, draw it as an image, decode the PNG).
import { expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { imageFillOf } from '../../src/render/export.ts';
import { parseWebviewMessage } from '../../src/protocol.ts';
import type { ArtboardScene, SceneNode } from '../../src/scene/scene.ts';
import type { PreviewSite } from './preview-server.ts';

export interface SavedFile {
  fileName: string;
  data: Buffer;
}

type PreviewWindow = Window & { previewSaves?: { fileName: unknown; data: unknown }[] };

export function exportButton(page: Page, format: 'image' | 'svg' | 'png', scale?: number): Locator {
  return page.locator(`#inspector button[data-export="${format}"]${scale ? `[data-scale="${scale}"]` : ''}`);
}

/** Opens the layer's artboard and selects the layer through its (possibly collapsed) row in the layer tree. */
export async function selectLayerByKey(page: Page, layer: LayerRef): Promise<void> {
  await page.locator(`#artboards .artboard-item[data-id="${layer.artboardId}"]`).click();
  await expect(page.locator(`#artboards .artboard-item.active[data-id="${layer.artboardId}"]`)).toHaveCount(1, { timeout: 30_000 });
  const row = page.locator(`#layers .layer-row[data-key="${layer.key}"]`);
  await expect(row).toBeAttached({ timeout: 30_000 });
  await row.evaluate((element) => (element as HTMLElement).click());
  await expect(page.locator(`#layers .layer-row.selected[data-key="${layer.key}"]`)).toHaveCount(1);
  await expect(exportButton(page, 'svg')).toBeVisible();
}

/** Clicks an export button and returns the file the host was asked to save, after the host's own validation. */
export async function exportWith(page: Page, button: Locator): Promise<SavedFile> {
  const count = () => page.evaluate(() => (window as PreviewWindow).previewSaves?.length ?? 0);
  const before = await count();
  await button.click();
  await page.waitForFunction(
    (n) => ((window as PreviewWindow).previewSaves?.length ?? 0) > n || document.getElementById('toast')?.textContent?.startsWith('Export failed'),
    before,
    { timeout: 60_000 },
  );
  const saved = await page.evaluate((index) => {
    const save = (window as PreviewWindow).previewSaves?.[index];
    if (!save) {
      return { failure: document.getElementById('toast')?.textContent ?? 'no save' };
    }
    const data = save.data instanceof Uint8Array ? save.data : null;
    const chunks: string[] = [];
    for (let i = 0; data && i < data.length; i += 0x8000) {
      chunks.push(String.fromCharCode(...data.subarray(i, i + 0x8000)));
    }
    return { fileName: String(save.fileName), bytes: data !== null, base64: btoa(chunks.join('')) };
  }, before);
  if ('failure' in saved) {
    throw new Error(`export failed: ${saved.failure}`);
  }
  expect(saved.bytes, 'the host receives the data as a Uint8Array').toBe(true);
  const data = Buffer.from(saved.base64, 'base64');
  expect(parseWebviewMessage({ type: 'save', fileName: saved.fileName, data: new Uint8Array(data) }), `${saved.fileName} passes the host's validation`).not.toBeNull();
  return { fileName: saved.fileName, data };
}

export interface SvgReport {
  parseError: string | null;
  width: number;
  height: number;
  ids: string[];
  /** url(#…) targets that are not defined in the file. */
  danglingRefs: string[];
  /** href values that are not data: URIs. */
  externalHrefs: string[];
  /** Ids that also exist in the viewer page. */
  clashes: string[];
  texts: { fontFamily: string | null; fontSize: string | null; content: string }[];
  drawn: { width: number; height: number };
}

/** Parses an exported SVG and draws it as an image on its own. */
export function openSvg(page: Page, file: SavedFile): Promise<SvgReport> {
  return page.evaluate(async (source) => {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    const root = doc.documentElement;
    const ids = [...doc.querySelectorAll('[id]')].map((element) => element.id);
    const refs = [...source.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1] ?? '');
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } finally {
      URL.revokeObjectURL(url);
    }
    return {
      parseError: doc.querySelector('parsererror')?.textContent ?? (root.localName === 'svg' ? null : `root is <${root.localName}>`),
      width: Number(root.getAttribute('width')),
      height: Number(root.getAttribute('height')),
      ids,
      danglingRefs: refs.filter((id) => !ids.includes(id)),
      externalHrefs: [...doc.querySelectorAll('[href]')].map((element) => element.getAttribute('href') ?? '').filter((href) => !href.startsWith('data:')),
      clashes: ids.filter((id) => document.getElementById(id) !== null),
      texts: [...doc.querySelectorAll('tspan')].map((tspan) => ({
        fontFamily: tspan.getAttribute('font-family'),
        fontSize: tspan.getAttribute('font-size'),
        content: tspan.textContent ?? '',
      })),
      drawn: { width: image.naturalWidth, height: image.naturalHeight },
    };
  }, file.data.toString('utf8'));
}

/** The exported SVG is a file of its own: well-formed, nothing outside it referenced, ids its own. */
export function expectStandaloneSvg(file: SavedFile, report: SvgReport): void {
  expect(file.data.toString('utf8')).not.toContain('blob:');
  expect(report.parseError).toBeNull();
  expect(report.danglingRefs).toEqual([]);
  expect(report.externalHrefs).toEqual([]);
  expect(report.clashes).toEqual([]);
  expect(new Set(report.ids).size).toBe(report.ids.length);
  expect(report.drawn.width).toBeGreaterThan(0);
}

/** Decodes a PNG in the page; `at` is a pixel to sample (default: the centre). */
export function decodePng(page: Page, file: SavedFile, at?: { x: number; y: number }): Promise<{ width: number; height: number; pixel: number[] }> {
  return page.evaluate(
    async ({ base64, at }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      context?.drawImage(bitmap, 0, 0);
      const x = at?.x ?? Math.floor(bitmap.width / 2);
      const y = at?.y ?? Math.floor(bitmap.height / 2);
      return { width: bitmap.width, height: bitmap.height, pixel: [...(context?.getImageData(x, y, 1, 1).data ?? [])] };
    },
    { base64: file.data.toString('base64'), at },
  );
}

/** The bytes of an embedded image exactly as the preview sent them to the webview. */
export function originalImage(site: PreviewSite, artboardIndex: number, uid: string): Buffer {
  const stored = JSON.parse(readFileSync(path.join(site.dir, 'data', `${artboardIndex}.json`), 'utf8')) as {
    images?: { uid: string; data: { index: number; view?: { byteOffset: number; byteLength: number } } }[];
  };
  const reference = stored.images?.find((image) => image.uid === uid)?.data;
  if (!reference) {
    throw new Error(`image ${uid} is not stored for artboard ${artboardIndex}`);
  }
  const buffer = readFileSync(path.join(site.dir, 'data', `${artboardIndex}-${reference.index}.bin`));
  return reference.view ? buffer.subarray(reference.view.byteOffset, reference.view.byteOffset + reference.view.byteLength) : buffer;
}

export interface LayerRef {
  artboardIndex: number;
  artboardId: string;
  key: string;
  uid?: string;
}

/** The first layer filled with an image the preview has bytes for, and the first vector path, in artboard order. */
export function findExportLayers(site: PreviewSite): { image?: LayerRef; vector?: LayerRef } {
  const found: { image?: LayerRef; vector?: LayerRef } = {};
  site.artboardIds.forEach((artboardId, artboardIndex) => {
    const stored = JSON.parse(readFileSync(path.join(site.dir, 'data', `${artboardIndex}.json`), 'utf8')) as { scene?: ArtboardScene; images?: { uid: string }[] };
    const sent = new Set(stored.images?.map((image) => image.uid));
    const walk = (nodes: SceneNode[]) => {
      for (const node of nodes) {
        const fill = imageFillOf(node);
        if (!found.image && fill && sent.has(fill.uid)) {
          found.image = { artboardIndex, artboardId, key: node.key, uid: fill.uid };
        }
        if (!found.vector && node.kind === 'shape' && node.geometry.type === 'path' && !fill) {
          found.vector = { artboardIndex, artboardId, key: node.key };
        }
        if (node.kind === 'group') {
          walk(node.children);
        }
      }
    };
    walk(stored.scene?.children ?? []);
  });
  return found;
}
