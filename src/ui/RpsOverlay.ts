/**
 * G1 猜拳, pet window (docs/claude/2026-11-03-rps.md): the three small buttons beside her, her invitation's two buttons,
 * the score and the "石头——剪刀——布！" call. The buttons are one RpsHandInput ("我出了什么"); a camera gesture reader can
 * be another later. Her words are not shown here: they go to the ordinary chat bubble and voice (src/ui/rps-speech.ts). The window never decides anything: it shows the host's view and sends the user's hand.
 */
import { registerUiMessages } from '../../shared/ui-language';
import { RPS_HANDS, RPS_TIMING, type RpsHand, type RpsHandInput, type RpsResponseRequest, type RpsThrowRequest, type RpsView } from '../../shared/rps';
import { uiText } from './ui-language';
import { RpsSpeech, type RpsSayPorts } from './rps-speech';
export { petSayPorts } from './rps-speech';

registerUiMessages({
  en: { '石头': 'Rock', '剪刀': 'Scissors', '布': 'Paper', '布！': 'Paper!', '来！': "Let's play!", '下次吧': 'Next time', '不玩了': 'Stop playing',
    '你 {0} · 她 {1}': 'You {0} · Her {1}', '猜拳': 'Rock paper scissors', '出石头': 'Throw rock', '出剪刀': 'Throw scissors', '出布': 'Throw paper' },
  'zh-CN': {},
});

const HAND_LABEL: Readonly<Record<RpsHand, string>> = { rock: '石头', scissors: '剪刀', paper: '布' };
const HAND_ICON: Readonly<Record<RpsHand, string>> = { rock: '✊', scissors: '✌️', paper: '✋' };
const CALL = ['石头', '剪刀', '布！'] as const;

/** What the overlay shows for a view, `sinceMs` after it arrived. Pure, for tests. */
export interface RpsOverlayModel {
  visible: boolean;
  /** The call word on the beat, or null. */
  call: string | null;
  hands: { hand: RpsHand; enabled: boolean; chosen: boolean }[];
  invite: boolean;
  quit: boolean;
  score: string | null;
}
export function rpsOverlayModel(view: RpsView | null, sinceMs: number): RpsOverlayModel {
  const none: RpsOverlayModel = { visible: false, call: null, hands: [], invite: false, quit: false, score: null };
  if (!view) return none;
  if (view.phase === 'invite') return { ...none, visible: true, invite: true };
  // Her answer to "下次吧": only words, and they are in the chat bubble.
  if (view.phase === 'aside') return none;
  const t = view.elapsedMs + Math.max(0, sinceMs), lead = RPS_TIMING.leadMs, beat = view.beatMs;
  const call = view.phase === 'count' ? (t < lead ? null : CALL[Math.min(2, Math.floor((t - lead) / beat))]) : view.phase === 'wait' ? CALL[2] : null;
  const showHands = view.phase === 'ready' || view.phase === 'count' || view.phase === 'wait' || view.phase === 'reveal';
  return {
    visible: true, call,
    hands: showHands ? RPS_HANDS.map(hand => ({ hand, enabled: view.accepting, chosen: view.userHand === hand })) : [],
    invite: false, quit: view.phase !== 'end',
    score: uiText('你 {0} · 她 {1}', '●'.repeat(view.score.user) + '○'.repeat(Math.max(0, view.firstTo - view.score.user)),
      '●'.repeat(view.score.her) + '○'.repeat(Math.max(0, view.firstTo - view.score.her))),
  };
}

export interface RpsOverlayAPI {
  rpsGet(): Promise<RpsView | null>;
  rpsThrow(input: RpsThrowRequest): Promise<string>;
  rpsRespond(input: RpsResponseRequest): Promise<boolean>;
  rpsEvents(callback: (view: RpsView | null) => void): () => void;
}
export interface RpsOverlayAnchor {
  x: number; y: number; visible: boolean; radius?: number;
  /** Her raised hand (wrist) and elbow on screen while she plays (MmdStage reportFaceAnchor); absent while the arm is down. */
  raisedHand?: { x: number; y: number; elbowX: number; elbowY: number };
}

