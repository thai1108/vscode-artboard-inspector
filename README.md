# Artboard Inspector

![Selecting a layer and measuring the gap to its neighbour](images/screenshot.png)

Open Adobe XD (`.xd`) files and Figma local copies (`.fig`) in VS Code and inspect them like a developer handoff tool.

- Artboard list with filter, layer tree, zoom/pan canvas
- Click a layer to see position, size, fill, border, radius, shadow, typography and generated CSS; click any value to copy it
- With a layer selected, hover another one (or the artboard background) to see the spacing redlines
- Reloads automatically when the file changes on disk
- Fully offline: the file is unzipped and rendered locally, nothing is uploaded

![Inspecting a text layer: typography, insets to the parent and CSS](images/inspect-text.png)

## Figma files (.fig)

In Figma choose **File → Save local copy…** and open the downloaded `.fig` file in VS Code. Every top-level frame
(also frames inside sections) becomes an artboard, listed as `Page / Section / Frame`. The file is decoded and drawn
locally — no Figma account, token or network access is needed.

## Build from source

Requires Node.js 22.18 or later (the tests and scripts run TypeScript directly) and pnpm 10.

```bash
corepack enable                    # provides the pnpm version pinned in package.json
pnpm install
pnpm package                       # runs all checks, writes artboard-inspector-<version>.vsix
code --install-extension artboard-inspector-0.2.0.vsix
```

## Shortcuts (canvas focused)

| Key | Action |
| --- | --- |
| Scroll / trackpad | Pan |
| Ctrl/Cmd + scroll, pinch | Zoom at the cursor |
| Space + drag, middle drag, drag outside the artboard | Pan |
| `+` / `-` | Zoom in / out |
| `1` | 100% |
| `0` | Fit artboard |
| `W` | Fit width |
| `Esc` | Select the parent layer |

## Limitations

- Text is drawn with the fonts installed locally. Fonts the design uses but this machine lacks are listed as
  "not installed" in the inspector; XD's Windows fallback fonts (Yu Gothic UI) are approximated with proportional
  Japanese metrics.
- Files larger than 300 MB, or with more than 50,000 layers per artboard, are refused or cut off (with a notice) to
  keep VS Code responsive.
- Blur and background-blur effects are not rendered (listed under "Not rendered" in the artboard inspector).
- Figma: layers are redrawn from the file, so they can differ slightly from Figma itself. Layers with several fills
  show only the top one, angular/diamond gradients are drawn as radial ones, and FigJam objects (stickies, widgets)
  are listed as unsupported. Only `.fig` local copies are read — Figma links are not.

## Development

```bash
pnpm watch                            # rebuild on change, then F5 in VS Code to launch the extension host
pnpm check                            # type-check, lint, tests, build
pnpm smoke <file.xd|file.fig>...     # parse and render every artboard, print warnings
pnpm preview <file.xd|file.fig> <dir> # static browser copy of the webview for UI checks
pnpm sample <out.xd>                  # write an original demo design (used for the screenshots above)
```

`pnpm preview` writes the design data to `<out-dir>`; keep it outside the repository.

## Trademarks

Adobe XD is a trademark of Adobe Inc. Figma is a trademark of Figma, Inc. This project is an independent viewer for
`.xd` and `.fig` files and is not affiliated with, sponsored or endorsed by Adobe or Figma. The icon is original
artwork.
