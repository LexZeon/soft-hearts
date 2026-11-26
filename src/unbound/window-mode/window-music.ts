/**
 * I-154 batch 6, row 37 跟音乐跳、点头、听歌的反应 (docs/claude/2026-11-20-unbound-window-batch6.md): music in the companion window on
 * Unbound's engine. The old stage's performers run unchanged (src/stage/mmd/music.ts on this window's state): what she hears and whether it
 * is music (MusicLikeness), her choice to dance, nod or stay still (MusicChoice, M1; "让她一直跟着跳" is the R15 way back), the dance
 * (MusicDance: small sway, bounce, chest and head offsets with its own presence fade and release), the nod and the listening look (MusicNod,
 * MusicListenCue: offsets for procedural life), the song reactions (MusicReactStage: the dance's shape, a face accent, the host told).
 *
 * Only through the user's own switch: the samples reach the stage from the wiring only while 和她一起听 is on (setMusicEnabled), and this
 * window refuses any that come while it is off (musicSampleHeard). Nothing here opens a sense or asks the host for sound.
 *
 * Where the motion goes: the dance at the figure's mixer level (window-under-layer.ts; the old stage writes it at the same place: the
 * centre's bounce and sway, the chest's roll, the head's pitch and roll), so the figure's look, breath and feet ride on it; the nod there
 * too (2026-11-24, docs/claude/2026-11-24-music-nod-window.md: as procedural life's beat it was about 1°, lost under this engine's idle,
 * and gone whenever procedural life gave way, while she was told she nodded); the listening look as procedural life's beat
 * (window-proc-life.ts), goals the springs carry. What she is told her body does (presence) is what shows, never the tier alone.
 * Giving way (musicYieldReason, the old stage's owners: speech, a camera or window move, a touch, a picked head motion; the window adds a pull and her sleep body) is the dance's own
 * presence fade (R29b), never a cut; only a hidden window resets it (nothing is on screen).
 */
import type { MusicChoiceContext, MusicDancePose, MusicEnergySample, MusicLib, MusicNodOffsets, MusicPresence, MusicVerdictFlip, SongMemoryPort } from '../../stage';
import { normalizeMusicSettings, type MusicSettings, type MusicTaste } from '../../../shared/senses';
import type { MoodView } from '../../../shared/mood';
import type { Bone } from 'three';
import type { UnderPort, UnderWriter } from './window-under-layer';

type Choice = InstanceType<MusicLib['MusicChoice']>;
type Dance = InstanceType<MusicLib['MusicDance']>;
type Nod = InstanceType<MusicLib['MusicNod']>;
type Listen = InstanceType<MusicLib['MusicListenCue']>;
type Likeness = InstanceType<MusicLib['MusicLikeness']>;
type React = InstanceType<MusicLib['MusicReactStage']>;
type Tier = 'none' | 'nod' | 'dance';
type ReactPorts = Parameters<React['step']>[1];

/** What the stage lends the music (the old stage's options and its speaking-accent layer). */
export interface WindowMusicPorts {
  /** The speaking-accent layer (window-face.ts musicFace) the song reactions perform on, and whether it exists yet. */
  face(): ReturnType<ReactPorts['face']>;
  hasFace(): boolean;
  /** The old stage's records: a reaction started, the tier changed, the music verdict flipped (numbers only; a record never changes what she does). */
  told?(intent: Parameters<ReactPorts['told']>[0], scale: number): void;
  tier?(tier: Tier, score: number | null): void;
  verdict?(flip: MusicVerdictFlip): void;
  /** The card's music taste and the song memory (numbers to the host and back; I-077 step 2). */
  taste?(): Readonly<MusicTaste> | undefined;
  memory?(): SongMemoryPort | null | undefined;
  /** The dance starts: an automatic body motion hands back (the old stage's cancelBodyMotion). */
  danceStarts?(): void;
  /** Monotonic ms (performance.now) and the wall clock (Date.now); a test's own clocks. */
  now?(): number;
  wall?(): number;
}

/** This frame's owners of her that the dance yields to (window-stage.ts fills it from the same state as her motions' gates). */
export interface WindowMusicEnv {
  view: MoodView | null;
  shown: boolean;
  speaking: boolean;
  /** A camera adjust. */
  adjusting: boolean;
  /** A window move or resize. */
  behaviorBlocked: boolean;
  /** A pat, a snack (or one at her mouth), a pinch, a hover, a pull. */
  touched: boolean;
  /** A picked motion moves her head. */
  manualHead: boolean;
  /** Her sleep body holds her. */
  asleep: boolean;
  /** Full-screen only (batch F, docs/claude/2026-11-21-unbound-full-D.md): she walks (no dance while she walks); the window never sets it. */
  walking?: boolean;
}

