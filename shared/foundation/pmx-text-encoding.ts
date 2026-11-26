/**
 * PMX bytes three's MMDParser can read (docs/claude/2026-11-02-pmx-utf8.md):
 * UTF-8 text → UTF-16LE, PMX 2.1 → 2.0, additional-UV morph offsets left out.
 *
 * three's MMDParser records the PMX header's text-encoding byte (0 UTF-16LE,
 * 1 UTF-8) but decodes every text field as UTF-16LE, so a UTF-8 PMX loads with
 * garbled bone, morph, material, rigid-body and model names: the model profile
 * cannot map it, and IK, expressions and motions mostly stop working.
 * It also refuses every PMX 2.1 file (it compares the Float32 version with the
 * double 2.1), throws on QDEF vertices, and reads no elements for 2.1's flip
 * and impulse morphs (losing its place in the file). For additional-UV morphs
 * (types 4-7, PMX 2.0 and 2.1) it knows the type but reads no bytes for each
 * offset, so it loses its place too: usually a RangeError, sometimes (all-zero
 * offsets) a model that loads without its frames, rigid bodies and joints.
 *
 * Both conversions walk the whole PMX 2.0/2.1 structure (header globals,
 * vertices with additional UVs and BDEF1/2/4, SDEF, QDEF, faces, textures,
 * materials, bones with every optional field, morphs of every type, display
 * frames, rigid bodies, joints, 2.1 soft bodies) before changing anything.
 * - `transcodePmxUtf8ToUtf16`: re-encodes each text field as UTF-16LE with its
 *   new byte length and sets the encoding byte to 0, so the result is exactly
 *   the file a UTF-16 writer would have produced. The version is kept.
 * - `preparePmxForMmdParser` (what the app's mmd-asset protocol and the model
 *   lab use): the same text conversion for UTF-8 files and, for a 2.1 file, a
 *   downgrade to 2.0 in the same pass: version 2.0; QDEF vertices become BDEF4
 *   (same four bones and weights; dual-quaternion skinning becomes linear);
 *   flip morphs become group morphs (same elements); impulse morphs become
 *   group morphs with no elements (name, panel and index kept, so display
 *   frames and groups still point at the right morphs; the physics impulses are
 *   dropped); soft bodies stay after the joints, where MMDParser stops reading.
 *   In any version, an additional-UV morph with offsets keeps its type, name,
 *   panel and index but loses its offsets (element count 0), which MMDParser
 *   reads correctly; neither MMDLoader nor the app uses additional UVs or UV
 *   morphs. A UTF-16 PMX 2.0 that declares no additional UVs (Gene) comes back
 *   as the same object without a walk (`pmxMayNeedPreparation`), as does one
 *   that is walked and has nothing to change.
 * Every other byte, including any bytes after the last section, is copied as is.
 *
 * Both work on an in-memory copy; the caller's bytes (and the file on disk) are
 * never modified. Anything they do not apply to, or that is not a well-formed
 * PMX 2.0/2.1, comes back as the same bytes object with `changed: false` and a
 * reason, and neither function throws, so a caller can always fall back to
 * today's loading. Invalid UTF-8 inside a name decodes to U+FFFD in that name
 * only (the header says UTF-8, which is what MMD itself trusts).
 *
 * Pure: no Node, DOM or Electron APIs beyond TextDecoder.
 */

/** Bytes `readPmxHeader` needs: magic, version, globals count, encoding byte, additional-UV count. */
export const PMX_HEADER_SNIFF_BYTES = 11;

export type PmxVersion = '2.0' | '2.1';
export interface PmxHeaderInfo { version: PmxVersion; encoding: number; additionalUv: number }

export type PmxTextTranscode =
  | { changed: true; bytes: Uint8Array; version: PmxVersion; textFields: number; replacedTextFields: number; trailingBytes: number }
  | { changed: false; bytes: Uint8Array; reason: 'not-pmx' | 'unsupported-version' | 'utf16' | 'unknown-encoding' | 'malformed'; detail?: string };

