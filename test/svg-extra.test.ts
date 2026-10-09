import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderArtboardSvg } from '../src/render/svg.ts';
import { artboard, group, shape, stroke, text, textStyle } from './support/sceneBuilders.ts';

const noImages = () => undefined;
const render = (...nodes: Parameters<typeof artboard>[0]) => renderArtboardSvg(artboard(nodes), noImages);

describe('renderArtboardSvg extra cases', () => {
  it('omits the background rect for transparent artboards and identity transforms', () => {
    const svg = renderArtboardSvg(artboard([shape({ key: 'a' })], { background: null }), noImages);
    assert.doesNotMatch(svg, /dv-bg/);
    assert.match(svg, /<g data-key="a"><rect/);
  });

  it('writes layer opacity on the group', () => {
    assert.match(render(shape({ key: 'o', opacity: 0.35 })), /<g data-key="o" opacity="0.35">/);
  });

  it('defines radial gradients', () => {
    const svg = render(
      shape({ key: 'r', fill: { kind: 'radial', cx: 0.5, cy: 0.4, r: 0.6, fx: 0.5, fy: 0.3, stops: [{ offset: 0, color: { r: 241, g: 199, b: 71, a: 1 } }] } }),
    );
    assert.match(svg, /<radialGradient id="dv-r-fill" cx="0.5" cy="0.4" r="0.6" fx="0.5" fy="0.3"><stop offset="0" stop-color="#F1C747"\/><\/radialGradient>/);
    assert.match(svg, /fill="url\(#dv-r-fill\)"/);
  });

  it('masks outside path strokes so only the outer half shows', () => {
    const svg = render(shape({ key: 'p', geometry: { type: 'path', d: 'M0,0 L10,0 L10,10 Z' }, stroke: stroke({ width: 3, align: 'outside' }) }));
    assert.match(svg, /<mask id="dv-p-stroke-mask" maskUnits="userSpaceOnUse"[^>]*><rect [^>]*fill="white"\/><path d="M0,0 L10,0 L10,10 Z" fill-rule="evenodd" fill="black"\/><\/mask>/);
    assert.match(svg, /stroke-width="6" mask="url\(#dv-p-stroke-mask\)"/);
  });

  it('insets inside strokes on ellipses and keeps strokes centered on lines whatever the alignment', () => {
    const ellipse = render(shape({ geometry: { type: 'ellipse', cx: 10, cy: 10, rx: 10, ry: 6 }, stroke: stroke({ width: 2, align: 'inside' }) }));
    assert.match(ellipse, /<ellipse cx="10" cy="10" rx="9" ry="5" fill="none" stroke="#000000" stroke-width="2"\/>/);
    const line = render(shape({ geometry: { type: 'line', x1: 0, y1: 0, x2: 20, y2: 0 }, stroke: stroke({ width: 2, align: 'inside' }) }));
    assert.match(line, /<line x1="0" y1="0" x2="20" y2="0" class="dv-geom" fill="none" stroke="#000000" stroke-width="2"\/>/);
  });

  it('writes non-default caps, joins and translucent strokes', () => {
    const svg = render(shape({ stroke: stroke({ cap: 'round', join: 'bevel', color: { r: 0, g: 0, b: 0, a: 0.5 } }) }));
    assert.match(svg, /stroke="#000000" stroke-opacity="0.5" stroke-width="1" stroke-linecap="round" stroke-linejoin="bevel"/);
  });

  it('merges several shadows over the source graphic', () => {
    const svg = render(
      shape({
        key: 's',
        shadows: [
          { x: 0, y: 1, blur: 2, color: { r: 0, g: 0, b: 0, a: 0.1 } },
          { x: 0, y: 4, blur: 8, color: { r: 0, g: 0, b: 255, a: 1 } },
        ],
      }),
    );
    assert.match(svg, /<feMerge><feMergeNode in="s0"\/><feMergeNode in="s1"\/><feMergeNode in="SourceGraphic"\/><\/feMerge>/);
    assert.match(svg, /<feFlood flood-color="#0000FF" flood-opacity="1" result="f1"\/>/);
  });

  it('fits contain images with meet', () => {
    const svg = renderArtboardSvg(artboard([shape({ key: 'i', fill: { kind: 'image', uid: 'u', width: 10, height: 20, fit: 'contain' } })]), () => 'blob:x');
    assert.match(svg, /preserveAspectRatio="xMidYMid meet"/);
  });

  it('renders italic and struck-through text, and skips styles that do not exist', () => {
    const svg = render(
      text({
        styles: [textStyle({ italic: true, underline: true, strikethrough: true })],
        lines: [{ x: 0, y: 10, runs: [{ text: 'a', style: 0 }, { text: 'b', style: 7 }] }],
      }),
    );
    assert.match(svg, /font-style="italic" text-decoration="underline line-through">a<\/tspan>/);
    assert.match(svg, /<tspan >b<\/tspan>|<tspan>b<\/tspan>/);
  });

  it('keeps whitespace runs and nested groups without clip', () => {
    const svg = render(group([group([text({ key: 't', lines: [{ x: 0, y: 10, runs: [{ text: '  ', style: 0 }] }] })], { key: 'inner' })], { key: 'outer' }));
    assert.match(svg, /<g data-key="outer"><g data-key="inner"><g data-key="t"><text x="0" y="10"[^>]*><tspan [^>]*> {2}<\/tspan><\/text><\/g><\/g><\/g>/);
  });

  it('produces an empty defs block when nothing needs definitions', () => {
    assert.match(render(), /<defs><\/defs>/);
  });
});
