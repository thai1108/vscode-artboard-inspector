import { geometryElement } from '../render/svg.ts';
import { intersect, union, type Box } from '../render/geometry.ts';
import type { ArtboardScene, SceneNode, ShapeNode, TextNode } from '../xd/scene.ts';

// Noto Sans ascender/descender: XD sizes text boxes from the baseline with these, not from the glyphs drawn.
const ASCENT = 1.069;
const DESCENT = 0.293;

export interface IndexedNode {
  node: SceneNode;
  parentKey: string | null;
}

export function indexScene(scene: ArtboardScene): Map<string, IndexedNode> {
  const index = new Map<string, IndexedNode>();
  const walk = (nodes: SceneNode[], parentKey: string | null) => {
    for (const node of nodes) {
      index.set(node.key, { node, parentKey });
      if (node.kind === 'group') {
        walk(node.children, node.key);
      }
    }
  };
  walk(scene.children, null);
  return index;
}

export interface MeasuredLayers {
  elements: Map<string, SVGGElement>;
  boxes: Map<string, Box>;
}

/** Measures every layer of the rendered artboard in artboard pixels. */
export function measureLayers(svg: SVGSVGElement, scene: ArtboardScene): MeasuredLayers {
  const elements = new Map<string, SVGGElement>();
  for (const element of svg.querySelectorAll<SVGGElement>('g[data-key]')) {
    elements.set(element.dataset['key'] ?? '', element);
  }
  const boxes = new Map<string, Box>();

  const measure = (node: SceneNode): Box | null => {
    const element = elements.get(node.key);
    const ctm = element?.getCTM();
    if (!element || !ctm) {
      return null;
    }
    let box: Box | null;
    switch (node.kind) {
      case 'shape': {
        const geometry = element.querySelector<SVGGraphicsElement>(':scope > .dv-geom');
        box = geometry ? transformBox(ctm, geometry.getBBox()) : null;
        break;
      }
      case 'text':
        box = transformBox(ctm, textLocalBox(element, node));
        break;
      case 'group': {
        box = union(node.children.map(measure).filter((child): child is Box => child !== null));
        if (box && node.clip) {
          const clip = union(node.clip.map((shape) => clipShapeBox(element, shape)));
          box = clip ? intersect(box, clip) : box;
        }
        break;
      }
    }
    if (box) {
      boxes.set(node.key, box);
    }
    return box;
  };
  scene.children.forEach(measure);
  return { elements, boxes };
}

function textLocalBox(element: SVGGElement, node: TextNode): Box {
  if (node.frame.type === 'area') {
    return { x: 0, y: 0, width: node.frame.width, height: node.frame.height };
  }
  let left = Infinity;
  let right = -Infinity;
  for (const text of element.querySelectorAll<SVGTextElement>(':scope > text')) {
    const bbox = text.getBBox();
    left = Math.min(left, bbox.x);
    right = Math.max(right, bbox.x + bbox.width);
  }
  let top = Infinity;
  let bottom = -Infinity;
  for (const line of node.lines) {
    const size = Math.max(...line.runs.map((run) => node.styles[run.style]?.size ?? 0));
    top = Math.min(top, line.y - ASCENT * size);
    bottom = Math.max(bottom, line.y + DESCENT * size);
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Clip shapes live in <clipPath> and are never rendered, so measure a temporary copy inside the group. */
function clipShapeBox(group: SVGGElement, shape: ShapeNode): Box {
  const { a, b, c, d, e, f } = shape.transform;
  group.insertAdjacentHTML('beforeend', geometryElement(shape.geometry, `transform="matrix(${a} ${b} ${c} ${d} ${e} ${f})" visibility="hidden"`));
  const probe = group.lastElementChild as SVGGraphicsElement;
  const ctm = probe.getCTM();
  const box = ctm ? transformBox(ctm, probe.getBBox()) : { x: 0, y: 0, width: 0, height: 0 };
  probe.remove();
  return box;
}

function transformBox(m: DOMMatrix, box: Box): Box {
  const corners = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height],
  ].map(([x = 0, y = 0]) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
