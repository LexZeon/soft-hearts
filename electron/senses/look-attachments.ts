import { createHash, randomUUID } from 'node:crypto';
import type { Attachment } from '../../shared/foundation/chat';
import { scanWatchPointing, withheldLook } from '../../shared/senses/look-request';
import { TEXT_FIRST_KNOBS } from '../../shared/brain';
import type { CameraLookMiss } from '../../shared/senses/camera-look';
import { CLOSER_RETRY_MISSES, SEE_AND_SAY, type CloserMiss } from '../../shared/senses/see-and-say';
import { validateLookHint, type LookState, type LookTurns, type LookVia } from './look-turns';
import type { ScreenSampleMiss } from './screen-snapshots';

/** 2026-11-22: how her closer look's capture went, for the journal (closed words and a count; never a picture). */
export interface CloserCaptureDetail { tries: number; miss?: CloserMiss }

/**
 * 识图第 1 步「细看」: the host side of preload `sharedAttachments(hint)`, the only way a chat message gets a shared screen or
 * camera frame (taken out of electron/main.ts on 2026-11-04 so the whole send path can be tested without Electron).
 *
 * The order is the privacy rule: the decision (electron/senses/look-turns.ts → shared/senses/look-request.ts scanLookRequest, the one place
 * that reads the user's words) comes first, and a frame is taken only after it said yes. A refused turn never reaches a capture
 * port, so no frame of it exists to leave the computer (Codex T-205 round 2, X-253: "禁止查看我的屏幕" took a frame because the
 * words were misread, docs/claude/2026-11-04-v1-refusal-grab.md). Anything that changes while a frame is taken (media state,
 * the vision context, a newer message) discards it.
 *
 * 屏幕只读大概: an ordinary message carries no frame, sharing
 * on or off; the morning's V1 (each message carried the latest frame the host kept every 10 s) is gone, and so is that kept frame.
 * Nothing waits for a capture on an ordinary message: from the send to Claude's stdin there is no picture to wait for.
 *
 * I-036 「发图片」: with that camera switch on, an ordinary
 * message carries one small camera frame the host already keeps (`glance` port: no capture, so still nothing to wait for), with
 * its own ticket like any shared frame; asking her to look ("你看看我") takes a clear one instead. A "别看" holds both.
 *
 * 关掉之后的旧帧 (same record, last section): a frame goes back to the window and only then comes with the chat. If the user turns
 * that sharing off in between, "别看了" holds for the frame already taken too: the chat handler asks `admit` which of the turn's
 * attachments may still go, and asks again right before Claude gets them. A frame this host took stays sendable only while its
 * source is on in the same opening it was taken in (turned off and on again is a new opening) and the vision context was not
 * cleared; otherwise it is dropped and the turn goes out as text, as a turn without a picture. A snapshot the user attached by
 * hand (控制窗口"附屏幕快照", 摄像头拍照) was never handed out here, so it passes unchanged, as before.
 *
 * 帧的来源 (Codex T-205 round 4, X-258, same record): which is which is told by a mark, not by the picture. Each shared frame handed
 * out carries a random `shareTicket` the window sends back unchanged; this host knows its own tickets. A frame with a ticket is a
 * shared frame, sendable only while its ticket is known and live; an unknown ticket (forged, used, from an ended opening, or
 * pushed out by the cap) is dropped, never mistaken for a snapshot. A frame without one is the user's own snapshot and passes,
 * whatever its bytes. Before, the last 4 frames were remembered by their bytes: an older frame sent back passed as a snapshot,
 * and a snapshot that happened to match an old frame byte for byte was dropped.
 *
 * 记号绑在那一帧上 (Codex T-205 round 5, X-260, same record): a ticket only said which source, opening and context it was issued
 * for, so a request built over IPC could put a live ticket on another picture (the old frame of an ended opening, a revoked camera
 * frame) or send one ticket twice in a message. Now a ticket also keeps the SHA-256 of the frame's data (the digest only, never the
 * picture), and a ticketed attachment passes only with the same source and the same digest; in a message a ticket counts once, for
 * its first attachment. Anything else is dropped, never taken for a hand-attached snapshot.
 *
 * I-085 第 3 步 文字为主 (plan section 5 option B: "选 B（我推荐）：她的第一个字每句快约 0.9 秒，语音通话也更快；代价是她
 * 平时看到的是一句总结，细节少一点。可以"): this replaces two behaviours the user had confirmed and
 * now knowingly changed — 「和她一起看」's screen frame on every message (2026-11-07) and 「发图片」's small camera frame on every message
 * (I-036 choice C). Each picture turn retires the warm chat process (old frames never stay in its context), so with either on nearly
 * every turn started a new process. Now an ordinary message carries no frame; she gets text (the watch timeline's descriptions, her
 * own recent look's line; shared/brain/perception-rule.ts says how old). A frame goes only when it is needed: the user asks or points
 * ("你看这个", and while watching together "这是谁", "屏幕上那个": shared/senses/look-request.ts scanWatchPointing), asks about their looks,
 * presses a button, says yes to her offer, or — while watching together, no "别看" — she is very curious and the latest description
 * is stale or unclear (`curious`, at most once per 10 minutes: electron/senses/look-closer.ts). A "别看" still holds every frame, and the
 * ticket and digest rules above apply to these frames unchanged. `textFirst` off (shared/behaviors/text-first/knobs.ts): as before.
 */
