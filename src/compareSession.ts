import * as path from 'node:path';
import type * as vscode from 'vscode';
import { artboardDiffOf, compareDocuments, orientDiff, summarize, type DocumentDiff } from './compare/compare.ts';
import { imageKeys } from './compare/imageKeys.ts';
import type { DesignDocument } from './document.ts';
import { artboardMessage, scenesMessage, searchMessage } from './payload.ts';
import type { HostMessage, Side } from './protocol.ts';
import { buildSearchIndex, type SearchIndex } from './search.ts';

/** A design file an editor shows: the opened one, or the one it is compared with. */
export interface DesignSource {
  readonly name: string;
  readonly design: DesignDocument;
  searchIndex(): Promise<SearchIndex>;
}

/** The VS Code calls comparing makes, injected so the flow can be tested without a running editor. */
export interface CompareDeps {
  /** Asks for the file to compare with; undefined when cancelled. */
  pickFile(): Thenable<vscode.Uri | undefined>;
  /** Reads and opens a design file with the same limits as opening it in the editor. */
  readDesign(uri: vscode.Uri): Promise<DesignDocument>;
  withProgress<T>(title: string, task: () => Promise<T>): Thenable<T>;
  showErrorMessage(message: string): void;
}

interface Comparison {
  other: DesignSource;
  swapped: boolean;
  /** The other file as the earlier version; null while it is computed. */
  diff: DocumentDiff | null;
  /** `diff` the way round it is shown. */
  oriented: DocumentDiff | null;
  generation: number;
}

/**
 * One editor's comparison of its file with another version of it. Answers the webview's requests from whichever
 * file is shown as the later version, and adds each artboard's diff while comparing.
 */
export class CompareSession {
  private readonly opened: () => DesignSource;
  private readonly deps: CompareDeps;
  private readonly post: (message: HostMessage) => void;
  private comparison: Comparison | null = null;
  private generation = 0;
  private disposed = false;

  constructor(opened: () => DesignSource, deps: CompareDeps, post: (message: HostMessage) => void) {
    this.opened = opened;
    this.deps = deps;
    this.post = post;
  }

  /** The file shown as the later version. */
  get after(): DesignSource {
    const comparison = this.comparison;
    return comparison?.swapped ? comparison.other : this.opened();
  }

  get before(): DesignSource | null {
    const comparison = this.comparison;
    return !comparison ? null : comparison.swapped ? this.opened() : comparison.other;
  }

  documentMessage(): HostMessage {
    const { name, design } = this.after;
    return { type: 'document', fileName: name, artboards: [...design.artboards], board: design.board };
  }

  /** Everything a (re)loaded webview needs. */
  ready(): void {
    this.send(this.documentMessage());
    const comparison = this.comparison;
    if (comparison?.oriented) {
      this.send(this.summaryMessage(comparison, comparison.oriented));
    }
  }

  /** The answer to loadArtboard, with the artboard's diff while comparing. */
  artboard(id: string, knownImages: Set<string>, side?: Side): HostMessage {
    const source = side === 'before' ? this.before : this.after;
    if (!source) {
      return { type: 'error', message: 'Not comparing with another version' };
    }
    const message = artboardMessage(source.design, id, knownImages);
    const oriented = this.comparison?.oriented;
    const diff = oriented && message.type === 'artboard' ? artboardDiffOf(oriented, id, side ?? 'after') : undefined;
    return message.type === 'artboard' ? { ...message, ...(side ? { side } : {}), ...(diff ? { diff } : {}) } : message;
  }

  scenes(ids: string[], knownImages: Set<string>): HostMessage {
    return scenesMessage(this.after.design, ids, knownImages);
  }

  async search(query: string, seq: number): Promise<HostMessage> {
    try {
      return searchMessage(await this.after.searchIndex(), query, seq);
    } catch (error) {
      return { type: 'searchResults', seq, hits: [], total: 0, searched: 0, error: (error as Error).message };
    }
  }

  /** Asks for the earlier version and compares the opened file with it. */
  async pick(): Promise<void> {
    const uri = await this.deps.pickFile();
    if (!uri) {
      return;
    }
    const name = path.posix.basename(uri.path);
    let design: DesignDocument;
    try {
      design = await this.deps.readDesign(uri);
    } catch (error) {
      this.deps.showErrorMessage(`Could not open ${name}: ${(error as Error).message}`);
      return;
    }
    if (this.disposed) {
      return;
    }
    this.exit();
    let index: Promise<SearchIndex> | undefined;
    const other: DesignSource = { name, design, searchIndex: () => (index ??= buildSearchIndex(design)) };
    this.comparison = { other, swapped: false, diff: null, oriented: null, generation: 0 };
    await this.recompute();
  }

  swap(): void {
    const comparison = this.comparison;
    if (!comparison?.diff) {
      return;
    }
    comparison.swapped = !comparison.swapped;
    comparison.oriented = orientDiff(comparison.diff, comparison.swapped);
    this.send(this.summaryMessage(comparison, comparison.oriented));
    this.send(this.documentMessage());
  }

  exit(): void {
    const comparison = this.comparison;
    if (!comparison) {
      return;
    }
    this.comparison = null;
    this.generation++;
    this.send({ type: 'compare', summary: null });
    if (comparison.swapped) {
      this.send(this.documentMessage());
    }
  }

  /** The editor closed: drops the other file, and anything a dialog or comparison still running would send. */
  dispose(): void {
    this.disposed = true;
    this.comparison = null;
    this.generation++;
  }

  private send(message: HostMessage): void {
    if (!this.disposed) {
      this.post(message);
    }
  }

  /** The opened file changed on disk: show it (when it is the later version) and compare again. */
  async openedChanged(): Promise<void> {
    if (!this.comparison?.swapped) {
      this.send(this.documentMessage());
    }
    await this.recompute();
  }

  private async recompute(): Promise<void> {
    const comparison = this.comparison;
    if (!comparison) {
      return;
    }
    const generation = ++this.generation;
    comparison.generation = generation;
    comparison.diff = null;
    comparison.oriented = null;
    const { other } = comparison;
    const opened = this.opened();
    const beforeKey = imageKeys(other.design);
    const afterKey = imageKeys(opened.design);
    let diff: DocumentDiff;
    try {
      diff = await this.deps.withProgress(`Comparing with ${other.name}`, () =>
        compareDocuments(other.design, opened.design, { imageKey: (side, uid) => (side === 'before' ? beforeKey : afterKey)(uid) }),
      );
    } catch (error) {
      if (this.comparison === comparison && comparison.generation === generation) {
        this.deps.showErrorMessage(`Could not compare with ${other.name}: ${(error as Error).message}`);
        this.exit();
      }
      return;
    }
    // A newer pick, exit or reload took over while this one ran.
    if (this.comparison !== comparison || comparison.generation !== generation) {
      return;
    }
    comparison.diff = diff;
    comparison.oriented = orientDiff(diff, comparison.swapped);
    this.send(this.summaryMessage(comparison, comparison.oriented));
  }

  private summaryMessage(comparison: Comparison, oriented: DocumentDiff): HostMessage {
    const opened = this.opened().name;
    const names = comparison.swapped ? { before: opened, after: comparison.other.name } : { before: comparison.other.name, after: opened };
    return { type: 'compare', summary: summarize(oriented, names, comparison.swapped, comparison.generation) };
  }
}
