/**
 * I-187 陪看深度修 (decision: "要，合成一个开关").
 * 和她一起看 is ONE switch: the screen and the dialogue (the computer's sound with words, the 'movie' purpose). What this pins:
 * - the eye button shows a not-heard state (a mark and a tooltip that says 台词) whenever she sees the screen and the dialogue does not reach her;
 * - one click turns both on, or both off; off always stops the dialogue, even when the screen change is refused;
 * - the click only ever asks for screen sharing and system-audio/movie: never the camera, voice input, the microphone or 一起听's music;
 * - 「和她一起听」 off keeps 一起看's dialogue while 一起看 is on (the two never switch each other off);
 * - the minute tally says how long the dialogue could reach her, was paused, or had no capture; busy clips are counted.
 * Fake views, fake API, fake clock; no real capture, model or profile.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { watchTogetherLook, watchTogetherPlan, WATCH_TOGETHER_TOOLTIPS, type DialogueHearing } from '../shared/senses/watch-together-state';
import { listenMusicSwitchOn } from '../shared/senses/listen-together';
import { switchWatchTogether } from '../src/senses/watch-together-toggle';
import { WatchTogetherButton } from '../src/stage/watch-together-button';
import { WatchTogether, watchHearingOf } from '../electron/senses/watch-notes/wiring';
import type { WatchHearing } from '../electron/senses/watch-notes/session';
import { ListenTally } from '../electron/senses/listen-tally';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { ENGLISH_LISTEN_UI_COPY } from '../shared/foundation/ui-copy.listen.en';
import type { AudioReadingPhase, AudioReadingView } from '../shared/voice/audio-reading-toggles';

function view(cells: { music?: boolean; movie?: boolean; phase?: AudioReadingPhase }): Pick<AudioReadingView, 'sources'> {
  const words = cells.music === true || cells.movie === true;
  const phase = words ? (cells.phase ?? 'ready') : 'off';
  const cell = (on: boolean | undefined) => ({ revision: 1, intent: on === true, phase: on === true ? (phase === 'off' ? 'waiting' : phase) : 'off' as AudioReadingPhase, status: '' });
  const quiet = { capture: { revision: 0, active: false, phase: 'off' as AudioReadingPhase, status: '' }, music: cell(false), movie: cell(false) };
  return { sources: { 'system-audio': { capture: { revision: 1, active: phase === 'ready', phase, status: '' }, music: cell(cells.music), movie: cell(cells.movie) }, microphone: quiet } };
}

test('the eye button: a not-heard state is shown whenever she sees the screen and the dialogue does not reach her', () => {
  const phases: AudioReadingPhase[] = ['waiting', 'ready', 'paused', 'error'];
  for (const screen of [false, true]) for (const music of [false, true]) for (const movie of [false, true]) for (const phase of phases) {
    const look = watchTogetherLook({ screen, view: view({ music, movie, phase }) });
    const hearing: DialogueHearing = !music && !movie ? 'off' : phase === 'ready' ? 'hearing' : phase === 'paused' ? 'paused' : phase === 'error' ? 'error' : 'starting';
    const label = `screen ${screen} music ${music} movie ${movie} ${phase}`;
    assert.equal(look.hearing, hearing, label);
    assert.equal(look.on, screen && movie, label);
    assert.equal(look.notHeard, screen && hearing !== 'hearing', label);
    if (look.notHeard) assert.match(look.tooltip, /台词/u, `${label}: the tooltip says the dialogue`);
    if (look.notHeard) assert.notEqual(look.tooltip, WATCH_TOGETHER_TOOLTIPS.hearing, label);
    assert.ok(ENGLISH_LISTEN_UI_COPY[look.tooltip], `${label}: English copy for ${look.tooltip}`);
  }
  // No view yet (the first one has not arrived) with the screen on: not heard.
  assert.equal(watchTogetherLook({ screen: true, view: null }).notHeard, true);
  assert.equal(watchTogetherLook({ screen: true, view: null }).tooltip, WATCH_TOGETHER_TOOLTIPS.screenOnly);
  // Both on and the words flowing: plain "on", no mark.
  const on = watchTogetherLook({ screen: true, view: view({ movie: true }) });
  assert.deepEqual([on.on, on.notHeard, on.tooltip], [true, false, WATCH_TOGETHER_TOOLTIPS.hearing]);
});

test('the eye button renders the mark, the pressed state and the tooltip', () => {
  const attributes = new Map<string, string>();
  const element = { dataset: {} as Record<string, string>, setAttribute: (key: string, value: string) => attributes.set(key, value), matches: () => false };
  let shown = 0;
  const button = new WatchTogetherButton(() => element as unknown as HTMLElement, () => { shown++; });
  button.setScreen(true);
  assert.equal(element.dataset.notHeard, 'true', 'the screen alone: not heard');
  assert.equal(attributes.get('aria-pressed'), 'false');
  assert.equal(element.dataset.tooltip, WATCH_TOGETHER_TOOLTIPS.screenOnly);
  button.setView(view({ movie: true, phase: 'paused' }));
  assert.deepEqual([attributes.get('aria-pressed'), element.dataset.notHeard], ['true', 'true'], 'on but paused: pressed and marked');
  button.setView(view({ movie: true, phase: 'ready' }));
  assert.deepEqual([attributes.get('aria-pressed'), element.dataset.notHeard], ['true', 'false']);
  assert.deepEqual(button.look.dialogue, true);
  button.setScreen(false);
  assert.deepEqual([attributes.get('aria-pressed'), element.dataset.notHeard, element.dataset.tooltip], ['false', 'false', WATCH_TOGETHER_TOOLTIPS.dialogueOnly]);
  assert.equal(shown, 0, 'no tooltip pops up unless the pointer is on it');
});

test('one click: both on, or both off; turning it off always stops its dialogue', () => {
  assert.deepEqual(watchTogetherPlan({ screen: false, dialogue: false }), { target: true, screen: true, dialogue: true });
  assert.deepEqual(watchTogetherPlan({ screen: true, dialogue: false }), { target: true, screen: null, dialogue: true }, 'only the screen: also hear the dialogue');
  assert.deepEqual(watchTogetherPlan({ screen: false, dialogue: true }), { target: true, screen: true, dialogue: null });
  assert.deepEqual(watchTogetherPlan({ screen: true, dialogue: true }), { target: false, screen: false, dialogue: false });
});

function fakeApi(fail: { screen?: boolean; dialogue?: boolean } = {}) {
  const calls: unknown[] = [];
  return {
    calls,
    api: {
      setRuntimeState: async (patch: unknown) => { calls.push(['runtime', patch]); if (fail.screen) throw new Error('screen refused'); return { voiceInput: false, screenSharing: true, cameraSharing: false, voiceOwner: null, cameraOwner: null }; },
      setAudioReadingIntent: async (intent: unknown) => { calls.push(['reading', intent]); if (fail.dialogue) throw new Error('reading refused'); return {} as never; },
    },
  };
}

test('the click asks only for screen sharing and the system-audio dialogue: never the camera, voice input, the microphone or 一起听 music', async () => {
  const on = fakeApi();
  assert.equal(await switchWatchTogether(on.api, { screen: false, dialogue: false }), true);
  assert.deepEqual(on.calls, [['runtime', { screenSharing: true }], ['reading', { source: 'system-audio', purpose: 'movie', enabled: true }]]);
  const off = fakeApi();
  assert.equal(await switchWatchTogether(off.api, { screen: true, dialogue: true }), false);
  assert.deepEqual(off.calls, [['reading', { source: 'system-audio', purpose: 'movie', enabled: false }], ['runtime', { screenSharing: false }]], 'off: the dialogue goes first');
  for (const [kind, value] of [...on.calls, ...off.calls] as [string, Record<string, unknown>][]) {
    if (kind === 'runtime') assert.deepEqual(Object.keys(value), ['screenSharing'], 'no camera, no voice input');
    else { assert.equal(value.source, 'system-audio', 'never the microphone'); assert.equal(value.purpose, 'movie', 'never 一起听 music'); }
  }
});

test('off with the screen change refused still stops the dialogue, and the refusal is reported', async () => {
  const refused = fakeApi({ screen: true });
  await assert.rejects(switchWatchTogether(refused.api, { screen: true, dialogue: true }), /screen refused/u);
  assert.deepEqual(refused.calls[0], ['reading', { source: 'system-audio', purpose: 'movie', enabled: false }]);
  const deaf = fakeApi({ dialogue: true });
  await assert.rejects(switchWatchTogether(deaf.api, { screen: true, dialogue: true }), /reading refused/u);
  assert.deepEqual(deaf.calls.at(-1), ['runtime', { screenSharing: false }], 'a refused dialogue change still turns the screen off');
});

test('「和她一起听」 shows on for its music or the rhythm, not for the dialogue of 一起看 (off keeping the dialogue: tests/audio-dance-client.test.ts)', () => {
  assert.equal(listenMusicSwitchOn(view({ movie: true }), true), false, '一起看 dialogue alone is not 一起听');
  assert.equal(listenMusicSwitchOn(view({ music: true }), true), true);
  assert.equal(listenMusicSwitchOn(view({}), true), true, 'the rhythm alone (words refused) still shows 一起听 on');
  assert.equal(listenMusicSwitchOn(view({}), false), false);
});

test('the minute tally says how long the dialogue could reach her, was paused, or had no capture', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i187-watch-'));
  try {
    let clock = 2_000_000_000_000, hearing: WatchHearing = 'hearing';
    const conditions = { watch: true, screen: true };
    const watch = new WatchTogether({ directory, characterId: () => 'gene', conditions: () => conditions, capture: async () => null, prepare: () => null,
      readListenNote: () => null, now: () => clock, hearing: () => hearing });
    const seconds = async (n: number) => { for (let i = 0; i < n; i++) { clock += 1000; await watch.session.tick(); } };
    await seconds(21); // the first tick only starts counting
    hearing = 'paused'; await seconds(15);
    hearing = 'no-capture'; await seconds(10);
    conditions.watch = false; await seconds(30); // not watching: not counted
    const tally = await watch.tally();
    assert.deepEqual({ hearS: tally?.hearS, pausedS: tally?.pausedS, noCaptureS: tally?.noCaptureS, heard: tally?.heard }, { hearS: 20, pausedS: 15, noCaptureS: 10, heard: 0 });
    const parsed = buildJournalEntry({ type: 'watch-tally', characterId: 'gene', ...tally }, clock);
    assert.ok(parsed && parsed.type === 'watch-tally' && parsed.hearS === 20 && parsed.pausedS === 15 && parsed.noCaptureS === 10, 'the journal keeps the three numbers');
    const line = describeJournalEntry(parsed!, (source, ...values) => source.replace(/\{(\d+)\}/gu, (_, i: string) => String(values[Number(i)])));
    assert.match(line, /台词能听到 20 秒，暂停 15 秒，没采到电脑的声音 10 秒/u);
    await watch.dispose();
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  assert.equal(watchHearingOf(view({ movie: true, phase: 'ready' }) as AudioReadingView), 'hearing');
  assert.equal(watchHearingOf(view({ movie: true, phase: 'paused' }) as AudioReadingView), 'paused');
  assert.equal(watchHearingOf(view({ movie: true, phase: 'waiting' }) as AudioReadingView), 'no-capture');
  assert.equal(watchHearingOf(null), 'no-capture');
});

test('clips turned away because the recognizer was busy are counted in the listen tally', () => {
  const tally = new ListenTally();
  tally.add('received'); tally.add('skipped-busy'); tally.add('skipped-busy');
  assert.deepEqual(tally.take(), { received: 1, skippedPaused: 0, withText: 0, empty: 0, failed: 0, skippedBusy: 2 });
  tally.add('skipped-busy');
  assert.deepEqual(tally.take(), { received: 0, skippedPaused: 0, withText: 0, empty: 0, failed: 0, skippedBusy: 1 }, 'a busy-only minute still writes a line');
  assert.equal(tally.take(), null);
  const parsed = buildJournalEntry({ type: 'listen-tally', characterId: null, received: 0, skippedPaused: 0, withText: 0, empty: 0, failed: 0, skippedBusy: 3 }, 1);
  assert.ok(parsed && parsed.type === 'listen-tally' && parsed.skippedBusy === 3);
});
