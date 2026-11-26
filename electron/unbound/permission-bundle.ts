/**
 * Unbound v1 step 1 (I-136, docs/claude/2026-11-15-unbound-v1-step1-entry.md): the permission bundle. Turning Unbound on means
 * so after one page that lists every sense and what she uses it for, the ones
 * that are off are turned on together; when she goes back to the small window they go back to what they were.
 *
 * The rules, small enough to test:
 *  - Only items that were off are turned on ("attempted"); items already on are never touched, now or on the way back.
 *  - Each change goes through the user's own switches' host paths (electron/safety/agent-channel/bridge.ts createPerceptionSwitches),
 *    so refusals (a missing component), indicators and the face check's own records behave as when the user clicks.
 *  - The face check is turned on only when its components are already installed: turning it on otherwise starts a download,
 *    and a download is the user's own step in its settings. Not enrolled yet: it is turned on and does nothing until they enrol.
 *  - While she is out every item stays on (I-159 A: "unbound暂时只做全开权限"): any item read off again (the
 *    user's click, a voice turn ending, a stopped reply) is turned on again, the items that were on before entering included; the
 *    face check only while its components are installed (never a download from here). `keptOnWhileOut` is the one place to change
 *    when parts may be switched off in Unbound later. The window's own settings are separate:
 *    going back puts them as they were. Right after turning on, each attempted item's value is its baseline (for the report only).
 *  - Going back turns every untouched attempted item off with the switch's own "off" (which also clears side effects, such as
 *    the rhythm that stays on when 和她一起听 had no words). It waits (up to a minute) for a reply being written to finish,
 *    because turning screen sharing off ends a running reply by design.
 *  - The session is saved before anything is turned on and removed after the way back, so if the app dies while she is out the
 *    next start puts back what outlives a restart (only the face check: camera, microphone, screen and the computer's sound
 *    start off with every run). Quitting while she is out does the same for the face check at once.
 *  - 「发图片」 (camera pictures to Claude, `images`) is an item like the others since 2026-11-20 (it had been missing from the bundle;
 *    docs/claude/2026-11-20-bundle-camera-images.md). Its own switch
 *    starts off with every run, so it is not persistent. A "别看" holds its pictures without turning the switch off, so the bundle
 *    reads it as on and never undoes a "别看".
 *  - 2026-11-24 (user: "保留"): what the USER switched on by hand while she is out is not the bundle's to put back. An item that was off
 *    after the bundle's own steps and is on again with no step of the bundle's behind it (settings, 「◉」, her, the user's own Claude), and
 *    「和她一起看」 beginning on its own account (a begin the bundle did not cause; `watchBegan`), are kept: screen and computer's sound stay
 *    for the way back. The user switching 一起看 off (`watchEnded(true)`) or an item off drops the keep. At the way back an item is kept
 *    only while it still reads on (permission revoked, her window gone off the screen: the host already stopped it, nothing is kept).
 *    What the bundle turned on and the user did not touch goes back as before. `kept` hears what was kept (one journal row).
 * Not in the bundle and never touched: paid voice (百炼), Claude task execution, keys, read-aloud.
 */
import { ASSISTANT_NAME } from '../../shared/foundation/assistant-name';
export type BundleItem = 'camera' | 'images' | 'microphone' | 'screen' | 'listen' | 'face';
export const BUNDLE_ITEMS: readonly BundleItem[] = Object.freeze(['camera', 'images', 'microphone', 'screen', 'listen', 'face']);
/** Items whose switch outlives a restart (the others start off with every run). */
export const PERSISTENT_ITEMS: readonly BundleItem[] = Object.freeze(['face']);
/**
 * I-159 A: which items stay on while she is out. All of them now; the face check only when its components are installed (turning
 * it on otherwise starts a download, which is the user's own step). Later "turn off some parts in Unbound" changes only this.
 */
export function keptOnWhileOut(item: BundleItem, face: FaceReadiness): boolean { return item !== 'face' || face.installed; }
/** Re-opening one item that keeps going off (a missing component, a refusal) is tried this many times in a row, then left for the stay. */
export const REOPEN_TRIES = 3;

