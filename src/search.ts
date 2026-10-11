// Search over layer names and text content of every artboard. The index is built in the extension host, once per
// opened file, so the webview only ever receives a capped list of hits.
import type { DesignDocument } from './document.ts';
import type { ArtboardScene, SceneNode } from './scene/scene.ts';

/** Caps that keep the index of a huge or hostile file bounded; real files stay far below them. */
export const SEARCH_LIMITS = {
  /** Characters of a layer name that are indexed. */
  nameLength: 500,
  /** Characters of a text layer's content that are indexed. */
  textLength: 5_000,
  /** Indexed layers in the whole file. */
  entries: 250_000,
  /** Indexed characters (names and text) in the whole file. */
  totalChars: 5_000_000,
};

export type SearchLimits = typeof SEARCH_LIMITS;

/** Longest stretch of indexing between yields, so the extension host keeps serving other work. */
const SLICE_MS = 20;
const EXCERPT_LENGTH = 80;
/** Width before a match (in Latin-letter units) shown without cutting; the sidebar fits about 30. */
const EXCERPT_LEAD = 24;
/** Width kept before the match when the start is cut. */
const EXCERPT_CONTEXT = 12;
/** Characters drawn about twice as wide as Latin letters: CJK, kana, hangul, full-width forms, emoji. */
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f000}-\u{3ffff}]/u;

/** Anything outside printable ASCII and whitespace may change under NFKC. */
const NEEDS_NFKC = /[^\s!-~]/;
/** A whitespace run, or one character with the marks that compose with it (incl. half-width kana voicing marks). */
const CHUNK = /\s+|.[\p{M}\uFF9E\uFF9F]*/gsu;

interface SearchEntry {
  artboard: string;
  key: string;
  name: string;
  /** Content of a text layer, '' for other layers. */
  text: string;
  nameKey: string;
  textKey: string;
}

/** Plain JSON, so the browser preview can store it. */
export interface SearchIndex {
  entries: SearchEntry[];
  /** Artboards indexed in full; fewer than the file has when some fail to convert or a cap is reached. */
  searched: number;
}

/** Part of a layer name or text around the first match; `match` is a [start, end) range in `text`. */
export interface Excerpt {
  text: string;
  match: [number, number] | null;
}

export interface SearchHit {
  artboard: string;
  key: string;
  /** The layer name (the content for unnamed text layers). */
  name: Excerpt;
  /** Text content around the match, when the content matched and differs from the name. */
  text: Excerpt | null;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Matching layers, including those beyond the hit limit. */
  total: number;
  searched: number;
}

/**
 * The form names, text and queries are compared in: NFKC (full-width Latin becomes half-width, half-width katakana
 * full-width), lower case, whitespace runs as one space. Normalized chunk by chunk so a match can be mapped back to
 * the original characters (see locate).
 */
export function normalizeForSearch(value: string): string {
  if (!NEEDS_NFKC.test(value)) {
    return value.toLowerCase().replace(/\s+/g, ' ');
  }
  let normalized = '';
  for (const [chunk] of value.matchAll(CHUNK)) {
    normalized += normalizeChunk(chunk);
  }
  return normalized;
}

function normalizeChunk(chunk: string): string {
  return /^\s/.test(chunk) ? ' ' : chunk.normalize('NFKC').toLowerCase();
}

/** Converts every artboard once and keeps its layer names and text, in layer-panel order (topmost first). */
export async function buildSearchIndex(design: Pick<DesignDocument, 'artboards' | 'scene'>, limits: SearchLimits = SEARCH_LIMITS): Promise<SearchIndex> {
  const entries: SearchEntry[] = [];
  let chars = 0;
  let searched = 0;
  const full = () => entries.length >= limits.entries || chars >= limits.totalChars;
  /** False when a cap stopped the walk before the last layer. */
  const walk = (artboard: string, nodes: SceneNode[]): boolean => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (full()) {
        return false;
      }
      const node = nodes[i] as SceneNode;
      const name = clip(node.name, limits.nameLength);
      const text = node.kind === 'text' ? clip(node.content, limits.textLength) : '';
      if (name || text) {
        entries.push({ artboard, key: node.key, name, text, nameKey: normalizeForSearch(name), textKey: normalizeForSearch(text) });
        chars += name.length + text.length;
      }
      if (node.kind === 'group' && !walk(artboard, node.children)) {
        return false;
      }
    }
    return true;
  };

  let sliceStart = performance.now();
  for (const { id } of design.artboards) {
    if (full()) {
      break;
    }
    let scene: ArtboardScene;
    try {
      scene = design.scene(id);
    } catch {
      // The error is shown when the artboard itself is opened; here it is only left out of the search.
      continue;
    }
    if (walk(id, scene.children)) {
      searched++;
    }
    if (performance.now() - sliceStart > SLICE_MS) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }
  return { entries, searched };
}

