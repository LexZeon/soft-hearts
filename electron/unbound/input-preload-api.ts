/**
 * Unbound v1 step 2: the whole API the small input box gets (`window.unboundInput`), from a minimal IPC surface so a test can
 * check it with a fake. Two requests and one event on fixed channels, plain values: send a line, close the box, and "you are
 * open now, clear and take the keyboard". No Node, no paths, no general invoke.
 * 2026-11-19: the 「打电话」 button adds one request (start / end the call: a boolean) and one event (the call is on / off).
 * I-190: the senses panel (docs/claude/2026-11-22-i190-source-pickers.md) adds four requests and two events, plain values only: the senses on
 * now (four booleans), the screen menu (opaque ids and the titles the host lists) and a pick by id, the panel's size; the screen choice
 * changed, and "open the panel" (a right click on her). Microphone and camera names never come this way: the page reads its own storage.
 */
import type { ScreenSourceMenuView, ScreenSourceView, WatchTogetherLook } from '../../shared/senses';
import type { UnboundSenses } from '../../shared/unbound/senses';
import type { DefaultPlaceLook } from '../../shared/unbound/life/place-record';
import type { CompanyLook } from '../../shared/unbound/company';
export const UNBOUND_INPUT_CHANNELS = Object.freeze({
  submit: 'unbound:input-submit',
  cancel: 'unbound:input-cancel',
  open: 'unbound:input-open',
  call: 'unbound:input-call',
  callState: 'unbound:input-call-state',
  senses: 'unbound:input-senses',
  screenMenu: 'unbound:input-screen-menu',
  chooseScreen: 'unbound:input-choose-screen',
  panel: 'unbound:input-panel',
  screenState: 'unbound:input-screen-state',
  panelOpen: 'unbound:input-panel-open',
  watch: 'unbound:input-watch',
  toggleWatch: 'unbound:input-toggle-watch',
  typed: 'unbound:input-typed',
  place: 'unbound:input-place',
  setPlace: 'unbound:input-set-place',
  company: 'unbound:input-company',
  setCompany: 'unbound:input-set-company',
} as const);

export interface UnboundInputIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
}
export interface UnboundInputApi {
  /** Enter: the host sends the line (ok), or says why not (hint) and the box stays open. */
  submit(text: string): Promise<{ ok: boolean; hint?: string }>;
  /** Esc: close the box. */
  cancel(): Promise<void>;
  /**
   * The host opened the box (again): empty it, focus the field. `language` is the interface language the host is showing ('' when it did
   * not say). 2026-11-22: `refill` is a line that did not go out, to put back in the field with its hint (a fixed host line, a copy key).
   */
  onOpen(callback: (language: string, refill?: { text: string; hint: string }, to?: string) => void): () => void;
  /** 「打电话」 / 「挂断」: the host starts or ends the call as the companion window's button does (ok false: the host's reason in `hint`; `on` is the call now). */
  call(on: boolean): Promise<{ ok: boolean; on: boolean; hint?: string }>;
  /** The call is on (true) or off (false): sent with every open and on every change. */
  onCallState(callback: (on: boolean) => void): () => void;
  /** I-190: the senses on now (the same four the light beside her shows); null before the host knows. */
  senses(): Promise<UnboundSenses | null>;
  /** I-190: the screens and other programs' windows 屏幕共享 may read, and the choice (opaque ids). */
  screenSourceMenu(): Promise<ScreenSourceMenuView>;
  /** I-190: an id from the last menu, or null for 跟着系统默认. Never turns sharing on or off. */
  chooseScreenSource(id: string | null): Promise<ScreenSourceView>;
  onScreenSource(callback: (view: ScreenSourceView) => void): () => void;
  /** I-190: the senses panel opened or closed: the host makes the box taller or back. */
  panel(open: boolean): Promise<void>;
  /** I-190: the host asks the page to open the panel (a right click on her opened the box). */
  onPanelOpen(callback: () => void): () => void;
  /** I-190: 「和她一起看」 as the eye button shows it (pressed, the "台词没在听" mark and its reason); null when the host cannot say. */
  watchTogether(): Promise<WatchTogetherLook | null>;
  /** I-190: one click of 「和她一起看」 (the screen and the dialogue; while she is out, off stops only the dialogue). */
  toggleWatchTogether(): Promise<WatchTogetherLook | null>;
  /**
   * 2026-11-23: a key went into the box just now (no text, no key: only that it happened; the page sends it at most a few times a second). Her
   * kiss / hug gate reads "you are typing now" from this, not from the box merely being open (electron/unbound/typing.ts typingNow).
   */
  typed(): Promise<void>;
  /** 2026-11-23: the user's default place for her (set, and whether she can be kept where she stands); null when the host cannot say. */
  defaultPlace(): Promise<DefaultPlaceLook | null>;
  /** (true: keep where she stands now) or its clear (false); the look after. Only this box's own click. */
  setDefaultPlace(on: boolean): Promise<DefaultPlaceLook | null>;
  /** I-209 step 1: who is on stage (the cards by name, who is there, why one cannot come); null when the host cannot say. */
  company(): Promise<CompanyLook | null>;
  /** I-209 step 1: bring one character out (true) or send her back (false); never the one you talk with. The look after. Only this box's own click. */
  setCompany(id: string, on: boolean): Promise<CompanyLook | null>;
}
export const UNBOUND_INPUT_API_KEYS = Object.freeze(['submit', 'cancel', 'onOpen', 'call', 'onCallState', 'senses', 'screenSourceMenu', 'chooseScreenSource', 'onScreenSource', 'panel', 'onPanelOpen', 'watchTogether', 'toggleWatchTogether', 'typed', 'defaultPlace', 'setDefaultPlace', 'company', 'setCompany'] as const);