/** What the page lists. A different list asks again even after 「以后直接进，不再问」. */
export const BUNDLE_SIGNATURE = 'unbound-bundle-2:camera-pose,camera-images,microphone,screen,listen-music,face-check';

export type BundleFacts = Record<BundleItem, boolean>;
export interface FaceReadiness { supported: boolean; installed: boolean; enrolled: number }

/** The facts the internal channel reads (electron/safety/agent-channel/app-tools.ts PerceptionFacts), at the bundle's levels. */
export function bundleFactsFrom(facts: { cameraPose?: boolean; cameraImages?: boolean; faceCheck?: boolean; microphone: boolean; screen: boolean; systemAudio: { music: boolean; movie: boolean } }): BundleFacts {
  return {
    camera: facts.cameraPose === true, // 「姿势识别」 (local only): what she needs to notice and look at you
    images: facts.cameraImages === true, // 「发图片」: she sees you, pictures go to Claude (a "别看" holds them and leaves this on)
    microphone: facts.microphone === true,
    screen: facts.screen === true,
    listen: facts.systemAudio.music === true || facts.systemAudio.movie === true, // 「和她一起听」, as its own switch reads it
    face: facts.faceCheck === true,
  };
}

/**
 * Which of the user's own switches an item is (electron/safety/agent-channel/bridge.ts PerceptionSwitches.set). 和她一起听: on is the
 * music cell, as its own switch does; off is every computer's-sound cell (which also stops the rhythm).
 */
export function bundleSwitch(item: BundleItem, on: boolean): { kind: 'camera_pose' | 'camera_images' | 'microphone' | 'screen' | 'system_audio' | 'face_check'; purposes: ('music' | 'movie')[] } {
  if (item === 'listen') return { kind: 'system_audio', purposes: on ? ['music'] : ['music', 'movie'] };
  return { kind: item === 'camera' ? 'camera_pose' : item === 'images' ? 'camera_images' : item === 'face' ? 'face_check' : item, purposes: [] };
}

/** The face check's view (shared/senses/face-check.ts) → what the bundle needs to know. */
export function faceReadinessFrom(view: { phase: string; enrolled: number } | null | undefined): FaceReadiness {
  if (!view || view.phase === 'unsupported') return { supported: false, installed: false, enrolled: 0 };
  return { supported: true, installed: view.phase === 'idle' || view.phase === 'starting' || view.phase === 'ready', enrolled: Math.max(0, view.enrolled | 0) };
}

// ---- the page -----------------------------------------------------------------------------------------------------------

export interface BundleDialog { title: string; message: string; detail: string; checkbox: string; confirm: string; cancel: string }
type Translate = (text: string, params?: Record<string, string>) => string;
const same: Translate = (text, params = {}) => text.replace(/\{(\w+)\}/g, (marker, name: string) => params[name] ?? marker);

