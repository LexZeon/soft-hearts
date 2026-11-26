// Unbound's wiring (wiring rewrite step 4, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2; docs/claude/2026-11-16-wiring-step-4a.md):
// her second stage beside the companion (U1, developer mode), the way out and back (v1 step 1: entry, its permission page and the recovery of a
// stay a dead run left), and typing to her while she is out (v1 step 2). Moved from electron/main.ts.
// - startUnbound is one step of the ready chain, where the old lines ran: after the companion window's topmost guard and before
//   registerIPC. Its three handlers (getUnbound, setUnbound, toggleUnbound) are registered there, outside the agent channel's recorder,
//   as before: the agent channel does not reuse them. The wiring golden reads startUnbound's body in place of the call.
// - The recovery check (unboundEntry.recover) stays in electron/main.ts's ready chain at its old moment: after both windows loaded,
//   once the face check settled.
// - releaseUnbound is the before-quit step (the old three calls, in order).
// unbound, unboundEntry and unboundTyping are live bindings electron/main.ts reads (null until startUnbound ran).
// What the lines read from the rest of the app comes through UnboundNeeds (electron/main.ts gives getters; each read when used).
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import type { BrowserWindow } from 'electron';
import { t, currentUiLanguage } from '../../shared/foundation/ui-language';
import { cardDisplayNames } from '../../shared/cards';
import { unboundOutsideLine } from '../../shared/unbound/outside-line';
import { herPositionLine, placeMarkWordsLine } from '../../shared/unbound/her-position';
import { closeArmsOf, type CloseArms } from '../../shared/unbound/close-moments';
import { BeatSituation, CONDENSE_SYSTEM, CloseBeatSequence, CloseCutNotice, SPEECH_FACE_RELAY, UnboundHistory, applyPlaceMark, companyPorts, createUnboundHost, motionsOut, stageOf, peekMoodFrom, applyReadPause, type BubbleHoldPlan, type CompanyStage, type UnboundGamesPorts, type UnboundHost, type UnboundMotionPorts } from '../unbound';
import { stageCharacters, stageHostOf } from './unbound-stage-wiring';
import { quickLineWithClaude } from '../initiative';
import { reportTouch } from '../mood';
import { setHandedLineGate, speechBeatsFor, type CompanionService } from '../brain';
import type { AppJournal } from '../memory';
import type { reactions as moodReactions } from './mood-wiring';
import { createUnboundEntry, type UnboundEntryHandle, type UnboundEntryWiring } from '../unbound/entry-wiring';
import { createUnboundTyping, type UnboundTypingHandle } from '../unbound/typing-wiring';
import { sayLine } from '../unbound/say-line';
import { UnboundSayAcks } from '../unbound/say-ack';
import { createControlAwake, followUnboundMode, lineAwake, type ControlAwake } from '../unbound/control-awake';
import { InputCallBridge } from '../unbound/input-call';
import { createUnboundCards, type UnboundCardsHandle } from '../unbound/card-wiring';
import { unboundBubbleLingerMs } from '../unbound/bubble-linger';
import type { ChatSettingCardView } from '../../shared/brain';
import type { PerceptionSwitches } from '../safety';
import type { SettingsStore } from '../settings';
import type { PartIpc } from './ipc-wiring';
import { startUnitSync, type PartDeclaration } from './parts-wiring';
import { broadcast, tapBroadcast, updateTray } from './shell-wiring';
import { relayStageMusic } from './unbound-senses-wiring';
import { gateEnabled, onChannelGatesChanged, registerChannelGates, unboundEntryAllowed } from './channel-gates-wiring';
import { onScreenSourceChanged, screenSourceChoice } from './screen-source-wiring';
import { inputWatchTogether } from '../unbound/input-watch';
import { offAsNotUsers } from '../senses';
import { audioReading } from './senses-listen-wiring';
import { characterCards } from './cards-ready-wiring';
import { assetRegistry, bundledAssets } from './actions-wiring';
/** The user's own switch paths (the control window's recorded operations); the input box's 一起看 click uses them as the permission bundle does. */
const switchesNow = () => { const value = needs().perceptionSwitches; if (!value) throw new Error('控制窗口尚未就绪。'); return value; };

