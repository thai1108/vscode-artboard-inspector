// Writes a small original demo design as an .xd file, used for README screenshots and manual testing:
// `node scripts/sample-xd.ts <out.xd>`
import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import type { AgcFill, AgcNode, AgcStroke } from '../src/xd/agc.ts';
import { writeZip, type ZipInput } from '../test/support/zipWriter.ts';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/sample-xd.ts <out.xd>');
  process.exit(2);
}

const FONT = 'Helvetica Neue';
let nextId = 0;
const id = () => `demo-${nextId++}`;

function rgb(hex: string, alpha?: number) {
  const n = Number.parseInt(hex.slice(1), 16);
  return { mode: 'RGB', value: { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }, ...(alpha === undefined ? {} : { alpha }) };
}

const solid = (hex: string): AgcFill => ({ type: 'solid', color: rgb(hex) });
const vertical = (from: string, to: string): AgcFill => ({
  type: 'gradient',
  gradient: {
    x1: 0.5,
    y1: 0,
    x2: 0.5,
    y2: 1,
    units: 'objectBoundingBox',
    meta: { ux: { gradientResources: { type: 'linear', stops: [{ offset: 0, color: rgb(from) }, { offset: 1, color: rgb(to) }] } } },
  },
});
const border = (hex: string): AgcStroke => ({ type: 'solid', color: rgb(hex), width: 1, align: 'inside' });
const softShadow = [{ type: 'dropShadow', params: { dropShadows: [{ dx: 0, dy: 2, r: 4, color: rgb('#000000', 0.08) }] } }];

function rect(name: string, x: number, y: number, width: number, height: number, style: { fill?: AgcFill; r?: number; stroke?: AgcStroke; shadow?: boolean } = {}): AgcNode {
  return {
    type: 'shape',
    id: id(),
    name,
    transform: { tx: x, ty: y },
    shape: { type: 'rect', x: 0, y: 0, width, height, r: style.r ?? 0 },
    style: { fill: style.fill ?? solid('#FFFFFF'), stroke: style.stroke ?? { type: 'none' }, ...(style.shadow ? { filters: softShadow } : {}) },
  };
}

function circle(name: string, cx: number, cy: number, r: number, fill: string): AgcNode {
  return { type: 'shape', id: id(), name, transform: { tx: cx - r, ty: cy - r }, shape: { type: 'circle', cx: r, cy: r, r }, style: { fill: solid(fill) } };
}

function line(name: string, x1: number, y: number, x2: number, color: string): AgcNode {
  return { type: 'shape', id: id(), name, transform: { tx: x1, ty: y }, shape: { type: 'line', x1: 0, y1: 0, x2: x2 - x1, y2: 0 }, style: { stroke: { type: 'solid', color: rgb(color), width: 1 } } };
}

/** Left-aligned single-line text whose baseline starts at (x, y). */
function text(content: string, x: number, y: number, size: number, fontStyle: string, color: string, lineHeight?: number): AgcNode {
  return {
    type: 'text',
    id: id(),
    name: content,
    transform: { tx: x, ty: y },
    style: { font: { family: FONT, style: fontStyle, size }, fill: solid(color), ...(lineHeight ? { textAttributes: { lineHeight } } : {}) },
    meta: { ux: { rangedStyles: [{ length: content.length, fontFamily: FONT, fontStyle, fontSize: size }] } },
    text: { rawText: content, frame: { type: 'positioned' }, paragraphs: [{ lines: [[{ from: 0, to: content.length, x: 0, y: 0 }]] }] },
  };
}

function group(name: string, x: number, y: number, children: AgcNode[]): AgcNode {
  return { type: 'group', id: id(), name, transform: { tx: x, ty: y }, group: { children } };
}

function header(title: string): AgcNode {
  return group('Header', 0, 0, [rect('Header background', 0, 0, 430, 64, { fill: solid('#111827') }), text(title, 16, 40, 20, 'Bold', '#FFFFFF'), circle('Cart icon', 390, 32, 16, '#374151')]);
}

function productCard(name: string, detail: string, price: string, from: string, to: string, x: number): AgcNode {
  return group(`Card / ${name}`, x, 344, [
    rect('Card background', 0, 0, 191, 236, { r: 12, stroke: border('#E5E7EB'), shadow: true }),
    rect('Thumbnail', 12, 12, 167, 128, { r: 8, fill: vertical(from, to) }),
    text(name, 12, 166, 15, 'Medium', '#111827'),
    text(detail, 12, 186, 12, 'Regular', '#6B7280'),
    text(price, 12, 216, 16, 'Bold', '#2563EB'),
  ]);
}

function button(label: string, y: number, labelX: number): AgcNode {
  return group('Primary button', 16, y, [rect('Button background', 0, 0, 398, 52, { r: 26, fill: solid('#2563EB') }), text(label, labelX, 32, 16, 'Bold', '#FFFFFF')]);
}

