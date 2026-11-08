import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type WebContents } from 'electron';
import path from 'node:path';
import { PET_TOPMOST_LEVEL } from './pet-topmost';
import { getEmoji, type EmojiId } from '../shared/single-emoji';
import { layoutSingleEmoji, type EmojiRect } from './single-emoji-layout';
import type { SingleEmojiCue } from './single-emoji-cues';

// Static, textContent-only surface. Its isolated preload can receive catalog IDs
// but exposes no invoke/send, desktop API, file, window, image or provider access.
const HTML = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data:; script-src &#39;unsafe-inline&#39;; style-src &#39;unsafe-inline&#39;">'
 + '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none;user-select:none}body{display:grid;place-items:center}#glyph{font:48px/1.15 "Segoe UI Emoji",sans-serif}img{width:76px;height:76px;object-fit:contain}</style><span id="glyph"></span>'
 + '<script>var current=null;window.singleEmoji.onCue(function(v){current=v?v.token:null;var root=document.getElementById("glyph");root.replaceChildren();if(!v)return;var done=function(){if(current!==v.token)return;requestAnimationFrame(function(){requestAnimationFrame(function(){if(current===v.token)window.singleEmoji.presented(v.token);});});};if(v.png){var im=new Image();im.onload=function(){if(current!==v.token)return;root.replaceChildren(im);done();};im.onerror=function(){if(current===v.token)root.replaceChildren();};im.src=v.png;}else{root.textContent=v.glyph;done();}});</script>';
const URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(HTML) + '#soft-hearts-single-emoji';

