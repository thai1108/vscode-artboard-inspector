// Pairs up the artboards and layers of two versions of a design. Ids come first; names are used only where they
// are unambiguous, so a guess never turns two different layers into one "changed" layer.
import type { ArtboardSummary, SceneNode } from '../scene/scene.ts';

export type MatchedBy = 'id' | 'name';

export interface ArtboardPairing {
  /** Index into the earlier version's artboards, null when the artboard was added. */
  before: number | null;
  after: number | null;
  matchedBy: MatchedBy | null;
}

/**
 * Artboards with the same id, then the remaining ones whose name occurs once among the unmatched artboards of both
 * versions. Order: the later version's artboards, then the removed ones in their earlier order.
 */
export function matchArtboards(before: readonly ArtboardSummary[], after: readonly ArtboardSummary[]): ArtboardPairing[] {
  const afterById = new Map<string, number>();
  after.forEach((artboard, i) => afterById.set(artboard.id, i));
  const beforeOf = new Map<number, { index: number; matchedBy: MatchedBy }>();
  const matchedBefore = new Set<number>();
  before.forEach((artboard, i) => {
    const j = afterById.get(artboard.id);
    if (j !== undefined && !beforeOf.has(j)) {
      beforeOf.set(j, { index: i, matchedBy: 'id' });
      matchedBefore.add(i);
    }
  });
  const unmatchedBefore = before.map((artboard, i) => ({ key: artboard.name, i })).filter(({ i }) => !matchedBefore.has(i));
  const unmatchedAfter = after.map((artboard, i) => ({ key: artboard.name, i })).filter(({ i }) => !beforeOf.has(i));
  for (const [i, j] of uniquePairs(unmatchedBefore, unmatchedAfter)) {
    beforeOf.set(j, { index: i, matchedBy: 'name' });
    matchedBefore.add(i);
  }
  const pairings: ArtboardPairing[] = after.map((_, j) => {
    const match = beforeOf.get(j);
    return { before: match?.index ?? null, after: j, matchedBy: match?.matchedBy ?? null };
  });
  before.forEach((_, i) => {
    if (!matchedBefore.has(i)) {
      pairings.push({ before: i, after: null, matchedBy: null });
    }
  });
  return pairings;
}

/** A layer with its place in the tree. */
export interface IndexedLayer {
  node: SceneNode;
  parent: IndexedLayer | null;
  /** Ids from the top-level layer down to this one; tells apart the children of two instances of one component. */
  idPath: string;
}

/** Layers in document order (parents before children). */
export function indexLayers(nodes: readonly SceneNode[]): IndexedLayer[] {
  const out: IndexedLayer[] = [];
  const walk = (children: readonly SceneNode[], parent: IndexedLayer | null) => {
    for (const node of children) {
      const entry: IndexedLayer = { node, parent, idPath: `${parent?.idPath ?? ''}\u0000${node.id}` };
      out.push(entry);
      if (node.kind === 'group') {
        walk(node.children, entry);
      }
    }
  };
  walk(nodes, null);
  return out;
}

export interface LayerMatches {
  /** After key by before key. */
  afterOf: Map<string, string>;
  beforeOf: Map<string, string>;
  byId: number;
  byName: number;
}

/**
 * Pairs layers of two versions of one artboard:
 * 1. the same id, when the id occurs once in each version (Figma and XD repeat ids inside component instances);
 * 2. the same chain of ids from the top level, when that occurs once in each (children of separate instances);
 * 3. top-down under every matched pair of parents (the artboards being the first), children of the same kind whose
 *    name occurs once among the unmatched children on both sides — a match by name path.
 * Layers of different kinds are never paired.
 */
export function matchLayers(before: readonly SceneNode[], after: readonly SceneNode[]): LayerMatches {
  const beforeLayers = indexLayers(before);
  const afterLayers = indexLayers(after);
  const matches: LayerMatches = { afterOf: new Map(), beforeOf: new Map(), byId: 0, byName: 0 };
  const pair = (b: SceneNode, a: SceneNode, by: MatchedBy) => {
    matches.afterOf.set(b.key, a.key);
    matches.beforeOf.set(a.key, b.key);
    if (by === 'id') {
      matches.byId++;
    } else {
      matches.byName++;
    }
  };

  const idKeys = [(entry: IndexedLayer) => entry.node.id, (entry: IndexedLayer) => (entry.node.id ? entry.idPath : '')];
  for (const keyOf of idKeys) {
    const beforeLeft = beforeLayers.filter((entry) => !matches.afterOf.has(entry.node.key) && keyOf(entry));
    const afterLeft = afterLayers.filter((entry) => !matches.beforeOf.has(entry.node.key) && keyOf(entry));
    for (const [i, j] of uniquePairs(beforeLeft.map((entry, i) => ({ key: keyOf(entry), i })), afterLeft.map((entry, j) => ({ key: keyOf(entry), i: j })))) {
      const b = beforeLeft[i]?.node;
      const a = afterLeft[j]?.node;
      if (b && a && b.kind === a.kind) {
        pair(b, a, 'id');
      }
    }
  }

  const queue: [readonly SceneNode[], readonly SceneNode[]][] = [[before, after]];
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [beforeChildren, afterChildren] = next;
    const nameKey = (node: SceneNode) => `${node.kind}\u0000${node.name}`;
    const beforeLeft = beforeChildren.filter((node) => !matches.afterOf.has(node.key));
    const afterLeft = afterChildren.filter((node) => !matches.beforeOf.has(node.key));
    for (const [i, j] of uniquePairs(beforeLeft.map((node, i) => ({ key: nameKey(node), i })), afterLeft.map((node, j) => ({ key: nameKey(node), i: j })))) {
      const b = beforeLeft[i];
      const a = afterLeft[j];
      if (b && a) {
        pair(b, a, 'name');
      }
    }
    const afterByKey = new Map(afterChildren.map((node) => [node.key, node]));
    for (const b of beforeChildren) {
      const a = afterByKey.get(matches.afterOf.get(b.key) ?? '');
      if (a?.kind === 'group' && b.kind === 'group') {
        queue.push([b.children, a.children]);
      }
    }
  }
  return matches;
}

/** [before index, after index] of keys that occur exactly once in each list. */
function uniquePairs(before: { key: string; i: number }[], after: { key: string; i: number }[]): [number, number][] {
  const count = (list: { key: string }[]) => {
    const counts = new Map<string, number>();
    for (const { key } of list) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const beforeCounts = count(before);
  const afterCounts = count(after);
  const afterIndex = new Map(after.filter(({ key }) => afterCounts.get(key) === 1).map(({ key, i }) => [key, i]));
  const pairs: [number, number][] = [];
  for (const { key, i } of before) {
    const j = afterIndex.get(key);
    if (j !== undefined && beforeCounts.get(key) === 1) {
      pairs.push([i, j]);
    }
  }
  return pairs;
}
