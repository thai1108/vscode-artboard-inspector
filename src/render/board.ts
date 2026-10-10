import type { BoardLayout } from '../scene/board.ts';
import type { ArtboardSummary } from '../scene/scene.ts';
import { bottom, right, union, type Box } from './geometry.ts';

/** An artboard on a board page, in board pixels (the page's top-left artboard corner is the origin). */
export interface BoardItem extends Box {
  id: string;
  title: string;
}

export interface BoardPage {
  name: string;
  items: BoardItem[];
  width: number;
  height: number;
  /** File coordinates of the board origin. */
  originX: number;
  originY: number;
}

export interface ViewState {
  x: number;
  y: number;
  zoom: number;
}

/** Below 100% zoom, artboards smaller than this on screen are drawn as cheap placeholders instead of full SVG. */
export const DETAIL_MIN_SCREEN_PX = 160;
/** Upper bound on artboards drawn in full at the same time. */
export const MAX_DETAILED = 48;
const UNPLACED_GAP = 100;

/** Groups artboards into pages at their file positions; artboards the layout does not place go in a row below. */
export function buildPages(artboards: readonly ArtboardSummary[], layout: BoardLayout): BoardPage[] {
  const placements = new Map(layout.placements.map((placement) => [placement.id, placement]));
  const names = layout.pages.length ? layout.pages : ['Canvas'];
  const pages: BoardItem[][] = names.map(() => []);
  const unplaced: ArtboardSummary[] = [];
  for (const artboard of artboards) {
    const placement = placements.get(artboard.id);
    const page = placement ? pages[placement.page] : undefined;
    if (!placement || !page || !Number.isFinite(placement.x) || !Number.isFinite(placement.y)) {
      unplaced.push(artboard);
      continue;
    }
    page.push({ id: artboard.id, title: placement.title || artboard.name, x: placement.x, y: placement.y, width: artboard.width, height: artboard.height });
  }
  const first = pages[0] ?? [];
  const placed = union(first);
  let x = placed?.x ?? 0;
  const y = placed ? bottom(placed) + UNPLACED_GAP : 0;
  for (const artboard of unplaced) {
    first.push({ id: artboard.id, title: artboard.name, x, y, width: artboard.width, height: artboard.height });
    x += artboard.width + UNPLACED_GAP;
  }

  return pages.flatMap((items, index) => {
    const bounds = union(items);
    if (!bounds) {
      return [];
    }
    return [
      {
        name: names[index] ?? `Page ${index + 1}`,
        originX: bounds.x,
        originY: bounds.y,
        width: bounds.width,
        height: bounds.height,
        items: items.map((item) => ({ ...item, x: item.x - bounds.x, y: item.y - bounds.y })),
      },
    ];
  });
}

/** Board-space rectangle shown in a stage of the given size, grown by `margin` × its size on every side. */
export function visibleRect(view: ViewState, width: number, height: number, margin = 0): Box {
  const w = width / view.zoom;
  const h = height / view.zoom;
  return { x: -view.x / view.zoom - w * margin, y: -view.y / view.zoom - h * margin, width: w * (1 + 2 * margin), height: h * (1 + 2 * margin) };
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x <= right(b) && b.x <= right(a) && a.y <= bottom(b) && b.y <= bottom(a);
}

/**
 * At 100% and above every visible artboard is drawn in full (only a stage's worth of them can be on screen, and
 * MAX_DETAILED still caps them), so small artboards such as icons do not stay placeholders when zoomed in.
 */
export function showsDetail(item: Box, zoom: number): boolean {
  return zoom >= 1 || Math.max(item.width, item.height) * zoom >= DETAIL_MIN_SCREEN_PX;
}

/** Artboards to draw in full: inside `area`, large enough on screen, nearest to the area's centre first, capped. */
export function planDetail(items: readonly BoardItem[], area: Box, zoom: number, maxDetailed = MAX_DETAILED): string[] {
  const cx = area.x + area.width / 2;
  const cy = area.y + area.height / 2;
  const distance = (item: BoardItem) => Math.hypot(item.x + item.width / 2 - cx, item.y + item.height / 2 - cy);
  return items
    .filter((item) => overlaps(item, area) && showsDetail(item, zoom))
    .sort((p, q) => distance(p) - distance(q))
    .slice(0, maxDetailed)
    .map((item) => item.id);
}

export function offsetBox(box: Box, dx: number, dy: number): Box {
  return { x: box.x + dx, y: box.y + dy, width: box.width, height: box.height };
}