/** What a 2.1 → 2.0 downgrade changed or left out. */
export interface PmxDowngrade {
  /** QDEF vertices now BDEF4 (same bones and weights, linear instead of dual-quaternion skinning). */
  qdefVertices: number;
  /** Flip morphs now group morphs with the same elements. */
  flipMorphs: number;
  /** Impulse morphs now group morphs without elements; `impulseElements` impulses were dropped with them. */
  impulseMorphs: number;
  impulseElements: number;
  /** Soft bodies left after the joints, which MMDParser does not read. */
  softBodies: number;
}

export type PmxPreparation =
  | { changed: true; bytes: Uint8Array; version: PmxVersion; fromUtf8: boolean;
    /** Text fields re-encoded (0 when the file was already UTF-16) and how many of them had invalid UTF-8. */
    textFields: number; replacedTextFields: number; trailingBytes: number;
    /** Set when a 2.1 file was served as 2.0. */
    downgrade: PmxDowngrade | null;
    /** Set when additional-UV morphs (types 4-7) lost their offsets: how many morphs, how many offsets. */
    additionalUvMorphs: { morphs: number; elements: number } | null }
  | { changed: false; bytes: Uint8Array;
    /** 'utf16-2.0': a UTF-16 PMX 2.0 declaring no additional UVs, not walked; 'no-change': walked, nothing MMDParser cannot read. */
    reason: 'not-pmx' | 'unsupported-version' | 'utf16-2.0' | 'no-change' | 'unknown-encoding' | 'malformed'; detail?: string };

const MAGIC = [0x50, 0x4d, 0x58, 0x20]; // "PMX "

function versionOf(bytes: Uint8Array): PmxVersion | null {
  const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(4, true);
  return value === Math.fround(2.0) ? '2.0' : value === Math.fround(2.1) ? '2.1' : null;
}
const hasMagic = (bytes: Uint8Array) => bytes.byteLength >= 4 && MAGIC.every((value, k) => bytes[k] === value);

/** Version, text-encoding byte and additional-UV count of a PMX 2.0/2.1 file from its first `PMX_HEADER_SNIFF_BYTES` bytes; null for anything else. */
export function readPmxHeader(bytes: Uint8Array): PmxHeaderInfo | null {
  if (bytes.byteLength < PMX_HEADER_SNIFF_BYTES || !hasMagic(bytes)) return null;
  const version = versionOf(bytes);
  return version ? { version, encoding: bytes[9], additionalUv: bytes[10] } : null;
}

/**
 * Whether `preparePmxForMmdParser` may change a file with this header: UTF-8
 * text, version 2.1, or additional UVs (the only files that can carry
 * additional-UV morph offsets; the header cannot tell whether they do). The
 * mmd-asset protocol reads other PMX files no further than their header, and
 * `preparePmxForMmdParser` itself returns them untouched without a walk, so
 * the app and the model lab agree on every file.
 */
export function pmxMayNeedPreparation(header: PmxHeaderInfo): boolean {
  return header.encoding === 1 || header.version === '2.1' || header.additionalUv > 0;
}

class PmxStructureError extends Error {}

/**
 * A place a conversion may rewrite, in file order: a text field's int32 length
 * prefix, a QDEF vertex's deform byte, a flip morph's type byte, an impulse
 * morph's type byte (its element count and elements follow, up to `end`), or
 * an additional-UV morph's element count (its offsets follow, up to `end`).
 */
type PmxSite = { kind: 'text' | 'qdef' | 'flip'; at: number } | { kind: 'impulse' | 'uv'; at: number; end: number };
interface PmxWalk {
  sites: PmxSite[]; texts: number; qdef: number; flips: number; impulses: number; impulseElements: number; softBodies: number;
  uvMorphs: number; uvElements: number; end: number;
}

