/**
 * I-176 prep, audit row 6: the Unbound window tells the experience record whether her blush was really shown ('blush-stage'), the same
 * closed words as the old stage (src/stage/blush-seen.ts, what src/stage/mmd/mood.ts hands to options.onBlushCue): once per blush cue,
 * 'shown' / 'no-cheek' / 'face-busy' / 'off' / 'size-zero'. A synthetic rig (tests/helpers/window-face-fixture.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowFace, type WindowFaceEnv } from '../src/unbound/window-mode/window-face';
import { BlushSeen, type BlushStageState } from '../src/stage/blush-seen';
import { card, faceView, syntheticRig } from './helpers/window-face-fixture';

const ENV: WindowFaceEnv = { shown: true, adjusting: false, voiced: false, speaking: false };
function setup(opts: { painted?: boolean; blushChannel?: number; off?: boolean; size?: number; faceBlocked?: boolean; cue?: string } = {}) {
  const told: BlushStageState[] = [];
  const face = new WindowFace();
  face.attach(syntheticRig({ blushChannel: opts.blushChannel ?? -1 }));
  face.setPainted(opts.painted ?? true);
  if (opts.off) face.setCard(card(['blush'], { blush: 'off' }));
  if (opts.faceBlocked) face.setBlocks({ face: true, mouth: false, head: false });
  const view = faceView({ blushCue: { id: opts.cue ?? 'b1', amount: 1 } });
  if (opts.size !== undefined) view.parameters.blush.size = opts.size;
  face.setMood(view);
  face.onBlushCue = state => told.push(state);
  return { face, told, view };
}
const run = (face: WindowFace, frames = 90) => { for (let i = 0; i < frames; i++) face.frame(1 / 60, ENV); };

test('a shown blush in the window is told exactly once per cue, however many frames it lasts', () => {
  const { face, told } = setup();
  run(face, 240);
  assert.deepEqual(told, ['shown']);
});

test('a new cue is told again; the same cue is not', () => {
  const { face, told, view } = setup();
  run(face);
  face.setMood({ ...view, snapshot: { ...view.snapshot, blush: { ...view.snapshot.blush!, id: 'b2' } } });
  run(face); run(face);
  assert.deepEqual(told, ['shown', 'shown']);
});

test('the same facts give the same word as the old stage (BlushSeen), for every way it can fail', () => {
  const cases: { name: string; opts: Parameters<typeof setup>[0]; facts: Parameters<BlushSeen['observe']>[1] }[] = [
    { name: 'painted', opts: {}, facts: { path: 'procedural', faceBlocked: false, off: false, size: 50 } },
    { name: 'own morph', opts: { painted: false, blushChannel: 13 }, facts: { path: 'morph', faceBlocked: false, off: false, size: 50 } },
    { name: 'no cheek', opts: { painted: false, blushChannel: -1 }, facts: { path: 'none', faceBlocked: false, off: false, size: 50 } },
    { name: 'face busy', opts: { faceBlocked: true }, facts: { path: 'procedural', faceBlocked: true, off: false, size: 50 } },
    { name: 'off', opts: { off: true }, facts: { path: 'none', faceBlocked: false, off: true, size: 50 } },
    { name: 'size zero', opts: { size: 0 }, facts: { path: 'procedural', faceBlocked: false, off: false, size: 0 } },
  ];
  for (const c of cases) {
    const { face, told } = setup(c.opts);
    run(face);
    const old = new BlushSeen().observe('b1', c.facts);
    assert.ok(old, c.name);
    assert.deepEqual(told, [old], `${c.name}: the window tells '${told[0]}', the old stage '${old}'`);
  }
});

test('no cue, no fact: a window with no blush cue tells nothing; a throwing listener never stops her frame', () => {
  const face = new WindowFace(); face.attach(syntheticRig()); face.setPainted(true); face.setMood(faceView());
  const told: string[] = []; face.onBlushCue = s => told.push(s);
  run(face);
  assert.deepEqual(told, []);
  const bad = setup(); bad.face.onBlushCue = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => run(bad.face));
});
