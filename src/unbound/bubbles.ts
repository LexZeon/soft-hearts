/**
 * Unbound v1 step 2: the small things drawn beside her head (docs/claude/2026-11-15-unbound-v1-step2-typing.md): her reply bubble
 * (the whole reply, readable, following her), the line the user just sent (shown briefly), and the light for the senses in use.
 * Text only through textContent. The bubble and the line take no mouse (pointer-events: none); the light is only "hit" by the
 * page's own pointer test, so its hover text can show (the window is click-through everywhere else).
 */
import type { UnboundBubble } from '../../shared/unbound/scene';
import { litSenses, senseLines, SENSE_LABELS, type UnboundSenses } from '../../shared/unbound/senses';
import { readBubbleLingerMs } from '../../shared/brain';
import { placeBubble, type HeadSpot } from '../../shared/unbound/typing';
import { uiText } from '../foundation/ui-language';

const BUBBLE_FADE_MS = 600;
const SAID_SHOW_MS = 3_500;
const SAID_MAX_CHARS = 60;
const NOTICE_SHOW_MS = 7_000;
const NOTICE_MAX_CHARS = 120;

interface Win { width: number; height: number }

/** A voice flag that never comes back false stops holding the bubble after this long (the mouth's own limit). */
export const VOICE_HOLD_MAX_MS = 90_000;

/**
 * Her reply: the whole text (the newest part in view while it streams in), then it stays long enough to read, then fades.
 * Read-aloud (docs/claude/2026-11-15-unbound-read-aloud.md): it says exactly what it has on screen (`state`, for the host's
 * display proof), and while a voice is sounding a finished bubble waits instead of fading under her words.
 */
export class ReplyBubble {
  private readonly node: HTMLDivElement;
  private id = '';
  private text = '';
  /** The host's revision of `text` (UnboundBubble.rev); 0 until one arrives. */
  private rev = 0;
  private fading = false;
  private placed = false;
  /** A voice is sounding; `waiting` is the linger a finished bubble will take once it stops. */
  private voice = false;
  private waiting: number | null = null;
  /** How long this finished bubble stays, as the host decided (UnboundBubble.lingerMs): the same rule as the companion window's. */
  private lingerMs = 0;
  private voiceTimer: ReturnType<typeof setTimeout> | null = null;
  /** The running countdown is a finished bubble's linger (a voice may pause it), not a retraction. */
  private holdable = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private size: Win | null = null;
  constructor(parent: HTMLElement) {
    this.node = parent.ownerDocument.createElement('div');
    this.node.className = 'unbound-bubble';
    this.node.hidden = true;
    parent.append(this.node);
  }
  /** A reply is on screen (the frame-rate governor keeps the full rate while she speaks). */
  get shown(): boolean { return !this.node.hidden; }
  /** The text on screen now (for the speech's proof and the tests). */
  get current(): string { return this.node.hidden ? '' : this.text.trim(); }
  receive(bubble: UnboundBubble): void {
    if (bubble.id !== this.id) { this.id = bubble.id; this.text = ''; this.rev = 0; }
    if (bubble.type === 'delta' && bubble.hold === true && !bubble.text && !this.text) {
      // I-165: her reply is on its way and will be shown as her voice reaches it: "……" until then (never empty, nothing to prove).
      this.rev = 0; this.node.textContent = '……'; this.size = null;
      this.show(); this.clearTimer(); this.waiting = null;
      return;
    }
    if (bubble.type === 'delta') {
      this.text += bubble.text;
      this.rev = Number.isSafeInteger(bubble.rev) && (bubble.rev as number) > 0 ? bubble.rev as number : 0; // no revision: nothing to prove
      const shown = this.text.trim();
      this.node.textContent = shown;
      this.size = null;
      if (shown) { this.show(); this.clearTimer(); this.waiting = null; this.node.scrollTop = this.node.scrollHeight; }
    } else if (bubble.type === 'done') { this.lingerMs = readBubbleLingerMs(bubble.lingerMs); this.later(this.lingerMs, true); }
    else this.later(0, false);
  }
  /** Beside her head (window pixels), above it when it fits; hidden when her head is not on the window. */
  place(head: HeadSpot | null, win: Win, visible: boolean): void {
    if (!visible || !head) { this.node.style.visibility = 'hidden'; this.placed = false; return; }
    this.node.style.visibility = '';
    this.placed = true;
    if (this.node.hidden) return;
    this.size ??= { width: this.node.offsetWidth, height: this.node.offsetHeight };
    const spot = placeBubble(head, this.size, win);
    this.node.style.transform = `translate(${Math.round(spot.x)}px, ${Math.round(spot.y)}px)`;
  }
  /**
   * Read-aloud: exactly what is on screen after the last `place` (null before the host gave a revision): its id, the host's
   * revision, the whole untrimmed text, and whether it can be read now (shown, not fading, her head on the window).
   */
  state(): { id: string; rev: number; text: string; visible: boolean } | null {
    if (!this.id || !this.rev) return null;
    return { id: this.id, rev: this.rev, text: this.text, visible: !this.node.hidden && !this.fading && this.placed && !!this.text.trim() };
  }
  /** A voice started or stopped sounding: a finished bubble waits for it, then stays as long as the host decided (the window waits the same way). */
  voiceSounding(on: boolean): void {
    if (this.voiceTimer) { clearTimeout(this.voiceTimer); this.voiceTimer = null; }
    this.voice = on === true;
    if (this.voice) {
      this.voiceTimer = setTimeout(() => this.voiceSounding(false), VOICE_HOLD_MAX_MS);
      if (this.hideTimer && this.holdable && !this.fading && !this.node.hidden) { this.clearTimer(); this.waiting ??= this.lingerMs; } // the countdown pauses
      return;
    }
    const linger = this.waiting;
    this.waiting = null;
    if (linger !== null && !this.node.hidden) this.later(linger, true);
  }
  private show(): void { this.node.hidden = false; this.node.classList.remove('fading'); this.fading = false; }
  private later(ms: number, holdable: boolean): void {
    this.clearTimer();
    if (holdable && this.voice) { this.waiting = ms; return; } // she is still reading it out
    this.waiting = null;
    this.holdable = holdable;
    this.hideTimer = setTimeout(() => {
      this.node.classList.add('fading');
      this.fading = true;
      this.hideTimer = setTimeout(() => { this.node.hidden = true; this.node.classList.remove('fading'); this.fading = false; this.hideTimer = null; }, BUBBLE_FADE_MS);
    }, ms);
  }
  private clearTimer(): void { if (this.hideTimer) clearTimeout(this.hideTimer); this.hideTimer = null; }
}

