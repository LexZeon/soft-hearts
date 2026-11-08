/**
 * Test-only, read-only VMD reader shaped like three's `MMDParser.parseVmd(buffer, true)`
 * (the sandbox lacks `three/examples`). Left-to-right conversion as the parser does:
 * position z and rotation x/y are negated. Bytes are never modified.
 */
import type { VmdBoneFrame, VmdMorphFrame } from '../../src/stage/vmd-tracks';

export interface VmdLiteBoneFrame extends VmdBoneFrame { position: number[]; rotation: number[]; interpolation: number[] }
export interface VmdLite {
  metadata: { name: string; motionCount: number; morphCount: number; cameraCount: number };
  motions: VmdLiteBoneFrame[];
  morphs: VmdMorphFrame[];
  cameras: unknown[];
}

export function readVmdLite(input: Uint8Array): VmdLite {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const decoder = new TextDecoder('shift_jis');
  const text = (at: number, length: number) => {
    const raw = input.subarray(at, at + length), end = raw.indexOf(0);
    return decoder.decode(raw.subarray(0, end < 0 ? length : end));
  };
  const signature = new TextDecoder('ascii').decode(input.subarray(0, 25));
  const nameLength = signature === 'Vocaloid Motion Data 0002' ? 20 : 10;
  let at = 30;
  const name = text(at, nameLength); at += nameLength;
  const motionCount = view.getUint32(at, true); at += 4;
  const motions: VmdLiteBoneFrame[] = [];
  for (let n = 0; n < motionCount; n++, at += 111) {
    const f = (k: number) => view.getFloat32(at + 19 + k * 4, true);
    motions.push({
      boneName: text(at, 15), frameNum: view.getUint32(at + 15, true),
      position: [f(0), f(1), -f(2)], rotation: [-f(3), -f(4), f(5), f(6)],
      interpolation: Array.from(input.subarray(at + 47, at + 111)),
    });
  }
  const morphs: VmdMorphFrame[] = [];
  const morphCount = at + 4 <= input.length ? view.getUint32(at, true) : 0; at += 4;
  for (let n = 0; n < morphCount; n++, at += 23) morphs.push({ morphName: text(at, 15), frameNum: view.getUint32(at + 15, true), weight: view.getFloat32(at + 19, true) });
  return { metadata: { name, motionCount, morphCount, cameraCount: 0 }, motions, morphs, cameras: [] };
}
