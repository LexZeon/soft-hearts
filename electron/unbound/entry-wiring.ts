/**
 * Unbound v1 step 1: the Electron pieces for the normal ways in and out (electron/unbound/entry.ts): the permission page as the
 * host's own message box (with 「以后直接进，不再问」), the perception switches the internal channel also uses, the profile file,
 * and a short notice when something did not open. electron/main.ts only creates this and calls toggle / modeChanged / quit /
 * recover.
 */
import { dialog, type BrowserWindow, type MessageBoxOptions } from 'electron';
import type { FaceCheckView } from '../../shared/senses';
import type { UnboundState } from '../../shared/unbound/scene';
import type { PerceptionSwitches } from '../safety';
import { onWatchChange } from '../senses';
import { UnboundEntry, type ToggleResult } from './entry';
import { UnboundEntryStore } from './entry-store';
import { PermissionBundle, bundleFactsFrom, bundleSwitch, failedNotice, faceReadinessFrom, notOpenedNotice, openedNote, tellBundleOfWatch, type BundleItem } from './permission-bundle';

export interface UnboundEntryWiring {
  profileDirectory: string;
  state(): UnboundState;
  enter(): void;
  exit(): void;
  /** The user's own switches' host paths (electron/safety/agent-channel/bridge.ts); null until the control window registered them. */
  switches(): PerceptionSwitches | null;
  face(): FaceCheckView | null;
  /** A chat reply is being written. */
  replyRunning(): boolean;
  /** The control window, to hold the page when it is on screen. */
  parent(): BrowserWindow | null;
  translate(text: string, params?: Record<string, string>): string;
  /** I-159 D: a short line beside her (UnboundHost.notice). */
  said?(text: string): void;
  /** Why the last entry did not get her out (UnboundHost's view), for the notice. */
  error(): string | null;
  /** The way in is on (the channel's default or the user's switch in settings). */
  allowed?(): boolean;
  /** 2026-11-24 (user: "保留"): at the way back these items stayed on, because the user turned them on by hand while she was out. */
  kept?(items: BundleItem[]): void;
}
export interface UnboundEntryHandle {
  toggle(): Promise<ToggleResult>;
  modeChanged(state: UnboundState): void;
  quit(): Promise<void>;
  /** I-159 D: clears the saved 「以后直接进，不再问」 so the permission page comes again; true when one was saved. */
  askAgain(): Promise<boolean>;
  /** At start, once the windows and the face check are up: a session left by a run that died while she was out. */
  recover(): Promise<void>;
}

const noGuard = () => {};

export function createUnboundEntry(wiring: UnboundEntryWiring): UnboundEntryHandle {
  const store = new UnboundEntryStore(wiring.profileDirectory);
  const switches = () => { const value = wiring.switches(); if (!value) throw new Error('控制窗口尚未就绪。'); return value; };
  const set = async (item: BundleItem, on: boolean): Promise<void> => {
    const { kind, purposes } = bundleSwitch(item, on);
    await switches().set(kind, on, purposes, noGuard);
  };
  const read = () => bundleFactsFrom(switches().read());
  const face = () => faceReadinessFrom(wiring.face());
  let bundle: PermissionBundle | null = null;
  let stopWatching: (() => void) | null = null;
  const loaded = store.ready.then(record => {
    bundle = new PermissionBundle({
      read, face, set, save: session => store.setSession(session), replyRunning: () => wiring.replyRunning(),
      every: (ms, run) => { const timer = setInterval(run, ms); timer.unref?.(); return () => clearInterval(timer); },
      wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
      log: line => console.info(line),
      kept: items => wiring.kept?.(items),
    }, record.session);
    // 2026-11-24: 一起看 beginning or ending while she is out; the bundle tells the user's hand from its own steps (permission-bundle.ts).
    stopWatching?.();
    stopWatching = onWatchChange(change => tellBundleOfWatch(bundle, change));
    return new UnboundEntry({
      allowed: wiring.allowed, state: wiring.state, enter: wiring.enter, exit: wiring.exit, bundle, read, face, translate: wiring.translate,
      skipAsk: () => store.skipAsk, setSkipAsk: signature => store.setSkipAsk(signature),
      ask: async page => {
        const options: MessageBoxOptions = { type: 'question', title: `soft hearts · ${page.title}`, message: page.message, detail: page.detail,
          buttons: [page.cancel, page.confirm], defaultId: 0, cancelId: 0, noLink: true, checkboxLabel: page.checkbox, checkboxChecked: false };
        const parent = wiring.parent();
        const result = parent && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized()
          ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
        return { confirmed: result.response === 1, remember: result.response === 1 && result.checkboxChecked === true };
      },
      outcome: outcome => {
        const opened = openedNote(outcome, wiring.translate); // I-159 D: what this entry turned on, beside her for a few seconds
        if (opened) { try { wiring.said?.(opened); } catch { /* a courtesy line */ } }
        const notice = notOpenedNotice(outcome, wiring.translate);
        if (!notice) return;
        void dialog.showMessageBox({ type: 'info', title: `soft hearts · ${notice.title}`, message: notice.title, detail: notice.detail,
          buttons: [wiring.translate('知道了')], defaultId: 0, noLink: true }).catch(() => undefined);
      },
      failed: () => {
        const { title, detail } = failedNotice(wiring.error(), wiring.translate); // the reason, and that no sense was turned on
        void dialog.showMessageBox({ type: 'warning', title: `soft hearts · ${title}`, message: title, detail,
          buttons: [wiring.translate('知道了')], defaultId: 0, noLink: true }).catch(() => undefined);
      },
      log: line => console.info(line),
    });
  });
  const ready = (run: (entry: UnboundEntry) => unknown) => { void loaded.then(run).catch(error => console.error(error)); };
  return {
    toggle: async () => {
      // She is out: back at once, without waiting for anything.
      if (wiring.state() !== 'normal') { wiring.exit(); return 'back'; }
      return (await loaded).toggle();
    },
    modeChanged: state => ready(entry => entry.modeChanged(state)),
    quit: async () => { await (await loaded).quit(); },
    askAgain: () => store.clearSkipAsk(),
    recover: async () => { await loaded; await bundle?.recover(); },
  };
}