/** "我出了什么" by clicking: the three buttons. */
export class ClickHandInput implements RpsHandInput {
  readonly source = 'click' as const;
  private listener: ((hand: RpsHand) => void) | null = null;
  start(onHand: (hand: RpsHand) => void): () => void { this.listener = onHand; return () => { if (this.listener === onHand) this.listener = null; }; }
  /** A button was pressed. */
  press(hand: RpsHand): void { this.listener?.(hand); }
}

interface Doc { createElement(tag: string): HTMLElement }
export class RpsOverlay {
  private view: RpsView | null = null;
  private receivedAt = 0;
  private unsubscribe: (() => void) | null = null;
  private stopInput: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly root: HTMLElement;
  private readonly callEl: HTMLElement;
  private readonly scoreEl: HTMLElement;
  private readonly handsEl: HTMLElement;
  private readonly inviteEl: HTMLElement;
  private readonly quitEl: HTMLButtonElement;
  private readonly buttons = new Map<RpsHand, HTMLButtonElement>();
  readonly input = new ClickHandInput();
  private readonly speech: RpsSpeech | null;
  private disposed = false;

  constructor(parent: HTMLElement, private readonly api: RpsOverlayAPI, private readonly options: {
    /** The stage: her arm, hand and face follow the same view. */
    stage?: { setRps(view: RpsView | null): void };
    /** Her words: the ordinary chat bubble and voice (rps-speech.ts petSayPorts). Omitted: her lines are only reported done. */
    say?: RpsSayPorts;
    now?: () => number;
    document?: Doc;
  } = {}) {
    const doc = options.document ?? document;
    const el = (tag: string, className: string) => { const node = doc.createElement(tag); node.className = className; return node; };
    this.root = el('div', 'rps-overlay'); this.root.hidden = true; this.root.setAttribute('role', 'group'); this.root.setAttribute('aria-label', uiText('猜拳'));
    // A pet control area: pointer events here are buttons, never a pat or a pinch (MoodCompanion isPetControlPoint).
    this.root.dataset.moodUi = 'true';
    this.callEl = el('div', 'rps-call');
    this.scoreEl = el('div', 'rps-score');
    this.handsEl = el('div', 'rps-hands');
    for (const hand of RPS_HANDS) {
      const button = el('button', 'rps-hand') as HTMLButtonElement;
      button.type = 'button'; button.textContent = HAND_ICON[hand];
      button.setAttribute('aria-label', uiText(`出${HAND_LABEL[hand]}`)); button.title = uiText(HAND_LABEL[hand]);
      button.onclick = () => this.input.press(hand);
      this.buttons.set(hand, button); this.handsEl.append(button);
    }
    this.inviteEl = el('div', 'rps-invite');
    const yes = el('button', 'rps-yes') as HTMLButtonElement, no = el('button', 'rps-no') as HTMLButtonElement;
    yes.type = no.type = 'button'; yes.textContent = uiText('来！'); no.textContent = uiText('下次吧');
    yes.onclick = () => this.respond('accept'); no.onclick = () => this.respond('decline');
    this.inviteEl.append(yes, no);
    this.quitEl = el('button', 'rps-quit') as HTMLButtonElement;
    this.quitEl.type = 'button'; this.quitEl.textContent = '×'; this.quitEl.setAttribute('aria-label', uiText('不玩了')); this.quitEl.title = uiText('不玩了');
    this.quitEl.onclick = () => this.respond('quit');
    this.root.append(this.callEl, this.scoreEl, this.handsEl, this.inviteEl, this.quitEl);
    parent.append(this.root);
    // Round 028: a line it did not show is `skipped`, so the host does not count it as said.
    const said = (id: string, shown: boolean) => { void this.api.rpsRespond({ id, action: shown ? 'said' : 'skipped' }).catch(() => {}); };
    this.speech = new RpsSpeech(options.say ?? { free: () => false, voiceOn: () => false, show: () => {}, speak: async () => {}, ended: () => {} }, said);
  }

