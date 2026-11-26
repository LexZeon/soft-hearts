/**
 * Unbound U1, the host side (docs/claude/2026-11-12-unbound-u1-part1.md): enters and leaves Unbound, owns the Unbound window,
 * answers its four requests, keeps her world's numbers (screen size, viewer distance, where she stands), forwards her reply text
 * to a small bubble. A full-screen program in front is only information for her: she stays where she is, drawn, above it (I-199).
 *
 * Unbound v1 step 1 (docs/claude/2026-11-15-unbound-v1-step1-entry.md): entering and leaving are no longer developer-mode only
 * (tray, control window, Ctrl+Alt+U go through electron/unbound/entry.ts and its permission page); the knobs and 「让她凑过来」
 * stay developer-only.
 *
 * Everything outside is a port, so tests drive it with fakes and electron/main.ts only wires it (electron-host.ts makes the real
 * ports). The shared brain is untouched: chat, mood, memory and voice keep running in the main process and the control window;
 * this only shows her somewhere else.
 *
 * The Unbound window's requests are answered only when they come from that window's own top frame.
 */
import type { FullscreenProbe, FullscreenReading } from './fullscreen-watch';
import { UnboundMode, type PetPort, type UnboundWindowPort } from './mode';
import {
  UNBOUND_BODY_DEFAULTS, UNBOUND_EVENTS, UNBOUND_REQUESTS, parseUnboundControlPatch, parseUnboundReady, parseUnboundStats,
  type UnboundBody, type UnboundBubble, type UnboundControlPatch, type UnboundControlView, type UnboundInteractiveAck, type UnboundScene,
  type UnboundState, type UnboundStats, type UnboundWorld,
} from '../../shared/unbound/scene';
import {
  DEFAULT_VIEWER_DISTANCE_M, clampViewerDistance, eyeHeightFor, resolvePhysicalScreen, type DisplayFacts, type MonitorMeasurement, type PhysicalScreen, type Rect,
} from '../../shared/unbound/world';
import { withRestPose, type UnboundSource } from './source';
import { PeekDirectorHost, type PeekPorts } from './peek';
import { parseUnboundAnchor, parseUnboundTouch, type HeadSpot, type UnboundTouchReport } from '../../shared/unbound/typing';
import { UnboundPullAnswer } from './pull-answer'; // step 5c's answers (moved out 2026-11-24)
import { CompanyHost } from './company/host';
import { parseSenses, sameSenses, type UnboundSenses } from '../../shared/unbound/senses';
import { UnboundBubbleProof, retractedLineId } from './read-aloud';
import { UnboundBubbleHold } from './bubble-hold';
import { lingerField } from './bubble-linger';
import { holdLineIn } from './hold-line';
import { voiceReplyBubbleEvent } from './voice-bubble';
import { formatVisionPresentation, type VisionInitiative } from '../../shared/senses';
import { LifeHost, type LifePorts } from './life';
import { PlaceKeeper } from './place-keeper';
import { HerPlace } from './her-place'; // I-212: where she stands, in screen terms
import { startEntryWait } from '../../shared/unbound/entry-wait';
import { sanitizeFillerShape } from '../../shared/voice'; // 2026-11-20: her short sounds in a call move her mouth
import { UnboundMoodBridge, type UnboundMoodPorts } from './mood-bridge';
import { UnboundGamesBridge, type UnboundGamesPorts } from './games-bridge'; // batch B: her games out here

import { withTimeout, type UnboundHostPorts, type UnboundIpcEvent, type UnboundSpeechTarget, type UnboundWindowLike } from './host-ports';
import { herHere, windowPresenceFacts } from '../../shared/foundation/step-away';
export type { UnboundHostPorts, UnboundIpcEvent, UnboundIpcMain, UnboundWindowLike } from './host-ports';

