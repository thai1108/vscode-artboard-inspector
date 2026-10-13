import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchArtboards, matchLayers } from '../src/compare/match.ts';
import type { ArtboardSummary, SceneNode } from '../src/scene/scene.ts';
import { group, shape, text } from './support/sceneBuilders.ts';

const board = (id: string, name: string): ArtboardSummary => ({ id, name, width: 100, height: 100 });

/** Matched pairs as "before key → after key", sorted. */
function pairs(before: SceneNode[], after: SceneNode[]): string[] {
  return [...matchLayers(before, after).afterOf].map(([b, a]) => `${b}→${a}`).sort();
}

describe('matchArtboards', () => {
  it('matches by id first, then by a name that is unique among the unmatched artboards', () => {
    const before = [board('a', 'Home'), board('b', 'Cart'), board('c', 'Old')];
    const after = [board('x', 'Cart'), board('a', 'Home renamed'), board('y', 'New')];
    assert.deepEqual(matchArtboards(before, after), [
      { before: 1, after: 0, matchedBy: 'name' },
      { before: 0, after: 1, matchedBy: 'id' },
      { before: null, after: 2, matchedBy: null },
      { before: 2, after: null, matchedBy: null },
    ]);
  });

  it('treats artboards with an ambiguous name as added and removed rather than guessing', () => {
    const before = [board('a', 'Screen'), board('b', 'Screen')];
    const after = [board('c', 'Screen')];
    assert.deepEqual(matchArtboards(before, after), [
      { before: null, after: 0, matchedBy: null },
      { before: 0, after: null, matchedBy: null },
      { before: 1, after: null, matchedBy: null },
    ]);
    assert.deepEqual(
      matchArtboards([board('a', 'Screen')], [board('b', 'Screen'), board('c', 'Screen')]).map((p) => p.matchedBy),
      [null, null, null],
    );
  });
});

describe('matchLayers', () => {
  it('matches layers with the same id, wherever they moved to', () => {
    const before = [group([shape({ key: 'b1', id: 'title' })], { key: 'b0', id: 'card' })];
    const after = [group([], { key: 'a0', id: 'card' }), shape({ key: 'a1', id: 'title' })];
    const matches = matchLayers(before, after);
    assert.deepEqual(pairs(before, after), ['b0→a0', 'b1→a1']);
    assert.equal(matches.byId, 2);
    assert.equal(matches.byName, 0);
  });

  it('tells repeated ids (component instances) apart by the ids of their parents', () => {
    const instance = (key: string, id: string) => group([shape({ key: `${key}-label`, id: 'label' })], { key, id });
    const before = [instance('b1', 'i1'), instance('b2', 'i2')];
    const after = [instance('a2', 'i2'), instance('a1', 'i1')];
    assert.deepEqual(pairs(before, after), ['b1-label→a1-label', 'b1→a1', 'b2-label→a2-label', 'b2→a2']);
  });

  it('falls back to names under matched parents when ids changed', () => {
    const before = [group([shape({ key: 'b1', id: 'x1', name: 'Background' }), text({ key: 'b2', id: 'x2', name: 'Title' })], { key: 'b0', id: 'old', name: 'Card' })];
    const after = [group([text({ key: 'a2', id: 'y2', name: 'Title' }), shape({ key: 'a1', id: 'y1', name: 'Background' })], { key: 'a0', id: 'new', name: 'Card' })];
    const matches = matchLayers(before, after);
    assert.deepEqual(pairs(before, after), ['b0→a0', 'b1→a1', 'b2→a2']);
    assert.equal(matches.byName, 3);
  });

  it('matches by name below a parent matched by id, even when the parent was renamed', () => {
    const before = [group([shape({ key: 'b1', name: 'Icon' })], { key: 'b0', id: 'g', name: 'Old name' })];
    const after = [group([shape({ key: 'a1', name: 'Icon' })], { key: 'a0', id: 'g', name: 'New name' })];
    assert.deepEqual(pairs(before, after), ['b0→a0', 'b1→a1']);
  });

  it('leaves ambiguous names, other parents and other kinds unmatched', () => {
    const before = [shape({ key: 'b1', name: 'Dot' }), shape({ key: 'b2', name: 'Dot' }), shape({ key: 'b3', name: 'Label' }), group([shape({ key: 'b5', name: 'Deep' })], { key: 'b4', name: 'Box' })];
    const after = [shape({ key: 'a1', name: 'Dot' }), text({ key: 'a3', name: 'Label' }), group([shape({ key: 'a5', name: 'Deep' })], { key: 'a4', name: 'Other box' })];
    assert.deepEqual(pairs(before, after), []);
  });

  it('never pairs layers of different kinds by id', () => {
    assert.deepEqual(pairs([shape({ key: 'b', id: 'same' })], [text({ key: 'a', id: 'same' })]), []);
  });
});
