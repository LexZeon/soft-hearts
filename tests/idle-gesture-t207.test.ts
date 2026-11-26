/**
 * #11 小动作：Codex T-207 的三个反例，照它的最小复现写成测试。
 *  - 默认卡、真 MoodHost：连着三次同样的样子和表情（抬眼看你 · 只是看着）→ 修：连着两次一样之后，第三次至少换一样；
 *  - recent 旋钮设成 [1, 1, 1]（= 不管重复）时，"为什么"还写"降低了，还是挑中了" → 修：没降低就不说降低；
 *  - 暂停自动表现时，正在演的小动作被一下子撤掉，R29 护栏接住了两次 → 不修（理由见 docs/claude/2026-11-03-idle-gesture.md
 *    "Codex T-207 反例和修复"）；这里钉住用户看到的：每帧的步子很小，头和眼睛平滑地回到原位。
 * 只用隔离的临时目录和合成骨骼；不读任何配置、角色卡或桥里的文件。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MoodHost } from '../electron/mood/mood';
import { chooseIdleGesture, IdleGestureDirector, idleGestureNow } from '../shared/behaviors/idle-gesture/choose';
import { IDLE_FACE_IDS, IDLE_GESTURE_KNOBS, IDLE_SHAPE_IDS, type IdleFaceId, type IdleShapeId } from '../shared/behaviors/idle-gesture/knobs';
import { BoredomTimingDirector } from '../shared/behaviors/boredom-timing/choose';
import { createMoodState, DEFAULT_MOOD_PARAMETERS, getMoodSnapshot, type MoodLabel } from '../shared/foundation/mood';
import { seeded } from './helpers/seeded';

test('T-207 #11: the default card on the real host never shows the same shape and face three times in a row (Codex: seeds 8499 / 1)', async () => {
  for (const [gestureSeed, timingSeed] of [[8499, 1], [1, 1], [2, 3], [77, 5]] as const) {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'soft-t207-idle-repeat-'));
    let now = 1_000_000;
    const cues = new Set<string>();
    // Every shown gesture as it is remembered (the why keeps only the last 8): oldest first.
    const shown = new Map<string, string>();
    const keep = (entries: readonly { at: number; kind: string; shape: string; face: string }[] | undefined) => {
      for (const item of [...(entries ?? [])].reverse()) if (!shown.has(`${item.at}|${item.kind}`)) shown.set(`${item.at}|${item.kind}`, `${item.shape}/${item.face}`);
    };
    const host = new MoodHost(profile, view => {
      keep(view.idleGestureWhy);
      const cue = view.snapshot.cue;
      if (cue && view.idleGesture) cues.add(cue.id);
    }, () => now, { idleGesture: new IdleGestureDirector({ random: seeded(gestureSeed), clock: () => now }), boredomTiming: new BoredomTimingDirector({ random: seeded(timingSeed) }) });
    try {
      await host.load();
      host.activate('synthetic', structuredClone(DEFAULT_MOOD_PARAMETERS));
      host.setDeveloperMode(true);
      for (let tick = 0; tick < 6_000 && cues.size < 12; tick++) { now += 1_000; host.tick(true, { allowGenericSpeech: false }); }
      keep(host.get().idleGestureWhy);
      const pairs = [...shown.values()];
      assert.ok(pairs.length >= 10, `${gestureSeed}: real cues (${pairs.length})`);
      for (let i = 2; i < pairs.length; i++)
        assert.ok(!(pairs[i] === pairs[i - 1] && pairs[i] === pairs[i - 2]), `${gestureSeed}: three in a row: ${pairs.join(' → ')}`);
      if (gestureSeed === 8499) assert.ok(new Set(pairs.slice(0, 3)).size > 1, `Codex's first three: ${pairs.slice(0, 3).join(' → ')}`);
    } finally {
      await host.flush();
      await rm(profile, { recursive: true, force: true });
    }
  }
});

test('after the same shape and face twice, the third pick changes at least one of them, whatever the moment; still five random numbers', () => {
  const random = seeded(207);
  const moods: MoodLabel[] = ['calm', 'happy', 'sad', 'concerned', 'longing', 'content', 'close', 'upset'];
  let changedFace = 0, changedShape = 0;
  for (let i = 0; i < 4000; i++) {
    const mood = moods[i % moods.length], kind = random() < 0.5 ? 'look' as const : 'motion' as const;
    const now = idleGestureNow({ kind, source: 'rule', snapshot: { ...getMoodSnapshot(createMoodState(0), 0), primary: mood, boredom: random() * 100 },
      personality: { playful: random() * 3, close: random() * 3, cautious: random() * 3, comfortable: random() * 3 }, contacts: [], fatiguePhase: null, now: 0 });
    const shape = IDLE_SHAPE_IDS[Math.floor(random() * IDLE_SHAPE_IDS.length)] as IdleShapeId, face = IDLE_FACE_IDS[Math.floor(random() * IDLE_FACE_IDS.length)] as IdleFaceId;
    let calls = 0;
    const draw = seeded(1000 + i);
    const choice = chooseIdleGesture(now, { shapes: [shape, shape, 'nod'], faces: [face, face, 'smile'] }, () => { calls++; return draw(); })!;
    assert.equal(calls, 5, 'shape, face, amplitude, pace, side');
    assert.ok(!(choice.shape === shape && choice.face === face), `${mood} ${kind}: ${shape}/${face} a third time (${choice.why.join('；')})`);
    if (choice.why.some(line => line.includes('这次换个表情'))) changedFace++;
    if (choice.why.some(line => line.includes('这次换个样子'))) changedShape++;
  }
  assert.ok(changedFace > 0, 'the why says when it changed the face');
  // A sad moment allows only one face that smiles not ("心情写在脸上" or "只是看着"): when both were used up, the shape changes.
  const serious = idleGestureNow({ kind: 'look', source: 'rule', snapshot: { ...getMoodSnapshot(createMoodState(0), 0), primary: 'sad', boredom: 10 },
    personality: null, contacts: [], fatiguePhase: null, now: 0 });
  const onlyFace = { ...IDLE_GESTURE_KNOBS, faces: { ...IDLE_GESTURE_KNOBS.faces, mood: { ...IDLE_GESTURE_KNOBS.faces.mood, base: { look: 0, motion: 0 } } } };
  for (let i = 0; i < 200; i++) {
    const choice = chooseIdleGesture(serious, { shapes: ['lift', 'lift'], faces: ['plain', 'plain'] }, seeded(i), onlyFace)!;
    assert.ok(!(choice.shape === 'lift' && choice.face === 'plain'), choice.why.join('；'));
    if (choice.shape !== 'lift' && choice.why.some(line => line.includes('这次换个样子'))) changedShape++;
  }
  assert.ok(changedShape > 0, 'when no other face is possible, the shape changes and the why says so');
  // Only one combination possible at all: she repeats rather than freeze (nothing else she could do).
  const single = { ...onlyFace, shapes: Object.fromEntries(Object.entries(IDLE_GESTURE_KNOBS.shapes).map(([id, knob]) => [id, id === 'lift' ? knob : { ...knob, base: { look: 0, motion: 0 } }])) as typeof IDLE_GESTURE_KNOBS.shapes };
  const forced = chooseIdleGesture(serious, { shapes: ['lift', 'lift'], faces: ['plain', 'plain'] }, seeded(1), single)!;
  assert.deepEqual([forced.shape, forced.face], ['lift', 'plain']);
});

test('T-207 #11: with recent = [1, 1, 1] (repeats not lowered) the why never says the weight went down', () => {
  const now = idleGestureNow({ kind: 'look', source: 'rule', snapshot: getMoodSnapshot(createMoodState(0), 0), personality: null, contacts: [], fatiguePhase: null, now: 0 });
  const knobs = { ...IDLE_GESTURE_KNOBS, recent: [1, 1, 1] };
  const first = chooseIdleGesture(now, { shapes: [], faces: [] }, () => 0.01, knobs)!;
  const repeat = chooseIdleGesture(now, { shapes: [first.shape], faces: [first.face] }, () => 0.01, knobs)!;
  assert.equal(repeat.weights, first.weights, 'the same weights: nothing was lowered');
  assert.doesNotMatch(repeat.why.join('\n'), /降低/u);
  // With the default knob it is lowered, and said so.
  const lowered = chooseIdleGesture(now, { shapes: [first.shape], faces: [first.face] }, () => 0.01)!;
  assert.notEqual(lowered.weights, first.weights);
});

// ---------------------------------------------------------------- pausing mid-gesture (not changed; what the user sees is pinned)

const degrees = 180 / Math.PI;
const dt = 1 / 60;