/**
 * Why the dance gives way this frame, or null (the old stage's syncMusicSuppression, same order); 'disabled' is not a yield (no dance).
 * The window adds a pull to the touches and her sleep body, which the old stage does not have.
 */
export function musicYieldReason(env: WindowMusicEnv, danceOn: boolean): string | null {
  return !env.shown ? 'hidden' : env.speaking ? 'speech' : env.adjusting ? 'camera' : env.behaviorBlocked ? 'window-or-input'
    : env.touched ? 'direct-interaction' : env.walking === true ? 'walking' : env.manualHead ? 'manual-head' : env.asleep ? 'asleep' : !danceOn ? 'disabled' : null;
}

/** A sample counts only while the user's own switch says she hears (the wiring sends none otherwise; this refuses a stray one too). */
export function musicSampleHeard(hearing: boolean, sample: unknown): sample is MusicEnergySample {
  if (!hearing || !sample || typeof sample !== 'object') return false;
  const s = sample as Record<string, unknown>;
  return ['time', 'rms', 'low', 'mid', 'high'].every(key => typeof s[key] === 'number' && Number.isFinite(s[key]));
}

const ZERO_POSE: MusicDancePose = Object.freeze({ sway: 0, bounce: 0, chestRoll: 0, headRoll: 0, headPitch: 0 });
/** The least of the user's strength at which the dance counts as on her (music-nod.ts MUSIC_NOD_SHOWN_STRENGTH, the same for the nod). */
const MUSIC_SHOWN_STRENGTH = 0.25;
const OFF: MusicPresence = Object.freeze({ music: 'off', always: true, beat: 0 }) as MusicPresence;

export class WindowMusic implements UnderWriter {
  private lib: MusicLib | null = null;
  private dance: Dance | null = null;
  private choice: Choice | null = null;
  private nod: Nod | null = null;
  private listen: Listen | null = null;
  private likeness: Likeness | null = null;
  private react: React | null = null;
  /** The user's switch says she hears (the old stage's musicHearing). */
  private hearing = false;
  /** The dance is on (the old stage's musicEnabled). */
  private danceOn = false;
  private settings: MusicSettings | null = null;
  private suppressed = false;
  private reason: string | null = null;
  private loudAt = -Infinity;
  private listenSide = 1;
  private reportedTier: Tier | null = null;
  private listenKind = '';
  private pose: MusicDancePose = ZERO_POSE;
  private showing = false;
  private beatOut: MusicNodOffsets | null = null;
  /** This frame's nod (written on her head and chest by write()), or null. */
  private nodOut: Readonly<MusicNodOffsets> | null = null;
  private readonly beatSum = { headX: 0, headZ: 0, bodyZ: 0 };
  private bones: { center: Bone | null; chest: Bone | null; head: Bone | null; height: number } | null = null;

  constructor(private readonly ports: WindowMusicPorts) {}
  private now(): number { return this.ports.now?.() ?? performance.now(); }

  /** The performers' code (src/stage/index.ts loadMusicForEngine). What was told before it came is applied now. */
  load(lib: MusicLib): void {
    if (this.lib) return;
    this.lib = lib;
    this.dance = new lib.MusicDance(); this.nod = new lib.MusicNod(); this.likeness = new lib.MusicLikeness(); this.react = new lib.MusicReactStage();
    const hearing = this.hearing, settings = this.settings;
    this.hearing = false;
    if (settings) this.setSettings(settings);
    this.setEnabled(hearing);
  }
  get loaded(): boolean { return !!this.lib; }

  /** This model's centre, chest and head, and her height (model units), or null without a model. */
  attach(bones: { center: Bone | null; chest: Bone | null; head: Bone | null; height: number } | null): void {
    this.bones = bones; this.resetPresentation();
  }

