// Builds synthetic .fig files with a small Figma-like kiwi schema (only the fields the parser reads).
import { deflateRawSync, zstdCompressSync } from 'node:zlib';
import type { KiwiDefinition, KiwiField } from '../../src/fig/kiwi.ts';
import { encodeMessage, encodeSchema, type FixtureValue } from './kiwiWriter.ts';
import { writeZip, type ZipInput } from './zipWriter.ts';

const enumDef = (name: string, values: Record<string, number>): KiwiDefinition => ({
  name,
  kind: 'ENUM',
  fields: Object.entries(values).map(([field, value]) => ({ name: field, type: 'uint', isArray: false, value })),
});

/** Fields numbered in order; `[]` suffix marks arrays. */
const def = (name: string, kind: 'STRUCT' | 'MESSAGE', fields: [string, string][]): KiwiDefinition => ({
  name,
  kind,
  fields: fields.map(([field, type], i): KiwiField => ({ name: field, type: type.replace('[]', ''), isArray: type.endsWith('[]'), value: i + 1 })),
});

export const FIG_SCHEMA: KiwiDefinition[] = [
  enumDef('NodeType', { DOCUMENT: 1, CANVAS: 2, FRAME: 4, VECTOR: 6, ELLIPSE: 9, RECTANGLE: 10, ROUNDED_RECTANGLE: 12, TEXT: 13, SYMBOL: 15, INSTANCE: 16, STICKY: 17, SECTION: 25 }),
  enumDef('PaintType', { SOLID: 0, GRADIENT_LINEAR: 1, GRADIENT_RADIAL: 2, IMAGE: 5 }),
  enumDef('StrokeAlign', { CENTER: 0, INSIDE: 1, OUTSIDE: 2 }),
  enumDef('WindingRule', { NONZERO: 0, ODD: 1 }),
  enumDef('EffectType', { INNER_SHADOW: 0, DROP_SHADOW: 1 }),
  enumDef('NumberUnits', { RAW: 0, PIXELS: 1, PERCENT: 2 }),
  enumDef('ImageScaleMode', { STRETCH: 0, FIT: 1, FILL: 2 }),
  enumDef('TextAlignHorizontal', { LEFT: 0, CENTER: 1, RIGHT: 2 }),
  def('GUID', 'STRUCT', [['sessionID', 'uint'], ['localID', 'uint']]),
  def('Color', 'STRUCT', [['r', 'float'], ['g', 'float'], ['b', 'float'], ['a', 'float']]),
  def('Vector', 'STRUCT', [['x', 'float'], ['y', 'float']]),
  def('Matrix', 'STRUCT', [['m00', 'float'], ['m01', 'float'], ['m02', 'float'], ['m10', 'float'], ['m11', 'float'], ['m12', 'float']]),
  def('ParentIndex', 'MESSAGE', [['guid', 'GUID'], ['position', 'string']]),
  def('ColorStop', 'MESSAGE', [['color', 'Color'], ['position', 'float']]),
  def('Image', 'MESSAGE', [['hash', 'byte[]'], ['dataBlob', 'uint']]),
  def('Paint', 'MESSAGE', [['type', 'PaintType'], ['color', 'Color'], ['opacity', 'float'], ['visible', 'bool'], ['stops', 'ColorStop[]'], ['transform', 'Matrix'], ['image', 'Image'], ['imageScaleMode', 'ImageScaleMode'], ['originalImageWidth', 'uint'], ['originalImageHeight', 'uint']]),
  def('Effect', 'MESSAGE', [['type', 'EffectType'], ['color', 'Color'], ['offset', 'Vector'], ['radius', 'float'], ['visible', 'bool'], ['spread', 'float']]),
  def('Path', 'MESSAGE', [['windingRule', 'WindingRule'], ['commandsBlob', 'uint']]),
  def('FontName', 'MESSAGE', [['family', 'string'], ['style', 'string']]),
  def('Number', 'MESSAGE', [['value', 'float'], ['units', 'NumberUnits']]),
  def('Baseline', 'MESSAGE', [['position', 'Vector'], ['firstCharacter', 'uint'], ['endCharacter', 'uint']]),
  def('DerivedTextData', 'MESSAGE', [['baselines', 'Baseline[]'], ['logicalIndexToCharacterOffsetMap', 'float[]']]),
  def('TextData', 'MESSAGE', [['characters', 'string'], ['characterStyleIDs', 'uint[]'], ['styleOverrideTable', 'NodeChange[]']]),
  def('GUIDPath', 'MESSAGE', [['guids', 'GUID[]']]),
  def('SymbolData', 'MESSAGE', [['symbolID', 'GUID'], ['symbolOverrides', 'NodeChange[]']]),
  def('NodeChange', 'MESSAGE', [
    ['guid', 'GUID'],
    ['parentIndex', 'ParentIndex'],
    ['type', 'NodeType'],
    ['name', 'string'],
    ['visible', 'bool'],
    ['opacity', 'float'],
    ['size', 'Vector'],
    ['transform', 'Matrix'],
    ['fillPaints', 'Paint[]'],
    ['strokePaints', 'Paint[]'],
    ['strokeWeight', 'float'],
    ['strokeAlign', 'StrokeAlign'],
    ['effects', 'Effect[]'],
    ['cornerRadius', 'float'],
    ['frameMaskDisabled', 'bool'],
    ['fillGeometry', 'Path[]'],
    ['strokeGeometry', 'Path[]'],
    ['textData', 'TextData'],
    ['derivedTextData', 'DerivedTextData'],
    ['fontName', 'FontName'],
    ['fontSize', 'float'],
    ['lineHeight', 'Number'],
    ['letterSpacing', 'Number'],
    ['symbolData', 'SymbolData'],
    ['derivedSymbolData', 'NodeChange[]'],
    ['overrideKey', 'GUID'],
    ['guidPath', 'GUIDPath'],
    ['internalOnly', 'bool'],
    ['styleID', 'uint'],
    ['rectangleCornerRadiiIndependent', 'bool'],
    ['rectangleTopLeftCornerRadius', 'float'],
    ['rectangleTopRightCornerRadius', 'float'],
    ['rectangleBottomRightCornerRadius', 'float'],
    ['rectangleBottomLeftCornerRadius', 'float'],
    ['borderStrokeWeightsIndependent', 'bool'],
    ['borderTopWeight', 'float'],
    ['borderRightWeight', 'float'],
    ['borderBottomWeight', 'float'],
    ['borderLeftWeight', 'float'],
    ['mask', 'bool'],
    ['textAlignHorizontal', 'TextAlignHorizontal'],
    ['overriddenSymbolID', 'GUID'],
  ]),
  def('Blob', 'MESSAGE', [['bytes', 'byte[]']]),
  def('Message', 'MESSAGE', [['nodeChanges', 'NodeChange[]'], ['blobs', 'Blob[]']]),
];

