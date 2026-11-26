/**
 * I-190: the companion toolbar's source pickers (docs/claude/2026-11-22-i190-source-pickers.md). The microphone and the screen buttons get a
 * small ▾ beside them that opens a menu of sources; the camera's panel and the listening panel get the same list as a section (their buttons
 * already open a panel). The lists come from one place (src/senses/source-choices.ts) and are drawn by one builder (src/foundation/source-menu.ts),
 * the same the Unbound input box uses. A pick never turns a sense on or off; the buttons beside stay the switches.
 */
import { SourcePopup, renderSourceList, type SourceListModel } from '../foundation/source-menu';

export type ToolbarSourceKind = 'microphone' | 'camera' | 'screen' | 'systemAudio';
export interface ToolbarSourcePorts {
  menu(kind: ToolbarSourceKind): Promise<SourceListModel>;
  choose(kind: ToolbarSourceKind, id: string): Promise<void>;
  onChange(callback: () => void): () => void;
}
/** The ▾ buttons in the toolbar's markup (src/stage/PetUI.ts renderPet) and the menu each opens. */ // no-pet-ok: the existing file name
// no-pet-ok: the next line holds the existing toolbar's element ids
export const SOURCE_CARETS: Readonly<Record<string, ToolbarSourceKind>> = Object.freeze({ 'pet-voice-input-sources': 'microphone', 'pet-screen-sharing-sources': 'screen' });

export class ToolbarSources {
  private ports: ToolbarSourcePorts | null = null;
  private readonly popup: SourcePopup;
  private openKind: ToolbarSourceKind | null = null;
  private cameraHost: HTMLElement | null = null;
  private stopWatching: (() => void) | null = null;
  private asking = 0;
  private disposed = false;

  constructor(private readonly doc: Document, private readonly hooks: { held(open: boolean): void; error(message: string): void }) {
    this.popup = new SourcePopup(doc, open => { if (!open) this.openKind = null; hooks.held(open); });
    for (const [id, kind] of Object.entries(SOURCE_CARETS)) {
      const button = doc.getElementById(id) as HTMLButtonElement | null;
      if (!button) continue;
      button.disabled = true; // until the window gives the lists (setPorts)
      button.onclick = () => { void this.toggle(kind, button); };
    }
  }

  /** The lists arrived (src/wiring/sources-wiring.ts): the ▾ buttons work; a change anywhere redraws what is open. */
  setPorts(ports: ToolbarSourcePorts): void {
    if (this.disposed) return;
    this.stopWatching?.();
    this.ports = ports;
    this.stopWatching = ports.onChange(() => { void this.refresh(); });
    for (const id of Object.keys(SOURCE_CARETS)) { const button = this.doc.getElementById(id) as HTMLButtonElement | null; if (button) button.disabled = false; }
    void this.refresh();
  }

  get isOpen(): boolean { return this.popup.isOpen; }
  close(): void { this.popup.close(false); }

  /** The camera panel's section (src/senses/CameraSharingPanel.ts calls this once when it builds). */
  mountCamera(host: HTMLElement): void { this.cameraHost = host; void this.drawCamera(); }

  dispose(): void { this.disposed = true; this.stopWatching?.(); this.stopWatching = null; this.popup.close(false); }

  private async toggle(kind: ToolbarSourceKind, button: HTMLElement): Promise<void> {
    if (this.popup.openFor === button) { this.popup.close(true); return; }
    const ports = this.ports, ask = ++this.asking;
    if (!ports) return;
    let model: SourceListModel;
    try { model = await ports.menu(kind); } catch (error) { this.hooks.error(String(error)); return; }
    if (ask !== this.asking || this.disposed) return; // a newer click won
    this.openKind = kind;
    this.popup.open(button, model, id => { void this.pick(kind, id); });
  }

  private async pick(kind: ToolbarSourceKind, id: string): Promise<void> {
    try { await this.ports?.choose(kind, id); } catch (error) { this.hooks.error(String(error)); }
  }

  private async refresh(): Promise<void> {
    const ports = this.ports, kind = this.openKind;
    if (ports && kind && this.popup.isOpen) {
      try { const model = await ports.menu(kind); if (this.openKind === kind) this.popup.refresh(model, id => { void this.pick(kind, id); }); } catch { /* the open list stays */ }
    }
    await this.drawCamera();
  }

  private async drawCamera(): Promise<void> {
    const host = this.cameraHost, ports = this.ports;
    if (!host || !ports) return;
    try { host.replaceChildren(renderSourceList(this.doc, await ports.menu('camera'), id => { void this.pick('camera', id); })); } catch { /* the panel works without the list */ }
  }
}
