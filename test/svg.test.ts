import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyTextTransform, fontFamilyList, num, renderArtboardSvg } from '../src/render/svg.ts';
import { artboard, group, shape, stroke, text, textStyle } from './support/sceneBuilders.ts';

const noImages = () => undefined;

describe('renderArtboardSvg', () => {
  it('wraps every layer in a keyed group and paints the artboard background', () => {
    const rect = shape({ key: 'r1', transform: { a: 1, b: 0, c: 0, d: 1, e: 16, f: 8 }, fill: { kind: 'solid', color: { r: 255, g: 0, b: 0, a: 0.5 } } });
    const svg = renderArtboardSvg(artboard([rect]), noImages);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" class="dv-artboard" width="430" height="800" viewBox="0 0 430 800">/);
    assert.match(svg, /<rect class="dv-bg" width="430" height="800" fill="#FFFFFF"\/>/);
    assert.match(svg, /<g data-key="r1" transform="matrix\(1 0 0 1 16 8\)"><rect x="0" y="0" width="100" height="40" class="dv-geom" fill="#FF0000" fill-opacity="0.5"\/><\/g>/);
  });

  it('draws per-corner radii as a path and equal radii as rx', () => {
    const equal = renderArtboardSvg(artboard([shape({ geometry: { type: 'rect', x: 0, y: 0, width: 20, height: 10, radii: [4, 4, 4, 4] } })]), noImages);
    assert.match(equal, /<rect x="0" y="0" width="20" height="10" rx="4" class="dv-geom"/);
    const mixed = renderArtboardSvg(artboard([shape({ geometry: { type: 'rect', x: 0, y: 0, width: 20, height: 10, radii: [8, 0, 0, 100] } })]), noImages);
    assert.match(mixed, /<path d="M5,0 H20 A0,0 0 0 1 20,0 V10 A0,0 0 0 1 20,10 H5 A5,5 0 0 1 0,5 V5 A5,5 0 0 1 5,0 Z" class="dv-geom"/);
  });

  it('insets inside strokes, outsets outside strokes and keeps centered strokes on the shape', () => {
    const inside = renderArtboardSvg(artboard([shape({ stroke: stroke({ width: 2, align: 'inside' }) })]), noImages);
    assert.match(inside, /<rect x="1" y="1" width="98" height="38" fill="none" stroke="#000000" stroke-width="2"\/>/);
    const outside = renderArtboardSvg(artboard([shape({ stroke: stroke({ width: 2, align: 'outside' }) })]), noImages);
    assert.match(outside, /<rect x="-1" y="-1" width="102" height="42" fill="none" stroke="#000000" stroke-width="2"\/>/);
    const center = renderArtboardSvg(artboard([shape({ stroke: stroke({ width: 2, dash: [3, 1] }) })]), noImages);
    assert.match(center, /class="dv-geom" fill="none" stroke="#000000" stroke-width="2" stroke-dasharray="3 1"\/>/);
    const path = renderArtboardSvg(artboard([shape({ key: 'p', geometry: { type: 'path', d: 'M0,0 L10,0 L5,5 Z' }, stroke: stroke({ width: 2, align: 'inside' }) })]), noImages);
    assert.match(path, /<clipPath id="dv-p-stroke-clip"><path d="M0,0 L10,0 L5,5 Z" fill-rule="evenodd"\/><\/clipPath>/);
    assert.match(path, /stroke-width="4" clip-path="url\(#dv-p-stroke-clip\)"/);
  });

  it('defines gradients, image patterns and shadows', () => {
    const svg = renderArtboardSvg(
      artboard([
        shape({ key: 'g', fill: { kind: 'linear', x1: 0.5, y1: 0, x2: 0.5, y2: 1, stops: [{ offset: 0, color: { r: 255, g: 255, b: 255, a: 1 } }, { offset: 1, color: { r: 0, g: 0, b: 0, a: 0.25 } }] } }),
        shape({ key: 'i', fill: { kind: 'image', uid: 'u1', width: 800, height: 600, fit: 'cover' } }),
        shape({ key: 'm', fill: { kind: 'image', uid: 'missing', width: 1, height: 1, fit: 'cover' } }),
        shape({ key: 's', shadows: [{ x: 0, y: 3, blur: 6, color: { r: 0, g: 0, b: 0, a: 0.16 } }] }),
      ]),
      (uid) => (uid === 'u1' ? 'blob:image&1' : undefined),
    );
    assert.match(svg, /<linearGradient id="dv-g-fill" x1="0.5" y1="0" x2="0.5" y2="1"><stop offset="0" stop-color="#FFFFFF"\/><stop offset="1" stop-color="#000000" stop-opacity="0.25"\/><\/linearGradient>/);
    assert.match(svg, /<pattern id="dv-i-fill" patternUnits="objectBoundingBox" width="1" height="1" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice"><image width="800" height="600" href="blob:image&amp;1"/);
    assert.match(svg, /<g data-key="m"><rect [^>]*fill="#D9D9D9"\/>/);
    assert.match(svg, /<g data-key="s" filter="url\(#dv-s-shadow\)">/);
    assert.match(svg, /<feGaussianBlur in="SourceAlpha" stdDeviation="3" result="b0"\/><feOffset in="b0" dx="0" dy="3" result="o0"\/><feFlood flood-color="#000000" flood-opacity="0.16"/);
  });

  it('does not put shadows on lines, whose zero-height box would hide them', () => {
    const svg = renderArtboardSvg(artboard([shape({ key: 'l', geometry: { type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }, shadows: [{ x: 0, y: 1, blur: 2, color: { r: 0, g: 0, b: 0, a: 1 } }] })]), noImages);
    assert.doesNotMatch(svg, /filter=/);
  });

  it('clips mask groups with their clip shapes in the group space', () => {
    const masked = group([shape({ key: 'child' })], {
      key: 'mask',
      clip: [shape({ key: 'clipper', transform: { a: 1, b: 0, c: 0, d: 1, e: 5, f: 0 }, geometry: { type: 'ellipse', cx: 10, cy: 10, rx: 10, ry: 10 } })],
    });
    const svg = renderArtboardSvg(artboard([masked]), noImages);
    assert.match(svg, /<clipPath id="dv-mask-clip"><ellipse cx="10" cy="10" rx="10" ry="10" transform="matrix\(1 0 0 1 5 0\)"\/><\/clipPath>/);
    assert.match(svg, /<g data-key="mask"><g clip-path="url\(#dv-mask-clip\)"><g data-key="child">/);
  });

  it('renders text lines as tspans with fonts, spacing, decorations and escaped content', () => {
    const node = text({
      key: 't',
      styles: [textStyle({ letterSpacing: 50, underline: true }), textStyle({ weight: 700, textTransform: 'uppercase', color: { r: 204, g: 0, b: 0, a: 1 } })],
      lines: [{ x: -10, y: 16, runs: [{ text: 'a<b', style: 0, glyphFont: 'Yu Gothic UI' }, { text: 'c', style: 1, x: 40 }] }],
    });
    const svg = renderArtboardSvg(artboard([node]), noImages);
    assert.match(svg, /<text x="-10" y="16" pointer-events="bounding-box">/);
    assert.match(svg, /<tspan font-family="'Noto Sans', 'Yu Gothic UI', 'Noto Sans JP'[^"]*" font-size="16" font-weight="500" fill="#333333" letter-spacing="0.8" text-decoration="underline" class="dv-palt">a&lt;b<\/tspan>/);
    assert.match(svg, /<tspan x="40" [^>]*font-weight="700" fill="#CC0000">C<\/tspan>/);
  });
});

describe('svg helpers', () => {
  it('formats numbers compactly', () => {
    assert.equal(num(1.000004), '1');
    assert.equal(num(-0.00001), '0');
    assert.equal(num(12.34567), '12.3457');
  });

  it('applies XD text transforms', () => {
    assert.equal(applyTextTransform('hello world', 'uppercase'), 'HELLO WORLD');
    assert.equal(applyTextTransform('Hello', 'lowercase'), 'hello');
    assert.equal(applyTextTransform('hello world', 'titlecase'), 'Hello World');
    assert.equal(applyTextTransform('hello', 'none'), 'hello');
  });

  it('strips quotes from font names', () => {
    assert.match(fontFamilyList(`Bad"Name'`), /^'BadName', 'Noto Sans JP'/);
  });
});
