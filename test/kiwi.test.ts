import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeMessage, decodeSchema, type KiwiDefinition } from '../src/fig/kiwi.ts';
import { encodeMessage, encodeSchema } from './support/kiwiWriter.ts';

const SCHEMA: KiwiDefinition[] = [
  { name: 'Kind', kind: 'ENUM', fields: [{ name: 'A', type: 'uint', isArray: false, value: 0 }, { name: 'B', type: 'uint', isArray: false, value: 7 }] },
  { name: 'Point', kind: 'STRUCT', fields: [{ name: 'x', type: 'float', isArray: false, value: 1 }, { name: 'y', type: 'int', isArray: false, value: 2 }] },
  {
    name: 'Root',
    kind: 'MESSAGE',
    fields: [
      { name: 'flag', type: 'bool', isArray: false, value: 1 },
      { name: 'count', type: 'uint', isArray: false, value: 2 },
      { name: 'label', type: 'string', isArray: false, value: 3 },
      { name: 'kind', type: 'Kind', isArray: false, value: 4 },
      { name: 'points', type: 'Point', isArray: true, value: 5 },
      { name: 'data', type: 'byte', isArray: true, value: 6 },
      { name: 'child', type: 'Root', isArray: false, value: 7 },
      { name: 'ratios', type: 'float', isArray: true, value: 8 },
    ],
  },
];

describe('kiwi decoder', () => {
  it('round-trips an embedded schema', () => {
    assert.deepEqual(decodeSchema(encodeSchema(SCHEMA)), SCHEMA);
  });

  it('decodes builtins, enums, structs, nested messages and byte arrays', () => {
    const value = {
      flag: true,
      count: 300,
      label: 'ボタン ✓',
      kind: 'B',
      points: [{ x: 0, y: -5 }, { x: 1.5, y: 70000 }],
      data: new Uint8Array([1, 2, 255]),
      child: { label: 'inner', ratios: [0.25, -2] },
    };
    const decoded = decodeMessage(SCHEMA, 'Root', encodeMessage(SCHEMA, 'Root', value));
    assert.deepEqual(JSON.parse(JSON.stringify({ ...decoded, data: [...(decoded['data'] as Uint8Array)] })), {
      ...value,
      data: [1, 2, 255],
      child: { label: 'inner', ratios: [0.25, -2] },
    });
  });

  it('rejects unknown roots, unknown fields and truncated data', () => {
    const bytes = encodeMessage(SCHEMA, 'Root', { count: 1 });
    assert.throws(() => decodeMessage(SCHEMA, 'Missing', bytes), /no Missing type/);
    assert.throws(() => decodeMessage(SCHEMA, 'Root', Buffer.from([99, 0])), /unknown field 99/);
    assert.throws(() => decodeMessage(SCHEMA, 'Root', bytes.subarray(0, 1)), /unexpected end of data/);
  });
});

describe('kiwi decoder against hostile input', () => {
  it('refuses huge arrays of zero-size structs instead of looping for billions of elements', () => {
    const schema: KiwiDefinition[] = [
      { name: 'Empty', kind: 'STRUCT', fields: [] },
      { name: 'Root', kind: 'MESSAGE', fields: [{ name: 'items', type: 'Empty', isArray: true, value: 1 }] },
    ];
    // field 1, length 0xffffffff, then end of message
    const bytes = Buffer.from([1, 0xff, 0xff, 0xff, 0xff, 0x0f, 0]);
    const started = Date.now();
    assert.throws(() => decodeMessage(decodeSchema(encodeSchema(schema)), 'Root', bytes), /longer than the data left/);
    assert.ok(Date.now() - started < 1000);
  });

  it('refuses array lengths larger than the remaining bytes', () => {
    const schema: KiwiDefinition[] = [{ name: 'Root', kind: 'MESSAGE', fields: [{ name: 'values', type: 'uint', isArray: true, value: 1 }] }];
    assert.throws(() => decodeMessage(schema, 'Root', Buffer.from([1, 0xff, 0xff, 0x03, 1, 2])), /longer than the data left/);
  });

  it('rejects a struct that contains itself', () => {
    const schema: KiwiDefinition[] = [{ name: 'Loop', kind: 'STRUCT', fields: [{ name: 'next', type: 'Loop', isArray: false, value: 1 }] }];
    assert.throws(() => decodeSchema(encodeSchema(schema)), /contains itself/);
  });

  it('stops runaway nesting with an error instead of overflowing the stack', () => {
    const nested = Buffer.concat([Buffer.alloc(5000, 7), Buffer.alloc(5001, 0)]);
    assert.throws(() => decodeMessage(SCHEMA, 'Root', nested), /nesting too deep/);
  });

  it('keeps a field named __proto__ as plain data', () => {
    const schema: KiwiDefinition[] = [
      { name: 'Inner', kind: 'MESSAGE', fields: [{ name: 'polluted', type: 'bool', isArray: false, value: 1 }] },
      { name: 'Root', kind: 'MESSAGE', fields: [{ name: '__proto__', type: 'Inner', isArray: false, value: 1 }] },
    ];
    const decoded = decodeMessage(schema, 'Root', encodeMessage(schema, 'Root', JSON.parse('{"__proto__":{"polluted":true}}')));
    assert.equal(Object.getPrototypeOf(decoded), null);
    assert.deepEqual({ ...(Object.getOwnPropertyDescriptor(decoded, '__proto__')?.value as object) }, { polluted: true });
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });
});
