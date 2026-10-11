import type { HostMessage } from '../protocol.ts';
import { assertScreenshotSize, screenshotType } from '../screenshot.ts';
import { byId } from './dom.ts';
import { isTyping } from './viewport.ts';

/** Image pixels per design pixel (retina captures). */
export const SCREENSHOT_SCALES = [1, 2, 3];
const SHIFT_NUDGE = 10;

/** Offsets are design pixels from the artboard's top-left corner. */
export interface ScreenshotSettings {
  scale: number;
  opacity: number;
  difference: boolean;
  visible: boolean;
  x: number;
  y: number;
}

interface Screenshot extends ScreenshotSettings {
  name: string;
  url: string;
  /** Image pixels. */
  width: number;
  height: number;
}

const DEFAULTS: ScreenshotSettings = { scale: 1, opacity: 0.5, difference: false, visible: true, x: 0, y: 0 };

/** The scale whose design width comes closest to the artboard's, so a 2x capture of a 390 pt screen lands on 2x. */
export function guessScale(imageWidth: number, artboardWidth: number): number {
  let best = 1;
  for (const scale of SCREENSHOT_SCALES) {
    if (Math.abs(imageWidth / scale - artboardWidth) < Math.abs(imageWidth / best - artboardWidth)) {
      best = scale;
    }
  }
  return best;
}

/** Transform of the overlay image inside the artboard's (already zoomed and panned) coordinate space. */
export function screenshotTransform(settings: Pick<ScreenshotSettings, 'x' | 'y' | 'scale'>): string {
  return `translate(${settings.x}px, ${settings.y}px) scale(${1 / settings.scale})`;
}

/** The offset change for an arrow key, or null for any other key. */
export function nudgeFor(key: string, shift: boolean): { dx: number; dy: number } | null {
  const step = shift ? SHIFT_NUDGE : 1;
  switch (key) {
    case 'ArrowLeft':
      return { dx: -step, dy: 0 };
    case 'ArrowRight':
      return { dx: step, dy: 0 };
    case 'ArrowUp':
      return { dx: 0, dy: -step };
    case 'ArrowDown':
      return { dx: 0, dy: step };
    default:
      return null;
  }
}

const BAR_HTML = `
  <span id="screenshot-name" class="shot-name"></span>
  <label class="shot-field">Scale
    <select id="screenshot-scale">${SCREENSHOT_SCALES.map((scale) => `<option value="${scale}">${scale}x</option>`).join('')}</select>
  </label>
  <label class="shot-field">Opacity
    <input id="screenshot-opacity" type="range" min="0" max="100" step="1">
    <span id="screenshot-opacity-value" class="shot-value"></span>
  </label>
  <button id="screenshot-blend" class="text-button toggle" title="Difference blend: pixels that match the design turn black">Difference</button>
  <button id="screenshot-visible" class="text-button" title="Show or hide the screenshot"></button>
  <span class="shot-field" title="Offset from the artboard's top-left corner in design pixels; arrow keys nudge it (Shift: ${SHIFT_NUDGE} px)">Offset
    <span id="screenshot-offset" class="shot-value"></span>
    <span>(arrow keys)</span>
  </span>
  <span class="spacer"></span>
  <button id="screenshot-remove" class="text-button" title="Remove the screenshot from this artboard">Remove</button>
`;

export interface ScreenshotOverlayDeps {
  canvas: HTMLElement;
  /** Where image files can be dropped. */
  dropTarget: HTMLElement;
  bar: HTMLElement;
  loadButton: HTMLElement;
  artboardWidth: (id: string) => number | undefined;
  requestPick: (artboardId: string) => void;
  notify: (text: string) => void;
}

/**
 * A screenshot drawn over the single-artboard view to compare an implementation with the design. The image sits in
 * the zoomed canvas next to the artboard, so it follows zoom and pan; it never takes pointer events, so inspecting and
 * measuring keep working through it. Kept per artboard in memory only.
 */
export class ScreenshotOverlay {
  private readonly deps: ScreenshotOverlayDeps;
  private readonly shots = new Map<string, Screenshot>();
  private readonly image: HTMLImageElement;
  private readonly controls: {
    name: HTMLElement;
    scale: HTMLSelectElement;
    opacity: HTMLInputElement;
    opacityValue: HTMLElement;
    blend: HTMLElement;
    visible: HTMLElement;
    offset: HTMLElement;
    remove: HTMLElement;
  };
  private artboardId: string | null = null;

  constructor(deps: ScreenshotOverlayDeps) {
    this.deps = deps;
    this.image = document.createElement('img');
    this.image.className = 'dv-screenshot';
    this.image.alt = '';
    this.image.draggable = false;
    deps.bar.innerHTML = BAR_HTML;
    this.controls = {
      name: byId('screenshot-name'),
      scale: byId<HTMLSelectElement>('screenshot-scale'),
      opacity: byId<HTMLInputElement>('screenshot-opacity'),
      opacityValue: byId('screenshot-opacity-value'),
      blend: byId('screenshot-blend'),
      visible: byId('screenshot-visible'),
      offset: byId('screenshot-offset'),
      remove: byId('screenshot-remove'),
    };
    this.bindEvents();
    this.render();
  }

  /** Shows the overlay of the artboard just drawn into the canvas, or none (board view). */
  show(artboardId: string | null): void {
    this.artboardId = artboardId;
    this.render();
  }

  /** Drops the overlays of artboards that are no longer in the file. */
  retain(artboardIds: Set<string>): void {
    for (const [id, shot] of this.shots) {
      if (!artboardIds.has(id)) {
        URL.revokeObjectURL(shot.url);
        this.shots.delete(id);
      }
    }
    this.render();
  }