export type FixtureNode = { [field: string]: FixtureValue | undefined };

export const guid = (localID: number) => ({ sessionID: 1, localID });
export const at = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
export const solid = (r: number, g: number, b: number, a = 1) => ({ type: 'SOLID', color: { r, g, b, a }, opacity: 1, visible: true });

/** A node under `parent` (local id); siblings are ordered by `position`. */
export function node(id: number, parent: number | null, type: string, fields: FixtureNode = {}, position = 'a'): FixtureNode {
  return { guid: guid(id), ...(parent === null ? {} : { parentIndex: { guid: guid(parent), position } }), type, name: `${type.toLowerCase()} ${id}`, visible: true, opacity: 1, ...fields };
}

/** Document root (0:0) with one page (local id 1), plus the given nodes. */
export function documentNodes(nodes: FixtureNode[], pageName = 'Page 1'): FixtureNode[] {
  return [
    { guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT', name: 'Document' },
    { guid: guid(1), parentIndex: { guid: { sessionID: 0, localID: 0 }, position: 'a' }, type: 'CANVAS', name: pageName, visible: true },
    ...nodes,
  ];
}

export function encodeCanvas(nodes: FixtureNode[], blobs: Uint8Array[] = [], schema: KiwiDefinition[] = FIG_SCHEMA): Buffer {
  const message = encodeMessage(schema, 'Message', { nodeChanges: nodes as FixtureValue[], blobs: blobs.map((bytes) => ({ bytes })) });
  const chunk = (data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(data.length);
    return Buffer.concat([length, data]);
  };
  const header = Buffer.alloc(12);
  header.write('fig-kiwi', 0, 'latin1');
  header.writeUInt32LE(106, 8);
  return Buffer.concat([header, chunk(deflateRawSync(encodeSchema(schema))), chunk(zstdCompressSync(message))]);
}

export function buildFig(nodes: FixtureNode[], options: { blobs?: Uint8Array[]; images?: Record<string, Buffer> } = {}): Buffer {
  const files: ZipInput[] = [
    { name: 'canvas.fig', data: encodeCanvas(nodes, options.blobs), store: true },
    { name: 'meta.json', data: '{}' },
  ];
  for (const [hash, data] of Object.entries(options.images ?? {})) {
    files.push({ name: `images/${hash}`, data, store: true });
  }
  return writeZip(files);
}

/** Path command blob: [command byte][float32 LE …]. */
export function commands(...steps: [number, ...number[]][]): Uint8Array {
  const parts: Buffer[] = [];
  for (const [command, ...values] of steps) {
    const part = Buffer.alloc(1 + values.length * 4);
    part[0] = command;
    values.forEach((value, i) => part.writeFloatLE(value, 1 + i * 4));
    parts.push(part);
  }
  return Buffer.concat(parts);
}
