// I-016 B part: one simulated evening of 一起听 (docs/claude/2026-11-03-listen-together.md, "主动频率"): 20 songs and 2
// episodes through the real segment/note core, the real pause-point line and the real mood quota (shared/mood.ts, default
// parameters: 2 lines an hour, 30 minutes apart, stop after 1 unanswered). Fake clock, fake small model, fake chat model.
//
// I-020 #10 (docs/claude/2026-11-04-opening-choice.md): with `choice`, every pause-point cue goes through the real opening host
// (electron/inner-loop/opening-host.ts), which may give it to the listen line, her small feeling (a fake inner loop: one small-model
// call that speaks with `innerSpeaks`), or silence. Without it, the old arm: every cue is the listen line's. The user's replies and
// her choice draw from their own random streams, so both arms hear the same evening (same songs, notes and pause points).
//
//   node node_modules/tsx/dist/cli.mjs scripts/lib/listen-night.ts [--seeds 1,2,3] [--reply 0.5]
import { ListenKindHost, type ListenKind } from '../../shared/listen-kind';
import { ListenTogetherCore } from '../../electron/listen-together/core';
import { ListenProactive } from '../../electron/listen-together/proactive';
import { OpeningHost, type OpeningLoop } from '../../electron/inner-loop/opening-host';
import { OpeningChoiceDirector } from '../../shared/behaviors/opening-choice/choose';
import type { OpeningChoiceHost } from '../../shared/behaviors/opening-choice/interface';
import { applyMoodEvent, canRequestAmbientSpeech, createMoodState, getMoodSnapshot, releaseUnspokenSpeech, DEFAULT_MOOD_PARAMETERS, type MoodCue, type MoodState } from '../../shared/mood';
import type { MoodView } from '../../shared/mood-runtime';

export interface NightResult {
  songs: number; episodes: number; minutes: number;
  haikuCalls: number; notes: number; localNotes: number;
  pauses: number; declined: number; offered: number; cues: number; lines: number; replies: number;
  lineTimes: string[];
  /** Chat-model calls for her listen line (ListenProactive.counts.generated). */
  chatCalls: number;
  /** I-020 #10 arm only: small-model calls for her small feeling, lines it showed, cues she let pass in silence, listen candidates passed over. */
  innerCalls: number; innerLines: number; quiet: number; passed: number;
  /** Every line she said (listen + her own), and the minutes they were said at. */
  spoken: number; spokenTimes: number[];
}

function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

export interface NightOptions {
  seed?: number; replyChance?: number; songMention?: number; showMention?: number;
  /** I-020 #10: route the cues through the opening choice. `innerSpeaks`: how often her small-feeling call ends in a line (default 0.6). */
  choice?: { chooser?: OpeningChoiceHost; innerSpeaks?: number };
}

