import type { ArtboardDiff, ArtboardDiffSummary, CompareSummary } from '../compare/compare.ts';
import type { ChangeStatus, LayerChange, PropertyChange } from '../compare/diff.ts';
import type { Box } from '../render/geometry.ts';
import { escapeHtml } from '../render/html.ts';
import type { ArtboardScene } from '../scene/scene.ts';

/** Which version the canvas shows while comparing. */
export type Version = 'after' | 'before';

/** An outline drawn over a changed layer; `ghost`: the layer is only in the other version, drawn where it is there. */
export interface DiffMark {
  box: Box;
  status: ChangeStatus;
  ghost: boolean;
}

/** Changed layers listed in the artboard inspector. */
const LISTED_CHANGES = 200;
const STATUS_LABELS: Record<ChangeStatus, string> = { added: 'Added', removed: 'Removed', changed: 'Changed' };
const STATUS_SIGNS: Record<ChangeStatus, string> = { added: '+', removed: '−', changed: '~' };

/** Compare mode in the webview: the host's summary, the diffs of the artboards opened and the earlier scenes. */
export class Comparison {
  readonly summary: CompareSummary;
  private readonly entries = new Map<string, ArtboardDiffSummary>();
  private readonly diffs = new Map<ArtboardDiffSummary, ArtboardDiff>();
  readonly beforeScenes = new Map<string, ArtboardScene>();

  constructor(summary: CompareSummary) {
    this.summary = summary;
    for (const entry of summary.artboards) {
      if (entry.afterId !== null) {
        this.entries.set(`after:${entry.afterId}`, entry);
      }
      if (entry.beforeId !== null) {
        this.entries.set(`before:${entry.beforeId}`, entry);
      }
    }
  }

  /** The summary of the same comparison, so what is held stays valid. */
  sameAs(summary: CompareSummary): boolean {
    return summary.generation === this.summary.generation && summary.swapped === this.summary.swapped;
  }

  entry(id: string, version: Version): ArtboardDiffSummary | undefined {
    return this.entries.get(`${version}:${id}`);
  }

  /** Artboards only in the earlier version, listed after the current ones. */
  get removed(): ArtboardDiffSummary[] {
    return this.summary.artboards.filter((entry) => entry.afterId === null);
  }

  addDiff(diff: ArtboardDiff): void {
    const entry = (diff.afterId !== null ? this.entry(diff.afterId, 'after') : undefined) ?? (diff.beforeId !== null ? this.entry(diff.beforeId, 'before') : undefined);
    if (entry) {
      this.diffs.set(entry, diff);
    }
  }

  diff(entry: ArtboardDiffSummary | undefined): ArtboardDiff | undefined {
    return entry && this.diffs.get(entry);
  }
}

export function keyOn(change: LayerChange, version: Version): string | null {
  return version === 'after' ? change.afterKey : change.beforeKey;
}

/** The change of the layer with `key` in `version`'s scene. */
export function changeOf(diff: ArtboardDiff | undefined, version: Version, key: string): LayerChange | undefined {
  return diff?.changes.find((change) => keyOn(change, version) === key);
}

/** The same layer's key in the other version, or null when it is only in this one. */
export function counterpartKey(diff: ArtboardDiff | undefined, version: Version, key: string): string | null {
  const pair = diff?.pairs.find(([before, after]) => (version === 'after' ? after : before) === key);
  return pair ? (version === 'after' ? pair[0] : pair[1]) : null;
}

/** Outlines for the changes of `diff` over `version`, measured where the layer is drawn and ghosted where it is not. */
export function diffMarks(diff: ArtboardDiff | undefined, version: Version, measured: ReadonlyMap<string, Box>): DiffMark[] {
  const marks: DiffMark[] = [];
  for (const change of diff?.changes ?? []) {
    const key = keyOn(change, version);
    const box = key !== null ? (measured.get(key) ?? (version === 'after' ? change.afterBox : change.beforeBox)) : version === 'after' ? change.beforeBox : change.afterBox;
    if (box) {
      marks.push({ box, status: change.status, ghost: key === null });
    }
  }
  return marks;
}

/** Status of every changed layer drawn in `version`, for the layer tree. */
export function layerStatuses(diff: ArtboardDiff | undefined, version: Version): Map<string, ChangeStatus> {
  const statuses = new Map<string, ChangeStatus>();
  for (const change of diff?.changes ?? []) {
    const key = keyOn(change, version);
    if (key !== null) {
      statuses.set(key, change.status);
    }
  }
  return statuses;
}

/** "2 changed · 1 added · 1 removed" over the artboards. */
export function summaryText(summary: CompareSummary): string {
  const count = (status: ArtboardDiffSummary['status']) => summary.artboards.filter((entry) => entry.status === status).length;
  const parts = [`${count('changed')} changed`, `${count('added')} added`, `${count('removed')} removed`, `${count('unchanged')} unchanged`];
  const skipped = count('skipped');
  if (skipped) {
    parts.push(`${skipped} not compared`);
  }
  return `Artboards: ${parts.join(' · ')}`;
}

