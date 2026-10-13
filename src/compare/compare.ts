// Compares two versions of a design file artboard by artboard. Runs in the extension host like the search index:
// every artboard of both files is converted once, in slices, and only a compact result is kept.
import type { DesignDocument } from '../document.ts';
import type { ArtboardScene, ArtboardSummary, SceneNode } from '../scene/scene.ts';
import { DIFF_LIMITS, diffScenes, type DiffOptions, type LayerChange, type LayerCounts, type PropertyChange, type SceneDiff } from './diff.ts';
import { matchArtboards, type MatchedBy } from './match.ts';

/** Caps that keep comparing a huge or hostile pair of files bounded; real files stay far below them. */
export const COMPARE_LIMITS = {
  /** Layers compared in each file, over all artboards; later artboards are left out. */
  layers: 250_000,
  /** Layer changes listed over all artboards (each artboard also has its own cap, DIFF_LIMITS). */
  changes: 50_000,
  /** Characters of values kept over all artboards. */
  chars: 5_000_000,
};

export type CompareLimits = typeof COMPARE_LIMITS;

/** Longest stretch of comparing between yields, so the extension host keeps serving other work. */
const SLICE_MS = 20;

export type ArtboardStatus = 'added' | 'removed' | 'changed' | 'unchanged' | 'skipped';

export interface ArtboardDiff extends SceneDiff {
  beforeId: string | null;
  afterId: string | null;
  /** Place in each version's artboard list. */
  beforeIndex: number | null;
  afterIndex: number | null;
  /** The later name and size when the artboard is in both versions. */
  name: string;
  width: number;
  height: number;
  status: ArtboardStatus;
  matchedBy: MatchedBy | null;
  /** Why a matched artboard was not compared. */
  note?: string;
}

export interface DocumentDiff {
  /** The later version's artboards in its order, then the removed ones. */
  artboards: ArtboardDiff[];
  /** True when the layer cap left artboards out. */
  truncated: boolean;
  matched: { byId: number; byName: number };
}

type Source = Pick<DesignDocument, 'artboards' | 'scene'>;

export interface CompareOptions extends DiffOptions {
  compareLimits?: CompareLimits;
}

/** Diffs every artboard of `after` against its match in `before` (by id, then by unique name). */
export async function compareDocuments(before: Source, after: Source, options: CompareOptions = {}): Promise<DocumentDiff> {
  const limits = options.compareLimits ?? COMPARE_LIMITS;
  const diffLimits = options.limits ?? DIFF_LIMITS;
  const result: DocumentDiff = { artboards: [], truncated: false, matched: { byId: 0, byName: 0 } };
  let beforeLayers = 0;
  let afterLayers = 0;
  let changesLeft = limits.changes;
  let charsLeft = limits.chars;
  let sliceStart = performance.now();
  for (const pairing of matchArtboards(before.artboards, after.artboards)) {
    const beforeArtboard = pairing.before === null ? undefined : before.artboards[pairing.before];
    const afterArtboard = pairing.after === null ? undefined : after.artboards[pairing.after];
    const diff = emptyDiff(beforeArtboard, afterArtboard, pairing.before, pairing.after, pairing.matchedBy);
    result.artboards.push(diff);
    if (!beforeArtboard || !afterArtboard) {
      continue;
    }
    if (beforeLayers >= limits.layers || afterLayers >= limits.layers) {
      result.truncated = true;
      diff.status = 'skipped';
      diff.note = `Not compared: the files have more than ${limits.layers.toLocaleString('en-US')} layers`;
      continue;
    }
    let scenes: [ArtboardScene, ArtboardScene];
    try {
      scenes = [before.scene(beforeArtboard.id), after.scene(afterArtboard.id)];
    } catch (error) {
      diff.status = 'skipped';
      diff.note = `Not compared: ${(error as Error).message}`;
      continue;
    }
    beforeLayers += countLayers(scenes[0].children);
    afterLayers += countLayers(scenes[1].children);
    const sceneDiff = diffScenes(scenes[0], scenes[1], {
      ...options,
      limits: { ...diffLimits, changes: Math.min(diffLimits.changes, changesLeft), artboardChars: Math.min(diffLimits.artboardChars, charsLeft) },
    });
    changesLeft -= sceneDiff.changes.length;
    charsLeft -= charsOf(sceneDiff.changes);
    Object.assign(diff, sceneDiff);
    diff.status = diff.props.length || diff.counts.added || diff.counts.removed || diff.counts.changed ? 'changed' : 'unchanged';
    result.matched.byId += diff.matched.byId;
    result.matched.byName += diff.matched.byName;
    if (performance.now() - sliceStart > SLICE_MS) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }
  return result;
}