export class UnboundHost {
  readonly mode: UnboundMode;
  private viewerDistanceM = DEFAULT_VIEWER_DISTANCE_M;
  private measured: MonitorMeasurement[] | null = null;
  private reviewed: { url: string | null; value: boolean } = { url: null, value: false };
  /** The default stand's URL once known (asked on each entry until it is). */
  private rest: string | null = null;
  private debug = false;
  /** E3, on by default in Unbound (developer panel can turn it off, this run only): the opening beat before she speaks. */
  private speechBeat = true;
  /** Step 2: which senses are in use now (the small light near her). */
  private sensesNow: UnboundSenses | null = null;
  private readonly headAsks = new Map<string, (head: HeadSpot | null) => void>();
  private askCount = 0;
  /** Her walk and stance knobs (this run only, like the other knobs). */
  private body: UnboundBody = { ...UNBOUND_BODY_DEFAULTS };
  private screen: PhysicalScreen | null = null;
  private world: UnboundWorld | null = null;
  private revision = 0;
  private sceneKey = '';
  private stats: UnboundStats | null = null;
  private error: string | null = null;
  /** I-199: a full-screen program is in front (information only: nothing about her window, place or drawing reads it). */
  private fullscreenInFront = false;
  private measurement: Promise<MonitorMeasurement[] | null> | null = null;
  /** The window being made or shown, and the wait for its ready report. */
  private window: UnboundWindowLike | null = null;
  private readiness: { win: UnboundWindowLike; progress: (value: unknown) => boolean; resolve: (report: { ok: boolean; error?: string }) => void } | null = null;
  private registered = false;
  /** U2: the director's host side (electron/unbound/peek.ts); null without its ports. */
  readonly peek: PeekDirectorHost | null;
  /**
   * Read-aloud while she is out (electron/unbound/read-aloud.ts, docs/claude/2026-11-15-unbound-read-aloud.md): the display proof
   * of her bubble, the surface electron/main.ts reads aloud from while she is out.
   */
  readonly readAloud = new UnboundBubbleProof({ active: () => this.bubbleCanShow(), here: () => this.mode.state === 'unbound' && herHere(windowPresenceFacts(this.shownWin)) }); // I-174
  /** Step 4: her own life (electron/unbound/life.ts); null without its ports. */
  readonly life: LifeHost | null;
  /** Her mood out here (electron/unbound/mood-bridge.ts): the view relayed, a touch's input from the shown window only. */
  private readonly moodBridge: UnboundMoodBridge<UnboundWindowLike>;
  /** Batch B: her games out here (猜拳, 递东西, 牵手; electron/unbound/games-bridge.ts). */
  readonly games: UnboundGamesBridge<UnboundWindowLike>;
  /** Her last place and the user's default place (place-keeper.ts); the full-screen panel's button and the internal channel use it. */
  readonly places: PlaceKeeper = new PlaceKeeper(() => ({ last: this.ports.savedPlace, fixed: this.ports.defaultPlace }), () => this.mode.state === 'unbound' && this.world && this.her.placement ? { frame: this.world, at: this.her.placement, heightM: this.her.heightM } : null,
    () => this.ports.company?.current() ?? null); // I-209: per character
  /** I-209: who else is on stage; step 3: company/stage.ts routes a line to whoever said it (`speechTo`). */
  readonly company = new CompanyHost({ ports: () => this.ports.company, state: () => this.mode.state, notice: text => this.notice(text), shown: win => this.mode.shown === win });
  speechTo: ((replyId: string | null) => UnboundSpeechTarget | null) | null = null;
  private readonly pulls = new UnboundPullAnswer({ ports: () => this.ports, shown: win => this.mode.shown === win && win.isVisible(), life: () => this.life, peek: () => this.peek, arrived: at => this.arrived(at) });

  /** Where she stands (her-place.ts): her placement, her height, an entry's start in screen terms; come-near's size. */
  readonly her: HerPlace = new HerPlace(this.places, () => this.world);

