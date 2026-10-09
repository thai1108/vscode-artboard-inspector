import type { HostMessage, ImagePayload } from '../protocol.ts';
import { measureBetween, type Guide } from '../render/measure.ts';
import { renderArtboardSvg } from '../render/svg.ts';
import { fmt, type Box } from '../render/geometry.ts';
import type { ArtboardScene, ArtboardSummary, SceneNode } from '../scene/scene.ts';
import { indexScene, measureLayers, type IndexedNode } from './bounds.ts';
import { escapeHtml } from '../render/html.ts';
import { byId } from './dom.ts';
import { renderInspector } from './inspector.ts';
import { renderLayerTree } from './layers.ts';
import { drawOverlay } from './overlay.ts';
import { isTyping, Viewport } from './viewport.ts';
import { vscode } from './vscodeApi.ts';

/** Selection key of the artboard itself. */
const ARTBOARD = '';

byId('app').innerHTML = `
  <aside id="sidebar">
    <section class="pane">
      <div class="pane-title">Artboards <span id="artboard-count" class="dim"></span></div>
      <input id="artboard-filter" type="search" placeholder="Filter artboards" spellcheck="false">
      <ul id="artboards"></ul>
    </section>
    <section class="pane grow">
      <div class="pane-title">Layers</div>
      <div id="layers"></div>
    </section>
  </aside>
  <main id="stage">
    <header id="toolbar">
      <button id="toggle-sidebar" class="icon-button" title="Toggle sidebar">☰</button>
      <span id="artboard-title"></span>
      <span class="spacer"></span>
      <span id="warnings" class="warning-badge" hidden></span>
      <button id="zoom-out" class="icon-button" title="Zoom out (-)">−</button>
      <button id="zoom-value" class="zoom-value" title="Actual size (1)">100%</button>
      <button id="zoom-in" class="icon-button" title="Zoom in (+)">+</button>
      <button id="fit-width" class="text-button" title="Fit width (W)">Fit width</button>
      <button id="fit-all" class="text-button" title="Fit artboard (0)">Fit</button>
    </header>
    <div id="viewport">
      <div id="canvas"></div>
      <svg id="overlay"></svg>
      <div id="message" hidden></div>
    </div>
  </main>
  <aside id="inspector"></aside>
  <div id="toast" hidden></div>
`;

const ui = {
  app: byId('app'),
  artboards: byId<HTMLUListElement>('artboards'),
  artboardCount: byId('artboard-count'),
  artboardFilter: byId<HTMLInputElement>('artboard-filter'),
  layers: byId('layers'),
  title: byId('artboard-title'),
  warnings: byId('warnings'),
  zoomValue: byId('zoom-value'),
  viewport: byId('viewport'),
  canvas: byId('canvas'),
  overlay: document.getElementById('overlay') as unknown as SVGSVGElement,
  message: byId('message'),
  inspector: byId('inspector'),
  toast: byId('toast'),
};

let artboards: ArtboardSummary[] = [];
let scene: ArtboardScene | null = null;
let index = new Map<string, IndexedNode>();
let boxes = new Map<string, Box>();
let selected: string | null = null;
let hovered: string | null = null;
const imageUrls = new Map<string, string>();
const state = vscode.getState() ?? {};

const viewport = new Viewport(ui.viewport, ui.canvas, () => {
  ui.zoomValue.textContent = `${Math.round(viewport.zoom * 100)}%`;
  redrawOverlay();
});

if (state.sidebarHidden) {
  ui.app.classList.add('no-sidebar');
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'document':
      onDocument(message.fileName, message.artboards);
      break;
    case 'artboard':
      void onArtboard(message.scene, message.images);
      break;
    case 'error':
      showMessage(message.message);
      break;
  }
});

function onDocument(fileName: string, list: ArtboardSummary[]): void {
  artboards = list;
  document.title = fileName;
  ui.artboardCount.textContent = String(list.length);
  renderArtboardList();
  const wanted = scene?.id ?? state.artboardId;
  const target = list.find((artboard) => artboard.id === wanted) ?? list[0];
  if (target) {
    requestArtboard(target.id);
  } else {
    showMessage('This XD file has no artboards.');
  }
}