const home: AgcNode[] = [
  header('Sample Store'),
  {
    type: 'shape',
    id: id(),
    name: 'Hero image',
    transform: { tx: 16, ty: 80 },
    shape: { type: 'rect', x: 0, y: 0, width: 398, height: 200, r: 16 },
    style: { fill: { type: 'pattern', pattern: { width: 600, height: 300, meta: { ux: { uid: 'demohero', scaleBehavior: 'fill' } } } } },
  },
  text('Weekend Sale', 36, 230, 28, 'Bold', '#FFFFFF'),
  text('Up to 40% off selected items', 36, 254, 14, 'Regular', '#F1F5F9'),
  text('Popular', 16, 324, 20, 'Bold', '#111827'),
  text('See all', 366, 324, 14, 'Medium', '#2563EB'),
  productCard('Ceramic Mug', 'Stoneware, 350 ml', '$18.00', '#DBEAFE', '#93C5FD', 16),
  productCard('Linen Tote', 'Natural, 38 × 42 cm', '$24.00', '#FCE7F3', '#F9A8D4', 223),
  group('Shipping banner', 16, 600, [
    rect('Banner background', 0, 0, 398, 88, { r: 12, fill: solid('#EEF2FF') }),
    text('Free shipping over $50', 16, 38, 16, 'Bold', '#3730A3'),
    text('Use code SHIPFREE at checkout', 16, 62, 13, 'Regular', '#4F46E5'),
  ]),
  button('Shop now', 712, 165),
  group('Tab bar', 0, 868, [
    rect('Tab bar background', 0, 0, 430, 64),
    line('Divider', 0, 0, 430, '#E5E7EB'),
    circle('Home tab', 54, 32, 10, '#2563EB'),
    circle('Search tab', 161, 32, 10, '#9CA3AF'),
    circle('Saved tab', 268, 32, 10, '#9CA3AF'),
    circle('Profile tab', 375, 32, 10, '#9CA3AF'),
  ]),
];

const detail: AgcNode[] = [
  header('Ceramic Mug'),
  rect('Product photo', 0, 64, 430, 360, { fill: vertical('#DBEAFE', '#60A5FA') }),
  text('Ceramic Mug', 16, 470, 24, 'Bold', '#111827'),
  text('$18.00', 16, 502, 20, 'Bold', '#2563EB'),
  text('Hand-glazed stoneware mug that keeps', 16, 540, 14, 'Regular', '#4B5563', 22),
  text('your coffee warm. Dishwasher safe.', 16, 562, 14, 'Regular', '#4B5563', 22),
  button('Add to cart', 600, 156),
];

const cartRow = (name: string, price: string, y: number, from: string, to: string) =>
  group(`Row / ${name}`, 16, y, [
    rect('Row background', 0, 0, 398, 88, { r: 12, stroke: border('#E5E7EB') }),
    rect('Thumbnail', 12, 12, 64, 64, { r: 8, fill: vertical(from, to) }),
    text(name, 92, 40, 15, 'Medium', '#111827'),
    text(price, 92, 62, 14, 'Bold', '#2563EB'),
  ]);

const cart: AgcNode[] = [
  header('Cart'),
  cartRow('Ceramic Mug', '$18.00', 88, '#DBEAFE', '#93C5FD'),
  cartRow('Linen Tote', '$24.00', 188, '#FCE7F3', '#F9A8D4'),
  line('Divider', 16, 304, 414, '#E5E7EB'),
  text('Total', 16, 340, 16, 'Medium', '#111827'),
  text('$42.00', 352, 340, 16, 'Bold', '#111827'),
  button('Checkout', 380, 165),
];

const artboards = [
  { name: 'Home', x: 0, children: home },
  { name: 'Product detail', x: 530, children: detail },
  { name: 'Cart', x: 1060, children: cart },
].map((artboard, i) => ({ ...artboard, path: `artboard-demo-${i}` }));

const files: ZipInput[] = [
  { name: 'mimetype', data: 'application/vnd.adobe.sparkler.project+dcx', store: true },
  {
    name: 'manifest',
    data: JSON.stringify({
      name: 'Sample Store',
      children: [
        {
          name: 'artwork',
          path: 'artwork',
          children: artboards.map((a) => ({ name: a.name, path: a.path, 'uxdesign#bounds': { x: a.x, y: 0, width: 430, height: 932 } })),
        },
      ],
    }),
  },
  { name: 'resources/graphics/graphicContent.agc', data: JSON.stringify({ resources: { meta: { ux: { symbols: [] } } } }) },
  { name: 'resources/demohero', data: heroPng(600, 300), store: true },
  ...artboards.map((a) => ({
    name: `artwork/${a.path}/graphics/graphicContent.agc`,
    data: JSON.stringify({
      children: [
        {
          type: 'artboard',
          id: a.path,
          style: { fill: solid('#F9FAFB') },
          // Artboard children are stored in document coordinates.
          artboard: { children: a.children.map((node) => ({ ...node, transform: { ...node.transform, tx: (node.transform?.tx ?? 0) + a.x } })) },
        },
      ],
    }),
  })),
];
writeFileSync(out, writeZip(files));
console.log(`Wrote ${out}`);

/** Sunset gradient with a sun and two hills, encoded as an RGB PNG. */
function heroPng(width: number, height: number): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const t = y / height;
      let color = [Math.round(99 + 150 * t), Math.round(102 + 60 * t), Math.round(241 - 120 * t)];
      if (Math.hypot(x - 430, y - 120) < 60) {
        color = [253, 224, 71];
      }
      if (y > height - 70 - 40 * Math.sin((x / width) * Math.PI)) {
        color = [30, 64, 175];
      }
      if (y > height - 40 - 25 * Math.cos((x / width) * Math.PI * 1.5)) {
        color = [23, 37, 84];
      }
      row.set(color, 1 + x * 3);
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
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
