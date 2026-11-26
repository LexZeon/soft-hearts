// 主动's wiring (wiring rewrite step 4, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2; docs/claude/2026-11-16-wiring-step-4e.md):
// what she starts on her own. Moved from electron/main.ts; the statements are the ones main.ts had. Split by feature
// (docs/claude/2026-11-17-split-initiative-memory-wiring.md); wireInitiative makes them in the order main.ts did:
// - here: the one proactive-speech gate (every proactive line holds it; it reads her sleep, T-209);
// - initiative-look-wiring.ts: I-040 看一眼、听一下 (the sense router, evaluated by the reactions' haiku call: made before
//   electron/main.ts makes the reactions) and I-085 her own look (its timer starts in early(), where main.ts started it);
// - initiative-together-wiring.ts: G1 猜拳, I-019 喂食认图 (its line is hers; the recognition itself is 感知's module), I-051 带我去,
//   I-050 her folder and its keepsakes, I-059 special days (记忆's module, made beside the keepsakes as before), I-086 递东西, I-087 牵手;
// - here: 数据地图, the stores 主动 owns (G1 猜拳, I-087 牵手拉钩, I-086 我们的小东西, I-050 留给你的) are registered (registerPrivacyStores);
// - initiative-inner-loop-wiring.ts: L1 the inner loop and 松绑 her urge; R20 offers (off), made by the ready chain;
// - here: the line she says on her own being acknowledged or cancelled.
// - The cue chain (CUE_CHAIN, I-020 #10 / I-087): who is asked about her mood cue, in order; electron/main.ts's mood publish asks it once
//   per publish (claimMoodCue) and the 1-second clock reads the owner (moodCueOwner). The wiring golden pins the list (order.cueChain).
// - The handlers (register) run inside the agent channel's recorder, where main.ts registered them.
// - What the lines read from the rest of the app comes through InitiativeNeeds (getters electron/main.ts gives): `needs.<value>` (read
//   when used), and the other parts' functions taken by their own names. The state other parts read is module-level and exported (live
//   bindings electron/main.ts reads: the ready chain loads, the clock ticks and before-quit disposes them where it always did); the
//   feature files' state is re-exported from here, so the other parts import 主动's state from this file only.
// What stays in electron/main.ts and why (docs/claude/2026-11-16-wiring-step-4e.md): companionCanExpress (the mood tick's own gate, also
// the clock's), the chat turn's lines, the order lists (ready chain, clock, before-quit) and the mood publish itself (it fans out to the
// stage, the senses, 记忆, R20 and the mood judge; only its claim is here).
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import type { BrowserWindow } from 'electron';
import type { MoodCue } from '../../shared/foundation/mood';
import type { MoodView } from '../../shared/mood';
import { ProactiveSpeechGate, type createInnerLoopHost, type MoodCueOwner, type R20ProactiveOffers, type RpsJournalEntry } from '../initiative';
import type { createRps } from '../initiative/rps/wiring';
import type { CompanionService } from '../brain';
import type { AppJournal } from '../memory';
import type { CameraLookJournal } from '../senses';
import type { createHerState, createTouchBrain } from '../mood';
import type { CharacterCardStore, PersonalizeLanguageStore } from '../cards';
import type { ReplyProofSurface } from '../unbound';
import { publicSettings, type SettingsStore } from '../settings';
import type { PartIpc } from './ipc-wiring';
import type { PartHandle } from './parts-wiring';
import { registerPrivacyStores, textMemorialHost } from './memory-wiring';
import { ambientComments, visionGeneration, type SensesNeeds, type SensesProvides } from './senses-wiring';
import type { SafetyProvides } from './safety-wiring';
import type { VoiceProvides } from './voice-wiring';
import { broadcast } from './shell-wiring';
import { unboundNoticedClaims } from './unbound-wiring';
import { selfLook, senseRouter, wireInitiativeLook } from './initiative-look-wiring';
import { feeding, give, hands, herFolder, keepsake, rps, specialDay, takeMeThere, wireInitiativeTogether } from './initiative-together-wiring';
import { impulse, innerLoopHost, r20ProactiveOffers, wireInitiativeInnerLoop } from './initiative-inner-loop-wiring';
import { moments, momentsChatTurn, momentsReplyDone, registerHerAlarms, wireInitiativeMoments } from './initiative-moments-wiring';

