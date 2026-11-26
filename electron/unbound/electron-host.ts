/**
 * Unbound U1: the real ports for UnboundHost (Electron's screen, ipcMain and windows, the monitor-size reader, the full-screen
 * watcher), so electron/main.ts adds only a few lines: make it, mask the companion in sync(), forward the chat stream, quit.
 */
import { BrowserWindow, ipcMain, screen } from 'electron';
import type { UnboundControlView, UnboundState } from '../../shared/unbound/scene';
import type { UnboundTouchReport } from '../../shared/unbound/typing';
import type { DisplayFacts, Rect } from '../../shared/unbound/world';
import { readMonitorSizes } from './display-size';
import { WindowsFullscreenProbe } from './fullscreen-watch';
import type { UnboundMoodPorts } from './mood-bridge';
import type { UnboundGamesPorts } from './games-bridge';
import type { PetPort } from './mode';
import { unboundSource, type UnboundSource } from './source';
import { createUnboundWindow, loadUnboundPage, raiseUnboundWindow, type UnboundPageSource } from './window';
import type { GazeMoodSource } from '../../shared/senses';
import type { FrameTimeRow } from '../../shared/stage';
import type { LifeCue } from '../../shared/unbound/life/reactions';
import type { LifeJournalRow } from '../../shared/unbound/her-position';
import type { CompanyPorts } from './company/host';

import type { PeekMoodSource, PeekPorts } from './peek';
import type { CloseMomentPorts } from './close-moments';
import type { UnboundHost, UnboundWindowLike } from './host';
import type { UnboundIpcMain } from './host-ports';
import type { CompanyStage } from './company/stage';
import { buildUnboundStage, type StageParts } from './company/build';
export type { StageParts } from './company/build';


export { unboundSource };

export function primaryDisplayFacts(): DisplayFacts {
  const display = screen.getPrimaryDisplay();
  return { bounds: { ...display.bounds }, workArea: { ...display.workArea }, scaleFactor: display.scaleFactor, internal: display.internal === true };
}

export function asUnboundWindow(win: BrowserWindow): UnboundWindowLike {
  const gone: (() => void)[] = [];
  let fired = false;
  const fire = () => { if (fired) return; fired = true; for (const callback of gone.splice(0)) { try { callback(); } catch (error) { console.error(error); } } };
  win.once('closed', fire);
  win.webContents.on('render-process-gone', () => { fire(); if (!win.isDestroyed()) win.destroy(); });
  return {
    get webContents() { return win.webContents; },
    isDestroyed: () => win.isDestroyed(),
    isVisible: () => !win.isDestroyed() && win.isVisible(),
    showInactive: () => { if (!win.isDestroyed()) win.showInactive(); },
    hide: () => { if (!win.isDestroyed()) win.hide(); },
    raise: () => raiseUnboundWindow(win), // I-199: only on a full-screen program's arrival
    destroy: () => { if (!win.isDestroyed()) win.destroy(); },
    setIgnoreMouseEvents: (ignore, options) => { if (!win.isDestroyed()) win.setIgnoreMouseEvents(ignore, options); },
    setBounds: (bounds: Rect) => { if (!win.isDestroyed()) win.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) }); },
    onGone: callback => { if (fired) queueMicrotask(callback); else gone.push(callback); },
  };
}

export interface UnboundWiring {
  page: UnboundPageSource;
  pet(): PetPort | null;
  petWanted(): boolean;
  developerMode(): boolean;
  /** The normal way in is on (shared/foundation/channel-defaults.ts); absent: on. */
  entryAllowed?(): boolean;
  source(): UnboundSource;
  reviewed(): Promise<boolean>;
  /** Her default stand when the companion has no pose layer: the bundled stand pose's asset URL (host.ts restPose). */
  restPose?(): Promise<string | null>;
  restored(): void;
  /** How long a finished full-screen bubble stays (the companion window's decision; electron/unbound/bubble-linger.ts). */
  lingerMs?(text: string): number;
  publish(view: UnboundControlView): void;
  /** Unbound v1 step 1: every state change (the tray label, the companion window told again, the permission bundle). */
  modeChanged?(state: UnboundState): void;
  /** Unbound v1 step 2: she was clicked (electron/unbound/typing.ts). */
  touch?(report: UnboundTouchReport): void;
  /** Step 5c: a pull's report (electron/wiring/unbound-wiring.ts: reportTouch with kind 'pull', place 'unbound'). */
  pull?(report: Record<string, unknown>): void;
  /** I-154 follow-up: her mood view and a direct touch's mood input (electron/unbound/mood-bridge.ts). */
  mood?: UnboundMoodPorts;
  /** Batch B: the game hosts' methods for her games out here (electron/unbound/games-bridge.ts), read when a request comes. */
  games?(): UnboundGamesPorts | undefined;
  /** U2 (electron/unbound/peek.ts): what the app already knows, read for the peek. Absent: she never peeks. */
  peek?: UnboundPeekWiring;
  /** Step 4 (electron/unbound/life.ts): her own life reads the peek's readings and these. Absent: no life of her own. */
  life?: UnboundLifeWiring;
  /** I-184 (electron/unbound/close-moments.ts): what her close moments read and write. Absent: only the look, as before. */
  close?: UnboundCloseWiring;
  /** I-209 step 1 (electron/unbound/company/host.ts): the cards, the one you talk with, an extra's model. Absent: nobody else comes out. */
  company?: CompanyPorts;
  /** I-209 step 3: what each other character on stage reads as her own; absent: nobody else comes out as her own full screen. */
  stage?: StageCharacterWiring;
  /** I-209 step 3: which character a reply belongs to (the brain's turn owner), so its bubble goes to her window; absent: the first one's. */
  replyOwner?(replyId: string): string | null;
}
/** I-209 step 3: one other character's own readings and writes on stage (electron/wiring/unbound-wiring.ts gives them). */
export interface StageCharacterWiring {
  /** Her mood view and a touch's mood input on her page (absent: refused). */
  mood(id: string): UnboundMoodPorts | undefined;
  /** Her mood as her movement reads it. */
  peekMood(id: string): PeekMoodSource | null;
  /** What her close moments read and write (her mood, her stage, her journal rows). */
  close(id: string): UnboundCloseWiring | undefined;
  /** One journal row of her life (a go-word, a walk that ended), as hers. */
  journal(id: string, row: LifeJournalRow): void;
  /** 2026-11-24 (docs/claude/2026-11-24-stage-smooth.md): one page's frame times of the last minute, as a checked row, for the experience journal (`id`: her card; null: not known). */
  frames?(id: string | null, row: FrameTimeRow): void;
  /** 2026-11-25 (docs/claude/2026-11-25-stage-mouth-height.md): one page's mouth while she read one reply, as a 'mouth-reading' row under her id (null: not known, nothing written). */
  mouth?(id: string | null, sentences: unknown[]): void;
  /** I-209 step 4: a pull of hers ended or holds (her page's report): her own mood moves as the first one's does (absent: nothing). */
  pull?(id: string, report: Record<string, unknown>): void;
}
/** I-184: read only, except the mood moment and the turn line's item. */
export type UnboundCloseWiring = Pick<CloseMomentPorts, 'view' | 'typing' | 'playing' | 'moment' | 'happened'> & Partial<Pick<CloseMomentPorts, 'pulling' | 'arms' | 'dropHand'>>
  & Pick<PeekPorts, 'notes' | 'sequence'>; // 2026-11-23: a missed kiss / hug and your interruptions (journal, her next turn); her words after a kiss / hug wait
