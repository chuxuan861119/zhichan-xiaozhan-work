type NodeRecord =
  | { type: "undefined" }
  | { type: "value"; value: string | number | boolean | null }
  | { type: "buffer"; offset: number; length: number }
  | { type: "view"; name: string; buffer: number; offset: number; length: number }
  | { type: "image"; data: number; width: number; height: number; colorSpace: PredefinedColorSpace }
  | { type: "array"; entries: number[] }
  | { type: "object"; entries: [string, number][] };

/** Binary pixels stay binary; graph references preserve shared history tiles rather than duplicating them. */
export function packKlecksHistory(value: unknown): Uint8Array<ArrayBuffer> {
  const nodes: NodeRecord[] = [],
    seen = new Map<object, number>(),
    buffers: Uint8Array[] = [];
  let bytes = 0;
  const visit = (item: unknown): number => {
    if (item !== null && typeof item === "object" && seen.has(item)) return seen.get(item)!;
    const id = nodes.length;
    nodes.push({ type: "undefined" });
    if (item !== null && typeof item === "object") seen.set(item, id);
    if (item === undefined) return id;
    if (item === null || ["string", "number", "boolean"].includes(typeof item))
      nodes[id] = { type: "value", value: item as string | number | boolean | null };
    else if (item instanceof ArrayBuffer) {
      nodes[id] = { type: "buffer", offset: bytes, length: item.byteLength };
      buffers.push(new Uint8Array(item));
      bytes += item.byteLength;
    } else if (ArrayBuffer.isView(item)) {
      if (!(item.buffer instanceof ArrayBuffer)) throw new Error("不支持共享内存历史。");
      nodes[id] = {
        type: "view",
        name: item.constructor.name,
        buffer: visit(item.buffer),
        offset: item.byteOffset,
        length: item.byteLength,
      };
    } else if (typeof ImageData !== "undefined" && item instanceof ImageData) {
      nodes[id] = {
        type: "image",
        data: visit(item.data),
        width: item.width,
        height: item.height,
        colorSpace: item.colorSpace,
      };
    } else if (Array.isArray(item)) nodes[id] = { type: "array", entries: Array.from(item, visit) };
    else if (
      typeof item === "object" &&
      item !== null &&
      [Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      nodes[id] = {
        type: "object",
        entries: Object.entries(item).map(([key, child]) => [key, visit(child)]),
      };
    else throw new Error("编辑历史包含不支持的缓存类型，原内容仍保留。");
    return id;
  };
  const root = visit(value),
    header = new TextEncoder().encode(JSON.stringify({ version: 1, root, nodes }));
  const result = new Uint8Array(4 + header.byteLength + bytes);
  new DataView(result.buffer).setUint32(0, header.byteLength, true);
  result.set(header, 4);
  let offset = 4 + header.byteLength;
  for (const buffer of buffers) {
    result.set(buffer, offset);
    offset += buffer.byteLength;
  }
  return result;
}

export function unpackKlecksHistory(bytes: Uint8Array<ArrayBuffer>): unknown {
  const headerSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    0,
    true,
  );
  if (headerSize > bytes.byteLength - 4) throw new Error("编辑会话缓存不完整。");
  const graph = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerSize))) as {
    version: number;
    root: number;
    nodes: NodeRecord[];
  };
  if (graph.version !== 1) throw new Error("编辑会话缓存版本不匹配。");
  const built = new Map<number, unknown>();
  const views = {
    Uint8Array,
    Uint8ClampedArray,
    Uint16Array,
    Uint32Array,
    Int8Array,
    Int16Array,
    Int32Array,
    Float32Array,
    Float64Array,
  };
  const restore = (id: number): unknown => {
    if (built.has(id)) return built.get(id);
    const node = graph.nodes[id];
    if (!node) throw new Error("编辑会话缓存引用无效。");
    let value: unknown;
    if (node.type === "undefined") value = undefined;
    else if (node.type === "value") value = node.value;
    else if (node.type === "buffer") {
      const start = 4 + headerSize + node.offset;
      if (node.offset < 0 || node.length < 0 || start + node.length > bytes.byteLength)
        throw new Error("编辑会话像素不完整。");
      value = bytes.slice(start, start + node.length).buffer;
    } else if (node.type === "view") {
      if (!Object.hasOwn(views, node.name)) throw new Error("编辑会话像素类型无效。");
      const Constructor = views[node.name as keyof typeof views];
      value = new Constructor(
        restore(node.buffer) as ArrayBuffer,
        node.offset,
        node.length / Constructor.BYTES_PER_ELEMENT,
      );
    } else if (node.type === "image")
      value = new ImageData(
        restore(node.data) as Uint8ClampedArray<ArrayBuffer>,
        node.width,
        node.height,
        { colorSpace: node.colorSpace },
      );
    else if (node.type === "array") {
      const array: unknown[] = [];
      built.set(id, array);
      for (const child of node.entries) array.push(restore(child));
      return array;
    } else {
      const record = {};
      built.set(id, record);
      for (const [key, child] of node.entries)
        Object.defineProperty(record, key, {
          value: restore(child),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      return record;
    }
    built.set(id, value);
    return value;
  };
  return restore(graph.root);
}