export class SingleEmojiWindow {
  private window: BrowserWindow | null = null;
  private cue: SingleEmojiCue | null = null;
  private ready = false;
  private imagePending=false;
  private png:string|null=null;
  private disposed = false;
  private slot: string | undefined;
  private renderSerial = 0;
  private renderToken: string | null = null;
  private paintedToken: string | null = null;
  private sentCueId: string | null = null;
  private readonly presented = (event: IpcMainEvent, token: unknown) => {
    try { this.presentCurrent(event, token); } catch { this.clear(); }
  };
  private presentCurrent(event: IpcMainEvent, token: unknown): void {
    const win = this.window, cue = this.cue;
    if (!win || win.isDestroyed() || !this.ready || !this.valid(cue) || typeof token !== 'string'
      || !this.renderToken || token !== this.renderToken || this.sentCueId !== cue.id
      || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame
      || win.webContents.getURL() !== URL || event.senderFrame.url !== URL) return;
    const owner = this.owner.getBounds();
    const layout = layoutSingleEmoji(owner, screen.getDisplayMatching(owner).workArea, this.exclusions(), this.slot);
    if (!layout) { this.clear(); return; }
    const bounds = win.getBounds();
    if (Object.entries(layout.bounds).some(([key, value]) => bounds[key as keyof EmojiRect] !== value)) { this.sync(); return; }
    this.paintedToken = this.renderToken;
    win.showInactive();
  }
  private readonly move = () => this.sync();
  private readonly lost = () => this.clear();
  private readonly restored = () => {
    this.clear();
    const child = this.window;
    setImmediate(() => { if (child && this.window === child && !this.cue && !child.isDestroyed()) child.hide(); });
  };
  private readonly closed = () => this.dispose();
  // Kept from construction: during the owner's 'closed' event the owner is already
  // destroyed and reading owner.webContents throws "Object has been destroyed".
  private readonly ownerContents: WebContents;
  constructor(private readonly owner: BrowserWindow, private readonly exclusions: () => EmojiRect[],
    private readonly context: () => string, private readonly now = Date.now,private readonly imageFor?:(id:EmojiId)=>Promise<string|null>) {
    owner.on('move', this.move); owner.on('resize', this.move);
    owner.on('hide', this.lost); owner.on('minimize', this.lost);
    owner.on('restore', this.restored); owner.on('closed', this.closed);
    this.ownerContents = owner.webContents;
    this.ownerContents.on('did-start-loading', this.lost);
    this.ownerContents.on('render-process-gone', this.lost);
    screen.on('display-metrics-changed', this.move);
    screen.on('display-added', this.move); screen.on('display-removed', this.move);
    ipcMain.on('desk:single-emoji-presented', this.presented);
  }
  show(cue: SingleEmojiCue): boolean {
    try { return this.showCurrent(cue); } catch { this.clear(); return false; }
  }
  private showCurrent(cue: SingleEmojiCue): boolean {
    if (!this.valid(cue)) return false;
    const owner = this.owner.getBounds();
    const area = screen.getDisplayMatching(owner).workArea;
    const layout = layoutSingleEmoji(owner, area, this.exclusions());
    if (!layout) { this.clear(); return false; }
    this.cue = { ...cue }; this.slot = layout.slot;
    this.ensureWindow();
    if(this.imageFor){const current=this.cue;this.imagePending=true;this.png=null;try{this.window?.hide();}catch{}void this.imageFor(cue.catalogId).then(png=>{if(this.cue!==current||!this.valid(current))return;this.png=png;this.imagePending=false;this.sync();},()=>{if(this.cue===current){this.imagePending=false;this.sync();}});}else this.sync();
    return !!this.cue;
  }
  clear(): void {
    this.cue = null; this.slot = undefined;this.png=null;this.imagePending=false;
    this.renderToken = this.paintedToken = this.sentCueId = null;
    try { if (this.window && !this.window.isDestroyed() && this.window.isVisible()) this.window.hide(); } catch { /* Already retired. */ }
  }
  private valid(cue: SingleEmojiCue | null): cue is SingleEmojiCue {
    return !this.disposed && !!cue && !!getEmoji(cue.catalogId) && cue.context === this.context()
      && Number.isFinite(cue.expiresAt) && cue.expiresAt > this.now() && cue.expiresAt <= this.now() + 5_000
      && !this.owner.isDestroyed() && this.owner.isVisible() && !this.owner.isMinimized() && this.owner.getOpacity() > 0;
  }
  sync(): void {
    try { this.syncCurrent(); } catch { this.clear(); }
  }
  private syncCurrent(): void {
    const cue = this.cue;
    if (!cue) return; // No per-frame native work while this optional surface is idle.
    if (!this.valid(cue)) { this.clear(); return; }
    if(this.imagePending)return;
    const owner = this.owner.getBounds();
    const layout = layoutSingleEmoji(owner, screen.getDisplayMatching(owner).workArea, this.exclusions(), this.slot);
    if (!layout) { this.clear(); return; } // Permanently discard; no later auto-resume.
    const win = this.window;
    if (!win || win.isDestroyed() || !this.ready) return;
    if (win.webContents.getURL() !== URL || win.webContents.mainFrame.url !== URL) { this.clear(); return; }
    this.slot = layout.slot;
    const bounds = win.getBounds();
    const changed = Object.entries(layout.bounds).some(([key, value]) => bounds[key as keyof EmojiRect] !== value);
    // Only when it differs, with the owner's level: moving this owned window drags her (the owner) along, so an unconditional
    // call here raised her over the taskbar's popups on every emoji layout (electron/pet-topmost.ts, electron/pet-shell-hold.ts).
    if (win.isAlwaysOnTop() !== this.owner.isAlwaysOnTop()) win.setAlwaysOnTop(this.owner.isAlwaysOnTop(), PET_TOPMOST_LEVEL);
    if (!changed && this.sentCueId === cue.id) return;
    // Hide before a native geometry update. No transient paint at old overlapping bounds.
    if (win.isVisible()) win.hide();
    win.setBounds(layout.bounds);
    this.sentCueId = cue.id;
    this.renderToken = 'emoji-paint-' + ++this.renderSerial;
    this.paintedToken = null;
    win.webContents.send('desk:single-emoji-render', { catalogId: cue.catalogId, token: this.renderToken, png:this.png });
  }
  private ensureWindow(): void {
    if (this.window && !this.window.isDestroyed()) return;
    const win = this.window = new BrowserWindow({
      parent: this.owner, show: false, width: 80, height: 80,
      transparent: true, backgroundColor: '#00000000', frame: false,
      focusable: false, resizable: false, movable: false, hasShadow: false,
      skipTaskbar: true, title: 'soft hearts · 表情', paintWhenInitiallyHidden: true,
      webPreferences: { preload: path.join(__dirname, 'single-emoji-preload.cjs'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
        // Only two event-scoped rAF callbacks; no idle animation/timer. Hidden
        // reuse must paint the new glyph before show, rather than deadlock rAF.
        backgroundThrottling: false },
    });
    win.setIgnoreMouseEvents(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.on('show', () => { if (!this.valid(this.cue) || !this.paintedToken || this.paintedToken !== this.renderToken) win.hide(); });
    win.webContents.on('did-finish-load', () => {
      if (this.disposed || this.window !== win || win.webContents.getURL() !== URL) return;
      this.ready = true; this.sync();
    });
    const failed = () => { if (this.window === win) { this.ready = false; this.clear(); } };
    win.webContents.on('did-fail-load', failed); win.webContents.on('render-process-gone', failed);
    win.webContents.on('did-start-loading', () => { if (this.ready) failed(); });
    win.on('closed', () => { if (this.window === win) { this.window = null; this.ready = false; this.cue = null; } });
    void win.loadURL(URL).catch(failed);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.clear();
    this.owner.removeListener('move', this.move); this.owner.removeListener('resize', this.move);
    this.owner.removeListener('hide', this.lost); this.owner.removeListener('minimize', this.lost);
    this.owner.removeListener('restore', this.restored); this.owner.removeListener('closed', this.closed);
    // Plain listener removal; safe even when the owner and its contents are already destroyed.
    this.ownerContents.removeListener('did-start-loading', this.lost);
    this.ownerContents.removeListener('render-process-gone', this.lost);
    screen.removeListener('display-metrics-changed', this.move);
    screen.removeListener('display-added', this.move); screen.removeListener('display-removed', this.move);
    ipcMain.removeListener('desk:single-emoji-presented', this.presented);
    const win = this.window; this.window = null;
    if (win && !win.isDestroyed()) win.destroy();
  }
}