/**
 * Every rewritable site in file order, counts of each, and where the last
 * section ends. Throws PmxStructureError on anything the PMX 2.0/2.1 layout
 * does not allow (out-of-range sizes, flags or types, counts or lengths past
 * the end), so a walk that returns has accounted for every byte.
 */
function walkPmx(bytes: Uint8Array, version: PmxVersion): PmxWalk {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), size = bytes.byteLength, sites: PmxSite[] = [];
  const walk: PmxWalk = { sites, texts: 0, qdef: 0, flips: 0, impulses: 0, impulseElements: 0, softBodies: 0, uvMorphs: 0, uvElements: 0, end: 0 };
  let at = 0;
  const fail = (problem: string): never => { throw new PmxStructureError(`${problem} at byte ${at}`); };
  const skip = (length: number, what: string) => { if (at + length > size) fail(`${what} runs past the end`); at += length; };
  const u8 = (what: string) => { if (at + 1 > size) fail(`${what} runs past the end`); return bytes[at++]; };
  const u16 = (what: string) => { if (at + 2 > size) fail(`${what} runs past the end`); const value = view.getUint16(at, true); at += 2; return value; };
  const i32 = (what: string) => { if (at + 4 > size) fail(`${what} runs past the end`); const value = view.getInt32(at, true); at += 4; return value; };
  /** An element count; `least` is the smallest element, so an impossible count fails before any loop. */
  const count = (what: string, least: number) => {
    const value = i32(`${what} count`);
    if (value < 0) fail(`negative ${what} count ${value}`);
    if (value * least > size - at) fail(`${what} count ${value} does not fit in the file`);
    return value;
  };
  const text = (what: string) => {
    const start = at, length = i32(`${what} length`);
    if (length < 0) fail(`negative ${what} length ${length}`);
    skip(length, what);
    sites.push({ kind: 'text', at: start }); walk.texts++;
  };

  at = 8;
  const globals = u8('header');
  if (globals < 8) fail(`header declares ${globals} globals (8 needed)`);
  skip(globals, 'header globals');
  const [, extraUv, vertexIndex, textureIndex, materialIndex, boneIndex, morphIndex, bodyIndex] = bytes.subarray(9, 17);
  if (extraUv > 4) fail(`${extraUv} additional UVs (at most 4)`);
  for (const [name, value] of [['vertex', vertexIndex], ['texture', textureIndex], ['material', materialIndex], ['bone', boneIndex], ['morph', morphIndex], ['rigid body', bodyIndex]] as const)
    if (value !== 1 && value !== 2 && value !== 4) fail(`${name} index size ${value}`);
  for (const field of ['model name', 'model English name', 'comment', 'English comment']) text(field);

  // Vertices: position, normal, UV, additional UVs, deform type and its data, edge scale.
  const vertexBase = 32 + 16 * extraUv;
  // BDEF1, BDEF2, BDEF4, SDEF (BDEF2 + C, R0, R1), QDEF (as BDEF4).
  const deformData = [boneIndex, 2 * boneIndex + 4, 4 * boneIndex + 16, 2 * boneIndex + 40, 4 * boneIndex + 16];
  const vertices = count('vertex', vertexBase + 1 + boneIndex + 4);
  for (let vertex = 0; vertex < vertices; vertex++) {
    if (at + vertexBase + 1 > size) fail(`vertex ${vertex} runs past the end`);
    const deform = bytes[at + vertexBase];
    if (deform > 4) fail(`vertex ${vertex} has deform type ${deform}`);
    if (deform === 4) { sites.push({ kind: 'qdef', at: at + vertexBase }); walk.qdef++; }
    skip(vertexBase + 1 + deformData[deform] + 4, `vertex ${vertex}`);
  }
  const faceIndices = count('face index', vertexIndex);
  skip(faceIndices * vertexIndex, 'faces');
  const textures = count('texture', 4);
  for (let texture = 0; texture < textures; texture++) text(`texture ${texture} path`);

  // Materials: names, colours (diffuse 4, specular 3, specularity, ambient 3), flags, edge colour 4 and size,
  // texture and sphere indices, sphere mode, toon (shared byte or texture index), memo, surface count.
  const materials = count('material', 8 + 65 + 2 * textureIndex + 1 + 2 + 4 + 4);
  for (let material = 0; material < materials; material++) {
    text(`material ${material} name`); text(`material ${material} English name`);
    skip(44 + 1 + 20 + 2 * textureIndex + 1, `material ${material}`);
    const toon = u8(`material ${material} toon flag`);
    if (toon === 0) skip(textureIndex, `material ${material} toon texture`);
    else if (toon === 1) skip(1, `material ${material} shared toon`);
    else fail(`material ${material} has toon flag ${toon}`);
    text(`material ${material} memo`);
    skip(4, `material ${material} surface count`);
  }

  // Bones: names, position, parent, deform level, flags, then the fields the flags call for.
  const bones = count('bone', 8 + 12 + boneIndex + 4 + 2 + boneIndex);
  for (let bone = 0; bone < bones; bone++) {
    text(`bone ${bone} name`); text(`bone ${bone} English name`);
    skip(12 + boneIndex + 4, `bone ${bone}`);
    const flags = u16(`bone ${bone} flags`);
    skip(flags & 0x0001 ? boneIndex : 12, `bone ${bone} tail`);
    if (flags & 0x0300) skip(boneIndex + 4, `bone ${bone} grant`);
    if (flags & 0x0400) skip(12, `bone ${bone} fixed axis`);
    if (flags & 0x0800) skip(24, `bone ${bone} local axes`);
    if (flags & 0x2000) skip(4, `bone ${bone} external parent key`);
    if (flags & 0x0020) {
      skip(boneIndex + 8, `bone ${bone} IK`);
      const links = count(`bone ${bone} IK link`, boneIndex + 1);
      for (let link = 0; link < links; link++) {
        skip(boneIndex, `bone ${bone} IK link ${link}`);
        const limited = u8(`bone ${bone} IK link ${link} limit flag`);
        if (limited === 1) skip(24, `bone ${bone} IK link ${link} limits`);
        else if (limited !== 0) fail(`bone ${bone} IK link ${link} has limit flag ${limited}`);
      }
    }
  }

  // Morphs: every element of a type has the same size.
  const elementSize = (type: number): number | null => {
    switch (type) {
      case 0: return morphIndex + 4; // group: morph, ratio
      case 1: return vertexIndex + 12; // vertex: offset
      case 2: return boneIndex + 28; // bone: translation, rotation quaternion
      case 3: case 4: case 5: case 6: case 7: return vertexIndex + 16; // UV, additional UV 1-4
      case 8: return materialIndex + 113; // material: operation byte, 28 floats
      case 9: return morphIndex + 4; // 2.1 flip: morph, ratio
      case 10: return bodyIndex + 25; // 2.1 impulse: local flag, velocity, torque
      default: return null;
    }
  };
  const morphs = count('morph', 8 + 2 + 4);
  for (let morph = 0; morph < morphs; morph++) {
    text(`morph ${morph} name`); text(`morph ${morph} English name`);
    skip(1, `morph ${morph} panel`);
    const typeAt = at, type = u8(`morph ${morph} type`), each = elementSize(type);
    if (each === null) fail(`morph ${morph} has type ${type}`);
    const elements = count(`morph ${morph} element`, each!);
    skip(elements * each!, `morph ${morph} elements`);
    if (type === 9) { sites.push({ kind: 'flip', at: typeAt }); walk.flips++; }
    else if (type === 10) { sites.push({ kind: 'impulse', at: typeAt, end: at }); walk.impulses++; walk.impulseElements += elements; }
    else if (type >= 4 && type <= 7 && elements > 0) { sites.push({ kind: 'uv', at: typeAt + 1, end: at }); walk.uvMorphs++; walk.uvElements += elements; }
  }

  const frames = count('display frame', 8 + 1 + 4);
  for (let frame = 0; frame < frames; frame++) {
    text(`display frame ${frame} name`); text(`display frame ${frame} English name`);
    skip(1, `display frame ${frame} special flag`);
    const elements = count(`display frame ${frame} element`, 1 + Math.min(boneIndex, morphIndex));
    for (let element = 0; element < elements; element++) {
      const target = u8(`display frame ${frame} element ${element}`);
      if (target === 0) skip(boneIndex, `display frame ${frame} element ${element}`);
      else if (target === 1) skip(morphIndex, `display frame ${frame} element ${element}`);
      else fail(`display frame ${frame} element ${element} has target ${target}`);
    }
  }

  // Rigid bodies: bone, group, no-collision mask, shape, size 3, position 3, rotation 3, mass, dampings, restitution, friction, mode.
  const bodyData = boneIndex + 1 + 2 + 1 + 56 + 1;
  const bodies = count('rigid body', 8 + bodyData);
  for (let body = 0; body < bodies; body++) {
    text(`rigid body ${body} name`); text(`rigid body ${body} English name`);
    skip(bodyData, `rigid body ${body}`);
  }
  // Joints: type, two bodies, position, rotation, four limits, two springs (24 floats).
  const jointData = 1 + 2 * bodyIndex + 96;
  const joints = count('joint', 8 + jointData);
  for (let joint = 0; joint < joints; joint++) {
    text(`joint ${joint} name`); text(`joint ${joint} English name`);
    skip(jointData, `joint ${joint}`);
  }

  // PMX 2.1 soft bodies (a 2.1 file that ends after its joints has none): shape, material, group, no-collision mask,
  // flags, B-link distance, clusters, mass, margin, aero model, 12 config + 6 cluster floats, 4 iterations,
  // 3 material floats, then anchors (body, vertex, near mode) and pinned vertices.
  if (version === '2.1' && at < size) {
    const softData = 1 + materialIndex + 1 + 2 + 1 + 20 + 100;
    const softBodies = walk.softBodies = count('soft body', 8 + softData + 8);
    for (let soft = 0; soft < softBodies; soft++) {
      text(`soft body ${soft} name`); text(`soft body ${soft} English name`);
      skip(softData, `soft body ${soft}`);
      const anchor = bodyIndex + vertexIndex + 1, anchors = count(`soft body ${soft} anchor`, anchor);
      skip(anchors * anchor, `soft body ${soft} anchors`);
      const pins = count(`soft body ${soft} pin`, vertexIndex);
      skip(pins * vertexIndex, `soft body ${soft} pins`);
    }
  }
  walk.end = at;
  return walk;
}

