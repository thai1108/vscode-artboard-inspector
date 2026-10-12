import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DesignDocument } from '../src/document.ts';
import { FigDocument } from '../src/fig/parse.ts';
import { searchMessage } from '../src/payload.ts';
import { MESSAGE_LIMITS, parseWebviewMessage } from '../src/protocol.ts';
import type { ArtboardScene, SceneNode } from '../src/scene/scene.ts';
import { buildSearchIndex, excerpt, normalizeForSearch, search, SEARCH_LIMITS, type SearchHit } from '../src/search.ts';
import type { AgcNode } from '../src/xd/agc.ts';
import { at, buildFig, documentNodes, guid, node } from './support/figFixture.ts';
import { artboard, group, shape, text } from './support/sceneBuilders.ts';
import { deserializeInWebview, serializeForWebview } from './support/vscodeWebviewSerializer.ts';
import { buildXd } from './support/xdFixture.ts';

/** A design whose artboards are the given scenes; ids in `broken` fail to convert. */
function designOf(scenes: ArtboardScene[], broken: string[] = []): Pick<DesignDocument, 'artboards' | 'scene'> {
  return {
    artboards: [...scenes, ...broken.map((id) => ({ id }))].map(({ id }) => ({ id, name: id, width: 100, height: 100 })),
    scene(id) {
      const scene = scenes.find((candidate) => candidate.id === id);
      if (!scene) {
        throw new Error(`Unknown artboard: ${id}`);
      }
      return scene;
    },
  };
}

const plain = (hit: SearchHit | undefined) => hit && { name: hit.name, text: hit.text };

function findNode(nodes: SceneNode[], key: string): SceneNode | undefined {
  for (const candidate of nodes) {
    const found = candidate.key === key ? candidate : candidate.kind === 'group' ? findNode(candidate.children, key) : undefined;
    if (found) {
      return found;
    }
  }
  return undefined;
}

describe('normalizeForSearch', () => {
  it('folds case, full-width Latin and whitespace runs', () => {
    assert.equal(normalizeForSearch('ＡＢＣ　Def\n\tGHI'), 'abc def ghi');
    assert.equal(normalizeForSearch('Hello  World'), 'hello world');
  });

  it('turns half-width katakana into full-width, voicing marks included', () => {
    assert.equal(normalizeForSearch('ﾊﾟｽﾜｰﾄﾞ'), 'パスワード');
    assert.equal(normalizeForSearch('ｶﾞｲﾄﾞ'), normalizeForSearch('ガイド'));
  });

  it('keeps Japanese text and expands compatibility characters', () => {
    assert.equal(normalizeForSearch('ご利用ガイド'), 'ご利用ガイド');
    assert.equal(normalizeForSearch('㍿'), '株式会社');
  });
});

describe('excerpt', () => {
  it('maps a match in the normalized form back to the original characters', () => {
    const result = excerpt('ご利用ｶﾞｲﾄﾞを見る', normalizeForSearch('ガイド'));
    assert.deepEqual(result, { text: 'ご利用ｶﾞｲﾄﾞを見る', match: [3, 8] });
    assert.equal(result.text.slice(3, 8), 'ｶﾞｲﾄﾞ');
  });

  it('puts line breaks on one line and matches across them', () => {
    assert.deepEqual(excerpt('Line one\nLine two', 'one line'), { text: 'Line one Line two', match: [5, 13] });
  });

  it('cuts long text around the match without splitting a surrogate pair', () => {
    const result = excerpt(`${'x'.repeat(100)} 😀 match ${'y'.repeat(100)}`, 'match');
    assert.ok(result.text.startsWith('…') && result.text.endsWith('…'));
    assert.ok(result.text.length <= 82);
    assert.ok(result.match);
    assert.equal(result.text.slice(...result.match), 'match');
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(result.text), 'no lone surrogates');
  });

  it('cuts the start only when the text before the match is too wide for the sidebar (CJK counts double)', () => {
    const japanese = excerpt('セキュリティのため、定期的にパスワードを変更してください。', normalizeForSearch('パスワード'));
    assert.deepEqual(japanese, { text: '…め、定期的にパスワードを変更してください。', match: [7, 12] });
    assert.deepEqual(excerpt('The quick brown fox jumps over the lazy dog', 'lazy'), { text: '…jumps over the lazy dog', match: [16, 20] });
    assert.deepEqual(excerpt('Hand-glazed stoneware mug that keeps', 'mug'), { text: 'Hand-glazed stoneware mug that keeps', match: [22, 25] });
  });

  it('shows the start without a highlight when the text does not contain the query', () => {
    assert.deepEqual(excerpt('Title', 'mug'), { text: 'Title', match: null });
    assert.deepEqual(excerpt('a'.repeat(100), 'b', 10), { text: `${'a'.repeat(10)}…`, match: null });
  });
});

