// Three.js r170 does not publish declarations for its bundled MMD parser.
// @ts-expect-error Bundled parser has no TypeScript declaration.
import { MMDParser } from "three/examples/jsm/libs/mmdparser.module.js";
import { stripDefaultVmdTracks, type VmdTrackData, type VmdTrackReport } from './vmd-tracks';

/** Optional load-time adaptation (motion retargeting); it gets the stripped data and the original bytes, and must not mutate either. */
export type VmdDataTransform = <T extends VmdTrackData>(vmd: T, buffer: ArrayBuffer) => T;

/** Repair only a truncated display name in memory; motion data on disk stays original. */
export function readableVmdHeader(buffer: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(buffer);
  const signature = new TextDecoder("ascii").decode(bytes.subarray(0, 30));
  const length = signature.startsWith("Vocaloid Motion Data 0002") ? 20 :
    signature.startsWith("Vocaloid Motion Data file") ? 10 : 0;
  if (!length || bytes.length < 30 + length) return buffer;
  for (let i = 30; i < 30 + length && bytes[i] !== 0; i++) {
    const byte = bytes[i];
    if ((byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc)) {
      if (i + 1 === 30 + length || bytes[i + 1] === 0) {
        const copy = buffer.slice(0);
        new Uint8Array(copy)[i] = 0;
        return copy;
      }
      i++;
    }
  }
  return buffer;
}

/**
 * R29f: MMD keeps per-key flags (physics on/off) in bytes 2 and 3 of a bone key's 64-byte interpolation block,
 * where the first of its four shifted copies would hold the Z and rotation curves' x1. three's MMDLoader reads
 * only that first copy, so on MMD-written files (the bundled Stand, Gene's reactions, the dance: zeros there)
 * every rotation segment started at an infinite slope: a speed spike at every key. When the second copy agrees
 * with the first wherever neither is overwritten, it holds the curves' own values: copy those two back. In
 * memory only (the file and its hash are untouched); a block without consistent copies is left as it is.
 * Returns how many keys were repaired.
 */
export function repairVmdCurveBytes(motions: readonly { interpolation?: ArrayLike<number> }[] | undefined): number {
  let repaired = 0;
  for (const motion of motions ?? []) {
    const c = motion.interpolation as number[] | undefined;
    if (!c || c.length < 32) continue;
    let copies = true;
    for (let i = 3; i <= 14; i++) if (c[16 + i] !== c[i + 1]) { copies = false; break; }
    if (!copies || (c[2] === c[17] && c[3] === c[18])) continue;
    c[2] = c[17]; c[3] = c[18]; repaired++;
  }
  return repaired;
}

export function createVmdParser(onTracks?: (report: VmdTrackReport) => void, transform?: VmdDataTransform): object {
  const parser = new MMDParser.Parser();
  const parse = parser.parseVmd.bind(parser);
  parser.parseVmd = (buffer: ArrayBuffer, leftToRight: boolean) => {
    const parsed = parse(readableVmdHeader(buffer), leftToRight);
    repairVmdCurveBytes(parsed?.motions);
    const result = stripDefaultVmdTracks(parsed);
    onTracks?.(result.report);
    return transform ? transform(result.vmd, buffer) : result.vmd;
  };
  return parser;
}

/** Parses one VMD exactly as a load would (header repair, default-track strip, transform), without building a clip. */
export function parseVmdWith(buffer: ArrayBuffer, transform?: VmdDataTransform): VmdTrackData {
  return (createVmdParser(undefined, transform) as { parseVmd(buffer: ArrayBuffer, leftToRight: boolean): VmdTrackData }).parseVmd(buffer, true);
}