/**
 * The walked file with its text sites re-encoded as UTF-16LE (`text`), its 2.1
 * sites rewritten as 2.0 (`downgrade`) and/or its additional-UV morph offsets
 * left out (`uv`), as a new array. Only called after a successful walk, so
 * every offset is in range.
 */
function rewritePmx(input: Uint8Array, walk: PmxWalk, options: { text: boolean; downgrade: boolean; uv: boolean }): { bytes: Uint8Array; replaced: number } {
  const { text, downgrade } = options;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const sites = walk.sites.filter(site => site.kind === 'text' ? text : site.kind === 'uv' ? options.uv : downgrade);
  const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }), lenient = new TextDecoder('utf-8', { ignoreBOM: true });
  const strings: string[] = [];
  let growth = 0, replaced = 0;
  for (const site of sites) {
    if (site.kind === 'text') {
      const length = view.getInt32(site.at, true), raw = input.subarray(site.at + 4, site.at + 4 + length);
      let value: string;
      try { value = strict.decode(raw); } catch { value = lenient.decode(raw); replaced++; }
      strings.push(value);
      growth += value.length * 2 - length;
    } else if (site.kind === 'impulse') growth -= site.end - (site.at + 5); // the elements go; the type byte and the count stay
    else if (site.kind === 'uv') growth -= site.end - (site.at + 4); // the offsets go; the count stays
  }

  const output = new Uint8Array(input.byteLength + growth), out = new DataView(output.buffer);
  let read = 0, write = 0, next = 0;
  for (const site of sites) {
    output.set(input.subarray(read, site.at), write); write += site.at - read;
    switch (site.kind) {
      case 'text': {
        const value = strings[next++];
        out.setInt32(write, value.length * 2, true); write += 4;
        for (let unit = 0; unit < value.length; unit++) { const code = value.charCodeAt(unit); output[write++] = code & 0xff; output[write++] = code >>> 8; }
        read = site.at + 4 + view.getInt32(site.at, true);
        break;
      }
      // BDEF4: QDEF's data is the same four bone indices and four weights.
      case 'qdef': output[write++] = 2; read = site.at + 1; break;
      // Group: a flip element is the same morph index and ratio.
      case 'flip': output[write++] = 0; read = site.at + 1; break;
      // Group with no elements: its impulses (body, local flag, velocity, torque) are dropped.
      case 'impulse': output[write++] = 0; out.setInt32(write, 0, true); write += 4; read = site.end; break;
      // Same additional-UV morph type with no offsets: MMDParser reads no bytes per element, so only an empty one keeps it in place.
      case 'uv': out.setInt32(write, 0, true); write += 4; read = site.end; break;
    }
  }
  output.set(input.subarray(read), write);
  if (text) output[9] = 0;
  if (downgrade) out.setFloat32(4, 2.0, true);
  return { bytes: output, replaced };
}

