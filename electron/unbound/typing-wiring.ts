/**
 * Unbound v1 step 2: the Electron pieces for typing to her (electron/unbound/typing.ts): the global shortcut, the small input
 * window, the touch sink. electron/main.ts only creates this, passes the chat path (`say`) and calls click / modeChanged / quit.
 */
import { globalShortcut } from 'electron';
import type { UnboundState } from '../../shared/unbound/scene';
import type { UnboundTouchReport } from '../../shared/unbound/typing';
import { reportTouch } from '../mood';
import type { UnboundHost } from './host';
import { InputBoxWindow, type InputScreenPorts } from './input-window';
import type { InputWatch } from './input-watch';
import type { InputCallBridge } from './input-call';
import { panelPlace, type PanelPlaceRow } from './place-panel';
import { UnboundTyping, type SayResult, type SayTag } from './typing';
import type { UnboundSayAcks } from './say-ack';
import type { UnboundPageSource } from './window';

export interface UnboundTypingWiring {
  page: UnboundPageSource;
  /** The host of the one you talk to (I-209 step 3: the one you clicked last on stage): the box opens beside her, her line shows near her. */
  host(): UnboundHost | null;
  /** The first one's host (the 「谁在场」 rows are hers); absent: `host`. */
  main?(): UnboundHost | null;
  /** I-209 step 3: the name of the one you talk to while several are on stage (null alone): her box says so. */
  to?(): string | null;
  /** The chat path: send this line as the user's message (electron/main.ts). */
  say(text: string, tag?: SayTag): SayResult;
  /** 2026-11-22: the control window's word on each line (electron/unbound/say-ack.ts). */
  acks?: UnboundSayAcks;
  /** The 「打电话」 button's bridge to the voice call (electron/unbound/input-call.ts). */
  call: InputCallBridge;
  /** I-190: the app's one screen choice, for the box's senses panel (electron/wiring/screen-source-wiring.ts). */
  screen?: InputScreenPorts;
  /** I-190: 「和她一起看」 in the box's senses panel (electron/unbound/input-watch.ts). */
  watch?: InputWatch;
  /** 2026-11-24: one journal row for each click of the panel's 「设为默认位置」 / 「清除」 (electron/unbound/place-panel.ts). */
  placeJournal?(row: PanelPlaceRow): void;
}
export interface UnboundTypingHandle {
  click(report: UnboundTouchReport): void;
  modeChanged(state: UnboundState): void;
  quit(): void;
  /** Step 4: her input box is open (you are typing to her). */
  boxOpen(): boolean;
  /** 2026-11-23: you typed into her box within the last moment (her kiss / hug gate). */
  typingNow(): boolean;
}

export function createUnboundTyping(wiring: UnboundTypingWiring): UnboundTypingHandle {
  const host = () => wiring.host(), main = () => (wiring.main ? wiring.main() : wiring.host());
  const input: InputBoxWindow = new InputBoxWindow({ page: wiring.page, submit: text => typing.submit(text), cancel: () => typing.cancel(), call: wiring.call, state: () => host()?.state ?? 'normal',
    senses: () => host()?.senseState ?? null, screen: wiring.screen, watch: wiring.watch, typed: () => typing.typed(), // I-190: the senses panel; 2026-11-23 keystrokes
    place: panelPlace({ places: () => host()?.places ?? null, walking: () => host()?.life?.view().running?.action === 'place', journal: wiring.placeJournal }), // 2026-11-23: 设为默认位置; 11-24: always answers (place-panel.ts)
    company: { look: async () => (await main()?.company.look()) ?? null, set: async (id, on) => (await main()?.company.set(id, on)) ?? null }, to: () => wiring.to?.() ?? null }); // I-209: 谁在场 (the first one's rows)
  const typing: UnboundTyping = new UnboundTyping({
    touch: reportTouch, say: wiring.say, acks: wiring.acks,
    shortcut: { register: (accelerator, run) => globalShortcut.register(accelerator, run), unregister: accelerator => globalShortcut.unregister(accelerator) },
    input, state: () => host()?.state ?? 'normal', window: () => host()?.windowRect() ?? null,
    askHead: () => host()?.askHead() ?? Promise.resolve(null), said: text => host()?.said(text), clock: () => Date.now(),
  });
  return { click: report => typing.click(report), modeChanged: state => typing.modeChanged(state), quit: () => { typing.quit(); input.dispose(); }, boxOpen: () => typing.boxOpen, typingNow: () => typing.typingNow };
}
