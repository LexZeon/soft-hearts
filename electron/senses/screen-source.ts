/**
 * I-190: which screen or window "屏幕共享" reads (docs/claude/2026-11-22-i190-source-pickers.md). Before, every read of the shared screen
 * (the rough look, the clear look, small frames, closer looks, watch-together frames: electron/senses/screen-capture.ts) took the screen
 * her companion window is on; that stays the default ("跟着系统默认"). The user may pick another screen or one program's window from the
 * toolbar's ▾ or the Unbound input box's senses panel; the pick is an opaque desktopCapturer id ("screen:N:M" / "window:N:M").
 *
 * - Choosing never turns screen sharing on or off: this holds no switch and touches no media state (tests/i190-source-pickers.test.ts).
 * - Only an id listed in the last menu (two minutes) is accepted: a window cannot name a source it was not shown.
 * - Memory only: the choice is gone at the next start (window ids do not survive one anyway). Our own windows are never offered.
 * - A chosen window that closed (or a screen unplugged): back to the default, and the menus say so once. A chosen window that is only
 *   minimized gives no picture (never the whole screen instead: the user narrowed what she sees).
 */
import type { DesktopCapturerSource, SourcesOptions } from 'electron';
import { SOURCE_TEXT, parseScreenSourceId, screenSourceKind, type ScreenSourceEntry, type ScreenSourceMenuView, type ScreenSourceView } from '../../shared/senses';

export interface ScreenSourcePorts {
  capturer: { getSources(options: SourcesOptions): Promise<DesktopCapturerSource[]> };
  /** desktopCapturer ids of this app's own windows (BrowserWindow.getMediaSourceId), never offered. */
  ownWindows(): string[];
  /** The choice changed (by a pick or because the chosen source went away): the windows show it. */
  changed(view: ScreenSourceView): void;
  /** 2026-11-24 (续): the chosen window or screen went away and the read fell back to the default (一起看's facts, electron/senses/watch-continuity/). Told once per loss of a choice. */
  gone?(): void;
  now?(): number;
}
/** How long a listed menu stays good for a pick. */
export const SCREEN_MENU_TTL_MS = 120_000;
const MAX_ENTRIES = 40;

export class ScreenSourceChoice {
  private choice: string | null = null;
  private note: string | undefined;
  private listed: { at: number; ids: Set<string> } = { at: -Infinity, ids: new Set() };
  constructor(private readonly ports: ScreenSourcePorts) {}

  private now(): number { return this.ports.now?.() ?? Date.now(); }

  view(): ScreenSourceView { return { choice: this.choice, ...(this.note ? { note: this.note } : {}) }; }
  /** The chosen opaque id, or null: the screen her companion window is on. */
  get current(): string | null { return this.choice; }

  /** The screens and the other programs' windows, by opaque id; no thumbnails are made. */
  async menu(): Promise<ScreenSourceMenuView> {
    const sources = await this.ports.capturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    const own = new Set(this.safeOwn());
    const entries: ScreenSourceEntry[] = [];
    for (const source of sources) {
      const id = parseScreenSourceId(source.id);
      if (!id || own.has(id) || entries.length >= MAX_ENTRIES) continue;
      const kind = screenSourceKind(id);
      entries.push({ id, kind, label: kind === 'window' ? String(source.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) : '' });
    }
    this.listed = { at: this.now(), ids: new Set(entries.map(entry => entry.id)) };
    if (this.choice && !this.listed.ids.has(this.choice)) this.gone();
    return { ...this.view(), entries };
  }

  /** A pick from a menu: an id listed in the last two minutes, or null for the default. Never a switch. */
  choose(value: unknown): ScreenSourceView {
    if (value === null) return this.set(null);
    const id = parseScreenSourceId(value);
    if (!id) throw new Error('来源格式不正确。');
    if (!this.listed.ids.has(id) || this.now() - this.listed.at > SCREEN_MENU_TTL_MS) throw new Error('请重新点开列表再选。');
    return this.set(id);
  }

  /**
   * The source a read of the shared screen uses now: the chosen one while it exists; the companion's screen by default or when the chosen
   * one went away (then the choice resets). Null: nothing to read (no such screen, or a chosen window that gives no picture).
   */
  async source(companionDisplayId: string, thumbnailSize: { width: number; height: number }): Promise<DesktopCapturerSource | null> {
    const chosen = this.choice;
    const read = (types: Array<'screen' | 'window'>) => this.ports.capturer.getSources({ types, thumbnailSize, fetchWindowIcons: false });
    const screens = !chosen || screenSourceKind(chosen) === 'screen' ? await read(['screen']) : null;
    if (chosen) {
      const list = screens ?? await read(['window']);
      const hit = list.find(item => item.id === chosen);
      if (hit && this.choice === chosen) return hit;
      if (this.choice === chosen) this.gone();
    }
    return (screens ?? await read(['screen'])).find(item => item.display_id === companionDisplayId) ?? null;
  }

  private set(id: string | null): ScreenSourceView {
    const changed = id !== this.choice || this.note !== undefined;
    this.choice = id; this.note = undefined;
    if (changed) this.tell();
    return this.view();
  }
  private gone(): void { this.choice = null; this.note = SOURCE_TEXT.windowGoneNote; this.tell(); try { this.ports.gone?.(); } catch { /* the notice never changes the read */ } }
  private tell(): void { try { this.ports.changed(this.view()); } catch { /* a closing window */ } }
  private safeOwn(): string[] { try { return this.ports.ownWindows(); } catch { return []; } }
}
