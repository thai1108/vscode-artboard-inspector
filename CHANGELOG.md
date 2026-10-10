# Changelog

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
