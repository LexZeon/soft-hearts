/**
 * I-154 follow-up, first slice (docs/claude/2026-11-20-unbound-full-shares.md): what the full-screen Unbound page (src/unbound/main.ts) wires
 * of the shared set, in one place so main.ts gains only a few lines: her face (out-face.ts), the touch input on her own body (out-touch.ts),
 * her head region through the world camera (head-region.ts), and the page's cues for her face (a line you sent: she thinks; her reply's
 * first words: she stops thinking, and the bubble's text gives the speaking accents their timing, as the companion's does with reading
 * aloud off).
 */
import type { AnimationClip, Bone, Object3D, PerspectiveCamera } from 'three';
import { loadLivelinessForEngine, probeHeadContact, type BlushAnchors } from '../../stage';
import type { UnboundFigure } from '../figure';
import type { IdleBody } from '../motion/unbound-idle';
import type { StandardBody } from '../model/standard-body';
import { standardHeadContact } from '../model/standard-contact';
import type { WindowModelMeasure } from '../window-mode/window-model';
import { defaultPoseChecks, eyeBones } from '../window-mode/window-model';
import { isRestPose } from '../rest-pose';
import { SpeechOwner } from './speech-owner';
import { ShownSentence, closedMouthMayStart } from '../../../shared/behaviors/part-mix/closed-mouth';
import { speechBeatGatesOf, type SpeechBeatGates } from '../speech-beat-player';
import { pinchCheeks } from '../window-mode/window-blush';
import { headRegion, type HeadContact } from './head-region';
import { HerOutFace, type HerFaceEnv, type HerFaceOut } from './out-face';
import { HerOutTouch, type HerMoodApi } from './out-touch';
import { dropZoneOf } from './drop-zone';
import { HerOutMotions, type HerMotionApi } from './out-motions';
import { cardOf, heldUpdate, holdView, type CardProfile, type HeldRecord } from './model-card';
import { fullTouchable, type TouchHeadRegion } from '../../mood';
import type { BlushCalibrationView } from '../../../shared/mood';
import { pullGatesOf, pullRefusal, type PullGroup } from '../../../shared/stage';
import type { CollisionProxy } from '../../../shared/actions';
import type { HeadSpot } from '../../../shared/unbound/typing';
import type { UnboundBubble } from '../../../shared/unbound/scene';
import type { UnboundGamesApi } from '../../../electron/unbound/games-preload-api';
import { HerOutGames, withOutGames } from './out-games';
import { HerOutPlay } from './out-play';
import { HerOutSleep, sleepInput } from './out-sleep';
import { withReaction, withSleep } from '../window-mode/window-liveliness';
import { WindowReactions } from '../window-mode/window-reactions';
import { HerOutSenses, type HerSenseApi } from './out-senses';
import type { MoodView } from '../../../shared/mood';

/**
 * The page's requests this set uses (electron/unbound/preload-api.ts): her mood, the model's capability record (read only); batch A: the blush
 * calibration (read only) and her voice's facts for her speaking face.
 */
export type HerOutApi = HerMoodApi & { getModelCard?(): Promise<unknown>; onModelCard?(callback: (update: unknown) => void): () => void;
  getBlushCalibration?(): Promise<BlushCalibrationView>; onBlushCalibration?(callback: (view: BlushCalibrationView) => void): () => void;
  onSpeechFace?(callback: (cue: unknown) => void): () => void } & HerMotionApi & Partial<UnboundGamesApi> & HerSenseApi;

export interface HerOutPorts {
  camera: PerspectiveCamera;
  /** CSS px for `units` model units `aheadUnits` in front of the eye (camera.ts pixelsPerUnit on this window). */
  pixels(units: number, aheadUnits: number): number;
  /** The page's own rule for a click on her (shown, not forced click-through by a peek, the page visible). */
  canTouch(): boolean;
  /** Signed distance (CSS px) from a point to her silhouette (≤ 0 on her): a dragged picture counts only at her body (drop-zone.ts). Absent: anywhere. */
  bodyDistance?(x: number, y: number): number;
  notice?(message: string): void;
  /** Batch B: the world scene (the offer's props), her reply bubble (her game lines) and her head on this window (the buttons beside it). */
  scene?: Object3D;
  bubble?: { readonly shown: boolean; receive(bubble: UnboundBubble): void };
  head?(): HeadSpot | null;
  /** Batch G: her place in the scene (she walks back to it once she is up from sleeping), or null before it is known. */
  home?(): { xM: number; depthM: number } | null;
  /** Batches D, F: the page's monotonic clock (ms; default performance.now): a music source silent 250 ms on it is off. Tests pass their frame clock. */
  now?(): number;
}
/** A frame's environment: her face's, a pull, and the cursor on this window (CSS px; null outside it) for her reach toward your hand. */
export type HerOutEnv = Omit<HerFaceEnv, 'nowMs'> & { pulled?: boolean; pointer?: { x: number; y: number } | null;
  /** Batch G: the scene's breath setting (her sleep makes it lighter); absent: her breath is left as the page set it. */
  breath?: number };

