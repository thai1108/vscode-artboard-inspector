import { MESSAGE_LIMITS, type HostMessage } from '../protocol.ts';
import { escapeHtml } from '../render/html.ts';
import type { Excerpt, SearchHit } from '../search.ts';

const DEBOUNCE_MS = 150;

type SearchResults = Extract<HostMessage, { type: 'searchResults' }>;

export interface SearchDeps {
  input: HTMLInputElement;
  status: HTMLElement;
  results: HTMLElement;
  requestSearch(query: string, seq: number): void;
  artboardName(id: string): string | undefined;
  artboardCount(): number;
  /** Shows the hit's artboard in the single view and selects the layer. */
  open(hit: SearchHit): void;
}

/** Sidebar search over the text and layer names of every artboard; the extension host does the matching. */
export class SearchPanel {
  private readonly deps: SearchDeps;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Seq of the request whose answer has not arrived yet, or 0. */
  private waitingFor = 0;
  /** Enter was pressed before the answer to the current query arrived. */
  private openWhenAnswered = false;
  private hits: SearchHit[] = [];
  private active = -1;
  private opened = -1;

  constructor(deps: SearchDeps) {
    this.deps = deps;
    deps.input.maxLength = MESSAGE_LIMITS.searchQueryLength;
    deps.input.addEventListener('input', () => this.schedule());
    deps.input.addEventListener('keydown', (event) => this.onKeyDown(event));
    deps.results.addEventListener('click', (event) => {
      const item = (event.target as Element).closest<HTMLElement>('.search-hit');
      if (item) {
        this.open(Number(item.dataset['index']));
      }
    });
  }

  focus(): void {
    this.deps.input.focus();
    this.deps.input.select();
  }

  /** Runs the current query again, e.g. after the file changed on disk. */
  refresh(): void {
    if (this.query) {
      this.send();
    }
  }

  onResults(message: SearchResults): void {
    if (message.seq !== this.seq) {
      return;
    }
    this.waitingFor = 0;
    this.hits = message.hits;
    this.active = this.hits.length ? 0 : -1;
    this.opened = -1;
    this.render(message);
    if (this.openWhenAnswered) {
      this.openWhenAnswered = false;
      this.open(0);
    }
  }

  private get query(): string {
    return this.deps.input.value.trim().slice(0, MESSAGE_LIMITS.searchQueryLength);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.openWhenAnswered = false;
    if (!this.query) {
      this.clear();
      return;
    }
    this.timer = setTimeout(() => this.send(), DEBOUNCE_MS);
  }

  private send(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.waitingFor = ++this.seq;
    this.deps.requestSearch(this.query, this.seq);
    this.deps.results.classList.add('pending');
    if (!this.hits.length) {
      this.showStatus('Searching…');
    }
  }

  private clear(): void {
    // Answers still on their way belong to a query that is gone.
    this.seq++;
    this.waitingFor = 0;
    this.hits = [];
    this.active = -1;
    this.opened = -1;
    this.deps.input.removeAttribute('aria-activedescendant');
    this.deps.results.innerHTML = '';
    this.deps.results.hidden = true;
    this.deps.status.hidden = true;
  }

  private onKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        this.setActive(Math.min(this.active + 1, this.hits.length - 1));
        break;
      case 'ArrowUp':
        this.setActive(Math.max(this.active - 1, 0));
        break;
      case 'Enter':
        if (this.timer !== undefined || this.waitingFor) {
          this.openWhenAnswered = true;
          if (this.timer !== undefined) {
            this.send();
          }
        } else if (this.hits.length) {
          // Enter on the hit already shown walks on to the next one (Shift+Enter: the previous one).
          const step = this.active === this.opened ? (event.shiftKey ? -1 : 1) : 0;
          this.open((this.active + step + this.hits.length) % this.hits.length);
        }
        break;
      case 'Escape':
        if (this.deps.input.value) {
          this.deps.input.value = '';
          this.schedule();
        } else {
          this.deps.input.blur();
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  private open(index: number): void {
    const hit = this.hits[index];
    if (!hit) {
      return;
    }
    this.opened = index;
    this.setActive(index);
    this.deps.open(hit);
  }

  private setActive(index: number): void {
    if (index < 0 || index >= this.hits.length) {
      this.deps.input.removeAttribute('aria-activedescendant');
      return;
    }
    this.active = index;
    for (const item of this.deps.results.querySelectorAll<HTMLElement>('.search-hit')) {
      const itemIndex = Number(item.dataset['index']);
      const isActive = itemIndex === index;
      item.classList.toggle('active', isActive);
      item.classList.toggle('opened', itemIndex === this.opened);
      item.setAttribute('aria-selected', String(isActive));
      if (isActive) {
        item.scrollIntoView({ block: 'nearest' });
      }
    }
    this.deps.input.setAttribute('aria-activedescendant', `search-hit-${index}`);
  }

  private render(message: SearchResults): void {
    const { results } = this.deps;
    results.classList.remove('pending');
    results.hidden = false;
    const more = message.total - message.hits.length;
    results.innerHTML =
      message.hits.map((hit, i) => this.renderHit(hit, i)).join('') +
      (more > 0 ? `<li class="search-more">${more.toLocaleString('en-US')} more — refine the search</li>` : '');
    this.setActive(this.active);

    const count = this.deps.artboardCount();
    const scope = message.searched < count ? ` in ${message.searched} of ${count} artboards` : '';
    if (message.error) {
      this.showStatus(`Search failed: ${message.error}`);
    } else {
      this.showStatus(`${message.total ? message.total.toLocaleString('en-US') : 'No'} result${message.total === 1 ? '' : 's'}${scope}`);
    }
  }

  private renderHit(hit: SearchHit, index: number): string {
    const artboard = this.deps.artboardName(hit.artboard) ?? hit.artboard;
    return (
      `<li class="search-hit" role="option" id="search-hit-${index}" aria-selected="false" data-index="${index}" ` +
      `data-artboard="${escapeHtml(hit.artboard)}" data-key="${escapeHtml(hit.key)}" title="${escapeHtml(`${artboard} › ${hit.name.text}`)}">` +
      `<div class="search-hit-name">${highlight(hit.name)}</div>` +
      (hit.text ? `<div class="search-hit-text">${highlight(hit.text)}</div>` : '') +
      `<div class="search-hit-artboard">${escapeHtml(artboard)}</div></li>`
    );
  }

  private showStatus(text: string): void {
    this.deps.status.textContent = text;
    this.deps.status.hidden = false;
  }
}

function highlight({ text, match }: Excerpt): string {
  if (!match) {
    return escapeHtml(text);
  }
  const [start, end] = match;
  return `${escapeHtml(text.slice(0, start))}<mark>${escapeHtml(text.slice(start, end))}</mark>${escapeHtml(text.slice(end))}`;
}
