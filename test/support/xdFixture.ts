import type { AgcGraphicContent, AgcNode, XdBounds } from '../../src/xd/agc.ts';
import { XdDocument } from '../../src/xd/parse.ts';
import { ZipArchive } from '../../src/zip.ts';
import { writeZip, type ZipInput } from './zipWriter.ts';

export interface FixtureArtboard {
  id: string;
  name: string;
  bounds: XdBounds;
  children: AgcNode[];
  background?: { r: number; g: number; b: number };
}

export interface FixtureOptions {
  artboards: FixtureArtboard[];
  /** Nodes stored in resources/graphics/graphicContent.agc (component masters). */
  resources?: AgcNode[];
  images?: Record<string, Buffer>;
}

export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** Builds an in-memory .xd archive with the same layout XD writes. */
export function buildXd(options: FixtureOptions): XdDocument {
  const manifest = {
    name: 'fixture',
    children: [
      {
        name: 'artwork',
        path: 'artwork',
        children: options.artboards.map((artboard) => ({
          name: artboard.name,
          path: artboard.id,
          'uxdesign#bounds': artboard.bounds,
          children: [{ name: 'graphics', path: 'graphics' }],
        })),
      },
    ],
  };
  const files: ZipInput[] = [
    { name: 'mimetype', data: 'application/vnd.adobe.sparkler.project+dcx', store: true },
    { name: 'manifest', data: JSON.stringify(manifest) },
    {
      name: 'resources/graphics/graphicContent.agc',
      data: JSON.stringify({ resources: { meta: { ux: { symbols: options.resources ?? [] } } } }),
    },
  ];
  for (const artboard of options.artboards) {
    const content: AgcGraphicContent = {
      children: [
        {
          type: 'artboard',
          id: artboard.id.replace('artboard-', ''),
          style: artboard.background
            ? { fill: { type: 'solid', color: { mode: 'RGB', value: artboard.background } } }
            : undefined,
          artboard: { children: artboard.children },
        },
      ],
    };
    files.push({ name: `artwork/${artboard.id}/graphics/graphicContent.agc`, data: JSON.stringify(content) });
  }
  for (const [uid, data] of Object.entries(options.images ?? {})) {
    files.push({ name: `resources/${uid}`, data, store: true });
  }
  return XdDocument.open(ZipArchive.open(writeZip(files)));
}

export function rgb(r: number, g: number, b: number) {
  return { mode: 'RGB', value: { r, g, b } };
}
