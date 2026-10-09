# Changelog

## 0.2.0

- Open Figma local copies (`.fig`) offline: pages' frames (and frames in sections) as artboards, frames with clipping,
  per-corner radii and per-side borders, vectors from Figma's outline data, text laid out with Figma's glyph
  positions, instances expanded from their components with overrides, images, gradients, drop shadows and masks.
- Same safety limits as for `.xd` files: capped decompression and ZIP sizes, layer counts, nesting, instance
  recursion and text runs; corrupt numbers are replaced with safe defaults.

## 0.1.1

- Security: limit decompressed size, layer nesting and linked-layer cycles in malicious files; escape all
  file-provided values in the webview; tighten the webview CSP; validate webview messages.

## 0.1.0

- First release: open `.xd` files in a custom editor with artboard list, layer tree, zoom/pan, inspector
  (position, size, fill, border, radius, shadow, typography, CSS), spacing redlines, missing-font hints and
  automatic reload when the file changes.
