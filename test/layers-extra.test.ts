import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayName, kindLabel, renderLayerTree } from '../src/webview/layers.ts';
import { group, shape, text } from './support/sceneBuilders.ts';

describe('layer labels', () => {
  it('labels every kind of layer', () => {
    assert.equal(kindLabel(group([], { role: 'repeatGrid' })), 'Repeat grid');
    assert.equal(kindLabel(group([])), 'Group');
    assert.equal(kindLabel(shape()), 'Rectangle');
    assert.equal(kindLabel(shape({ geometry: { type: 'ellipse', cx: 0, cy: 0, rx: 4, ry: 2 } })), 'Ellipse');
    assert.equal(kindLabel(shape({ geometry: { type: 'line', x1: 0, y1: 0, x2: 1, y2: 0 } })), 'Line');
    assert.equal(kindLabel(shape({ geometry: { type: 'path', d: 'M0,0' } })), 'Path');
  });

  it('prefers the layer name and collapses whitespace', () => {
    assert.equal(displayName(shape({ name: '  Card \n background ' })), 'Card background');
    assert.equal(displayName(group([], { name: '', role: 'component' })), 'Component');
  });
});

describe('renderLayerTree icons and nesting', () => {
  const iconOf = (html: string, key: string) => new RegExp(`data-key="${key}"[^>]*><span class="twisty(?:-space)?"[^>]*></span><span class="layer-icon">([^<]+)</span>`).exec(html)?.[1];

  it('picks an icon per kind', () => {
    const html = renderLayerTree([
      text({ key: 't' }),
      group([], { key: 'g' }),
      group([], { key: 'c', role: 'component' }),
      group([], { key: 'r', role: 'repeatGrid' }),
      shape({ key: 'rect' }),
      shape({ key: 'img', fill: { kind: 'image', uid: 'u', width: 1, height: 1, fit: 'cover' } }),
      shape({ key: 'ell', geometry: { type: 'ellipse', cx: 0, cy: 0, rx: 1, ry: 1 } }),
      shape({ key: 'line', geometry: { type: 'line', x1: 0, y1: 0, x2: 1, y2: 0 } }),
      shape({ key: 'path', geometry: { type: 'path', d: 'M0,0' } }),
    ]);
    assert.deepEqual(
      ['t', 'g', 'c', 'r', 'rect', 'img', 'ell', 'line', 'path'].map((key) => iconOf(html, key)),
      ['T', '▣', '◈', '▦', '▭', '▨', '◯', '╱', '✎'],
    );
  });

  it('gives empty groups no toggle and no nested list', () => {
    const html = renderLayerTree([group([], { key: 'empty', name: 'Empty' })]);
    assert.match(html, /<li class="layer"><div class="layer-row" data-key="empty" title="Empty"><span class="twisty-space"><\/span>/);
    assert.equal(html.match(/<ul class="layer-list">/g)?.length, 1);
  });

  it('nests children in their own list, topmost first at every level', () => {
    const html = renderLayerTree([group([text({ key: 'a' }), text({ key: 'b' })], { key: 'parent' })]);
    assert.equal(html.match(/<ul class="layer-list">/g)?.length, 2);
    assert.ok(html.indexOf('data-key="b"') < html.indexOf('data-key="a"'));
  });

  it('escapes names in titles and labels', () => {
    const html = renderLayerTree([shape({ key: 'x', name: `"><img src=x onerror=alert(1)>` })]);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /title="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);
  });

  it('renders an empty list for an empty artboard', () => {
    assert.equal(renderLayerTree([]), '<ul class="layer-list"></ul>');
  });
});