/** The page's rule for touching her (the same as for a click): the companion window's rule (I-174 item 7: src/mood/touchable.ts) on this page's names. */
export const herTouchable = fullTouchable;

/** How long a thinking look waits for her reply's first words at most (ms): a reply that never comes does not hold it. */
export const THINKING_MAX_MS = 60_000;
/**
 * Batch A: after a fact from her voice, for this long (ms) the bubble's text no longer times the speaking accents (the companion's rule: the
 * bubble's cue only with reading aloud off). Her voice reads the bubble's text a little after it shows, so the first piece may still get one.
 */
export const VOICE_HOLDS_MS = 20_000;
/** Batch A: the bubble's text times the accents only while her voice has not spoken lately. */
export const bubbleTimesAccents = (lastVoiceAt: number, now: number): boolean => !(now - lastVoiceAt < VOICE_HOLDS_MS);
/** Batch A: a calibration update for the model shown is used as it is; one for another model (or the first) is read again (the window's rule). */
export const sameCalibrationModel = (last: BlushCalibrationView | null, next: BlushCalibrationView): boolean => !!last && next.modelKey === last.modelKey;

export class HerOut {
  readonly face: HerOutFace;
  readonly touch: HerOutTouch | null;
  /** Batch C: her chat gestures, her actions and the automatic body motions (out-motions.ts; the window's players, one writer at the mixer). */
  readonly motions: HerOutMotions;
  /** Batch B: 猜拳, 递东西, 牵手 (out-games.ts), and the companion window's overlays on this page (out-play.ts; null without the game requests). */
  readonly games: HerOutGames;
  readonly play: HerOutPlay | null;
  private proxy: CollisionProxy | null = null;
  /** Batch G: her sleep out here (out-sleep.ts: the window's doze and sleep body, at world scale where she stands). */
  readonly sleep: HerOutSleep;
  /** Batches D, F: her reactions to your pose, the 惊喜 / 害羞 show, music (out-senses.ts; the window's layers); her look at you is her face's (out-gaze.ts). */
  readonly senses: HerOutSenses;
  private view: MoodView | null = null;
  /** Her own life gives way now (main.ts: the life player eases what she does): a game starts, the sleep body takes her. */
  yieldLife: (() => void) | null = null;
  private figure: UnboundFigure | null = null;
  private head: { contact: HeadContact | null; contactHead: Bone | null; height: number; fallback: BlushAnchors | null; reviewed: boolean } | null = null;
  private said = 0;
  private thinkingSince = -Infinity;
  /** I-170: her reply moved since the last frame (its words arriving, done or failed): a talk signal for one frame (the linger is the layers'). */
  private replied = false;
  private shownKey = '';
  /** The capability card's inputs for the model shown (model-card.ts): this load's profile and the host's record. */
  private profile: CardProfile | null = null;
  private held: HeldRecord | null = null;
  private cardRead = 0;
  /** Batch A: the blush calibration view for the model shown, the read it came from, and when her voice last told her face anything. */
  private calibration: BlushCalibrationView | null = null;
  private calibrationRead = 0;
  private url = '';
  private voiceAt = -Infinity;

