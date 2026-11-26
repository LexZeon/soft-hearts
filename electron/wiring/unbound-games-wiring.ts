// Batch B (docs/claude/2026-11-21-unbound-full-BG.md): where her games (G1 猜拳, I-086 递东西, I-087 牵手) are shown now. While she is out
// in full-screen Unbound the companion window is held hidden, so the initiative wiring asks here instead of reading the companion window:
// her games go to the Unbound window (electron/unbound/games-bridge.ts) and count as shown only while she is shown there; at home
// everything is as before (the companion window, while it is visible). The rule itself is shared/unbound/games.ts playSurface (pure, tested).
// No module-level side effects: nothing here runs on import.
import type { BrowserWindow } from 'electron';
import { playSurface, type UnboundGameKind } from '../../shared/unbound/games';
import type { RpsUnreadWhy } from '../../shared/initiative';
import { GameLineRelay, readGameLine } from '../unbound';
import { unbound } from './unbound-wiring';

const shownAtHome = (win: BrowserWindow | null | undefined) => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();

/** Where her games are now, and whether that window shows her (read when called). */
export function herPlay(companion: BrowserWindow | null | undefined): { surface: 'unbound' | 'companion'; shown: boolean } {
  return playSurface({ held: !!unbound && unbound.state !== 'normal', outShown: unbound?.games.canPlay() === true, companionShown: shownAtHome(companion) });
}
/** The game hosts' "visible": her games can be seen and played now. */
export function playShown(companion: BrowserWindow | null | undefined): boolean { return herPlay(companion).shown; }
/**
 * Her game lines while she is out (electron/unbound/game-line.ts): into her bubble as a held line, then the companion window reads it (the stage
 * voice's guard: the line plays only while her bubble shows exactly it). The caller supplies what lives in other wiring files.
 */
export function createGameLines(deps: { companion(): BrowserWindow | null | undefined; chatBusy(): boolean; voiceOn(): boolean;
  begin(owner: number, id: string): void; guard(owner: number, id: string, canSpeak: (id: string) => boolean): void; skipped(id: string, why: RpsUnreadWhy): void; unread(why: RpsUnreadWhy): void }): GameLineRelay {
  return new GameLineRelay({ chatBusy: deps.chatBusy, voiceOn: deps.voiceOn, skipped: deps.skipped, unread: deps.unread,
    hold: (id, text) => unbound?.holdLine(id, text).held === true,
    read: (id, text) => readGameLine({ companion: () => { const win = deps.companion(); return win && !win.isDestroyed() ? { id: win.webContents.id, send: (channel, value) => win.webContents.send(channel, value) } : null; },
      proof: () => unbound?.readAloud ?? null, begin: deps.begin, guard: deps.guard }, id, text) });
}

/** One game event to where her games are now (`toCompanion`: the companion window's own send, as before); false when it could not be sent. */
export function sendPlay(companion: BrowserWindow | null | undefined, kind: UnboundGameKind, value: unknown, toCompanion: (win: BrowserWindow) => void): boolean {
  if (herPlay(companion).surface === 'unbound') return unbound?.games.send(kind, value) === true;
  if (!companion || companion.isDestroyed()) return false;
  toCompanion(companion);
  return true;
}