function requestArtboard(id: string): void {
  vscode.postMessage({ type: 'loadArtboard', id, knownImages: [...imageUrls.keys()] });
}

async function onArtboard(next: ArtboardScene, images: ImagePayload[]): Promise<void> {
  for (const image of images) {
    imageUrls.set(image.uid, URL.createObjectURL(new Blob([image.data as Uint8Array<ArrayBuffer>], { type: image.mime })));
  }
  const sameArtboard = scene?.id === next.id;
  scene = next;
  state.artboardId = next.id;
  vscode.setState(state);

  ui.message.hidden = true;
  ui.canvas.innerHTML = renderArtboardSvg(next, (uid) => imageUrls.get(uid));
  await document.fonts.ready;
  const svg = ui.canvas.querySelector<SVGSVGElement>('svg.dv-artboard');
  index = indexScene(next);
  boxes = svg ? measureLayers(svg, next).boxes : new Map();
  if (!sameArtboard || (selected !== null && selected !== ARTBOARD && !index.has(selected))) {
    selected = null;
  }
  hovered = null;

  ui.title.innerHTML = `${escapeHtml(next.name)} <span class="dim">${fmt(next.width)} × ${fmt(next.height)}</span>`;
  const warningCount = new Set(next.warnings).size;
  ui.warnings.hidden = warningCount === 0;
  ui.warnings.textContent = `⚠ ${warningCount}`;
  ui.warnings.title = `${warningCount} layer issue(s) — see the inspector`;
  ui.layers.innerHTML = renderLayerTree(next.children);
  renderArtboardList();
  viewport.setContent(next.width, next.height);
  if (!sameArtboard) {
    viewport.fitWidth();
  }
  refreshSelection();
}

function renderArtboardList(): void {
  const filter = ui.artboardFilter.value.trim().toLowerCase();
  ui.artboards.innerHTML = artboards
    .filter((artboard) => !filter || artboard.name.toLowerCase().includes(filter))
    .map(
      (artboard) =>
        `<li class="artboard-item${artboard.id === scene?.id ? ' active' : ''}" data-id="${escapeHtml(artboard.id)}" title="${escapeHtml(artboard.name)}">` +
        `<span class="artboard-name">${escapeHtml(artboard.name)}</span><span class="dim">${fmt(artboard.width)}×${fmt(artboard.height)}</span></li>`,
    )
    .join('');
}

function boxOf(key: string | null): Box | null {
  if (key === null || !scene) {
    return null;
  }
  return key === ARTBOARD ? { x: 0, y: 0, width: scene.width, height: scene.height } : (boxes.get(key) ?? null);
}

function ancestorsOf(key: string): SceneNode[] {
  const chain: SceneNode[] = [];
  let parent = index.get(key)?.parentKey ?? null;
  while (parent !== null) {
    const entry = index.get(parent);
    if (!entry) {
      break;
    }
    chain.unshift(entry.node);
    parent = entry.parentKey;
  }
  return chain;
}

function select(key: string | null, options: { reveal?: boolean } = {}): void {
  selected = key;
  refreshSelection();
  const box = boxOf(key);
  if (options.reveal && box && key !== ARTBOARD) {
    viewport.reveal(box);
  }
}

function refreshSelection(): void {
  if (!scene) {
    return;
  }
  const node = selected && selected !== ARTBOARD ? (index.get(selected)?.node ?? null) : null;
  ui.inspector.innerHTML = renderInspector({
    scene,
    node,
    box: node ? boxOf(node.key) : null,
    ancestors: node ? ancestorsOf(node.key) : [],
    layerCount: index.size,
  });
  for (const row of ui.layers.querySelectorAll('.layer-row.selected')) {
    row.classList.remove('selected');
  }
  if (node) {
    const row = ui.layers.querySelector(`.layer-row[data-key="${CSS.escape(node.key)}"]`);
    if (row) {
      row.classList.add('selected');
      for (let li = row.parentElement?.parentElement?.closest('li.layer'); li; li = li.parentElement?.closest('li.layer')) {
        li.classList.remove('collapsed');
      }
      row.scrollIntoView({ block: 'nearest' });
    }
  }
  redrawOverlay();
}

