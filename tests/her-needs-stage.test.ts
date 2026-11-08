/**
 * 她也会需要你 on the real Stage frame loop (gene-stage-harness: bundled Gene, Stand VMD, real procedural life, mood feedback,
 * chat-gesture player). docs/claude/2026-11-03-she-needs-you.md.
 *
 * R29 measure ("unexpected step", tests/helpers/gene-stage-harness.ts surprises): how far one frame's world-space step of a tracked
 * bone departs from repeating the previous step. A small feeling coming, being soothed halfway, turning into the glow, fading away,
 * and the user's chat or pat arriving in the middle of it may not exceed max(1.25 × the reference run's own largest value, floor);
 * floor 0.15° at 60 fps, 0.6° at 30 fps (the same angular acceleration, R29d). Reference: the same seconds with no need.
 * The "naive" run makes every transition instant (HerLifeTiming) to show what the smoothing prevents.
 * HER_NEED_REPORT=1 prints the numbers in docs/claude/2026-11-03-she-needs-you.md.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_CONTACT } from '../src/stage/mood-feedback';
import { HerLifeStage, HER_LIFE_TIMING, herLifeStageLoader, type HerLifeTiming } from '../src/stage/her-life-stage';
import { HER_LIFE_NEUTRAL_PRESENTATION, type HerLifeActivity, type HerLifeView } from '../shared/her-life';
import { HER_NEED_GLOW, HER_NEED_IDS, HER_NEED_TABLE, type HerNeedId, type HerNeedView } from '../shared/her-needs';
import { between, geneStage, patContact, pointAtScalp, surprises, TRACKED_BONES, type GeneStage } from './helpers/gene-stage-harness';

const NAIVE: HerLifeTiming = { yieldS: 1e-3, returnS: 1e-3, crossfadeS: 1e-3, lookUp: { rise: 1e-3, hold: 1, fall: 1e-3 }, poseAccel: { enter: Infinity, yield: Infinity } };
const floor = (fps: number) => fps >= 60 ? 0.15 : 0.6;
const report = process.env.HER_NEED_REPORT;

function setNeed(h: GeneStage, need: HerNeedView | null, herLife?: HerLifeView): void {
  const view = h.stage.moodView;
  const next = { ...view, revision: view.revision + 1 } as typeof view & { herNeed?: HerNeedView };
  if (need) next.herNeed = need; else delete next.herNeed;
  if (herLife) next.herLife = herLife;
  h.stage.setMood(next);
}
const needView = (id: HerNeedId, mode: 'need' | 'glow' | 'low', strength = 1): HerNeedView => ({ id, mode, since: Date.now(), strength, usedToday: 1 });
const lifeView = (activity: HerLifeActivity): HerLifeView => ({ activity, since: Date.now(), until: Date.now() + 600_000, source: 'rule', lookUp: null });

interface Cue { at: number; act(h: GeneStage): void }
async function run(fps: number, seconds: number, cues: Cue[], options: { timing?: HerLifeTiming; during?(h: GeneStage, t: number): void } = {}) {
  const h = await geneStage({ fps, herLife: true });
  const stage = h.stage;
  stage.herLife = new HerLifeStage(herLifeStageLoader({ mesh: () => stage.mesh, token: () => stage.moodView?.token ?? null, transform: () => undefined, unfit: () => false }),
    options.timing ?? HER_LIFE_TIMING);
  setNeed(h, null, lifeView('company'));
  h.tick();
  for (const id of ['thinking', 'sleepy']) stage.herLife.request(id);
  for (let i = 0; i < 400 && Object.values(stage.herLife.getState().clips).some(state => state === 'loading'); i++) await new Promise(resolve => setTimeout(resolve, 2));
  const pending = [...cues].sort((a, b) => a.at - b.at);
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i++) {
    const t = h.time();
    while (pending.length && pending[0].at <= t + 1e-9) pending.shift()!.act(h);
    options.during?.(h, t);
    h.tick();
  }
  return { h, frames: h.shown };
}
function largest(frames: GeneStage['shown'], from: number, to: number, fps: number): number[] {
  return surprises(between(frames, from - 2 / fps, to)).map(values => Math.max(0, ...values));
}
interface Verdict { worst: number; bone: string; reference: number; limit: number }
function verdict(event: number[], reference: number[], fps: number): Verdict {
  let worst = -1, index = 0;
  event.forEach((value, i) => { if (value > worst) { worst = value; index = i; } });
  const ref = Math.max(...reference);
  return { worst, bone: TRACKED_BONES[index], reference: ref, limit: Math.max(ref * 1.25, floor(fps)) };
}
const fmt = (value: number) => value.toFixed(3);
function note(label: string, smooth: Verdict, naive?: Verdict): void {
  if (report) console.log(`${label}: ${fmt(smooth.worst)}° (${smooth.bone}) reference ${fmt(smooth.reference)}° limit ${fmt(smooth.limit)}°${naive ? ` | instant ${fmt(naive.worst)}° (${naive.bone})` : ''}`);
}

for (const fps of [60, 30]) {
  test(`her needs (${fps} fps): every small feeling comes, fades away and leaves without an unexpected step`, async () => {
    const control = await run(fps, 20, []);
    try {
      for (const id of HER_NEED_IDS) {
        // It arrives at 3 s at full strength; at 14 s the host drops it (it faded or she went to sleep): the view is simply gone.
        const cues = [{ at: 3, act: (h: GeneStage) => setNeed(h, needView(id, 'need')) }, { at: 14, act: (h: GeneStage) => setNeed(h, null) }];
        const smooth = await run(fps, 20, cues), naive = await run(fps, 20, cues, { timing: NAIVE });
        try {
          const reference = largest(control.frames, 1, 20, fps);
          for (const [phase, from, to] of [['arrive', 3, 9], ['leave', 14, 20]] as const) {
            const v = verdict(largest(smooth.frames, from, to, fps), reference, fps), n = verdict(largest(naive.frames, from, to, fps), reference, fps);
            note(`${fps} fps ${id} ${phase}`, v, n);
            assert.ok(v.worst <= v.limit, `${id} ${phase} at ${fps} fps: ${v.bone} ${fmt(v.worst)} > ${fmt(v.limit)} deg`);
          }
          const shown = (smooth.h.stage.herLife as HerLifeStage).getState();
          assert.equal(shown.need, null, 'she has left it');
        } finally { smooth.h.close(); naive.h.close(); }
      }
    } finally { control.h.close(); }
  });

  test(`her needs (${fps} fps): being soothed halfway, then turning into the glow, then fading, has no unexpected step`, async () => {
    const control = await run(fps, 30, []);
    try {
      for (const id of ['lonely', 'chatty'] as const) {
        // Strength follows what the host sends: full, then 0.75 after a pat that was not enough (a step in the view), then the glow, then it fades.
        const cues: Cue[] = [
          { at: 3, act: h => setNeed(h, needView(id, 'need', 1)) },
          { at: 9, act: h => setNeed(h, needView(id, 'need', 0.75)) },
          { at: 14, act: h => setNeed(h, needView(id, 'glow', 1)) },
          { at: 19, act: h => setNeed(h, needView(id, 'glow', 0.4)) },
          { at: 24, act: h => setNeed(h, null) },
        ];
        const smooth = await run(fps, 30, cues), naive = await run(fps, 30, cues, { timing: NAIVE });
        try {
          const reference = largest(control.frames, 1, 30, fps);
          for (const [phase, from, to] of [['half-soothed', 9, 13], ['into the glow', 14, 18], ['fading', 19, 23], ['gone', 24, 30]] as const) {
            const v = verdict(largest(smooth.frames, from, to, fps), reference, fps), n = verdict(largest(naive.frames, from, to, fps), reference, fps);
            note(`${fps} fps ${id} ${phase}`, v, n);
            assert.ok(v.worst <= v.limit, `${id} ${phase} at ${fps} fps: ${v.bone} ${fmt(v.worst)} > ${fmt(v.limit)} deg`);
            // The measure catches a cut: the glow arriving and the whole thing vanishing at once fail it (the smaller steps are within noise).
            if (phase === 'into the glow' || phase === 'gone') assert.ok(n.worst > n.limit, `the instant "${phase}" should be caught (${fmt(n.worst)} deg)`);
          }
        } finally { smooth.h.close(); naive.h.close(); }
      }
    } finally { control.h.close(); }
  });

  test(`her needs (${fps} fps): a need that goes unanswered turns into the quiet 低落 look, piles up, and ends the moment the user comes (释然), all without an unexpected step`, async () => {
    const control = await run(fps, 30, []);
    try {
      // The need fades at 3 s (the view turns from `need` into `low`, strength = 低落 0.35), a second one piles it up to 0.7 at 12 s, and the user's first move
      // ends it at 20 s (the view is gone). The strength also settles a little between (the host sends it every second).
      const cues: Cue[] = [
        { at: 1, act: h => setNeed(h, needView('lonely', 'need', 0.2)) },
        { at: 3, act: h => setNeed(h, needView('lonely', 'low', 0.35)) },
        { at: 8, act: h => setNeed(h, needView('lonely', 'low', 0.33)) },
        { at: 12, act: h => setNeed(h, needView('chatty', 'low', 0.7)) },
        { at: 20, act: h => setNeed(h, null) },
      ];
      const smooth = await run(fps, 30, cues), naive = await run(fps, 30, cues, { timing: NAIVE });
      try {
        const reference = largest(control.frames, 1, 30, fps);
        for (const [phase, from, to] of [['into low', 3, 8], ['settling', 8, 12], ['piles up', 12, 17], ['relief (gone)', 20, 26]] as const) {
          const v = verdict(largest(smooth.frames, from, to, fps), reference, fps), n = verdict(largest(naive.frames, from, to, fps), reference, fps);
          note(`${fps} fps low ${phase}`, v, n);
          assert.ok(v.worst <= v.limit, `low ${phase} at ${fps} fps: ${v.bone} ${fmt(v.worst)} > ${fmt(v.limit)} deg`);
        }
        const held = (smooth.h.stage.herLife as HerLifeStage).getState();
        assert.equal(held.need, null);
      } finally { smooth.h.close(); naive.h.close(); }
    } finally { control.h.close(); }
  });

  for (const [name, scenario] of Object.entries({
    chat: { seconds: 17, from: 9, cues: [
      { at: 9, act: (h: GeneStage) => { h.stage.setBodyInputBlocked(true); h.stage.setTyping(true); } },
      { at: 10.5, act: (h: GeneStage) => { h.stage.setTyping(false); h.stage.setBodyInputBlocked(false); h.stage.setBodyWaitingForReply(true); h.stage.setReplyThinking('turn-1'); } },
      { at: 11.5, act: (h: GeneStage) => { h.stage.setReplyThinking(null); h.stage.setBodyWaitingForReply(false); h.stage.setSpeaking(true); } },
      { at: 13.5, act: (h: GeneStage) => h.stage.setSpeaking(false) },
    ] as Cue[], during: undefined as ((h: GeneStage, t: number) => void) | undefined },
    pat: { seconds: 15, from: 9, cues: [
      { at: 9, act: (h: GeneStage) => pointAtScalp(h) },
      { at: 10.7, act: (h: GeneStage) => h.stage.setMoodContact({ ...EMPTY_CONTACT }) },
    ] as Cue[], during: (h: GeneStage, t: number) => { if (t >= 9.2 && t < 10.7) h.stage.setMoodContact(patContact(t)); } },
  })) {
    test(`her needs (${fps} fps): a ${name} while she has a small feeling hands over (and the glow comes in after) without an unexpected step`, async () => {
      // The user's message or pat soothes her at the moment it arrives: the view turns from `need` into `glow` (the host does it in the same breath).
      const soothe: Cue = { at: scenario.from + 1.2, act: h => setNeed(h, needView('lonely', 'glow')) };
      const start: Cue = { at: 2, act: h => setNeed(h, needView('lonely', 'need')) };
      const reference = await run(fps, scenario.seconds, scenario.cues, { during: scenario.during });
      const smooth = await run(fps, scenario.seconds, [start, soothe, ...scenario.cues], { during: scenario.during });
      const naive = await run(fps, scenario.seconds, [start, soothe, ...scenario.cues], { during: scenario.during, timing: NAIVE });
      try {
        const v = verdict(largest(smooth.frames, scenario.from, scenario.seconds, fps), largest(reference.frames, 1, scenario.seconds, fps), fps);
        const n = verdict(largest(naive.frames, scenario.from, scenario.seconds, fps), largest(reference.frames, 1, scenario.seconds, fps), fps);
        note(`${fps} fps need + ${name}`, v, n);
        assert.ok(v.worst <= v.limit, `${name} at ${fps} fps: ${v.bone} ${fmt(v.worst)} > ${fmt(v.limit)} deg`);
        if (name === 'chat' || fps === 30) assert.ok(n.worst > n.limit, `the instant hand-off should be caught (${fmt(n.worst)} deg)`);
        assert.equal((smooth.h.stage.herLife as HerLifeStage).getState().need, 'glow');
      } finally { reference.h.close(); smooth.h.close(); naive.h.close(); }
    });
  }
}

// ---------------------------------------------------------------- the stage's own rules (no model)

const gates = { expressive: true, engaged: false, bodyOwned: false, asleep: false, posture: 50 };
const view = (activity: HerLifeActivity): HerLifeView => ({ activity, since: 0, until: 1, source: 'rule', lookUp: null });
const need = (id: HerNeedId, mode: 'need' | 'glow' | 'low', strength = 1): HerNeedView => ({ id, mode, since: 0, strength, usedToday: 1 });

test('her needs stage: it replaces what she is doing while it lasts, scaled by its strength, and her own activity returns after', () => {
  const herLife = new HerLifeStage(null), owner = {};
  const frames = (seconds: number, input: Partial<Parameters<HerLifeStage['frame']>[1]>) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) herLife.frame(1 / 60, { owner, view: view('daydream'), gates, nowMs: 0, ...input });
    return herLife.getState();
  };
  frames(4, {});
  const daydreamGaze = herLife.life.gazeX;
  assert.ok(daydreamGaze > 0.1, 'daydreaming');
  assert.equal(frames(4, { need: need('lonely', 'need') }).need, 'need:lonely');
  const spec = HER_NEED_TABLE.lonely.presentation;
  assert.ok(Math.abs(herLife.life.gazeX - spec.gazeX) < 0.002 && Math.abs(herLife.life.gazeY - spec.gazeY) < 0.002, 'her small feeling, not the daydream');
  assert.ok(Math.abs(herLife.life.headX - spec.headX) < 1e-4 && Math.abs(herLife.life.lidSoft - spec.lidSoft) < 1e-4);
  // Half as strong: halfway between nothing and the table (after the stage has followed it).
  frames(10, { need: need('lonely', 'need', 0.5) });
  assert.ok(Math.abs(herLife.life.lidSoft - spec.lidSoft * 0.5) < 2e-3 && Math.abs(herLife.life.headZ - spec.headZ * 0.5) < 2e-3, 'half strength is half the offset');
  // 低落 after a need nobody answered: quiet (eyes lower, slower blinks, little swaying), scaled by how much has piled up, the same for every kind.
  assert.equal(frames(6, { need: need('lonely', 'low', 0.8) }).need, 'low');
  assert.ok(herLife.life.gazeY < -0.04 && herLife.life.lidSoft > 0.08 && herLife.life.sway < 0.7 && herLife.life.smileEyes === 0 && herLife.life.mouthSmile === 0);
  frames(8, { need: need('chatty', 'low', 0.4) });
  assert.ok(herLife.life.gazeY > -0.04 && herLife.life.gazeY < -0.02, 'less piled up, less of it');
  // The glow is the same whatever soothed her.
  assert.equal(frames(4, { need: need('chatty', 'glow') }).need, 'glow');
  assert.ok(Math.abs(herLife.life.smileEyes - HER_NEED_GLOW.presentation.smileEyes) < 1e-3 && herLife.life.mouthSmile > 0.25);
  assert.equal(frames(4, { need: need('lowEnergy', 'glow') }).need, 'glow', 'a different need, the same glow');
  // It ends: her own activity comes back.
  assert.equal(frames(4, { need: null }).need, null);
  assert.ok(Math.abs(herLife.life.gazeX - daydreamGaze) < 0.002, 'back to daydreaming');
});

test('her needs stage: she gives way to the user in 0.3 s, comes back gently, and a held pose does not appear under a small feeling', () => {
  const herLife = new HerLifeStage(null), owner = {};
  const run = (seconds: number, over: Partial<Parameters<HerLifeStage['frame']>[1]>) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) herLife.frame(1 / 60, { owner, view: view('thinking'), gates, nowMs: 0, need: need('dream', 'need'), ...over });
    return herLife.getState();
  };
  assert.equal(run(3, {}).presence, 1);
  assert.ok(herLife.life.gazeY < -0.05, 'eyes down');
  assert.equal(run(0.3, { gates: { ...gates, engaged: true } }).presence, 0, 'the user is typing: gone within 0.3 s');
  assert.ok(Math.abs(herLife.life.gazeY) < 1e-12 && Math.abs(herLife.life.lidSoft) < 1e-12);
  const back = run(0.75, {});
  assert.ok(back.presence > 0.45 && back.presence < 0.55, 'and back over 1.5 s');
  assert.equal(run(1, { gates: { ...gates, expressive: false } }).presence < 0.5, true, '自动表现 off takes it away');
  assert.equal(herLife.getState().pose, null, 'the thinking pose is not asked for while a small feeling is shown');
});

test('her needs stage: a corrupted or unknown view is ignored; the fixed neutral presentation never changes', () => {
  const herLife = new HerLifeStage(null), owner = {};
  const before = { ...HER_LIFE_NEUTRAL_PRESENTATION };
  for (const bad of [{ id: 'nope', mode: 'need', since: 0, strength: 1, usedToday: 1 }, { id: 'lonely', mode: 'weird', since: 0, strength: 1, usedToday: 1 }, { id: 'lonely', mode: 'need', since: 0, strength: 0, usedToday: 1 }]) {
    for (let i = 0; i < 120; i++) herLife.frame(1 / 60, { owner, view: view('company'), gates, nowMs: 0, need: bad as unknown as HerNeedView });
    assert.equal(herLife.getState().need, null, JSON.stringify(bad));
    assert.equal(herLife.life.lidSoft, 0);
  }
  assert.deepEqual(HER_LIFE_NEUTRAL_PRESENTATION, before);
});
