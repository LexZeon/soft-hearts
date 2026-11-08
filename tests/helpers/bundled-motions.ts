/** Read-only access to the bundled (CC BY) library VMDs and Gene for retarget tests. */
import { readFileSync } from 'node:fs';
import catalog from '../../shared/motion-catalog.json';
import bundled from '../../shared/bundled-assets.json';
import { stripDefaultVmdTracks } from '../../src/stage/vmd-tracks';
import { readPmxLite } from './pmx-lite';
import { readVmdLite, type VmdLite } from './vmd-lite';

const ASSETS = new URL('../../assets/bundled/', import.meta.url);
const PACK_ROOTS: Record<string, string> = {
  gene: 'mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03', '100style-idles': '100style/100style-idles/3ad1793831ecf4301fec98d4462e5470bd2ae2da',
  'mpi-embm-gestures': 'mpi-embm/mpi-embm-gestures/c379688214b270a17f5d7312691a12b7c69312bb',
  'genea-2022-gestures': 'genea-2022/genea-2022-gestures/78e7cf914e0679d94fe24410452e4f63e4860ccf', 'fnoji-dances': 'fnoji/fnoji-dances/10b9af30fcc7b0b060138b459ad891f9453ecd23',
  'soft-hearts-actions': 'soft-hearts-next/soft-hearts-actions/636749eea3aa947bc115881083f31f2b8fb26cdd',
};
export const catalogMotions = catalog.packs.flatMap(pack => pack.motions.map(motion => ({ packId: pack.id, ...motion })));
export const motionBytes = (packId: string, relativePath: string) => new Uint8Array(readFileSync(new URL(`${PACK_ROOTS[packId]}/${relativePath}`, ASSETS)));
export function bundledMotionBytes(id: string): Uint8Array {
  const motion = catalogMotions.find(entry => entry.id === id);
  if (!motion) throw new Error(`No bundled motion ${id}`);
  return motionBytes(motion.packId, motion.relativePath);
}
/** Parsed and default-stripped exactly like the stage's parser hook sees it. */
export const loadBundledMotion = (id: string): VmdLite => stripDefaultVmdTracks(readVmdLite(bundledMotionBytes(id))).vmd;
export const readGene = () => readPmxLite(new Uint8Array(readFileSync(new URL(`${bundled.root}/${bundled.model.relativePath}`, ASSETS))));
