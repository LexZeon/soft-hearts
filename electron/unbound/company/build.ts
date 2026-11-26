/**
 * I-209 step 3 (docs/claude/2026-11-24-i209-step3-instances.md): the full-screen stage made from the app's wiring, without Electron itself
 * (electron/unbound/electron-host.ts hands the real ipcMain, windows, watcher and display; tests hand fakes). The first one's host and,
 * through the coordinator (stage.ts), every other one's: the same UnboundHost, her own ports (instance-ports.ts), her own window and ipc
 * port (ipc-fanout.ts). Moved here with them: the peek's, life's and close moments' ports from the wiring, and the saved place store
 * (moved out of electron-host.ts unchanged).
 */
import type { DisplayFacts, MonitorMeasurement, Rect } from '../../../shared/unbound/world';
import { placementAcross } from '../../../shared/unbound/world';
import type { FullscreenProbe } from '../fullscreen-watch';
import { UnboundHost, type UnboundWindowLike } from '../host';
import type { UnboundHostPorts, UnboundIpcMain } from '../host-ports';
import { peekMoodFrom, type PeekPorts } from '../peek';
import type { LifePorts } from '../life';
import { UnboundPlaceStore, UNBOUND_DEFAULT_PLACE_FILE } from '../place-store';
import { CloseMomentsHost } from '../close-moments';
import type { UnboundCloseWiring, UnboundLifeWiring, UnboundPeekWiring, UnboundWiring } from '../electron-host';
import { CompanyStage, MAIN_KEY, type StageInstance } from './stage';
import { IpcFanout } from './ipc-fanout';
import { SharedFullscreen, SharedLook } from './shared-senses';
import { SharedPlaceBook } from './place-share';
import { closeBlocked, instancePorts, oneCloseAtATime, ownedWindow } from './instance-ports';
import { firstBubbleProof, shareBubbleProof } from './voice-proof';

/** Step 4: her saved place in the profile (read when she first comes out, written after her walks). */
function savedPlaceStore(life: UnboundLifeWiring | undefined, file?: string) {
  let store: UnboundPlaceStore | null = null;
  const get = () => { if (store) return store; const directory = life?.directory() ?? null; return directory ? (store = new UnboundPlaceStore(directory, {}, file)) : null; };
  // 2026-11-25: the write's own promise goes back (a failed write is told to the keeper, which tells the panel); nobody is left holding it unhandled
  return life ? { load: () => get()?.load() ?? Promise.resolve(null), save: (place: Parameters<UnboundPlaceStore['save']>[0]) => get()?.save(place) ?? Promise.reject(new Error('no profile folder')),
    clear: () => get()?.clear() ?? Promise.reject(new Error('no profile folder')) } : undefined;
}

/**
 * The peek's ports. Idle seconds come only from what 「知道你是不是在忙」 already reads (when she may come up to the lens). Nothing reads your
 * input during a peek any more (2026-11-23: the mouse, typing and the keys never end an action; shared/unbound/action-ends).
 */
function peekPorts(wiring: UnboundPeekWiring) {
  return {
    clock: () => Date.now(), random: () => Math.random(),
    idleSeconds: () => wiring.activityIdleSeconds(),
    asleep: () => wiring.asleep(), inCall: () => wiring.inCall(), userTalking: () => wiring.userTalking(),
    mood: () => peekMoodFrom(wiring.mood()), lastInteractionAt: () => wiring.lastInteractionAt(), answered: () => wiring.answered(),
    every: (ms: number, run: () => void) => { const timer = setInterval(run, ms); timer.unref?.(); return () => clearInterval(timer); },
  };
}

/** Step 4: her own life's ports: the peek's readings and the life wiring's, nothing else. */
function lifePorts(peek: UnboundPeekWiring, life: UnboundLifeWiring): LifePorts {
  return {
    clock: () => Date.now(), random: () => Math.random(),
    readings: () => ({ idleSeconds: peek.activityIdleSeconds(), state: life.activityState(), pose: life.pose(), activity: life.activity(), talkedAt: life.talkedAt(), sound: life.sound() }),
    asleep: () => peek.asleep(), inCall: () => peek.inCall(), waiting: () => peek.userTalking(), typing: () => life.typing(), readingAloud: () => life.readingAloud(),
    mood: () => peekMoodFrom(peek.mood()), gazeMood: () => life.gazeMood(), lastInteractionAt: () => peek.lastInteractionAt(), answered: () => peek.answered(),
    noticed: cue => life.noticed?.(cue), happened: kind => life.happened?.(kind), playing: () => life.playing?.() === true, journal: row => life.journal?.(row),
    every: (ms: number, run: () => void) => { const timer = setInterval(run, ms); timer.unref?.(); return () => clearInterval(timer); },
  };
}

