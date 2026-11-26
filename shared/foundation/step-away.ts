/**
 * I-171 (docs/claude/2026-11-21-i171-minimize-keeps-her.md): a minimize (Win+D, the title bar's button) is a step away, not a hide.
 * She keeps what she is saying: the reply goes on and is archived once, the bubble's words are kept for the window's return,
 * and her chat process stays warm as if she were seen. Only hiding to the tray (the window hidden) ends the reply and clears the
 * bubble. Pure rules, so the host's steps and the page's guards say the same thing.
 */

/** The window facts these rules read (an Electron BrowserWindow has them). */
export interface AwayWindow { isDestroyed(): boolean; isVisible(): boolean; isMinimized(): boolean }

/** The window is minimized (a step away). Hidden to the tray or shown is not. */
export function minimizedAway(win: AwayWindow): boolean {
  try { return !win.isDestroyed() && win.isMinimized(); } catch { return false; }
}

/** Her companion window is gone from the screen and it was a hide, not a minimize: the reply she was finishing ends. */
export function hideEndsReply(win: AwayWindow): boolean {
  try { return (!win.isVisible() || win.isMinimized()) && !minimizedAway(win); } catch { return true; }
}

/** Her chat process counts her as seen: the window is shown, or only minimized (the 10-minute idle rule, not the hidden one). */
export function chatSeen(win: AwayWindow): boolean {
  try { return (win.isVisible() && !win.isMinimized()) || minimizedAway(win); } catch { return false; }
}

/**
 * I-174 item 2 (docs/claude/2026-11-21-i174-parity-fixes.md): one "is she here" for both pages and the host. A surface she is on is
 *  - 'shown': on screen;
 *  - 'covered': only for a while out of sight: minimized (I-171). (A full-screen program no longer hides her at all, I-199.) Another
 *    window on top, the Win+Shift+S snip overlay or Chromium marking the page
 *    hidden because it is covered never reach the host's facts at all: the host still says shown;
 *  - 'gone': hidden to the tray, closed, or out of Unbound.
 * Her speech, her reading and her beats go on while she is covered, and her warm Claude process keeps the seen idle rule; only 'gone' ends
 * them. What senses her (microphone, camera) is decided elsewhere and still stops on a minimize (privacy).
 */
export type HerPresence = 'shown' | 'covered' | 'gone';
export interface PresenceFacts {
  /** The surface exists (the window is not destroyed; for Unbound: she is out and her window is there). */
  exists: boolean;
  /** The host shows it (BrowserWindow.isVisible, or the page's host-told visibility). */
  visible: boolean;
  minimized: boolean;
}
export function herPresence(f: PresenceFacts): HerPresence {
  if (!f.exists) return 'gone';
  if (f.visible && !f.minimized) return 'shown';
  return f.minimized ? 'covered' : 'gone';
}
/** She is here: shown or only covered for a while. */
export function herHere(f: PresenceFacts): boolean { return herPresence(f) !== 'gone'; }
/** A window's facts (an Electron BrowserWindow has them); a throwing reader reads as gone. */
export function windowPresenceFacts(win: Pick<AwayWindow, 'isDestroyed' | 'isVisible'> & Partial<Pick<AwayWindow, 'isMinimized'>> | null | undefined): PresenceFacts {
  try { return win && !win.isDestroyed() ? { exists: true, visible: win.isVisible(), minimized: win.isMinimized?.() === true } : { exists: false, visible: false, minimized: false }; }
  catch { return { exists: false, visible: false, minimized: false }; }
}

/**
 * The page: the reply may go on (be shown, be read): her window is here (herHere: shown, or only minimized). I-174 item 2: the document
 * alone being hidden (another window or the snip overlay covering her, which Chromium reports as hidden) no longer stops it; the host's
 * word decides. `documentHidden` is kept for the callers' shape and not read.
 */
export function replyMayRun(hostVisible: boolean, _documentHidden: boolean, minimized: boolean): boolean {
  return herHere({ exists: true, visible: hostVisible, minimized });
}

/**
 * The screen look's identity inputs (the window she looks from, the display): a change ends the look's context and, in the page, the
 * reply made from it. A minimize keeps them (still "seen", the same display as last seen) so it does not end the turn; the look itself
 * still stops (the screen snapshots take visible: false). A hide to the tray changes them as before. The one identity string is
 * visionContextKey (electron/senses/vision-context.ts), which takes these two values; there is no second key.
 */
export interface AwayVisionInput { visible: boolean; window: AwayWindow | null; displayId: number | null; lastDisplayId: number | null }
export function awayAwareVision(i: AwayVisionInput): { visible: boolean; displayId: number | null } {
  const away = !i.visible && !!i.window && minimizedAway(i.window);
  return { visible: i.visible || away, displayId: i.visible ? i.displayId : away ? i.lastDisplayId : null };
}

/** The same, remembering the display she was last seen on (kept through a minimize). One per host. */
export function createAwayVision(): (i: Omit<AwayVisionInput, 'lastDisplayId'>) => { visible: boolean; displayId: number | null } {
  let last: number | null = null;
  return (i) => { const r = awayAwareVision({ ...i, lastDisplayId: last }); if (i.visible) last = r.displayId; return r; };
}

/**
 * I-171: a window that left the screen used to end the look's context at once, and the page stops the reply made from it (the turn was
 * marked stopped). Not now: a minimized companion window, or a control window that hid while she is on screen (herOnScreen), keeps it.
 * A destroyed window, a hidden companion window, or a control window hiding with her nowhere on screen end it as before.
 */
export function leaveClearsVision(win: AwayWindow, owner: string, herOnScreen: boolean): boolean {
  if (win.isDestroyed()) return true;
  return owner === 'controls' ? !herOnScreen : !minimizedAway(win);
}

/**
 * I-171 (closing the control window cut her off): a closed control window does not stop a chat reply while she is
 * on screen (her window shown, or out in full-screen): the reply keeps streaming into her bubble and is archived once. A reply whose only
 * surface is gone (she is not on screen at all) is aborted as before; so are authoring runs and the companion window's own tasks.
 */
export function abortsWithClosedWindow(task: { kind: string; source?: string }, closing: { owner: string }, herOnScreen: boolean): boolean {
  const keeps = task.kind === 'chat' && task.source !== 'language-authoring' && task.source !== 'visual-authoring' && closing.owner === 'controls' && herOnScreen;
  return !keeps;
}