type Sniffed = PmxHeaderInfo | { reason: 'not-pmx' | 'unsupported-version' | 'malformed'; detail?: string };
function sniff(input: Uint8Array): Sniffed {
  if (!hasMagic(input)) return { reason: 'not-pmx' };
  if (input.byteLength < PMX_HEADER_SNIFF_BYTES) return { reason: 'malformed', detail: `header cut at ${input.byteLength} bytes` };
  return readPmxHeader(input) ?? { reason: 'unsupported-version' };
}
const walkFailure = (error: unknown) => error instanceof PmxStructureError ? error.message : String(error);
const conversionFailure = (error: unknown) => `conversion failed: ${error instanceof Error ? error.message : String(error)}`;

/** A UTF-8 PMX 2.0/2.1 as the same model with UTF-16LE text (version kept); anything else unchanged (the same object). Never throws. */
export function transcodePmxUtf8ToUtf16(input: Uint8Array): PmxTextTranscode {
  const unchanged = (reason: Extract<PmxTextTranscode, { changed: false }>['reason'], detail?: string): PmxTextTranscode =>
    ({ changed: false, bytes: input, reason, ...(detail ? { detail } : {}) });
  try {
    const header = sniff(input);
    if ('reason' in header) return unchanged(header.reason, header.detail);
    if (header.encoding === 0) return unchanged('utf16');
    if (header.encoding !== 1) return unchanged('unknown-encoding', `encoding byte ${header.encoding}`);

    let walk: PmxWalk;
    try { walk = walkPmx(input, header.version); } catch (error) { return unchanged('malformed', walkFailure(error)); }
    const { bytes, replaced } = rewritePmx(input, walk, { text: true, downgrade: false, uv: false });
    return { changed: true, bytes, version: header.version, textFields: walk.texts, replacedTextFields: replaced, trailingBytes: input.byteLength - walk.end };
  } catch (error) {
    // Allocation failures and the like: the caller loads the original bytes, as before.
    return unchanged('malformed', conversionFailure(error));
  }
}

