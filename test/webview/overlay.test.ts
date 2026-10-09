import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { drawOverlay } from '../../src/webview/overlay.ts';
import type { Viewport } from '../../src/webview/viewport.ts';

/** Artboard origin at screen (10, 20), zoom 2. */
const viewport = { zoom: 2, toScreen: (x: number, y: number) => ({ x: 10 + x * 2, y: 20 + y * 2 }) } as unknown as Viewport;

function draw(state: Parameters<typeof drawOverlay>[2]): string {
  const svg = { innerHTML: '' } as SVGSVGElement;
  drawOverlay(svg, viewport, state);
  return svg.innerHTML;
}

describe('drawOverlay', () => {
  it('draws nothing without hover, selection or guides', () => {
    assert.equal(draw({ hovered: null, selected: null, guides: [] }), '');
  });

  it('outlines the hovered box in screen space on half pixels', () => {
    assert.equal(draw({ hovered: { x: 0, y: 0, width: 10, height: 5 }, selected: null, guides: [] }), '<rect class="ov-hover" x="10.5" y="20.5" width="19" height="9"/>');
  });

  it('labels the selection with its artboard size below the box', () => {
    const html = draw({ hovered: null, selected: { x: 5, y: 5, width: 100.333, height: 20 }, guides: [] });
    assert.match(html, /^<rect class="ov-selected" x="20.5" y="30.5" width="199.666" height="39"\/>/);
    assert.match(html, /<g class="ov-size"><rect [^>]*\/><text x="120.333" y="83" text-anchor="middle" dominant-baseline="central">100.33 × 20<\/text><\/g>/);
  });

  it('hides the size label while measuring and draws distance and extension guides', () => {
    const html = draw({
      hovered: { x: 50, y: 0, width: 10, height: 10 },
      selected: { x: 0, y: 0, width: 10, height: 10 },
      guides: [
        { x1: 10, y1: 5, x2: 50, y2: 5, value: 40 },
        { x1: 50, y1: 0, x2: 50, y2: 5 },
      ],
    });
    assert.doesNotMatch(html, /ov-size/);
    assert.match(html, /<line class="ov-guide" x1="30" y1="30" x2="110" y2="30"\/>/);
    assert.match(html, /<line class="ov-guide" x1="30" y1="26" x2="30" y2="34"\/><line class="ov-guide" x1="110" y1="26" x2="110" y2="34"\/>/);
    assert.match(html, /<g class="ov-distance">[^]*>40<\/text><\/g>/);
    assert.match(html, /<line class="ov-extension" x1="110" y1="20" x2="110" y2="30"\/>/);
  });

  it('draws horizontal end caps on vertical guides', () => {
    const html = draw({ hovered: null, selected: null, guides: [{ x1: 0, y1: 0, x2: 0, y2: 10, value: 10 }] });
    assert.match(html, /<line class="ov-guide" x1="6" y1="20" x2="14" y2="20"\/>/);
  });

  it('clamps boxes smaller than a pixel to zero size', () => {
    assert.equal(draw({ hovered: { x: 0, y: 0, width: 0, height: 0.1 }, selected: null, guides: [] }), '<rect class="ov-hover" x="10.5" y="20.5" width="0" height="0"/>');
  });
});