  constructor(surface: HTMLElement, private readonly api: HerOutApi | null, private readonly ports: HerOutPorts, random: () => number = Math.random) {
    this.face = new HerOutFace(random);
    // Batches D, F: the dance writes at the mixer level under her clips; the dance starting hands an automatic body motion back (as the window).
    this.senses = new HerOutSenses(api, recipe => WindowReactions.support(recipe, this.face.showCapabilities(), this.face.procLife.on, ''), this.face.face,
      () => this.motions.motions.gatesChanged(true, false), ports.now ? () => ports.now!() : undefined);
    this.motions = new HerOutMotions(api, Date.now, [this.senses.music]);
    this.motions.motions.mouth.talkingFace = (name, holdS) => this.face.face.show(name, { holdS, onset: 'quick' }, !!this.figure).ok; // I-175: a pout while she speaks
    this.face.camera = ports.camera; // batch D: the viewer's eye is where you are (refined by where pose says you sit)
    this.face.gazeFact = event => { void api?.herFact?.('gaze', event).catch(() => {}); }; // the host journals it once
    api?.onUserGaze?.(reading => this.face.gaze.set(reading)); // only while camera pose sensing runs; null: forget at once
    this.games = new HerOutGames(ports.scene ?? null, () => ({ camera: ports.camera, width: innerWidth, height: innerHeight }));
    this.games.onStart = () => this.yieldLife?.();
    this.sleep = new HerOutSleep(random);
    const gamesApi = api && typeof api.rpsGet === 'function' ? api as UnboundGamesApi : null;
    this.play = gamesApi && ports.bubble ? new HerOutPlay(surface, { api: gamesApi, games: this.games, bubble: ports.bubble, blocked: () => !ports.canTouch() || !this.figure,
      head: () => ports.head?.() ?? null }) : null;
    // Batch H: her procedural life's code, on demand (as the window loads it); until it comes she is as before.
    void loadLivelinessForEngine().then(lib => { this.face.loadLife(lib); this.sleep.load(lib); }, () => { /* she stays without it */ }); // batch G: her sleep body too
    this.touch = api ? new HerOutTouch(surface, api, { region: () => this.region(), canTouch: () => ports.canTouch() && !!this.figure,
      view: view => { this.view = view ?? null; if (view) this.face.setMood(view); else this.face.invalidate(); this.motions.setMood(view ?? null); }, 
      contact: feedback => { if (feedback?.contact || feedback?.feeding) this.play?.interrupt(); this.face.setContact(feedback); }, // a pat or a snack: what she holds out goes back
      notice: message => ports.notice?.(message), blocks: (x, y) => this.play?.covers(x, y) === true, dropZone: dropZoneOf(ports.bodyDistance) }) : null;
    this.touch?.start();
    // Your choice on the character page (or a finished check) for the model shown: her face follows it at once.
    api?.onModelCard?.(update => { const next = heldUpdate(this.held, update); if (next) { this.held = next; this.face.setCard(cardOf(next, this.profile)); } });
    // Batch A: the calibration slider on the character page moves her full-screen blush too; her voice's facts time her speaking face.
    api?.onBlushCalibration?.(view => { if (this.figure && view && sameCalibrationModel(this.calibration, view)) this.useCalibration(view); else void this.readCalibration(); });
    api?.onSpeechFace?.(cue => this.speechFace(cue));
  }

