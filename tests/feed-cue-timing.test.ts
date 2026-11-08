/**
 * #32 喂点心的语气词：三个时序（Codex T-209 #3，docs/claude/2026-11-04-sleep-gap-and-feed-timing.md）。
 *  1. 点心拖走（这块没喂成）以后，迟到的这块的打算不能再让她"啊"一声，原来的话也不该因此续得更晚。
 *  2. 第二块点心到嘴边，用的是第二块自己的打算，不是上一块没喂成、没出声的那一份。
 *  3. 切角色的间隙里，旧角色还在等的那一声，不能用新角色（主机已经换过去）的旧打算。
 *
 * 照桌宠窗口的接线（src/main.ts、src/ui/MoodCompanion.ts）：真 PetInteractionTracker（拖点心）、真 FeedSpeechPause、真 ChosenFeedCues、
 * 真 MoodHost（隔离临时目录；FeedCueDirector 用固定随机数，两块点心挑出的声音不同）；主机往返、声音播放器都是假的，假时钟一毫秒一跳。
 * 对照：拖走时另外显式取消（cancelCues），本来就不出声、400 ms 后续说。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MoodHost } from '../electron/mood';
import { FeedCueDirector } from '../shared/behaviors/feed-cue/choose';
import type { FeedCueView } from '../shared/behaviors/feed-cue/interface';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import type { CueKind } from '../shared/feed-cue';
import { PetInteractionTracker, type PetHeadRegion } from '../src/ui/PetInteraction';
import { FeedSpeechPause } from '../src/ui/feed-speech-pause';
import { ChosenFeedCues } from '../src/ui/feed-cue-choice';

function fakeClock() {
  let now = 0, nextId = 0;
  const jobs = new Map<number, { at: number; callback: () => void }>();
  const timers = {
    set(callback: () => void, delay: number) { const id = ++nextId; jobs.set(id, { at: now + delay, callback }); return id; },
    clear(id: unknown) { jobs.delete(id as number); },
  };
  async function until(end: number) {
    for (; now < end; now++) {
      for (const [id, job] of [...jobs]) { if (job.at > now) continue; jobs.delete(id); job.callback(); }
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }
  }
  return { now: () => now, timers, until };
}

const head: PetHeadRegion = { x: 40, y: 40, radius: 10, mouthX: 40, mouthY: 46, mouthRadius: 8 };
type Row = Record<string, unknown> & { t: number };

/** The pet window's feeding path; `openDelay(sessionId)`: how late the host hears this snack's 'food-wait' (0: at once). */
async function feeding(openDelay: (sessionId: string) => number = () => 0) {
  const clock = fakeClock(), trace: Row[] = [], played: { t: number; kind: CueKind; renderer: string; host: string }[] = [];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-feed-timing-'));
  let renderer = 'gene-a', hostRole = 'gene-a', lastSession = '';
  const note = (row: Record<string, unknown>) => trace.push({ t: clock.now(), ...row });
  const cues = new ChosenFeedCues({ now: clock.now, timers: clock.timers, player: {
    async play(kind) {
      played.push({ t: clock.now(), kind, renderer, host: hostRole });
      return { ended: new Promise<void>(resolve => clock.timers.set(resolve, 600)) };
    },
    stop() {},
  } });
  const pause = new FeedSpeechPause({ cues, now: clock.now, timers: clock.timers,
    targets: [{ pause() { note({ speech: 'paused' }); }, resume() { note({ speech: 'resumed' }); } }] });
  const host = new MoodHost(directory, view => { note({ role: view.characterId, plan: view.feedCue?.sessionId }); cues.view(view); },
    () => Date.UTC(2026, 10, 4, 19, 0) + clock.now(), { feedCue: new FeedCueDirector({ random: () => 0.46 }) });
  host.activate('gene-a', structuredClone(DEFAULT_MOOD_PARAMETERS));
  const submit = (value: Record<string, unknown>) => host.interaction({ token: host.get().token, ...value });
  // src/ui/MoodCompanion.ts inputState: a new snack's 'food-wait' goes to the host (here, maybe late); idle 220 ms after the snack is gone.
  const tracker = new PetInteractionTracker({
    onFeedback: feedback => pause.feedback(feedback),
    onState(state) {
      if (state.phase === 'idle') {
        const sessionId = lastSession;
        if (sessionId) clock.timers.set(() => { try { submit({ type: 'phase', phase: 'idle', sessionId }); } catch { /* another character */ } }, 220);
      } else if (state.phase === 'feeding-wait' && state.sessionId !== lastSession) {
        lastSession = state.sessionId!;
        const input = { type: 'phase', phase: 'food-wait', sessionId: state.sessionId }, delay = openDelay(state.sessionId!);
        if (!delay) { submit(input); return; }
        const token = host.get().token;
        clock.timers.set(() => { try { host.interaction({ ...input, token }); } catch { note({ rejected: input.sessionId }); } }, delay);
      }
    },
    onEvent() {},
  });
  return {
    clock, trace, played, tracker, pause, host,
    plan: (): FeedCueView | undefined => host.get().feedCue,
    switchHost(role: string) { hostRole = role; host.activate(role, structuredClone(DEFAULT_MOOD_PARAMETERS)); },
    // src/main.ts applyCharacterCards: the card notice resets the pet's interaction (the snack is gone) and stops speech (cancelCues).
    switchRenderer(role: string) { renderer = role; tracker.cancel(); pause.cancelCues(); },
    async finish() {
      pause.dispose(); cues.dispose(); await host.flush().catch(() => {});
      assert.equal(path.dirname(directory), os.tmpdir());
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('feed timing 1: the snack dragged away before her pick arrived: no "啊" afterwards, and she goes on talking on the usual beat', async () => {
  const f = await feeding(() => 30);
  try {
    f.tracker.drag(40, 46, 0, head); // at her mouth at once: speech pauses, the "啊" moment waits for this snack's pick
    await f.clock.until(10);
    f.tracker.cancel(); // dragged away, never let go at her mouth
    await f.clock.until(800); // the pick for that snack arrives at 30 ms
    assert.equal(f.plan()?.sessionId, 'interaction-1', 'the host did pick for the snack (late)');
    assert.deepEqual(f.played, [], 'no sound for a snack that is gone');
    assert.equal(f.trace.find(row => row.speech === 'resumed')?.t, 410, 'resumed 400 ms after the snack left, not after a late sound');
  } finally { await f.finish(); }
});

test('feed timing 1, control: the same order with an explicit cancelCues was already silent', async () => {
  const f = await feeding(() => 30);
  try {
    f.tracker.drag(40, 46, 0, head);
    await f.clock.until(10);
    f.tracker.cancel(); f.pause.cancelCues();
    await f.clock.until(800);
    assert.deepEqual(f.played, []);
    assert.equal(f.trace.find(row => row.speech === 'resumed')?.t, 410);
  } finally { await f.finish(); }
});

test('feed timing 2: the second snack says its own pick, never the one the first snack (taken away unheard) left behind', async () => {
  let first = '';
  const f = await feeding(id => first && id !== first ? 30 : 0);
  try {
    f.tracker.drag(120, 46, 0, head); // in the window, not at her mouth: the host picks for it, nothing is heard
    first = f.tracker.state.sessionId!;
    const stale = f.plan()!;
    await f.clock.until(10);
    f.tracker.cancel();
    await f.clock.until(20);
    f.tracker.drag(40, 46, 20, head); // the second snack, right at her mouth; its pick comes 30 ms later
    const second = f.tracker.state.sessionId!;
    await f.clock.until(90);
    const live = f.plan()!;
    assert.equal(live.sessionId, second);
    assert.notEqual(stale.open.sound, live.open.sound, 'the fixed draw gives the two snacks different sounds');
    assert.deepEqual(f.played.map(row => row.kind), live.open.sound ? [live.open.sound] : [], 'only the second snack\'s own sound');
    if (live.open.sound) assert.equal(f.played[0].t, 50, 'played when its own pick came');
  } finally { await f.finish(); }
});

test('feed timing 3: switching characters, the old character\'s waiting "啊" never uses the new character\'s old pick', async () => {
  let stale = '';
  const f = await feeding(id => stale && id !== stale ? 100 : 0);
  try {
    // B fed earlier: a snack that never reached her mouth leaves B's pick (B's host keeps it for a while).
    f.switchHost('gene-b'); f.switchRenderer('gene-b');
    f.tracker.drag(120, 46, 0, head);
    stale = f.tracker.state.sessionId!;
    await f.clock.until(10);
    f.tracker.cancel();
    await f.clock.until(260);
    // Back to A; a snack at A's mouth waits for A's pick (the host hears it late).
    f.switchHost('gene-a'); f.switchRenderer('gene-a');
    await f.clock.until(270);
    f.tracker.drag(40, 46, 270, head);
    await f.clock.until(280);
    // The host switches to B first; the pet window still shows A until the card notice at 330 ms.
    f.switchHost('gene-b');
    assert.equal(f.plan()?.sessionId, stale, 'B\'s old pick is in the view the pet window now gets');
    await f.clock.until(330);
    f.switchRenderer('gene-b');
    await f.clock.until(400);
    assert.deepEqual(f.played, [], 'A\'s waiting moment did not take B\'s pick');
    assert.equal(f.trace.filter(row => row.rejected).length, 1, 'A\'s late food-wait was refused by B\'s host (no bite, no pick)');
  } finally { await f.finish(); }
});

test('cue port: a moment uses only the pick of the snack being fed; its snack gone or the character changed, a waiting moment is dropped', async () => {
  const clock = fakeClock(), played: string[] = [];
  const cues = new ChosenFeedCues({ now: clock.now, timers: clock.timers, player: { async play(kind) { played.push(`${kind}@${clock.now()}`); return { ended: Promise.resolve() }; }, stop() {} } });
  const plan = (sessionId: string, sound: FeedCueView['open']['sound']): FeedCueView => ({ sessionId, open: { id: `${sessionId}:open`, sound, mouth: { rate: 1, size: 1 }, shake: null } });
  const view = (characterId: string, feedCue: FeedCueView) => cues.view({ characterId, expressions: true, feedCue });
  view('gene-a', plan('s1', 'wa'));
  // Snack s2 is being fed: s1's pick is not its own; s2's comes 20 ms later.
  cues.feeding('s2');
  const own = cues.play('ah', 250);
  await clock.until(20); view('gene-a', plan('s2', 'soft'));
  await own;
  assert.deepEqual(played, ['soft@20']);
  // Snack s3 leaves while its moment waits: the late pick finds no one waiting.
  cues.feeding('s3');
  const gone = cues.play('ah', 250);
  await clock.until(30); cues.feeding(null);
  await clock.until(40); view('gene-a', plan('s3', 'aowu'));
  assert.equal(await gone, null);
  // Snack s4 waits; the host is now another character (its old pick even names s4): dropped.
  cues.feeding('s4');
  const switched = cues.play('ah', 250);
  await clock.until(50); view('gene-b', plan('s4', 'wa'));
  assert.equal(await switched, null);
  assert.deepEqual(played, ['soft@20'], 'nothing else was played');
  // Without a snack identity (a caller that does not say), the old behavior: the last pick.
  const plain = new ChosenFeedCues({ now: clock.now, timers: clock.timers, player: { async play(kind) { played.push(`${kind}@plain`); return { ended: Promise.resolve() }; }, stop() {} } });
  plain.view({ characterId: 'gene-a', expressions: true, feedCue: plan('s9', 'huh') });
  plain.prepare();
  await plain.play('ah', 250);
  assert.equal(played.at(-1), 'huh@plain');
  cues.dispose(); plain.dispose();
});
