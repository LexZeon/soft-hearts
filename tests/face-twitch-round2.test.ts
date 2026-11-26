/**
 * 2026-11-10 嘴、脸和头抽搐，第二轮 (docs/claude/2026-11-10-face-head-twitch.md "第二轮"). Around 21:24–21:28 she did a wink, a pout, a tilt or a heart after almost every reply, happy / close, blushing.
 * On the user's model a wink's conflict group is 25 eye morphs (the smile-eye among them, with its single-side versions), a pout's
 * 21 mouth morphs, all with large overlaps; Gene shows the same thing (ウィンク and 笑い share 396 vertices).
 *
 * On the real stage frame loop (gene-stage-harness: bundled Gene, Stand, procedural life, her own activity, mood feedback, the
 * display guard, playHerAction), happy and close, a wink and a pout, against the same stage without them:
 *  - the eye that does not wink keeps its smile (its vertices, from every morph as displayed, against the idle stage);
 *  - the winking eye never closes past the wink itself (no double closure: smile-eye + wink on the same lid), and it does not
 *    open first and then close (the base leaving before the wink arrives);
 *  - the pout takes the smiling mouth over at its own pace: the mouth smile never drops faster than the pout arrives, and the
 *    mouth never passes through a blank face between the two;
 *  - 60 fps and 30 fps settings on a 60 Hz screen.
 * And the module alone (face-keep.ts, face-exclusive.ts) on a small synthetic face with two lids: what is kept and on which
 * morph, the duplicate and the sliver, a model with no single-side morph (nothing kept: as before), ownership never ahead of the
 * clip, speed continuity with the partners written.
 * FACE_TWITCH_REPORT=1 prints the numbers in the doc.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { FaceExclusive, type FaceRequest } from '../src/stage/face-exclusive';
import { ChatActionHost, CHAT_ACTION_AFTER_SPEECH_MS, CHAT_ACTION_SPEECH_POLL_MS } from '../electron/brain/chat-actions-host';
import { createReactionPerformers } from '../electron/mood/reactions/performers';
import { CHAT_FACE_ACTION_GAP_MS, type ChatActionWord } from '../shared/brain/chat-actions';
import { buildModelProfile } from '../shared/stage/model-profile';
import type { HerActionId } from '../shared/actions/her-actions';
import type { GestureAnswer } from '../shared/memory/journal';
import type { ModelCapabilityView } from '../shared/stage/model-capability-check';
import { readGene } from './helpers/bundled-motions';
import { profileInput } from './helpers/model-fixtures';
import { type ShownFrame } from './helpers/frame-stats';

const REPORT = process.env.FACE_TWITCH_REPORT === '1';

/**
 * Two lids of four vertices (0–3 left, 4–7 right) and a brow vertex (8). Morphs: 0 wink (left lid down, the brow a hair),
 * 1 smile-eye on both lids, 2 the right lid's own smile, 3 the same right smile at 1.5× (a duplicate at another size), 4 a brow
 * raise that touches the left lid by a sliver, 5 a surprise on both lids (no single-side version on this face).
 */
