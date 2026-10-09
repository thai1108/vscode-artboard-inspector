import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayName, kindLabel, renderLayerTree } from '../src/webview/layers.ts';
import { group, shape, text } from './support/sceneBuilders.ts';

describe('layer list', () => {
  it('labels layer kinds', () => {
    assert.equal(kindLabel(text()), 'Text');
    assert.equal(kindLabel(group([], { role: 'component' })), 'Component');
    assert.equal(kindLabel(group([], { clip: [shape()] })), 'Mask group');
    assert.equal(kindLabel(shape({ fill: { kind: 'image', uid: 'u', width: 1, height: 1, fit: 'cover' } })), 'Image');
    assert.equal(kindLabel(shape({ geometry: { type: 'ellipse', cx: 0, cy: 0, rx: 2, ry: 2 } })), 'Circle');
  });

  it('falls back to the text content or kind when a layer has no name', () => {
    assert.equal(displayName(text({ name: '', content: 'Line one\nline two' })), 'Line one line two');
    assert.equal(displayName(shape({ name: '' })), 'Rectangle');
  });

  it('lists layers topmost first with collapsible, escaped groups', () => {
    const html = renderLayerTree([shape({ key: 'bottom', name: 'Bottom' }), group([text({ key: 'inner', name: '<b>' })], { key: 'top', name: 'Top' })]);
    assert.ok(html.indexOf('data-key="top"') < html.indexOf('data-key="bottom"'));
    assert.match(html, /<li class="layer collapsed"><div class="layer-row" data-key="top"[^>]*><span class="twisty" data-toggle><\/span>/);
    assert.match(html, /&lt;b&gt;/);
  });
});