type RpsWiring = Parameters<typeof createRps>[0];
type R20Options = ConstructorParameters<typeof R20ProactiveOffers>[0];

/** What 主动's lines read from the rest of the app (electron/main.ts gives getters; a value is read when it is used). */
export interface InitiativeNeeds {
  readonly store: SettingsStore;
  readonly companion: CompanionService;
  readonly characterCards: CharacterCardStore;
  readonly personalizeLanguage: PersonalizeLanguageStore | undefined;
  readonly pet: BrowserWindow | null;
  readonly controls: BrowserWindow | null;
  readonly petReply: ReturnType<R20Options['surface']>;
  readonly petWindowDrag: { readonly active: boolean } | null;
  readonly pending: SensesNeeds['pending'];
  readonly exiting: boolean;
  readonly appJournal: AppJournal;
  // 感知 I-084 (one journal line per chat turn: whether the sense router's look saw the user)
  readonly cameraLookJournal: CameraLookJournal; // made before wireInitiative runs and never replaced (taken once)
  // 心情 and 大脑 objects her lines report to or read (made by electron/main.ts)
  readonly moodJudge: { readonly host: { note(note: { kind: 'game'; characterId: string; result: NonNullable<RpsJournalEntry['result']>; rounds: number } | { kind: 'her-line'; characterId: string }): void } };
  readonly moduleRouter: RpsWiring['router'];
  readonly touchBrain: ReturnType<typeof createTouchBrain>;
  readonly herState: ReturnType<typeof createHerState>;
  readonly safety: SafetyProvides['crisisCard'];
  // 感知 (看): the switches, the look, the screen and camera frames, the visual initiative and its presentation
  readonly media: SensesProvides['media'];
  readonly lookTurns: SensesProvides['lookTurns'];
  readonly screenSnapshots: SensesProvides['screenSnapshots'];
  readonly proactiveVision: SensesProvides['proactiveVision'];
  readonly visionPresentation: SensesProvides['visionPresentation'];
  readonly cameraSamples: SensesProvides['cameraSamples'];
  // 声音 / 感知 (听): what is speaking now
  readonly speechRuntime: VoiceProvides['speechRuntime'];
  readonly ambientSpeakingOwners: SensesProvides['ambientSpeakingOwners'];
  readonly speechPlaybackActivity: VoiceProvides['speechPlaybackActivity'];
  // the other parts' functions (electron/main.ts's wrappers; taken once)
  speechScope(): string;
  journalCharacterId(): string | null;
  replySpeechBusy(): boolean;
  beginInitiativeSpeech(sender: number, id: string, owner?: string): void; // I-209 step 4: `owner` (her card) for a chime-in on stage
  /** The mood tick's automatic-expression gate (electron/main.ts; the clock reads it too). */
  companionCanExpress(): boolean;
  herOnScreen(): boolean;
  replySurface(): ReplyProofSurface | null;
  readingActive(): boolean;
  currentAmbientSession: SensesProvides['currentAmbientSession'];
  /** Read when called, by its own name (tests/pose-privacy.test.ts counts every captureSharedCamera call and its guard). */
  readonly captureSharedCamera: SensesProvides['captureSharedCamera'];
  lookState: SensesProvides['lookState'];
  visionEligible(): boolean;
  cancelReplyStyle(id: string): boolean;
  mutate<T>(operation: () => Promise<T>): Promise<T>;
  agentInterconnected: SensesNeeds['agentInterconnected'];
  openCodexTaskConfirmation: SafetyProvides['openCodexTaskConfirmation'];
}

/** What electron/main.ts calls (from initiative.provides, so its ready chain and mood publish keep them as calls). */
export interface InitiativeProvides {
  /** Ready-chain step (inside startMemory): R20 offers, made once the profile is active. */
  initR20ProactiveOffers(): void;
  /** One mood publish's claim: the owner of its cue, asked along CUE_CHAIN; the clock reads it as moodCueOwner. */
  claimMoodCue(view: MoodView): MoodCueOwner | null;
  /** Her proactive line and what goes with it go back (inputOnly: the user only typed; the memorial, her hand, what she holds out and R20 stay). */
  cancelProactiveVision(inputOnly?: boolean, keepLine?: boolean): void;
}