/**
 * The bytes the app's MMDLoader should get for a PMX file: UTF-8 text as
 * UTF-16LE, a 2.1 file as 2.0, additional-UV morphs without their offsets, in
 * one pass (see the file comment for what changes). A file
 * `pmxMayNeedPreparation` rules out (a UTF-16 PMX 2.0 declaring no additional
 * UVs, Gene), one with nothing to change and anything that is not a
 * well-formed PMX 2.0/2.1 come back unchanged (the same object). Never throws.
 */
export function preparePmxForMmdParser(input: Uint8Array): PmxPreparation {
  const unchanged = (reason: Extract<PmxPreparation, { changed: false }>['reason'], detail?: string): PmxPreparation =>
    ({ changed: false, bytes: input, reason, ...(detail ? { detail } : {}) });
  try {
    const header = sniff(input);
    if ('reason' in header) return unchanged(header.reason, header.detail);
    if (header.encoding !== 0 && header.encoding !== 1) return unchanged('unknown-encoding', `encoding byte ${header.encoding}`);
    if (!pmxMayNeedPreparation(header)) return unchanged('utf16-2.0');
    const fromUtf8 = header.encoding === 1, downgrade = header.version === '2.1';

    let walk: PmxWalk;
    try { walk = walkPmx(input, header.version); } catch (error) { return unchanged('malformed', walkFailure(error)); }
    if (!fromUtf8 && !downgrade && walk.uvMorphs === 0) return unchanged('no-change');
    const { bytes, replaced } = rewritePmx(input, walk, { text: fromUtf8, downgrade, uv: true });
    return {
      changed: true, bytes, version: header.version, fromUtf8, textFields: fromUtf8 ? walk.texts : 0, replacedTextFields: replaced,
      trailingBytes: input.byteLength - walk.end,
      downgrade: downgrade
        ? { qdefVertices: walk.qdef, flipMorphs: walk.flips, impulseMorphs: walk.impulses, impulseElements: walk.impulseElements, softBodies: walk.softBodies }
        : null,
      additionalUvMorphs: walk.uvMorphs ? { morphs: walk.uvMorphs, elements: walk.uvElements } : null,
    };
  } catch (error) {
    return unchanged('malformed', conversionFailure(error));
  }
}

