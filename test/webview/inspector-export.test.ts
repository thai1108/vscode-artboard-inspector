import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SceneNode } from '../../src/scene/scene.ts';
import { renderInspector, type InspectorContext } from '../../src/webview/inspector.ts';
import { artboard, group, shape, text } from '../support/sceneBuilders.ts';
import { installFakeCanvas } from './support/fakeCanvas.ts';

installFakeCanvas(new Set(['Noto Sans']));

const BOX = { x: 0, y: 0, width: 100, height: 40 };
const photo = shape({ name: 'Hero', fill: { kind: 'image', uid: 'u1', width: 800, height: 600, fit: 'cover' } });
const formats: Record<string, string> = { u1: 'jpg' };

function inspect(node: SceneNode | null, overrides: Partial<InspectorContext> = {}): string {
  return renderInspector({ scene: artboard([]), node, box: node ? BOX : null, ancestors: [], layerCount: 0, imageFormat: (uid) => formats[uid], ...overrides });
}

/** The export buttons, as `data-export[:scale] label`. */
function exportButtons(html: string): string[] {
  const section = /<h3>Export<\/h3>([^]*?)<\/section>/.exec(html)?.[1] ?? '';
  return [...section.matchAll(/<button [^>]*data-export="(\w+)"(?: data-scale="(\d)")?[^>]*>([^<]*)<\/button>/g)].map(
    ([, format, scale, label]) => `${format}${scale ? `:${scale}` : ''} ${label}`,
  );
}

describe('renderInspector export section', () => {
  it('offers the embedded image in its own format, SVG and PNG at 1x, 2x and 3x for an image layer', () => {
    assert.deepEqual(exportButtons(inspect(photo)), ['image Save image (JPG)', 'svg Export SVG', 'png:1 1x', 'png:2 2x', 'png:3 3x']);
    assert.match(inspect(photo), /<span class="export-label">Export PNG<\/span>/);
  });

  it('offers SVG and PNG for vector, text and group layers', () => {
    for (const node of [shape({ fill: { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } } }), text(), group([shape()])]) {
      assert.deepEqual(exportButtons(inspect(node)), ['svg Export SVG', 'png:1 1x', 'png:2 2x', 'png:3 3x']);
    }
  });

  it('offers a frame’s background image', () => {
    const frame = group([], { frame: { width: 10, height: 10, radii: [0, 0, 0, 0], fill: { kind: 'image', uid: 'u1', width: 1, height: 1, fit: 'cover' }, stroke: null } });
    assert.equal(exportButtons(inspect(frame))[0], 'image Save image (JPG)');
  });

  it('leaves out Save image while the image bytes are missing, and drawings while the layer is unmeasured', () => {
    assert.deepEqual(exportButtons(inspect(photo, { imageFormat: () => undefined })), ['svg Export SVG', 'png:1 1x', 'png:2 2x', 'png:3 3x']);
    assert.deepEqual(exportButtons(inspect(photo, { imageFormat: undefined })), ['svg Export SVG', 'png:1 1x', 'png:2 2x', 'png:3 3x']);
    assert.deepEqual(exportButtons(inspect(photo, { box: null })), ['image Save image (JPG)']);
    assert.doesNotMatch(inspect(shape(), { box: null }), /<h3>Export/);
  });

  it('has no export section for the artboard itself', () => {
    assert.doesNotMatch(inspect(null), /data-export|<h3>Export/);
  });
});