export const BUNDLE_LINES: Readonly<Record<BundleItem, string>> = Object.freeze({
  camera: '摄像头（姿势识别）：看你在不在、有没有看她，她会注意到你、抬头看你。只在这台电脑上识别，画面不离开电脑、不保存。',
  images: `摄像头（发图片）：她能通过摄像头看到你，看你时画面会发给 ${ASSISTANT_NAME}。只在她出来时开着，回到小窗就恢复成你进来前的样子。`,
  microphone: '麦克风：你可以直接开口跟她说话。你的声音在本机转成文字，录音不保存。',
  screen: '屏幕：她能看看你在做什么。',
  listen: '电脑的声音：和你一起听歌、看剧。',
  face: '认出是不是你（Beta）：用摄像头在这台电脑上认你的脸，看到不是你时她会知道。',
});
/** Short names, for "these did not open". */
export const BUNDLE_NAMES: Readonly<Record<BundleItem, string>> = Object.freeze({
  camera: '摄像头（姿势识别）', images: '摄像头（发图片）', microphone: '麦克风', screen: '屏幕', listen: '电脑的声音', face: '认出是不是你（Beta）',
});
export const BUNDLE_COPY = Object.freeze({
  title: '让她出来',
  message: '让她出来，在你的电脑上生活',
  intro: '她会离开桌宠小窗，站到屏幕后面的世界里。为了让她在你的电脑上生活，下面这些会一起打开：',
  on: '（已经开着）',
  faceNotInstalled: '（认脸组件还没下载。这里不会替你下载，这一项先不开；想用的话在设置的「隐私」里打开它）',
  faceNotEnrolled: '（你还没登记自己的脸，登记之前它什么都不做）',
  restore: '她在外面时，这些一直开着（暂时不能单独关）；回到小窗时，会恢复成你进来前的设置，任何一项随时都能在设置里自己关掉。',
  untouched: `花钱的语音（百炼）、${ASSISTANT_NAME} 任务执行和密钥不会因为这里打开；你本来开着的朗读，照常用。`,
  back: '随时按 Ctrl+Alt+U、点托盘或控制窗口里的「回到小窗」，她就回来。',
  checkbox: '以后直接进，不再问',
  confirm: '让她出来',
  cancel: '取消',
  openedNote: '这次打开了：{items}。她在外面时一直开着，回小窗后恢复。',
  notOpenedTitle: '她出来了',
  notOpened: '这几样没打开：{items}。可能缺少本机组件，或者还没设置好；可以在设置的「输入与共享」和「隐私」里看看。',
  failedTitle: '她没能出来',
  failedSenses: '这次没有替你打开摄像头、麦克风、屏幕或电脑的声音（它们只在她出来以后才开）；你自己原来开着的，照旧开着。',
});

/**
 * An entry the user confirmed ended before she was out (docs/claude/2026-11-19-unbound-entry-load.md): what happened (the host's
 * reason) and where the senses stand. The bundle only turns on once she is out, so a failed entry has turned nothing on.
 */
export function failedNotice(reason: string | null, translate: Translate = same): { title: string; detail: string } {
  const senses = translate(BUNDLE_COPY.failedSenses);
  return { title: translate(BUNDLE_COPY.failedTitle), detail: reason ? `${reason}\n\n${senses}` : senses };
}

/** The notice after entering when something did not open (null: everything asked for is on). */
export function notOpenedNotice(outcome: BundleOutcome, translate: Translate = same): { title: string; detail: string } | null {
  if (!outcome.notOpened.length) return null;
  const items = outcome.notOpened.map(item => translate(BUNDLE_NAMES[item])).join(translate('、'));
  return { title: translate(BUNDLE_COPY.notOpenedTitle), detail: translate(BUNDLE_COPY.notOpened, { items }) };
}

/**
 * I-159 D: the one line beside her after entering: what this entry really turned on (the ones that were
 * already on, or did not open, are not named). Null when nothing was turned on. With 「以后直接进，不再问」 ticked there is no page,
 * so this line is how the user finds out.
 */
export function openedNote(outcome: BundleOutcome, translate: Translate = same): string | null {
  if (!outcome.opened.length) return null;
  const items = outcome.opened.map(item => translate(BUNDLE_NAMES[item])).join(translate('、'));
  return translate(BUNDLE_COPY.openedNote, { items });
}

/** The page's text from what is on now. Lines only: no setting is read beyond the bundle's own items. */
export function bundleDialog(facts: BundleFacts | null, face: FaceReadiness, translate: Translate = same): BundleDialog {
  const lines: string[] = [];
  for (const item of BUNDLE_ITEMS) {
    if (item === 'face' && !face.supported) continue;
    let note = '';
    if (facts?.[item]) note = translate(BUNDLE_COPY.on);
    else if (item === 'face' && !face.installed) note = translate(BUNDLE_COPY.faceNotInstalled);
    else if (item === 'face' && face.enrolled === 0) note = translate(BUNDLE_COPY.faceNotEnrolled);
    lines.push(`· ${translate(BUNDLE_LINES[item])}${note}`);
  }
  const detail = [translate(BUNDLE_COPY.intro), '', ...lines, '', translate(BUNDLE_COPY.restore), translate(BUNDLE_COPY.untouched), translate(BUNDLE_COPY.back)].join('\n');
  return { title: translate(BUNDLE_COPY.title), message: translate(BUNDLE_COPY.message), detail, checkbox: translate(BUNDLE_COPY.checkbox),
    confirm: translate(BUNDLE_COPY.confirm), cancel: translate(BUNDLE_COPY.cancel) };
}