  constructor(private readonly ports: UnboundHostPorts) {
    this.mode = new UnboundMode({
      pet: () => ports.pet(), petWanted: () => ports.petWanted(),
      // The reason is known before the mode turns normal, so the 「她没能出来」 notice (entry.ts failed, on that change) can show it.
      open: () => this.open().catch((error: unknown) => { this.error = error instanceof Error ? error.message : String(error); throw error; }), restored: () => ports.restored(), changed: state => this.stateChanged(state),
    });
    this.peek = ports.peek ? new PeekDirectorHost(ports.peek, {
      shown: () => this.mode.state === 'unbound' && !!this.mode.shown,
      fullscreen: () => this.fullscreenInFront,
      send: command => { const win = this.shownWin; if (win) this.send(win, UNBOUND_EVENTS.peek, command); },
      changed: () => this.publish(),
    }) : null;
    this.life = ports.life ? new LifeHost(ports.life, {
      shown: () => this.mode.state === 'unbound' && !!this.mode.shown, fullscreen: () => this.fullscreenInFront, out: () => this.mode.state === 'unbound',
      send: command => { const win = this.shownWin; if (win) this.send(win, UNBOUND_EVENTS.life, command); },
      ...this.her.lifeLink(), // I-193 / I-212: her spot, come-near's size, the nearest, go's numbers (her-place.ts)
      arrived: at => this.arrived(at), taskbar: () => !!this.world && this.world.workArea.height < this.world.display.height,
      peekActive: () => !!this.peek?.active, interruptPeek: cause => this.peek?.interrupt(cause), interrupted: (action, by) => ports.peek?.notes?.interrupted(action, by),
      changed: () => this.publish(),
    }) : null;
    this.moodBridge = new UnboundMoodBridge(() => ports.mood, { current: () => this.window, shown: () => this.shownWin,
      touchable: () => true, send: (win, channel, value) => this.send(win, channel, value) }); // 2026-11-23: no forced click-through while she plays a peek (I-199: no step-back)
    this.games = new UnboundGamesBridge(() => ports.games?.(), { shown: () => this.shownWin, out: () => this.mode.state === 'unbound',
      touchable: () => true, send: (win, channel, value) => this.send(win, channel, value) });
    if (this.peek && this.life) { const life = this.life; this.peek.arbiter = { claim: () => life.claim(), block: () => life.peekBlock(), pace: knob => life.peekPace(knob) }; }
    this.registerWindowRequests();
    void this.places.load(); // so the panel and the internal channel can say whether a default place is set before her first entry
  }

  get state(): UnboundState { return this.mode.state; }
  /** The window she is shown in now (null: none). */
  private get shownWin(): UnboundWindowLike | null { return this.mode.shown as UnboundWindowLike | null; }
  /** For the host's settings sync: the companion's 显示桌宠 masked while she is in Unbound. */
  petSettings<T extends { visible: boolean }>(settings: T): T { return this.mode.petSettings(settings); }

  view(): UnboundControlView {
    const screen = this.screen;
    return {
      available: this.ports.developerMode(), state: this.mode.state,
      viewerDistanceCm: Math.round(this.viewerDistanceM * 1000) / 10, depthM: Math.round((this.her.placement?.depthM ?? this.her.depthM) * 100) / 100,
      body: { ...this.body }, debug: this.debug, screen: screen ? { widthCm: Math.round(screen.widthM * 1000) / 10, heightCm: Math.round(screen.heightM * 1000) / 10, source: screen.source } : null,
      stats: this.stats, error: this.error, fullscreen: this.fullscreenInFront, peek: this.peek?.view() ?? null, speechBeat: this.speechBeat,
      life: this.life?.view() ?? null, entryAllowed: this.ports.entryAllowed?.() ?? true,
    };
  }

  /**
   * The control window's request. `active` (in or out) is allowed in any mode (Unbound v1 step 1: the permission page is in
   * electron/unbound/entry.ts, and entering by itself turns no sense on); every other field is a developer knob and is refused
   * outside developer mode. Returns the view right away; entering finishes later.
   */
  apply(value: unknown): UnboundControlView {
    const patch: UnboundControlPatch = parseUnboundControlPatch(value);
    if (Object.keys(patch).some(key => key !== 'active') && !this.ports.developerMode()) throw new Error('这些调节只在开发者模式下可用。');
    if (patch.viewerDistanceCm !== undefined) this.viewerDistanceM = clampViewerDistance(patch.viewerDistanceCm / 100);
    if (patch.depthM !== undefined) this.her.knobDepth(patch.depthM, this.viewerDistanceM); // along your line of sight (her-place.ts)
    if (patch.debug !== undefined) this.debug = patch.debug;
    if (patch.speechBeat !== undefined && patch.speechBeat !== this.speechBeat) { this.speechBeat = patch.speechBeat; this.pushScene(); } // E3 experiment
    const bodyChanged = patch.walkSpeedMps !== undefined || patch.stepLengthM !== undefined || patch.stance !== undefined;
    if (patch.walkSpeedMps !== undefined) this.body.walkSpeedMps = patch.walkSpeedMps;
    if (patch.stepLengthM !== undefined) this.body.stepLengthM = patch.stepLengthM;
    if (patch.stance !== undefined) this.body.stance = patch.stance;
    if (patch.viewerDistanceCm !== undefined || patch.depthM !== undefined || patch.debug !== undefined || bodyChanged) {
      if (patch.viewerDistanceCm !== undefined && this.world) this.rebuildWorld();
      else if (this.world && this.her.placement) this.world = { ...this.world, placement: this.her.placement };
      this.pushScene();
    }
    if (patch.peekIdleSeconds !== undefined || patch.peekCooldownMinutes !== undefined || patch.peekPerHour !== undefined || patch.peekSoftness !== undefined) {
      this.peek?.setKnobs({ idleSeconds: patch.peekIdleSeconds, cooldownMinutes: patch.peekCooldownMinutes, perHour: patch.peekPerHour, softness: patch.peekSoftness });
      if (patch.peekSoftness !== undefined) this.pushScene();
    }
    if (patch.peekNow) {
      if (!this.peek) throw new Error('这里还不能让她凑过来。');
      if (!this.peek.trial()) throw new Error('现在不行：她不在 Unbound 里，或者正在凑过来。');
    }
    if (patch.lifeKnobs) this.life?.setKnobs(patch.lifeKnobs); // step 4: the starting numbers (this run only)
    if (patch.lifeFast !== undefined) this.life?.fastForward(patch.lifeFast);
    if (patch.lifeTry && !this.life?.trial(patch.lifeTry)) throw new Error('现在不行：她不在外面，或者她正在做别的事、你正在和她互动。');
    if (patch.active === true) this.enter();
    else if (patch.active === false) this.exit();
    this.publish();
    return this.view();
  }

