import catalog from '../../shared/motion-catalog.json';

// Fixed background identities only. An idle tag or familiar filename is never
// sufficient; model-specific playback acceptance remains a separate check.
const backgroundPoses = [
  { filename: 'stand.vmd', packId: 'gene', motionId: 'stand' },
  { filename: 'neutral-idle.vmd', packId: '100style-idles', motionId: 'neutral-idle' },
] as const;

/** Cheap prefilter only; callers still require the content verification below. */
export function isDefaultPoseCandidateName(name: unknown): boolean {
  return backgroundPoses.some(entry => entry.filename === name);
}

/** Verify the exact pinned bytes before treating a small-motion pose as background. */
export async function isReviewedDefaultPose(url: string, request: typeof fetch = fetch): Promise<boolean> {
  try {
    const source = new URL(url);
    if (source.protocol !== 'mmd-asset:' || source.search || source.hash || url.includes('?') || url.includes('#')) return false;
    const filename = decodeURIComponent(source.pathname).split('/').at(-1);
    const background = backgroundPoses.find(entry => entry.filename === filename);
    if (!background) return false;
    const motion = catalog.packs.find(pack => pack.id === background.packId)?.motions.find(entry => entry.id === background.motionId);
    if (!motion) return false;
    const response = await request(url);
    if (!response.ok) return false;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== motion.bytes) return false;
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    return hash === motion.sha256;
  } catch { return false; }
}
