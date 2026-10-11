// End-to-end checks of the real webview bundle in Chrome, through the browser preview whose mock host replays
// VS Code's message serializer. Runs on the synthetic demo; set E2E_FILES (paths joined by the OS path
// delimiter) to run the generic checks on your own .xd/.fig files too, and E2E_EXPORT_DIR to keep what they export.
import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { imageSize } from '../../src/image.ts';
import { decodePng, exportButton, exportWith, expectStandaloneSvg, findExportLayers, openSvg, originalImage, selectLayerByKey, type SavedFile } from './exportChecks.ts';
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