function layerCountText(entry: ArtboardDiffSummary): string {
  const { added, removed, changed } = entry.counts;
  return `${changed} changed, ${added} added, ${removed} removed layers`;
}

/** The badge after an artboard's name in the list and on the board. */
export function artboardBadge(entry: ArtboardDiffSummary | undefined): string {
  if (!entry) {
    return '';
  }
  switch (entry.status) {
    case 'added':
      return '<span class="diff-badge diff-added" title="Not in the earlier version">New</span>';
    case 'removed':
      return '<span class="diff-badge diff-removed" title="Only in the earlier version">Removed</span>';
    case 'skipped':
      return `<span class="diff-badge diff-skipped" title="${escapeHtml(entry.note ?? 'Not compared')}">?</span>`;
    case 'unchanged':
      return '';
    case 'changed': {
      const { added, removed, changed } = entry.counts;
      const total = added + removed + changed;
      return `<span class="diff-badge diff-changed" title="${escapeHtml(layerCountText(entry))}">${total || '~'}</span>`;
    }
  }
}

/** Values longer than this together get a line each. */
const INLINE_VALUES = 28;

function rows(props: PropertyChange[]): string {
  return props
    .map(
      (prop) =>
        `<div class="change-row${prop.before.length + prop.after.length > INLINE_VALUES ? ' stacked' : ''}"><span class="change-label">${escapeHtml(prop.label)}</span>` +
        `<span class="change-before" title="${escapeHtml(prop.before)}">${escapeHtml(prop.before)}</span><span class="change-arrow">→</span>` +
        `<span class="change-after" title="${escapeHtml(prop.after)}">${escapeHtml(prop.after)}</span></div>`,
    )
    .join('');
}

function section(body: string): string {
  return `<section class="insp-section changes"><h3>Changes</h3>${body}</section>`;
}

/** The inspector's Changes section for a layer: before → after per property. */
export function layerChangesSection(change: LayerChange | undefined, summary: CompareSummary): string {
  if (!change) {
    return section('<div class="change-status">Unchanged</div>');
  }
  // The compare bar names both files; only a layer missing from one of them says which.
  const where = change.status === 'added' ? summary.beforeName : change.status === 'removed' ? summary.afterName : null;
  const status = `<div class="change-status diff-${change.status}">${STATUS_LABELS[change.status]}${where === null ? '' : ` <span class="dim">— not in ${escapeHtml(where)}</span>`}</div>`;
  return section(status + (change.props.length ? `<div class="change-rows">${rows(change.props)}</div>` : ''));
}

/** The inspector's Changes section for an artboard: its own changes and the list of changed layers. */
export function artboardChangesSection(entry: ArtboardDiffSummary | undefined, diff: ArtboardDiff | undefined, version: Version): string {
  if (!entry) {
    return '';
  }
  if (entry.status === 'added' || entry.status === 'removed' || entry.status === 'skipped') {
    const text = entry.status === 'added' ? 'New artboard: not in the earlier version' : entry.status === 'removed' ? 'Removed: only in the earlier version' : (entry.note ?? 'Not compared');
    return section(`<div class="change-status diff-${entry.status}">${escapeHtml(text)}</div>`);
  }
  if (entry.status === 'unchanged') {
    return section('<div class="change-status">Unchanged</div>');
  }
  if (!diff) {
    return section('<div class="change-status">Loading…</div>');
  }
  const parts = [`<div class="change-status diff-changed">${escapeHtml(layerCountText(entry))}</div>`];
  if (diff.props.length) {
    parts.push(`<div class="change-rows">${rows(diff.props)}</div>`);
  }
  const items = diff.changes.slice(0, LISTED_CHANGES).map((change, index) => {
    const here = keyOn(change, version) !== null;
    const detail = change.props.map((prop) => prop.label).join(', ');
    return (
      `<li><button class="change-layer diff-${change.status}${here ? '' : ' elsewhere'}" data-change="${index}" title="${here ? 'Select' : 'Show the other version and select'}">` +
      `<span class="change-sign">${STATUS_SIGNS[change.status]}</span><span class="change-name">${escapeHtml(change.name || 'Layer')}</span>` +
      (detail ? `<span class="change-props dim">${escapeHtml(detail)}</span>` : '') +
      '</button></li>'
    );
  });
  const hidden = entry.counts.added + entry.counts.removed + entry.counts.changed - items.length;
  if (hidden > 0) {
    items.push(`<li class="dim">${hidden.toLocaleString('en-US')} more not listed</li>`);
  }
  parts.push(`<ul class="change-list">${items.join('')}</ul>`);
  return section(parts.join(''));
}