/** I-184: her close moments read the peek's mood reading and the close wiring; nothing else. */
function closePorts(peek: UnboundPeekWiring, close: UnboundCloseWiring | undefined): CloseMomentsHost | undefined {
  return close ? new CloseMomentsHost({ ...close, clock: () => Date.now(), random: () => Math.random(), mood: () => peekMoodFrom(peek.mood()) }) : undefined;
}

/** I-209 step 3: the peek's ports for one character (her mood; her close moments, one at a time on stage). */
function peekFor(wiring: UnboundWiring, peek: UnboundPeekWiring, close: UnboundCloseWiring | undefined, busy: () => boolean): PeekPorts {
  const moments = closePorts(peek, close);
  return { ...peekPorts(peek), readingAloud: () => wiring.life?.readingAloud() ?? false, close: moments ? oneCloseAtATime(moments, busy) : undefined, notes: close?.notes, sequence: close?.sequence }; // step 4: reading aloud counts as speaking; I-184; 2026-11-23
}

/**
 * The first one's host and the stage coordinator (I-209 step 3, electron/unbound/company/stage.ts): every other character on stage is made
 * here too, the same UnboundHost with her own ports (company/instance-ports.ts), her own window and her own ipc port (company/ipc-fanout.ts).
 * What they share is made once: the full-screen watcher, the monitor measurement, the place books, the readings her life looks at.
 * Display changes follow the primary display's work area, for everyone on stage.
 */