function lids(withRightSmile = true) {
  const geometry = new BufferGeometry(), n = 9;
  geometry.setAttribute('position', new Float32BufferAttribute(new Array(n * 3).fill(0), 3));
  const morph = (moves: [number, number][]) => {
    const values = new Array(n * 3).fill(0);
    for (const [vertex, dy] of moves) values[vertex * 3 + 1] = dy;
    return new Float32BufferAttribute(values, 3);
  };
  const left = [0, 1, 2, 3], right = [4, 5, 6, 7];
  geometry.morphAttributes.position = [
    morph([...left.map(v => [v, -0.05] as [number, number]), [8, -0.002]]),
    morph([...left, ...right].map(v => [v, -0.02])),
    morph(withRightSmile ? right.map(v => [v, -0.02]) : []),
    morph(withRightSmile ? right.map(v => [v, -0.03]) : []),
    morph([[8, 0.04], [0, 0.0005]]),
    morph([...left, ...right].map(v => [v, 0.01])),
  ];
  geometry.morphTargetsRelative = true;
  return { geometry, morphTargetInfluences: [0, 0, 0, 0, 0, 0] };
}
const WINK_KEYS = { times: [0, 3, 6, 9, 16].map(f => f / 30), values: [0, 0.35, 0.9, 0.9, 0] };
/** A stage-like loop: the writers' base each frame (a smile-eye, a brow, a surprise), then frame(), restored next frame. */
function lidRig(mesh = lids(), base = (_t: number) => [0, 0.6, 0, 0, 0.5, 0.3]) {
  const exclusive = new FaceExclusive(mesh), layers: { index: number; value: number }[] = [];
  let now = 0;
  const step = (dt: number) => {
    for (const layer of layers) mesh.morphTargetInfluences[layer.index] = layer.value;
    layers.length = 0;
    now += dt;
    base(now).forEach((value, index) => { mesh.morphTargetInfluences[index] = value; });
    exclusive.frame(dt, { key: 'k' }, mesh.morphTargetInfluences, layers);
    return [...mesh.morphTargetInfluences];
  };
  /** Per-vertex y offset of the shown weights. */
  const shown = (y: number[]) => Array.from({ length: 9 }, (_, v) => mesh.geometry.morphAttributes.position!.reduce((sum, target, i) => sum + y[i] * target.getY(v), 0));
  return { exclusive, mesh, layers, step, shown, time: () => now };
}
const winkRequest = (overrides: Partial<FaceRequest> = {}): FaceRequest =>
  ({ id: `w${Math.random()}`, scope: 'eyelids', key: 'k', duration: 16 / 30, tracks: [{ index: 0, ...WINK_KEYS }], ...overrides });

test('module: a wink keeps the other lid\'s smile on its own morph, the brow on itself; the winking lid shows only the wink', () => {
  const r = lidRig();
  r.step(1 / 60);
  const before = r.shown(r.step(1 / 60));
  assert.equal(r.exclusive.request(winkRequest()), true);
  let hold: number[] | null = null, worstOther = 0, worstBrow = 0;
  while (r.exclusive.active('eyelids')) {
    const y = r.step(1 / 60), at = r.shown(y), state = r.exclusive.getState().eyelids;
    for (const v of [4, 5, 6, 7]) worstOther = Math.max(worstOther, Math.abs(at[v] - before[v]));
    worstBrow = Math.max(worstBrow, Math.abs(at[8] - before[8] - y[0] * -0.002));
    if (state && state.elapsedMs > 210 && state.elapsedMs < 290) hold = y;
  }
  assert.ok(hold, 'frames in the hold');
  assert.ok(Math.abs(hold[1]) < 1e-9, 'the bilateral smile-eye leaves (it moves the winking lid)');
  assert.ok(Math.abs(hold[2] - 0.6) < 1e-6 && Math.abs(hold[3]) < 1e-9, `kept on the right lid's own smile at its own size, not the 1.5× duplicate (${hold[2]}, ${hold[3]})`);
  assert.ok(Math.abs(hold[4] - 0.5) < 0.02, `a brow that only grazes the lid keeps itself (${hold[4]})`);
  assert.ok(worstBrow <= 0.03 * 0.5 * 0.04, `the brow vertex keeps its raise (moved ${worstBrow} beyond the wink's own pull)`);
  assert.ok(Math.abs(hold[5]) < 1e-9, 'a surprise with no single-side morph on this face is taken as before');
  const at = r.shown(hold);
  for (const v of [0, 1, 2, 3]) assert.ok(Math.abs(at[v] - (-0.05 * 0.9 + (v === 0 ? 0.0005 * hold[4] : 0))) < 1e-6, `left lid vertex ${v} shows the wink alone (${at[v]})`);
  assert.ok(worstOther <= 0.01 * 0.3 + 1e-9, `the right lid moved only by the surprise it lost (${worstOther})`);
  const after = r.step(1 / 60);
  assert.deepEqual(after, [0, 0.6, 0, 0, 0.5, 0.3], 'over: exactly the base');
});

test('module: on a face with no single-side morph nothing is kept (exactly the T-215 hold)', () => {
  const r = lidRig(lids(false));
  r.step(1 / 60);
  assert.equal(r.exclusive.request(winkRequest()), true);
  let hold: number[] | null = null;
  while (r.exclusive.active('eyelids')) {
    const y = r.step(1 / 60), state = r.exclusive.getState().eyelids;
    if (state && state.elapsedMs > 210 && state.elapsedMs < 290) hold = y;
  }
  assert.deepEqual(hold && [hold[1], hold[2], hold[3], hold[5]], [0, 0, 0, 0]);
});

