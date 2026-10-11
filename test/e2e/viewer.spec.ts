// End-to-end checks of the real webview bundle in Chrome, through the browser preview whose mock host replays
// VS Code's message serializer. Runs on the synthetic demo; set E2E_FILES (paths joined by the OS path
// delimiter) to run the generic checks on your own .xd/.fig files too.
import { expect, test, type Page } from '@playwright/test';
import * as path from 'node:path';
import { bandedPng } from '../support/png.ts';
import { buildSampleXd, servePreview, type PreviewSite } from './preview-server.ts';

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

  test.beforeAll(async () => {
    site = await servePreview(buildSampleXd());
  });
  test.afterAll(() => site.close());

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
});

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
  });
}