  /**
   * Her new figure, still at rest (main.ts calls this before her first frame): her face on its slots and painted blush, and her scalp
   * measured for the touch input. `measure` was taken before the figure was made (window-model.ts measureWindowModel).
   */
  attach(figure: UnboundFigure, measure: WindowModelMeasure, scene: { reviewed: boolean; url: string }, standard: StandardBody | null): void {
    this.figure = figure;
    this.face.attach({ body: figure, mesh: figure.mesh, profile: measure.profile, painter: measure.painter, reviewed: scene.reviewed && !standard, standard: !!standard, url: scene.url, vrm: standard });
    let contact: HeadContact | null = null, contactHead: Bone | null = figure.head, height = measure.bounds.height;
    if (standard) {
      figure.frame(0); standard.present(); // her arms come down first: the scalp is measured standing (as the window does)
      height = standard.measureShown().height;
      ({ contact, head: contactHead } = standardHeadContact(standard, height));
    } else if (figure.head) contact = probeHeadContact(figure.mesh, figure.head, eyeBones(figure.mesh), height);
    this.head = { contact, contactHead, height, fallback: measure.profile?.cheekAnchors ?? null, reviewed: scene.reviewed && !standard };
    this.profile = measure.profile; this.held = null;
    this.games.attach(figure.mesh); this.proxy = measure.profile?.profile?.collision ?? null;
    this.sleep.attach(figure, measure, standard);
    this.senses.attach(figure);
    this.url = scene.url; this.calibration = null;
    void this.readCard(); void this.readCalibration();
    this.motions.attach({ figure, mesh: figure.mesh, reviewed: scene.reviewed, retarget: measure.retarget, transform: measure.transform, profile: measure.profile, standard });
  }
  /** Batch A: the host's calibration for the model shown, then her blush measured with it (until it comes: the default place, as the window). */
  private async readCalibration(): Promise<void> {
    const read = ++this.calibrationRead, url = this.url;
    if (!this.figure || !this.api?.getBlushCalibration) return;
    let view: BlushCalibrationView | null = null;
    try { view = await this.api.getBlushCalibration(); } catch { view = null; }
    if (read !== this.calibrationRead || url !== this.url || !this.figure || !view?.calibration) return;
    this.useCalibration(view);
  }
  private useCalibration(view: BlushCalibrationView): void { this.calibration = view; this.face.setBlushCalibration(view.calibration, this.url); }
  /** The host's record for this model, then the card derived from it (until it comes: the card derived from the profile alone, as the window). */
  private async readCard(): Promise<void> {
    const read = ++this.cardRead, profile = this.profile;
    if (!profile || !this.api?.getModelCard) return;
    let view: unknown = null;
    try { view = await this.api.getModelCard(); } catch { view = null; }
    if (read !== this.cardRead || profile !== this.profile) return;
    this.held = holdView(view, profile);
    if (this.held) this.face.setCard(cardOf(this.held, profile));
  }
  detach(): void { this.games.attach(null); this.sleep.attach(null); this.senses.attach(null); this.face.gaze.forget(); this.proxy = null; this.figure = null; this.head = null; this.profile = null; this.held = null; this.cardRead++; this.calibration = null; this.calibrationRead++; this.motions.attach(null); this.face.attach(null); this.touch?.reset('model'); }
  /**
   * The companion's motion layers: her face's blocks, and what they hold for her own motions. `picked`: the picked pose's URL (null: none, her
   * default stand); whether it counts as rest is the window's rule too (I-174 item 4: ../rest-pose.ts isRestPose; a reviewed stand.vmd is rest).
   */
  setClips(clips: { pose: AnimationClip | null; gesture: AnimationClip | null; expression: AnimationClip | null }, legacy: boolean, picked: string | null = null): void {
    const face = this.face.setClips(clips, legacy), asked = ++this.clipsAsked;
    void isRestPose({ picked, injected: false }, this.reviewedPose).then(rest => { if (asked === this.clipsAsked) this.motions.setClips(clips, rest, face); });
  }
  private clipsAsked = 0;
  private readonly reviewedPose = defaultPoseChecks();

  /** Her head region on this window (CSS px), for the touch input. */
  region(): TouchHeadRegion | null {
    const figure = this.figure, head = this.head;
    if (!figure?.head || !head) return null;
    const camera = this.ports.camera;
    // The cheeks as the window takes them (window-blush.ts pinchCheeks), with the calibration for this model (batch A).
    const cheeks = pinchCheeks(this.face.blush.painter?.cheeks ?? null, head.fallback, head.reviewed, this.face.blush.calibrationFor(this.url));
    return headRegion({ head: figure.head, contact: head.contact, contactHead: head.contactHead, cheeks },
      { camera, width: innerWidth, height: innerHeight, boundsHeight: head.height,
        radiusPx: (units, point) => { const ahead = camera.position.z - point.z; return ahead > 1e-3 ? this.ports.pixels(units, ahead) : 0; } });
  }
  /** A pinch on her cheek owns this press (the page's click report and pull leave it alone). */
  get pinching(): boolean { return this.touch?.pinching === true; }
  /**
   * A press on her: the page's own click report and pull get it (`press`) unless the touch input took it as a pinch (its pointerdown came
   * first) or it is on one of the game controls (`target`: the press's own element).
   */
  pagePress(press: () => void, target: EventTarget | null = null): void { if (!this.pinching && !this.play?.owns(target)) press(); }
  /** A press on this part of her is not a pull now: her hand and arm while she holds your hand (the shared gate, as on the window). */
  /** A press on her is not a pull: asleep (refused up front, as in the window: I-174 item 6), or her hand is held. The host refuses asleep again. */
  pullRefused(group: PullGroup): boolean { return pullRefusal(pullGatesOf(this.view, this.games.handBusy), group) !== null; }
  /** 边说边演: may a beat start now (the window's rule, I-174 item 5): asleep, or a hand word while the game, an offer or her reach holds her arms. */
  beatGates(): SpeechBeatGates { return { ...speechBeatGatesOf(this.view, !!this.figure, this.games.games.armsHeld(false)), armsCan: this.armsCan() }; }
  /** A game, an offer or her reach is on (the page draws at the full rate; her own life stays out). */
  get busy(): boolean { return this.games.busy; }