export interface LookAttachmentPorts {
  /** Runs first, before the decision: the user is active now (the vision context is refreshed and may be cleared). */
  noteActivity(): void;
  /** What is switched on now, and the conversation it belongs to. */
  state(): LookState;
  /** 「发图片」 is on (I-036): its window can give camera frames (「姿势识别」 alone never gives chat a picture). */
  sharesCameraFrames(): boolean;
  /** Media revision and vision generation: a change while a frame is taken discards it. */
  revision(): number;
  generation(): number;
  /** Which opening of the source this is (electron/senses/media-runtime.ts MediaRuntime.openings): it changes when that source turns on or off. */
  opening(source: Attachment['source']): number;
  /**
   * 「和她一起看」 (紧急: with screen sharing on she still said she could not see the show): screen sharing and
   * 「和她一起听」's words both on. Then every message takes one screen frame, like a look; 屏幕只读大概 (2026-11-04) stays for screen
   * sharing alone. A "别看" still holds it. Absent: never (older wiring, tests).
   */
  watchingTogether?(): boolean;
  /** I-085 第 3 步: text first (absent: TEXT_FIRST_KNOBS.enabled). False: every message of 一起看 / 「发图片」 carries a frame, as before. */
  textFirst?(): boolean;
  /**
   * I-085 第 3 步: while watching together (text first, no "别看", nothing asked), she wants a closer look now. Called at most once per
   * message, only then; true counts as her look (electron/senses/look-closer.ts keeps the 10-minute gap). Absent: never.
   */
  curious?(): boolean;
  /** One frame of the shared screen, right now (null: the screen is unavailable; `miss` says why, in closed words). */
  captureScreen(signal: AbortSignal, miss?: (why: ScreenSampleMiss) => void): Promise<Attachment | null>;
  /** 2026-11-22: her closer look found the screen source not ready: the vision context is read again before its one more try. Absent: none. */
  refreshContext?(): void;
  /** 2026-11-22: how many captures her closer look may try (SEE_AND_SAY.closerTries; absent: that knob). */
  closerTries?(): number;
  /** One frame from the camera owner's window (null: no owner or no frame; `miss` says why, in closed words). */
  captureCamera(signal: AbortSignal, miss?: (why: CameraLookMiss) => void): Promise<Attachment | null>;
  /**
   * I-036 「发图片」: the small frame the host already keeps (electron/senses/camera-glance.ts CameraGlance.take, which also applies the
   * both-switches-on rule); synchronous, nothing is captured. Absent: no small frames (older wiring, tests).
   */
  glance?(everyTurn?: boolean): Attachment | null;
  /**
   * I-166: every turn carries a small frame from each sense that is on
   * (shared/senses/see-and-say/knobs.ts SEE_AND_SAY.smallFramesEveryTurn). Absent or false: as before (older wiring, tests).
   */
  seeAndSay?(): boolean;
  /** I-166: one small screen frame (320×200 JPEG, kept a few seconds or taken now); null: none. Absent: no small screen frames. */
  smallScreen?(signal: AbortSignal): Promise<Attachment | null>;
  /** I-166: a small camera frame taken now when the kept one is stale (her window throttled while she is out in full-screen); null: none. */
  freshGlance?(signal: AbortSignal): Promise<Attachment | null>;
  /** I-166: how long a small frame that is not ready may hold the turn (SEE_AND_SAY.smallWaitMs). */
  smallWaitMs?(): number;
  /** I-166: which senses this turn carried a small frame from (the experience journal; closed values only). */
  smallFrames?(senses: { camera: boolean; screen: boolean }): void;
  /**
   * I-168 (SEE_AND_SAY.keepClearFrames): a clear frame this host took ("看看我", the button, her closer look) may
   * stay in the warm Claude process like a small one (glanceOnly). Absent or false: I-161 A's rule, a clear frame retires the process after use.
   */
  keepClearFrames?(): boolean;
  /** A clear camera frame went for this message (the next small frame compares with it). */
  seenCamera?(): void;
  /** The user said not to look (true) or asked her to look again (false): electron/senses/media-runtime.ts MediaRuntime.holdCamera. */
  holdCamera?(held: boolean): void;
}

