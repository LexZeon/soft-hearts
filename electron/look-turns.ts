import { randomUUID } from 'node:crypto';
import { isLookAffirmation, isLookDecline, scanLookRequest, withheldLook } from '../shared/look-request';

/**
 * 识图分三档 · 「细看」(docs/claude/2026-11-03-image-depth-step1.md): which frames the message about to be sent carries.
 *
 * 屏幕只读大概 (I-015): with screen sharing on, an
 * ordinary message carries no picture. She knows only roughly what the user is doing (electron/screen-glance.ts: the program in
 * front, never its title), which the turn's perception line says. This replaces the morning's V1 ("每条消息带最近一帧",
 * docs/claude/2026-11-04-v1-sharing-means-look.md); the host no longer keeps a frame in the background at all.
 *
 * A new frame is taken right then (the send waits for that one capture) only when:
 *  - the user pressed "给她看看屏幕" (screen only, only with sharing on), or "看吧" on her look offer in the pet (src/ui/LookOfferPrompt.ts),
 *    which sends the same way;
 *  - the message asks her to look (shared/look-request.ts: "你看看这个", "看我屏幕"; "你看看我" means the camera, a clear frame
 *    only while 「发图片」 is on — 「姿势识别」 alone never sends a picture; I-036);
 *  - she asked "要我凑近看看吗" in the reply just before (shared/look-request.ts isLookOffer) and the user answers with a short yes
 *    ("嗯", "看吧", "好"). Whatever the user sends next answers the offer; it is never carried further. A short no ("不用", or "不用" on
 *    the pet's prompt: `decline`) closes it without a frame.
 *
 * A "别看我屏幕" (withheldLook 'refused') holds for the messages after it (REFUSAL_HOLDS): no frame, and the rough reading is not told
 * to her either (`refusedIn`; no thumbnail is looked at), until the user asks her to look or turns sharing off and on.
 * Nothing but the open offer and a no is kept here: the frames are the host's (electron/look-attachments.ts), one turn each.
 *
 * I-036 「发图片」: with that camera switch on, an ordinary message also carries one small camera frame
 * the host already has (`glance`; with 「姿势识别」 also on only when the pose changed, electron/camera-glance.ts). A no to looking
 * holds the camera too (`hold`, kept in electron/runtime.ts so the owner window stops drawing frames).
 */

/** What the window says about the message it is about to send (preload `sharedAttachments(hint)`). */
export interface LookHint { text?: string; look?: boolean }
/** What is switched on now, and the conversation it belongs to (an offer from another conversation or media state is void). */
export interface LookState {
  /** `camera`: 「发图片」 is on and its window can give frames (I-036); 「姿势识别」 alone gives no picture. */
  screen: boolean; camera: boolean; scope: string;
  /** 「发图片」 is held: the user said not to look (electron/runtime.ts MediaRuntime.holdCamera). */
  cameraHeld?: boolean;
  /** Which opening of screen sharing this is (electron/runtime.ts MediaRuntime.openings.screen): a no lasts until it changes. */
  screenOpening?: number;
}
/**
 * Every screen or camera decision takes a new frame right then; null: none this turn.
 * I-036 「发图片」: `glance` (present only when true): this message carries the small camera frame the
 * host keeps ready (electron/camera-glance.ts decides, with 「姿势识别」 also on, whether it goes); nothing is captured for it.
 * `hold` (present only when it changes): true, the user said not to look, so no small frame goes and none is drawn until the user
 * asks her to look (false) or turns 「发图片」 off and on.
 */
export interface LookDecision { screen: boolean; camera: boolean; via: 'button' | 'words' | 'offer' | null; glance?: true; hold?: boolean }

/** How long her "要我凑近看看吗" stays open for a short yes (and the pet's prompt for it stays up). */
export const LOOK_OFFER_TTL_MS = 10 * 60_000;

