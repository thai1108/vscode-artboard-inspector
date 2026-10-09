const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;
const PADDING = 40;
const ZOOM_STEP = 1.25;

/** Zoom/pan of the artboard inside the stage; `x`/`y` are the screen offset of the artboard's top-left corner. */
export class Viewport {
  zoom = 1;
  x = 0;
  y = 0;
  private contentWidth = 0;
  private contentHeight = 0;
  private spaceDown = false;
  private dragMoved = false;
  private readonly host: HTMLElement;
  private readonly canvas: HTMLElement;
  private readonly onChange: () => void;

  constructor(host: HTMLElement, canvas: HTMLElement, onChange: () => void) {
    this.host = host;
    this.canvas = canvas;
    this.onChange = onChange;
    this.bindEvents();
  }

  setContent(width: number, height: number): void {
    this.contentWidth = width;
    this.contentHeight = height;
  }

  /** Fits the artboard width (never above 100%) and shows its top. */
  fitWidth(): void {
    const available = this.host.clientWidth - PADDING * 2;
    this.zoom = clampZoom(Math.min(1, available / Math.max(1, this.contentWidth)));
    this.x = (this.host.clientWidth - this.contentWidth * this.zoom) / 2;
    this.y = PADDING;
    this.apply();
  }

  fitAll(): void {
    const zoomX = (this.host.clientWidth - PADDING * 2) / Math.max(1, this.contentWidth);
    const zoomY = (this.host.clientHeight - PADDING * 2) / Math.max(1, this.contentHeight);
    this.zoom = clampZoom(Math.min(zoomX, zoomY));
    this.x = (this.host.clientWidth - this.contentWidth * this.zoom) / 2;
    this.y = (this.host.clientHeight - this.contentHeight * this.zoom) / 2;
    this.apply();
  }

  actualSize(): void {
    this.zoomTo(1, this.host.clientWidth / 2, this.host.clientHeight / 2);
  }

  zoomIn(): void {
    this.zoomTo(this.zoom * ZOOM_STEP, this.host.clientWidth / 2, this.host.clientHeight / 2);
  }

  zoomOut(): void {
    this.zoomTo(this.zoom / ZOOM_STEP, this.host.clientWidth / 2, this.host.clientHeight / 2);
  }

  /** Zooms keeping the artboard point under the given host-relative screen point fixed. */
  zoomTo(zoom: number, screenX: number, screenY: number): void {
    const next = clampZoom(zoom);
    const artboardX = (screenX - this.x) / this.zoom;
    const artboardY = (screenY - this.y) / this.zoom;
    this.zoom = next;
    this.x = screenX - artboardX * next;
    this.y = screenY - artboardY * next;
    this.apply();
  }

  /** Scrolls just enough to bring an artboard-space box into view. */
  reveal(box: { x: number; y: number; width: number; height: number }): void {
    const left = this.x + box.x * this.zoom;
    const top = this.y + box.y * this.zoom;
    const right = left + box.width * this.zoom;
    const bottom = top + box.height * this.zoom;
    const margin = PADDING;
    if (left < margin || right > this.host.clientWidth - margin) {
      this.x += this.host.clientWidth / 2 - (left + right) / 2;
    }
    if (top < margin || bottom > this.host.clientHeight - margin) {
      this.y += this.host.clientHeight / 2 - (top + bottom) / 2;
    }
    this.apply();
  }

  toScreen(x: number, y: number): { x: number; y: number } {
    return { x: this.x + x * this.zoom, y: this.y + y * this.zoom };
  }

  private apply(): void {
    this.canvas.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.zoom})`;
    this.onChange();
  }

  private bindEvents(): void {
    this.host.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
          const rect = this.host.getBoundingClientRect();
          const delta = Math.max(-50, Math.min(50, event.deltaY));
          this.zoomTo(this.zoom * Math.exp(-delta * 0.01), event.clientX - rect.left, event.clientY - rect.top);
        } else {
          this.x -= event.deltaX;
          this.y -= event.deltaY;
          this.apply();
        }
      },
      { passive: false },
    );

    let drag: { pointerId: number; startX: number; startY: number; originX: number; originY: number } | null = null;
    this.host.addEventListener('pointerdown', (event) => {
      const onArtboard = (event.target as Element).closest('.dv-artboard') !== null;
      if (event.button === 1 || (event.button === 0 && (this.spaceDown || !onArtboard))) {
        drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: this.x, originY: this.y };
        this.dragMoved = false;
        this.host.setPointerCapture(event.pointerId);
        this.host.classList.add('panning');
        event.preventDefault();
      }
    });
    this.host.addEventListener('pointermove', (event) => {
      if (drag?.pointerId === event.pointerId) {
        this.dragMoved ||= Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3;
        this.x = drag.originX + event.clientX - drag.startX;
        this.y = drag.originY + event.clientY - drag.startY;
        this.apply();
      }
    });
    const endDrag = (event: PointerEvent) => {
      if (drag?.pointerId === event.pointerId) {
        drag = null;
        this.host.classList.remove('panning');
      }
    };
    this.host.addEventListener('pointerup', endDrag);
    this.host.addEventListener('pointercancel', endDrag);

    window.addEventListener('keydown', (event) => {
      if (event.code === 'Space' && !isTyping(event)) {
        this.spaceDown = true;
        this.host.classList.add('pan-ready');
        event.preventDefault();
      }
    });
    window.addEventListener('keyup', (event) => {
      if (event.code === 'Space') {
        this.spaceDown = false;
        this.host.classList.remove('pan-ready');
      }
    });
    new ResizeObserver(() => this.onChange()).observe(this.host);
  }

  /** Whether the click that just happened ended a pan gesture (so it must not change the selection). */
  consumeDragClick(): boolean {
    const moved = this.dragMoved;
    this.dragMoved = false;
    return moved;
  }
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable === true;
}