/**
 * A frame this host handed out for a message: which source, which opening of it, which vision context, and the digest of its data
 * (no picture is kept).
 */
interface Issued { source: Attachment['source']; opening: number; context: number; digest: string; glance?: true; via?: FrameVia }

/** How a frame this host took was asked for: LookVia, or (I-085 第 3 步) her own closer look while watching together. */
export type FrameVia = LookVia | 'curious';

/**
 * I-161: how a voice or call turn asks for its frames (electron/senses/voice-look.ts). Typed chat
 * passes none, and then `request` is exactly what it was.
 */
export interface LookRequestOptions {
  /** The small 「发图片」 frame goes on every turn even with text first (shared/senses/call-look.ts CALL_LOOK.glanceEveryTurn). */
  glanceEveryTurn?: boolean;
  /** Told the decision before anything is taken: which sources a clear frame is wanted from (the call's "no picture" line). */
  decided?(wanted: { screen: boolean; camera: boolean }): void;
}

/**
 * SHA-256 of a frame's data URL, as sent (validateChatRequest keeps it unchanged); once when the frame is handed out, once when
 * it comes back. Measured 2026-11-04 (Node 26, arm64, median of 50): 0.34 ms for a 200 K-character data URL (about a 1600×1000
 * JPEG screen frame), 2.1 ms for 1 M, 9 ms at the 4 M cap. Only on a turn that looks, next to a capture that takes far longer.
 */
export function frameDigest(dataUrl: string): string {
  return createHash('sha256').update(dataUrl).digest('base64');
}

/**
 * Tickets handed out and not yet sent are kept this many at most, well under 20 KB in all (a ticket and a digest each, no image
 * data). Only frames of the current opening and vision context are kept at all: the rest can never be live again. Past the cap the
 * oldest is forgotten, and
 * a forgotten ticket is dropped like any unknown one: fewer pictures, never a stale one. The window sends a frame right after it
 * gets it, so in practice there are one or two.
 */
export const SHARE_TICKETS_KEPT = 64;

/** I-166: a message that says no to looking, or cannot be read, carries no small screen frame (unsure is no, as for the camera). */
const SMALL_SCREEN_NO: ReadonlySet<string> = new Set(['refused', 'unread']);

/** One chat turn's attachments, from the request until Claude gets them (`admit`). */
export class TurnFrames {
  constructor(private items: ReadonlyArray<{ attachment: Attachment; live: (() => boolean) | null; glance?: boolean; via?: FrameVia }>, private readonly miss: CameraLookMiss | null = null,
    private readonly keepClear = false) {}

