const GENERIC_WIDTH: Record<string, number> = { monospace: 8, serif: 9 };

/**
 * Stands in for `document.createElement('canvas')` so fonts.ts can run under node:test: a family listed in
 * `installed` measures differently from the generic fallback, everything else measures like the fallback.
 */
export function installFakeCanvas(installed: ReadonlySet<string>): void {
  const context = {
    font: '',
    measureText(text: string) {
      const [, family, generic = 'serif'] = /^\d+px (?:"([^"]+)", )?(\w+)$/.exec(this.font) ?? [];
      const width = family && installed.has(family) ? 10 : (GENERIC_WIDTH[generic] ?? 9);
      return { width: text.length * width };
    },
  };
  (globalThis as unknown as { document: unknown }).document = { createElement: () => ({ getContext: () => context }) };
}
