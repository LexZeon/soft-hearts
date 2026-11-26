/**
 * The JSON chunk of a GLB (a .vrm) without reading the rest, and the name a VRM gives itself (I-152): the host names a new character
 * card after it (shared/cards/character-model.ts reads the PMX/PMD names). A file format reader like pmx-text-encoding.ts, so
 * foundation: pure, bytes in, values out; never throws. The full VRM reading is shared/stage/vrm/vrm-read.ts.
 */

const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a;
/** A JSON chunk larger than this is not read for a name. */
export const MAX_GLB_JSON_BYTES = 32 * 1024 * 1024;

/** How many leading bytes hold the whole JSON chunk (header 20 + chunk), or null when `head` is not a GLB whose first chunk is JSON. */
export function glbJsonEnd(head: Uint8Array): number | null {
  if (!(head instanceof Uint8Array) || head.byteLength < 20) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2 || view.getUint32(16, true) !== CHUNK_JSON) return null;
  const length = view.getUint32(12, true);
  return length > 0 && length <= MAX_GLB_JSON_BYTES ? 20 + length : null;
}

/** The parsed JSON chunk (an object) when `bytes` holds all of it, else null. */
export function readGlbJson(bytes: Uint8Array): Record<string, unknown> | null {
  const end = glbJsonEnd(bytes);
  if (end === null || bytes.byteLength < end) return null;
  try {
    const json = JSON.parse(new TextDecoder('utf-8').decode(bytes.subarray(20, end)).replace(/[\0 ]+$/u, '')) as unknown;
    return json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : null;
  } catch { return null; }
}

/**
 * The same GLB with its JSON chunk replaced (the binary chunk and any after it kept byte for byte). Throws when `bytes` is not a
 * GLB whose first chunk is JSON. Used to hand the glTF loader a VRM 0.x whose materials were translated (shared/stage/vrm/vrm0-mtoon.ts).
 */
export function glbWithJson(bytes: Uint8Array, json: unknown): Uint8Array {
  const end = glbJsonEnd(bytes);
  if (end === null || bytes.byteLength < end) throw new Error('不是 GLB/VRM 文件');
  let text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (text.length % 4)) % 4;
  if (pad) { const padded = new Uint8Array(text.length + pad).fill(0x20); padded.set(text); text = padded; }
  const rest = bytes.subarray(end);
  const out = new Uint8Array(20 + text.length + rest.length), view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true); view.setUint32(4, 2, true); view.setUint32(8, out.length, true);
  view.setUint32(12, text.length, true); view.setUint32(16, CHUNK_JSON, true);
  out.set(text, 20); out.set(rest, 20 + text.length);
  return out;
}

const field = (value: unknown, key: string): unknown => value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;

/** The name a VRM gives itself (1.0 meta.name, 0.x meta.title; '' when it has none), or null when the bytes are not a VRM. */
export function readVrmModelName(bytes: Uint8Array): string | null {
  const extensions = field(readGlbJson(bytes), 'extensions');
  const vrm1 = field(extensions, 'VRMC_vrm'), vrm0 = field(extensions, 'VRM');
  const name = vrm1 !== undefined ? field(field(vrm1, 'meta'), 'name') : vrm0 !== undefined ? field(field(vrm0, 'meta'), 'title') : undefined;
  if (vrm1 === undefined && vrm0 === undefined) return null;
  return typeof name === 'string' ? name : '';
}