// ---- the session ----------------------------------------------------------------------------------------------------------

/** Saved while she is out (profile file, electron/unbound/entry-store.ts): enough to put things back after a crash. */
export interface BundleSession {
  signature: string;
  /** Items that were off and were turned on by the bundle. */
  attempted: BundleItem[];
  /** Each attempted item's value right after turning on (false: it did not open). */
  baseline: Partial<Record<BundleItem, boolean>>;
  /** Items whose value changed after that: they keep what they are. */
  touched: BundleItem[];
}

const isItem = (value: unknown): value is BundleItem => typeof value === 'string' && (BUNDLE_ITEMS as readonly string[]).includes(value);
/** A saved session, checked (closed shape; anything else counts as none). */
export function parseBundleSession(value: unknown): BundleSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== 'attempted,baseline,signature,touched') return null;
  if (typeof v.signature !== 'string' || v.signature.length > 200) return null;
  if (!Array.isArray(v.attempted) || !v.attempted.every(isItem) || !Array.isArray(v.touched) || !v.touched.every(isItem)) return null;
  if (!v.baseline || typeof v.baseline !== 'object' || Array.isArray(v.baseline)) return null;
  const baseline: Partial<Record<BundleItem, boolean>> = {};
  for (const [key, flag] of Object.entries(v.baseline as Record<string, unknown>)) {
    if (!isItem(key) || typeof flag !== 'boolean') return null;
    baseline[key] = flag;
  }
  return { signature: v.signature, attempted: [...new Set(v.attempted)], baseline, touched: [...new Set(v.touched)] };
}

export interface BundleOutcome {
  alreadyOn: BundleItem[];
  opened: BundleItem[];
  /** Tried, still off (a missing component, the recognizer not set up…). */
  notOpened: BundleItem[];
  /** Not tried (the face check without its components). */
  skipped: BundleItem[];
}

export interface BundlePorts {
  /** What is on now; throws when it cannot be read (then nothing is decided from it). */
  read(): BundleFacts;
  face(): FaceReadiness;
  /** The user's own switch for this item, on or off. */
  set(item: BundleItem, on: boolean): Promise<void>;
  /** null removes the saved session. */
  save(session: BundleSession | null): Promise<void>;
  /** A reply is being written (turning screen sharing off would end it). */
  replyRunning(): boolean;
  every(ms: number, run: () => void): () => void;
  wait(ms: number): Promise<void>;
  log?(line: string): void;
  /** What stayed on at the way back because the user turned it on by hand while she was out. */
  kept?(items: BundleItem[]): void;
  now?(): number;
}

/** A change seen within this long of the bundle's own switching on is the bundle's (a begin of 一起看 follows its screen by up to a tick). */
export const OWN_STEP_QUIET_MS = 3_000;
/** 「和她一起看」 is these two items on together. */
const WATCH_ITEMS: readonly BundleItem[] = Object.freeze(['screen', 'listen']);

export const BUNDLE_WATCH_MS = 1_000;
export const BUNDLE_REPLY_WAIT_MS = 60_000;

/** The detector's word (electron/senses/watch-off-notice.ts onWatchChange) to the bundle: only an end whose cause is 'user' is the user's own off. */
export function tellBundleOfWatch(bundle: Pick<PermissionBundle, 'watchBegan' | 'watchEnded'> | null, change: { kind: 'began' } | { kind: 'ended'; why: string }): void {
  if (change.kind === 'began') bundle?.watchBegan(); else bundle?.watchEnded(change.why === 'user');
}