/**
 * Step 4: the raw readings her free time may look at (each goes through shared/unbound/life/signals.ts, which keeps only what it
 * lists). All memory only, all already on: nothing here starts a sense.
 */
export interface UnboundLifeWiring {
  /** 「知道你是不是在忙」's state word (busy / pause / away / unknown). */
  activityState(): unknown;
  /** The pose sensing's latest signal (null when it does not run). */
  pose(): unknown;
  /** The screen-sharing reading of the program in front, as its activity word only (null without sharing). */
  activity(): unknown;
  /** When the voiceprint last passed your voice with no name and no call (ms), or null. */
  talkedAt(): number | null;
  /** The computer's sound kind word. */
  sound(): unknown;
  /** Her voice is reading now (replySpeechBusy() || speechPlaybackActivity.busy). */
  readingAloud(): boolean;
  /** Her small input box is open. */
  typing(): boolean;
  /** Her mood view, for I-081's gaze attention. */
  gazeMood(): GazeMoodSource | null;
  /** A cue she noticed (the interaction history; kinds and a duration only). */
  noticed?(cue: LifeCue): void;
  /** You talked, not to her (the fact), or you answered her coming closer: for the interaction history. */
  happened?(kind: 'talked' | 'answered' | 'pulled-along'): void;
  /** Batch B: a game, an offer or her reach for your hand is on (you are playing with her: her own life gives way). */
  playing?(): boolean;
  /** I-193: one row per go-word of hers and per walk that ended (the journal; closed words and metres). */
  journal?(row: LifeJournalRow): void;
  /** The profile folder (her saved place); null: not kept. */
  directory(): string | null;
}
export interface UnboundPeekWiring {
  /** 「知道你是不是在忙」's idle reading (I-006; null when the switch is off, the screen locked, asleep or pretending). */
  activityIdleSeconds(): number | null;
  mood(): PeekMoodSource | null;
  asleep(): boolean;
  inCall(): boolean;
  userTalking(): boolean;
  lastInteractionAt(): number | null;
  /** The small O lift when you answered her (mood moments 'peek-answered'). */
  answered(): boolean;
}

/** The host with Electron's real pieces (the first one on stage; I-209 step 3: createUnboundStage also makes the others). */
export function createUnboundHost(wiring: UnboundWiring): UnboundHost { const made = createUnboundStage(wiring); stages.set(made.host, made.stage); return made.host; }
const stages = new WeakMap<UnboundHost, CompanyStage>();
/** I-209 step 3: the stage coordinator made with this host (null: none, e.g. a host made by hand in a test). */
export function stageOf(host: UnboundHost | null): CompanyStage | null { return host ? stages.get(host) ?? null : null; }

/**
 * The first one's host and the stage coordinator (I-209 step 3, electron/unbound/company/build.ts and stage.ts) with Electron's real pieces.
 * Display changes follow the primary display's work area, for everyone on stage.
 */
export function createUnboundStage(wiring: UnboundWiring): { host: UnboundHost; stage: CompanyStage } { return buildUnboundStage(wiring, electronParts(wiring)); }

function electronParts(wiring: UnboundWiring): StageParts {
  return {
    ipcMain: ipcMain as unknown as UnboundIpcMain, fullscreen: new WindowsFullscreenProbe(), measure: () => readMonitorSizes(), display: primaryDisplayFacts,
    open: bounds => { const win = createUnboundWindow(bounds, wiring.page); return { window: asUnboundWindow(win), loaded: loadUnboundPage(win, wiring.page) }; },
    displayChanged: changed => { screen.on('display-metrics-changed', changed); screen.on('display-removed', changed); screen.on('display-added', changed); },
  };
}