test('module: ownership never runs ahead of the clip, and speed stays continuous with the partners written (h = 1e-5 s)', context => {
  // The base keeps moving (a smile that breathes) so a kink in the partner write would show.
  const moving = (t: number) => [0, 0.5 + 0.1 * Math.sin(5 * t), 0, 0, 0.4 + 0.1 * Math.sin(3 * t), 0.2];
  let ahead = 0;
  {
    const r = lidRig(lids(), moving);
    r.step(0.2);
    assert.equal(r.exclusive.request(winkRequest()), true);
    while (r.exclusive.active('eyelids')) {
      const y = r.step(1 / 60), state = r.exclusive.getState().eyelids;
      // Shown wink y = w·A, so w ≤ A / 0.9 (the clip's own progress) is w² ≤ y / 0.9.
      if (state && state.phase !== 'exiting') ahead = Math.max(ahead, state.weight ** 2 - y[0] / 0.9);
    }
  }
  assert.ok(ahead <= 1e-6, `the base hands over no faster than the wink arrives (ownership ahead by ${ahead})`);
  let worst = 0;
  for (const at of [2e-5, 0.05, 0.1, 0.2, 0.3, 0.42, 16 / 30 - 1e-4]) {
    const r = lidRig(lids(), moving);
    r.step(0.2);
    assert.equal(r.exclusive.request(winkRequest()), true);
    let t = 0, y0 = r.step(0);
    while (at - 1e-5 - t > 1e-12) { const dt = Math.min(1 / 60, at - 1e-5 - t); y0 = r.step(dt); t += dt; }
    const y1 = r.step(1e-5), y2 = r.step(1e-5);
    for (let i = 0; i < y1.length; i++) worst = Math.max(worst, Math.abs((y1[i] - y0[i]) / 1e-5 - (y2[i] - y1[i]) / 1e-5));
  }
  assert.ok(worst < 0.005, `one-sided speeds differ by ${worst.toFixed(6)}/s at most`);
  context.diagnostic(`largest one-sided speed difference with partners: ${worst.toFixed(6)}/s`);
});

interface Offsets { vertices: number[]; morphs: { index: number; d: Float64Array }[] }
/** The displayed offsets of those vertices in one frame (every morph as shown). */
function shape(o: Offsets, frame: ShownFrame): Float64Array {
  const out = new Float64Array(o.vertices.length * 3);
  for (const { index, d } of o.morphs) { const w = frame.all![index]; if (w) for (let k = 0; k < out.length; k++) out[k] += w * d[k]; }
  return out;
}
const apart = (a: Float64Array, b: Float64Array) => { let m = 0; for (let k = 0; k < a.length; k += 3) m = Math.max(m, Math.hypot(a[k] - b[k], a[k + 1] - b[k + 1], a[k + 2] - b[k + 2])); return m; };

export interface WinkNumbers { kept: number; keptStep: number; smileLost: number; overClose: number; openFirst: number; smileMin: number; guard: number }

export interface PoutNumbers { smileStep: number; blank: number; smileFrom: number; guard: number }

// ---------------------------------------------------------------- her own face shapes, spaced (CHAT_FACE_ACTION_GAP_MS)

const GENE = readGene();
const GENE_PROFILE = buildModelProfile(profileInput({ positions: GENE.positions, skinBone: GENE.skinBone, bones: GENE.bones, morphs: GENE.morphs }));
const IDLE = { expressions: true, snapshot: { phase: 'idle', intensity: { posture: 1, expression: 1 } } };
function spacingHost(options: { speaking?: () => boolean } = {}) {
  const state = { now: 0, played: [] as HerActionId[], journal: [] as [ChatActionWord | null, GestureAnswer | null, boolean][], timers: new Map<number, () => void>(), serial: 0 };
  const host = new ChatActionHost({
    modelPath: () => 'C:/models/gene.pmx',
    read: async () => ({ view: { modelKey: 'k'.repeat(64), modelUrl: '', profile: GENE_PROFILE, record: null } as ModelCapabilityView, fits: null }),
    play: async action => { state.played.push(action); return { status: 'played', missing: [], detail: '' }; },
    speaking: options.speaking ?? (() => false), mood: () => IDLE, now: () => state.now,
    journal: (word, answer, waited) => { state.journal.push([word, answer, waited]); },
    timers: { set: callback => { const id = ++state.serial; state.timers.set(id, callback); return id; }, clear: id => { state.timers.delete(id as number); } },
  });
  const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  const fire = () => { const [id, callback] = [...state.timers][0] ?? []; assert.ok(callback, 'a timer is waiting'); state.timers.delete(id!); state.now += CHAT_ACTION_SPEECH_POLL_MS; callback!(); };
  return { host, state, settle, fire };
}