export async function simulateNight(options: NightOptions = {}): Promise<NightResult> {
  const seed = options.seed ?? 7;
  const random = rng(seed), replyRandom = rng(seed * 7919 + 13), innerRandom = rng(seed * 104729 + 7);
  const start = Date.UTC(2026, 10, 3, 12, 0, 0);
  let clock = start, revision = 0, haikuCalls = 0, cues = 0, replies = 0, innerCalls = 0, innerLines = 0, quiet = 0;
  const kinds = new ListenKindHost();
  const setKind = (kind: ListenKind) => kinds.set({ kind, confidence: 0.9, since: clock, revision: ++revision });
  let mood: MoodState = createMoodState(clock);
  const session = { owner: 2, sessionId: 'night', startedAt: start, captureReadyAt: start, mode: 'music' as const, scope: { characterId: 'gene', providerScope: 'p' }, contextIdentity: 'ctx' };
  let busy = false;
  const gate = { get busy() { return busy; }, setScope() {}, tryAcquire: () => {
    if (busy) return null; busy = true; const c = new AbortController(); let done = false;
    return { signal: c.signal, commit: () => { if (done) return false; done = true; busy = false; return true; }, cancel: () => { busy = false; c.abort(); } };
  } };
  const offers: string[] = [];
  let core!: ListenTogetherCore;
  const proactive = new ListenProactive({ gate, currentSession: () => session, canComment: () => true, persona: () => 'Gene', moodText: () => '',
    generate: async () => '{"comment":"刚才那段挺好的"}', offer: o => offers.push(o.id),
    mood: () => { const s = getMoodSnapshot(mood, clock); return { primary: s.primary, tendencies: s.tendencies }; },
    readNote: id => core.readNote(id), talked: (id, at) => core.markTalked(id, at), now: () => clock, random });
  core = new ListenTogetherCore({ kinds, characterId: () => 'gene', listening: () => true, now: () => clock, save: async () => {},
    note: async request => { haikuCalls++;
      const mention = random() < (request.kind === 'music' ? options.songMention ?? 0.35 : options.showMention ?? 0.6);
      return JSON.stringify({ what: request.kind === 'music' ? '歌' : '剧', gist: '合成的一段笔记', mood: '平静', points: [], mention, hook: mention ? '一个话头' : '' }); },
    pausePoint: (note, pause) => proactive.candidate(note, pause) });
  // The #10 arm: the real opening host over a fake inner loop (her small feeling: one small-model call, a line or not).
  let inner: { cue: MoodCue } | null = null;
  const loop: OpeningLoop = {
    offerOpportunity: (cue, focus) => { if (inner || (focus !== 'mood' && focus !== 'play')) return false; inner = { cue: cue as MoodCue }; return true; },
    canTake: () => !inner && !busy, claims: () => false, asleep: () => false, silence: () => false, restReminderDue: () => false,
    quietNow: () => ({ asleep: false, drowsy: false, night: false, quiet: false }),
  };
  const opening = options.choice ? new OpeningHost({ loop, chooser: options.choice.chooser ?? new OpeningChoiceDirector({ random: rng(seed * 31 + 5) }),
    innerOn: () => true, developerMode: () => false, clock: () => clock,
    releaseSpeech: cue => { quiet++; mood = releaseUnspokenSpeech(mood, cue); } }) : null;
  const lineTimes: string[] = [], spokenTimes: number[] = [];
  let replyAt: number | null = null;
  const said = () => { spokenTimes.push(Math.round((clock - start) / 60_000)); if (replyRandom() < (options.replyChance ?? 0.5)) replyAt = clock + 20_000; };
  const step = async (seconds: number, text?: () => string | null) => {
    for (let i = 0; i < seconds; i++) {
      clock += 1000;
      if (text && i % 12 === 11) { const t = text(); if (t) core.accept({ at: clock - 12_000, end: clock, text: t, language: 'zh' }); }
      core.tick();
      for (let k = 0; k < 6; k++) await Promise.resolve();
      const source = proactive.nextSourceObservation();
      if (source && canRequestAmbientSpeech(mood, source, clock)) {
        mood = applyMoodEvent(mood, { type: 'attention', id: `cue-${clock}`, kind: 'speech', source }, clock);
        const snapshot = getMoodSnapshot(mood, clock);
        if (snapshot.cue) {
          cues++;
          const view: MoodView = { characterId: 'gene', revision: cues, token: 't', developerMode: false, expressions: true, parameters: DEFAULT_MOOD_PARAMETERS, snapshot, gesture: null };
          const owner = opening ? opening.claim(snapshot.cue, { ambient: c => proactive.canTake(c), ambientPassed: c => proactive.pass(c) }, view) : 'ambient';
          if (owner === 'ambient') {
            proactive.observe(view);
            for (let k = 0; k < 8; k++) await Promise.resolve();
            const id = offers.at(-1);
            if (id && proactive.awaitingPresentation(2, id) && await proactive.acknowledge(2, id)) {
              lineTimes.push(`${Math.round((clock - start) / 60_000)} min`);
              said();
            }
          } else if (owner === 'inner' && inner) {
            const taken: { cue: MoodCue } = inner; inner = null; innerCalls++;
            if (innerRandom() < (options.choice?.innerSpeaks ?? 0.6)) { innerLines++; said(); }
            else { quiet++; mood = releaseUnspokenSpeech(mood, taken.cue); }
          }
        }
      }
      if (replyAt !== null && clock >= replyAt) {
        replyAt = null; replies++;
        mood = applyMoodEvent(mood, { type: 'chat', id: `reply-${clock}` }, clock);
        await proactive.acceptUserTurn(`reply-${clock}`, '嗯');
      }
    }
  };
  let songs = 0;
  for (let i = 0; i < 20; i++) {
    songs++;
    const lyrics = i % 4 !== 3, seconds = 180 + Math.floor(random() * 120);
    setKind('music');
    await step(seconds, () => lyrics ? `第${i}首歌的歌词一句一句地唱着夏天和远方` : null);
    setKind('quiet'); await step(2);
  }
  await step(5 * 60);
  for (let e = 0; e < 2; e++) {
    setKind('show'); await step(20 * 60, () => `第${e + 1}集的对白，两个人在店里说着要离开的事情`);
    setKind('quiet'); await step(120); // the user paused it
    setKind('show'); await step(25 * 60, () => `第${e + 1}集后半段的对白，故事慢慢走向告别`);
    setKind('quiet'); await step(e === 0 ? 3 * 60 : 11 * 60);
  }
  await core.settled();
  const notes = core.notesFor('gene');
  return { songs, episodes: 2, minutes: Math.round((clock - start) / 60_000), haikuCalls, notes: notes.length, localNotes: notes.filter(n => n.local).length,
    pauses: proactive.counts.pauses, declined: proactive.counts.declined, offered: proactive.counts.offered, cues, lines: proactive.counts.shown, replies, lineTimes,
    chatCalls: proactive.counts.generated, innerCalls, innerLines, quiet, passed: proactive.counts.passed,
    spoken: proactive.counts.shown + innerLines, spokenTimes };
}

if (process.argv[1] && process.argv[1].endsWith('listen-night.ts')) {
  const option = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
  void (async () => {
    for (const arm of ['old', 'choice'] as const) {
      const rows: NightResult[] = [];
      for (const seed of option('seeds', '1,2,3,4,5,6,7,8,9,10').split(',').map(Number))
        rows.push(await simulateNight({ seed, replyChance: Number(option('reply', '0.5')), ...(arm === 'choice' ? { choice: {} } : {}) }));
      for (const r of rows) console.log(arm, JSON.stringify({ ...r, lineTimes: undefined }));
      const avg = (key: keyof NightResult) => (rows.reduce((s, r) => s + (r[key] as number), 0) / rows.length).toFixed(1);
      console.log(`${arm} 平均（${rows.length} 晚）：haiku 笔记 ${avg('haikuCalls')} 次，停顿点候选 ${avg('pauses')}，交给心情 ${avg('offered')}，开口时机 ${avg('cues')}，`
        + `聊歌 ${avg('lines')} 句（聊天模型 ${avg('chatCalls')} 次），她自己的话 ${avg('innerLines')} 句（小模型 ${avg('innerCalls')} 次），不说 ${avg('quiet')}，共说 ${avg('spoken')} 句，用户接话 ${avg('replies')}`);
    }
    process.exit(0);
  })();
}
