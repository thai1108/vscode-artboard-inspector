import type { SceneNode } from '../xd/scene.ts';
import { escapeHtml } from '../render/html.ts';

export function kindLabel(node: SceneNode): string {
  switch (node.kind) {
    case 'text':
      return 'Text';
    case 'group':
      return node.role === 'component' ? 'Component' : node.role === 'repeatGrid' ? 'Repeat grid' : node.clip ? 'Mask group' : 'Group';
    case 'shape':
      switch (node.geometry.type) {
        case 'rect':
          return node.fill?.kind === 'image' ? 'Image' : 'Rectangle';
        case 'ellipse':
          return node.geometry.rx === node.geometry.ry ? 'Circle' : 'Ellipse';
        case 'line':
          return 'Line';
        case 'path':
          return 'Path';
      }
  }
}

function icon(node: SceneNode): string {
  switch (node.kind) {
    case 'text':
      return 'T';
    case 'group':
      return node.role === 'component' ? '◈' : node.role === 'repeatGrid' ? '▦' : '▣';
    case 'shape':
      if (node.fill?.kind === 'image') {
        return '▨';
      }
      return { rect: '▭', ellipse: '◯', line: '╱', path: '✎' }[node.geometry.type];
  }
}

export function displayName(node: SceneNode): string {
  return (node.name || (node.kind === 'text' ? node.content : kindLabel(node))).replace(/\s+/g, ' ').trim();
}

/** Nested layer list in XD order (topmost first); groups start collapsed. */
export function renderLayerTree(nodes: SceneNode[]): string {
  const items = [...nodes].reverse().map((node) => {
    const name = escapeHtml(displayName(node));
    const twisty = node.kind === 'group' && node.children.length ? '<span class="twisty" data-toggle></span>' : '<span class="twisty-space"></span>';
    const row = `<div class="layer-row" data-key="${node.key}" title="${name}">${twisty}<span class="layer-icon">${icon(node)}</span><span class="layer-name">${name}</span></div>`;
    const children = node.kind === 'group' && node.children.length ? renderLayerTree(node.children) : '';
    return `<li class="layer${children ? ' collapsed' : ''}">${row}${children}</li>`;
  });
  return `<ul class="layer-list">${items.join('')}</ul>`;
}
