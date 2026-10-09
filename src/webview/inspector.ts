import { cssForNode, borderRadius, shadowValue } from '../render/css.ts';
import { fmt, type Box } from '../render/geometry.ts';
import { roundAlpha, toCssColor, toHex } from '../xd/color.ts';
import type { ArtboardScene, Paint, Rgba, SceneNode, Stroke, TextNode, TextStyle } from '../xd/scene.ts';
import { escapeHtml } from '../render/html.ts';
import { fontsUsed, isFontAvailable } from './fonts.ts';
import { displayName, kindLabel } from './layers.ts';

export interface InspectorContext {
  scene: ArtboardScene;
  /** null shows the artboard itself. */
  node: SceneNode | null;
  box: Box | null;
  /** Ancestors of the node, outermost first. */
  ancestors: SceneNode[];
  layerCount: number;
}

export function renderInspector(ctx: InspectorContext): string {
  return ctx.node ? nodeInspector(ctx, ctx.node) : artboardInspector(ctx);
}

function artboardInspector({ scene, layerCount }: InspectorContext): string {
  const parts = [
    header(scene.name, 'Artboard'),
    section('Size', grid([prop('W', copyable(fmt(scene.width))), prop('H', copyable(fmt(scene.height)))])),
  ];
  if (scene.background) {
    parts.push(section('Background', colorValue(scene.background)));
  }
  parts.push(section('Layers', `<div class="prop-text">${layerCount}</div>`));
  const fonts = fontsUsed(scene);
  if (fonts.length) {
    const items = fonts.map(
      (font) =>
        `<li>${escapeHtml(font.family)}${font.fallback ? ' <span class="dim">(XD glyph fallback)</span>' : ''}` +
        `${font.available ? '' : ' <span class="missing">not installed</span>'}</li>`,
    );
    parts.push(section('Fonts', `<ul class="fonts">${items.join('')}</ul>`));
  }
  if (scene.warnings.length) {
    const unique = [...new Set(scene.warnings)];
    parts.push(section('Not rendered', `<ul class="warnings">${unique.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`));
  }
  parts.push('<p class="hint">Click a layer to inspect it. With a layer selected, hover another one to see the spacing.</p>');
  return parts.join('');
}

function nodeInspector(ctx: InspectorContext, node: SceneNode): string {
  const parts = [header(displayName(node), kindLabel(node)), breadcrumbs(ctx.scene, ctx.ancestors)];
  if (ctx.box) {
    const items = [
      prop('X', copyable(fmt(ctx.box.x))),
      prop('Y', copyable(fmt(ctx.box.y))),
      prop('W', copyable(fmt(ctx.box.width))),
      prop('H', copyable(fmt(ctx.box.height))),
    ];
    const rotation = (Math.atan2(node.transform.b, node.transform.a) * 180) / Math.PI;
    if (Math.abs(rotation) > 0.01) {
      items.push(prop('Rotate', copyable(`${fmt(rotation)}°`)));
    }
    parts.push(section('Layout', grid(items)));
  }
  if (node.opacity < 1) {
    parts.push(section('Opacity', copyable(`${fmt(node.opacity * 100)}%`)));
  }

  if (node.kind === 'text') {
    parts.push(textSections(node));
  }
  if (node.kind === 'shape') {
    if (node.fill) {
      parts.push(section('Fill', paintValue(node.fill)));
    }
    if (node.stroke) {
      parts.push(section('Border', strokeValue(node.stroke)));
    }
    const radius = borderRadius(node);
    if (radius) {
      parts.push(section('Radius', copyable(radius)));
    }
  }
  if (node.shadows.length) {
    parts.push(
      section(
        'Shadow',
        node.shadows
          .map(
            (shadow) =>
              grid([prop('X', copyable(fmt(shadow.x))), prop('Y', copyable(fmt(shadow.y))), prop('Blur', copyable(fmt(shadow.blur)))]) +
              grid([prop('Color', colorValue(shadow.color)), prop('CSS', copyable(shadowValue(shadow)))], 'wide'),
          )
          .join(''),
      ),
    );
  }
  if (ctx.box) {
    parts.push(cssSection(node, ctx.box));
  }
  return parts.join('');
}

function textSections(node: TextNode): string {
  const content =
    `<pre class="content">${escapeHtml(node.content)}</pre>` +
    `<button class="action" data-copy="${escapeHtml(node.content)}" data-label="text">Copy text</button>`;
  const typography = node.styles
    .map((style, index) => {
      const title = node.styles.length > 1 ? `<div class="sub-title">Style ${index + 1}</div>` : '';
      return title + typographyGrid(node, style);
    })
    .join('');
  return section('Content', content) + section('Typography', typography);
}

