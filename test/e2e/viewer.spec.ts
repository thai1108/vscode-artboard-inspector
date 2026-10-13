// End-to-end checks of the real webview bundle in Chrome, through the browser preview whose mock host replays
// VS Code's message serializer. Runs on the synthetic demo; set E2E_FILES (paths joined by the OS path
// delimiter) to run the generic checks on your own .xd/.fig files too, and E2E_EXPORT_DIR to keep what they export.
// E2E_COMPARE lists pairs of versions the same way, earlier then later: "v1.xd:v2.xd:old.fig:new.fig".
import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { imageSize } from '../../src/image.ts';
import { bandedPng } from '../support/png.ts';
import { decodePng, exportButton, exportWith, expectStandaloneSvg, findExportLayers, openSvg, originalImage, selectLayerByKey, type SavedFile } from './exportChecks.ts';
import { buildSampleXd, removeSample, servePreview, type PreviewSite } from './preview-server.ts';

/** Console errors, CSP violations and uncaught exceptions seen by the page. */
function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || /Content Security Policy|Refused to/i.test(message.text())) {
      problems.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      problems.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return problems;
}

interface ImageReport {
  images: number;
  broken: string[];
  unreferenced: number;
}

/** Decodes every <image> drawn on the canvas and checks its pattern is used by a shape. */
async function imageReport(page: Page): Promise<ImageReport> {
  return page.evaluate(async () => {
    const canvas = document.getElementById('canvas');
    const images = [...(canvas?.querySelectorAll('svg image') ?? [])];
    const broken: string[] = [];
    let unreferenced = 0;
    for (const image of images) {
      const href = image.getAttribute('href') ?? '';
      const width = await new Promise<number>((resolve) => {
        const probe = new Image();
        probe.onload = () => resolve(probe.naturalWidth);
        probe.onerror = () => resolve(0);
        probe.src = href;
      });
      if (!href.startsWith('blob:') || width <= 0) {
        broken.push(href.slice(0, 60) || '(empty href)');
      }
      const pattern = image.closest('pattern');
      const svg = image.closest('svg');
      if (!pattern || !svg?.querySelector(`[fill="url(#${CSS.escape(pattern.id)})"]`)) {
        unreferenced += 1;
      }
    }
    return { images: images.length, broken, unreferenced };
  });
}

async function expectImagesLoaded(page: Page, minimum = 1): Promise<number> {
  const report = await imageReport(page);
  expect(report.images, 'images drawn on the canvas').toBeGreaterThanOrEqual(minimum);
  expect(report.broken, 'images that failed to decode').toEqual([]);
  expect(report.unreferenced, 'image patterns not used by any shape').toBe(0);
  return report.images;
}

function layoutValue(page: Page, label: string) {
  return page.locator('.insp-section', { has: page.locator('h3', { hasText: /^Layout$/ }) }).locator('.prop', { has: page.locator('.prop-label', { hasText: new RegExp(`^${label}$`) }) }).locator('.prop-value');
}

function layerRowIn(page: Page, groupName: string, layerName: string) {
  return page.locator(`#layers li.layer:has(> .layer-row:has-text("${groupName}")) .layer-row`, { hasText: layerName });
}

/** Where the overlay image sits relative to the artboard, in design pixels at the current zoom. */
async function overlayPlacement(page: Page, artboardWidth: number) {
  return page.evaluate((designWidth) => {
    const artboard = document.querySelector('#canvas svg.dv-artboard')?.getBoundingClientRect();
    const shot = document.querySelector('#canvas img.dv-screenshot')?.getBoundingClientRect();
    if (!artboard || !shot) {
      throw new Error('artboard or screenshot missing');
    }
    const zoom = artboard.width / designWidth;
    return { zoom, x: (shot.x - artboard.x) / zoom, y: (shot.y - artboard.y) / zoom, width: shot.width / zoom, height: shot.height / zoom };
  }, artboardWidth);
}

/**
 * VS Code injects a default stylesheet into every webview (webview/browser/pre/index.html in VS Code 1.141); its body
 * padding would inset the viewer and its image rule would shrink an overlay taller than the artboard. Adopted, because
 * the page's CSP refuses inline styles.
 */
async function adoptVsCodeDefaults(page: Page) {
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      '@layer vscode-default { body { margin: 0; padding: 0 20px; } img, video { max-width: 100%; max-height: 100%; } }',
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
}

async function expectOverlayAt(page: Page, expected: { x: number; y: number; width: number; height: number }) {
  const placement = await overlayPlacement(page, 430);
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(placement[key] - expected[key]), `${key} at zoom ${placement.zoom.toFixed(3)}: ${placement[key]}`).toBeLessThan(0.5);
  }
}

