import type { HostMessage, ImagePayload } from '../protocol.ts';
import type { BoardLayout } from '../scene/board.ts';
import { measureBetween, type Guide } from '../render/measure.ts';
import { renderArtboardSvg } from '../render/svg.ts';
import { fmt, type Box } from '../render/geometry.ts';
import type { ArtboardScene, ArtboardSummary, SceneNode } from '../scene/scene.ts';
import { BoardView } from './board.ts';
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
      <div class="mode-toggle" role="group" aria-label="View mode">
        <button id="mode-artboard" class="text-button" title="One artboard (B)">Artboard</button>
        <button id="mode-board" class="text-button" title="All artboards at their positions (B)">Board</button>
      </div>
      <select id="board-page" title="Page" hidden></select>
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
      <div id="board-titles" hidden></div>
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
  boardTitles: byId('board-titles'),
  boardPage: byId<HTMLSelectElement>('board-page'),
  modeArtboard: byId('mode-artboard'),
  modeBoard: byId('mode-board'),
  message: byId('message'),
  inspector: byId('inspector'),
  toast: byId('toast'),
};

type Mode = 'artboard' | 'board';

let artboards: ArtboardSummary[] = [];
let fileName = '';
let scene: ArtboardScene | null = null;
let index = new Map<string, IndexedNode>();
let boxes = new Map<string, Box>();
let selected: string | null = null;
let hovered: string | null = null;
const imageUrls = new Map<string, string>();
/** Images whose bytes did not arrive as a Uint8Array; shown as a layer warning instead of a silent broken image. */
const undecodableImages = new Set<string>();
const state = vscode.getState() ?? {};

let mode: Mode = state.mode ?? 'artboard';

const viewport = new Viewport(ui.viewport, ui.canvas, () => {
  ui.zoomValue.textContent = `${Math.round(viewport.zoom * 100)}%`;
  if (mode === 'board') {
    board.onViewportChange();
  } else {
    redrawOverlay();
  }
});

const board = new BoardView({
  canvas: ui.canvas,
  titles: ui.boardTitles,
  overlay: ui.overlay,
  inspector: ui.inspector,
  layers: ui.layers,
  viewport,
  imageUrl: (uid) => imageUrls.get(uid),
  requestScenes: (ids) => vscode.postMessage({ type: 'loadArtboards', ids, knownImages: [...imageUrls.keys()] }),
  onSelectionChange: () => renderArtboardList(),
});

if (state.sidebarHidden) {
  ui.app.classList.add('no-sidebar');
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'document':
      onDocument(message.fileName, message.artboards, message.board);
      break;
    case 'artboard':
      void onArtboard(message.scene, message.images);
      break;
    case 'scenes':
      addImages(message.images);
      noteUndecodableImages(message.scenes);
      board.onScenes(message.scenes, message.failed);
      break;
    case 'error':
      showMessage(message.message);
      break;
  }
});

function onDocument(name: string, list: ArtboardSummary[], layout: BoardLayout): void {
  artboards = list;
  fileName = name;
  document.title = name;
  ui.artboardCount.textContent = String(list.length);
  board.setDocument(list, layout, state.boardPage);
  renderPageSelect();
  renderArtboardList();
  if (!list.length) {
    showMessage('This file has no artboards.');
    return;
  }
  if (mode === 'board') {
    if (board.isActive) {
      renderBoardTitle();
    } else {
      enterBoard();
    }
    return;
  }
  const wanted = scene?.id ?? state.artboardId;
  const target = list.find((artboard) => artboard.id === wanted) ?? list[0];
  if (target) {
    requestArtboard(target.id);
  }
}

function addImages(images: ImagePayload[]): void {
  for (const image of images) {
    if (imageUrls.has(image.uid)) {
      continue;
    }
    if (!(image.data instanceof Uint8Array)) {
      undecodableImages.add(image.uid);
      continue;
    }
    imageUrls.set(image.uid, URL.createObjectURL(new Blob([image.data as Uint8Array<ArrayBuffer>], { type: image.mime })));
  }
}

function noteUndecodableImages(scenes: ArtboardScene[]): void {
  for (const target of scenes) {
    for (const uid of target.imageUids) {
      const warning = `Image ${uid} could not be decoded`;
      if (undecodableImages.has(uid) && !target.warnings.includes(warning)) {
        target.warnings.push(warning);
      }
    }
  }
}

function setMode(next: Mode): void {
  mode = next;
  state.mode = next;
  vscode.setState(state);
  ui.app.classList.toggle('board-mode', next === 'board');
  ui.modeArtboard.classList.toggle('active', next === 'artboard');
  ui.modeBoard.classList.toggle('active', next === 'board');
  ui.modeArtboard.setAttribute('aria-pressed', String(next === 'artboard'));
  ui.modeBoard.setAttribute('aria-pressed', String(next === 'board'));
  renderPageSelect();
}

function enterBoard(): void {
  if (scene) {
    board.addScene(scene);
  }
  setMode('board');
  ui.message.hidden = true;
  ui.warnings.hidden = true;
  hovered = null;
  board.activate();
  renderBoardTitle();
  renderArtboardList();
}