  /** 2026-11-21: why the clear camera picture this message asked for did not come (closed words; null: it came, or none was asked). */
  cameraMiss(): CameraLookMiss | null { return this.miss; }

  /** What this turn may send right now. A shared frame once dropped stays dropped; a hand-attached snapshot always passes. */
  current(): Attachment[] {
    this.items = this.items.filter(item => !item.live || item.live());
    return this.items.map(item => item.attachment);
  }

  /** I-036: the camera frame this turn still carries is the small 「发图片」 one, not one the user asked for or attached. */
  cameraGlance(): boolean {
    this.current();
    return this.items.some(item => item.glance && item.attachment.source === 'camera');
  }

  /**
   * I-084 (the experience journal's camera line): how the clear camera picture this turn still carries was asked for — the button,
   * the words, their meaning, a yes to her offer — or 'photo' (the user attached it by hand); null: no clear camera picture.
   */
  cameraVia(): LookVia | 'photo' | null {
    this.current();
    const item = this.items.find(entry => entry.attachment.source === 'camera' && !entry.glance);
    const via = !item ? null : item.live === null ? 'photo' : item.via ?? 'words';
    return via === 'curious' ? 'words' : via; // never: her closer look is the screen's only
  }

  /** I-085 第 3 步: how the screen picture this turn still carries came: asked for, her closer look ('curious'), a snapshot by hand ('photo'); null: none. */
  screenVia(): FrameVia | 'photo' | null {
    this.current();
    const item = this.items.find(entry => entry.attachment.source === 'screen' && !entry.glance); // I-166: the small one is not a look
    return !item ? null : item.live === null ? 'photo' : item.via ?? 'words';
  }

  /** I-166: the screen frame this turn still carries is the small one (every turn while sharing is on), not one asked for. */
  screenGlance(): boolean {
    this.current();
    return this.items.some(item => item.glance && item.attachment.source === 'screen') && !this.items.some(item => !item.glance && item.attachment.source === 'screen');
  }

  /**
   * I-161 A (electron/brain/call-glances.ts): this turn still carries a frame, and every frame it may leave in the warm process: a small
   * 「发图片」 one, or (I-168 keepClear) any frame this host took for the turn. A snapshot attached by hand never.
   */
  glanceOnly(): boolean {
    this.current();
    return this.items.length > 0 && this.items.every(item => (item.glance === true || this.keepClear) && item.live !== null);
  }

  /**
   * I-161 A: a check that this turn's small frames may still be seen (each one's ticket check: source on, same opening, same vision
   * context, no "别看"). It closes over those checks only, never over a picture; false when there are none.
   */
  glanceStill(): () => boolean {
    this.current();
    const checks = this.items.filter(item => item.glance === true || this.keepClear).map(item => item.live); // I-168: a kept clear frame's check too
    return () => checks.length > 0 && checks.every(check => check !== null && check());
  }

  /**
   * The frames the user asked for or attached by hand (the small 「发图片」 frame left out): a local control ("暂停朗读") or anything
   * that used to mean "a message without pictures" still means that with 「发图片」 on (electron/main.ts).
   */
  asked(): Attachment[] {
    this.current();
    return this.items.filter(item => !item.glance).map(item => item.attachment);
  }

  /**
   * `text` was composed for `sent` (the turn's perception line says whether a picture is attached). If a frame was dropped since,
   * the text is composed again for the frames left, so what she is told stays true at the moment Claude gets the message.
   */
  recompose(sent: readonly Attachment[], text: string, compose: (left: Attachment[]) => string): string {
    const left = this.current();
    return left.length === sent.length ? text : compose(left);
  }
}

export class LookAttachments {
  private task: AbortController | null = null;
  /** Ticket → the frame it marks, oldest first. */
  private issued = new Map<string, Issued>();
  private context = 0;
  /** 2026-11-21: why the last request's asked-for camera picture did not come; taken by the next admit (null: none missed). */
  private cameraMissed: CameraLookMiss | null = null;
  constructor(private readonly turns: LookTurns, private readonly ports: LookAttachmentPorts) {}

