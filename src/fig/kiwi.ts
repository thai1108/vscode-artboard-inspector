// Decoder for the kiwi binary format (https://github.com/evanw/kiwi) that Figma uses inside .fig files.
// Each file embeds its own binary schema, so decoding is schema-driven and needs no generated code.

const BUILTIN_TYPES = ['bool', 'byte', 'int', 'uint', 'float', 'string', 'int64', 'uint64'] as const;

type DefinitionKind = 'ENUM' | 'STRUCT' | 'MESSAGE';
const KINDS: DefinitionKind[] = ['ENUM', 'STRUCT', 'MESSAGE'];

export interface KiwiField {
  name: string;
  /** Builtin type name or the name of another definition. */
  type: string;
  isArray: boolean;
  value: number;
}

export interface KiwiDefinition {
  name: string;
  kind: DefinitionKind;
  fields: KiwiField[];
}

export type KiwiValue = boolean | number | bigint | string | Uint8Array | KiwiValue[] | { [field: string]: KiwiValue };

/** Deeper nesting than this can only come from a hostile or broken schema. */
const MAX_DEPTH = 256;

const float32 = new Float32Array(1);
const int32 = new Int32Array(float32.buffer);

class ByteReader {
  private readonly data: Uint8Array;
  private index = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  get remaining(): number {
    return this.data.length - this.index;
  }

  byte(): number {
    if (this.index >= this.data.length) {
      throw new Error('kiwi: unexpected end of data');
    }
    return this.data[this.index++] as number;
  }

  byteArray(): Uint8Array {
    const length = this.varUint();
    const start = this.index;
    this.index += length;
    if (this.index > this.data.length) {
      throw new Error('kiwi: byte array past end of data');
    }
    return this.data.subarray(start, this.index);
  }

  varUint(): number {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.byte();
      value |= (byte & 127) << shift;
      shift += 7;
    } while (byte & 128 && shift < 35);
    return value >>> 0;
  }

  varInt(): number {
    const value = this.varUint() | 0;
    return value & 1 ? ~(value >>> 1) : value >>> 1;
  }

  varUint64(): bigint {
    let value = 0n;
    let shift = 0n;
    let byte: number;
    do {
      byte = this.byte();
      value |= BigInt(byte & 127) << shift;
      shift += 7n;
    } while (byte & 128 && shift < 70n);
    return value;
  }

  varInt64(): bigint {
    const value = this.varUint64();
    return value & 1n ? ~(value >> 1n) : value >> 1n;
  }

  /** kiwi stores floats with the exponent rotated to the front so that 0 fits in one byte. */
  varFloat(): number {
    const first = this.byte();
    if (first === 0) {
      return 0;
    }
    if (this.index + 3 > this.data.length) {
      throw new Error('kiwi: float past end of data');
    }
    let bits = first | ((this.data[this.index] as number) << 8) | ((this.data[this.index + 1] as number) << 16) | ((this.data[this.index + 2] as number) << 24);
    this.index += 3;
    bits = (bits << 23) | (bits >>> 9);
    int32[0] = bits;
    return float32[0] as number;
  }

  /** Null-terminated UTF-8. */
  string(): string {
    const start = this.index;
    const end = this.data.indexOf(0, start);
    if (end < 0) {
      throw new Error('kiwi: unterminated string');
    }
    this.index = end + 1;
    return decoder.decode(this.data.subarray(start, end));
  }
}

const decoder = new TextDecoder();

export function decodeSchema(data: Uint8Array): KiwiDefinition[] {
  const reader = new ByteReader(data);
  const definitions: { name: string; kind: DefinitionKind; fields: { name: string; typeIndex: number; isArray: boolean; value: number }[] }[] = [];
  const count = reader.varUint();
  for (let i = 0; i < count; i++) {
    const name = reader.string();
    const kind = KINDS[reader.byte()];
    if (!kind) {
      throw new Error(`kiwi: invalid definition kind for ${name}`);
    }
    const fieldCount = reader.varUint();
    const fields = [];
    for (let j = 0; j < fieldCount; j++) {
      fields.push({ name: reader.string(), typeIndex: reader.varInt(), isArray: reader.byte() !== 0, value: reader.varUint() });
    }
    definitions.push({ name, kind, fields });
  }
  const resolved = definitions.map((definition) => ({
    name: definition.name,
    kind: definition.kind,
    fields: definition.fields.map((field) => {
      const type = field.typeIndex < 0 ? BUILTIN_TYPES[~field.typeIndex] : definitions[field.typeIndex]?.name;
      if (!type) {
        throw new Error(`kiwi: invalid type for ${definition.name}.${field.name}`);
      }
      return { name: field.name, type, isArray: field.isArray, value: field.value };
    }),
  }));
  minimumSizes(resolved);
  return resolved;
}

