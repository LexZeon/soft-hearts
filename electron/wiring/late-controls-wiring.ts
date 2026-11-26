// The control window loaded late (overhaul step 8, docs/claude/2026-11-17-lazy-loading-step8.md; plan section 4): a developer switch, off by
// default (SOFT_HEARTS_LATE_CONTROLS=1; the user turns it on only after trying it). With it on, the control window is still made at start-up
// (its webContents id, the guard and secureWindow are as before) but its page is not loaded with the companion's. It loads the first time
// anything shows it (every path goes through controls.show: the tray, a second start, openControls, a prompt, Claude tasks, the start-up
// decision initialControlsVisible) or sends it an action (below). That saves one renderer process while it stays hidden.
// What a page that is not there yet would lose, and what this file does about it (each risk is listed with its check in the record):
// - A push that starts something in the window (CONTROL_ACTION_CHANNELS: 「带我去」's page, a Claude task proposal, an agent-channel action,
//   Unbound typing's line) is held and sent once the page is ready, in order; such a push also starts the load (Unbound typing then still
//   reaches the chat box, with the window hidden, as before).
// - Every other push (state the window shows) goes out as before: the page reads the current state with its own initial call when it loads.
// - "Ready": the page asked for the character cards (getCharacterCards, the last call its start-up waits for, src/main.ts init) and that
//   call was answered: every listener it has is attached by then. tests/late-controls.test.ts pins that order in src/main.ts.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import type { BrowserWindow } from 'electron';
import { onAnswered } from './ipc-wiring';

/** The developer switch (an environment variable, like SOFT_HEARTS_CALM_PACE): '1' turns the late load on. */
export const LATE_CONTROLS_ENV = 'SOFT_HEARTS_LATE_CONTROLS';
/** Host pushes that start something in the control window: held until its page is ready. */
export const CONTROL_ACTION_CHANNELS: readonly string[] = ['desk:control-navigate', 'desk:codex-task-proposal', 'desk:agent-channel-action', 'desk:unbound-say'];
/** The call the control window's start-up waits for last: once it is answered, the page listens to everything. */
export const CONTROLS_READY_METHOD = 'getCharacterCards';

export function lateControlsRequested(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[LATE_CONTROLS_ENV] === '1';
}

export type LateControlsState = 'waiting' | 'loading' | 'ready';
export interface LateControls {
  state(): LateControlsState;
  /** Starts the load now (the first show, an action push); the same promise each time. */
  load(): Promise<void>;
}

/**
 * The control window's page waits for its first show (or action). `load` loads it (electron/wiring/shell-wiring.ts loadWindow). The
 * window's show and its webContents' send are wrapped on this one window (every caller is unchanged).
 */
export function deferControlsLoad(controls: BrowserWindow, load: () => Promise<void>): LateControls {
  let state: LateControlsState = 'waiting';
  let loading: Promise<void> | null = null;
  const held: [string, unknown[]][] = [];
  const contents = controls.webContents;
  const send = contents.send.bind(contents);
  const show = controls.show.bind(controls);
  const start = (): Promise<void> => {
    if (!loading) { state = 'loading'; loading = load(); loading.catch(() => undefined); }
    return loading;
  };
  const stop = onAnswered(CONTROLS_READY_METHOD, sender => {
    if (sender !== contents.id || state === 'ready') return;
    state = 'ready';
    stop();
    // After the answer has gone out (Electron replies once the handler's promise settled), so the page has its cards first.
    setTimeout(() => { for (const [channel, args] of held.splice(0)) { if (!contents.isDestroyed()) send(channel, ...args); } }, 0);
  });
  controls.show = () => { void start(); show(); };
  contents.send = (channel: string, ...args: unknown[]) => {
    if (state !== 'ready' && CONTROL_ACTION_CHANNELS.includes(channel)) { held.push([channel, args]); void start(); return; }
    send(channel, ...args);
  };
  return { state: () => state, load: start };
}
