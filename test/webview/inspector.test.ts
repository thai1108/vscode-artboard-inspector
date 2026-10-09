import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderInspector, type InspectorContext } from '../../src/webview/inspector.ts';
import type { SceneNode } from '../../src/scene/scene.ts';
import { artboard, group, shape, stroke, text, textStyle } from '../support/sceneBuilders.ts';
import { installFakeCanvas } from './support/fakeCanvas.ts';

const BOX = { x: 16, y: 344, width: 191, height: 236 };

// fonts.ts keeps the first canvas context, so install one fake for the whole file.
installFakeCanvas(new Set(['Inspector Installed', 'Noto Sans']));

function inspect(node: SceneNode | null, overrides: Partial<InspectorContext> = {}): string {
  return renderInspector({ scene: artboard([]), node, box: node ? BOX : null, ancestors: [], layerCount: 0, ...overrides });
}

/** Text content of every element with the given class, in order. */
function texts(html: string, className: string): string[] {
  return [...html.matchAll(new RegExp(`class="${className}"[^>]*>([^<]*)<`, 'g'))].map((match) => match[1] ?? '');
}

describe('renderInspector for the artboard', () => {
  it('shows size, background, layer count, fonts, unique warnings and the hint', () => {
    const scene = artboard([text({ styles: [textStyle({ family: 'Inspector Installed' }), textStyle({ family: 'Inspector Missing' })] })], {
      name: 'Home & <Cart>',
      warnings: ['Effect "uiBlur" not rendered ("Bg")', 'Effect "uiBlur" not rendered ("Bg")', 'Unsupported fill "<x>"'],
    });
    const html = renderInspector({ scene, node: null, box: null, ancestors: [], layerCount: 42 });
    assert.deepEqual(texts(html, 'insp-title'), ['Home &amp; &lt;Cart&gt;']);
    assert.deepEqual(texts(html, 'insp-kind'), ['Artboard']);
    assert.match(html, /<h3>Size<\/h3>[^]*data-copy="430"[^]*data-copy="800"/);
    assert.match(html, /<h3>Background<\/h3>[^]*data-copy="#FFFFFF"/);
    assert.match(html, /<h3>Layers<\/h3><div class="prop-text">42<\/div>/);
    assert.match(html, /<li>Inspector Installed<\/li><li>Inspector Missing <span class="missing">not installed<\/span><\/li>/);
    assert.equal(html.match(/<li>Effect &quot;uiBlur&quot;/g)?.length, 1);
    assert.match(html, /<li>Unsupported fill &quot;&lt;x&gt;&quot;<\/li>/);
    assert.match(html, /class="hint"/);
  });

  it('leaves out background, fonts and warnings when there are none', () => {
    const html = renderInspector({ scene: artboard([], { background: null }), node: null, box: null, ancestors: [], layerCount: 0 });
    assert.doesNotMatch(html, /Background|Fonts|Not rendered/);
  });
});