/** Her open look offer as the pet's prompt sees it (src/ui/LookOfferPrompt.ts): an id to answer it by, and how long it stays. */
export interface LookOfferView { id: string; ttlMs: number }

/**
 * A "别看我屏幕" holds for the messages after it, not only its own: the user said stop, so she does not look again — and is not told
 * the rough reading either — until the user asks her to (words, the button, a yes to her offer) or turns sharing off and on. Taken by
 * recommendation (V1, kept for 屏幕只读大概: "别看" should also stop "你在写代码呀"); undo: set this to false.
 */
export const REFUSAL_HOLDS = true;

/**
 * A short "不用" to her "要我凑近看看吗" (in words or on the pet's prompt) closes the offer without a frame, and is not a "别看": she still
 * knows roughly what the user is doing, as the user chose (A). Taken by recommendation (in V1 it held like "别看", because there it
 * stopped the frame on every message; here the user only said no to looking closer); undo: set this to true.
 */
export const DECLINE_HOLDS = false;

/**
 * R10 "按心情主动看画面聊天" starts off (2026-11-03, after 识图第 1 步): when it is on and screen sharing is on, her
 * proactive turns still hand the chat model a whole-screen capture, which is how the screen's contents reached her
 * replies. Until 识图第 3 步 replaces it with "看一看" (a small image, mood only), she does not look on her own unless
 * the user turns it on in the privacy page. Taken by recommendation (CLAUDE.md rule 8; R10 was never confirmed);
 * undo: set this back to true.
 */
export const PROACTIVE_VISION_DEFAULT = false;

/** Older windows send no hint (nothing is attached then); anything else must be exactly this shape. */
export function validateLookHint(value: unknown): LookHint {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('附图请求格式不正确。');
  const hint = value as Record<string, unknown>;
  if (Object.keys(hint).some(key => key !== 'text' && key !== 'look')
    || ('text' in hint && (typeof hint.text !== 'string' || hint.text.length > 20_000))
    || ('look' in hint && typeof hint.look !== 'boolean')) throw new Error('附图请求格式不正确。');
  return { ...(typeof hint.text === 'string' ? { text: hint.text } : {}), ...(hint.look === true ? { look: true } : {}) };
}

const NONE: LookDecision = Object.freeze({ screen: false, camera: false, via: null });
/** Which opening of screen sharing a no belongs to; without the opening number the conversation and media scope stands in. */
const openingOf = (state: LookState): number | string => state.screenOpening ?? state.scope;

export class LookTurns {
  private offer: { scope: string; at: number; id: string } | null = null;
  /** The user said no to looking in this opening of screen sharing (REFUSAL_HOLDS). */
  private refused: { opening: number | string } | null = null;
  /**
   * `changed`: her offer opened (its view) or closed (null), for the pet's prompt (electron/main.ts broadcasts it). Called after the
   * change; a listener that throws changes nothing here.
   */
  constructor(private readonly clock: () => number = Date.now, private readonly changed: (offer: LookOfferView | null) => void = () => {}) {}

  /**
   * Her reply on `turnScope` (sharing on, no frame that turn) asked whether to look closer. Kept only while the conversation and
   * the media state are what they were when the turn started.
   */
  noteOffer(turnScope: string, currentScope: string): void {
    if (!turnScope || turnScope !== currentScope) return;
    this.offer = { scope: turnScope, at: this.clock(), id: randomUUID() };
    this.tell({ id: this.offer.id, ttlMs: LOOK_OFFER_TTL_MS });
  }

  /** A pending offer (tests and the developer panel); never a frame. */
  get offerOpen(): boolean { return this.offer !== null; }

  /** The user's no still holds in this opening of screen sharing (tests, the turn's perception line, the rough reading's looks). */
  refusedIn(state: LookState): boolean { return !!this.refused && this.refused.opening === openingOf(state); }

  /** Her offer is void (a new conversation, a cleared vision context, sharing off). A no is not: only the user lifts it, or sharing restarts. */
  clear(): void { this.close(); }