type UnboundWiring = Parameters<typeof createUnboundHost>[0];
/** What Unbound's wiring reads from the rest of the app (electron/main.ts gives getters; each is read when it is used). */
export interface UnboundNeeds {
  /** Where the Unbound pages come from (dev server or the built files); a fresh object each read, as the old lines built one each. */
  readonly page: UnboundWiring['page'];
  readonly pet: BrowserWindow | null;
  readonly controls: BrowserWindow | null;
  readonly store: SettingsStore;
  /** The user's own switches' host paths (electron/safety/agent-channel), null until the control window's operations are recorded. */
  readonly perceptionSwitches: PerceptionSwitches | null;
  developerMode(): boolean;
  source: UnboundWiring['source'];
  reviewed(): Promise<boolean>;
  restPose(): Promise<string | null>;
  sync(): void;
  /** The companion window is told its visibility again (null until it was secured). */
  republishPetVisibility(): void;
  cancelCompletedReply(id?: string, by?: 'stop' | 'switch' | 'interrupt'): boolean;
  cancelProactiveVision(quiet: boolean): void;
  /** U2 (I-104): what her peek reads from what the app already knows. */
  readonly peek: NonNullable<UnboundWiring['peek']>;
  face: UnboundEntryWiring['face'];
  /** A chat reply is being written. */
  replyRunning(): boolean;
  /** Claude's chat can take a message now (electron/brain chat availability). */
  chatAvailable(): boolean;
  /** Step 4: her voice is reading a reply, or holds a playback lease (the watch-along initiative's reading of "she is speaking"). */
  replySpeechBusy(): boolean;
  /** I-165: the reading plan her full-screen bubble asks whether a reply follows her voice, and where its sentences end. */
  readonly completedReplySpeech: BubbleHoldPlan;
  readonly speechPlaybackActivity: { readonly busy: boolean };
  /** Step 4: the computer's sound kind (I-016; only its word is read). */
  readonly listenKind: { heardKind(): unknown };
  /** Step 4 (afternoon addition C): her mood host (moments, the speech cue), her reactions' dispositions, the experience journal. */
  readonly companion: CompanionService;
  readonly reactions: typeof moodReactions | null;
  readonly appJournal: AppJournal;
}

/** Step 4 (afternoon addition C): what she noticed of you while out; null until startUnbound. */
export let unboundHistory: UnboundHistory | null = null;
/**
 * The chat turn's sentences about it ('' for none): brain-chat-wiring adds them after this turn's perception line. I-193: while she is out, one more
 * line says where she stands (I-211: how far from the user by the screen formula, what the user sees of her, left / middle / right and the share
 * across, the user's default place, an edge, the taskbar), in the chat's language; information only. I-212: then the two hidden place markers'
 * words (what they are, never when; electron/unbound/place-marks.ts reads them).
 */
export function unboundNoticedLine(language?: string | null, owner?: string | null): string {
  if (stageHostOf(unboundStage(), owner)) { try { return unboundPositionLine(language, owner); } catch { return ''; } } // I-209 step 3: someone else on stage: where SHE stands (what the first one noticed stays hers)
  let line = '';
  try { line = (closeCutHost?.turnLine() ?? '') + (unboundHistory?.turnLine() ?? ''); } catch { line = ''; } // I-203: an interrupted kiss / hug's facts first (they replace the short line)
  try { return line + unboundPositionLine(language); } catch { return line; }
}
/** I-193 / I-211: where she stands (with how big, the near-far table and how her last go-markers went), with the place markers' words ('' at home, or before her world and her height are known). */
export function unboundPositionLine(language?: string | null, owner?: string | null): string {
  const host = stageHostOf(unboundStage(), owner) ?? unbound; // I-209 step 3: the one whose turn it is
  if (host?.state !== 'unbound') return '';
  const now = host.her.facts(), lastGo = now ? host.life?.takeGoOutcomes() ?? null : null; // I-193: how her go-markers went, told once
  const line = now ? herPositionLine(now.spot, { ...now.facts, language, lastGo }) : '';
  return line ? line + placeMarkWordsLine(language) : '';
}
/**
 * I-212: her hidden place markers in her finished reply to the
 * message the user just sent (the typed / voice-input chat turn calls this; nothing else does): only while she is out; one per reply; a journal row.
 */