function emptyDiff(before: ArtboardSummary | undefined, after: ArtboardSummary | undefined, beforeIndex: number | null, afterIndex: number | null, matchedBy: MatchedBy | null): ArtboardDiff {
  return {
    beforeId: before?.id ?? null,
    afterId: after?.id ?? null,
    beforeIndex: before ? beforeIndex : null,
    afterIndex: after ? afterIndex : null,
    name: after?.name ?? before?.name ?? '',
    width: after?.width ?? before?.width ?? 0,
    height: after?.height ?? before?.height ?? 0,
    status: !after ? 'removed' : !before ? 'added' : 'unchanged',
    matchedBy,
    props: [],
    changes: [],
    counts: { added: 0, removed: 0, changed: 0 },
    truncated: false,
    pairs: [],
    matched: { byId: 0, byName: 0 },
  };
}

function charsOf(changes: LayerChange[]): number {
  return changes.reduce((sum, change) => sum + change.props.reduce((chars, prop) => chars + prop.before.length + prop.after.length, change.name.length), 0);
}

function countLayers(nodes: SceneNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + (node.kind === 'group' ? countLayers(node.children) : 0), 0);
}

const INVERTED_STATUS = { added: 'removed', removed: 'added', changed: 'changed', unchanged: 'unchanged', skipped: 'skipped' } as const;

function invertProps(props: PropertyChange[]): PropertyChange[] {
  return props.map(({ label, before, after }) => ({ label, before: after, after: before }));
}

function invertChange(change: LayerChange): LayerChange {
  return {
    status: INVERTED_STATUS[change.status],
    beforeKey: change.afterKey,
    afterKey: change.beforeKey,
    name: change.name,
    beforeBox: change.afterBox,
    afterBox: change.beforeBox,
    props: invertProps(change.props),
  };
}

function invertCounts(counts: LayerCounts): LayerCounts {
  return { added: counts.removed, removed: counts.added, changed: counts.changed };
}

/** The same diff read the other way round: the later version becomes the earlier one. */
export function invertArtboardDiff(diff: ArtboardDiff): ArtboardDiff {
  return {
    ...diff,
    beforeId: diff.afterId,
    afterId: diff.beforeId,
    beforeIndex: diff.afterIndex,
    afterIndex: diff.beforeIndex,
    status: INVERTED_STATUS[diff.status],
    props: invertProps(diff.props),
    changes: diff.changes.map(invertChange),
    counts: invertCounts(diff.counts),
    pairs: diff.pairs.map(([before, after]) => [after, before]),
  };
}

/** The diff as seen with the files swapped (`swapped`), in the then-later version's artboard order. */
export function orientDiff(diff: DocumentDiff, swapped: boolean): DocumentDiff {
  if (!swapped) {
    return diff;
  }
  const artboards = diff.artboards.map(invertArtboardDiff);
  const rank = (index: number | null) => index ?? Number.MAX_SAFE_INTEGER;
  artboards.sort((p, q) => rank(p.afterIndex) - rank(q.afterIndex) || rank(p.beforeIndex) - rank(q.beforeIndex));
  return { ...diff, artboards };
}

/** One artboard in the compare summary the webview lists: no layer details. */
export interface ArtboardDiffSummary {
  beforeId: string | null;
  afterId: string | null;
  name: string;
  width: number;
  height: number;
  status: ArtboardStatus;
  matchedBy: MatchedBy | null;
  counts: LayerCounts;
  note?: string;
}

export interface CompareSummary {
  /** File names of the earlier and the later version. */
  beforeName: string;
  afterName: string;
  /** The opened file is the earlier version. */
  swapped: boolean;
  /** Changes whenever the comparison is redone, so the webview drops what it holds of an older one. */
  generation: number;
  artboards: ArtboardDiffSummary[];
  truncated: boolean;
  matched: { byId: number; byName: number };
}

/** The summary of an oriented diff (see orientDiff). */
export function summarize(diff: DocumentDiff, names: { before: string; after: string }, swapped: boolean, generation: number): CompareSummary {
  return {
    beforeName: names.before,
    afterName: names.after,
    swapped,
    generation,
    artboards: diff.artboards.map(({ beforeId, afterId, name, width, height, status, matchedBy, counts, note }) => ({
      beforeId,
      afterId,
      name,
      width,
      height,
      status,
      matchedBy,
      counts,
      ...(note ? { note } : {}),
    })),
    truncated: diff.truncated,
    matched: diff.matched,
  };
}

/** The diff of the artboard with `id` on `side` of an oriented diff. */
export function artboardDiffOf(diff: DocumentDiff, id: string, side: 'before' | 'after'): ArtboardDiff | undefined {
  return diff.artboards.find((artboard) => (side === 'before' ? artboard.beforeId : artboard.afterId) === id);
}
