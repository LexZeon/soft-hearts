import { createHash, randomUUID } from 'node:crypto';
import type { Attachment } from '../shared/contracts';
import type { LookState, LookTurns } from './look-turns';

/**
 * 识图第 1 步「细看」: the host side of preload `sharedAttachments(hint)`, the only way a chat message gets a shared screen or
 * camera frame (taken out of electron/main.ts on 2026-11-04 so the whole send path can be tested without Electron).
 *
 * The order is the privacy rule: the decision (electron/look-turns.ts → shared/look-request.ts scanLookRequest, the one place
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
  /** Which opening of the source this is (electron/runtime.ts MediaRuntime.openings): it changes when that source turns on or off. */
  opening(source: Attachment['source']): number;
  /**
   * 「和她一起看」 (紧急: with screen sharing on she still said she could not see the show): screen sharing and
   * 「和她一起听」's words both on. Then every message takes one screen frame, like a look; 屏幕只读大概 (2026-11-04) stays for screen
   * sharing alone. A "别看" still holds it. Absent: never (older wiring, tests).
   */
  watchingTogether?(): boolean;
  /** One frame of the shared screen, right now (null: the screen is unavailable). */
  captureScreen(signal: AbortSignal): Promise<Attachment | null>;
  /** One frame from the camera owner's window (null: no owner or no frame). */
  captureCamera(signal: AbortSignal): Promise<Attachment | null>;
  /**
   * I-036 「发图片」: the small frame the host already keeps (electron/camera-glance.ts CameraGlance.take, which also applies the
   * both-switches-on rule); synchronous, nothing is captured. Absent: no small frames (older wiring, tests).
   */
  glance?(): Attachment | null;
  /** A clear camera frame went for this message (the next small frame compares with it). */
  seenCamera?(): void;
  /** The user said not to look (true) or asked her to look again (false): electron/runtime.ts MediaRuntime.holdCamera. */
  holdCamera?(held: boolean): void;
}

/**
 * A frame this host handed out for a message: which source, which opening of it, which vision context, and the digest of its data
 * (no picture is kept).
 */
interface Issued { source: Attachment['source']; opening: number; context: number; digest: string; glance?: true }

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

/** One chat turn's attachments, from the request until Claude gets them (`admit`). */
export class TurnFrames {
  constructor(private items: ReadonlyArray<{ attachment: Attachment; live: (() => boolean) | null; glance?: boolean }>) {}

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
  constructor(private readonly turns: LookTurns, private readonly ports: LookAttachmentPorts) {}

  private safeWatching(): boolean { try { return this.ports.watchingTogether?.() === true; } catch { return false; } }

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
  async request(hint: unknown): Promise<Attachment[]> {
    this.ports.noteActivity();
    const state = this.ports.state();
    let look = this.turns.decide(hint, state);
    // 和她一起看: an ordinary message takes the screen too, unless she was told not to look (decide just updated that).
    if (!look.screen && state.screen && !this.turns.refusedIn(state) && this.safeWatching()) look = { ...look, screen: true };
    // I-036: a no to looking stops the small frames right away (before anything below), a request to look lifts it.
    if (look.hold !== undefined) this.ports.holdCamera?.(look.hold);
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
      const ticket = randomUUID();
      taken.push([ticket, { source, opening, context, digest: frameDigest(frame.dataUrl), ...(glance ? { glance: true as const } : {}) }]);
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
        const frame = await this.ports.captureCamera(controller.signal);
        current();
        if (frame) { mark(frame, 'camera', opening); this.ports.seenCamera?.(); }
      }
      // I-036 「发图片」: the small frame that is already here; no capture, so the message does not wait for the camera.
      if (this.ports.sharesCameraFrames() && look.glance && !look.camera) {
        const frame = this.ports.glance?.() ?? null;
        if (frame) mark(frame, 'camera', this.ports.opening('camera'), true);
      }
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
      return { attachment, live: bound ? () => this.live(entry) : () => false, glance: bound && entry?.glance === true };
    });
    return new TurnFrames(items);
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