  enter(): void {
    if (this.mode.state !== 'normal') return;
    this.error = null;
    this.mode.enter().then(() => {
      if (this.mode.state !== 'unbound') return;
      this.startWatching();
      this.publish();
    }, (error: unknown) => {
      this.error = error instanceof Error ? error.message : String(error);
      this.publish();
    });
  }

  exit(): void {
    this.stopWatching();
    this.cancelReadiness('已取消。');
    this.mode.exit();
    this.window = null;
  }

  /** The app is quitting: the window goes, nothing is restored or saved (the next start is normal mode). */
  quit(): void {
    this.stopWatching();
    this.cancelReadiness('应用正在退出。');
    this.mode.quit();
    this.window = null;
    if (this.registered) for (const channel of [...Object.values(UNBOUND_REQUESTS), ...this.games.channels, ...this.company.channels]) this.ports.ipcMain.removeHandler(channel);
    this.registered = false;
  }

  /** Her reply streaming in the control window's chat: a small bubble near her head. */
  stream(event: { id: string; kind: string; type: string; text: string; speechBeats?: UnboundBubble['speechBeats'] }): void {
    const win = this.shownWin;
    // 边说边演 (docs/claude/2026-11-20-speech-beats-2-4.md): her beats go to her as they are (no text, revision or cue); I-209 step 3: to whoever said them.
    if (win && event.kind === 'chat' && event.type === 'beats' && event.speechBeats) { this.sendOut(UNBOUND_EVENTS.bubble, { id: String(event.id).slice(0, 100), type: 'beats', text: '', speechBeats: event.speechBeats } satisfies UnboundBubble, String(event.id).slice(0, 100)); return; }
    if (!win || event.kind !== 'chat' || (event.type !== 'delta' && event.type !== 'done' && event.type !== 'error')) return;
    const bubble = { id: String(event.id).slice(0, 100), type: event.type, text: event.type === 'delta' ? String(event.text) : '' } satisfies UnboundBubble;
    if (this.bubbleHold.take(bubble)) return; // I-165: held back until her voice reaches it (electron/unbound/bubble-hold.ts)
    this.sendBubble(bubble);
  }
  /** I-165: her reply's bubble text held back until her voice reaches it; voice-wiring connects the plan. */
  readonly bubbleHold = new UnboundBubbleHold({ emit: held => this.sendBubble(held.type === 'hold' ? { id: held.id, type: 'delta', text: '', hold: true } : { id: held.id, type: held.type, text: held.text }) });
  private sendBubble(bubble: UnboundBubble & { type: 'delta' | 'done' | 'error' }): void {
    const win = this.shownWin;
    if (!win) return;
    // Read-aloud: each piece gets a revision the page echoes once painted; an error clears the bubble.
    if (bubble.hold) this.readAloud.hold(bubble.id);
    else if (bubble.type === 'delta') bubble.rev = this.readAloud.sent(bubble.id, bubble.text);
    else { bubble.rev = this.readAloud.revision; if (bubble.type === 'error') this.readAloud.ended(bubble.id); else Object.assign(bubble, lingerField(this.ports.lingerMs, this.readAloud.textOf(bubble.id))); }
    const to = this.speechTo?.(bubble.id); // I-209 step 3: her line to her window, and the cue to her (else here, as before)
    if (to) { to.send(UNBOUND_EVENTS.bubble, bubble); to.cue(bubble.type); return; }
    this.send(win, UNBOUND_EVENTS.bubble, bubble);
    this.peek?.chat(bubble.type); // U2: a cue (she speaks), and a reply that starts mid-peek backs her off
    this.life?.chat(bubble.type); // step 4: you two are talking: her own action eases out
  }

