import type { ArtboardDiff, CompareSummary } from '../compare/compare.ts';
import type { HostMessage, ImagePayload } from '../protocol.ts';
import type { BoardLayout } from '../scene/board.ts';
import { measureBetween, type Guide } from '../render/measure.ts';
import { renderArtboardSvg } from '../render/svg.ts';
import { fmt, type Box } from '../render/geometry.ts';
import type { ArtboardScene, ArtboardSummary, SceneNode } from '../scene/scene.ts';
import type { SearchHit } from '../search.ts';
import { BoardView } from './board.ts';
import { indexScene, measureLayers, type IndexedNode } from './bounds.ts';
import {
  artboardBadge,
  artboardChangesSection,
  changeOf,
  Comparison,
  counterpartKey,
  diffMarks,
  keyOn,
  layerChangesSection,
  layerStatuses,
  summaryText,
  type DiffMark,
  type Version,
} from './compare.ts';
import { escapeHtml } from '../render/html.ts';
import { byId } from './dom.ts';
import { exportLayer, type ExportFormat, type ExportTarget } from './exporter.ts';
import { ImageStore } from './images.ts';
import { renderInspector } from './inspector.ts';
import { renderLayerTree } from './layers.ts';
import { drawOverlay } from './overlay.ts';
import { ScreenshotOverlay } from './screenshot.ts';
import { SearchPanel } from './search.ts';
import { isTyping, Viewport } from './viewport.ts';
import { vscode } from './vscodeApi.ts';

/** Selection key of the artboard itself. */
const ARTBOARD = '';
const isMac = navigator.userAgent.includes('Mac');