export function buildUnboundStage(wiring: UnboundWiring, parts: StageParts): { host: UnboundHost; stage: CompanyStage } {
  const fanout = new IpcFanout(parts.ipcMain), mainPort = fanout.port();
  const fullscreen = new SharedFullscreen(parts.fullscreen);
  let measuring: Promise<MonitorMeasurement[] | null> | null = null;
  const measure = () => measuring ??= parts.measure().catch(() => { measuring = null; return null; });
  const rawOpen = parts.open;
  const current = () => { try { return wiring.company?.current() ?? null; } catch { return null; } };
  const lastFile = savedPlaceStore(wiring.life), fixedFile = savedPlaceStore(wiring.life, UNBOUND_DEFAULT_PLACE_FILE);
  const lastBook = lastFile ? new SharedPlaceBook(lastFile, current) : null, fixedBook = fixedFile ? new SharedPlaceBook(fixedFile, current) : null;
  const readings = new SharedLook<unknown>(() => null, Date.now, 900); // her life's readings, taken once a second for everyone on stage
  const lifeOf = (peek: UnboundPeekWiring, life: UnboundLifeWiring): LifePorts => { const ports = lifePorts(peek, life), read = ports.readings; return { ...ports, readings: () => readings.now(read) as ReturnType<LifePorts['readings']> }; };
  let stage!: CompanyStage;
  // The cards' names, for the box of the one you clicked ("对 A 说点什么…"); read again whenever who is on stage changes.
  const names = new Map<string, string>();
  const readNames = () => { void Promise.resolve().then(() => wiring.company?.cards() ?? []).then(cards => { names.clear(); for (const card of cards) names.set(card.id, card.name); }, () => {}); };
  const ports: UnboundHostPorts = {
    ipcMain: mainPort.ipcMain,
    // no-pet-ok: the host ports' existing names for the companion window
    pet: wiring.pet, petWanted: wiring.petWanted, developerMode: wiring.developerMode, source: wiring.source, reviewed: wiring.reviewed, restPose: wiring.restPose,
    ...(parts.preview ? { preview: parts.preview } : {}), display: parts.display, measure, openWindow: ownedWindow(rawOpen, mainPort, win => stage.opened(MAIN_KEY, win)), fullscreen: fullscreen.probeFor(),
    restored: wiring.restored, lingerMs: wiring.lingerMs, entryAllowed: wiring.entryAllowed, publish: wiring.publish, pull: wiring.pull, mood: wiring.mood, games: wiring.games,
    modeChanged: state => { stage.mainChanged(state); wiring.modeChanged?.(state); },
    touch: report => { stage.address(MAIN_KEY); wiring.touch?.(report); }, // I-209 step 3: you clicked the first one: your words go to her
    peek: wiring.peek ? peekFor(wiring, wiring.peek, wiring.close, () => stage.closeBusy(MAIN_KEY)) : undefined,
    life: wiring.peek && wiring.life ? lifeOf(wiring.peek, wiring.life) : undefined,
    ...(lastBook ? { savedPlace: lastBook.portFor(current, true) } : {}), ...(fixedBook ? { defaultPlace: fixedBook.portFor(current, true) } : {}),
    company: wiring.company ? { ...wiring.company, present: ids => { wiring.company?.present?.(ids); readNames(); stage.sync(ids); }, addressee: () => stage.addresseeId() } : undefined,
  };
  const host = new UnboundHost(ports);
  if (host.peek) host.peek.arbiter = closeBlocked(host.peek.arbiter, () => stage.closeBusy(MAIN_KEY));
  const make = async (id: string): Promise<StageInstance | null> => {
    const model = await Promise.resolve().then(() => wiring.company?.model(id) ?? null).catch(() => null), character = wiring.stage;
    if (!model || !character) return null;
    const port = fanout.port(), busy = () => stage.closeBusy(id);
    const peek: UnboundPeekWiring | undefined = wiring.peek ? { ...wiring.peek, mood: () => character.peekMood(id) } : undefined;
    const extra = new UnboundHost(instancePorts({ base: ports, openWindow: rawOpen, id, model, port, opened: win => stage.opened(id, win), changed: state => stage.extraChanged(id, state),
      touch: report => { stage.address(id); wiring.touch?.(report); }, fullscreen: fullscreen.probeFor(), mood: character.mood(id),
      peek: peek ? peekFor(wiring, peek, character.close(id), busy) : undefined,
      life: peek && wiring.life ? lifeOf(peek, { ...wiring.life, gazeMood: () => character.peekMood(id), journal: row => character.journal(id, row), noticed: undefined, happened: undefined }) : undefined,
      places: { last: lastBook?.portFor(() => id, false), fixed: fixedBook?.portFor(() => id, false) }, ...(character.pull ? { pull: (report: Record<string, unknown>) => character.pull!(id, report) } : {}) }));
    if (extra.peek) extra.peek.arbiter = closeBlocked(extra.peek.arbiter, busy);
    shareBubbleProof(extra, prove, line => stage.windowOf(line) === id); // stage voice: her page's paint proves her lines for the one voice
    extra.her.clearStart = (at, frame) => stage.clearOf(id, at, { minX: placementAcross(frame, 0.07, at.depthM).xM, maxX: placementAcross(frame, 0.93, at.depthM).xM });
    return { host: extra, port };
  };
  stage = new CompanyStage({ primary: () => host, primaryPort: mainPort, primaryId: current, make, replyOwner: wiring.replyOwner, clock: Date.now, name: id => names.get(id) ?? null,
    frames: (key, row) => wiring.stage?.frames?.(key === MAIN_KEY ? current() : key, row), // 2026-11-24: her frame times, once a minute, for the journal
    mouth: (key, sentences) => wiring.stage?.mouth?.(key === MAIN_KEY ? current() : key, sentences), // 2026-11-25: her mouth per reply, under her id
    setTimer: (run, ms) => { const timer = setTimeout(run, ms); timer.unref?.(); return timer; }, clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) });
  host.speechTo = replyId => stage.speechTo(replyId);
  const prove = firstBubbleProof(host, line => stage.windowOf(line) === MAIN_KEY); // stage voice: each page proves only its own lines (voice-proof.ts)
  fullscreen.after = () => stage.world.restack(); // a full-screen program's arrival raised each window: back in depth order
  const changed = () => { host.displayChanged(); for (const key of stage.keys()) if (key !== MAIN_KEY) stage.hostOf(key)?.displayChanged(); };
  parts.displayChanged?.(changed);
  return { host, stage };
}

/** What buildUnboundStage takes from Electron (tests hand fakes): ipcMain, her windows, the full-screen watcher, the monitor sizes, the display. */
export interface StageParts {
  ipcMain: UnboundIpcMain;
  open(bounds: Rect): { window: UnboundWindowLike; loaded: Promise<void> };
  fullscreen?: FullscreenProbe;
  measure(): Promise<MonitorMeasurement[] | null>;
  display(): DisplayFacts;
  /** Display changes: the windows follow the work area. */
  displayChanged?(changed: () => void): void;
  /** Smoke runs only: every window a small one showing the whole screen scaled (the host ports' preview). */
  preview?: { bounds: Rect };
}
