/**
 * R29c: the two one-frame cuts R29b left (docs/claude/2026-11-02-R29b-continuity.md):
 * 1. the drowsy face (困る brow, じと目 eye shape, a small head nod) vanished in
 *    one frame on a head pat, when the music was turned on and on a window adjust;
 * 2. cancelling an automatic body motion stopped its player outright, so the
 *    body snapped back to the base pose.
 * Real Stage frame loop on the bundled Gene (gene-stage-harness), 60 fps.
 *
 * - Bones: the R29b surprise measure (a frame's step vs repeating the previous
 *   one) may not exceed 1.25x the undisturbed run's own largest, floor 0.15 deg.
 * - Drowsy morphs: the largest one-frame change of the shown weight after the
 *   event, as a share of what was shown before it. A fade over 0.35 s (smoothstep)
 *   peaks at ~7% per frame at 60 fps; a cut shows the whole remaining drop at once.
 * Natural blinks are off in the drowsy runs so the eye-shape steps are the drowsy
 * channel's own (its yield to the blink is covered by drowsy-expression tests).
 * R29_REPORT=1 prints the numbers recorded in the R29c section of that page.
 * Module-level checks: tests/motion-transition.test.ts (derived bones, sizing,
 * handOffToBase), tests/body-motion-stage.test.ts (release hook),
 * tests/drowsy-expression.test.ts (channel release).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_CONTACT } from '../src/stage/mood-feedback';
import { DROWSY_RELEASE_SECONDS } from '../src/stage/drowsy-expression';
import { HANDOFF_MAX_MS } from '../src/stage/motion-transition';
import { geneStage, measureHandoff, patContact, pointAtScalp, type BoneHandoff, type GeneStage, type HandoffScript, type MorphHandoff } from './helpers/gene-stage-harness';

const FLOOR = 0.15;
function noTeleport(bones: BoneHandoff[], label: string, ends: { start?: boolean; end?: boolean } = { start: true, end: true }): void {
  for (const bone of bones) {
    const limit = Math.max(bone.sourceSurprise * 1.25, FLOOR);
    if (ends.start) assert.ok(bone.startSurprise <= limit, `${label}: ${bone.bone} jumps at the start (${bone.startSurprise.toFixed(3)} > ${limit.toFixed(3)} deg)`);
    if (ends.end) assert.ok(bone.endSurprise <= limit, `${label}: ${bone.bone} jumps at the end (${bone.endSurprise.toFixed(3)} > ${limit.toFixed(3)} deg)`);
  }
}
/** Share of the shown drowsy weight one frame may take: the 0.35 s smoothstep peaks at 1.5 / 21 = 7.1% at 60 fps. */
const MORPH_SHARE = 0.12;
function noMorphCut(morph: MorphHandoff, label: string): void {
  assert.ok(morph.before > 0.02, `${label}: the drowsy face is shown before the event (${morph.before.toFixed(4)})`);
  assert.ok(morph.startStep <= morph.before * MORPH_SHARE,
    `${label}: one frame takes ${(100 * morph.startStep / morph.before).toFixed(1)}% of the shown weight (${morph.startStep.toFixed(4)} of ${morph.before.toFixed(4)})`);
}
const bone = (bones: BoneHandoff[], name: string) => bones.find(value => value.bone === name)!;
function report(label: string, m: { bones: BoneHandoff[]; morphs?: { brow: MorphHandoff; jitome: MorphHandoff }; guard?: { jumps: number } }): void {
  if (!process.env.R29_REPORT) return;
  const f = (value: number) => value.toFixed(3), worst = [...m.bones].sort((a, b) => b.startSurprise - a.startSurprise).slice(0, 3);
  const morphs = m.morphs ? ` | brow ${m.morphs.brow.startStep.toFixed(4)}/${m.morphs.brow.before.toFixed(4)} jitome ${m.morphs.jitome.startStep.toFixed(4)}/${m.morphs.jitome.before.toFixed(4)}` : '';
  console.log(`${label}: ${worst.map(v => `${v.bone} ${f(v.startSurprise)}/${f(v.endSurprise)} (source ${f(v.sourceSurprise)})`).join(', ')}${morphs} | guard jumps ${m.guard?.jumps}`);
}
const drowsyState = (h: GeneStage) => JSON.parse(h.stage.renderer.domElement.dataset.drowsyExpression ?? 'null') as
  { active: boolean; headX: number; brow: number; eyeShape: number; reason: string } | null;
const noBlinks = (h: GeneStage) => { h.stage.nextBlink = Infinity; };

// ------------------------------------------------------------------ 1. drowsy face

test('R29c drowsy: a head pat fades the drowsy face out from what is shown (no one-frame cut), and it eases back after', async () => {
  const states: ReturnType<typeof drowsyState>[] = [];
  const m = await measureHandoff({ drowsy: true }, { t0: 3, hold: 1.5, after: 1.5,
    prepare: h => { noBlinks(h); pointAtScalp(h); },
    start: h => h.stage.setMoodContact(patContact(0)),
    during: (h, time) => { h.stage.setMoodContact(patContact(time)); states.push(drowsyState(h)); },
    end: h => h.stage.setMoodContact({ ...EMPTY_CONTACT }) });
  report('drowsy + pat', m);
  noTeleport(m.bones, 'drowsy + pat');
  noMorphCut(m.morphs.brow, 'brow'); noMorphCut(m.morphs.jitome, 'eye shape');
  const settled = states[Math.ceil((DROWSY_RELEASE_SECONDS + 0.05) * 60)];
  assert.equal(settled?.active, false, 'the pat still owns the face: the profile is out after its release');
  assert.equal(settled?.reason, 'contact-or-adjusting');
});