export function unboundPlaceMarks(markers: readonly string[] | undefined, owner?: string | null): void {
  try {
    const host = stageHostOf(unboundStage(), owner) ?? unbound, id = stageHostOf(unboundStage(), owner) ? owner! : needs().companion?.mood.get().characterId ?? null; // I-209 step 3: her own place
    applyPlaceMark(markers, 'user', { out: () => host?.state === 'unbound', setHere: () => host?.places.setHere() ?? false, clear: () => { host?.places.clear(); },
      journal: row => needs().appJournal.record({ ...row, characterId: id }) });
  } catch { /* her reply is done; nothing here stops anything */ }
}
/** The opening choice's claimant for the speech cue she asked for (initiative-wiring's cue chain, beside the touch's). */
export function unboundNoticedClaims(cue: { kind?: unknown; source?: unknown } | null | undefined): boolean { try { return unboundHistory?.claims(cue) ?? false; } catch { return false; } }
/** The inner loop's focus line for that cue (beside the touch's). */
export function unboundNoticedPrompt(characterId: string): string { try { return unboundHistory?.promptLine(characterId) ?? ''; } catch { return ''; } }
/** I-159 B: while she is out, the turn's one line that the senses are all on and need no switch from the user ('' at home). */
export function unboundOutsideTurnLine(): string { try { return unboundOutsideLine(unbound?.state); } catch { return ''; } }
const localDay =(now: number) => { const d = new Date(now); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
function createHistory(): UnboundHistory {
  const mood = () => needs().companion?.mood;
  return new UnboundHistory({
    clock: () => Date.now(), random: () => Math.random(), day: localDay,
    characterId: () => mood()?.get().characterId ?? null, mood: () => peekMoodFrom(needs().peek.mood()), asleep: () => needs().peek.asleep(),
    lean: () => { const m = mood(), r = needs().reactions; if (!m || !r) return null; const d = r.dispositionsFor(m.get()); return { lively: d.lively, restrained: d.restrained }; },
    moment: kind => mood()?.moments.note(kind) ?? false,
    attention: () => mood()?.touchAttention('free') ?? false, // Unbound: no cap (as a touch while she is out)
    journal: row => needs().appJournal.record({ type: 'noticed', ...row }),
    condense: async (account, signal) => (await quickLineWithClaude(account, CONDENSE_SYSTEM, signal)).text, // haiku: only the day's account (kinds and count words)
  });
}

/** I-185: what she can do now for her turn's marker words (electron/unbound/beat-situation.ts); made once, on first use. */
let beatSituationHost: BeatSituation | null = null;
function beatSituation(): BeatSituation {
  beatSituationHost ??= new BeatSituation({
    state: () => unbound?.state ?? 'normal', companionShown: () => needs().store.current.pet.visible !== false, // no-pet-ok: the stored settings field's own name
    view: () => needs().companion?.mood.get() ?? null, asleep: () => needs().peek.asleep(), armsHeld: () => gamesPorts?.playing() ?? false, inCall: () => needs().peek.inCall(),
    card: () => capabilityView ? capabilityView() : Promise.resolve(null),
    closeNow: () => unbound?.life?.pulledNow ? 'pulled' : unbound?.peek?.active ? 'busy' : unboundTyping?.typingNow() ? 'typing' : null, // 2026-11-23
  });
  return beatSituationHost;
}

/**
 * 2026-11-23 / I-203: her words wait only at the frames she placed (electron/unbound/close-sequence.ts); one for the app, made on first use. A kiss's
 * contact pauses her bubble's follow clocks; an interrupted kiss / hug of her reply stops her bubble and her reading of it ('interrupt').
 */
let closeSequenceHost: CloseBeatSequence | null = null;
const closeSequence = () => closeSequenceHost ??= new CloseBeatSequence({ setTimer: (run, ms) => { const timer = setTimeout(run, ms); timer.unref?.(); return timer; },
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  capped: kind => { if (kind) try { needs().appJournal.record({ type: 'close-beat-skipped', characterId: needs().companion?.mood.get().characterId ?? null, kind, block: 'waited' }); } catch { /* the journal never holds her words */ } },
  contact: on => { if (on) unbound?.bubbleHold.pause(); else unbound?.bubbleHold.resume(); },
  cut: () => { const shown = unbound?.bubbleHold.cut() ?? null; needs().cancelCompletedReply(undefined, 'interrupt'); return shown; } });
/** I-203: an interrupted kiss / hug of her reply: its facts for one immediate turn (the moments' path) or her next chat turn; made on first use. */
let closeCutHost: CloseCutNotice | null = null;
export const closeCutNotice = (): CloseCutNotice => closeCutHost ??= new CloseCutNotice({ language: () => speechBeatsFor(needs().store.directory).cardLanguage(), told: () => unboundHistory?.toldCut() });

/**
 * I-184: what her close moments read (her mood view and stage, you typing, a game) and write (the mood moment, her next turn's line). 2026-11-23:
 * a kiss / hug she wrote that did not walk up and an action you ended each write one journal row and one line for her next turn.
 */
function closeMomentWiring(): NonNullable<UnboundWiring['close']> {
  const mood = () => needs().companion?.mood, characterId = () => mood()?.get().characterId ?? null;
  return {
    view: () => mood()?.get() ?? null,
    typing: () => unboundTyping?.typingNow() ?? false, playing: () => gamesPorts?.playing() ?? false, // keystrokes now, not the box being open
    arms: armsNow, dropHand: () => gamesPorts?.dropHand?.(), // 2026-11-25: her hand reach yields to what she wrote
    pulling: () => unbound?.life?.pulledNow === true, // 2026-11-23: the 'pulled' gate was never wired
    moment: kind => mood()?.moments.note(kind) ?? false, happened: item => unboundHistory?.closeMoment(item),
    notes: {
      missed: (kind, block) => { unboundHistory?.closeMissed({ kind, block, at: Date.now() }); }, // its journal row: `outcome` (2026-11-25)
      outcome: fate => { needs().appJournal.record({ type: 'close-beat', characterId: characterId(), ...fate }); }, // 2026-11-25: one row per kiss / hug she wrote
      notReached: kind => { needs().appJournal.record({ type: 'close-beat-skipped', characterId: characterId(), kind, block: 'unreached' }); unboundHistory?.closeMissed({ kind, block: 'unreached', at: Date.now() }); },
      interrupted: (action, by) => { needs().appJournal.record({ type: 'action-interrupted', characterId: characterId(), action, by }); unboundHistory?.interrupted({ action, by, at: Date.now() }); },
    },
    sequence: closeSequence(),
  };
}

/**
 * Step 4: readers the senses' wiring hands in for her own life (they import this file; this file does not import theirs). Each is read
 * once a second while she is out, and only through shared/unbound/life/signals.ts. Memory only.
 */
export const lifeFeeds: { activityState: () => unknown; pose: () => unknown; screenActivity: () => unknown } = {
  activityState: () => 'unknown', pose: () => null, screenActivity: () => null,
};
/**
 * Batches D, F (docs/claude/2026-11-21-unbound-full-D.md): her facts from her full-screen page go where the companion window's go (the journal
 * wiring sets `fact`, the mood wiring `tier`); `poseOn` is camera pose sensing now (unbound-senses-wiring.ts keeps it). Read when used.
 */
export const senseFeeds: { fact: (kind: string, value: unknown) => boolean; tier: (value: unknown) => boolean; poseOn: boolean; held: boolean;
  /** 2026-11-24: what her body out here does to the sound (the mood wiring: StageStateHost.acceptOut), and the user's music settings (the senses' wiring). */
  stage: (value: unknown) => boolean; musicSettings: () => unknown } = {
  fact: () => false, tier: () => false, poseOn: false, held: false, stage: () => false, musicSettings: () => null,
};
/** 2026-11-24: her full-screen page's facts by kind: the tier and what her body does have their own paths, the rest go to the journal's. */
function routeSenseFact(kind: string, value: unknown): boolean {
  return kind === 'music-tier' ? senseFeeds.tier(value) : kind === 'stage-state' ? senseFeeds.stage(value) : senseFeeds.fact(kind, value);
}
let userTalkedAt: number | null = null;
/** Step 4: the voiceprint passed your voice with no name and no call (electron/senses/voiceprint/gate.ts): the fact only, never the words. */
export function noteUserTalked(at = Date.now()): void { userTalkedAt = at; }

/** Unbound's host: null until the ready chain ran startUnbound. */
export let unbound: UnboundHost | null = null;
/** 2026-11-24: her reading paused / went on because of where you are (the window's 'pose-use' fact): her full-screen bubble's clocks pause with it. */
export function unboundReadPause(value: unknown): void {
  try { applyReadPause(unbound?.bubbleHold, value); } catch { /* display only */ }
}
/** I-209 step 3: the stage coordinator (each character on stage her own full screen; made with the host); null until startUnbound. */
export function unboundStage(): CompanyStage | null { return stageOf(unbound); }
let replyOwnerPort: ((replyId: string) => string | null) | null = null;
/** I-209 step 3: brain-wiring connects which character a reply belongs to (its pending turn's owner), so her bubble goes to her window. */
export function connectUnboundReplyOwner(read: (replyId: string) => string | null): void { replyOwnerPort = read; }
/** Unbound v1 step 1 (electron/unbound/entry.ts): out with the permission page, or back; the recovery of a stay a dead run left. */
export let unboundEntry: UnboundEntryHandle | null = null;
/** The input box's 「打电话」 button (electron/unbound/input-call.ts): voice-wiring connects the call host to it and tells it every change of the call. */
let inputCallBridge: InputCallBridge | null = null;
/** The Unbound input box's 打电话 / 挂断 bridge, made on first use (wiring files keep no module-level side effects: tests/wiring-skeleton.test.ts). */
export function unboundInputCall(): InputCallBridge { return inputCallBridge ??= new InputCallBridge(); }
/** Unbound v1 step 2 (electron/unbound/typing.ts): typing to her (click, shortcut, input box). */
export let unboundTyping: UnboundTypingHandle | null = null;
/** I-159 C: the card beside her (electron/unbound/card-surface.ts); null until startUnbound. */
export let unboundCards: UnboundCardsHandle | null = null;
let cardChooser: ((request: { proposalId: string; choiceId: string }) => Promise<unknown>) | null = null;
let capabilityView: (() => Promise<unknown>) | null = null;
/** 2026-11-25: `armsOn` what holds her arms now (a game, an offer, her hand reach), `dropHand` her hand reach lets go (a kiss / hug of hers walks up). */
type GamesLink = UnboundGamesPorts & { playing(): boolean; surfaceChanged(): void; armsOn?(): { game: boolean; give: boolean; hand: boolean }; dropHand?(): void };
/** 2026-11-25: who holds her arms (closeArmsOf); without the detail, as `playing` says. */
const armsNow = (): CloseArms => { const on = gamesPorts?.armsOn?.(); return on ? closeArmsOf(on) : gamesPorts?.playing() ? 'game' : 'free'; };
let gamesPorts: GamesLink | null = null;
/** Batch B: the initiative wiring connects the game hosts' methods (猜拳, 递东西, 牵手) once it has made them; her games out here answer through them. */
export function connectUnboundGames(ports: GamesLink): void { gamesPorts = ports; }
/** 2026-11-25: she is coming up to the lens, kissing or hugging in full-screen now (a new hand reach of hers waits: electron/initiative/hands/host.ts closeOn). */
export function unboundCloseOn(): boolean { return unbound?.peek?.active === true; }
/** I-154 follow-up: stage-model-wiring connects the model check's read (getModelCapabilities) once it has made it; her full-screen face reads it. */
export function connectUnboundCapabilities(view: () => Promise<unknown>): void { capabilityView = view; }
let blushView: (() => Promise<unknown>) | null = null;
/** Batch A (docs/claude/2026-11-21-unbound-full-ACH.md): mood-wiring connects the blush calibration's read (getBlushCalibration); her full-screen blush reads it. */
export function connectUnboundBlush(view: () => Promise<unknown>): void { blushView = view; }
let motionPorts: UnboundMotionPorts | null = null;
/** Batch C: actions-wiring connects the companion stage's motion reads and her action answer; her full-screen window reads them (electron/unbound/motion-bridge.ts). */
export function connectUnboundMotions(ports: UnboundMotionPorts): void { motionPorts = ports; }
/** Batch C: she is out and shown in full-screen Unbound (her actions play there and only that window's answer counts). */
export function unboundShowsHer(): boolean { return motionsOut(unbound?.state); }
/** brain-wiring connects the host's own card path once it has made the chat cards (ChatSettingProposals.chooseMirrored). */
export function connectUnboundCardChooser(choose: (request: { proposalId: string; choiceId: string }) => Promise<unknown>): void { cardChooser = choose; }
/** Every card (and update) the owning window gets is also offered here; it shows only while she is out. */
export function offerUnboundCard(card: ChatSettingCardView): void { try { unboundCards?.offer(card); } catch { /* a courtesy copy */ } }
/** Somebody who follows Unbound's mode (normal / entering / unbound), e.g. the brain's spare chat process; returns the way to stop. */
let modeListeners: Set<(state: 'normal' | 'entering' | 'unbound') => void> | null = null;
export function onUnboundModeChanged(listener: (state: 'normal' | 'entering' | 'unbound') => void): () => void { (modeListeners ??= new Set()).add(listener); return () => { modeListeners?.delete(listener); }; }
let unboundNeeds: UnboundNeeds | null = null;

/** electron/main.ts calls this once, while it is evaluated. */
export function wireUnbound(needs: UnboundNeeds): void { unboundNeeds = needs; }
/** Overhaul step 7: Unbound has no PartHandle; this is what the part runner knows of it (one unit; its three handlers answer PART_OFF while it is off). */
export const UNBOUND_PART: PartDeclaration = { id: 'unbound', units: ['unbound'], ipc: { unbound: ['getUnbound', 'setUnbound', 'toggleUnbound', 'askUnboundAgain', 'getChannelGates', 'setChannelGates', 'relaySpeechFace'] } };
function needs(): UnboundNeeds {
  if (!unboundNeeds) throw new Error('Unbound is not wired.');
  return unboundNeeds;
}

/** Unbound v1 step 1: her companion window hidden only because she is out in Unbound still counts as on screen for her senses. */
export function petHeld(): boolean { return !!unbound && unbound.state !== 'normal'; }

/** The ready chain's Unbound step: her host, its three control-window handlers (outside the agent channel's recorder), entry, typing. */
let controlAwake: ControlAwake | null = null;
export function startUnbound(host: PartIpc['host']): void {
  startUnitSync('unbound', 'unbound', () => { // overhaul step 7: this unit's start, through the part runner
  registerChannelGates(host, needs().store.directory); // the switches for what stays off in stable (docs/claude/2026-11-19-stable-defaults.md)
  onChannelGatesChanged(() => { updateTray(); unbound?.refresh(); }); // the tray item and the control window's button follow the entry switch
  tapBroadcast(relayStageMusic); // I-209 step 4: the song's capture state and settings reach everyone on stage (the frames: relayDance)
  unbound = createUnboundHost({ page: needs().page, entryAllowed: unboundEntryAllowed,
    pet: () => needs().pet, petWanted: () => needs().store.current.pet.visible, developerMode: () => needs().developerMode(),
    source: () => needs().source(), reviewed: () => needs().reviewed(), restPose: () => needs().restPose(), // default stand without a pose layer (docs/claude/2026-11-15-unbound-own-model.md)
    restored: () => needs().sync(), lingerMs: text => unboundBubbleLingerMs(needs().companion.mood, text), publish: view => broadcast('desk:unbound', view), touch: report => unboundTyping?.click(report),
    pull: report => { reportTouch({ ...report, kind: 'pull', where: 'unbound', at: Date.now() }); }, // step 5c: only the pull's fields (shared/unbound/pull.ts), checked again by parseTouchEvent
    mood: { get: () => needs().companion.mood.get(), // I-154 follow-up: her full-screen face reads the same view; a touch's input goes to the same mood host (electron/unbound/mood-bridge.ts)
      interaction: value => { if (!needs().store.current.model) throw new Error('只有可交互的窗口可以提交直接互动。'); return needs().companion.mood.interaction(value as never); },
      card: () => { if (!capabilityView) throw new Error('模型体检尚未就绪。'); return capabilityView(); }, // her face follows your choices on the character page (read only)
      blush: () => { if (!blushView) throw new Error('红晕校准尚未就绪。'); return blushView(); }, // batch A: the blush where the calibration put it (read only)
      motions: () => motionPorts, // batch C: her chat gestures, actions and automatic body motions (each read only from the window she is shown in)
      senses: () => ({ poseSensing: () => senseFeeds.poseOn && !senseFeeds.held, fact: routeSenseFact, musicSettings: () => senseFeeds.musicSettings() }) }, // batches D, F
    games: () => gamesPorts ?? undefined, // batch B: her games' answers go to the game hosts' own methods (electron/unbound/games-bridge.ts)
    modeChanged: state => { awakeFollows(state); for (const listener of [...(modeListeners ?? [])]) { try { listener(state); } catch { /* a follower never blocks the mode change */ } } needs().republishPetVisibility(); updateTray(); unboundEntry?.modeChanged(state); unboundTyping?.modeChanged(state); unboundCards?.modeChanged(state); needs().cancelCompletedReply(undefined, 'switch'); needs().cancelProactiveVision(true); gamesPorts?.surfaceChanged(); }, // Unbound v1 step 1; read-aloud: a switch ends what is being read; batch B: a game on the window she left ends
    peek: needs().peek, life: { // step 4: her own life (electron/unbound/life.ts)
      activityState: () => lifeFeeds.activityState(), pose: () => lifeFeeds.pose(), activity: () => lifeFeeds.screenActivity(), talkedAt: () => userTalkedAt,
      sound: () => needs().listenKind.heardKind(), readingAloud: () => needs().replySpeechBusy() || needs().speechPlaybackActivity.busy,
      typing: () => unboundTyping?.boxOpen() ?? false, gazeMood: () => needs().peek.mood(), directory: () => needs().store.directory,
      noticed: cue => unboundHistory?.note(cue), happened: kind => unboundHistory?.note({ kind, band: 'sure' }), // afternoon addition C
      playing: () => gamesPorts?.playing() ?? false, // batch B: a game, an offer or her reach: her own life gives way
      journal: row => { try { needs().appJournal.record({ ...row, characterId: needs().companion?.mood.get().characterId ?? null }); } catch { /* the journal never holds her walk */ } } }, // I-193: a row per go-word and per walk that ended
    close: closeMomentWiring(), // I-184: her kisses and hugs (electron/unbound/close-moments.ts)
    company: companyPorts(() => ({ cards: characterCards ?? null, models: bundledAssets && assetRegistry ? { bundledModel: () => bundledAssets.getModel(), register: file => assetRegistry!.register(file) } : null }), ids => needs().companion?.stage(ids), () => gateEnabled('threeOnStage'), cards => cardDisplayNames(cards, currentUiLanguage())), // I-219: the panel shows a language tag when the cards mix languages; I-209 step 1: the others on stage; step 2: each gets her own turn context
    stage: stageCharacters(() => needs(), closeSequence, { typing: () => unboundTyping?.typingNow() ?? false, pulled: id => unboundStage()?.hostOf(id)?.life?.pulledNow === true, relay: (id, channel, value) => unboundStage()?.relay(id, channel, value), musicSettings: () => senseFeeds.musicSettings() }),
    replyOwner: id => replyOwnerPort?.(id) ?? null }); // step 3: each her own full screen (unbound-stage-wiring.ts; her live mood relayed to her page)
  unboundHistory = createHistory();
  const situation = beatSituation(); situation.refresh(); speechBeatsFor(needs().store.directory).situate(() => situation.now()); // I-185: her turn's line of marker words she cannot use now (arms, sleep, a call, the model)
  speechBeatsFor(needs().store.directory).sequence(closeSequence()); // 2026-11-23 / I-203: her words wait only at the frames she placed
  speechBeatsFor(needs().store.directory).heardCut((event, cut, text, owner) => closeCutNotice().cut(event, cut, text, owner)); // I-203: an interrupted kiss / hug: her one immediate turn's facts
  host('getUnbound', () => unbound!.view()); host('setUnbound', patch => unbound!.apply(patch)); host('toggleUnbound', () => unboundEntry?.toggle() ?? 'busy'); host('askUnboundAgain', () => unboundEntry?.askAgain() ?? false); // I-159 D
  // I-165: her full-screen bubble shows a read-aloud reply as her voice reaches it (electron/unbound/bubble-hold.ts); read when used.
  unbound.bubbleHold.connect({ follows: id => needs().store.current.voice.enabled && needs().completedReplySpeech.follows(id), segmentEnd: (id, index) => needs().completedReplySpeech.segmentEnd(id, index) });
  host('relaySpeechFace', cue => { if (!unboundStage()?.speechFace(cue)) unbound?.mood(SPEECH_FACE_RELAY, cue); }, false); // batch A: her voice's facts for her full-screen face (checked and sent only to her window; electron/unbound/mood-bridge.ts); 2026-11-25: on stage, to the speaker's window, and her line takes the floor (company/stage.ts speechFace)
  unboundCards = createUnboundCards({ page: needs().page, host: () => unbound, choose: () => cardChooser }); // I-159 C: the card beside her (electron/unbound/card-wiring.ts)
  unboundEntry = createUnboundEntry({ allowed: unboundEntryAllowed, said: text => unbound?.notice(text), profileDirectory: needs().store.directory, state: () => unbound?.state ?? 'normal', enter: () => unbound?.enter(), exit: () => unbound?.exit(), switches: () => offAsNotUsers(needs().perceptionSwitches, 'unbound-exit'), kept: items => { if (items.includes('screen')) needs().appJournal.record({ type: 'watch-change', characterId: needs().companion?.mood.get().characterId ?? null, event: 'kept-after-unbound' }); }, face: () => needs().face(), // Unbound v1 step 1 (electron/unbound/entry.ts)
    replyRunning: () => needs().replyRunning(), parent: () => needs().controls, translate: t, error: () => unbound?.view().error ?? null });
  controlAwake = createControlAwake(() => needs().controls); const awakeFollows = followUnboundMode(controlAwake); // 2026-11-23: not throttled while she is out (electron/unbound/control-awake.ts)
  const sayAcks = new UnboundSayAcks({ now: () => Date.now(), setTimer: (run, ms) => setTimeout(run, ms), clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), // 2026-11-22: whether a line really went out (electron/unbound/say-ack.ts)
    journal: fact => { needs().appJournal.record({ type: 'send-dropped', characterId: needs().companion?.mood.get().characterId ?? null, from: 'unbound', ...fact }); },
    awake: lineAwake(controlAwake), addressee: () => unboundStage()?.addresseeId() ?? null }); // I-209 step 3: voice input goes to the one you clicked last // 2026-11-23: the hidden control window is not throttled while a line is on its way
  setHandedLineGate(sayAcks); // 2026-11-23: the chat handler sends a numbered line only while it is still open here (one truth, never twice)
  host('ackUnboundSay', ack => { sayAcks.ack(ack); }); // the control window's word on a line (controls only)
  unboundTyping = createUnboundTyping({ page: needs().page, host: () => unboundStage()?.addressedHost() ?? unbound, main: () => unbound, to: () => unboundStage()?.addresseeName() ?? null, call: unboundInputCall(), acks: sayAcks, // I-209 step 3: the box beside the one you clicked // Unbound v1 step 2 (electron/unbound/typing.ts)
    screen: { menu: () => screenSourceChoice().menu(), choose: id => screenSourceChoice().choose(id), subscribe: onScreenSourceChanged }, // I-190
    placeJournal: row => { needs().appJournal.record({ ...row, characterId: unboundStage()?.addresseeId() ?? needs().companion?.mood.get().characterId ?? null }); }, // 2026-11-24: the panel's 设为默认位置 click
    watch: inputWatchTogether({ screen: () => needs().perceptionSwitches?.read().screen === true, view: () => audioReading?.getView() ?? null, screenHeld: () => unbound?.state === 'unbound', // I-190: 一起看 in the box's panel
      setScreen: on => switchesNow().set('screen', on, [], () => {}), setDialogue: on => switchesNow().set('system_audio', on, ['movie'], () => {}) }),
    say: (text, tag) => { if (tag) sayAcks.own(tag.line, unboundStage()?.addresseeId() ?? null); return sayLine({ chatAvailable: () => needs().chatAvailable(), controlsAlive: () => { const controls = needs().controls; return !!controls && !controls.isDestroyed(); }, // I-209 step 3: her line is her turn; I-177: a send while she answers stops her reply and goes out (electron/unbound/say-line.ts)
      interruptReply: () => unbound?.bubbleHold.interrupt() ?? null, send: line => needs().controls?.webContents.send('desk:unbound-say', line) }, text, tag); } }); // the control window's own chat box path (src/wiring/control-window-wiring.ts)
  });
}

/** Sync step (Unbound): her second stage follows the settings (wireSettingsSync in electron/main.ts gives the order). */
export function syncUnbound(): void {
  unbound?.refresh();
}

/** Before quit: the entry's stay ends (its recovery file goes), the host and the typing close, in this order. */
export function releaseUnbound(): void {
  void unboundEntry?.quit(); unbound?.quit(); unboundTyping?.quit(); unboundCards?.quit(); controlAwake?.releaseAll();
}