export class PermissionBundle {
  private session: BundleSession | null = null;
  /** A session left by a run that ended while she was out; put back once (recover), before any new apply. */
  private stale: BundleSession | null;
  private stopWatch: (() => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly tries = new Map<BundleItem, number>();
  private readonly reopening = new Set<BundleItem>();
  /** Items the user turned on by hand while she is out (not put back). */
  private readonly userKept = new Set<BundleItem>();
  private readonly seen = new Map<BundleItem, boolean>();
  private ownStepAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly ports: BundlePorts, saved: BundleSession | null = null) { this.stale = saved; }

  /** Turned on and not yet put back. */
  get active(): boolean { return !!this.session; }
  get current(): BundleSession | null { return this.session ? structuredClone(this.session) : null; }

  /** She is out: turn on what is off. Resolves with what happened. Serialized with restore. */
  apply(): Promise<BundleOutcome> { return this.enqueue(() => this.applyNow()); }
  /** She is back ('exit') or the app quits ('quit'): put back the untouched items. */
  restore(how: 'exit' | 'quit'): Promise<void> { return this.enqueue(() => this.restoreNow(how)); }
  /** At start: a session left by a run that died while she was out. */
  recover(): Promise<void> { return this.enqueue(() => this.recoverNow()); }

  private now(): number { return this.ports.now?.() ?? Date.now(); }
  private ownStep(): void { this.ownStepAt = this.now(); }
  private ownStepRecent(): boolean { return this.now() - this.ownStepAt < OWN_STEP_QUIET_MS; }

  /** 一起看 began on (the host's detector). One the bundle did not cause is the user's: its screen and sound are kept for the way back. */
  watchBegan(): void {
    if (!this.session || this.ownStepRecent() || this.reopening.size) return;
    for (const item of WATCH_ITEMS) if (this.session.attempted.includes(item)) this.userKept.add(item);
  }
  /** 一起看 went off; `byUser`: the user's own off (not her window, not the way back). */
  watchEnded(byUser: boolean): void {
    if (!this.session || !byUser) return;
    for (const item of WATCH_ITEMS) this.userKept.delete(item);
  }

  /** One reading (every second while she is out): an item that is off again is turned on again (I-159 A). */
  observe(): void {
    if (!this.session) return;
    const facts = this.read();
    if (!facts) return;
    let face: FaceReadiness;
    try { face = this.ports.face(); } catch { face = { supported: false, installed: false, enrolled: 0 }; }
    for (const item of BUNDLE_ITEMS) {
      const before = this.seen.get(item);
      this.seen.set(item, facts[item]);
      if (facts[item] && before === false && !this.ownStepRecent() && !this.reopening.has(item)) this.userKept.add(item); // off, then on with no step of ours: the user's hand
      if (!facts[item]) this.userKept.delete(item);
      if (facts[item]) { this.tries.delete(item); continue; }
      if (!keptOnWhileOut(item, face) || this.reopening.has(item) || (this.tries.get(item) ?? 0) >= REOPEN_TRIES) continue;
      this.tries.set(item, (this.tries.get(item) ?? 0) + 1);
      this.reopening.add(item);
      void this.reopen(item);
    }
  }