  /** I-174 item 8: the held "she is speaking" her motion gates read, the window's own (speech-owner.ts). */
  private readonly speechOwner = new SpeechOwner();
  /** I-175: read-aloud off, her bubble in the middle of a sentence (shown); a new or failed reply drops her waiting mouth shapes (main.ts beats). */
  private readonly shownSentence = new ShownSentence();
  /** The held "she is speaking" as of her last frame (I-184's mouth gate reads it). */
  private speakingHeld = false;
  /** I-184: may her close moment's pucker start now (I-175's one rule: never while she speaks, never mid-sentence, nothing else on her mouth). */
  closeMouth(): { mayStart: boolean; speaking: boolean } {
    const world = { held: this.speakingHeld, sentenceOpen: this.shownSentence.open(Date.now() / 1000), free: !this.pinching };
    return { mayStart: closedMouthMayStart(world), speaking: world.held };
  }
  /** I-184: no game, offer or reach for your hand holds her arms (a hug never fights them). */
  armsFree(): boolean { return !this.games.games.armsHeld(false); }
  /** I-192 follow-up (Codex T-261): the engine can move her arms on this model (no figure yet: not known, taken as yes). */
  armsCan(): boolean { return this.figure?.armsCan ?? true; }
  /** Her side of the close moments' hooks (src/unbound/director/close-moment.ts CloseMomentHooks), for main.ts. */
  closeHooks(): { mouth(): { mayStart: boolean; speaking: boolean }; armsFree(): boolean; armsCan(): boolean } {
    return { mouth: () => this.closeMouth(), armsFree: () => this.armsFree(), armsCan: () => this.armsCan() };
  }
  dropWaitingMouth(): void { this.motions.motions.dropWaitingMouth(); }
  /** The owners' wrapper (out-face.ts wrap). */
  wrap(inner: IdleBody): IdleBody { return this.face.wrap(inner); }
  frame(delta: number, inner: IdleBody, env: HerOutEnv): HerFaceOut {
    if (this.thinkingSince > -Infinity && performance.now() - this.thinkingSince > THINKING_MAX_MS) this.endThinking();
    // Batch C: what holds her now, for her own motions (before her body's frame: they play inside it).
    const card = this.face.face.capabilities();
    this.motions.frame({ shown: env.shown && !!this.figure, adjusting: env.adjusting, pulled: env.pulled === true, walking: env.walking, contact: this.face.contact,
      speaking: this.speakingHeld = this.speechOwner.speaking(this.speechOwner.frame(delta, env.speaking || env.voiced)), preparing: false, thinking: this.face.face.thinkingActive, lidsHeld: this.face.lids, blink: this.face.naturalBlink,
      mouthOff: card?.mouth?.choice === 'off', eyesOff: card?.closeEyes?.choice === 'off',
      showing: this.senses.reactions.showing, reacting: this.senses.reactions.reacting, music: this.senses.music.moving, // batches D, F: declared owners of the window's gates
      sentenceOpen: this.shownSentence.open(Date.now() / 1000) }); // I-175: read-aloud off, mid-sentence: a closed-mouth shape waits
    // Batch B: the games' clocks first, their arms and lean then ride on her face's goals (the reach eases them in and out).
    const p = env.pointer, pointer = p ? { x: p.x / Math.max(1, innerWidth) * 2 - 1, y: 1 - p.y / Math.max(1, innerHeight) * 2 } : null; // -1..1, y up
    const games = this.figure ? this.games.frame(delta, { pointer, proxy: this.proxy }) : null;
    const motionEnv = this.motions.env();
    // Batch G: her sleep (the doze as goals, the sleep body as the figure's overlay, planned where she stands); its breath, its hold on her place.
    const figure = this.figure, sleep = figure ? this.sleep.frame(delta, sleepInput(this.face, this.view, { adjusting: env.adjusting, playing: this.games.busy,
      gameHead: games?.head === true, walking: env.walking, speaking: env.speaking || env.voiced, thinking: this.thinkingSince > -Infinity },
      { camera: this.ports.camera, width: innerWidth, height: innerHeight, scene: this.ports.scene ?? null })) : null;
    // Batches D, F: the music, then her reactions over the games' face (the window's order), the show and the nod for her procedural life.
    const senses = this.senses.frame(delta, { env: motionEnv, view: this.view, walking: env.walking, base: games?.activity ?? null, game: this.games.games.rpsActive,
      proxy: this.proxy, yawn: this.motions.motions.yawnCue, sleepCue: (base, nowMs) => this.sleep.sleep.poseCueView(base, nowMs), gates: this.motions.motions.lifeGates(motionEnv),
      fullBody: !env.adjusting, cover: cue => { void this.motions.motions.playHerAction({ ...cue, action: 'cover-yawn' }); } });
    Object.assign(this.face, { activity: senses.activity, show: senses.show, showBlocked: senses.showBlocked, beat: senses.beat, dancing: senses.dancing });
    figure?.setOverlay(withReaction(sleep?.overlay ?? null, senses.overlay));
    if (figure && sleep && typeof env.breath === 'number') figure.setBreath(env.breath * sleep.breath);
    const talking = this.replied || this.thinkingSince > -Infinity; this.replied = false; // I-170
    const out = this.face.frame(delta, inner, { ...env, nowMs: Date.now(), talking }, (face, owner) => withOutGames(sleep ? withSleep(face, sleep) : face, games, owner));
    if (this.sleep.holdPlace(sleep?.performing === true, this.ports.home?.() ?? null)) this.yieldLife?.(); // she does not walk while she is down
    this.murmurs();
    return this.games.busy && !out.performing ? { ...out, performing: true } : out; // her learned idle steps aside while she plays
  }
  /** 梦话: a silent "zzz…" in her bubble now and then while she sleeps (bubble only; not over a reply on screen). */
  private murmurs(): void {
    for (const murmur of this.sleep.sleep.takeMurmurs()) {
      const bubble = this.ports.bubble;
      if (!bubble || bubble.shown) continue;
      const id = `sleep-murmur:${murmur.id}`;
      bubble.receive({ id, type: 'delta', text: murmur.text }); bubble.receive({ id, type: 'done', text: '' });
    }
  }
  /** Her place is held while she is down (the page hands her no new place then). */
  get holdsPlace(): boolean { return this.sleep.holdsPlace; }
  /** After her frame: the offer's prop in her hand, the target on her hand, the buttons beside her head. */
  after(width: number, height: number): void { if (!this.figure) return; this.games.after(); this.play?.place(width, height); }

