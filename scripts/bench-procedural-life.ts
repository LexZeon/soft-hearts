// Procedural-life micro-benchmark: per-frame cost of the generator with a
// reused input, as the stage calls it (frame + body/face/preview apply + blink + eyelid compositor).
// Run:
//   node --import ./node_modules/tsx/dist/esm/index.mjs scripts/bench-procedural-life.ts
// Allocation is attributed with V8's sampling heap profiler to stacks inside
// the procedural-life modules only: a heapUsed delta would also count the tsx
// loader's own message traffic, which is noise at this scale.
import { Session } from 'node:inspector/promises';
import { EyelidCompositor } from '../src/stage/channel-compositors';
import { ProceduralLife, type LifeGates, type LifeInput, type LifePort } from '../src/stage/procedural-life';
import { SHY_CLIP_ID } from '../shared/surprise-preview';

const FRAMES = 200_000, DT = 1 / 60;
const owner = {}, bone = {};
const gates: LifeGates = { expressive: true, contact: false, manualPose: false, manualGesture: false, manualHead: false, manualExpression: false,
  manualMouth: false, chatGesture: false, music: false, bodyMotion: false, headOwned: false, authoredFace: false, preview: false, adjusting: false,
  speaking: false, gazeAllowed: true };
const input: LifeInput<object> = { enabled: true, owner, seedKey: 'bench', rig: { owner, upperBody: bone, shoulderLeft: bone, shoulderRight: bone,
  slots: { smileEyes: 1, mouthSmile: 2, sad: 3, angry: 4, jitome: 5, mouthOpen: 6 } },
  mood: { primary: 'happy', companion: 'playful', values: { D: 70, O: 60, E: 60, N: 60, C: 40 }, intensity: { expression: 50, gaze: 50, posture: 50 } },
  fatigue: { phase: 'awake', F: 0.1, sleeping: false }, pointerX: 0, pointerY: 0, breathStrength: 0.5, hasEyes: true,
  blush: { enabled: true, intensity: 35, size: 50 }, gates };
const lids = new EyelidCompositor(), lidInput = { contact: 0, cheek: 0, fatigue: 0, naturalBlink: 0, soft: 0, smileEyes: 0, jitome: 0 };
const sink = new Float64Array(1), eyes = [bone, bone];
const port: LifePort<object> = { rotate(_bone, x, y, z) { sink[0] += x + y + z; }, head(x, y, z) { sink[0] += x + y + z; }, morph(_index, weight) { sink[0] += weight; } };
const life = new ProceduralLife<object>();
const times = new Float64Array(FRAMES);

function frame(f: number, timed: boolean): void {
  input.pointerX = Math.sin(f * 0.01) * 0.4;
  // Every 7 s someone pats her for 1 s and every 10 s she talks: yields and fades run too.
  gates.contact = f % 420 > 360;
  gates.speaking = f % 600 > 400;
  // Every 10 s the shy preview plays its 1.8 s.
  const preview = f % 600 < 108; input.previewClip = preview ? SHY_CLIP_ID : null; input.previewElapsedMs = (f % 600) * DT * 1000; gates.preview = preview;
  const start = timed ? performance.now() : 0;
  life.frame(DT, input);
  life.applyBody(port);
  if (f % 240 === 0) life.beginBlink();
  lidInput.naturalBlink = life.blinkWeight((f % 240) * DT);
  lidInput.soft = life.out.lidSoft; lidInput.smileEyes = life.out.smileEyes; lidInput.jitome = life.out.jitome;
  life.applyFace(port, lids.frame(DT, lidInput, owner), 0);
  if (preview) life.applyPreview(port, bone, eyes, true, true);
  sink[0] += lidInput.naturalBlink + life.mixBreath(0.5);
  if (timed) times[f] = performance.now() - start;
}

for (let f = 0; f < FRAMES; f++) frame(f, true); // warm-up
for (let f = 0; f < FRAMES; f++) frame(f, true);
const sorted = Float64Array.from(times).sort();
const us = (q: number) => (sorted[Math.floor(q * (FRAMES - 1))] * 1000).toFixed(2);

const session = new Session(); session.connect();
await session.post('HeapProfiler.startSampling', { samplingInterval: 32 });
for (let f = 0; f < FRAMES; f++) frame(f, false);
const { profile } = await session.post('HeapProfiler.stopSampling') as { profile: { head: SampleNode } };
interface SampleNode { callFrame: { url: string }; selfSize: number; children: SampleNode[] }
const ours = /procedural-life|life-noise|continuous-expression|preview-performance|channel-compositors/;
let bytes = 0;
const walk = (node: SampleNode, inside: boolean) => {
  const here = inside || ours.test(node.callFrame.url);
  if (here) bytes += node.selfSize;
  for (const child of node.children) walk(child, here);
};
walk(profile.head, false);
session.disconnect();
console.log(`procedural life (frame + body/face/preview apply + blink + eyelid compositor): p50 ${us(0.5)} us, p99 ${us(0.99)} us per frame; sampled allocation inside the modules ${(bytes / FRAMES).toFixed(3)} B/frame`);
if (!Number.isFinite(sink[0])) throw new Error('non-finite output');