/**
 * Smallest encoding of each definition in bytes. Rejects structs that contain themselves (they can never be
 * encoded), and lets the decoder bound array lengths by the bytes left.
 */
function minimumSizes(definitions: KiwiDefinition[]): Map<string, number> {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const sizes = new Map<string, number>();
  const visiting = new Set<string>();
  const sizeOf = (type: string): number => {
    const definition = byName.get(type);
    if (!definition) {
      return 1;
    }
    const known = sizes.get(type);
    if (known !== undefined) {
      return known;
    }
    if (definition.kind !== 'STRUCT') {
      sizes.set(type, 1);
      return 1;
    }
    if (visiting.has(type)) {
      throw new Error(`kiwi: struct ${type} contains itself`);
    }
    visiting.add(type);
    const size = definition.fields.reduce((sum, field) => sum + (field.isArray ? 1 : sizeOf(field.type)), 0);
    visiting.delete(type);
    sizes.set(type, size);
    return size;
  };
  for (const definition of definitions) {
    sizeOf(definition.name);
  }
  return sizes;
}

/** Decodes `data` as an instance of the definition named `root`. */
export function decodeMessage(definitions: KiwiDefinition[], root: string, data: Uint8Array): Record<string, KiwiValue> {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const minSize = minimumSizes(definitions);
  const fieldsByValue = new Map(definitions.map((definition) => [definition.name, new Map(definition.fields.map((field) => [field.value, field]))]));
  const enumNames = new Map(definitions.filter((d) => d.kind === 'ENUM').map((d) => [d.name, new Map(d.fields.map((field) => [field.value, field.name]))]));
  const reader = new ByteReader(data);

  let depth = 0;
  const readType = (type: string): KiwiValue => {
    switch (type) {
      case 'bool':
        return reader.byte() !== 0;
      case 'byte':
        return reader.byte();
      case 'int':
        return reader.varInt();
      case 'uint':
        return reader.varUint();
      case 'float':
        return reader.varFloat();
      case 'string':
        return reader.string();
      case 'int64':
        return reader.varInt64();
      case 'uint64':
        return reader.varUint64();
    }
    const definition = byName.get(type);
    if (!definition) {
      throw new Error(`kiwi: unknown type ${type}`);
    }
    if (++depth > MAX_DEPTH) {
      throw new Error('kiwi: nesting too deep');
    }
    try {
      return readDefinition(definition, type);
    } finally {
      depth--;
    }
  };

  const readDefinition = (definition: KiwiDefinition, type: string): KiwiValue => {
    switch (definition.kind) {
      case 'ENUM': {
        const value = reader.varUint();
        const name = enumNames.get(type)?.get(value);
        if (name === undefined) {
          throw new Error(`kiwi: invalid value ${value} for enum ${type}`);
        }
        return name;
      }
      case 'STRUCT': {
        const result = record();
        for (const field of definition.fields) {
          result[field.name] = readField(field);
        }
        return result;
      }
      case 'MESSAGE': {
        const result = record();
        const fields = fieldsByValue.get(type);
        for (;;) {
          const value = reader.varUint();
          if (value === 0) {
            return result;
          }
          const field = fields?.get(value);
          if (!field) {
            throw new Error(`kiwi: unknown field ${value} in message ${type}`);
          }
          result[field.name] = readField(field);
        }
      }
    }
  };

  const readField = (field: KiwiField): KiwiValue => {
    if (!field.isArray) {
      return readType(field.type);
    }
    if (field.type === 'byte') {
      return reader.byteArray();
    }
    const length = reader.varUint();
    const elementSize = minSize.get(field.type) ?? 1;
    if (elementSize === 0 || length * elementSize > reader.remaining) {
      throw new Error(`kiwi: array ${field.name} longer than the data left`);
    }
    const values: KiwiValue[] = new Array(length);
    for (let i = 0; i < length; i++) {
      values[i] = readType(field.type);
    }
    return values;
  };

  const definition = byName.get(root);
  if (!definition) {
    throw new Error(`kiwi: schema has no ${root} type`);
  }
  return readType(root) as Record<string, KiwiValue>;
}

/** Prototype-less, so a field named "__proto__" stays plain data. */
function record(): Record<string, KiwiValue> {
  return Object.create(null) as Record<string, KiwiValue>;
}