  // ---- what the wiring tells her (the old stage's members) ------------------------------------------------------------------------
  /** The user's 和她一起听 switch: on means she hears. Whether she moves is her choice (M1); without settings it is the original R15 dance. */
  setEnabled(enabled: boolean): void {
    this.hearing = enabled === true;
    if (!this.lib) return;
    if (!this.hearing) { this.likeness?.reset(); this.react?.reset(); this.reportVerdicts(); }
    if (!this.choice) { this.setDanceOn(this.hearing); return; }
    this.choice.setHearing(this.hearing);
    this.applyTier();
  }
  setSample(sample: unknown): void {
    if (!this.lib || !musicSampleHeard(this.hearing, sample)) return;
    this.choice?.noteLevel(sample.rms);
    this.likeness?.update(sample);
    this.react?.hear(sample);
    this.reportVerdicts();
    if (sample.rms >= this.lib.MUSIC_AUDIBLE_RMS) this.loudAt = this.now();
    if (!this.danceOn) { if (this.nod?.active) this.nod.update(sample); return; }
    this.dance?.update(sample);
  }
  setSettings(settings: Partial<MusicSettings>): void {
    this.settings = normalizeMusicSettings(settings, this.settings ?? undefined);
    if (!this.lib) return;
    const always = this.settings.alwaysDance === true;
    if (!this.choice) {
      if (always) return;
      // First time: from "always" with what she hears now, so a dance already running carries on and is judged on the next frame.
      const created = new this.lib.MusicChoice();
      created.setAlways(true); created.setHearing(this.hearing);
      this.choice = created;
    }
    this.choice.setAlways(always);
    this.applyTier();
  }
  /** Developer test command: she judges again at the next frame. False: no music, or "一直跟着跳". */
  rejudge(): boolean { return this.choice?.rejudgeNow() ?? false; }
  setListenKindLine(line: string): void { this.listenKind = typeof line === 'string' ? line.slice(0, 200) : ''; }
  /** I-017: what her body is doing to the sound right now (reported to the host). */
  presence(): MusicPresence {
    const lib = this.lib;
    if (!lib) return OFF;
    return lib.musicPresence({ hearing: this.hearing, choice: this.choice ?? undefined, danceOn: this.danceOn, sinceLoudS: (this.now() - this.loudAt) / 1000,
      music: this.likeness?.music === true, beat: this.likeness?.score ?? 0, shown: this.shownShares() });
  }
  /** Developer line: her want to dance, the tier and why; is it music here; the host's kind (developer mode only). */
  line(view: MoodView | null): string {
    const lib = this.lib;
    return lib && view?.developerMode && this.choice ? [this.choice.getState().line, this.hearing ? lib.likenessLine(this.likeness?.getState()) : '', this.listenKind].filter(Boolean).join(' ｜ ') : '';
  }

  /** She dances, or the dance is still easing out (the old stage's gates.music: her own life and automatic motions give way). */
  get moving(): boolean { return this.danceOn || this.dance?.getState().releasing === true; }
  /** Something of the music shows (the frame pace stays full). */
  get active(): boolean { return this.showing || this.beatOut !== null || this.nodOut !== null; }
  /** This frame's listening look for procedural life, or null (nothing added). The nod is written by write() itself. */
  get beat(): Readonly<MusicNodOffsets> | null { return this.beatOut; }
  get yieldReason(): string | null { return this.reason; }
  getState() { return { hearing: this.hearing, danceOn: this.danceOn, reason: this.reason, tier: this.choice?.tier ?? null, dance: this.dance?.getState() ?? null, pose: this.pose,
    nod: this.nod?.getState() ?? null }; }

  /** One frame, before her body's: her choice, the song reactions, who the dance yields to, the dance and the nod for this frame. */
  frame(delta: number, env: WindowMusicEnv): void {
    const lib = this.lib, dance = this.dance;
    if (!lib || !dance) return;
    this.frameChoice(delta, env);
    this.frameReact(delta, env);
    const reason = musicYieldReason(env, this.danceOn), blocked = reason !== null && reason !== 'disabled';
    if (reason === 'hidden' && this.reason !== 'hidden') this.resetPresentation();
    dance.setSuppressed(blocked);
    this.nod?.setSuppressed(blocked); // the nod yields to what the dance yields to (R29b hand-off), then comes back
    this.suppressed = blocked; this.reason = reason;
    const strength = this.settings?.strength ?? 0.7;
    this.showing = false;
    if (this.danceOn || dance.getState().releasing) {
      // A yielding dance keeps running underneath and hands its share over (R29b); fully yielded, it writes nothing.
      this.pose = dance.frame(delta, strength);
      this.showing = !((!this.danceOn && !dance.getState().releasing) || (this.suppressed && !dance.getState().presence));
    }
    const nod = this.nod;
    this.nodOut = nod && nod.busy ? nod.frame(delta, strength) : null;
    const listen = this.listen?.active ? this.listen.frame(delta, strength) : null;
    if (!listen) { this.beatOut = null; return; }
    const sum = this.beatSum;
    sum.headX = listen.headX; sum.headZ = listen.headZ; sum.bodyZ = 0;
    this.beatOut = sum;
  }

  /** The window is not drawn: nothing is on screen, so the dance and the nod reset (the old stage's hidden). */
  notShown(): void {
    if (this.reason === 'hidden') return;
    this.reason = 'hidden'; this.suppressed = true;
    this.dance?.setSuppressed(true);
    this.resetPresentation();
  }