/** The line the user just sent from the small box: a small grey pill under her chin for a few seconds. */
export class SaidLine {
  private readonly node: HTMLDivElement;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(parent: HTMLElement) {
    this.node = parent.ownerDocument.createElement('div');
    this.node.className = 'unbound-said';
    this.node.hidden = true;
    parent.append(this.node);
  }
  get shown(): boolean { return !this.node.hidden; }
  show(text: string): void {
    const line = String(text).replace(/\s+/g, ' ').trim();
    if (!line) return;
    this.node.textContent = `你：${line.length > SAID_MAX_CHARS ? `${line.slice(0, SAID_MAX_CHARS)}…` : line}`;
    this.node.hidden = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.node.hidden = true; this.timer = null; }, SAID_SHOW_MS);
  }
  /** I-159 D: the app's own line (already in the interface language), a little longer on screen than a line you said; no "你：". */
  showNotice(text: string): void {
    const line = String(text).replace(/\s+/g, ' ').trim();
    if (!line) return;
    this.node.textContent = line.length > NOTICE_MAX_CHARS ? `${line.slice(0, NOTICE_MAX_CHARS)}…` : line;
    this.node.hidden = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.node.hidden = true; this.timer = null; }, NOTICE_SHOW_MS);
  }
  place(head: HeadSpot | null, win: Win, visible: boolean): void {
    if (this.node.hidden) return;
    if (!visible || !head) { this.node.style.visibility = 'hidden'; return; }
    this.node.style.visibility = '';
    const x = Math.min(win.width - 8, Math.max(8, head.x)), y = Math.min(win.height - 30, head.y + head.r * 1.5);
    this.node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, 0)`;
  }
}

const DOT = 9, GAP = 4, PAD = 6;
const SENSE_COLORS: Readonly<Record<keyof UnboundSenses, string>> = { camera: '#42b883', microphone: '#e0605e', screen: '#4a90e2', audio: '#a070d8' };

/** One small dot per sense in use, left of her head; hovering it says which senses are on. Nothing is drawn while none is. */
export class SensesLight {
  private readonly node: HTMLDivElement;
  private readonly tip: HTMLDivElement;
  private senses: UnboundSenses | null = null;
  private rect: { x: number; y: number; width: number; height: number } | null = null;
  private hovered = false;
  constructor(parent: HTMLElement) {
    const doc = parent.ownerDocument;
    this.node = doc.createElement('div'); this.node.className = 'unbound-senses'; this.node.hidden = true;
    this.tip = doc.createElement('div'); this.tip.className = 'unbound-senses-tip'; this.tip.hidden = true;
    parent.append(this.node, this.tip);
  }
  set(senses: UnboundSenses | null): void {
    this.senses = senses;
    const lit = litSenses(senses);
    this.node.replaceChildren();
    for (const key of lit) {
      const dot = this.node.ownerDocument.createElement('span');
      dot.className = 'unbound-sense-dot'; dot.style.background = SENSE_COLORS[key]; dot.dataset.sense = key; dot.setAttribute('aria-label', SENSE_LABELS[key]);
      this.node.append(dot);
    }
    this.node.hidden = lit.length === 0;
    this.tip.textContent = senseLines(senses).map(line => uiText(line)).join('\n'); // I-159: through the language layer (the words are keys of the English copy)
    if (!lit.length) { this.rect = null; this.hover(false); }
  }
  get lit(): number { return litSenses(this.senses).length; }
  place(head: HeadSpot | null, win: Win, visible: boolean): void {
    const n = this.lit;
    if (!n || !visible || !head) { this.node.style.visibility = 'hidden'; this.rect = null; this.hover(false); return; }
    this.node.style.visibility = '';
    const width = n * DOT + (n - 1) * GAP + PAD * 2, height = DOT + PAD * 2;
    const x = Math.min(win.width - width - 4, Math.max(4, head.x - head.r * 1.9 - width)), y = Math.min(win.height - height - 4, Math.max(4, head.y - height / 2));
    this.rect = { x, y, width, height };
    this.node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    this.tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y + height + 4)}px)`;
  }
  /** Distance from a pointer to the light (px; 0 and below on it; Infinity while it is not drawn). */
  distance(px: number, py: number): number {
    const r = this.rect;
    if (!r || this.node.hidden) return Infinity;
    return Math.hypot(Math.max(r.x - px, 0, px - (r.x + r.width)), Math.max(r.y - py, 0, py - (r.y + r.height)));
  }
  /** The rectangle it is drawn at now (window px), or null. */
  where(): { x: number; y: number; width: number; height: number } | null { return this.rect ? { ...this.rect } : null; }
  hover(on: boolean): void {
    if (on === this.hovered) return;
    this.hovered = on;
    this.tip.hidden = !on || !this.tip.textContent;
  }
}