byId('app').innerHTML = `
  <aside id="sidebar">
    <section class="pane" id="search-pane">
      <div class="pane-title">Search</div>
      <input id="search" type="search" placeholder="Text and layer names (${isMac ? '⌘F' : 'Ctrl+F'})" spellcheck="false" aria-controls="search-results">
      <div id="search-status" class="dim" hidden></div>
      <ul id="search-results" role="listbox" aria-label="Search results" hidden></ul>
    </section>
    <section class="pane">
      <div class="pane-title">Artboards <span id="artboard-count" class="dim"></span></div>
      <input id="artboard-filter" type="search" placeholder="Filter artboards" spellcheck="false">
      <label id="compare-filter" class="compare-filter" hidden><input id="compare-changed-only" type="checkbox"> Changed only</label>
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
      <span id="version-tag" class="version-tag" hidden></span>
      <span class="spacer"></span>
      <span id="warnings" class="warning-badge" hidden></span>
      <button id="compare-start" class="text-button" title="Compare with another version of this design (.xd or .fig)">Compare…</button>
      <button id="screenshot-load" class="text-button" title="Overlay a screenshot (PNG, JPEG or WebP) on this artboard. You can also paste one, or drop one while holding Shift." hidden>Overlay</button>
      <button id="zoom-out" class="icon-button" title="Zoom out (-)">−</button>
      <button id="zoom-value" class="zoom-value" title="Actual size (1)">100%</button>
      <button id="zoom-in" class="icon-button" title="Zoom in (+)">+</button>
      <button id="fit-width" class="text-button" title="Fit width (W)">Fit width</button>
      <button id="fit-all" class="text-button" title="Fit artboard (0)">Fit</button>
    </header>
    <div id="compare-bar" hidden>
      <span id="compare-files" class="compare-files"></span>
      <span id="compare-summary" class="dim"></span>
      <span class="spacer"></span>
      <div class="mode-toggle" role="group" aria-label="Version shown">
        <button id="compare-before" class="text-button" title="Show the earlier version (\`)">Before</button>
        <button id="compare-after" class="text-button" title="Show the current version (\`)">After</button>
      </div>
      <button id="compare-swap" class="text-button" title="Make the other file the current version and this one the earlier">Swap</button>
      <button id="compare-exit" class="text-button" title="Leave compare mode">Exit</button>
    </div>
    <div id="screenshot-bar" hidden></div>
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
  versionTag: byId('version-tag'),
  compareStart: byId('compare-start'),
  compareBar: byId('compare-bar'),
  compareFiles: byId('compare-files'),
  compareSummary: byId('compare-summary'),
  compareBefore: byId<HTMLButtonElement>('compare-before'),
  compareAfter: byId<HTMLButtonElement>('compare-after'),
  compareFilter: byId('compare-filter'),
  changedOnly: byId<HTMLInputElement>('compare-changed-only'),
};

type Mode = 'artboard' | 'board';

let artboards: ArtboardSummary[] = [];
let artboardsById = new Map<string, ArtboardSummary>();
let fileName = '';
/** The scene drawn in the single view: the current version's, or the earlier one's while comparing (`version`). */
let scene: ArtboardScene | null = null;
let index = new Map<string, IndexedNode>();
let boxes = new Map<string, Box>();
let selected: string | null = null;
let hovered: string | null = null;
/** Layer to select once its artboard is shown (a search hit in another artboard). */
let pendingLayer: { artboard: string; key: string } | null = null;
/** Images of the file shown as the current version; `beforeImages` hold the earlier one's while comparing. */
let images = new ImageStore();
let beforeImages = new ImageStore();
let comparison: Comparison | null = null;
let version: Version = 'after';
/** The last current-version scene shown, to switch back to from the earlier version without asking the host. */
let lastAfterScene: ArtboardScene | null = null;
/** How to show a scene requested from the host when it arrives: which version, the layer to select, whether to fit. */
let pendingView: { id: string; version: Version; select: string | null; fit: boolean } | null = null;
/** Outlines of the changed layers of the artboard shown. */
let marks: DiffMark[] = [];
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
  imageUrl: (uid) => images.url(uid),
  imageFormat: (uid) => images.format(uid),
  requestScenes: (ids) => vscode.postMessage({ type: 'loadArtboards', ids, knownImages: images.known() }),
  onSelectionChange: () => renderArtboardList(),
  titleBadge: (id) => artboardBadge(comparison?.entry(id, 'after')),
});

const search = new SearchPanel({
  input: byId<HTMLInputElement>('search'),
  status: byId('search-status'),
  results: byId('search-results'),
  requestSearch: (query, seq) => vscode.postMessage({ type: 'search', query, seq }),
  artboardName: (id) => artboardsById.get(id)?.name,
  artboardCount: () => artboards.length,
  open: openSearchHit,
});

const screenshots = new ScreenshotOverlay({
  canvas: ui.canvas,
  dropTarget: ui.viewport,
  bar: byId('screenshot-bar'),
  loadButton: byId('screenshot-load'),
  artboardWidth: (id) => artboards.find((artboard) => artboard.id === id)?.width,
  requestPick: (artboardId) => vscode.postMessage({ type: 'pickScreenshot', artboardId }),
  notify: (text) => showToast(text, 4000),
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
      if (message.side === 'before') {
        void onBeforeArtboard(message.scene, message.images, message.diff);
      } else {
        void onArtboard(message.scene, message.images, message.diff);
      }
      break;
    case 'scenes':
      images.add(message.images);
      images.noteUndecodable(message.scenes);
      board.onScenes(message.scenes, message.failed);
      break;
    case 'compare':
      onCompare(message.summary);
      break;
    case 'searchResults':
      search.onResults(message);
      break;
    case 'screenshot':
      void screenshots.receive(message);
      break;
    case 'error':
      showMessage(message.message);
      break;
  }
});

function onDocument(name: string, list: ArtboardSummary[], layout: BoardLayout): void {
  artboards = list;
  artboardsById = new Map(list.map((artboard) => [artboard.id, artboard]));
  fileName = name;
  document.title = name;
  ui.artboardCount.textContent = String(list.length);
  screenshots.retain(new Set(list.map((artboard) => artboard.id)));
  board.setDocument(list, layout, state.boardPage);
  renderPageSelect();
  renderArtboardList();
  search.refresh();
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

/** Images of the version drawn in the single view. */
function shownImages(): ImageStore {
  return version === 'before' ? beforeImages : images;
}

/** The compare summary entry of the artboard drawn in the single view. */
function shownEntry() {
  return scene ? comparison?.entry(scene.id, version) : undefined;
}

function shownDiff(): ArtboardDiff | undefined {
  return comparison?.diff(shownEntry());
}

/**
 * Compare mode started, was redone or swapped, or ended. When the file shown as the current version changes (swap,
 * or ending a swapped comparison), the image stores trade places and the host sends that file's document next.
 */
function onCompare(summary: CompareSummary | null): void {
  const previous = comparison;
  if (previous && summary && previous.sameAs(summary)) {
    return;
  }
  const flipped = (previous?.summary.swapped ?? false) !== (summary?.swapped ?? false);
  const entry = shownEntry();
  const shownKey = selected !== null && selected !== ARTBOARD ? selected : null;
  // The selected layer as a key of the current version's scene.
  const afterKey = shownKey && version === 'before' ? counterpartKey(previous?.diff(entry), 'before', shownKey) : shownKey;
  if (flipped) {
    [images, beforeImages] = [beforeImages, images];
  } else {
    beforeImages.clear();
  }
  comparison = summary ? new Comparison(summary) : null;
  pendingView = null;
  lastAfterScene = null;
  if (flipped) {
    // The other file becomes the one shown (its document comes next): open the same artboard and layer there.
    const counterpart = entry?.beforeId;
    const key = version === 'before' ? shownKey : afterKey && previous ? counterpartKey(previous.diff(entry), 'after', afterKey) : null;
    const shown = mode === 'artboard' && scene !== null;
    scene = null;
    version = 'after';
    if (counterpart) {
      state.artboardId = counterpart;
      pendingView = shown ? { id: counterpart, version: 'after', select: key, fit: false } : null;
    }
  } else if (mode === 'artboard' && scene) {
    // Ask again for the current version of the artboard shown: it comes with its diff, or without when comparing ended.
    const target = (version === 'after' ? scene.id : entry?.afterId) ?? state.artboardId ?? artboards[0]?.id;
    if (target) {
      pendingView = { id: target, version: 'after', select: afterKey, fit: target !== scene.id };
      requestArtboard(target);
    }
  }
  marks = [];
  renderCompareBar();
  renderArtboardList();
  board.refreshTitles();
  if (mode === 'artboard' && scene) {
    refreshSelection();
  }
}

function renderCompareBar(): void {
  const summary = comparison?.summary;
  ui.compareBar.hidden = !summary;
  ui.compareStart.hidden = !!summary;
  ui.compareFilter.hidden = !summary;
  ui.versionTag.hidden = !summary || mode !== 'artboard' || !scene;
  ui.versionTag.textContent = version === 'before' ? 'Before' : 'After';
  ui.versionTag.classList.toggle('before', version === 'before');
  if (!summary) {
    return;
  }
  ui.compareFiles.innerHTML =
    `<span class="compare-file" title="Earlier version">${escapeHtml(summary.beforeName)}</span>` +
    '<span class="compare-arrow">→</span>' +
    `<span class="compare-file" title="Current version">${escapeHtml(summary.afterName)}</span>`;
  ui.compareSummary.textContent = summaryText(summary);
  ui.compareSummary.title =
    `Layers matched by id: ${summary.matched.byId.toLocaleString('en-US')}, by name: ${summary.matched.byName.toLocaleString('en-US')}` +
    (summary.truncated ? '. Some artboards were not compared (too many layers).' : '');
  const entry = shownEntry();
  const single = mode === 'artboard';
  ui.compareBefore.disabled = !single || !entry?.beforeId;
  ui.compareAfter.disabled = !single || !entry?.afterId;
  for (const [button, value] of [
    [ui.compareBefore, 'before'],
    [ui.compareAfter, 'after'],
  ] as const) {
    const active = single && version === value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

/**
 * Shows the other version of the artboard in the single view, keeping zoom and pan, and selecting `select` there
 * (by default the same layer as now, where it exists).
 */
function showVersion(next: Version, select?: string | null): void {
  const entry = shownEntry();
  const target = next === 'after' ? entry?.afterId : entry?.beforeId;
  if (!comparison || !entry || !target || mode !== 'artboard' || next === version) {
    return;
  }
  const key = select !== undefined ? select : selected !== null && selected !== ARTBOARD ? counterpartKey(comparison.diff(entry), version, selected) : selected;
  const cached = next === 'before' ? comparison.beforeScenes.get(target) : lastAfterScene?.id === target ? lastAfterScene : undefined;
  if (cached) {
    version = next;
    selected = key;
    void showArtboard(cached, false);
    return;
  }
  pendingView = { id: target, version: next, select: key, fit: false };
  requestArtboard(target, next);
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
  // The board shows the current version only.
  const afterScene = version === 'after' ? scene : lastAfterScene;
  if (afterScene) {
    board.addScene(afterScene);
  }
  if (version === 'before') {
    version = 'after';
    scene = afterScene;
  }
  pendingView = null;
  setMode('board');
  renderCompareBar();
  screenshots.show(null);
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
  // Scenes the board holds came without their diff; while comparing, ask the host, which sends both.
  const diffMissing = comparison !== null && targetId !== undefined && !comparison.diff(comparison.entry(targetId, 'after'));
  const cached = targetId && !diffMissing ? (targetId === scene?.id ? scene : board.sceneOf(targetId)) : undefined;
  if (cached) {
    void showArtboard(cached, true);
  } else if (targetId) {
    scene = null;
    requestArtboard(targetId);
  }
  renderCompareBar();
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

function requestArtboard(id: string, side: Version = 'after'): void {
  if (side === 'before') {
    vscode.postMessage({ type: 'loadArtboard', id, knownImages: beforeImages.known(), side: 'before' });
  } else {
    vscode.postMessage({ type: 'loadArtboard', id, knownImages: images.known() });
  }
}

/** Takes the view a scene was requested for, if this is that scene. */
function takePendingView(next: ArtboardScene, side: Version): { select: string | null; fit: boolean } | null {
  const view = pendingView;
  if (view?.id !== next.id || view.version !== side) {
    return null;
  }
  pendingView = null;
  return view;
}

async function onArtboard(next: ArtboardScene, received: ImagePayload[], diff: ArtboardDiff | undefined): Promise<void> {
  images.add(received);
  images.noteUndecodable([next]);
  if (diff) {
    comparison?.addDiff(diff);
  }
  if (mode === 'board') {
    board.addScene(next);
    return;
  }
  const view = takePendingView(next, 'after');
  version = 'after';
  if (view) {
    selected = view.select;
  }
  await showArtboard(next, view ? view.fit : scene?.id !== next.id);
}

/** The earlier version of an artboard, for the Before view; kept until the comparison changes. */
async function onBeforeArtboard(next: ArtboardScene, received: ImagePayload[], diff: ArtboardDiff | undefined): Promise<void> {
  beforeImages.add(received);
  beforeImages.noteUndecodable([next]);
  if (!comparison) {
    return;
  }
  if (diff) {
    comparison.addDiff(diff);
  }
  comparison.beforeScenes.set(next.id, next);
  const view = takePendingView(next, 'before');
  if (view && mode === 'artboard') {
    version = 'before';
    selected = view.select;
    await showArtboard(next, view.fit);
  }
}

async function showArtboard(next: ArtboardScene, fit: boolean): Promise<void> {
  const sameArtboard = !fit;
  scene = next;
  if (version === 'after') {
    lastAfterScene = next;
    state.artboardId = next.id;
    vscode.setState(state);
  }

  ui.message.hidden = true;
  const shown = shownImages();
  ui.canvas.innerHTML = renderArtboardSvg(next, (uid) => shown.url(uid));
  screenshots.show(version === 'after' ? next.id : null);
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
  markChangedLayers();
  renderArtboardList();
  renderCompareBar();
  viewport.setContent(next.width, next.height);
  if (!sameArtboard) {
    viewport.fitWidth();
  }
  if (pendingLayer?.artboard === next.id) {
    const { key } = pendingLayer;
    pendingLayer = null;
    if (index.has(key)) {
      select(key, { reveal: true });
      return;
    }
  }
  refreshSelection();
}

function openSearchHit(hit: SearchHit): void {
  // Hits are layers of the current version.
  if (mode === 'artboard' && version === 'after' && scene?.id === hit.artboard) {
    pendingLayer = null;
    if (index.has(hit.key)) {
      select(hit.key, { reveal: true });
    }
    return;
  }
  pendingLayer = { artboard: hit.artboard, key: hit.key };
  pendingView = null;
  if (mode === 'board') {
    enterArtboard(hit.artboard);
  } else {
    requestArtboard(hit.artboard);
  }
}

/** The current version's artboards, then (while comparing) those only in the earlier version. */
function renderArtboardList(): void {
  const filter = ui.artboardFilter.value.trim().toLowerCase();
  const changedOnly = comparison !== null && ui.changedOnly.checked;
  const active = mode === 'board' ? board.selectedArtboard : version === 'after' ? scene?.id : undefined;
  const shown = shownEntry();
  const item = (artboard: { id: string; name: string; width: number; height: number }, side: Version) => {
    const entry = comparison?.entry(artboard.id, side);
    if ((filter && !artboard.name.toLowerCase().includes(filter)) || (changedOnly && entry?.status === 'unchanged')) {
      return '';
    }
    const isActive = (side === 'after' && artboard.id === active) || (entry !== undefined && entry === shown && mode === 'artboard');
    return (
      `<li class="artboard-item${isActive ? ' active' : ''}${side === 'before' ? ' removed' : ''}" data-id="${escapeHtml(artboard.id)}"${side === 'before' ? ' data-version="before"' : ''} title="${escapeHtml(artboard.name)}">` +
      `<span class="artboard-name">${escapeHtml(artboard.name)}</span>${artboardBadge(entry)}<span class="dim">${fmt(artboard.width)}×${fmt(artboard.height)}</span></li>`
    );
  };
  const removed = (comparison?.removed ?? []).map((entry) => item({ ...entry, id: entry.beforeId ?? '' }, 'before'));
  ui.artboards.innerHTML = artboards.map((artboard) => item(artboard, 'after')).join('') + removed.join('');
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
  const shown = shownImages();
  let changes: string | undefined;
  if (comparison) {
    const entry = shownEntry();
    changes = node ? layerChangesSection(changeOf(shownDiff(), version, node.key), comparison.summary) : artboardChangesSection(entry, shownDiff(), version);
  }
  ui.inspector.innerHTML = renderInspector({
    scene,
    node,
    box: node ? boxOf(node.key) : null,
    ancestors: node ? ancestorsOf(node.key) : [],
    layerCount: index.size,
    imageFormat: (uid) => shown.format(uid),
    changes,
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
    marks,
  });
}

/** Colours the changed layers in the tree and outlines them on the canvas, for the version shown. */
function markChangedLayers(): void {
  const diff = shownDiff();
  marks = diffMarks(diff, version, boxes);
  const statuses = layerStatuses(diff, version);
  if (!statuses.size) {
    return;
  }
  for (const row of ui.layers.querySelectorAll<HTMLElement>('.layer-row')) {
    const status = statuses.get(row.dataset['key'] ?? '');
    if (status) {
      row.classList.add(`diff-${status}`);
    }
  }
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
  if (!id) {
    return;
  }
  if (item.dataset['version'] === 'before') {
    // Only in the earlier version: shown on its own, as Before.
    if (mode === 'board') {
      board.deactivate();
      setMode('artboard');
      ui.overlay.innerHTML = '';
    }
    const cached = comparison?.beforeScenes.get(id);
    if (cached) {
      version = 'before';
      selected = null;
      void showArtboard(cached, true);
    } else {
      pendingView = { id, version: 'before', select: null, fit: true };
      requestArtboard(id, 'before');
    }
  } else if (mode === 'board') {
    board.flyTo(id);
    state.boardPage = board.currentPage;
    vscode.setState(state);
    renderPageSelect();
    renderBoardTitle();
  } else if (id !== scene?.id || version !== 'after') {
    pendingView = null;
    requestArtboard(id);
  }
});
ui.artboardFilter.addEventListener('input', renderArtboardList);
ui.changedOnly.addEventListener('change', renderArtboardList);

ui.inspector.addEventListener('click', (event) => {
  const target = event.target as Element;
  const listed = target.closest<HTMLElement>('[data-change]');
  if (listed && mode === 'artboard') {
    const change = shownDiff()?.changes[Number(listed.dataset['change'])];
    const key = change ? keyOn(change, version) : null;
    if (key !== null) {
      select(key, { reveal: true });
    } else if (change) {
      // Only in the other version: show that one with the layer selected.
      const other: Version = version === 'after' ? 'before' : 'after';
      showVersion(other, keyOn(change, other));
    }
    return;
  }
  const crumb = target.closest<HTMLElement>('[data-select]');
  if (crumb) {
    if (mode === 'board') {
      board.selectLayer(crumb.dataset['select'] ?? null, { reveal: true });
    } else {
      select(crumb.dataset['select'] ?? null, { reveal: true });
    }
    return;
  }
  const exportButton = target.closest<HTMLElement>('[data-export]');
  if (exportButton) {
    void runExport(exportButton.dataset['export'] as ExportFormat, Number(exportButton.dataset['scale'] ?? 1));
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
ui.compareStart.addEventListener('click', () => vscode.postMessage({ type: 'pickCompare' }));
byId('compare-swap').addEventListener('click', () => vscode.postMessage({ type: 'swapCompare' }));
byId('compare-exit').addEventListener('click', () => vscode.postMessage({ type: 'exitCompare' }));
ui.compareBefore.addEventListener('click', () => showVersion('before'));
ui.compareAfter.addEventListener('click', () => showVersion('after'));
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
  if ((event.key === 'f' || event.key === 'F') && (isMac ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey) {
    event.preventDefault();
    search.focus();
    return;
  }
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
    case '`':
      if (!comparison) {
        return;
      }
      showVersion(version === 'after' ? 'before' : 'after');
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

function exportTarget(): ExportTarget | null {
  if (mode === 'board') {
    return board.selectedLayer();
  }
  return scene && selected ? { scene, key: selected, boxes } : null;
}

let exporting = false;
/** Builds the file and hands it to the host, which asks where to save it. One export at a time. */
async function runExport(format: ExportFormat, scale: number): Promise<void> {
  const target = exportTarget();
  if (!target || exporting) {
    return;
  }
  exporting = true;
  try {
    const { fileName, data } = await exportLayer(target, format, scale, mode === 'board' ? images.blobs : shownImages().blobs);
    vscode.postMessage({ type: 'save', fileName, data });
  } catch (error) {
    showToast(`Export failed: ${(error as Error).message}`, 4000);
  } finally {
    exporting = false;
  }
}

let toastTimer: number | undefined;
function showToast(text: string, durationMs = 1500): void {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    ui.toast.hidden = true;
  }, durationMs);
}

setMode(mode);
vscode.postMessage({ type: 'ready' });
