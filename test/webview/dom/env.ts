// Boots the real webview bundle sources (src/webview/main.ts) in a happy-dom window with a fake VS Code host.
// Layout APIs (getBBox/getCTM, element sizes) are not real here, so these tests cover DOM wiring and state,
// not geometry; geometry is covered by the Playwright suite (test/e2e).
import { Window } from 'happy-dom';
import type { HostMessage, WebviewMessage } from '../../../src/protocol.ts';
import type { ViewerState } from '../../../src/webview/vscodeApi.ts';
import { deserializeInWebview, serializeForWebview } from '../../support/vscodeWebviewSerializer.ts';

export interface FakeHost {
  window: Window;
  posted: WebviewMessage[];
  state: ViewerState | undefined;
  blobs: Blob[];
  /** Delivers a host message the way VS Code does (serialize in the extension host, revive in the webview). */
  deliver(message: HostMessage): void;
  /** Waits until `predicate` holds, failing after `timeoutMs`. */
  until(predicate: () => boolean, what: string, timeoutMs?: number): Promise<void>;
  last<T extends WebviewMessage['type']>(type: T): Extract<WebviewMessage, { type: T }> | undefined;
  $<E extends Element = HTMLElement>(selector: string): E;
  $$(selector: string): Element[];
  click(target: Element): void;
  key(key: string): void;
  close(): Promise<void>;
}

const GLOBALS = [
  'window',
  'document',
  'HTMLElement',
  'SVGElement',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
  'MessageEvent',
  'CSS',
  'ResizeObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
  'DOMMatrix',
] as const;

export async function bootWebview(options: { state?: ViewerState; viewport?: { width: number; height: number } } = {}): Promise<FakeHost> {
  const window = new Window({ url: 'https://webview.test/', width: 1400, height: 900 });
  const scope = globalThis as unknown as Record<string, unknown>;
  const source = window as unknown as Record<string, unknown>;
  for (const name of GLOBALS) {
    scope[name] = name === 'window' ? window : source[name];
  }
  const document = window.document as unknown as Document;
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve(), check: () => true } });
  document.body.innerHTML = '<div id="app"></div>';

  const blobs: Blob[] = [];
  const createObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob: Blob) => {
    blobs.push(blob);
    return createObjectURL(blob);
  };

  const host: FakeHost = {
    window,
    posted: [],
    state: options.state,
    blobs,
    deliver(message) {
      const data = deserializeInWebview(serializeForWebview(message));
      window.dispatchEvent(new window.MessageEvent('message', { data }));
    },
    async until(predicate, what, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    last(type) {
      return [...host.posted].reverse().find((message) => message.type === type) as never;
    },
    $(selector) {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error(`No element matches ${selector}`);
      }
      return element as never;
    },
    $$(selector) {
      return [...document.querySelectorAll(selector)];
    },
    click(target) {
      target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as unknown as Event);
    },
    key(key) {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
    },
    async close() {
      await window.happyDOM.close();
    },
  };

  scope['acquireVsCodeApi'] = () => ({
    postMessage: (message: WebviewMessage) => host.posted.push(structuredClone(message)),
    getState: () => host.state,
    setState: (state: ViewerState) => {
      host.state = structuredClone(state);
    },
  });

  await import('../../../src/webview/main.ts');

  // happy-dom does no layout; give the stage a size so fitting and board culling behave like a real webview.
  const size = options.viewport ?? { width: 1000, height: 760 };
  const stage = document.getElementById('viewport');
  if (stage) {
    Object.defineProperty(stage, 'clientWidth', { value: size.width });
    Object.defineProperty(stage, 'clientHeight', { value: size.height });
  }
  return host;
}