  // ---- the page's cues ---------------------------------------------------------------------------------------------------------
  /** You sent a line: she waits for her reply with her thinking look (until its first words). */
  userSaid(): void { this.face.setThinking(`said-${++this.said}`); this.thinkingSince = performance.now(); }
  /** Her reply started (its first words), finished or failed: the thinking look eases back. */
  replyMoved(): void { this.endThinking(); this.replied = true; }
  /** The bubble's text on screen: the speaking accents time themselves by it (the companion's "shown" cue with reading aloud off). */
  shown(state: { id: string; rev: number; text: string; visible: boolean } | null, voiced: boolean): void {
    if (state?.visible && !voiced) this.shownSentence.note(state.text, Date.now() / 1000); // I-175: is a sentence still being shown
    if (!state?.visible || !state.text.trim() || !bubbleTimesAccents(this.voiceAt, performance.now())) return;
    const key = `${state.id}:${state.rev}`;
    if (key === this.shownKey) return;
    this.shownKey = key;
    this.face.speechCue({ kind: 'start', key: `${state.id.slice(0, 160)}#shown`, text: state.text, voiced });
  }
  /** Batch A: a fact from her voice (a heard segment starts, its loudness, a stop): her speaking face follows it, as the companion's does. */
  speechFace(cue: unknown): void { this.voiceAt = performance.now(); this.face.speechCue(cue); }
  private endThinking(): void { if (this.thinkingSince === -Infinity) return; this.thinkingSince = -Infinity; this.face.setThinking(null); }

  /** After her body's frame and her mouth: a face shape of hers (她的动作) over every other face writer. */
  afterBody(delta: number): void { this.motions.afterBody(delta); }
  /** Something of her own motions is moving (the page draws at the full rate). */
  get moving(): boolean { return this.motions.moving || this.senses.moving; }
  dispose(): void { this.senses.dispose(); this.touch?.dispose(); this.play?.dispose(); this.games.dispose(); this.motions.dispose(); this.face.attach(null); }
}

