// The 1-second clock (wiring rewrite step 3, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2; docs/claude/2026-11-16-wiring-step-3.md).
// One tick, its entries in the order electron/main.ts had them (the wiring golden pins it). The entries before `if (!scope) return` run
// every second; the ones after it only while her context is current (refreshVisionContext() gave a scope). electron/main.ts calls
// clockTick from its setInterval(…, 1_000) with what each entry reads, as it is at that tick (nothing is kept between ticks).
// Overhaul step 7 (docs/claude/2026-11-17-isolation-step7.md): each entry of a unit runs through the part runner (tickUnit): in isolate mode a
// throwing entry no longer stops the entries after it; three throws in a row switch that unit off alone (its entry is then skipped). The
// entries that are her conversation and mood (CompanionService, the mood host: core) and the scope that gates them run as they are: their
// failure stays what it was. The wiring golden reads a tickUnit call as the entry it wraps, so the order list is unchanged.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { isVisualAttentionCue } from '../../shared/senses';
import type { MoodCueOwner } from '../initiative';
import type { CompanionService } from '../brain';
import type { DiaryWriter, PeriodReviewWriter } from '../memory';
import type { HerNoteHost } from '../memory/her-note/wiring';
import type { FatigueActivityBridge } from '../mood';
import type { AmbientAudioRuntime, AmbientCommentsLike, ProactiveVision, ScreenGlance } from '../senses';
import type { MediaRuntime } from '../senses/media-runtime';
import type { FaceCheckParts } from '../senses/face/electron-wiring';
import type { createElectronUserActivity } from '../senses/user-activity-wiring';
import type { InnerLoopHost } from '../initiative/inner-loop/host';
import type { createImpulseHost } from '../initiative/impulse/wiring';
import type { createRps } from '../initiative/rps/wiring';
import { tickUnit } from './parts-wiring';

/** What one tick reads, as it is at that tick. */
export interface ClockScope {
  diaryWriter: Pick<DiaryWriter, 'tick'> | undefined;
  reviewWriter: Pick<PeriodReviewWriter, 'tick'> | undefined;
  herNote: Pick<HerNoteHost, 'writer'> | undefined;
  syncFatigueActivity(): void;
  screenGlance: Pick<ScreenGlance, 'watchTick'>;
  userActivity: ReturnType<typeof createElectronUserActivity> | undefined;
  innerLoopHost: InnerLoopHost;
  impulse: Pick<ReturnType<typeof createImpulseHost>, 'tick'>;
  companion: CompanionService;
  faceCheck: FaceCheckParts | null;
  refreshVisionContext(): string;
  companionCanExpress(): boolean;
  proactiveVisionEnabled: boolean;
  media: MediaRuntime;
  fatigueActivity: Pick<FatigueActivityBridge, 'current'>;
  ambientComments: AmbientCommentsLike | null;
  ambientAudio: AmbientAudioRuntime | null;
  readingActive(): boolean;
  rps: Pick<ReturnType<typeof createRps>, 'host'>;
  moodCueOwner: { id: string; owner: MoodCueOwner | null } | null;
  proactiveVision: Pick<ProactiveVision, 'start'>;
  visionEligible(): boolean;
}

export function clockTick({ diaryWriter, reviewWriter, herNote, syncFatigueActivity, screenGlance, userActivity, innerLoopHost, impulse, companion, faceCheck,
  refreshVisionContext, companionCanExpress, proactiveVisionEnabled, media, fatigueActivity, ambientComments, ambientAudio, readingActive, rps, moodCueOwner,
  proactiveVision, visionEligible }: ClockScope): void {
  tickUnit('memory', 'diary', () => diaryWriter?.tick()); // L3: a new local day, or that day's first "允许记录", writes the missing diary days.
  tickUnit('memory', 'period-review', () => reviewWriter?.tick()); // I-088 第 1 条: a finished week or month gets its look-back (after the diary has had its turn)
  tickUnit('memory', 'her-note', () => herNote?.writer.tick()); // I-134 step 3: her nightly note (once a local day from 04:00, while the user is not chatting)
  tickUnit('mood', 'fatigue-activity', () => syncFatigueActivity());
  tickUnit('senses', 'screen-glance', () => screenGlance.watchTick()); // I-006 step 3: a browser in front while the user is away may get one look
  tickUnit('senses', 'user-activity', () => userActivity?.tick()); tickUnit('initiative', 'moments', () => innerLoopHost.moments?.tick()); /* I-188: a moment asks first, so the plain greeting does not take its place */ tickUnit('initiative', 'inner-loop', () => innerLoopHost.opening.tick()); tickUnit('initiative', 'impulse', () => impulse.tick()); companion?.mood.moments.presence(userActivity?.presence()); // 心情第二批: a real return lifts O, D a little; I-066: a held intent is brought up when the user can be spoken to; I-006: one read of 'seconds since the last key or mouse' (never when the switch is off)
  tickUnit('senses', 'face-check', () => faceCheck?.host.notePresence(userActivity?.presence()?.presence)); // I-135: 在→不在, then someone back → a short burst of face checks (nothing while it is off)
  const scope = refreshVisionContext();
  tickUnit('initiative', 'inner-loop', () => innerLoopHost.loop.sweep());
  if (!scope) return;
  const canExpress = companionCanExpress();
  const visual = proactiveVisionEnabled && (media.state.screenSharing || media.sharesCameraFrames());
  companion.mood.tick(canExpress, {
    fatigueActivity:fatigueActivity.current(),
    ambientSpeech: canExpress ? ambientComments?.nextSourceObservation() : undefined,
    allowGenericSpeech: (!ambientAudio?.getState().active && !readingActive()) || visual,
  });
  companion.herLifeTick(canExpress); // 她自己的生活 (electron/stage/her-life/host.ts): only changes while the user is away.
  companion.stageMoods.tick(); // I-209 step 2: everyone else on the full-screen stage keeps her own mood's time (nobody else: nothing runs)
  tickUnit('initiative', 'rps', () => rps.host.sweep()); // G1 猜拳: a hidden companion or another character ends the game at once
  const view = companion.mood.get(), cue = view.snapshot.cue;
  if (isVisualAttentionCue(cue) && moodCueOwner?.id === cue.id && moodCueOwner.owner === 'vision') tickUnit('senses', 'proactive-vision', () => void proactiveVision.start(scope, cue,
    canExpress && visionEligible() && view.expressions && view.snapshot.phase === 'idle'));
}