/** Leaves the board for the single-artboard view, on `id` or the artboard shown before. */
function enterArtboard(id?: string): void {
  board.deactivate();
  setMode('artboard');
  ui.overlay.innerHTML = '';
  const targetId = id ?? scene?.id ?? state.artboardId ?? artboards[0]?.id;
  const cached = targetId ? board.sceneOf(targetId) : undefined;
  if (targetId === scene?.id && scene) {
    void showArtboard(scene, true);
  } else if (cached) {
    void showArtboard(cached, true);
  } else if (targetId) {
    scene = null;
    requestArtboard(targetId);
  }
}

function renderPageSelect(): void {
  const names = board.pageNames;
  ui.boardPage.hidden = mode !== 'board' || names.length < 2;
  ui.boardPage.innerHTML = names.map((name, i) => `<option value="${i}">${escapeHtml(name)}</option>`).join('');
  ui.boardPage.value = String(board.currentPage);
}

function renderBoardTitle(): void {
  const page = board.pageNames[board.currentPage] ?? fileName;
  ui.title.innerHTML = `${escapeHtml(page)} <span class="dim">${board.artboardCount} artboards</span>`;
}

function requestArtboard(id: string): void {
  vscode.postMessage({ type: 'loadArtboard', id, knownImages: [...imageUrls.keys()] });
}

async function onArtboard(next: ArtboardScene, images: ImagePayload[]): Promise<void> {
  addImages(images);
  noteUndecodableImages([next]);
  if (mode === 'board') {
    board.addScene(next);
    return;
  }
  await showArtboard(next, scene?.id !== next.id);
}

async function showArtboard(next: ArtboardScene, fit: boolean): Promise<void> {
  const sameArtboard = !fit;
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
  const active = mode === 'board' ? board.selectedArtboard : scene?.id;
  ui.artboards.innerHTML = artboards
    .filter((artboard) => !filter || artboard.name.toLowerCase().includes(filter))
    .map(
      (artboard) =>
        `<li class="artboard-item${artboard.id === active ? ' active' : ''}" data-id="${escapeHtml(artboard.id)}" title="${escapeHtml(artboard.name)}">` +
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

ui.canvas.addEventListener('pointermove', (event) => {
  if (mode === 'artboard') {
    setHovered(layerKeyAt(event.target));
  }
});
ui.canvas.addEventListener('pointerleave', () => {
  if (mode === 'artboard') {
    setHovered(null);
  }
});
ui.viewport.addEventListener('pointermove', (event) => {
  if (mode === 'board') {
    board.pointerMove(event.target);
  }
});
ui.viewport.addEventListener('pointerleave', () => {
  if (mode === 'board') {
    board.pointerMove(null);
  }
});
ui.viewport.addEventListener('click', (event) => {
  if (viewport.consumeDragClick()) {
    return;
  }
  if (mode === 'board') {
    board.click(event.target);
  } else {
    select(layerKeyAt(event.target));
  }
});
ui.viewport.addEventListener('dblclick', (event) => {
  const hit = mode === 'board' ? board.hit(event.target) : null;
  if (hit) {
    enterArtboard(hit.artboard);
  }
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
  if (mode === 'board') {
    board.selectLayer(row.dataset['key'] ?? null, { reveal: true });
  } else {
    select(row.dataset['key'] ?? null, { reveal: true });
  }
});
ui.layers.addEventListener('pointerover', (event) => {
  const row = (event.target as Element).closest<HTMLElement>('.layer-row');
  if (mode === 'board') {
    board.hoverLayer(row?.dataset['key'] ?? null);
  } else {
    setHovered(row?.dataset['key'] ?? null);
  }
});
ui.layers.addEventListener('pointerleave', () => {
  if (mode === 'board') {
    board.hoverLayer(null);
  } else {
    setHovered(null);
  }
});

ui.artboards.addEventListener('click', (event) => {
  const item = (event.target as Element).closest<HTMLElement>('.artboard-item');
  const id = item?.dataset['id'];
  if (id && mode === 'board') {
    board.flyTo(id);
    state.boardPage = board.currentPage;
    vscode.setState(state);
    renderPageSelect();
    renderBoardTitle();
  } else if (id && id !== scene?.id) {
    requestArtboard(id);
  }
});
ui.artboardFilter.addEventListener('input', renderArtboardList);

ui.inspector.addEventListener('click', (event) => {
  const target = event.target as Element;
  const crumb = target.closest<HTMLElement>('[data-select]');
  if (crumb) {
    if (mode === 'board') {
      board.selectLayer(crumb.dataset['select'] ?? null, { reveal: true });
    } else {
      select(crumb.dataset['select'] ?? null, { reveal: true });
    }
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
ui.modeArtboard.addEventListener('click', () => {
  if (mode !== 'artboard') {
    enterArtboard();
  }
});
ui.modeBoard.addEventListener('click', () => {
  if (mode !== 'board') {
    enterBoard();
  }
});
ui.boardPage.addEventListener('change', () => {
  board.setPage(Number(ui.boardPage.value));
  state.boardPage = board.currentPage;
  vscode.setState(state);
  renderBoardTitle();
});

window.addEventListener('keydown', (event) => {
  if (isTyping(event) || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  switch (event.key) {
    case 'b':
    case 'B':
      if (mode === 'board') {
        enterArtboard(board.selectedArtboard ?? undefined);
      } else {
        enterBoard();
      }
      break;
    case 'Escape':
      if (mode === 'board') {
        board.escape();
      } else if (selected !== null && selected !== ARTBOARD) {
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

setMode(mode);
vscode.postMessage({ type: 'ready' });