/** Layers whose name or text contains `query`, in index order; at most `limit` hits are returned. */
export function search(index: SearchIndex, query: string, limit: number): SearchResult {
  const needle = normalizeForSearch(query).trim();
  const hits: SearchHit[] = [];
  let total = 0;
  if (needle) {
    for (const entry of index.entries) {
      const textMatched = entry.textKey.includes(needle);
      if (!textMatched && !entry.nameKey.includes(needle)) {
        continue;
      }
      total++;
      if (hits.length < limit) {
        const label = entry.name || entry.text;
        hits.push({
          artboard: entry.artboard,
          key: entry.key,
          name: excerpt(label, needle),
          text: textMatched && flatten(entry.text) !== flatten(label) ? excerpt(entry.text, needle) : null,
        });
      }
    }
  }
  return { hits, total, searched: index.searched };
}

/** One line of `value` around the first match of `needle` (already normalized), marked with "…" where cut. */
export function excerpt(value: string, needle: string, length = EXCERPT_LENGTH): Excerpt {
  const flat = flatten(value);
  const match = locate(flat, needle);
  if (!match) {
    const end = codePointBoundary(flat, Math.min(flat.length, length));
    return { text: flat.slice(0, end) + (end < flat.length ? '…' : ''), match: null };
  }
  const start = excerptStart(flat, match[0]);
  const end = codePointBoundary(flat, Math.min(flat.length, Math.max(match[1], start + length)));
  const prefix = start > 0 ? '…' : '';
  const shift = prefix.length - start;
  return { text: prefix + flat.slice(start, end) + (end < flat.length ? '…' : ''), match: [match[0] + shift, match[1] + shift] };
}

/** Where to cut the text before a match at `at`: nowhere when it fits the sidebar, else shortly before the match. */
function excerptStart(flat: string, at: number): number {
  const before = Array.from(flat.slice(0, at));
  const widths = before.map((char) => (WIDE.test(char) ? 2 : 1));
  if (widths.reduce((sum, width) => sum + width, 0) <= EXCERPT_LEAD) {
    return 0;
  }
  let start = at;
  for (let i = before.length - 1, width = 0; i >= 0 && width < EXCERPT_CONTEXT; i--) {
    width += widths[i] ?? 1;
    start -= before[i]?.length ?? 1;
  }
  // Rather start at the beginning of a word than in its middle, when the word starts close by.
  const space = flat.lastIndexOf(' ', start);
  return space >= 0 && start - space <= EXCERPT_CONTEXT / 2 ? space + 1 : start;
}

/** The [start, end) range of `value` whose normalized form is the first occurrence of `needle`. */
function locate(value: string, needle: string): [number, number] | null {
  if (!needle) {
    return null;
  }
  if (!NEEDS_NFKC.test(value)) {
    // Lower-casing printable ASCII keeps every offset (whitespace is already single spaces here).
    const at = value.toLowerCase().indexOf(needle);
    return at < 0 ? null : [at, at + needle.length];
  }
  let normalized = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (const chunk of value.matchAll(CHUNK)) {
    const piece = normalizeChunk(chunk[0]);
    const from = Math.max(0, normalized.length - needle.length + 1);
    for (let i = 0; i < piece.length; i++) {
      starts.push(chunk.index);
      ends.push(chunk.index + chunk[0].length);
    }
    normalized += piece;
    // The earliest match is complete as soon as the piece that ends it is added.
    const at = normalized.indexOf(needle, from);
    if (at >= 0) {
      return [starts[at] ?? 0, ends[at + needle.length - 1] ?? value.length];
    }
  }
  return null;
}

function flatten(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, codePointBoundary(value, max));
}

/** Moves `index` off the middle of a surrogate pair. */
function codePointBoundary(value: string, index: number): number {
  const code = value.charCodeAt(index);
  return index > 0 && code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}