  /**
   * The user pressed "不用" on the pet's prompt for this offer: like a short "不用" in words, the offer closes without a frame
   * (DECLINE_HOLDS). An id that is not the open offer's (answered, expired, replaced) changes nothing. True when it closed one.
   */
  decline(id: unknown, state: LookState): boolean {
    if (typeof id !== 'string' || !this.offer || this.offer.id !== id) return false;
    this.close();
    if (DECLINE_HOLDS && state.screen) this.refused = { opening: openingOf(state) };
    return true;
  }

  /**
   * The host received a message from the user. Whatever the user sends next answers her offer, also a message that never asks
   * for attachments (a local control like "暂停朗读", a developer test command): without this, "要我凑近看看吗" → "暂停朗读" →
   * "嗯" took the screen on the old offer (Codex T-112 round 030, static review). For an ordinary message `decide` has already
   * answered it, so this is a no-op then.
   */
  userTurn(): void { this.close(); }

  /** The message about to be sent: which frames it carries. Throws on a malformed hint before anything is taken. */
  decide(value: unknown, state: LookState): LookDecision {
    const hint = validateLookHint(value);
    return this.cameraPart(this.screenPart(hint, state), hint, state);
  }

  /**
   * I-036 「发图片」: with it on, every message carries the small frame, unless this message asks her to look at the user (then a
   * clear one), says no to looking ("别看我", or any no to looking: unsure is no), or cannot be read. A no holds for the messages
   * after it until the user asks her to look at them; a message without words (an older window) carries nothing, as before.
   */
  private cameraPart(decision: LookDecision, hint: LookHint, state: LookState): LookDecision {
    if (!state.camera) return decision;
    const withheld = hint.text === undefined ? null : withheldLook(hint.text);
    const wasHeld = state.cameraHeld === true;
    const held = decision.camera ? false : withheld === 'refused' ? true : wasHeld;
    const glance = !decision.camera && !held && hint.text !== undefined && withheld !== 'refused' && withheld !== 'unread';
    return { ...decision, ...(glance ? { glance: true as const } : {}), ...(held !== wasHeld ? { hold: held } : {}) };
  }

  private screenPart(hint: LookHint, state: LookState): LookDecision {
    const offer = this.offer;
    this.close();
    if (this.refused && this.refused.opening !== openingOf(state)) this.refused = null; // sharing was turned off and on: a new yes
    if (hint.look) return state.screen ? this.looked({ screen: true, camera: false, via: 'button' }) : NONE;
    const asked = scanLookRequest(hint.text);
    if (asked) {
      const screen = state.screen && asked !== 'camera';
      const camera = state.camera && (asked === 'camera' || (asked === 'either' && !state.screen));
      return screen || camera ? this.looked({ screen, camera, via: 'words' }) : NONE;
    }
    const age = offer ? this.clock() - offer.at : Infinity;
    const open = !!offer && state.screen && !!state.scope && offer.scope === state.scope && age >= 0 && age <= LOOK_OFFER_TTL_MS;
    if (open && isLookAffirmation(hint.text)) return this.looked({ screen: true, camera: false, via: 'offer' });
    // 屏幕只读大概: nothing asked, nothing taken. A no from the user's own words holds (her rough reading is not told either).
    if (!state.screen || hint.text === undefined) return NONE;
    const refused = withheldLook(hint.text) === 'refused' || (DECLINE_HOLDS && open && isLookDecline(hint.text));
    if (refused && REFUSAL_HOLDS) this.refused = { opening: openingOf(state) };
    return NONE;
  }

  /** The user asked her to look at the screen: a no from before is over. */
  private looked(decision: LookDecision): LookDecision {
    if (decision.screen) this.refused = null;
    return decision;
  }

  private close(): void {
    if (!this.offer) return;
    this.offer = null;
    this.tell(null);
  }

  private tell(view: LookOfferView | null): void {
    try { this.changed(view); } catch { /* the prompt is only a view of the offer */ }
  }
}