export function createUnboundInputApi(ipc: UnboundInputIpc): UnboundInputApi {
  const listen = <T>(channel: string, read: (value: unknown) => T, callback: (value: T) => void) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event: unknown, value?: unknown) => callback(read(value));
    ipc.on(channel, listener);
    return () => { ipc.removeListener(channel, listener); };
  };
  const api: UnboundInputApi = {
    senses: () => ipc.invoke(UNBOUND_INPUT_CHANNELS.senses) as Promise<UnboundSenses | null>,
    screenSourceMenu: () => ipc.invoke(UNBOUND_INPUT_CHANNELS.screenMenu) as Promise<ScreenSourceMenuView>,
    chooseScreenSource: id => {
      if (id !== null && typeof id !== 'string') return Promise.reject(new TypeError('chooseScreenSource takes an id or null'));
      return ipc.invoke(UNBOUND_INPUT_CHANNELS.chooseScreen, id === null ? null : id.slice(0, 64)) as Promise<ScreenSourceView>;
    },
    onScreenSource: callback => listen(UNBOUND_INPUT_CHANNELS.screenState, value => (value && typeof value === 'object' ? value : { choice: null }) as ScreenSourceView, callback),
    panel: open => {
      if (typeof open !== 'boolean') return Promise.reject(new TypeError('panel takes a boolean'));
      return ipc.invoke(UNBOUND_INPUT_CHANNELS.panel, open) as Promise<void>;
    },
    onPanelOpen: callback => listen(UNBOUND_INPUT_CHANNELS.panelOpen, () => undefined, () => callback()),
    watchTogether: () => ipc.invoke(UNBOUND_INPUT_CHANNELS.watch) as Promise<WatchTogetherLook | null>,
    toggleWatchTogether: () => ipc.invoke(UNBOUND_INPUT_CHANNELS.toggleWatch) as Promise<WatchTogetherLook | null>,
    submit: text => {
      if (typeof text !== 'string') return Promise.reject(new TypeError('submit takes a string'));
      return ipc.invoke(UNBOUND_INPUT_CHANNELS.submit, text.slice(0, 20_000)) as Promise<{ ok: boolean; hint?: string }>;
    },
    cancel: () => ipc.invoke(UNBOUND_INPUT_CHANNELS.cancel) as Promise<void>,
    typed: () => ipc.invoke(UNBOUND_INPUT_CHANNELS.typed) as Promise<void>,
    defaultPlace: () => ipc.invoke(UNBOUND_INPUT_CHANNELS.place) as Promise<DefaultPlaceLook | null>,
    setDefaultPlace: on => {
      if (typeof on !== 'boolean') return Promise.reject(new TypeError('setDefaultPlace takes a boolean'));
      return ipc.invoke(UNBOUND_INPUT_CHANNELS.setPlace, on) as Promise<DefaultPlaceLook | null>;
    },
    company: () => ipc.invoke(UNBOUND_INPUT_CHANNELS.company) as Promise<CompanyLook | null>,
    setCompany: (id, on) => {
      if (typeof id !== 'string' || typeof on !== 'boolean') return Promise.reject(new TypeError('setCompany takes an id and a boolean'));
      return ipc.invoke(UNBOUND_INPUT_CHANNELS.setCompany, id.slice(0, 80), on) as Promise<CompanyLook | null>;
    },
    call: on => {
      if (typeof on !== 'boolean') return Promise.reject(new TypeError('call takes a boolean'));
      return ipc.invoke(UNBOUND_INPUT_CHANNELS.call, on) as Promise<{ ok: boolean; on: boolean; hint?: string }>;
    },
    onCallState: callback => {
      if (typeof callback !== 'function') throw new TypeError('callback must be a function');
      const listener = (_event: unknown, value?: unknown) => callback(value === true);
      ipc.on(UNBOUND_INPUT_CHANNELS.callState, listener);
      return () => { ipc.removeListener(UNBOUND_INPUT_CHANNELS.callState, listener); };
    },
    onOpen: callback => {
      if (typeof callback !== 'function') throw new TypeError('callback must be a function');
      const listener = (_event: unknown, value?: unknown) => {
        if (typeof value === 'string') { callback(value.slice(0, 16)); return; }
        const v = value && typeof value === 'object' ? value as { language?: unknown; text?: unknown; hint?: unknown; to?: unknown } : {};
        const language = typeof v.language === 'string' ? v.language.slice(0, 16) : '', to = typeof v.to === 'string' && v.to.trim() ? v.to.slice(0, 40) : undefined; // I-209 step 3: whose box
        const refill = typeof v.text === 'string' && v.text ? { text: v.text.slice(0, 2_000), hint: typeof v.hint === 'string' ? v.hint.slice(0, 200) : '' } : undefined;
        if (to) callback(language, refill, to); else if (refill) callback(language, refill); else callback(language);
      };
      ipc.on(UNBOUND_INPUT_CHANNELS.open, listener);
      return () => { ipc.removeListener(UNBOUND_INPUT_CHANNELS.open, listener); };
    },
  };
  return Object.freeze(api);
}