test('R29c drowsy: turning the music on releases only the drowsy head nod (music owns the head); the face stays, nothing cuts', async () => {
  const heads: number[] = [];
  const music: HandoffScript = { t0: 3, hold: 1, after: 1, prepare: noBlinks,
    start: h => h.stage.setMusicEnabled(true), end: h => h.stage.setMusicEnabled(false) };
  const m = await measureHandoff({ drowsy: true }, { ...music, during: h => heads.push(drowsyState(h)?.headX ?? NaN) });
  // The same switch without the drowsy profile: the dance's own onset is the reference.
  const plain = await measureHandoff({ primary: 'calm' }, music);
  report('drowsy + music on', m); report('calm + music on (reference)', plain);
  for (const value of m.bones) {
    const reference = bone(plain.bones, value.bone);
    const limit = Math.max(reference.startSurprise * 1.25, FLOOR);
    assert.ok(value.startSurprise <= limit, `${value.bone}: the drowsy release adds a jump to the music start (${value.startSurprise.toFixed(3)} > ${limit.toFixed(3)})`);
  }
  for (const key of ['brow', 'jitome'] as const) {
    assert.ok(m.morphs[key].startStep <= m.morphs[key].before * 0.02, `${key}: the face is not the music's, it does not dip (${m.morphs[key].startStep.toFixed(4)})`);
  }
  assert.ok(heads[0] > 0.01, 'the drowsy nod is shown when the music starts');
  const frames = Math.round(DROWSY_RELEASE_SECONDS * 60);
  assert.equal(heads[frames], 0, 'the nod is fully released after DROWSY_RELEASE_SECONDS');
  const headSteps = heads.slice(1, frames + 1).map((value, i) => heads[i] - value);
  assert.ok(Math.max(...headSteps) <= heads[0] * 1.5 / frames + 1e-9, 'the nod fades by smoothstep, never in one frame');
});

test('R29c drowsy: a window adjust fades the drowsy face out and it eases back after; nothing jumps', async () => {
  const m = await measureHandoff({ drowsy: true }, { t0: 3, hold: 1, after: 1.5, prepare: noBlinks,
    start: h => h.stage.setBehaviorBlocked(true), end: h => h.stage.setBehaviorBlocked(false) });
  report('drowsy + window adjust', m);
  noTeleport(m.bones, 'drowsy + window adjust');
  noMorphCut(m.morphs.brow, 'brow'); noMorphCut(m.morphs.jitome, 'eye shape');
  assert.ok(m.morphs.jitome.afterStart < m.morphs.jitome.before * 0.05, 'the eye shape is gone while the window is being adjusted');
});

// ------------------------------------------------------------------ 2. automatic body motion

const cancelBy: Record<string, Pick<HandoffScript, 'start' | 'end' | 'during' | 'prepare'>> = {
  typing: { start: h => h.stage.setTyping(true), end: h => h.stage.setTyping(false) },
  // Through the controller's own update (speech blocks a non-confirm body motion), not the Stage's cancel call.
  speaking: { start: h => h.stage.setSpeaking(true), end: h => h.stage.setSpeaking(false) },
  pat: { prepare: pointAtScalp, start: h => h.stage.setMoodContact(patContact(0)),
    during: (h, time) => h.stage.setMoodContact(patContact(time)), end: h => h.stage.setMoodContact({ ...EMPTY_CONTACT }) },
};

for (const [recipe, by] of [['idle.neutral', 'typing'], ['idle.proud', 'typing'], ['body.confirm', 'typing'], ['idle.neutral', 'speaking'], ['idle.neutral', 'pat']] as const) {
  test(`R29c body: cancelling ${recipe} (${by}) hands the shown pose back to the running base (no snap)`, async () => {
    const seen = { active: [] as boolean[], bridged: [] as boolean[] };
    const script = cancelBy[by];
    const m = await measureHandoff({ body: { recipe } }, { t0: 2.5, hold: 1, after: 0.8, ...script,
      start: h => { script.start(h); seen.active.push(h.stage.bodyMotion.getState().active); seen.bridged.push(!!h.stage.motionTransition?.getState().active); },
      during: (h, time) => { script.during?.(h, time); if (time >= 2.5 + HANDOFF_MAX_MS / 1000 + 0.05) seen.bridged.push(!!h.stage.motionTransition?.getState().active); } });
    report(`${recipe} cancelled by ${by}`, m);
    noTeleport(m.bones, `${recipe} / ${by}`, { start: true });
    assert.equal(m.guard.jumps, 0, 'nothing is left for the display guard to catch (grant and IK bones are bridged too)');
    assert.deepEqual([seen.active[0], seen.bridged[0]], [false, true], 'ownership ends at once; the display is bridged');
    assert.equal(seen.bridged.at(-1), false, 'the bridge has finished: she is on the running base');
  });
}

test('R29c body: hide and a scope change still clear at once (nothing is shown, so there is no bridge)', async () => {
  for (const clear of ['hide', 'scope'] as const) {
    const h = await geneStage({ body: { recipe: 'idle.neutral' } });
    try {
      h.run(1.5);
      assert.equal(h.stage.bodyMotion.getState().active, true);
      if (clear === 'hide') h.stage.setVisible(false);
      else h.stage.invalidateMoodScope();
      assert.equal(h.stage.bodyMotion.getState().active, false, `${clear}: the motion is gone`);
      assert.ok(!h.stage.motionTransition?.getState().active, `${clear}: no bridge was started`);
    } finally { h.close(); }
  }
});
