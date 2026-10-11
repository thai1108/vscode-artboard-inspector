import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { guessScale, nudgeFor, screenshotTransform } from '../../src/webview/screenshot.ts';

describe('screenshot overlay geometry', () => {
  it('guesses the retina scale from the image and artboard widths', () => {
    assert.equal(guessScale(390, 390), 1);
    assert.equal(guessScale(1440, 1440), 1);
    assert.equal(guessScale(750, 375), 2);
    assert.equal(guessScale(2880, 1440), 2);
    assert.equal(guessScale(1179, 393), 3);
    assert.equal(guessScale(1170, 390), 3);
    // Cropped or odd captures still pick the nearest factor.
    assert.equal(guessScale(800, 430), 2);
    assert.equal(guessScale(5000, 390), 3);
    assert.equal(guessScale(200, 390), 1);
  });

  it('falls back to 1x when nothing is known about the sizes', () => {
    assert.equal(guessScale(0, 390), 1);
    assert.equal(guessScale(0, 0), 1);
  });

  it('places the image at its offset in design pixels and shrinks it by the scale', () => {
    assert.equal(screenshotTransform({ x: 0, y: 0, scale: 1 }), 'translate(0px, 0px) scale(1)');
    assert.equal(screenshotTransform({ x: -3, y: 12, scale: 2 }), 'translate(-3px, 12px) scale(0.5)');
    assert.match(screenshotTransform({ x: 0, y: 0, scale: 3 }), /scale\(0\.333/);
  });

  it('nudges by 1 px with the arrow keys and by 10 px with Shift', () => {
    assert.deepEqual(nudgeFor('ArrowLeft', false), { dx: -1, dy: 0 });
    assert.deepEqual(nudgeFor('ArrowRight', false), { dx: 1, dy: 0 });
    assert.deepEqual(nudgeFor('ArrowUp', true), { dx: 0, dy: -10 });
    assert.deepEqual(nudgeFor('ArrowDown', true), { dx: 0, dy: 10 });
    assert.equal(nudgeFor('a', false), null);
    assert.equal(nudgeFor('Enter', true), null);
  });
});