/** One ASCII line on what `preparePmxForMmdParser` changed (the mmd-asset protocol sends it as the X-PMX-Conversion response header). */
export function describePmxPreparation(result: Extract<PmxPreparation, { changed: true }>): string {
  const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;
  const parts: string[] = [];
  if (result.fromUtf8)
    parts.push(`utf-8 text -> utf-16le (${count(result.textFields, 'field', 'fields')}${result.replacedTextFields ? `, ${result.replacedTextFields} with invalid utf-8` : ''})`);
  const down = result.downgrade;
  if (down) {
    const changes: string[] = [];
    if (down.qdefVertices) changes.push(`${count(down.qdefVertices, 'qdef vertex', 'qdef vertices')} -> bdef4`);
    if (down.flipMorphs) changes.push(`${count(down.flipMorphs, 'flip morph', 'flip morphs')} -> group`);
    if (down.impulseMorphs) changes.push(`${count(down.impulseMorphs, 'impulse morph', 'impulse morphs')} emptied (${count(down.impulseElements, 'impulse', 'impulses')} dropped)`);
    if (down.softBodies) changes.push(`${count(down.softBodies, 'soft body', 'soft bodies')} not read`);
    parts.push(`pmx 2.1 -> 2.0: ${changes.length ? changes.join(', ') : 'no 2.1-only content'}`);
  }
  const uv = result.additionalUvMorphs;
  if (uv) parts.push(`${count(uv.morphs, 'additional-uv morph', 'additional-uv morphs')} emptied (${count(uv.elements, 'uv offset', 'uv offsets')} dropped)`);
  return parts.join('; ');
}
