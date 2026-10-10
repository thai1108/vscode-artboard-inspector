// End-to-end checks of the real webview bundle in Chrome, through the browser preview whose mock host replays
// VS Code's message serializer. Runs on the synthetic demo; set E2E_FILES (paths joined by the OS path
// delimiter) to run the generic checks on your own .xd/.fig files too.
import { expect, test, type Page } from '@playwright/test';
import * as path from 'node:path';
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