  private async reopen(item: BundleItem): Promise<void> {
    try {
      if (!this.session) return; // she went back while this waited: nothing is turned on any more
      this.ownStep();
      await this.ports.set(item, true);
      this.ports.log?.(`unbound bundle: ${item} was off while she is out, turned on again`);
    } catch (error) { this.ports.log?.(`unbound bundle: ${item} did not turn on again (${error instanceof Error ? error.message : 'unknown'})`); }
    finally { this.ownStep(); this.reopening.delete(item); }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private read(): BundleFacts | null {
    try { return this.ports.read(); } catch { return null; }
  }

  private async applyNow(): Promise<BundleOutcome> {
    if (this.stale) await this.recoverNow();
    const outcome: BundleOutcome = { alreadyOn: [], opened: [], notOpened: [], skipped: [] };
    if (this.session) return outcome; // already applied for this stay
    const before = this.read();
    if (!before) { this.ports.log?.('unbound bundle: could not read the switches; nothing turned on'); return outcome; }
    let face: FaceReadiness;
    try { face = this.ports.face(); } catch { face = { supported: false, installed: false, enrolled: 0 }; }
    const attempted: BundleItem[] = [];
    for (const item of BUNDLE_ITEMS) {
      if (before[item]) outcome.alreadyOn.push(item);
      else if (item === 'face' && !face.installed) { if (face.supported) outcome.skipped.push(item); }
      else attempted.push(item);
    }
    const session: BundleSession = { signature: BUNDLE_SIGNATURE, attempted, baseline: {}, touched: [] };
    this.session = session;
    // Saved before anything turns on: a crash in between still puts things back.
    await this.ports.save(structuredClone(session)).catch(() => undefined);
    this.userKept.clear(); this.seen.clear();
    for (const item of attempted) {
      this.ownStep();
      try { await this.ports.set(item, true); }
      catch (error) { this.ports.log?.(`unbound bundle: ${item} did not turn on (${error instanceof Error ? error.message : 'unknown'})`); }
    }
    this.ownStep();
    const after = this.read();
    for (const item of BUNDLE_ITEMS) if (after) this.seen.set(item, after[item]);
    for (const item of attempted) {
      const on = after?.[item] === true;
      session.baseline[item] = on;
      (on ? outcome.opened : outcome.notOpened).push(item);
    }
    await this.ports.save(structuredClone(session)).catch(() => undefined);
    this.stopWatch?.();
    this.stopWatch = this.ports.every(BUNDLE_WATCH_MS, () => this.observe());
    return outcome;
  }

  private async restoreNow(how: 'exit' | 'quit'): Promise<void> {
    const session = this.session;
    this.stopWatch?.(); this.stopWatch = null;
    if (!session) return;
    if (how === 'exit') {
      // Screen sharing going off ends a reply being written; the way back is not the user taking it away, so it waits for it.
      for (let waited = 0; waited < BUNDLE_REPLY_WAIT_MS && this.replyRunning(); waited += 250) await this.ports.wait(250);
    }
    this.session = null; // from here nothing is turned on again
    this.tries.clear();
    // What the user turned on by hand stays, but only while it still reads on (a revoked permission or a window gone off the screen reads off).
    const now = how === 'exit' && this.userKept.size ? this.read() : null;
    const stay = BUNDLE_ITEMS.filter(item => this.userKept.has(item) && now?.[item] === true && session.attempted.includes(item));
    this.userKept.clear(); this.seen.clear();
    const back = session.attempted.filter(item => !session.touched.includes(item) && !stay.includes(item) && (how === 'exit' || PERSISTENT_ITEMS.includes(item)));
    if (stay.length) { try { this.ports.kept?.([...stay]); } catch { /* a journal row only */ } }
    let failed = false;
    for (const item of back) {
      try { await this.ports.set(item, false); }
      catch (error) { failed = true; this.ports.log?.(`unbound bundle: ${item} did not go back (${error instanceof Error ? error.message : 'unknown'})`); }
    }
    // Quitting: camera, microphone, screen and sound end with the run anyway; the session stays saved so the next start checks
    // that the face check really went back (its own save may not finish while the app quits).
    if (how === 'quit') { await this.ports.save({ ...session, attempted: session.attempted.filter(item => PERSISTENT_ITEMS.includes(item)) }).catch(() => undefined); return; }
    if (failed) { this.stale = { ...session, attempted: back }; }
    await this.ports.save(failed ? structuredClone(this.stale) : null).catch(() => undefined);
  }

  private async recoverNow(): Promise<void> {
    const session = this.stale;
    this.stale = null;
    if (!session) return;
    const facts = this.read();
    let failed = false;
    for (const item of session.attempted) {
      if (!PERSISTENT_ITEMS.includes(item) || session.touched.includes(item) || !facts?.[item]) continue;
      try { await this.ports.set(item, false); }
      catch { failed = true; }
    }
    if (failed || !facts) { this.stale = session; return; } // tried again at the next chance; the file stays
    if (!this.session) await this.ports.save(null).catch(() => undefined);
  }

  private replyRunning(): boolean {
    try { return this.ports.replyRunning(); } catch { return false; }
  }
}
