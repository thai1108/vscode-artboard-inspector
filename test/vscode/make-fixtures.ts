// Writes the files the VS Code suite opens: the synthetic demo .xd and its earlier version, a small synthetic .fig and
// its earlier version, screenshots to overlay, and an oversized design file.
import { execFileSync } from 'node:child_process';
import { mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { SCREENSHOT_MAX_BYTES } from '../../src/screenshot.ts';
import { at, buildFig, documentNodes, node, solid } from '../support/figFixture.ts';
import { bandedPng } from '../support/png.ts';

const out = path.resolve(import.meta.dirname, '../../dist-test/vscode/workspace');
mkdirSync(out, { recursive: true });
const sample = path.resolve(import.meta.dirname, '../../scripts/sample-xd.ts');
execFileSync(process.execPath, [sample, path.join(out, 'sample-store.xd')], { stdio: 'ignore' });
execFileSync(process.execPath, [sample, path.join(out, 'sample-store-v1.xd'), '--earlier'], { stdio: 'ignore' });
/** The earlier version has the button 20 px higher and green. */
const login = (buttonY: number, color: [number, number, number]) =>
  buildFig(
    documentNodes([
      node(10, 1, 'FRAME', { name: 'Login', size: { x: 390, y: 844 }, transform: at(0, 0), fillPaints: [solid(1, 1, 1)] }),
      node(11, 10, 'RECTANGLE', { name: 'Button', size: { x: 200, y: 48 }, transform: at(95, buttonY), fillPaints: [solid(...color)], cornerRadius: 24 }),
    ]),
  );
writeFileSync(path.join(out, 'sample.fig'), login(600, [0.15, 0.39, 0.92]));
writeFileSync(path.join(out, 'sample-v1.fig'), login(580, [0.13, 0.66, 0.38]));
// Sparse, like oversized.png below.
writeFileSync(path.join(out, 'oversized.xd'), '');
truncateSync(path.join(out, 'oversized.xd'), 300 * 1024 * 1024 + 1);
writeFileSync(path.join(out, 'login@2x.png'), bandedPng(780, 1688));
writeFileSync(path.join(out, 'notes.png'), 'not an image');
// Sparse, so the oversized file costs no disk space.
writeFileSync(path.join(out, 'oversized.png'), '');
truncateSync(path.join(out, 'oversized.png'), SCREENSHOT_MAX_BYTES + 1);
console.log(`Wrote VS Code test fixtures to ${out}`);
