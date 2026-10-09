import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { fontsUsed, isFontAvailable } from '../../src/webview/fonts.ts';
import { artboard, group, text, textStyle } from '../support/sceneBuilders.ts';
import { installFakeCanvas } from './support/fakeCanvas.ts';

describe('fonts', () => {
  before(() => installFakeCanvas(new Set(['Fonts Installed', 'Fonts Fallback Installed'])));

  it('detects installed and missing fonts', () => {
    assert.equal(isFontAvailable('Fonts Installed'), true);
    assert.equal(isFontAvailable('Fonts Missing'), false);
  });

  it('lists design fonts first, then XD glyph fallbacks, each once', () => {
    const scene = artboard([
      text({ styles: [textStyle({ family: 'Fonts Missing' })], lines: [{ x: 0, y: 0, runs: [{ text: 'a', style: 0, glyphFont: 'Fonts Fallback Installed' }] }] }),
      group([text({ styles: [textStyle({ family: 'Fonts Installed' }), textStyle({ family: 'Fonts Missing' })] })]),
    ]);
    assert.deepEqual(fontsUsed(scene), [
      { family: 'Fonts Installed', fallback: false, available: true },
      { family: 'Fonts Missing', fallback: false, available: false },
      { family: 'Fonts Fallback Installed', fallback: true, available: true },
    ]);
  });

  it('does not list a glyph fallback that is also a design font', () => {
    const scene = artboard([
      text({ styles: [textStyle({ family: 'Fonts Installed' })], lines: [{ x: 0, y: 0, runs: [{ text: 'a', style: 0, glyphFont: 'Fonts Installed' }] }] }),
    ]);
    assert.deepEqual(fontsUsed(scene).map((font) => font.family), ['Fonts Installed']);
  });

  it('returns nothing for an artboard without text', () => {
    assert.deepEqual(fontsUsed(artboard([])), []);
  });
});