function typographyGrid(node: TextNode, style: TextStyle): string {
  const items = [
    prop('Font', copyable(style.family) + (isFontAvailable(style.family) ? '' : ' <span class="missing">not installed</span>')),
    prop('Weight', copyable(String(style.weight), `${style.weight} (${style.fontStyle})`)),
    prop('Size', copyable(fmt(style.size))),
    prop('Line height', node.lineHeight === null ? '<span class="dim">auto</span>' : copyable(fmt(node.lineHeight))),
    prop('Letter', copyable(fmt((style.letterSpacing / 1000) * style.size), `${fmt(style.letterSpacing)} (${fmt((style.letterSpacing / 1000) * style.size)}px)`)),
    prop('Align', copyable(node.align)),
    prop('Color', colorValue(style.color)),
  ];
  const decorations = [style.underline ? 'underline' : '', style.strikethrough ? 'line-through' : '', style.italic ? 'italic' : '', style.textTransform !== 'none' ? style.textTransform : ''].filter(Boolean);
  if (decorations.length) {
    items.push(prop('Style', copyable(decorations.join(' '))));
  }
  return grid(items, 'wide');
}

function paintValue(paint: Paint): string {
  switch (paint.kind) {
    case 'solid':
      return colorValue(paint.color);
    case 'linear':
    case 'radial':
      return (
        `<div class="prop-text">${paint.kind === 'linear' ? 'Linear' : 'Radial'} gradient</div>` +
        paint.stops.map((stop) => `<div class="stop"><span class="dim">${fmt(stop.offset * 100)}%</span>${colorValue(stop.color)}</div>`).join('')
      );
    case 'image':
      return `<div class="prop-text">Image ${fmt(paint.width)} × ${fmt(paint.height)} (${paint.fit})</div>`;
  }
}

function strokeValue(stroke: Stroke): string {
  const items = [prop('Width', copyable(fmt(stroke.width))), prop('Align', copyable(stroke.align)), prop('Color', colorValue(stroke.color))];
  if (stroke.dash.length) {
    items.push(prop('Dash', copyable(stroke.dash.map(fmt).join(' '))));
  }
  return grid(items, 'wide');
}

function cssSection(node: SceneNode, box: Box): string {
  const blocks = cssForNode(node, box);
  const text = blocks
    .map((block) => (block.label ? `/* ${block.label} */\n` : '') + block.declarations.join('\n'))
    .join('\n\n');
  const body =
    `<pre class="css">${escapeHtml(text)}</pre>` +
    `<button class="action" data-copy="${escapeHtml(text)}" data-label="CSS">Copy CSS</button>`;
  return section('CSS', body);
}

function breadcrumbs(scene: ArtboardScene, ancestors: SceneNode[]): string {
  const crumbs = [`<button class="crumb" data-select="">${escapeHtml(scene.name)}</button>`].concat(
    ancestors.map((node) => `<button class="crumb" data-select="${node.key}">${escapeHtml(displayName(node))}</button>`),
  );
  return `<nav class="crumbs">${crumbs.join('<span class="crumb-sep">›</span>')}</nav>`;
}

function header(title: string, kind: string): string {
  return `<div class="insp-header"><div class="insp-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div><div class="insp-kind">${escapeHtml(kind)}</div></div>`;
}

function section(title: string, body: string): string {
  return `<section class="insp-section"><h3>${escapeHtml(title)}</h3>${body}</section>`;
}

function grid(items: string[], variant: 'wide' | '' = ''): string {
  return `<div class="prop-grid ${variant}">${items.join('')}</div>`;
}

function prop(label: string, value: string): string {
  return `<div class="prop"><span class="prop-label">${escapeHtml(label)}</span><span class="prop-value">${value}</span></div>`;
}

/** A value that copies itself (or `copy`) on click. */
function copyable(copy: string, shown: string = copy): string {
  return `<button class="copyable" data-copy="${escapeHtml(copy)}" data-label="${escapeHtml(copy)}">${escapeHtml(shown)}</button>`;
}

function colorValue(color: Rgba): string {
  const opacity = color.a < 1 ? ` fill-opacity="${roundAlpha(color.a)}"` : '';
  const alpha = color.a < 1 ? ` <span class="dim">${Math.round(color.a * 100)}%</span>` : '';
  return (
    `<span class="color"><svg class="swatch" viewBox="0 0 12 12"><rect width="12" height="12" rx="2" fill="${toHex(color)}"${opacity}/></svg>` +
    `${copyable(toCssColor(color), toHex(color))}${alpha}</span>`
  );
}
