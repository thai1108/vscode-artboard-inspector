import { buildPages, offsetBox, overlaps, planDetail, visibleRect, type BoardItem, type BoardPage, type ViewState } from '../render/board.ts';
import { fmt, type Box } from '../render/geometry.ts';
import { escapeHtml } from '../render/html.ts';
import { measureBetween, type Guide } from '../render/measure.ts';
import { renderArtboardSvg, type ImageUrlResolver } from '../render/svg.ts';
import type { BoardLayout } from '../scene/board.ts';
import { toCssColor } from '../scene/color.ts';
import type { ArtboardScene, ArtboardSummary, SceneNode } from '../scene/scene.ts';
import { indexScene, measureLayers, type IndexedNode } from './bounds.ts';
import { renderInspector } from './inspector.ts';
import { renderLayerTree } from './layers.ts';
import { drawOverlay } from './overlay.ts';
import type { Viewport } from './viewport.ts';

const LOAD_BATCH = 8;
const MAX_REQUESTS_IN_FLIGHT = 2;
/** Main-thread time per frame spent turning loaded scenes into SVG. */
const RENDER_BUDGET_MS = 12;
/** Artboard titles are hidden when the artboard is narrower than this on screen. */
const TITLE_MIN_SCREEN_WIDTH = 24;
const TITLE_OFFSET_Y = 18;
/** Extra board area around the stage that is drawn ahead of panning. */
const RENDER_MARGIN = 0.5;

/** A layer on the board; `key` '' is the artboard itself. */
export interface BoardSelection {
  artboard: string;
  key: string;
}

export interface BoardDeps {
  canvas: HTMLElement;
  titles: HTMLElement;
  overlay: SVGSVGElement;
  inspector: HTMLElement;
  layers: HTMLElement;
  viewport: Viewport;
  imageUrl: ImageUrlResolver;
  requestScenes(ids: string[]): void;
  /** Called when the selected artboard changes, e.g. to highlight it in the artboard list. */
  onSelectionChange(artboardId: string | null): void;
}

interface LoadedArtboard {
  scene: ArtboardScene;
  index: Map<string, IndexedNode>;
  /** Layer boxes in artboard pixels, measured once (see boxesOf). */
  boxes: Map<string, Box> | null;
}

/**
 * Board mode: every artboard of a page at its file position in one zoom/pan space. Only artboards near the stage
 * are drawn in full (and only when large enough on screen); the rest are placeholders, so big files stay responsive.
 */
export class BoardView {
  private readonly deps: BoardDeps;
  private pages: BoardPage[] = [];
  private pageIndex = 0;
  private itemsById = new Map<string, BoardItem>();
  private readonly loaded = new Map<string, LoadedArtboard>();
  private readonly failed = new Map<string, string>();
  private readonly requested = new Set<string>();
  private requestsInFlight = 0;
  private readonly elements = new Map<string, HTMLDivElement>();
  private readonly titleElements = new Map<string, HTMLDivElement>();
  private readonly detailed = new Set<string>();
  private wanted = new Set<string>();
  private renderQueue: string[] = [];
  private readonly savedViews = new Map<number, ViewState>();
  private selected: BoardSelection | null = null;
  private hovered: BoardSelection | null = null;
  private layerTreeArtboard: string | null = null;
  private active = false;
  private frame = 0;
  private fontsLoaded = false;
  private firstPaintPending = false;

  constructor(deps: BoardDeps) {
    this.deps = deps;
    void document.fonts.ready.then(() => {
      this.fontsLoaded = true;
      this.schedule();
    });
  }

  get isActive(): boolean {
    return this.active;
  }

  get pageNames(): string[] {
    return this.pages.map((page) => page.name);
  }

  get currentPage(): number {
    return this.pageIndex;
  }

  get artboardCount(): number {
    return this.pages[this.pageIndex]?.items.length ?? 0;
  }

  get selectedArtboard(): string | null {
    return this.selected?.artboard ?? null;
  }

  /** A converted scene the board already holds, so the single-artboard view can reuse it. */
  sceneOf(id: string): ArtboardScene | undefined {
    return this.loaded.get(id)?.scene;
  }