// ---- state other parts read (live bindings electron/main.ts imports) ----
/** T-209: asleep, a line still out is dropped and none commits (the opening choice's own reading of her sleep: "睡着时谁都不开口"). */
export let proactiveSpeechGate!: ProactiveSpeechGate;
/** Who the last mood publish gave its cue to (electron/initiative/inner-loop/claim.ts); the screen chat starts only on its own. */
export let moodCueOwner: { id: string; owner: MoodCueOwner | null } | null = null;
/** The feature files' state, re-exported (live bindings): electron/main.ts and the other parts import 主动's state from here. */
export { senseRouter, selfLook, rps, feeding, takeMeThere, herFolder, keepsake, specialDay, give, hands, innerLoopHost, impulse, r20ProactiveOffers, moments, momentsChatTurn, momentsReplyDone };
/** Her own proactive line being read (the voice reads it: VoiceNeeds.lastVisionSpeech; the inner loop's lines carry their own guard). */
export let lastVisionSpeech: { owner: number; id: string; guard?: SensesProvides['visionPresentation'] | ReturnType<typeof createInnerLoopHost>['presentation'] | StageLineGuard } | null = null;
/** I-209 stage voice: a chime-in's own proof (her bubble on the stage shows exactly this line). */
export type StageLineGuard = { canSpeak(id: string): boolean };
/**
 * I-209 stage voice (docs/claude/2026-11-24-i209-stage-voice.md): her chime-in on the full-screen stage is her own line being read, like a
 * look line: the voice lets the companion window play it only while its guard says her bubble shows it, re-checked before each piece of audio
 * (voice-wiring heldLineSpeakable and the runtime's config). A user's message ends it like her other own lines (cancelProactiveVision).
 */
export function readStageLine(owner: number, id: string, guard: StageLineGuard): void { lastVisionSpeech = { owner, id, guard }; }
/** Her chime-in's reading stops now (the user's turn talks over her, or she left): only if it is still the line being read. */
export function cutStageLine(id: string): void {
  const line = lastVisionSpeech;
  if (!line || line.id !== id) return;
  lastVisionSpeech = null;
  try { needs.speechRuntime.cancelReply(line.owner, line.id); } catch { /* nothing was playing */ }
  try { needs.cancelReplyStyle(line.id); } catch { /* already gone */ }
  broadcast('desk:vision-initiative', { type: 'cancel', id: line.id }); // the companion window stops reading it; her bubble takes it back
}

// Set by wireInitiative (while electron/main.ts is evaluated, before anything below runs).
let needs!: InitiativeNeeds;