describe('renderInspector for layers', () => {
  it('shows layout, breadcrumbs and CSS for a rectangle', () => {
    const parent = group([], { key: 'g1', name: 'Card / Mug' });
    const node = shape({
      name: 'Card background',
      geometry: { type: 'rect', x: 0, y: 0, width: 191, height: 236, radii: [12, 12, 12, 12] },
      fill: { kind: 'solid', color: { r: 255, g: 255, b: 255, a: 1 } },
      stroke: stroke({ color: { r: 229, g: 231, b: 235, a: 1 }, align: 'inside', dash: [4, 2] }),
      shadows: [{ x: 0, y: 2, blur: 8, color: { r: 0, g: 0, b: 0, a: 0.08 } }],
    });
    const html = inspect(node, { ancestors: [parent] });
    assert.deepEqual(texts(html, 'insp-kind'), ['Rectangle']);
    assert.deepEqual(texts(html, 'crumb'), ['Top', 'Card / Mug']);
    assert.match(html, /data-select=""[^]*data-select="g1"/);
    assert.match(html, /<h3>Layout<\/h3>[^]*data-copy="16"[^]*data-copy="344"[^]*data-copy="191"[^]*data-copy="236"/);
    assert.doesNotMatch(html, /Rotate|Opacity/);
    assert.match(html, /<h3>Fill<\/h3>/);
    assert.match(html, /<h3>Border<\/h3>[^]*data-copy="inside"[^]*data-copy="#E5E7EB"[^]*data-copy="4 2"/);
    assert.match(html, /<h3>Radius<\/h3><button class="copyable" data-copy="12px"/);
    assert.match(html, /<h3>Shadow<\/h3>[^]*data-copy="0 2px 8px rgba\(0, 0, 0, 0.08\)"/);
    assert.match(html, /<span class="dim">8%<\/span>/);
    assert.match(html, /<pre class="css">width: 191px;\nheight: 236px;\nbackground: #FFFFFF;\nborder: 1px dashed #E5E7EB;\nborder-radius: 12px;\nbox-shadow: 0 2px 8px rgba\(0, 0, 0, 0.08\);<\/pre>/);
    assert.match(html, /data-label="CSS">Copy CSS<\/button>/);
  });

  it('shows rotation and opacity', () => {
    const angle = Math.PI / 6;
    const node = shape({ opacity: 0.5, transform: { a: Math.cos(angle), b: Math.sin(angle), c: -Math.sin(angle), d: Math.cos(angle), e: 0, f: 0 } });
    const html = inspect(node);
    assert.match(html, /data-copy="30°"/);
    assert.match(html, /<h3>Opacity<\/h3><button class="copyable" data-copy="50%"/);
  });

  it('describes gradient and image fills', () => {
    const gradient = inspect(
      shape({
        fill: {
          kind: 'radial',
          cx: 0.5,
          cy: 0.5,
          r: 0.5,
          fx: 0.5,
          fy: 0.5,
          stops: [
            { offset: 0, color: { r: 255, g: 0, b: 0, a: 1 } },
            { offset: 1, color: { r: 0, g: 0, b: 255, a: 0.25 } },
          ],
        },
      }),
    );
    assert.match(gradient, /Radial gradient<\/div><div class="stop"><span class="dim">0%<\/span>[^]*#FF0000[^]*<span class="dim">100%<\/span>[^]*rgba\(0, 0, 255, 0.25\)/);
    const image = inspect(shape({ fill: { kind: 'image', uid: 'u', width: 1400, height: 1400, fit: 'cover' } }));
    assert.match(image, /Image 1400 × 1400 \(cover\)/);
    assert.deepEqual(texts(image, 'insp-kind'), ['Image']);
  });

  it('shows content, one typography block per style and missing fonts for text', () => {
    const node = text({
      name: '',
      content: 'Price <b>&</b>',
      lineHeight: null,
      align: 'center',
      styles: [
        textStyle({ letterSpacing: 50, underline: true, italic: true, textTransform: 'uppercase' }),
        textStyle({ family: 'Inspector Missing Font', weight: 700, fontStyle: 'Bold' }),
      ],
      lines: [{ x: 0, y: 16, runs: [{ text: 'Price ', style: 0 }, { text: '<b>&</b>', style: 1 }] }],
    });
    const html = inspect(node);
    assert.deepEqual(texts(html, 'insp-title'), ['Price &lt;b&gt;&amp;&lt;/b&gt;']);
    assert.match(html, /<pre class="content">Price &lt;b&gt;&amp;&lt;\/b&gt;<\/pre><button class="action" data-copy="Price &lt;b&gt;&amp;&lt;\/b&gt;" data-label="text">/);
    assert.deepEqual(texts(html, 'sub-title'), ['Style 1', 'Style 2']);
    assert.match(html, /<span class="dim">auto<\/span>/);
    assert.match(html, /data-copy="0.8" data-label="0.8">50 \(0.8px\)</);
    assert.match(html, /data-copy="underline italic uppercase"/);
    assert.match(html, /data-label="Inspector Missing Font">Inspector Missing Font<\/button> <span class="missing">not installed<\/span>/);
    assert.doesNotMatch(html, /data-label="Noto Sans">Noto Sans<\/button> <span class="missing">/);
    assert.match(html, /data-copy="700" data-label="700">700 \(Bold\)</);
    assert.match(html, /\/\* Price {2}\*\/[^]*\/\* &lt;b&gt;&amp;&lt;\/b&gt; \*\//);
  });

  it('skips layout and CSS when the layer could not be measured', () => {
    const html = inspect(group([], { name: 'Hidden' }), { box: null });
    assert.doesNotMatch(html, /Layout|<h3>CSS/);
    assert.deepEqual(texts(html, 'insp-kind'), ['Group']);
  });

  it('escapes every copy value taken from the file', () => {
    const html = inspect(shape({ name: '"><script>alert(1)</script>', fill: { kind: 'solid', color: { r: 1, g: 2, b: 3, a: 1 } } }));
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /title="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  });
});
