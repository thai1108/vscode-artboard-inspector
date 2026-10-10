// Writes the files the VS Code suite opens: the synthetic demo .xd and a small synthetic .fig.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { at, buildFig, documentNodes, node, solid } from '../support/figFixture.ts';

const out = path.resolve(import.meta.dirname, '../../dist-test/vscode/workspace');
mkdirSync(out, { recursive: true });
execFileSync(process.execPath, [path.resolve(import.meta.dirname, '../../scripts/sample-xd.ts'), path.join(out, 'sample-store.xd')], { stdio: 'ignore' });
writeFileSync(
  path.join(out, 'sample.fig'),
  buildFig(
    documentNodes([
      node(10, 1, 'FRAME', { name: 'Login', size: { x: 390, y: 844 }, transform: at(0, 0), fillPaints: [solid(1, 1, 1)] }),
      node(11, 10, 'RECTANGLE', { name: 'Button', size: { x: 200, y: 48 }, transform: at(95, 600), fillPaints: [solid(0.15, 0.39, 0.92)], cornerRadius: 24 }),
    ]),
  ),
);
console.log(`Wrote VS Code test fixtures to ${out}`);