  async receive(message: Extract<HostMessage, { type: 'screenshot' }>): Promise<void> {
    // Anything but a Uint8Array here means the payload was mangled on the way (see payload.ts).
    if (!(message.data instanceof Uint8Array)) {
      this.deps.notify(`${message.name} could not be read`);
      return;
    }
    await this.load(message.artboardId, message.name, message.data);
  }

  private get current(): Screenshot | undefined {
    return this.artboardId === null ? undefined : this.shots.get(this.artboardId);
  }

  private async load(artboardId: string, name: string, bytes: Uint8Array): Promise<void> {
    let url: string;
    try {
      url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: screenshotType(name, bytes) }));
    } catch (error) {
      this.deps.notify((error as Error).message);
      return;
    }
    const probe = document.createElement('img');
    probe.src = url;
    try {
      await probe.decode();
    } catch {
      URL.revokeObjectURL(url);
      this.deps.notify(`${name} could not be decoded`);
      return;
    }
    const previous = this.shots.get(artboardId);
    if (previous) {
      URL.revokeObjectURL(previous.url);
    }
    const { naturalWidth: width, naturalHeight: height } = probe;
    const scale = guessScale(width, this.deps.artboardWidth(artboardId) ?? width);
    this.shots.set(artboardId, { ...DEFAULTS, ...previous, name, url, width, height, scale, visible: true });
    this.render();
  }

  private async loadFile(artboardId: string, file: File): Promise<void> {
    const name = file.name || 'Pasted image';
    try {
      assertScreenshotSize(name, file.size);
    } catch (error) {
      this.deps.notify((error as Error).message);
      return;
    }
    await this.load(artboardId, name, new Uint8Array(await file.arrayBuffer()));
  }

  private update(change: Partial<ScreenshotSettings>): void {
    const shot = this.current;
    if (shot) {
      Object.assign(shot, change);
      this.render();
    }
  }

  private remove(): void {
    const shot = this.current;
    if (shot && this.artboardId !== null) {
      URL.revokeObjectURL(shot.url);
      this.shots.delete(this.artboardId);
      this.render();
    }
  }

  private render(): void {
    const { bar, canvas, loadButton } = this.deps;
    const shot = this.current;
    loadButton.hidden = this.artboardId === null;
    bar.hidden = !shot;
    if (!shot) {
      this.image.remove();
      return;
    }
    if (this.image.parentElement !== canvas) {
      canvas.append(this.image);
    }
    if (this.image.getAttribute('src') !== shot.url) {
      this.image.src = shot.url;
    }
    this.image.hidden = !shot.visible;
    this.image.classList.toggle('difference', shot.difference);
    this.image.style.opacity = String(shot.opacity);
    this.image.style.transform = screenshotTransform(shot);

    const { controls } = this;
    controls.name.textContent = shot.name;
    controls.name.title = `${shot.name} — ${shot.width} × ${shot.height} px`;
    controls.scale.value = String(shot.scale);
    controls.opacity.value = String(Math.round(shot.opacity * 100));
    controls.opacityValue.textContent = `${Math.round(shot.opacity * 100)}%`;
    controls.blend.setAttribute('aria-pressed', String(shot.difference));
    controls.visible.textContent = shot.visible ? 'Hide' : 'Show';
    controls.offset.textContent = `${shot.x}, ${shot.y}`;
  }

  private bindEvents(): void {
    const { controls } = this;
    this.deps.loadButton.addEventListener('click', () => {
      if (this.artboardId !== null) {
        this.deps.requestPick(this.artboardId);
      }
    });
    controls.scale.addEventListener('change', () => this.update({ scale: Number(controls.scale.value) }));
    controls.opacity.addEventListener('input', () => this.update({ opacity: Number(controls.opacity.value) / 100 }));
    controls.blend.addEventListener('click', () => this.update({ difference: !this.current?.difference }));
    controls.visible.addEventListener('click', () => this.update({ visible: !this.current?.visible }));
    controls.remove.addEventListener('click', () => this.remove());

    window.addEventListener('keydown', (event) => {
      const nudge = nudgeFor(event.key, event.shiftKey);
      const shot = this.current;
      if (!nudge || !shot?.visible || event.metaKey || event.ctrlKey || event.altKey || isTyping(event) || (event.target as Element | null)?.tagName === 'SELECT') {
        return;
      }
      this.update({ x: shot.x + nudge.dx, y: shot.y + nudge.dy });
      event.preventDefault();
    });

    document.addEventListener('paste', (event) => {
      const file = [...(event.clipboardData?.files ?? [])].find((item) => item.type.startsWith('image/'));
      const target = event.target as HTMLElement | null;
      const intoTextField = target?.isContentEditable === true || target?.matches?.('textarea, input:not([type="range"])') === true;
      if (!file || this.artboardId === null || intoTextField) {
        return;
      }
      event.preventDefault();
      void this.loadFile(this.artboardId, file);
    });

    // VS Code hands a file drag to the webview only while Shift is held (otherwise it opens the file); cancelling
    // dragover is what lets the drop happen in a plain browser.
    const { dropTarget } = this.deps;
    const draggingFiles = (event: DragEvent) => this.artboardId !== null && event.dataTransfer?.types.includes('Files') === true;
    for (const type of ['dragenter', 'dragover'] as const) {
      dropTarget.addEventListener(type, (event) => {
        if (draggingFiles(event) && event.dataTransfer) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      });
    }
    dropTarget.addEventListener('drop', (event) => {
      const file = [...(event.dataTransfer?.files ?? [])].find((item) => item.type.startsWith('image/'));
      if (!draggingFiles(event) || this.artboardId === null) {
        return;
      }
      event.preventDefault();
      if (file) {
        void this.loadFile(this.artboardId, file);
      } else {
        this.deps.notify('Drop a PNG, JPEG or WebP image');
      }
    });
  }
}