  private now(): number { return (this.options.now ?? (() => performance.now()))(); }

  async init(): Promise<void> {
    if (this.unsubscribe || this.disposed) return;
    this.unsubscribe = this.api.rpsEvents(view => this.show(view));
    this.stopInput = this.input.start(hand => this.throwHand(hand));
    try { const view = await this.api.rpsGet(); if (!this.view) this.show(view); } catch { /* No game open. */ }
  }

  /** A newer view from the host (older revisions are ignored). */
  show(view: RpsView | null): void {
    if (this.disposed) return;
    if (view && this.view && view.id === this.view.id && view.revision < this.view.revision) return;
    this.view = view ? structuredClone(view) : null;
    this.receivedAt = this.now();
    try { this.options.stage?.setRps(this.view); } catch { /* The stage may be reloading a model. */ }
    this.render();
    this.speech?.view(this.view);
  }

  /**
   * Beside her, on the side of her right hand: with the hand up for the game (pretrial 2026-11-03: the buttons and the × sat on her
   * raised arm and scarf), just below the arm and out from it; before that, to the viewer's left of her face, a little lower.
   * Clamped into the window. The CSS eases the move between the two.
   */
  place(anchor: RpsOverlayAnchor, width: number, height: number): void {
    const style = this.root.style;
    if (!anchor.visible) { style.left = '50%'; style.top = ''; style.bottom = '96px'; style.transform = 'translateX(-50%)'; return; }
    const r = anchor.radius ?? 40, hand = anchor.raisedHand;
    const fx = hand ? Math.min(hand.x, hand.elbowX) - 120 : anchor.x - r * 3.4 - 80, fy = hand ? Math.max(hand.y, hand.elbowY) + r * 0.6 : anchor.y + r * 0.9;
    const x = Math.max(8, Math.min(width - 168, fx)), y = Math.max(8, Math.min(height - 150, fy));
    style.left = `${Math.round(x)}px`; style.top = `${Math.round(y)}px`; style.bottom = ''; style.transform = '';
  }

  private throwHand(hand: RpsHand): void {
    const view = this.view;
    if (!view || !view.accepting || view.userHand) return;
    this.view = { ...view, userHand: hand, accepting: false };
    this.render();
    void this.api.rpsThrow({ gameId: view.id, round: view.round, hand, source: this.input.source }).catch(() => {});
  }

  private respond(action: RpsResponseRequest['action']): void {
    const view = this.view;
    if (!view) return;
    void this.api.rpsRespond({ id: view.id, action }).catch(() => {});
  }

  private render(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const model = rpsOverlayModel(this.view, this.now() - this.receivedAt);
    this.root.hidden = !model.visible;
    this.root.dataset.phase = this.view?.phase ?? '';
    this.callEl.textContent = model.call ? uiText(model.call) : ''; this.callEl.hidden = !model.call;
    this.scoreEl.textContent = model.score ?? ''; this.scoreEl.hidden = !model.score;
    this.handsEl.hidden = model.hands.length === 0;
    for (const { hand, enabled, chosen } of model.hands) {
      const button = this.buttons.get(hand)!;
      button.disabled = !enabled; button.classList?.toggle('rps-chosen', chosen);
      button.setAttribute('aria-pressed', chosen ? 'true' : 'false');
    }
    this.inviteEl.hidden = !model.invite;
    this.quitEl.hidden = !model.quit;
    // The call advances on the beat without a new view.
    if (this.view?.phase === 'count') this.timer = setTimeout(() => this.render(), Math.max(30, this.view.beatMs / 4));
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.(); this.stopInput?.();
    if (this.timer) clearTimeout(this.timer);
    this.root.remove();
  }
}