describe('buildSearchIndex and search', () => {
  const home = artboard(
    [
      shape({ name: 'Background' }),
      group([text({ name: 'Title', content: 'Ceramic MUG' }), shape({ name: 'Mug photo' })], { name: 'Card' }),
      text({ name: '', content: 'Free mug\nwith every order' }),
    ],
    { id: 'home' },
  );
  const login = artboard([text({ name: 'ボタン', content: 'ﾛｸﾞｲﾝする' }), text({ name: 'ご利用ガイド', content: 'ご利用ガイド' })], { id: 'login' });

  it('matches text content and layer names case-insensitively, in layer-panel order', async () => {
    const index = await buildSearchIndex(designOf([home, login]));
    const result = search(index, 'mug', 200);
    assert.equal(result.total, 3);
    assert.equal(result.searched, 2);
    assert.deepEqual(
      result.hits.map((hit) => hit.artboard),
      ['home', 'home', 'home'],
    );
    assert.deepEqual(result.hits.map(plain), [
      // An unnamed text layer is listed by its content, shown once.
      { name: { text: 'Free mug with every order', match: [5, 8] }, text: null },
      // A name-only match has no text excerpt.
      { name: { text: 'Mug photo', match: [0, 3] }, text: null },
      { name: { text: 'Title', match: null }, text: { text: 'Ceramic MUG', match: [8, 11] } },
    ]);
    const title = findNode(home.children, result.hits[2]?.key ?? '');
    assert.equal(title?.name, 'Title');
  });

  it('finds Japanese text whatever the width of the query or the text', async () => {
    const index = await buildSearchIndex(designOf([home, login]));
    const halfWidthText = search(index, 'ログイン', 200);
    assert.equal(halfWidthText.total, 1);
    assert.deepEqual(plain(halfWidthText.hits[0]), { name: { text: 'ボタン', match: null }, text: { text: 'ﾛｸﾞｲﾝする', match: [0, 5] } });
    assert.equal(halfWidthText.hits[0]?.text?.text.slice(0, 5), 'ﾛｸﾞｲﾝ');

    const halfWidthQuery = search(index, 'ｶﾞｲﾄﾞ', 200);
    assert.equal(halfWidthQuery.total, 1);
    // Name and content are the same, so the content is not repeated.
    assert.deepEqual(plain(halfWidthQuery.hits[0]), { name: { text: 'ご利用ガイド', match: [3, 6] }, text: null });
    assert.equal(search(index, 'ＭＵＧ', 200).total, 3);
  });

  it('returns at most `limit` hits but counts every match', async () => {
    const items = artboard(
      Array.from({ length: 250 }, (_, i) => text({ name: `Item ${i}`, content: `Item ${i}` })),
      { id: 'list' },
    );
    const index = await buildSearchIndex(designOf([items]));
    const result = search(index, 'item', 200);
    assert.equal(result.hits.length, 200);
    assert.equal(result.total, 250);

    const message = searchMessage(index, 'ITEM', 7);
    assert.equal(message.type, 'searchResults');
    if (message.type === 'searchResults') {
      assert.equal(message.seq, 7);
      assert.equal(message.hits.length, MESSAGE_LIMITS.searchResults);
      assert.equal(message.total, 250);
      assert.deepEqual(deserializeInWebview(serializeForWebview(message)), message, 'plain JSON through the VS Code serializer');
    }
  });

  it('finds nothing for an empty or blank query', async () => {
    const index = await buildSearchIndex(designOf([home]));
    assert.deepEqual(search(index, '', 200), { hits: [], total: 0, searched: 1 });
    assert.deepEqual(search(index, ' 　\n', 200), { hits: [], total: 0, searched: 1 });
  });

  it('leaves out artboards that fail to convert and reports how many were searched', async () => {
    const index = await buildSearchIndex(designOf([home], ['broken']));
    assert.equal(index.searched, 1);
    assert.equal(search(index, 'mug', 200).total, 3);
  });

  it('indexes only the first characters of long names and text', async () => {
    const long = artboard(
      [
        text({ name: 'Terms', content: `${'x'.repeat(SEARCH_LIMITS.textLength)}needle` }),
        shape({ name: `${'y'.repeat(SEARCH_LIMITS.nameLength)}needle` }),
        text({ name: 'Short', content: 'needle' }),
      ],
      { id: 'long' },
    );
    const result = search(await buildSearchIndex(designOf([long])), 'needle', 200);
    assert.equal(result.total, 1);
    assert.equal(result.hits[0]?.name.text, 'Short');
  });

  it('stops at the layer and character caps and says how many artboards it covered', async () => {
    const two = (id: string) => artboard([shape({ name: `${id} one` }), shape({ name: `${id} two` })], { id });
    const design = designOf([two('a'), two('b'), two('c')]);
    const byEntries = await buildSearchIndex(design, { ...SEARCH_LIMITS, entries: 3 });
    assert.equal(byEntries.entries.length, 3);
    assert.equal(byEntries.searched, 1, 'the second artboard was cut short');
    const byChars = await buildSearchIndex(design, { ...SEARCH_LIMITS, totalChars: 10 });
    assert.equal(byChars.entries.length, 2);
    assert.equal(byChars.searched, 1);
  });

  it('gives keys that select the same layer when an .xd artboard is opened later', async () => {
    const card: AgcNode = {
      type: 'group',
      id: 'card',
      name: 'Card',
      group: {
        children: [
          { type: 'shape', id: 'bg', name: 'Card background', shape: { type: 'rect', width: 200, height: 120 } },
          {
            type: 'text',
            id: 'price',
            name: 'Price',
            style: { font: { family: 'Noto Sans', style: 'Bold', size: 16 } },
            text: { rawText: '価格：１，８００円', frame: { type: 'positioned' }, paragraphs: [{ lines: [[{ from: 0, to: 9, x: 0, y: 0 }]] }] },
          },
        ],
      },
    };
    const xd = buildXd({
      artboards: [
        { id: 'artboard-home', name: 'Home', bounds: { x: 0, y: 0, width: 430, height: 600 }, children: [] },
        { id: 'artboard-cart', name: 'Cart', bounds: { x: 500, y: 0, width: 430, height: 600 }, children: [card] },
      ],
    });
    const result = search(await buildSearchIndex(xd), '1,800円', 200);
    assert.equal(result.total, 1);
    const hit = result.hits[0];
    assert.equal(hit?.artboard, 'artboard-cart');
    assert.deepEqual(hit?.text, { text: '価格：１，８００円', match: [3, 9] });
    const layer = findNode(xd.scene('artboard-cart').children, hit?.key ?? '');
    assert.equal(layer?.name, 'Price');
  });

  it('searches every frame of a .fig file, text overrides included', async () => {
    const fig = FigDocument.open(
      buildFig(
        documentNodes([
          node(10, 1, 'FRAME', { name: 'Login', size: { x: 390, y: 844 }, transform: at(0, 0) }),
          node(11, 10, 'TEXT', { name: 'Heading', size: { x: 200, y: 24 }, textData: { characters: 'パスワードを忘れた方' }, fontSize: 16 }),
          node(20, 10, 'SYMBOL', { name: 'Button', size: { x: 80, y: 30 } }, 'b'),
          node(21, 20, 'TEXT', { name: 'Label', overrideKey: guid(901), textData: { characters: 'OK' }, fontSize: 12 }),
          node(12, 1, 'FRAME', { name: 'Home', size: { x: 390, y: 844 }, transform: at(500, 0) }, 'b'),
          node(13, 12, 'RECTANGLE', { name: 'パスワード欄', size: { x: 300, y: 48 } }),
          node(14, 12, 'INSTANCE', {
            name: 'Submit',
            size: { x: 80, y: 30 },
            symbolData: { symbolID: guid(20), symbolOverrides: [{ guidPath: { guids: [guid(901)] }, textData: { characters: 'ログイン' } }] },
          }, 'b'),
        ]),
      ),
    );
    const index = await buildSearchIndex(fig);
    const result = search(index, 'ﾊﾟｽﾜｰﾄﾞ', 200);
    assert.deepEqual(
      result.hits.map((hit) => [hit.artboard, hit.name.text]),
      [
        ['1:10', 'Heading'],
        ['1:12', 'パスワード欄'],
      ],
    );
    const overridden = search(index, 'ログイン', 200);
    assert.deepEqual(
      overridden.hits.map((hit) => [hit.artboard, hit.name.text, hit.text?.text]),
      [['1:12', 'Label', 'ログイン']],
    );
    assert.deepEqual(
      search(index, 'ok', 200).hits.map((hit) => hit.artboard),
      ['1:10'],
      'the instance shows its override, not the component text',
    );
    for (const hit of [...result.hits, ...overridden.hits]) {
      assert.ok(findNode(fig.scene(hit.artboard).children, hit.key), `${hit.key} exists in ${hit.artboard}`);
    }
  });
});

describe('search messages from the webview', () => {
  it('accepts a query with its sequence number', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'search', query: 'ガイド', seq: 3, extra: true }), { type: 'search', query: 'ガイド', seq: 3 });
    assert.deepEqual(parseWebviewMessage({ type: 'search', query: '', seq: 0 }), { type: 'search', query: '', seq: 0 });
  });

  it('drops malformed or oversized queries', () => {
    const bad: unknown[] = [
      { type: 'search', query: 'x'.repeat(MESSAGE_LIMITS.searchQueryLength + 1), seq: 1 },
      { type: 'search', query: 42, seq: 1 },
      { type: 'search', query: ['a'], seq: 1 },
      { type: 'search', query: 'a' },
      { type: 'search', query: 'a', seq: '1' },
      { type: 'search', query: 'a', seq: -1 },
      { type: 'search', query: 'a', seq: 1.5 },
      { type: 'search', query: 'a', seq: Number.NaN },
      { type: 'search', query: 'a', seq: 2 ** 53 },
    ];
    for (const raw of bad) {
      assert.equal(parseWebviewMessage(raw), null, JSON.stringify(raw).slice(0, 60));
    }
  });
});