  pageOf(id: string): number {
    return this.pages.findIndex((page) => page.items.some((item) => item.id === id));
  }

  setDocument(artboards: readonly ArtboardSummary[], layout: BoardLayout, page?: number): void {
    this.pages = buildPages(artboards, layout);
    this.loaded.clear();
    this.failed.clear();
    this.requested.clear();
    this.requestsInFlight = 0;
    this.savedViews.clear();
    this.selected = null;
    this.hovered = null;
    this.layerTreeArtboard = null;
    this.pageIndex = Math.min(Math.max(0, page ?? this.pageIndex), Math.max(0, this.pages.length - 1));
    if (this.active) {
      this.mount(true);
      this.refreshSelection();
    }
  }

  /** Adds a scene converted elsewhere (single-artboard view) to the cache. */
  addScene(scene: ArtboardScene): void {
    if (!this.loaded.has(scene.id)) {
      this.loaded.set(scene.id, { scene, index: indexScene(scene), boxes: null });
    }
  }

  activate(): void {
    this.active = true;
    this.deps.titles.hidden = false;
    this.firstPaintPending = true;
    performance.mark('dv-board-activate');
    this.layerTreeArtboard = null;
    delete this.deps.layers.dataset['board'];
    this.mount(!this.savedViews.has(this.pageIndex));
    this.refreshSelection();
  }

  deactivate(): void {
    if (!this.active) {
      return;
    }
    this.saveView();
    this.active = false;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.deps.canvas.innerHTML = '';
    this.deps.titles.innerHTML = '';
    this.deps.titles.hidden = true;
    this.elements.clear();
    this.titleElements.clear();
    this.detailed.clear();
    this.renderQueue = [];
  }

  setPage(index: number): void {
    if (index === this.pageIndex || !this.pages[index]) {
      return;
    }
    this.saveView();
    this.pageIndex = index;
    this.selected = null;
    this.hovered = null;
    this.mount(!this.savedViews.has(index));
    this.refreshSelection();
  }

  fit(): void {
    this.deps.viewport.fitAll();
  }

  onScenes(scenes: ArtboardScene[], failed: { id: string; message: string }[]): void {
    this.requestsInFlight = Math.max(0, this.requestsInFlight - 1);
    for (const scene of scenes) {
      this.addScene(scene);
      this.paintPlaceholder(scene.id);
    }
    for (const { id, message } of failed) {
      this.failed.set(id, message);
      this.paintPlaceholder(id);
    }
    if (this.selected && scenes.some((scene) => scene.id === this.selected?.artboard)) {
      this.refreshSelection();
    }
    this.schedule();
  }

  onViewportChange(): void {
    this.schedule();
  }

  /** The board selection under a pointer target, or null over empty canvas. */
  hit(target: EventTarget | null): BoardSelection | null {
    const element = target instanceof Element ? target : null;
    const owner = element?.closest<HTMLElement>('.dv-board-item, .dv-board-title');
    const artboard = owner?.dataset['artboard'];
    if (!element || !owner || !artboard) {
      return null;
    }
    const layer = owner.classList.contains('dv-board-item') ? element.closest<SVGGElement>('g[data-key]') : null;
    return { artboard, key: layer?.dataset['key'] ?? '' };
  }

  pointerMove(target: EventTarget | null): void {
    this.setHovered(this.hit(target));
  }

  click(target: EventTarget | null): void {
    this.select(this.hit(target));
  }

  /** Selects a layer of the artboard shown in the layer panel ('' selects the artboard). */
  selectLayer(key: string | null, options: { reveal?: boolean } = {}): void {
    const artboard = this.layerTreeArtboard ?? this.selected?.artboard;
    if (!artboard) {
      return;
    }
    const selection = key === null ? null : { artboard, key };
    this.select(selection);
    const box = selection ? this.boardBox(selection) : null;
    if (options.reveal && box) {
      this.deps.viewport.reveal(box);
    }
  }

  hoverLayer(key: string | null): void {
    const artboard = this.layerTreeArtboard;
    this.setHovered(key !== null && artboard ? { artboard, key } : null);
  }