  // ---- read-aloud while she is out: her own lines in her bubble ----

  /**
   * Her own line (inner-loop, touch, visual topic, ambient comment) while she is out: into her bubble now; the companion window's offer says
   * `held`, so it only acknowledges and reads it (src/brain/held-lines.ts). Nothing when her bubble cannot be seen (the offer goes home).
   * I-209 step 4: to whoever on stage it belongs to (`speechTo`: a chime-in to her window, with the floor), else here.
   */
  holdLine(id: string, text: string): { held: true } | Record<string, never> {
    const win = this.shownWin, to = win ? this.speechTo?.(id) : null; // hold-line.ts
    return win && this.bubbleCanShow() ? holdLineIn({ proof: this.readAloud, send: (c, v) => to ? to.send(c, v) : this.send(win, c, v), lingerMs: this.ports.lingerMs, cue: type => { if (to) return to.cue(type); this.peek?.chat(type); this.life?.chat(type); } }, id, text) : {};
  }

  /** A visual or inner-loop line: the companion bubble's exact text. */
  holdVisionLine(message: Readonly<VisionInitiative>): { held: true } | Record<string, never> {
    try { return this.holdLine(message.id, formatVisionPresentation(message)); } catch { return {}; }
  }

  /** v1 step 3: her spoken reply (a call, voice input) in her bubble too, with a typed one's read-aloud proof. */
  voiceReply(channel: string, value: unknown): void { const event = voiceReplyBubbleEvent(channel, value); if (event) this.stream(event); }

  /** Every broadcast: a new mood view goes to her window too (electron/unbound/mood-bridge.ts). */
  mood(channel: string, value: unknown): void { this.moodBridge.relay(channel, value); }

  /** Every broadcast: a line of hers taken back leaves her bubble too (as the companion hides it). */
  retracted(channel: string, value: unknown): void {
    const id = retractedLineId(channel, value);
    if (!id || this.readAloud.currentId !== id) return;
    const rev = this.readAloud.revision;
    this.readAloud.ended(id);
    this.sendOut(UNBOUND_EVENTS.bubble, { id, type: 'error', text: '', rev } satisfies UnboundBubble, id);
  }
  /** To whoever said it (I-209 step 3: `speechTo`; a mouth: whoever has the floor), else her own window. */
  private sendOut(channel: string, value: unknown, replyId: string | null = null): void { const to = this.speechTo?.(replyId), win = this.shownWin; if (to) to.send(channel, value); else if (win) this.send(win, channel, value); }

  // ---- Unbound v1 step 2: typing, the light, her mouth ----

  /** The Unbound window's rectangle on the screen (work area), or null while she has no window. */
  windowRect(): Rect | null {
    const win = this.shownWin;
    return win && !win.isDestroyed() && this.world ? { ...this.world.window } : null;
  }

  /** The line the user just sent from the box: shown briefly near her. */
  said(text: string): void {
    const win = this.shownWin;
    if (win && typeof text === 'string' && text.trim()) this.send(win, UNBOUND_EVENTS.said, text.slice(0, 200));
  }

  /** I-159 D: the app's own short line beside her for a few seconds (what the entry turned on), not as something you said. */
  notice(text: string): void {
    const win = this.shownWin;
    if (win && typeof text === 'string' && text.trim()) this.send(win, UNBOUND_EVENTS.said, { notice: text.slice(0, 200) });
  }

  /** A voice sounds (or stopped): her mouth follows it. Only while she is out; the page ends it when it hears no more. */
  speaking(on: boolean): void { this.sendOut(UNBOUND_EVENTS.speaking, on === true); }

  /** 2026-11-20: one of her short call sounds (its mouth scale) or ended (null): her mouth follows it, only while she is out. */
  fillerMouth(shape: number | null): void { this.sendOut(UNBOUND_EVENTS.fillerMouth, sanitizeFillerShape(shape)); }

  /** I-190: for the input box's senses panel. */
  get senseState(): UnboundSenses | null { return this.sensesNow; }
  /** The senses in use now (the small light): kept before she comes out, so the light is right the moment she appears. */
  senses(next: unknown): void {
    const value = parseSenses(next);
    if (!value || sameSenses(value, this.sensesNow)) return;
    this.sensesNow = value;
    const win = this.shownWin;
    if (win) this.send(win, UNBOUND_EVENTS.senses, { ...value }); // its own event: a scene push would place her again
  }