/** electron/main.ts calls this once, while it is evaluated, where it made the sense router (before the reactions read its port). */
export function wireInitiative(given: InitiativeNeeds): PartHandle<InitiativeProvides> & { early(): void; register(ipc: PartIpc): void } {
  needs = given;
  const { speechScope, beginInitiativeSpeech, visionEligible, cancelReplyStyle, mutate } = given;
  // T-209: asleep, a line still out is dropped and none commits (the opening choice's own reading of her sleep: "睡着时谁都不开口").
  proactiveSpeechGate = new ProactiveSpeechGate(Date.now, { resting: () => innerLoopHost.loop.asleep() });
  // I-040 看一眼、听一下 and I-085 her own look (electron/wiring/initiative-look-wiring.ts).
  wireInitiativeLook(given);
  // G1 猜拳, I-019 喂食, I-051 带我去, I-050 her folder and keepsakes, I-059 special days, I-086 递东西, I-087 牵手 (electron/wiring/initiative-together-wiring.ts).
  wireInitiativeTogether(given);
  // 数据地图 (wiring rewrite step 4d): the stores 主动 owns, handed over once (G1 猜拳, I-087 牵手拉钩, I-086 我们的小东西, I-050 留给你的).
  registerPrivacyStores('initiative', { recycle: () => ({ rps: rps.store, hands: hands.store, ourThings: give.store, keepsakes: keepsake }),
    recordingOff: () => ({ rps: rps.store, hands: typeof hands !== 'undefined' ? hands.host : null, reminders: moments?.reminderStore ?? null }) }); // I-188: reminders go with a deleted character
  // L1 the inner loop, 松绑 her urge; R20 offers are made later, by the ready chain (electron/wiring/initiative-inner-loop-wiring.ts).
  const { initR20ProactiveOffers } = wireInitiativeInnerLoop(given);
  // I-188 她认出的时刻: the moments read the inner loop's sleep and rest-reminder night (electron/wiring/initiative-moments-wiring.ts).
  wireInitiativeMoments(given);

  /**
   * The cue chain (I-020 #10 one cue, one owner; I-087): who is asked about her mood cue, in this order; the first step that takes it owns
   * it and nobody after it is asked (claimMoodCue). Her hand first: one of her small-motion opportunities may become her hand reaching for
   * yours (same cue, same interval; never a speech cue). Then the opening choice (electron/brain/opening-host.ts): asleep nobody; her
   * memorial invitation, then R20; then she picks what to say (the screen chat, a sound line, her small feeling or an invite, or nothing).
   * The wiring golden pins this list (order.cueChain); tests/initiative-gates.test.ts runs it.
   */
  const CUE_CHAIN: readonly { readonly id: string; claims(cue: MoodCue | null, view: MoodView): MoodCueOwner | null }[] = [
    { id: 'hands', claims: cue => typeof hands !== 'undefined' && hands.host.claimCue(cue) ? 'hands' : null },
    { id: 'opening', claims: (cue, view) => innerLoopHost.opening.claim(cue, {
      memorial: c => c.kind === 'speech' && !!textMemorialHost?.offerOpportunity(c),
      r20: c => c.kind === 'speech' && !!r20ProactiveOffers?.offerOpportunity(c),
      vision: c => c.kind === 'speech' && c.source === undefined && visionEligible(),
      ambient: c => c.kind === 'speech' && c.source !== undefined && ambientComments?.canTake?.(c) !== false,
      ambientPassed: c => ambientComments?.pass?.(c),
      touch: c => needs.touchBrain.claims(c) || unboundNoticedClaims(c), // I-136: the speech cue she asked for to answer a touch; Unbound step 4: or something she noticed you do
      moment: c => moments?.claims(c) ?? null, // I-188: the speech cue a recognised moment asked for (information for her)
    }, view) },
  ];
  /** One mood publish's claim: the first step of CUE_CHAIN that takes her cue owns it; the 1-second clock reads the owner (moodCueOwner). */
  function claimMoodCue(view: MoodView): MoodCueOwner | null {
    const cue = view.snapshot.cue;
    let claimant: MoodCueOwner | null = null;
    for (const step of CUE_CHAIN) { claimant = step.claims(cue, view); if (claimant !== null) break; }
    moodCueOwner = cue ? { id: cue.id, owner: claimant } : null;
    return claimant;
  }
  async function ackInnerInitiative(sender: number, id: string): Promise<boolean> {
    const generation = visionGeneration, acceptedScope = speechScope();
    if (!await innerLoopHost.loop.ack(id) || generation !== visionGeneration || acceptedScope !== speechScope()
      || !innerLoopHost.presentation.canSpeak(id)) return false;
    beginInitiativeSpeech(sender, id);
    lastVisionSpeech = { owner: sender, id, guard: innerLoopHost.presentation };
    return true;
  }
  /** `keepLine` (I-174 item 3: your input, a touch): her line being said now goes on; what has not started yet is still dropped. */
  function cancelProactiveVision(inputOnly = false, keepLine = false): void {
    if(!inputOnly)textMemorialHost?.cancel();
    if(!inputOnly&&typeof hands!=='undefined')hands.host.cancel(); // I-087: her reach goes back quietly
    if(!inputOnly&&typeof give!=='undefined')give.host.cancel(); // I-086: what she holds out goes back quietly (nothing is written); the guard keeps tests that lift this function out working
    if(!inputOnly)r20ProactiveOffers?.cancel();
    if (!keepLine || !lastVisionSpeech || lastVisionSpeech.guard) needs.visionPresentation.clear(); // a kept look line still needs its proof
    if (lastVisionSpeech && !keepLine) {
      const previous = lastVisionSpeech;
      lastVisionSpeech = null;
      needs.speechRuntime.cancelReply(previous.owner, previous.id);
      cancelReplyStyle(previous.id);
      broadcast('desk:vision-initiative', { type: 'cancel', id: previous.id });
    }
    proactiveSpeechGate.cancel();
    needs.proactiveVision.cancel();
    needs.cameraSamples.cancel();
  }

  return {
    id: 'initiative',
    units: ['proactive-speech-gate', 'sense-router', 'self-look', 'rps', 'feeding', 'take-me-there', 'her-folder', 'keepsake', 'special-day', 'give', 'hands', 'inner-loop', 'impulse', 'r20-offers', 'moments'],
    /** Overhaul step 7: the handlers of each unit that can be switched off (they answer PART_OFF while it is off). */
    ipc: { rps: ['rpsGet', 'rpsThrow', 'rpsRespond'], feeding: ['feedSnack', 'feedLineDone', 'getFeedRecognition', 'setFeedRecognition'],
      'her-folder': ['getHerFolder', 'chooseHerFolder', 'turnOffHerFolder', 'restoreHerFolderItem', 'openHerFolder', 'openHerFolderFromNote'],
      'r20-offers': ['r20ProactiveOfferGet', 'r20ProactiveOfferAcknowledge', 'r20ProactiveOfferRespond'], 'inner-loop': ['getInnerLoop', 'setInnerLoop'],
      give: ['giveAnswer', 'givePicture', 'saveGivePicture', 'getOurThings', 'ourThingPicture', 'removeOurThing'], hands: ['handsAnswer', 'handsRequest'] },
    /** I-085: her own look's timer starts while electron/main.ts is evaluated, as before. */
    early(): void { selfLook.start(); },
    register(ipc: PartIpc): void {
      const { host, scopedHost } = ipc;
      scopedHost('takeMeThere', (sender, request) => takeMeThere.go(sender, request), false);
      registerHerAlarms(ipc); // I-195: the user profile page's switch and list of her own alarms
      herFolder.register(scopedHost); // I-050: the control page (choose, off, restore, open) and the note's button under her reply
      if (typeof hands!=='undefined') hands.register(scopedHost); // I-087: the companion window's answer and "the mouse rested near her"
      give.register(scopedHost); // I-086: the companion window's answer, picture and save; the control window's 我们的小东西 page
      host('getInnerLoop', () => innerLoopHost.view(), false);
      host('setInnerLoop', value => mutate(async () => {
        const { store } = needs; // read when called
        if (typeof value !== 'boolean') throw new Error('内心循环开关不正确。');
        if (store.current.innerLoop !== value) await store.persist({ ...store.current, innerLoop: value });
        if (!value) innerLoopHost.loop.cancel();
        broadcast('desk:settings', publicSettings(store.current));
        const view = innerLoopHost.view(); broadcast('desk:inner-loop', view); return view;
      }), false);
      host('r20ProactiveOfferGet', () => r20ProactiveOffers?.get() ?? {revision:0,offer:null}, false);
      // G1 猜拳: the companion window's view and its two inputs; only the companion window may throw or answer (electron/initiative/rps/host.ts validates the rest).
      host('rpsGet', () => rps.host.view(), false);
      scopedHost('rpsThrow', (sender, value) => { const { pet } = needs; /* read when called */ return pet && sender === pet.webContents.id ? rps.host.throwHand(value) : 'invalid'; }, false);
      scopedHost('rpsRespond', (sender, value) => { const { pet } = needs; /* read when called */ return pet && sender === pet.webContents.id ? rps.host.respond(value) : false; }, false);
      feeding.register(scopedHost); // I-019: the picture and her line (companion window only), the switch (control window)
      senseRouter.register(scopedHost); // I-040: the companion window says her short line was shown
      scopedHost('r20ProactiveOfferAcknowledge', (sender, value) => r20ProactiveOffers?.acknowledge(sender,value) ?? null, false);
      scopedHost('r20ProactiveOfferRespond', (sender, value) => r20ProactiveOffers?.respond(sender,value)
        ?? {status:'stale',state:{revision:0,offer:null}}, false);
      scopedHost('ackVisionInitiative', async (sender, id: unknown) => {
        const { pet, proactiveVision, visionPresentation } = needs; // read when called
        if (sender === pet?.webContents.id && typeof id === 'string' && innerLoopHost.loop.owns(id)) return ackInnerInitiative(sender, id);
        if (sender !== pet?.webContents.id || typeof id !== 'string' || !visionEligible()) return false;
        const generation = visionGeneration, acceptedScope = speechScope();
        if (!await proactiveVision.ack(id) || generation !== visionGeneration || !visionEligible()
          || acceptedScope !== speechScope() || !visionPresentation.canSpeak(id)) return false;
        beginInitiativeSpeech(sender, id);
        lastVisionSpeech = { owner: sender, id };
        return true;
      }, false);
    },
    provides: { initR20ProactiveOffers, claimMoodCue, cancelProactiveVision },
  };
}