  /** Esc: the parent layer, then the artboard, then nothing. */
  escape(): void {
    const selection = this.selected;
    if (!selection) {
      return;
    }
    if (!selection.key) {
      this.select(null);
      return;
    }
    const parent = this.loaded.get(selection.artboard)?.index.get(selection.key)?.parentKey ?? '';
    this.select({ artboard: selection.artboard, key: parent });
  }

  /** Shows an artboard (switching page if needed) and selects it. */
  flyTo(id: string): void {
    const page = this.pageOf(id);
    if (page < 0) {
      return;
    }
    if (page !== this.pageIndex) {
      this.setPage(page);
    }
    const item = this.itemsById.get(id);
    if (item) {
      this.deps.viewport.fitBox(item);
    }
    this.select({ artboard: id, key: '' });
  }

  private select(selection: BoardSelection | null): void {
    const previous = this.selected?.artboard ?? null;
    this.selected = selection;
    this.refreshSelection();
    if ((selection?.artboard ?? null) !== previous) {
      this.deps.onSelectionChange(selection?.artboard ?? null);
    }
  }

  private setHovered(selection: BoardSelection | null): void {
    if (!sameSelection(selection, this.hovered)) {
      this.hovered = selection;
      this.drawOverlay();
    }
  }

  private mount(fit: boolean): void {
    const page = this.pages[this.pageIndex];
    const { canvas, titles, viewport } = this.deps;
    canvas.innerHTML = '';
    titles.innerHTML = '';
    this.elements.clear();
    this.titleElements.clear();
    this.detailed.clear();
    this.renderQueue = [];
    this.itemsById = new Map((page?.items ?? []).map((item) => [item.id, item]));
    if (!page) {
      return;
    }
    const board = document.createElement('div');
    board.className = 'dv-board';
    board.style.width = `${page.width}px`;
    board.style.height = `${page.height}px`;
    for (const item of page.items) {
      const element = document.createElement('div');
      element.className = 'dv-board-item placeholder';
      element.dataset['artboard'] = item.id;
      element.dataset['slot'] = String(this.elements.size);
      element.style.left = `${item.x}px`;
      element.style.top = `${item.y}px`;
      element.style.width = `${item.width}px`;
      element.style.height = `${item.height}px`;
      board.append(element);
      this.elements.set(item.id, element);
      this.paintPlaceholder(item.id);
    }
    canvas.append(board);
    viewport.setContent(page.width, page.height);
    const saved = this.savedViews.get(this.pageIndex);
    if (fit || !saved) {
      viewport.fitAll();
    } else {
      viewport.setView(saved.x, saved.y, saved.zoom);
    }
    this.schedule();
  }

  private saveView(): void {
    const { x, y, zoom } = this.deps.viewport;
    this.savedViews.set(this.pageIndex, { x, y, zoom });
  }

  private paintPlaceholder(id: string): void {
    const element = this.elements.get(id);
    if (!element || this.detailed.has(id)) {
      return;
    }
    const background = this.loaded.get(id)?.scene.background;
    element.style.backgroundColor = background ? toCssColor(background) : '';
    const failure = this.failed.get(id);
    element.classList.toggle('failed', failure !== undefined);
    element.title = failure ?? '';
  }