test.describe('synthetic demo', () => {
  let site: PreviewSite;
  let sample: string;

  test.beforeAll(async () => {
    sample = buildSampleXd();
    site = await servePreview(sample);
  });
  test.afterAll(async () => {
    await site.close();
    removeSample(sample);
  });

  test('single view: renders, inspects, measures, zooms, with images and no console or CSP errors', async ({ page }) => {
    const problems = watchProblems(page);
    await page.goto(site.url);
    await expect(page.locator('#artboard-title')).toHaveText('Home 430 × 932');
    await expect(page.locator('#artboards .artboard-item')).toHaveCount(3);
    expect(await expectImagesLoaded(page)).toBe(1);

    await adoptVsCodeDefaults(page);
    const appBox = await page.locator('#app').boundingBox();
    expect(appBox?.x).toBe(0);
    expect(appBox?.width).toBe(page.viewportSize()?.width);

    await page.locator('#layers .layer-row', { hasText: 'Card / Ceramic Mug' }).locator('[data-toggle]').click();
    await layerRowIn(page, 'Card / Ceramic Mug', 'Card background').click();
    await expect(page.locator('.insp-title')).toHaveText('Card background');
    await expect(layoutValue(page, 'X')).toHaveText('16');
    await expect(layoutValue(page, 'Y')).toHaveText('344');
    await expect(layoutValue(page, 'W')).toHaveText('191');
    await expect(layoutValue(page, 'H')).toHaveText('236');
    await expect(page.locator('#inspector pre.css')).toContainText('border-radius: 12px;');

    await page.locator('#layers .layer-row', { hasText: 'Card / Linen Tote' }).locator('[data-toggle]').click();
    await layerRowIn(page, 'Card / Linen Tote', 'Card background').hover();
    await expect(page.locator('#overlay .ov-distance text')).toHaveText(['16']);

    await page.locator('#canvas').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('1');
    await expect(page.locator('#zoom-value')).toHaveText('100%');
    await page.locator('#fit-all').click();
    const viewport = await page.locator('#viewport').boundingBox();
    const artboard = await page.locator('#canvas svg.dv-artboard').boundingBox();
    expect(viewport && artboard).toBeTruthy();
    if (viewport && artboard) {
      expect(artboard.height).toBeLessThanOrEqual(viewport.height);
      expect(artboard.y).toBeGreaterThanOrEqual(viewport.y);
    }
    await expect(page.locator('#zoom-value')).not.toHaveText('100%');
    expect(problems).toEqual([]);
  });

  test('screenshot overlay: load, opacity, difference, nudge, zoom alignment, per artboard, remove', async ({ page }) => {
    const problems = watchProblems(page);
    await page.goto(site.url);
    await expect(page.locator('#artboard-title')).toHaveText('Home 430 × 932');
    await expect(page.locator('#screenshot-bar')).toBeHidden();
    await adoptVsCodeDefaults(page);

    // A 2x capture of the 430 × 932 artboard.
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#screenshot-load').click();
    await (await chooser).setFiles({ name: 'home@2x.png', mimeType: 'image/png', buffer: bandedPng(860, 1864) });
    await expect(page.locator('#screenshot-bar')).toBeVisible();
    await expect(page.locator('#screenshot-name')).toHaveText('home@2x.png');
    await expect(page.locator('#screenshot-scale')).toHaveValue('2');
    const shot = page.locator('#canvas img.dv-screenshot');
    await expect(shot).toBeVisible();
    await expect(shot).toHaveCSS('opacity', '0.5');
    await expect(shot).toHaveCSS('pointer-events', 'none');
    await expectOverlayAt(page, { x: 0, y: 0, width: 430, height: 932 });

    await page.locator('#screenshot-opacity').fill('80');
    await expect(shot).toHaveCSS('opacity', '0.8');
    await expect(page.locator('#screenshot-opacity-value')).toHaveText('80%');
    await page.locator('#screenshot-blend').click();
    await expect(shot).toHaveCSS('mix-blend-mode', 'difference');
    await expect(page.locator('#screenshot-blend')).toHaveAttribute('aria-pressed', 'true');

    // Layers are still picked and measured through the screenshot.
    const button = await page.locator('#canvas svg.dv-artboard').boundingBox();
    expect(button).toBeTruthy();
    const zoom = (button?.width ?? 430) / 430;
    await page.mouse.click((button?.x ?? 0) + 40 * zoom, (button?.y ?? 0) + 738 * zoom);
    await expect(page.locator('.insp-title')).toHaveText('Button background');

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('#screenshot-offset')).toHaveText('3, 9');
    await expectOverlayAt(page, { x: 3, y: 9, width: 430, height: 932 });
    for (const key of ['1', '+', '+', '-', 'w', '0']) {
      await page.keyboard.press(key);
      await expectOverlayAt(page, { x: 3, y: 9, width: 430, height: 932 });
    }
    await page.locator('#viewport').hover();
    await page.mouse.wheel(0, 120);
    await expectOverlayAt(page, { x: 3, y: 9, width: 430, height: 932 });

    await page.locator('#screenshot-scale').selectOption('1');
    await expectOverlayAt(page, { x: 3, y: 9, width: 860, height: 1864 });
    await page.locator('#screenshot-scale').selectOption('2');

    await page.locator('#screenshot-visible').click();
    await expect(shot).toBeHidden();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#screenshot-offset')).toHaveText('3, 9');
    await page.locator('#screenshot-visible').click();
    await expect(shot).toBeVisible();

    await page.locator('#artboards .artboard-item', { hasText: 'Cart' }).click();
    await expect(page.locator('#artboard-title')).toHaveText('Cart 430 × 932');
    await expect(page.locator('#screenshot-bar')).toBeHidden();
    await expect(shot).toHaveCount(0);
    await page.locator('#artboards .artboard-item', { hasText: 'Home' }).click();
    await expect(page.locator('#artboard-title')).toHaveText('Home 430 × 932');
    await expect(page.locator('#screenshot-offset')).toHaveText('3, 9');
    await expect(shot).toHaveCSS('opacity', '0.8');

    await page.locator('#mode-board').click();
    await expect(page.locator('#screenshot-load')).toBeHidden();
    await expect(shot).toHaveCount(0);
    await page.keyboard.press('b');
    await expect(shot).toBeVisible();

    await page.locator('#screenshot-remove').click();
    await expect(page.locator('#screenshot-bar')).toBeHidden();
    await expect(shot).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test('screenshot overlay: paste, drop, refuse files that are not images', async ({ page }) => {
    const problems = watchProblems(page);
    await page.goto(site.url);
    await expect(page.locator('#artboard-title')).toHaveText('Home 430 × 932');

    await page.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    }, bandedPng(430, 932).toString('base64'));
    await expect(page.locator('#screenshot-name')).toHaveText('image.png');
    await expect(page.locator('#screenshot-scale')).toHaveValue('1');
    await expectOverlayAt(page, { x: 0, y: 0, width: 430, height: 932 });

    const dropped = await page.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([bytes], 'dropped@3x.png', { type: 'image/png' }));
      const canvas = document.getElementById('canvas');
      const over = new DragEvent('dragover', { dataTransfer, bubbles: true, cancelable: true });
      canvas?.dispatchEvent(over);
      canvas?.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
      return over.defaultPrevented;
    }, bandedPng(1290, 600).toString('base64'));
    expect(dropped, 'dragover is cancelled so the drop reaches the webview').toBe(true);
    await expect(page.locator('#screenshot-name')).toHaveText('dropped@3x.png');
    await expect(page.locator('#screenshot-scale')).toHaveValue('3');
    await expectOverlayAt(page, { x: 0, y: 0, width: 430, height: 200 });

    const chooser = page.waitForEvent('filechooser');
    await page.locator('#screenshot-load').click();
    await (await chooser).setFiles({ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
    await expect(page.locator('#toast')).toHaveText('notes.png is not a PNG, JPEG or WebP image');
    await expect(page.locator('#screenshot-name')).toHaveText('dropped@3x.png');
    expect(problems).toEqual([]);
  });

  test('inspector: Tailwind classes next to the CSS for shapes and text, copied through the host', async ({ page }) => {
    const problems = watchProblems(page);
    const copies: string[] = [];
    page.on('console', (message) => {
      if (message.text().startsWith('[copy]')) {
        copies.push(message.text());
      }
    });
    await page.goto(site.url);
    await expect(page.locator('#artboard-title')).toHaveText('Home 430 × 932');
    await page.locator('#layers .layer-row', { hasText: 'Card / Ceramic Mug' }).locator('[data-toggle]').click();
    const css = page.locator('#inspector pre.css');
    const tailwind = page.locator('#inspector pre.tailwind');

    await layerRowIn(page, 'Card / Ceramic Mug', 'Card background').click();
    await expect(css).toHaveText(
      'width: 191px;\nheight: 236px;\nbackground: #FFFFFF;\nborder: 1px solid #E5E7EB;\nborder-radius: 12px;\nbox-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);',
    );
    await expect(tailwind).toHaveText('w-[191px] h-59 bg-[#FFFFFF] border border-[#E5E7EB] rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.08)]');
    await page.locator('#inspector button', { hasText: 'Copy Tailwind' }).click();
    await expect(page.locator('#toast')).toHaveText('Copied Tailwind classes');
    await expect.poll(() => copies.at(-1)).toBe(`[copy] Tailwind classes ${await tailwind.textContent()}`);

    await layerRowIn(page, 'Card / Ceramic Mug', 'Thumbnail').click();
    await expect(css).toContainText('background: linear-gradient(180deg, #DBEAFE 0%, #93C5FD 100%);');
    await expect(tailwind).toHaveText('w-[167px] h-32 bg-[linear-gradient(180deg,#DBEAFE_0%,#93C5FD_100%)] rounded-lg');

    await layerRowIn(page, 'Card / Ceramic Mug', '$18.00').click();
    await expect(page.locator('.insp-kind')).toHaveText('Text');
    await expect(css).toContainText('font-size: 16px;\nfont-weight: 700; /* Bold */\ncolor: #2563EB;');
    await expect(tailwind).toHaveText("font-['Helvetica_Neue'] text-[16px] font-bold text-[#2563EB]");
    expect(problems).toEqual([]);
  });

  test('board view: all artboards with titles and images, inspect on the board, double-click back', async ({ page }) => {
    const problems = watchProblems(page);
    await page.goto(site.url);
    await expect(page.locator('#artboard-title')).toHaveText('Home 430 × 932');
    await page.locator('#mode-board').click();
    await expect(page.locator('#board-titles .dv-board-title')).toHaveText(['Home', 'Product detail', 'Cart']);
    await expect(page.locator('#canvas svg.dv-artboard')).toHaveCount(3);
    await expect(page.locator('#board-page')).toBeHidden();
    await expectImagesLoaded(page);

    await page.locator('#board-titles .dv-board-title', { hasText: 'Home' }).click();
    await page.locator('#layers .layer-row', { hasText: 'Card / Ceramic Mug' }).locator('[data-toggle]').click();
    await layerRowIn(page, 'Card / Ceramic Mug', 'Card background').click();
    await expect(page.locator('.insp-title')).toHaveText('Card background');
    await expect(layoutValue(page, 'X')).toHaveText('16');
    await expect(page.locator('.crumbs')).toContainText('Home');

    await page.locator('#board-titles .dv-board-title', { hasText: 'Cart' }).dblclick();
    await expect(page.locator('#artboard-title')).toHaveText('Cart 430 × 932');
    await expect(page.locator('#app')).not.toHaveClass(/board-mode/);
    expect(problems).toEqual([]);
  });

  test('search: finds text in another artboard, opens it and selects the layer', async ({ page }) => {
    const problems = watchProblems(page);
    await page.goto(site.url);
    await expect(page.locator('#artboard-title')).toHaveText('Home 430 × 932');

    await page.keyboard.press('ControlOrMeta+f');
    await expect(page.locator('#search')).toBeFocused();
    await page.keyboard.type('ＤＩＳＨＷＡＳＨＥＲ');
    const hit = page.locator('#search-results .search-hit');
    await expect(hit).toHaveCount(1);
    await expect(hit.locator('.search-hit-name')).toHaveText('your coffee warm. Dishwasher safe.');
    await expect(hit.locator('mark')).toHaveText('Dishwasher');
    await expect(hit.locator('.search-hit-artboard')).toHaveText('Product detail');
    await expect(page.locator('#search-status')).toHaveText('1 result');

    await page.keyboard.press('Enter');
    await expect(page.locator('#artboard-title')).toHaveText('Product detail 430 × 932');
    await expect(page.locator('.insp-title')).toHaveText('your coffee warm. Dishwasher safe.');
    await expect(page.locator('#layers .layer-row.selected')).toHaveText(/your coffee warm/);
    await expect(layoutValue(page, 'X')).toHaveText('16');
    await expect(page.locator('#overlay .ov-selected')).toHaveCount(1);

    // From the board, choosing a hit goes back to the single view.
    await page.locator('#mode-board').click();
    await page.locator('#search').fill('checkout');
    await expect(page.locator('#search-results .search-hit')).toHaveCount(2);
    await page.locator('#search-results .search-hit[data-artboard="artboard-demo-2"]').click();
    await expect(page.locator('#app')).not.toHaveClass(/board-mode/);
    await expect(page.locator('#artboard-title')).toHaveText('Cart 430 × 932');
    await expect(page.locator('.insp-title')).toHaveText('Checkout');
    await expect(page.locator('.crumbs')).toContainText('Primary button');

    await page.locator('#search').press('Escape');
    await expect(page.locator('#search')).toHaveValue('');
    await expect(page.locator('#search-results')).toBeHidden();
    expect(problems).toEqual([]);
  });

  test('export: the embedded image as stored, a standalone SVG, and PNGs with shadows at the chosen scale', async ({ page }) => {
    const problems = watchProblems(page);
    await page.goto(site.url);
    await expect(page.locator('#artboard-title')).toHaveText('Home 430 × 932');

    await page.locator('#layers .layer-row', { hasText: 'Hero image' }).click();
    await expect(page.locator('.insp-title')).toHaveText('Hero image');
    await expect(exportButton(page, 'image')).toHaveText('Save image (PNG)');
    const image = await exportWith(page, exportButton(page, 'image'));
    expect(image.fileName).toBe('Hero image.png');
    expect(image.data.equals(originalImage(site, 0, 'demohero')), 'the original bytes').toBe(true);

    const svg = await exportWith(page, exportButton(page, 'svg'));
    expect(svg.fileName).toBe('Hero image.svg');
    const report = await openSvg(page, svg);
    expectStandaloneSvg(svg, report);
    expect(svg.data.toString('utf8')).toContain('href="data:image/png;base64,');
    expect([report.width, report.height, report.drawn.width, report.drawn.height]).toEqual([398, 200, 398, 200]);

    const png = await exportWith(page, exportButton(page, 'png', 2));
    expect(png.fileName).toBe('Hero image@2x.png');
    expect(imageSize(png.data)).toEqual({ width: 796, height: 400 });
    const centre = await decodePng(page, png);
    expect(centre.pixel[3], 'opaque: the image inside the SVG was drawn').toBe(255);
    expect(centre.pixel.slice(0, 3), 'not the missing-image grey').not.toEqual([217, 217, 217]);

    await page.locator('#layers .layer-row', { hasText: 'Weekend Sale' }).click();
    const text = await openSvg(page, await exportWith(page, exportButton(page, 'svg')));
    expect(text.texts).toEqual([{ fontFamily: expect.stringContaining("'Helvetica Neue'"), fontSize: '28', content: 'Weekend Sale' }]);

    // 191 × 236 with a drop shadow of y 2, blur 8 on every side.
    await page.locator('#layers .layer-row', { hasText: 'Card / Ceramic Mug' }).locator('[data-toggle]').click();
    await layerRowIn(page, 'Card / Ceramic Mug', 'Card background').click();
    const card = await exportWith(page, exportButton(page, 'png', 1));
    expect(card.fileName).toBe('Card background.png');
    expect(imageSize(card.data)).toEqual({ width: 207, height: 252 });
    expect((await decodePng(page, card)).pixel).toEqual([255, 255, 255, 255]);
    expect((await decodePng(page, card, { x: 0, y: 0 })).pixel[3], 'outside the shadow stays transparent').toBe(0);
    expect(problems).toEqual([]);
  });

  test('export from the board view, measured on the board', async ({ page }) => {
    const problems = watchProblems(page);
    await page.goto(site.url);
    await page.locator('#mode-board').click();
    await page.locator('#board-titles .dv-board-title', { hasText: 'Home' }).click();
    await page.locator('#layers .layer-row', { hasText: 'Card / Ceramic Mug' }).locator('[data-toggle]').click();
    await layerRowIn(page, 'Card / Ceramic Mug', 'Card background').click();
    const card = await exportWith(page, exportButton(page, 'png', 3));
    expect(card.fileName).toBe('Card background@3x.png');
    expect(imageSize(card.data)).toEqual({ width: 621, height: 756 });
    expect(problems).toEqual([]);
  });
});