function redrawOverlay(): void {
  const selectedBox = boxOf(selected);
  const hoveredBox = hovered !== selected ? boxOf(hovered) : null;
  let guides: Guide[] = [];
  if (selectedBox && hoveredBox && selected !== ARTBOARD) {
    guides = measureBetween(selectedBox, hoveredBox);
  }
  drawOverlay(ui.overlay, viewport, {
    selected: selected === ARTBOARD ? null : selectedBox,
    hovered: hovered === ARTBOARD ? null : hoveredBox,
    guides,
  });
}

function layerKeyAt(target: EventTarget | null): string | null {
  const element = target as Element | null;
  const layer = element?.closest('g[data-key]');
  if (layer) {
    return (layer as SVGGElement).dataset['key'] ?? null;
  }
  return element?.closest('svg.dv-artboard') ? ARTBOARD : null;
}

function setHovered(key: string | null): void {
  if (key !== hovered) {
    hovered = key;
    redrawOverlay();
  }
}

ui.canvas.addEventListener('pointermove', (event) => setHovered(layerKeyAt(event.target)));
ui.canvas.addEventListener('pointerleave', () => setHovered(null));
ui.viewport.addEventListener('click', (event) => {
  if (viewport.consumeDragClick()) {
    return;
  }
  select(layerKeyAt(event.target));
});

ui.layers.addEventListener('click', (event) => {
  const target = event.target as Element;
  const row = target.closest<HTMLElement>('.layer-row');
  if (!row) {
    return;
  }
  if (target.closest('[data-toggle]')) {
    row.parentElement?.classList.toggle('collapsed');
    return;
  }
  select(row.dataset['key'] ?? null, { reveal: true });
});
ui.layers.addEventListener('pointerover', (event) => {
  const row = (event.target as Element).closest<HTMLElement>('.layer-row');
  setHovered(row?.dataset['key'] ?? null);
});
ui.layers.addEventListener('pointerleave', () => setHovered(null));

ui.artboards.addEventListener('click', (event) => {
  const item = (event.target as Element).closest<HTMLElement>('.artboard-item');
  const id = item?.dataset['id'];
  if (id && id !== scene?.id) {
    requestArtboard(id);
  }
});
ui.artboardFilter.addEventListener('input', renderArtboardList);

ui.inspector.addEventListener('click', (event) => {
  const target = event.target as Element;
  const crumb = target.closest<HTMLElement>('[data-select]');
  if (crumb) {
    select(crumb.dataset['select'] ?? null, { reveal: true });
    return;
  }
  const copy = target.closest<HTMLElement>('[data-copy]');
  if (copy?.dataset['copy'] !== undefined) {
    vscode.postMessage({ type: 'copy', text: copy.dataset['copy'], label: copy.dataset['label'] ?? 'value' });
    showToast(`Copied ${copy.dataset['label'] ?? ''}`);
  }
});

byId('toggle-sidebar').addEventListener('click', () => {
  state.sidebarHidden = ui.app.classList.toggle('no-sidebar');
  vscode.setState(state);
});
byId('zoom-in').addEventListener('click', () => viewport.zoomIn());
byId('zoom-out').addEventListener('click', () => viewport.zoomOut());
byId('zoom-value').addEventListener('click', () => viewport.actualSize());
byId('fit-width').addEventListener('click', () => viewport.fitWidth());
byId('fit-all').addEventListener('click', () => viewport.fitAll());

window.addEventListener('keydown', (event) => {
  if (isTyping(event) || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  switch (event.key) {
    case 'Escape':
      if (selected !== null && selected !== ARTBOARD) {
        select(index.get(selected)?.parentKey ?? ARTBOARD);
      } else {
        select(null);
      }
      break;
    case '+':
    case '=':
      viewport.zoomIn();
      break;
    case '-':
      viewport.zoomOut();
      break;
    case '0':
      viewport.fitAll();
      break;
    case '1':
      viewport.actualSize();
      break;
    case 'w':
    case 'W':
      viewport.fitWidth();
      break;
    default:
      return;
  }
  event.preventDefault();
});

function showMessage(text: string): void {
  ui.message.textContent = text;
  ui.message.hidden = false;
}

let toastTimer: number | undefined;
function showToast(text: string): void {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    ui.toast.hidden = true;
  }, 1500);
}

vscode.postMessage({ type: 'ready' });