  /** Where her head is now on the window (the page answers; null when it does not in time or her head is not on the window). */
  askHead(): Promise<HeadSpot | null> {
    const win = this.shownWin;
    if (!win) return Promise.resolve(null);
    const id = `h${++this.askCount}`;
    return new Promise<HeadSpot | null>(resolve => {
      const done = (head: HeadSpot | null) => { clearTimeout(timer); if (this.headAsks.delete(id)) resolve(head); };
      const timer = setTimeout(() => done(null), this.ports.headTimeoutMs ?? 500);
      this.headAsks.set(id, done);
      this.send(win, UNBOUND_EVENTS.typing, { type: 'where', id });
    });
  }

  /** The companion's settings changed (model, motion, breath, physics): a new scene if anything shown changed. */
  refresh(): void {
    this.company.gateChanged(); this.company.refresh(); // I-209: a switch of who you talk with keeps the same people on stage
    if (!this.window || !this.world) return;
    if (this.ports.source().modelUrl === this.reviewed.url) { this.pushScene(); return; }
    void this.checkReviewed().then(() => this.pushScene()); // a new model: one scene, with its review answer
  }

  /** Display metrics changed: the window follows the work area and her world is measured again. */
  displayChanged(): void {
    if (!this.window || !this.world) return;
    this.rebuildWorld();
    if (!this.ports.preview && !this.window.isDestroyed()) this.window.setBounds(this.world!.window);
    this.pushScene();
  }

  /**
   * I-199 (11-15: she does not make way): a full-screen program came to the
   * front (or went away). Information only: nothing hides, moves or stops her; her peek, bubble and clicks go on. Her window is topmost
   * at the companion's level (window.ts). On the way in she is raised once (an event, never a timer, no focus): a full-screen program
   * that is itself topmost does not cover her, and anything topmost shown after it (Start, the tray, the snip overlay) is above her
   * again (I-062). Her own walks and peeks read it as their reason to wait (autonomous only).
   */
  fullscreenReading(value: FullscreenReading): void {
    const inFront = value === 'fullscreen';
    if (inFront === this.fullscreenInFront) return;
    this.fullscreenInFront = inFront;
    const win = this.shownWin;
    if (inFront && win && !win.isDestroyed()) win.raise?.();
    this.publish();
  }

  // ---- inside ----

  private async open(): Promise<UnboundWindowLike> {
    this.measurement ??= this.ports.measure().catch(() => null);
    [this.measured] = await Promise.all([withTimeout(this.measurement, this.ports.measureTimeoutMs ?? 4_000, null), this.checkReviewed(), this.checkRestPose(), this.places.load()]);
    this.rebuildWorld(true);
    if (this.mode.state !== 'entering') throw new Error('已取消。');
    const { window: win, loaded } = this.ports.openWindow(this.world!.window);
    // Known before its page runs, so its first request (the scene) is answered.
    this.window = win;
    this.sceneKey = '';
    const report = new Promise<{ ok: boolean; error?: string }>(resolve => {
      // Progress-aware (shared/unbound/entry-wait.ts): 45 s for the page to start, then 20 s without a forward step, 90 s in all.
      const wait = startEntryWait(error => resolve({ ok: false, error }), { firstMs: this.ports.readyFirstMs, quietMs: this.ports.readyTimeoutMs, capMs: this.ports.readyCapMs });
      this.readiness = { win, progress: value => wait.report(value), resolve: value => { wait.stop(); if (this.readiness?.win === win) this.readiness = null; resolve(value); } };
    });
    win.onGone(() => {
      if (this.readiness?.win === win) this.readiness.resolve({ ok: false, error: '窗口在她出现前关掉了。' });
      if (this.window === win) { this.stopWatching(); this.window = null; }
      this.mode.windowGone(win);
    });
    loaded.catch(() => { if (this.readiness?.win === win) this.readiness.resolve({ ok: false, error: '页面没能打开。' }); });
    const result = await report;
    if (this.mode.state !== 'entering' && result.ok) { if (!win.isDestroyed()) win.destroy(); throw new Error('已取消。'); }
    const reportValue = result;
    if (!reportValue.ok) {
      if (this.window === win) this.window = null;
      if (!win.isDestroyed()) win.destroy();
      throw new Error(reportValue.error || '她没能出现。');
    }
    return win;
  }

