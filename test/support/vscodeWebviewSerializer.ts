// Copy of how VS Code 1.141 moves a webview.postMessage() payload from the extension host to the webview
// (out/vs/workbench/api/node/extensionHostProcess.js, functions T8 / ote / w8). Used by tests and by the browser
// preview's mock host, so payloads that only break inside VS Code (e.g. Node Buffers) break there too.
// Both functions must stay self-contained: scripts/preview.ts embeds their source with Function#toString().

export interface SerializedMessage {
  message: string;
  buffers: Uint8Array[];
}

/** Extension host side (T8 with serializeBuffersForPostMessage). */
export function serializeForWebview(payload: unknown): SerializedMessage {
  const viewTypes = ['', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];
  const transferred: ArrayBufferLike[] = [];
  const add = (buffer: ArrayBufferLike) => {
    let index = transferred.indexOf(buffer);
    if (index < 0) {
      index = transferred.push(buffer) - 1;
    }
    return index;
  };
  // JSON.stringify calls toJSON() (e.g. Buffer#toJSON) before the replacer sees the value.
  const message = JSON.stringify(payload, (_key, value: unknown) => {
    if (value instanceof ArrayBuffer) {
      return { $$vscode_array_buffer_reference$$: true, index: add(value) };
    }
    if (ArrayBuffer.isView(value)) {
      const type = viewTypes.indexOf(value.constructor.name);
      if (type > 0) {
        return {
          $$vscode_array_buffer_reference$$: true,
          index: add(value.buffer),
          view: { type, byteLength: value.byteLength, byteOffset: value.byteOffset },
        };
      }
    }
    return value;
  });
  return { message, buffers: transferred.map((buffer) => new Uint8Array(buffer)) };
}

/** Webview side (w8): revives buffer references into typed arrays over copies of the transferred buffers. */
export function deserializeInWebview(serialized: SerializedMessage): unknown {
  const viewTypes = [
    null,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
  ];
  const buffers = serialized.buffers.map((bytes) => {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return copy;
  });
  return JSON.parse(serialized.message, (_key, value: unknown) => {
    const reference = value as { $$vscode_array_buffer_reference$$?: boolean; index: number; view?: { type: number; byteOffset: number; byteLength: number } } | null;
    if (!reference || typeof reference !== 'object' || !reference.$$vscode_array_buffer_reference$$) {
      return value;
    }
    const buffer = buffers[reference.index];
    if (!reference.view) {
      return buffer;
    }
    const View = viewTypes[reference.view.type];
    if (!View || !buffer) {
      throw new Error('Unknown array buffer view type');
    }
    return new View(buffer, reference.view.byteOffset, reference.view.byteLength / View.BYTES_PER_ELEMENT);
  });
}
