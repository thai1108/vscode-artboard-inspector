# Changelog

## 0.4.0

- Compare versions (toolbar "Compare…"): pick the earlier `.xd`/`.fig` of the same design to see which artboards
  were added, removed or changed, with changed-layer counts and a "Changed only" filter. On the canvas added layers
  are outlined in green, changed ones in amber and removed ones as dashed ghosts; Before/After (`` ` ``) shows the
  other version, and the inspector lists each change as before → after. Swap and Exit from the compare bar.
- Releases are also published to Open VSX (for Cursor, Windsurf, VSCodium), and an existing release can be published
  there with a manual workflow run.

## 0.3.0

- Screenshot overlay (toolbar "Overlay", paste, or Shift+drop): a PNG/JPEG/WebP capture drawn over the artboard at
  1x/2x/3x, with opacity, difference blend, show/hide and arrow-key nudging, to compare an implementation with the
  design. Kept in memory per artboard.
- Export from the inspector: save an embedded image exactly as stored, or export a layer as a standalone SVG or as
  PNG at 1x/2x/3x. VS Code asks where to save; file names and bytes are checked before anything is written.
- Tailwind CSS v4 classes next to the CSS, written from the same values: theme utilities when they match exactly,
  arbitrary values otherwise.
- Search (`Cmd/Ctrl+F`) across the text and layer names of every artboard, ignoring case and character width
  (Japanese included); choosing a result opens its artboard and selects the layer.
- Fix: inside VS Code the viewer was inset 20 px left and right by VS Code's default webview padding.
- Releases: pushing a `v*` tag builds the `.vsix` and creates the GitHub Release with it.

## 0.2.0

- Open Figma local copies (`.fig`) offline: pages' frames (and frames in sections) as artboards, frames with clipping,
  per-corner radii and per-side borders, vectors from Figma's outline data, text laid out with Figma's glyph
  positions, instances expanded from their components with overrides, images, gradients, drop shadows and masks.
- Same safety limits as for `.xd` files: capped decompression and ZIP sizes, layer counts, nesting, instance
  recursion and text runs; corrupt numbers are replaced with safe defaults.
- Board view (toolbar "Board" or `B`): all artboards of a page at their positions in one zoom/pan space, with
  titles, a page picker, and inspecting/measuring across artboards; double-click an artboard to open it on its own.
- Board view: artboards are drawn in full at 100% zoom and above however small they are (flying to a small
  frame such as an icon no longer leaves it as a placeholder).
- Fix: embedded images did not display inside VS Code (the image bytes reached the webview as a serialized Node
  Buffer, and each image transferred the whole file). Images are now sent as exactly-sized byte arrays, and any
  image that still arrives undecodable is listed as a layer warning.
- Tests: 205 fast tests (node:test, including happy-dom tests of the webview's DOM wiring), a Playwright suite
  that checks the webview in Chrome through VS Code's message serializer (images must really decode), and
  extension tests inside VS Code that open `.xd` and `.fig` files in the custom editors.

## 0.1.1

- Security: limit decompressed size, layer nesting and linked-layer cycles in malicious files; escape all
  file-provided values in the webview; tighten the webview CSP; validate webview messages.

## 0.1.0

- First release: open `.xd` files in a custom editor with artboard list, layer tree, zoom/pan, inspector
  (position, size, fill, border, radius, shadow, typography, CSS), spacing redlines, missing-font hints and
  automatic reload when the file changes.