  private cancelReadiness(error: string): void { this.readiness?.resolve({ ok: false, error }); }

  /** Whether the shown model is the reviewed Gene, asked once per model (a failed or slow answer counts as not reviewed). */
  private async checkReviewed(): Promise<void> {
    const url = this.ports.source().modelUrl;
    if (url === this.reviewed.url) return;
    const value = url && this.ports.reviewed ? await withTimeout(Promise.resolve().then(() => this.ports.reviewed!()), 5_000, false) : false;
    if (this.ports.source().modelUrl === url) this.reviewed = { url, value: value === true };
  }

  /** The default stand's URL, asked once it is needed (a failed or slow answer: none this time; the next entry asks again). */
  private async checkRestPose(): Promise<void> {
    if (this.rest || !this.ports.restPose) return;
    const url = await withTimeout(Promise.resolve().then(() => this.ports.restPose!()), 5_000, null);
    this.rest = typeof url === 'string' && url ? url : null;
  }

  private rebuildWorld(entering = false): void {
    const display = this.ports.display();
    const screen = this.screen = resolvePhysicalScreen(display, this.measured);
    const viewerDistanceM = this.viewerDistanceM;
    const preview = this.ports.preview, frame = { screen, display: { ...display.bounds }, workArea: { ...display.workArea }, viewerDistanceM };
    const placement = this.her.place(frame, entering); // an entry: the default place, where she was, the last place, the first appearance (her-place.ts)
    this.world = {
      ...frame, window: preview ? { ...preview.bounds } : { ...display.workArea },
      mapping: preview ? 'fit' : 'physical', viewerDistanceM, eyeHeightM: eyeHeightFor(screen, display, viewerDistanceM), placement: { ...placement },
    };
  }

  private scene(): UnboundScene {
    if (!this.world) this.rebuildWorld();
    const source = this.ports.source();
    return { revision: this.revision, modelUrl: source.modelUrl, reviewed: this.reviewed.url === source.modelUrl && this.reviewed.value,
      motion: withRestPose(source.motion, this.rest), breath: source.breath, physics: source.physics,
      world: { ...this.world!, placement: { ...this.world!.placement } }, ...(this.her.start ? { start: { ...this.her.start } } : {}), body: { ...this.body }, debug: this.debug,
      ...(this.peek ? { peekSoftness: this.peek.knobValues.softness } : {}), ...(this.speechBeat ? { speechBeat: true as const } : {}),
      ...(this.sensesNow ? { senses: { ...this.sensesNow } } : {}) };
  }

  private pushScene(): void {
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    const { revision: _ignored, senses: _lights, ...content } = this.scene(); // the light has its own event, so it never re-places her
    const key = JSON.stringify(content);
    if (key === this.sceneKey) return;
    this.sceneKey = key;
    this.revision++;
    this.send(win, UNBOUND_EVENTS.scene, this.scene());
  }

