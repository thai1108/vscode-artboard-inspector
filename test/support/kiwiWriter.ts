// Minimal kiwi encoder (the inverse of src/fig/kiwi.ts) for building synthetic .fig fixtures.
import type { KiwiDefinition } from '../../src/fig/kiwi.ts';

const BUILTINS = ['bool', 'byte', 'int', 'uint', 'float', 'string', 'int64', 'uint64'];
const KINDS = ['ENUM', 'STRUCT', 'MESSAGE'];
const float32 = new Float32Array(1);
const int32 = new Int32Array(float32.buffer);

export type FixtureValue = boolean | number | string | Uint8Array | FixtureValue[] | { [field: string]: FixtureValue | undefined };

class ByteWriter {
  readonly bytes: number[] = [];

  byte(value: number): void {
    this.bytes.push(value & 255);
  }

  varUint(value: number): void {
    let v = value >>> 0;
    do {
      const byte = v & 127;
      v >>>= 7;
      this.byte(v ? byte | 128 : byte);
    } while (v);
  }

  varInt(value: number): void {
    this.varUint((value << 1) ^ (value >> 31));
  }

  varFloat(value: number): void {
    float32[0] = value;
    let bits = int32[0] as number;
    bits = (bits >>> 23) | (bits << 9);
    if ((bits & 255) === 0) {
      this.byte(0);
      return;
    }
    this.byte(bits);
    this.byte(bits >> 8);
    this.byte(bits >> 16);
    this.byte(bits >> 24);
  }

  string(value: string): void {
    for (const byte of new TextEncoder().encode(value)) {
      this.byte(byte);
    }
    this.byte(0);
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bytes);
  }
}

export function encodeSchema(definitions: KiwiDefinition[]): Buffer {
  const writer = new ByteWriter();
  const index = new Map(definitions.map((definition, i) => [definition.name, i]));
  writer.varUint(definitions.length);
  for (const definition of definitions) {
    writer.string(definition.name);
    writer.byte(KINDS.indexOf(definition.kind));
    writer.varUint(definition.fields.length);
    for (const field of definition.fields) {
      writer.string(field.name);
      const builtin = BUILTINS.indexOf(field.type);
      writer.varInt(builtin >= 0 ? ~builtin : (index.get(field.type) ?? 0));
      writer.byte(field.isArray ? 1 : 0);
      writer.varUint(field.value);
    }
  }
  return writer.toBuffer();
}

export function encodeMessage(definitions: KiwiDefinition[], root: string, value: FixtureValue): Buffer {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const writer = new ByteWriter();
  const write = (type: string, item: FixtureValue): void => {
    switch (type) {
      case 'bool':
        return writer.byte(item ? 1 : 0);
      case 'byte':
        return writer.byte(item as number);
      case 'int':
        return writer.varInt(item as number);
      case 'uint':
        return writer.varUint(item as number);
      case 'float':
        return writer.varFloat(item as number);
      case 'string':
        return writer.string(item as string);
    }
    const definition = byName.get(type);
    if (!definition) {
      throw new Error(`fixture: unknown type ${type}`);
    }
    const record = item as Record<string, FixtureValue | undefined>;
    switch (definition.kind) {
      case 'ENUM': {
        const field = definition.fields.find((f) => f.name === item);
        if (!field) {
          throw new Error(`fixture: ${String(item)} is not in enum ${type}`);
        }
        return writer.varUint(field.value);
      }
      case 'STRUCT':
        for (const field of definition.fields) {
          writeField(field.type, field.isArray, record[field.name] as FixtureValue);
        }
        return;
      case 'MESSAGE':
        for (const field of definition.fields) {
          const fieldValue = record[field.name];
          if (fieldValue !== undefined) {
            writer.varUint(field.value);
            writeField(field.type, field.isArray, fieldValue);
          }
        }
        writer.varUint(0);
        return;
    }
  };
  const writeField = (type: string, isArray: boolean, item: FixtureValue): void => {
    if (!isArray) {
      write(type, item);
    } else if (item instanceof Uint8Array) {
      writer.varUint(item.length);
      item.forEach((byte) => writer.byte(byte));
    } else {
      const items = item as FixtureValue[];
      writer.varUint(items.length);
      items.forEach((element) => write(type, element));
    }
  };
  write(root, value);
  return writer.toBuffer();
}