  private safeWatching(): boolean { try { return this.ports.watchingTogether?.() === true; } catch { return false; } }
  private safeTextFirst(): boolean { try { return this.ports.textFirst ? this.ports.textFirst() === true : TEXT_FIRST_KNOBS.enabled === true; } catch { return true; } }
  private safeCurious(): boolean { try { return this.ports.curious?.() === true; } catch { return false; } }
  private safeSeeAndSay(): boolean { try { return this.ports.seeAndSay?.() === true; } catch { return false; } }

  /** I-166: a small frame that is not ready, given at most smallWaitMs (default 700 ms); null on timeout or failure. */
  private small(take: (signal: AbortSignal) => Promise<Attachment | null>, signal: AbortSignal): Promise<Attachment | null> {
    let wait = 700;
    try { wait = Math.max(0, Number(this.ports.smallWaitMs?.() ?? 700)) || 0; } catch { wait = 700; }
    const controller = new AbortController(), stop = () => controller.abort();
    signal.addEventListener('abort', stop, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      take(controller.signal).catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, wait); }),
    ]).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', stop); });
  }

  /**
   * I-166 her own closer look (electron/brain/look-continuation.ts): one clear frame of `source`, only while it is on and not held by "别看"
   * (the screen's no too); a change of the switches or the vision context while it is taken drops it. The frame's data is asked again on
   * every read (`dataUrls`): source on, same opening, same vision context, no "别看", else nothing. Held only by the caller's turn.
   * 2026-11-22: a capture that gave nothing for a reason that is not the switches or the context (the source not ready, interrupted, no
   * picture) is tried once more within the caller's wait (`closerTries`); `report` gets the closed miss word and the number of tries.
   */
  async closer(source: Attachment['source'], signal: AbortSignal, report?: (detail: CloserCaptureDetail) => void): Promise<{ dataUrls(): string[]; still(): boolean } | null> {
    const allowed = () => { const state = this.ports.state(); return source === 'screen' ? state.screen && !this.turns.refusedIn(state)
      : this.ports.sharesCameraFrames() && state.camera && state.cameraHeld !== true; };
    let tries = 0;
    const end = (miss?: CloserMiss) => { try { report?.({ tries, ...(miss ? { miss } : {}) }); } catch { /* journal only */ } return null; };
    // 2026-11-22 (a report that a closing line went without a sharp frame, docs/claude/2026-11-22-closer-no-frame.md): what may drop it is this source's own opening, the vision
    // context and its switch / "别看" (read again below), not the media revision, which any other switch (voice input…) bumps too.
    const key = () => `${this.ports.generation()}|${this.ports.opening(source)}|${this.context}`;
    const taken = key(), entry: Issued = { source, opening: this.ports.opening(source), context: this.context, digest: '' };
    const most = Math.max(1, Math.min(3, Math.round(Number(this.safeCloserTries())) || 1));
    for (;;) {
      if (!allowed()) return end(tries ? 'held' : 'off'); // every try asks the switch and "别看" first: a retry never captures after either
      tries++;
      let miss = null as CloserMiss | null; // set inside the capture's callback
      const frame = source === 'screen' ? await this.ports.captureScreen(signal, why => { miss = why; })
        : await this.ports.captureCamera(signal, why => { miss = why === 'off' ? 'held' : why === 'no-window' ? 'unready' : 'capture-failed'; });
      signal.throwIfAborted();
      if (!allowed()) return end('held');
      if (key() !== taken) return end('changed');
      if (frame) {
        if (source === 'camera') this.ports.seenCamera?.();
        const data = frame.dataUrl;
        end();
        // `still` (I-168, a kept clear frame's check in the warm process) closes over the ticket only, never the picture.
        const still = () => this.live(entry) && allowed();
        return { dataUrls: () => (still() ? [data] : []), still };
      }
      const why: CloserMiss = miss ?? 'capture-failed';
      if (tries >= most || !CLOSER_RETRY_MISSES.has(why)) return end(why);
      if (why === 'unready') try { this.ports.refreshContext?.(); } catch { /* the next try finds it unready again */ }
    }
  }

  private safeCloserTries(): number { try { return this.ports.closerTries ? this.ports.closerTries() : SEE_AND_SAY.closerTries; } catch { return 1; } }

  /** 和她一起看 is on now (screen sharing and 一起听's words), and whether text first applies (I-085 第 3 步; the chat turn's line reads both). */
  get watching(): boolean { return this.safeWatching(); }
  get textFirst(): boolean { return this.safeTextFirst(); }

  /** A frame is being taken for a message right now. */
  get busy(): boolean { return this.task !== null; }

  /** Shared frames handed out and not yet sent that are still remembered (at most SHARE_TICKETS_KEPT). */
  get outstanding(): number { return this.issued.size; }

  /** The vision context was cleared: a frame being taken is dropped, and so is every frame handed out and not yet sent. */
  abort(): void {
    this.context++;
    this.task?.abort();
  }

  /** The frames for the message about to be sent: none unless the decision says so. Throws on a malformed hint before anything is taken. */
  async request(hint: unknown, options: LookRequestOptions = {}): Promise<Attachment[]> {
    this.ports.noteActivity();
    this.cameraMissed = null;
    const state = this.ports.state();
    let look = this.turns.decide(hint, state);
    const textFirst = this.safeTextFirst();
    let screenVia: FrameVia | null = look.via;
    // 和她一起看: unless she was told not to look (decide just updated that), an ordinary message took the screen too (2026-11-07). Text
    // first (I-085 第 3 步): only when the message points at the screen, or she very much wants a closer look herself.
    if (!look.screen && state.screen && !this.turns.refusedIn(state) && this.safeWatching()) {
      if (!textFirst) look = { ...look, screen: true };
      else if (scanWatchPointing(validateLookHint(hint).text)) { look = { ...look, screen: true }; screenVia = 'words'; }
      else if (look.via === null && this.safeCurious()) { look = { ...look, screen: true }; screenVia = 'curious'; }
    }
    // I-036: a no to looking stops the small frames right away (before anything below), a request to look lifts it.
    if (look.hold !== undefined) this.ports.holdCamera?.(look.hold);
    try { options.decided?.({ screen: look.screen, camera: this.ports.sharesCameraFrames() && look.camera }); } catch { /* a listener changes nothing here */ }
    this.task?.abort();
    const controller = new AbortController();
    this.task = controller;
    const revision = this.ports.revision();
    const generation = this.ports.generation();
    const context = this.context;
    const current = () => {
      controller.signal.throwIfAborted();
      if (revision !== this.ports.revision() || generation !== this.ports.generation() || this.task !== controller)
        throw new Error('共享状态已改变，已丢弃画面。');
    };
    const attachments: Attachment[] = [], taken: [string, Issued][] = [];
    const mark = (frame: Attachment, source: Attachment['source'], opening: number, glance = false) => {
      const ticket = randomUUID(), via = source === 'screen' ? screenVia : look.via;
      taken.push([ticket, { source, opening, context, digest: frameDigest(frame.dataUrl), ...(glance ? { glance: true as const } : via ? { via } : {}) }]);
      // A copy: the capture port's own frame object stays as it was.
      attachments.push({ source, dataUrl: frame.dataUrl, shareTicket: ticket });
    };
    try {
      if (look.screen) {
        const opening = this.ports.opening('screen');
        const frame = await this.ports.captureScreen(controller.signal);
        current();
        if (!frame) throw new Error('无法读取已选择的共享屏幕，请检查屏幕是否可用。');
        mark(frame, 'screen', opening);
      }
      if (this.ports.sharesCameraFrames() && look.camera) {
        const opening = this.ports.opening('camera');
        let missed: CameraLookMiss | null = null;
        const frame = await this.ports.captureCamera(controller.signal, why => { missed = why; });
        current();
        if (frame) { mark(frame, 'camera', opening); this.ports.seenCamera?.(); } else this.cameraMissed = missed ?? 'no-answer';
      }
      // I-036 「发图片」: the small frame that is already here; no capture, so the message does not wait for the camera. Text first
      // (I-085 第 3 步): none; her own recent look goes as a line instead (electron/initiative/self-look/host.ts). A call turn (I-161 A) still
      // carries it, like a video call.
      // I-166: every turn, a small frame from each sense that is on and not held by "别看" (the screen's too); one that is not ready
      // waits at most smallWaitMs, else this turn goes without it.
      const seeing = this.safeSeeAndSay(), text = validateLookHint(hint).text;
      const camera = this.ports.sharesCameraFrames() && look.glance === true && !look.camera && (!textFirst || options.glanceEveryTurn === true || seeing);
      const screen = seeing && !look.screen && state.screen && !this.turns.refusedIn(state) && text !== undefined && (!this.turns.holds || !SMALL_SCREEN_NO.has(withheldLook(text) ?? '')); // I-168: a no holds nothing (LookTurns.holds)
      const cameraOpening = this.ports.opening('camera'), screenOpening = this.ports.opening('screen');
      const kept = camera ? this.ports.glance?.(seeing) ?? null : null;
      const [cameraFrame, screenFrame] = await Promise.all([
        kept ?? (camera && seeing && this.ports.freshGlance ? this.small(this.ports.freshGlance, controller.signal) : null),
        screen && this.ports.smallScreen ? this.small(this.ports.smallScreen, controller.signal) : null]);
      current();
      if (cameraFrame) mark(cameraFrame, 'camera', cameraOpening, true);
      if (screenFrame) mark(screenFrame, 'screen', screenOpening, true);
      if (seeing) try { this.ports.smallFrames?.({ camera: !!cameraFrame, screen: !!screenFrame }); } catch { /* journal only */ }
      current();
      this.prune();
      for (const [ticket, entry] of taken) this.issued.set(ticket, entry);
      for (const ticket of this.issued.keys()) {
        if (this.issued.size <= SHARE_TICKETS_KEPT) break;
        this.issued.delete(ticket);
      }
      return attachments;
    } finally {
      if (this.task === controller) this.task = null;
    }
  }

  /**
   * The chat handler received a turn with these attachments (after validateChatRequest). A frame with a `shareTicket` is a frame
   * this host took for a message: it stays in the turn only while its ticket is one this host handed out, for this very frame (same
   * source, same data digest), and `live`. Its ticket is used up at its first attachment (a shared frame goes with one message, once):
   * a later attachment with the same ticket, in this message or another, is dropped. A frame without a ticket is the user's own
   * snapshot and passes.
   */
  admit(attachments: readonly Attachment[]): TurnFrames {
    this.prune();
    const items = attachments.map(attachment => {
      const ticket = attachment.shareTicket;
      if (ticket === undefined) return { attachment, live: null }; // the user attached it by hand
      const entry = this.issued.get(ticket);
      this.issued.delete(ticket);
      const bound = entry !== undefined && entry.source === attachment.source && entry.digest === frameDigest(attachment.dataUrl);
      return { attachment, live: bound ? () => this.live(entry) : () => false, glance: bound && entry?.glance === true, ...(bound && entry?.via ? { via: entry.via } : {}) };
    });
    const miss = this.cameraMissed;
    this.cameraMissed = null;
    let keepClear = false;
    try { keepClear = this.ports.keepClearFrames?.() === true; } catch { keepClear = false; }
    return new TurnFrames(items, miss, keepClear);
  }

  /** Tickets of an ended opening or a cleared vision context can never be live again: forgotten (an unknown ticket is dropped). */
  private prune(): void {
    for (const [ticket, entry] of this.issued)
      if (entry.context !== this.context || entry.opening !== this.ports.opening(entry.source)) this.issued.delete(ticket);
  }

  /** Its source is on now, in the same opening it was taken in, and the vision context was not cleared since. */
  private live(entry: Issued): boolean {
    if (entry.context !== this.context || entry.opening !== this.ports.opening(entry.source)) return false;
    const state = this.ports.state();
    // I-036: a "别看" said after the frame was handed out holds it back too.
    return entry.source === 'screen' ? state.screen : this.ports.sharesCameraFrames() && state.camera && state.cameraHeld !== true;
  }
}