  private send(win: UnboundWindowLike, channel: string, value: unknown): void {
    try { if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, value); } catch { /* a closing window misses one update */ }
  }

  /** The request came from the current Unbound window's own top frame. */
  private owner(event: UnboundIpcEvent): UnboundWindowLike | null {
    const win = this.window;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null;
    if (event?.sender?.id !== win.webContents.id) return null;
    if (event.senderFrame !== event.sender.mainFrame) return null;
    return win;
  }

  private registerWindowRequests(): void {
    const handle = (channel: string, operation: (win: UnboundWindowLike, ...args: unknown[]) => unknown) => {
      this.ports.ipcMain.handle(channel, (event, ...args) => {
        const win = this.owner(event);
        if (!win) throw new Error('请求来源未授权。');
        return operation(win, ...args);
      });
    };
    handle(UNBOUND_REQUESTS.getScene, () => { const scene = this.scene(); const { revision: _r, senses: _s, ...content } = scene; this.sceneKey = JSON.stringify(content); return scene; });
    handle(UNBOUND_REQUESTS.ready, (win, value) => { if (this.readiness?.win === win) { const ready = parseUnboundReady(value); if (this.her.ready(ready.modelHeightM) && this.world) { this.world = { ...this.world, placement: { ...this.her.placement! } }; this.pushScene(); } this.readiness.resolve(ready); } });
    handle(UNBOUND_REQUESTS.loading, (win, value) => { if (this.readiness?.win === win) this.readiness.progress(value); }); // the entry's wait (shared/unbound/entry-wait.ts)
    handle(UNBOUND_REQUESTS.interactive, (win, value): UnboundInteractiveAck => {
      if (typeof value !== 'boolean') throw new Error('参数不正确。');
      const on = value && this.mode.shown === win && win.isVisible(); // 2026-11-23: also while she plays a peek (her own hit test, as at any time)
      win.setIgnoreMouseEvents(!on, { forward: true });
      return { interactive: on };
    });
    handle(UNBOUND_REQUESTS.peekReport, (win, value) => this.mode.shown === win ? this.life?.goAsk(value) ?? this.peek?.report(value) : undefined); // I-185/I-193: kiss, hug, go
    handle(UNBOUND_REQUESTS.lifeReport, (win, value) => { if (this.mode.shown === win) this.life?.report(value); }); // step 4
    handle(UNBOUND_REQUESTS.touch, (win, value) => {
      // Only from the shown window while she can be clicked: not while she plays a peek.
      const report = parseUnboundTouch(value);
      if (!report || this.mode.shown !== win || !win.isVisible()) return;
      this.life?.touched(); // step 4: you clicked her: her own action eases out, she turns to you
      try { this.ports.touch?.(report); } catch (error) { console.error(error); }
    });
    handle(UNBOUND_REQUESTS.pull, (win, value) => this.pulls.answer(win, value)); // step 5c: 拉她 (a start is answered: may she be pulled, and how she takes it)
    handle(UNBOUND_REQUESTS.anchor, (win, value) => {
      const report = parseUnboundAnchor(value);
      if (report && this.mode.shown === win) this.headAsks.get(report.id)?.(report.head);
    });
    // Read-aloud: which text her bubble has painted (only the shown window's top frame; electron/unbound/read-aloud.ts checks the rest).
    handle(UNBOUND_REQUESTS.shown, (win, value) => { if (this.mode.shown === win) this.readAloud.report(value); });
    this.moodBridge.register(handle); // her mood view and a touch's mood input (electron/unbound/mood-bridge.ts)
    this.games.register(handle); // batch B: her games' answers (electron/unbound/games-bridge.ts)
    this.company.register(handle); // I-209 step 1 (electron/unbound/company/host.ts)
    handle(UNBOUND_REQUESTS.stats,(_win, value) => { const stats = parseUnboundStats(value); if (stats) { this.stats = stats; this.publish(); } });
    this.registered = true;
  }

  private startWatching(): void {
    this.fullscreenInFront = false;
    this.ports.fullscreen?.start(value => this.fullscreenReading(value));
    // U2: the director asks once a second whether she may come up to the lens (its own port's timer, so tests drive it).
    // Step 4: her own life ticks right after the peek (the peek asks it for its turn while it ticks).
    if ((this.peek || this.life) && !this.stopPeekTick) this.stopPeekTick = (this.ports.peek ?? this.ports.life)!.every(1_000, () => { this.peek?.tick(); this.life?.tick(); });
  }
  /** Step 4: a walk of hers ended here: her place in the scene follows (so nothing walks her back) and is kept for next time (I-209: or a step aside). */
  arrived(at: { xM: number; depthM: number }): void {
    if (!this.world) return;
    this.world = { ...this.world, placement: { ...this.her.arrived(this.world, at) } };
    this.pushScene();
  }
  private stopPeekTick: (() => void) | null = null;
  private stopWatching(): void {
    try { this.stopPeekTick?.(); } catch { /* already stopped */ }
    this.stopPeekTick = null;
    this.peek?.stop();
    this.life?.stop();
    this.ports.fullscreen?.stop();
    this.fullscreenInFront = false;
  }

  /** Read-aloud: her bubble can be seen now (out, her window shown and visible; a full-screen program never hides it, I-199). */
  private bubbleCanShow(): boolean {
    const win = this.shownWin;
    return this.mode.state === 'unbound' && !!win && !win.isDestroyed() && !win.webContents.isDestroyed() && win.isVisible();
  }

  private stateChanged(state: UnboundState): void {
    this.readAloud.invalidate(); // read-aloud: one surface at a time; a switch proves nothing on the other one
    this.bubbleHold.reset();
    this.company.modeChanged(state);
    if (state === 'normal') { this.stopWatching(); this.window = null; for (const answer of [...this.headAsks.values()]) answer(null); }
    this.publish();
    try { this.ports.modeChanged?.(state); } catch (error) { console.error(error); }
  }
  private publish(): void { try { this.ports.publish(this.view()); } catch { /* the control window may be gone */ } }
}