  private schedule(): void {
    if (this.active && !this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.update();
      });
    }
  }

  private update(): void {
    const page = this.pages[this.pageIndex];
    if (!this.active || !page) {
      return;
    }
    const { viewport } = this.deps;
    const area = visibleRect(viewport, viewport.stageWidth, viewport.stageHeight, RENDER_MARGIN);
    this.wanted = new Set(planDetail(page.items, area, viewport.zoom));
    for (const id of [...this.detailed]) {
      if (!this.wanted.has(id)) {
        this.demote(id);
      }
    }
    const toLoad: string[] = [];
    for (const id of this.wanted) {
      if (this.detailed.has(id) || this.failed.has(id)) {
        continue;
      }
      if (this.loaded.has(id)) {
        if (!this.renderQueue.includes(id)) {
          this.renderQueue.push(id);
        }
      } else if (!this.requested.has(id)) {
        toLoad.push(id);
      }
    }
    this.requestScenes(toLoad);
    if (this.fontsLoaded) {
      this.drainRenderQueue();
    }
    this.updateTitles(page);
    this.drawOverlay();
    if (this.firstPaintPending) {
      this.firstPaintPending = false;
      performance.mark('dv-board-first-paint');
    }
    if (this.renderQueue.length) {
      this.schedule();
    }
  }

  private requestScenes(ids: string[]): void {
    while (ids.length && this.requestsInFlight < MAX_REQUESTS_IN_FLIGHT) {
      const batch = ids.splice(0, LOAD_BATCH);
      batch.forEach((id) => this.requested.add(id));
      this.requestsInFlight++;
      this.deps.requestScenes(batch);
    }
  }

  private drainRenderQueue(): void {
    const started = performance.now();
    while (this.renderQueue.length && performance.now() - started < RENDER_BUDGET_MS) {
      const id = this.renderQueue.shift();
      if (id && this.wanted.has(id) && !this.detailed.has(id)) {
        this.renderDetail(id);
      }
    }
  }

  private renderDetail(id: string): void {
    const element = this.elements.get(id);
    const entry = this.loaded.get(id);
    if (!element || !entry) {
      return;
    }
    // Every artboard SVG shares the document, so gradient/clip ids get a per-artboard prefix.
    element.innerHTML = renderArtboardSvg(entry.scene, this.deps.imageUrl, `dv${element.dataset['slot'] ?? ''}`);
    element.classList.remove('placeholder');
    this.detailed.add(id);
    if (this.selected?.artboard === id && !entry.boxes) {
      this.refreshSelection();
    }
  }

  /**
   * Layer boxes are measured the first time an artboard is hovered or selected while drawn in full, not when it is
   * drawn: measuring forces layout of the whole board, which would stall panning across many artboards.
   */
  private boxesOf(id: string): Map<string, Box> | null {
    const entry = this.loaded.get(id);
    if (!entry) {
      return null;
    }
    if (!entry.boxes && this.detailed.has(id)) {
      const svg = this.elements.get(id)?.querySelector<SVGSVGElement>('svg.dv-artboard');
      if (svg) {
        entry.boxes = measureLayers(svg, entry.scene).boxes;
      }
    }
    return entry.boxes;
  }

  private demote(id: string): void {
    const element = this.elements.get(id);
    this.detailed.delete(id);
    if (element) {
      element.innerHTML = '';
      element.classList.add('placeholder');
      this.paintPlaceholder(id);
    }
  }

  /** Titles live in screen space so they keep their size at any zoom. */
  private updateTitles(page: BoardPage): void {
    const { viewport, titles } = this.deps;
    const area = visibleRect(viewport, viewport.stageWidth, viewport.stageHeight);
    const shown = new Set<string>();
    for (const item of page.items) {
      const width = item.width * viewport.zoom;
      if (width < TITLE_MIN_SCREEN_WIDTH || !overlaps(item, area)) {
        continue;
      }
      shown.add(item.id);
      let title = this.titleElements.get(item.id);
      if (!title) {
        title = document.createElement('div');
        title.className = 'dv-board-title';
        title.dataset['artboard'] = item.id;
        title.textContent = item.title;
        title.title = item.title;
        titles.append(title);
        this.titleElements.set(item.id, title);
      }
      const at = viewport.toScreen(item.x, item.y);
      title.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y - TITLE_OFFSET_Y)}px)`;
      title.style.maxWidth = `${Math.floor(width)}px`;
      title.classList.toggle('active', this.selected?.artboard === item.id);
    }
    for (const [id, title] of this.titleElements) {
      if (!shown.has(id)) {
        title.remove();
        this.titleElements.delete(id);
      }
    }
  }

  /** A selection's box in board pixels, or null while its artboard has not been measured. */
  private boardBox(selection: BoardSelection | null): Box | null {
    const item = selection ? this.itemsById.get(selection.artboard) : undefined;
    if (!selection || !item) {
      return null;
    }
    if (!selection.key) {
      return item;
    }
    const box = this.boxesOf(selection.artboard)?.get(selection.key);
    return box ? offsetBox(box, item.x, item.y) : null;
  }

  private drawOverlay(): void {
    if (!this.active) {
      return;
    }
    const selectedBox = this.boardBox(this.selected);
    const hoveredBox = sameSelection(this.hovered, this.selected) ? null : this.boardBox(this.hovered);
    const guides: Guide[] = selectedBox && hoveredBox ? measureBetween(selectedBox, hoveredBox) : [];
    drawOverlay(this.deps.overlay, this.deps.viewport, { selected: selectedBox, hovered: hoveredBox, guides });
  }

  private refreshSelection(): void {
    const selection = this.selected;
    const entry = selection ? this.loaded.get(selection.artboard) : undefined;
    this.renderLayerPanel(selection?.artboard ?? null);
    if (!selection) {
      this.deps.inspector.innerHTML = this.boardSummary();
    } else if (!entry) {
      const item = this.itemsById.get(selection.artboard);
      const failure = this.failed.get(selection.artboard);
      this.deps.inspector.innerHTML =
        `<div class="insp-header"><div class="insp-title">${escapeHtml(item?.title ?? '')}</div><div class="insp-kind">Artboard</div></div>` +
        `<p class="hint">${escapeHtml(failure ?? 'Loading…')}</p>`;
    } else {
      const node = selection.key ? (entry.index.get(selection.key)?.node ?? null) : null;
      this.deps.inspector.innerHTML = renderInspector({
        scene: entry.scene,
        node,
        box: node ? (this.boxesOf(selection.artboard)?.get(node.key) ?? null) : null,
        ancestors: node ? ancestorsOf(entry.index, node.key) : [],
        layerCount: entry.index.size,
      });
    }
    this.highlightLayerRow(selection?.key ?? null);
    for (const [id, title] of this.titleElements) {
      title.classList.toggle('active', selection?.artboard === id);
    }
    this.drawOverlay();
  }

  private renderLayerPanel(artboard: string | null): void {
    const entry = artboard ? this.loaded.get(artboard) : undefined;
    const target = entry ? artboard : null;
    if (target === this.layerTreeArtboard && (target !== null || this.deps.layers.dataset['board'] === 'empty')) {
      return;
    }
    this.layerTreeArtboard = target;
    this.deps.layers.dataset['board'] = entry ? 'tree' : 'empty';
    this.deps.layers.innerHTML = entry
      ? renderLayerTree(entry.scene.children)
      : '<p class="hint">Select an artboard to see its layers.</p>';
  }

  private highlightLayerRow(key: string | null): void {
    const { layers } = this.deps;
    for (const row of layers.querySelectorAll('.layer-row.selected')) {
      row.classList.remove('selected');
    }
    if (!key) {
      return;
    }
    const row = layers.querySelector(`.layer-row[data-key="${CSS.escape(key)}"]`);
    if (row) {
      row.classList.add('selected');
      for (let li = row.parentElement?.parentElement?.closest('li.layer'); li; li = li.parentElement?.closest('li.layer')) {
        li.classList.remove('collapsed');
      }
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  private boardSummary(): string {
    const page = this.pages[this.pageIndex];
    return (
      `<div class="insp-header"><div class="insp-title">${escapeHtml(page?.name ?? '')}</div><div class="insp-kind">Board</div></div>` +
      `<section class="insp-section"><h3>Artboards</h3><div class="prop-text">${page?.items.length ?? 0}</div></section>` +
      (page ? `<section class="insp-section"><h3>Size</h3><div class="prop-text">${fmt(page.width)} × ${fmt(page.height)}</div></section>` : '') +
      '<p class="hint">Click a layer on any artboard to inspect it; hover another layer or artboard to measure. Double-click an artboard to open it on its own.</p>'
    );
  }
}

function sameSelection(a: BoardSelection | null, b: BoardSelection | null): boolean {
  return a === b || (a !== null && b !== null && a.artboard === b.artboard && a.key === b.key);
}

function ancestorsOf(index: Map<string, IndexedNode>, key: string): SceneNode[] {
  const chain: SceneNode[] = [];
  for (let parent = index.get(key)?.parentKey ?? null; parent !== null; parent = index.get(parent)?.parentKey ?? null) {
    const entry = index.get(parent);
    if (!entry) {
      break;
    }
    chain.unshift(entry.node);
  }
  return chain;
}