/** The before → after rows of the inspector's Changes section, by label. */
async function changeRows(page: Page): Promise<Record<string, [string, string]>> {
  const rows = await page.locator('#inspector .change-row').evaluateAll((elements) =>
    elements.map((row) => [row.querySelector('.change-label')?.textContent ?? '', row.querySelector('.change-before')?.textContent ?? '', row.querySelector('.change-after')?.textContent ?? '']),
  );
  return Object.fromEntries(rows.map(([label = '', before = '', after = '']) => [label, [before, after]]));
}

/** The changed layers listed in the artboard inspector, opened one after the other. */
function changeList(page: Page) {
  return page.locator('#inspector .change-layer');
}

test.describe('compare versions (synthetic pair)', () => {
  let site: PreviewSite;
  let current: string;
  let earlier: string;

  test.beforeAll(async () => {
    current = buildSampleXd();
    earlier = buildSampleXd({ earlier: true });
    site = await servePreview(current, { compare: earlier });
  });
  test.afterAll(async () => {
    await site.close();
    removeSample(current);
    removeSample(earlier);
  });

  test('compare mode: badges, outlines, before/after, inspector rows, swap, exit, no console or CSP errors', async ({ page }) => {
    const problems = watchProblems(page);
    await page.goto(site.url);
    await expect(page.locator('#artboard-title')).toHaveText('Home 430 × 932');
    await adoptVsCodeDefaults(page);
    await expect(page.locator('#compare-bar')).toBeHidden();

    await page.locator('#compare-start').click();
    await expect(page.locator('#compare-bar')).toBeVisible();
    await expect(page.locator('#compare-start')).toBeHidden();
    await expect(page.locator('#compare-files .compare-file')).toHaveText(['sample-store-v1.xd', 'sample-store.xd']);
    await expect(page.locator('#compare-summary')).toHaveText('Artboards: 1 changed · 1 added · 1 removed · 1 unchanged');
    await expect(page.locator('#artboards .artboard-item')).toHaveText(['Home10430×932', 'Product detail430×932', 'CartNew430×932', 'WishlistRemoved430×932']);
    await page.locator('#compare-changed-only').check();
    await expect(page.locator('#artboards .artboard-item .artboard-name')).toHaveText(['Home', 'Cart', 'Wishlist']);
    await page.locator('#compare-changed-only').uncheck();

    // Outlines in the overlay layer, measured like the selection outline.
    await expect(page.locator('#overlay .ov-diff-added')).toHaveCount(1);
    await expect(page.locator('#overlay .ov-diff-changed')).toHaveCount(8);
    await expect(page.locator('#overlay .ov-diff-removed.ov-diff-ghost')).toHaveCount(1);
    await expect(page.locator('#canvas .ov-diff')).toHaveCount(0);

    await changeList(page).filter({ hasText: 'Card / Linen Tote' }).click();
    await expect(page.locator('.insp-title')).toHaveText('Card / Linen Tote');
    expect(await changeRows(page)).toEqual({ X: ['231', '223'] });
    await expect(layoutValue(page, 'X')).toHaveText('223');
    const selectedOutline = await page.locator('#overlay .ov-selected').evaluate((rect) => ['x', 'y', 'width', 'height'].map((name) => rect.getAttribute(name)));
    const changedOutlines = await page.locator('#overlay .ov-diff-changed').evaluateAll((rects) => rects.map((rect) => ['x', 'y', 'width', 'height'].map((name) => rect.getAttribute(name))));
    expect(changedOutlines).toContainEqual(selectedOutline);

    await page.locator('#layers .layer-row', { hasText: 'Card / Linen Tote' }).locator('[data-toggle]').click();
    await layerRowIn(page, 'Card / Linen Tote', 'Card background').click();
    await expect(page.locator('#inspector .change-status')).toHaveText('Unchanged');

    await page.locator('.crumbs .crumb').first().click();
    await changeList(page).filter({ hasText: 'Weekend Sale' }).click();
    expect(await changeRows(page)).toEqual({ Text: ['Summer Sale', 'Weekend Sale'] });
    await page.locator('.crumbs .crumb').first().click();
    await changeList(page).filter({ hasText: 'Hero image' }).click();
    expect(Object.keys(await changeRows(page))).toEqual(['Image']);

    // Before: the earlier scene with its own image, the removed badge drawn, the added banner a ghost.
    await page.keyboard.press('`');
    await expect(page.locator('#version-tag')).toHaveText('Before');
    await expect(page.locator('#compare-before')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#canvas svg.dv-artboard text', { hasText: 'Summer Sale' })).toHaveCount(1);
    await expect(page.locator('.insp-title')).toHaveText('Hero image', { timeout: 5_000 });
    expect(Object.keys(await changeRows(page))).toEqual(['Image']);
    expect(await expectImagesLoaded(page)).toBe(1);
    await expect(page.locator('#overlay .ov-diff-removed:not(.ov-diff-ghost)')).toHaveCount(1);
    await expect(page.locator('#overlay .ov-diff-added.ov-diff-ghost')).toHaveCount(1);
    await expect(page.locator('#screenshot-load')).toBeHidden();
    await page.locator('.crumbs .crumb').first().click();
    await changeList(page).filter({ hasText: 'Card / Linen Tote' }).click();
    await expect(layoutValue(page, 'X')).toHaveText('231');
    await page.locator('.crumbs .crumb').first().click();
    await changeList(page).filter({ hasText: 'Promo badge' }).click();
    await expect(page.locator('.insp-title')).toHaveText('Promo badge');
    await expect(page.locator('#inspector .change-status')).toContainText('Removed');

    await page.locator('#compare-after').click();
    await expect(page.locator('#version-tag')).toHaveText('After');
    await expect(page.locator('#canvas svg.dv-artboard text', { hasText: 'Weekend Sale' })).toHaveCount(1);
    expect(await expectImagesLoaded(page)).toBe(1);

    // Swap: the earlier file is shown as the current one.
    await page.locator('#compare-swap').click();
    await expect(page.locator('#compare-files .compare-file')).toHaveText(['sample-store.xd', 'sample-store-v1.xd']);
    await expect(page.locator('#artboards .artboard-item')).toHaveText(['Home10430×932', 'Product detail430×932', 'WishlistNew430×932', 'CartRemoved430×932']);
    await expect(page.locator('#canvas svg.dv-artboard text', { hasText: 'Summer Sale' })).toHaveCount(1);
    expect(await expectImagesLoaded(page)).toBe(1);
    await page.locator('#mode-board').click();
    await expect(page.locator('#board-titles .dv-board-title')).toHaveText(['Home10', 'Product detail', 'WishlistNew']);
    await page.keyboard.press('b');

    await page.locator('#compare-exit').click();
    await expect(page.locator('#compare-bar')).toBeHidden();
    await expect(page.locator('#compare-start')).toBeVisible();
    await expect(page.locator('#artboards .artboard-item')).toHaveText(['Home430×932', 'Product detail430×932', 'Cart430×932']);
    await expect(page.locator('#canvas svg.dv-artboard text', { hasText: 'Weekend Sale' })).toHaveCount(1);
    await expect(page.locator('#overlay .ov-diff')).toHaveCount(0);
    expect(await expectImagesLoaded(page)).toBe(1);
    expect(problems).toEqual([]);
  });
});

/** A Japanese phrase from a text layer outside the first artboard, rare enough that its hits are not capped. */
function japanesePhrase(site: PreviewSite): { artboard: string; query: string } | null {
  const all = site.textsByArtboard.flat();
  for (let i = 1; i < site.artboardIds.length; i++) {
    for (const text of site.textsByArtboard[i] ?? []) {
      const query = /[\u3040-\u30ff\u3400-\u9fff]{3,8}/.exec(text)?.[0];
      if (query && all.filter((other) => other.includes(query)).length <= 50) {
        return { artboard: site.artboardIds[i] ?? '', query };
      }
    }
  }
  return null;
}

const extraFiles = (process.env['E2E_FILES'] ?? '').split(path.delimiter).filter(Boolean);

for (const file of extraFiles) {
  test.describe(`design file ${path.basename(file)}`, () => {
    let site: PreviewSite;

    test.beforeAll(async () => {
      site = await servePreview(file);
    });
    test.afterAll(() => site.close());

    test('artboards with images render them in the single view and on the board', async ({ page }) => {
      test.setTimeout(180_000);
      const problems = watchProblems(page);
      await page.goto(site.url);
      await expect(page.locator('#canvas svg.dv-artboard')).toHaveCount(1, { timeout: 30_000 });
      const withImages = site.artboardIds.filter((_, i) => (site.imageUidsByArtboard[i]?.length ?? 0) > 0).slice(0, 4);
      expect(withImages.length, 'artboards with embedded images').toBeGreaterThan(0);

      for (const id of withImages) {
        await page.locator(`#artboards .artboard-item[data-id="${id}"]`).click();
        await expect(page.locator(`#artboards .artboard-item.active[data-id="${id}"]`)).toHaveCount(1);
        await expect(page.locator('#canvas svg.dv-artboard image').first()).toBeAttached({ timeout: 15_000 });
        await expectImagesLoaded(page);
      }

      await page.locator('#mode-board').click();
      // Fitting a whole page can make artboards too small for titles; every artboard of the page is placed though.
      await expect(page.locator('#canvas .dv-board-item').first()).toBeAttached({ timeout: 30_000 });
      const target = withImages[0] ?? '';
      await page.locator(`#artboards .artboard-item[data-id="${target}"]`).click();
      await expect(page.locator(`#artboards .artboard-item.active[data-id="${target}"]`)).toHaveCount(1);
      await expect(page.locator('#board-titles .dv-board-title').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('#canvas svg.dv-artboard image').first()).toBeAttached({ timeout: 30_000 });
      await expectImagesLoaded(page);
      const pages = await page.locator('#board-page option').count();
      if (pages > 1) {
        await expect(page.locator('#board-page')).toBeVisible();
      }
      expect(problems).toEqual([]);
    });

    test('search finds Japanese text in another artboard and selects that layer', async ({ page }) => {
      test.setTimeout(120_000);
      const phrase = japanesePhrase(site);
      test.skip(!phrase, 'no Japanese text outside the first artboard');
      const { artboard, query } = phrase ?? { artboard: '', query: '' };
      const problems = watchProblems(page);
      await page.goto(site.url);
      await expect(page.locator('#canvas svg.dv-artboard')).toHaveCount(1, { timeout: 30_000 });

      await page.keyboard.press('ControlOrMeta+f');
      await expect(page.locator('#search')).toBeFocused();
      await page.keyboard.insertText(query);
      const hit = page.locator(`#search-results .search-hit[data-artboard="${artboard}"]`).first();
      await expect(hit).toBeVisible({ timeout: 30_000 });
      await expect(hit.locator('mark').first()).toBeAttached();
      const key = await hit.getAttribute('data-key');
      await hit.click();
      await expect(page.locator(`#artboards .artboard-item.active[data-id="${artboard}"]`)).toHaveCount(1, { timeout: 30_000 });
      await expect(page.locator(`#layers .layer-row.selected[data-key="${key}"]`)).toHaveCount(1);
      await expect(page.locator('.insp-kind')).not.toHaveText('Artboard');
      expect(problems).toEqual([]);
    });

    test('exports an image layer and a vector layer', async ({ page }) => {
      test.setTimeout(240_000);
      const problems = watchProblems(page);
      const exportDir = process.env['E2E_EXPORT_DIR'];
      // The step keeps the saved original apart from the PNG export of the same layer, which has the same name.
      const keep = (step: string, saved: SavedFile) => {
        if (exportDir) {
          writeFileSync(path.join(exportDir, `${path.basename(file)} - ${step} - ${saved.fileName}`), saved.data);
        }
      };
      await page.goto(site.url);
      await expect(page.locator('#canvas svg.dv-artboard')).toHaveCount(1, { timeout: 30_000 });
      const { image, vector } = findExportLayers(site);
      expect(image, 'a layer filled with an embedded image').toBeTruthy();

      for (const [kind, layer] of [['image', image], ['vector', vector]] as const) {
        if (!layer) {
          continue;
        }
        await selectLayerByKey(page, layer);
        if (layer.uid) {
          const saved = await exportWith(page, exportButton(page, 'image'));
          expect(saved.data.equals(originalImage(site, layer.artboardIndex, layer.uid)), 'the original bytes').toBe(true);
          keep(`${kind} original`, saved);
        }
        const svg = await exportWith(page, exportButton(page, 'svg'));
        const report = await openSvg(page, svg);
        expectStandaloneSvg(svg, report);
        keep(`${kind} svg`, svg);
        const scale = kind === 'image' ? 1 : 2;
        const png = await exportWith(page, exportButton(page, 'png', scale));
        expect(imageSize(png.data)).toEqual({ width: Math.max(1, Math.round(report.width * scale)), height: Math.max(1, Math.round(report.height * scale)) });
        keep(`${kind} png`, png);
      }
      expect(problems).toEqual([]);
    });
  });
}

/** The inspector's Layout values of the selected layer, by label. */
async function layoutValues(page: Page): Promise<Record<string, string>> {
  const props = page.locator('.insp-section', { has: page.locator('h3', { hasText: /^Layout$/ }) }).locator('.prop');
  const pairs = await props.evaluateAll((elements) => elements.map((prop) => [prop.querySelector('.prop-label')?.textContent ?? '', prop.querySelector('.prop-value')?.textContent ?? '']));
  return Object.fromEntries(pairs);
}

/**
 * Opens up to `limit` of the changed layers listed for the artboard shown, and checks that their X/Y/W/H rows give
 * the value the inspector measures for the version on screen. Returns how many layers were checked.
 */
async function checkChangeRows(page: Page, version: 'before' | 'after', limit: number): Promise<number> {
  let checked = 0;
  const count = await changeList(page).count();
  for (let i = 0; i < count && checked < limit; i++) {
    const item = changeList(page).nth(i);
    if (await item.evaluate((element) => element.classList.contains('elsewhere'))) {
      continue;
    }
    const name = (await item.locator('.change-name').textContent()) ?? '';
    await item.click();
    await expect(page.locator('#inspector .changes')).toBeVisible();
    const rows = await changeRows(page);
    const layout = await layoutValues(page);
    for (const label of ['X', 'Y', 'W', 'H']) {
      const values = rows[label];
      if (values) {
        expect(values[version === 'after' ? 1 : 0], `${label} of "${name}" (${version})`).toBe(layout[label]);
      }
    }
    checked++;
    await page.locator('.crumbs .crumb').first().click();
  }
  return checked;
}

const comparePairs = (process.env['E2E_COMPARE'] ?? '').split(path.delimiter).filter(Boolean);

for (let pair = 0; pair + 1 < comparePairs.length; pair += 2) {
  const earlierFile = comparePairs[pair] ?? '';
  const laterFile = comparePairs[pair + 1] ?? '';

  test.describe(`comparing ${path.basename(earlierFile)} → ${path.basename(laterFile)}`, () => {
    let site: PreviewSite;

    test.beforeAll(async () => {
      site = await servePreview(laterFile, { compare: earlierFile });
    });
    test.afterAll(() => site.close());

    test('compares, shows both versions with their images, and the Changes rows agree with the inspector', async ({ page }) => {
      test.setTimeout(300_000);
      const problems = watchProblems(page);
      await page.goto(site.url);
      await expect(page.locator('#canvas svg.dv-artboard')).toHaveCount(1, { timeout: 30_000 });
      await adoptVsCodeDefaults(page);
      await page.locator('#compare-start').click();
      await expect(page.locator('#compare-bar')).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('#compare-files .compare-file')).toHaveText([path.basename(earlierFile), path.basename(laterFile)]);

      await page.locator('#compare-changed-only').check();
      const listed = await page.locator('#artboards .artboard-item').count();
      await expect(page.locator('#artboards .artboard-item .diff-badge')).toHaveCount(listed);
      const changed = page.locator('#artboards .artboard-item:has(.diff-changed)');
      const changedCount = await changed.count();
      let layersChecked = 0;
      for (let i = 0; i < Math.min(3, changedCount); i++) {
        const item = changed.nth(i);
        const id = (await item.getAttribute('data-id')) ?? '';
        await item.click();
        await expect(page.locator(`#artboards .artboard-item.active[data-id="${id}"]`)).toHaveCount(1, { timeout: 30_000 });
        await expect(page.locator('#inspector .changes .change-status').first()).not.toHaveText('Loading…', { timeout: 30_000 });
        await expectImagesLoaded(page, 0);
        layersChecked += await checkChangeRows(page, 'after', 5);
        if (await page.locator('#compare-before').isEnabled()) {
          await page.keyboard.press('`');
          await expect(page.locator('#version-tag')).toHaveText('Before', { timeout: 30_000 });
          await expect(page.locator('#canvas svg.dv-artboard')).toHaveCount(1);
          await expectImagesLoaded(page, 0);
          layersChecked += await checkChangeRows(page, 'before', 3);
          await page.locator('#compare-after').click();
          await expect(page.locator('#version-tag')).toHaveText('After');
        }
      }
      const removed = page.locator('#artboards .artboard-item.removed').first();
      if (await removed.count()) {
        await removed.click();
        await expect(page.locator('#version-tag')).toHaveText('Before', { timeout: 30_000 });
        await expectImagesLoaded(page, 0);
      }
      // Only these runs print: what was found, for whoever compares their own files.
      console.log(`${path.basename(laterFile)}: ${(await page.locator('#compare-summary').textContent()) ?? ''}; ${layersChecked} changed layers checked against the inspector`);

      await page.locator('#compare-swap').click();
      await expect(page.locator('#compare-files .compare-file')).toHaveText([path.basename(laterFile), path.basename(earlierFile)], { timeout: 30_000 });
      await expect(page.locator('#canvas svg.dv-artboard')).toHaveCount(1, { timeout: 30_000 });
      await expectImagesLoaded(page, 0);
      await page.locator('#compare-exit').click();
      await expect(page.locator('#compare-bar')).toBeHidden({ timeout: 30_000 });
      await expect(page.locator('#canvas svg.dv-artboard')).toHaveCount(1, { timeout: 30_000 });
      expect(problems).toEqual([]);
    });
  });
}
