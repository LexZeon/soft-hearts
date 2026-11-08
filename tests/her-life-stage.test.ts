/**
 * 她自己的生活 on the real Stage frame loop (gene-stage-harness: bundled Gene, Stand VMD, real procedural life,
 * mood feedback, chat-gesture player and the stage's own VMD loader reading the pinned Gene thinking / sleepy bytes).
 *
 * R29 measure ("unexpected step", tests/helpers/gene-stage-harness.ts surprises): how far one frame's world-space
 * step of a tracked bone departs from repeating the previous step. Entering and leaving every state, and being
 * interrupted by a chat or a head pat while she holds a pose, may not exceed max(1.25 × the reference run's own
 * largest value, floor); floor 0.15° at 60 fps, 0.6° at 30 fps (the same angular acceleration, R29d).
 * Reference: the same seconds without her activity (company), with the same chat or pat.
 * The "naive" run is the same scenario with every transition made instant (HerLifeTiming), to show what the
 * smoothing prevents. HER_LIFE_REPORT=1 prints the numbers in docs/claude/2026-11-02-her-life.md.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_CONTACT } from '../src/stage/mood-feedback';
import { HerLifeStage, herLifeStageLoader, HER_LIFE_TIMING, type HerLifeTiming } from '../src/stage/her-life-stage';
import type { HerLifeActivity, HerLifeView } from '../shared/her-life';
import { between, geneStage, patContact, pointAtScalp, surprises, TRACKED_BONES, type GeneStage } from './helpers/gene-stage-harness';

const NAIVE: HerLifeTiming = { yieldS: 1e-3, returnS: 1e-3, crossfadeS: 1e-3, lookUp: { rise: 1e-3, hold: 1, fall: 1e-3 }, poseAccel: { enter: Infinity, yield: Infinity } };
const floor = (fps: number) => fps >= 60 ? 0.15 : 0.6;

let lookUps = 0;
function setHerLife(h: GeneStage, activity: HerLifeActivity, lookUp = false): void {
  const view = h.stage.moodView;
  const herLife: HerLifeView = { activity, since: Date.now(), until: Date.now() + 600_000, source: lookUp ? 'return' : 'rule',
    lookUp: lookUp ? { id: `look-${++lookUps}`, at: Date.now() } : null };
  h.stage.setMood({ ...view, revision: view.revision + 1, herLife });
}

interface Cue { at: number; act(h: GeneStage): void }
interface Run { h: GeneStage; frames: GeneStage['shown'] }
/** One run of a timed script; the pinned clips are loaded (asynchronously, as in the app) before the first measured second. */
async function run(fps: number, seconds: number, cues: Cue[], options: { timing?: HerLifeTiming; during?(h: GeneStage, t: number): void } = {}): Promise<Run> {
  const h = await geneStage({ fps, herLife: true });
  const stage = h.stage;
  stage.herLife = new HerLifeStage(herLifeStageLoader({ mesh: () => stage.mesh, token: () => stage.moodView?.token ?? null, transform: () => undefined, unfit: () => false }),
    options.timing ?? HER_LIFE_TIMING);
  setHerLife(h, 'company');
  h.tick();
  for (const id of ['thinking', 'sleepy']) stage.herLife.request(id);
  for (let i = 0; i < 400 && Object.values(stage.herLife.getState().clips).some(state => state === 'loading'); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.deepEqual(stage.herLife.getState().clips, { thinking: 'ready', sleepy: 'ready' });
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
/** Largest unexpected step per tracked bone in [from, to]. */
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
const fmt = (v: number) => v.toFixed(3);
function report(label: string, smooth: Verdict, naive?: Verdict): void {
  if (process.env.HER_LIFE_REPORT) console.log(`${label}: ${fmt(smooth.worst)}° (${smooth.bone}) reference ${fmt(smooth.reference)}° limit ${fmt(smooth.limit)}°${naive ? ` | instant ${fmt(naive.worst)}° (${naive.bone})` : ''}`);
}

/**
 * The user comes back while she holds "想事情" (hand at her chin): the host turns her to company with a look-up.
 * Chat: the input is focused and composed, the message is sent (waiting, X1 thinking), she answers (speech).
 * Pat: the hand is over her head, then strokes it. The reference run is the same chat or pat while she was
 * just keeping the user company.
 */
const interruptions = {
  chat: { seconds: 17, from: 9, cues: (withHerLife: boolean): Cue[] => [
    { at: 9, act: h => { h.stage.setBodyInputBlocked(true); h.stage.setTyping(true); } },
    { at: 10.5, act: h => { h.stage.setTyping(false); h.stage.setBodyInputBlocked(false); h.stage.setBodyWaitingForReply(true); h.stage.setReplyThinking('turn-1'); if (withHerLife) setHerLife(h, 'company', true); } },
    { at: 11.5, act: h => { h.stage.setReplyThinking(null); h.stage.setBodyWaitingForReply(false); h.stage.setSpeaking(true); } },
    { at: 13.5, act: h => h.stage.setSpeaking(false) },
  ] },
  pat: { seconds: 15, from: 9, cues: (withHerLife: boolean): Cue[] => [
    { at: 9, act: h => pointAtScalp(h) },
    { at: 9.6, act: h => { if (withHerLife) setHerLife(h, 'company', true); } },
    { at: 10.7, act: h => h.stage.setMoodContact({ ...EMPTY_CONTACT }) },
  ], during: (h: GeneStage, t: number) => { if (t >= 9.2 && t < 10.7) h.stage.setMoodContact(patContact(t)); } },
} as const;

for (const fps of [60, 30]) {
  for (const [name, scenario] of Object.entries(interruptions)) {
    test(`her life (${fps} fps): a ${name} while she holds her thinking pose hands over without an unexpected step`, async () => {
      const start: Cue = { at: 2, act: h => setHerLife(h, 'thinking') };
      const contact = 'during' in scenario ? scenario.during : undefined, lookUp = { max: 0 };
      const during = (h: GeneStage, t: number) => { contact?.(h, t); lookUp.max = Math.max(lookUp.max, h.stage.herLife?.life.lookUp ?? 0); };
      const reference = await run(fps, scenario.seconds, scenario.cues(false), { during: contact });
      const smooth = await run(fps, scenario.seconds, [start, ...scenario.cues(true)], { during });
      const naive = await run(fps, scenario.seconds, [start, ...scenario.cues(true)], { during, timing: NAIVE });
      try {
        const held = smooth.h.stage.herLife as HerLifeStage;
        const v = verdict(largest(smooth.frames, scenario.from, scenario.seconds, fps), largest(reference.frames, 1, scenario.seconds, fps), fps);
        const n = verdict(largest(naive.frames, scenario.from, scenario.seconds, fps), largest(reference.frames, 1, scenario.seconds, fps), fps);
        report(`${fps} fps thinking + ${name}`, v, n);
        assert.ok(v.worst <= v.limit, `${name} at ${fps} fps: ${v.bone} ${fmt(v.worst)} > ${fmt(v.limit)} deg`);
        assert.ok(n.worst > n.limit, `the instant hand-off should be caught (${fmt(n.worst)} deg)`);
        assert.ok(lookUp.max > 0.9, 'she looked up at the user');
        assert.equal(held.getState().activity, 'company');
        assert.equal(held.getState().pose, null, 'the hand has left her chin');
      } finally { reference.h.close(); smooth.h.close(); naive.h.close(); }
    });
  }

  test(`her life (${fps} fps): entering and leaving every state has no unexpected step`, async () => {
    const control = await run(fps, 17, []);
    try {
      for (const activity of ['daydream', 'humming', 'thinking', 'drowsy'] as const) {
        const cues = [{ at: 3, act: (h: GeneStage) => setHerLife(h, activity) }, { at: 12, act: (h: GeneStage) => setHerLife(h, 'company') }];
        const smooth = await run(fps, 17, cues), naive = await run(fps, 17, cues, { timing: NAIVE });
        try {
          const reference = largest(control.frames, 1, 17, fps);
          for (const [phase, from, to] of [['enter', 3, 9], ['leave', 12, 17]] as const) {
            const v = verdict(largest(smooth.frames, from, to, fps), reference, fps), n = verdict(largest(naive.frames, from, to, fps), reference, fps);
            report(`${fps} fps ${activity} ${phase}`, v, n);
            assert.ok(v.worst <= v.limit, `${activity} ${phase} at ${fps} fps: ${v.bone} ${fmt(v.worst)} > ${fmt(v.limit)} deg`);
            // The measure catches a cut: the same change made instantly fails it (humming's small offsets aside).
            if (activity !== 'humming') assert.ok(n.worst > n.limit, `the instant ${activity} ${phase} should be caught (${fmt(n.worst)} deg)`);
          }
          if (activity === 'thinking' || activity === 'drowsy') {
            const pose = (smooth.h.stage.herLife as HerLifeStage).getState();
            assert.equal(pose.pose, null, 'the held pose has fully given way and was released');
          }
        } finally { smooth.h.close(); naive.h.close(); }
      }
    } finally { control.h.close(); }
  });
}

test('her life stage: the look-up runs once per host id and only while fresh; her own activity gives way in 0.3 s and returns gently', () => {
  const herLife = new HerLifeStage(null);
  const owner = {};
  const gates = { expressive: true, engaged: false, bodyOwned: false, asleep: false, posture: 50 };
  const view = (activity: HerLifeActivity, lookUp: HerLifeView['lookUp'] = null): HerLifeView => ({ activity, since: 0, until: 1, source: 'rule', lookUp });
  const frames = (seconds: number, input: Parameters<HerLifeStage['frame']>[1]) => { for (let i = 0; i < Math.round(seconds * 60); i++) herLife.frame(1 / 60, input); return herLife.getState(); };
  frames(3, { owner, view: view('daydream'), gates, nowMs: 0 });
  assert.equal(herLife.getState().presence, 1); assert.ok(herLife.life.gazeX > 0.1 && herLife.life.pointerFollow < 0.4, 'she looks into the distance');
  assert.equal(frames(0.3, { owner, view: view('daydream'), gates: { ...gates, engaged: true }, nowMs: 0 }).presence, 0, 'gives way within 0.3 s');
  assert.equal(herLife.life.gazeX, 0); assert.equal(herLife.life.pointerFollow, 1);
  const back = frames(0.75, { owner, view: view('daydream'), gates, nowMs: 0 });
  assert.ok(back.presence > 0.45 && back.presence < 0.55, 'and comes back over 1.5 s');
  // A look-up: once per id, while fresh (a few seconds), even while her own activity gives way to the user.
  const look = { id: 'a', at: 10_000 };
  frames(0.5, { owner, view: view('company', look), gates: { ...gates, engaged: true }, nowMs: 10_200 });
  assert.ok(herLife.life.lookUp > 0.9, 'eyes to the user');
  frames(2, { owner, view: view('company', look), gates: { ...gates, engaged: true }, nowMs: 12_000 });
  assert.equal(herLife.life.lookUp, 0, 'the same id does not start again');
  frames(0.5, { owner, view: view('company', { id: 'b', at: 0 }), gates, nowMs: 60_000 });
  assert.equal(herLife.life.lookUp, 0, 'a stale look-up is not shown');
  frames(0.5, { owner, view: view('company', { id: 'c', at: 60_000 }), gates: { ...gates, expressive: false }, nowMs: 60_100 });
  assert.equal(herLife.life.lookUp, 0, '"自动表现" off: no look-up');
});