test('her own face shapes are at least 25 s apart; body actions and the user\'s own request through the channel never wait', async () => {
  assert.equal(CHAT_FACE_ACTION_GAP_MS, 25_000);
  const { host, state, settle } = spacingHost();
  host.request('wink'); await settle();
  assert.deepEqual(state.played, ['wink']);
  state.now = 8_000; host.request('pout'); await settle();
  assert.deepEqual(state.played, ['wink'], 'her pout 8 s after her wink is skipped');
  assert.deepEqual(state.journal.at(-1), ['pout', 'spaced', false], 'and the journal says why');
  state.now = 9_000; host.request('nod'); await settle();
  assert.deepEqual(state.played, ['wink', 'nod'], 'a body action is never spaced');
  state.now = 24_999; host.request('wink'); await settle();
  assert.deepEqual(state.played, ['wink', 'nod']);
  state.now = 25_000; host.request('wink'); await settle();
  assert.deepEqual(state.played, ['wink', 'nod', 'wink'], '25 s after: hers again');
  // The user asking through the internal channel is never spaced, and it counts as the last face shape.
  state.now = 26_000;
  assert.equal((await host.perform('pout')).status, 'played', 'the channel (the user\'s own request) plays at once');
  state.now = 40_000; host.request('wink'); await settle();
  assert.deepEqual(state.played, ['wink', 'nod', 'wink', 'pout'], 'her wink 14 s after the channel\'s pout waits');
  // An I-037 reaction is hers: spaced, answered "busy" with the reason; its gate says so before it is chosen.
  const reaction = await host.perform('wink', { hers: true });
  assert.deepEqual([reaction.status, reaction.played], ['busy', false]);
  assert.match(reaction.reason, /刚做过一个小表情/u);
  assert.equal(host.spaced('wink'), true); assert.equal(host.spaced('heart'), false);
  state.now = 51_000;
  assert.equal(host.spaced('wink'), false);
  assert.equal((await host.perform('wink', { hers: true })).status, 'played');
  // A clock that went backwards (wall time changed) never holds her back.
  state.now = 1_000;
  assert.equal(host.spaced('pout'), false);
});

test('a pout picked while she speaks right after a wink is skipped at once (never waits); one picked later still waits and plays; the reaction gate skips a spaced face shape', async () => {
  let speaking = false;
  const { host, state, settle, fire } = spacingHost({ speaking: () => speaking });
  state.now = 100_000;
  host.request('wink'); await settle();
  speaking = true; state.now = 110_000;
  host.request('pout');
  assert.equal(host.pending, false, 'spaced: it does not wait for the end of speech');
  assert.deepEqual(state.journal.at(-1), ['pout', 'spaced', false]);
  state.now = 125_000;
  host.request('pout');
  assert.equal(host.pending, true, '25 s after the wink: waits for her to finish');
  speaking = false;
  for (let quiet = 0; quiet < CHAT_ACTION_AFTER_SPEECH_MS; quiet += CHAT_ACTION_SPEECH_POLL_MS) fire();
  await settle();
  assert.deepEqual(state.played, ['wink', 'pout']);
  // The reaction performer's gate: a spaced face shape is "busy" before it is ever picked; a body action is not.
  const view = { characterId: 'gene', expressions: true, fatigue: null, snapshot: { phase: 'idle' } } as never;
  const performers = createReactionPerformers({ mood: () => ({ get: () => view, reactionBlush: () => ({ done: true }), lift: () => {} }) as never,
    actions: () => ({ offered: () => ['wink', 'nod'], perform: async () => ({ played: true, status: 'played' }), spaced: word => host.spaced(word) }), stage: () => true });
  const gate = (word: string) => performers.action.gate({ performer: 'action', arg: word } as never, { characterId: 'gene' } as never);
  assert.equal(gate('wink'), 'busy');
  assert.equal(gate('nod'), null);
});