  /** The dance at the mixer level (the old stage's animateMusic writes). */
  write(port: UnderPort): void {
    const bones = this.bones;
    if (!bones) return;
    const n = this.nodOut;
    if (n) { if (bones.head) port.rotate(bones.head, n.headX, 0, n.headZ); if (bones.chest) port.rotate(bones.chest, 0, 0, n.bodyZ); }
    if (!this.showing) return;
    const p = this.pose;
    if (bones.center) { port.move(bones.center, 0, bones.height * p.bounce, 0); port.rotate(bones.center, 0, 0, p.sway); }
    if (bones.chest) port.rotate(bones.chest, 0, 0, p.chestRoll + (bones.center ? 0 : p.sway));
    if (bones.head) port.rotate(bones.head, p.headPitch, 0, p.headRoll);
  }
  readonly armsHeld = 0;

  dispose(): void { this.setEnabled(false); this.resetPresentation(); this.bones = null; }

  private setDanceOn(enabled: boolean): void {
    if (this.danceOn === enabled || !this.dance) return;
    this.danceOn = enabled;
    if (enabled) { try { this.ports.danceStarts?.(); } catch { /* the body motion's own */ } }
    if (enabled) this.dance.resume(); else this.dance.stop();
  }
  private applyTier(): void {
    const choice = this.choice;
    if (!choice) return;
    const tier = choice.tier;
    this.nod?.setActive(tier === 'nod');
    this.setDanceOn(tier === 'dance');
    if (tier !== this.reportedTier) {
      this.reportedTier = tier;
      try { this.ports.tier?.(tier, choice.isAlways ? null : choice.getState().score); } catch { /* a record never changes the dance */ }
    }
  }
  private frameChoice(delta: number, env: WindowMusicEnv): void {
    const choice = this.choice, lib = this.lib;
    if (!choice || !lib) return;
    // I-016: only what she recognizes as music is danced or nodded to; the beat analysis runs on underneath (music-dance.ts setHeld).
    const music = this.hearing && this.likeness?.music === true;
    choice.noteMusic(music); if (this.hearing) { this.dance?.setHeld(!music); this.nod?.setHeld(!music); }
    if (choice.isAlways) { choice.frame(delta); this.applyTier(); return; }
    const view = env.view, weights = view?.parameters?.weights, fatigue = view?.fatigue;
    const context: MusicChoiceContext = {
      playfulWeight: weights?.playful ?? 1, cautiousWeight: weights?.cautious ?? 1, playfulIntensity: view?.snapshot?.intensity?.playful ?? 50,
      mood: view?.snapshot?.primary, fatigue: fatigue ? { phase: fatigue.phase, F: fatigue.F, sleeping: fatigue.sleeping } : null, activity: view?.herLife?.activity,
      scope: view ? `${view.characterId}|${view.token}` : '', request: view?.danceRequest ?? null, songEnergy: this.likeness?.songEnergy ?? 0,
      nowMs: this.ports.wall?.() ?? Date.now(), expressive: view ? view.expressions === true : true,
    };
    choice.frame(delta, context);
    if (choice.takeListenCue()) { this.listenSide = -this.listenSide; (this.listen ??= new lib.MusicListenCue()).start(this.listenSide); }
    this.applyTier();
  }
  private frameReact(delta: number, env: WindowMusicEnv): void {
    const react = this.react, choice = this.choice, dance = this.dance;
    if (!react || !dance) return;
    const music = this.hearing && this.likeness?.music === true;
    react.step(delta, { view: env.view, choosing: !!choice && !choice.isAlways && this.hearing, music, tier: choice?.tier ?? 'none', shown: !this.suppressed,
      speaking: env.speaking, likeness: music ? this.likeness?.getState() : null, dance, nod: this.nod ?? undefined,
      face: () => this.ports.face(), hasFace: this.ports.hasFace(), told: (intent, scale) => { try { this.ports.told?.(intent, scale); } catch { /* a record */ } },
      taste: this.ports.taste?.(), memory: this.ports.memory?.() });
  }
  /** 2026-11-24: how much of the nod and of the dance is on her now (0..1; nothing while hidden or with no model to move). */
  private shownShares(): { nod: number; dance: number } {
    if (this.reason === 'hidden' || !this.bones) return { nod: 0, dance: 0 };
    const strength = this.settings?.strength ?? 0.7;
    return { nod: this.nod?.shownShare ?? 0, dance: (this.dance?.shownShare ?? 0) * Math.min(1, strength / MUSIC_SHOWN_STRENGTH) };
  }
  private reportVerdicts(): void {
    const flips = this.likeness?.takeFlips();
    if (flips?.length) for (const flip of flips) { try { this.ports.verdict?.(flip); } catch { /* a record never changes the music */ } }
  }
  private resetPresentation(): void {
    this.dance?.reset(); this.nod?.reset(); this.listen?.reset(); this.react?.reset();
    this.pose = ZERO_POSE; this.showing = false; this.beatOut = null; this.nodOut = null;
  }
}
