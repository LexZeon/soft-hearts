import type { PetPresentationSample, PetWindowDiagnosticEntry, PetWindowDiagnosticsView } from '../shared/contracts';
import { PET_SIZE, type Bounds } from './pet-view';
import { PET_TOPMOST_LEVEL, type TopmostLevel } from './pet-topmost';

/** The BrowserWindow surface this module needs; structural so tests need no Electron. */
export interface PetWindowLike {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isMaximized(): boolean;
  isAlwaysOnTop(): boolean;
  getOpacity(): number;
  setOpacity(value: number): void;
  getBounds(): Bounds;
  restore(): void;
  setBounds(bounds: Bounds): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
  setAlwaysOnTop(flag: boolean, level?: TopmostLevel): void;
  show(): void;
  showInactive(): void;
  moveTop(): void;
}
export interface PetScreenLike {
  getAllDisplays(): { workArea: Bounds }[];
  getDisplayMatching(rect: Bounds): { workArea: Bounds };
}
export type PetPresentationReason = 'startup' | 'restore' | 'show';
export type PetPresentationProblem = 'minimized' | 'hidden' | 'zero-size' | 'off-screen' | 'not-on-top';
export interface PetPresentationPorts {
  window(): PetWindowLike | null;
  screen(): PetScreenLike;
  /** Persisted host intent. Every deliberate hide path saves `visible: false` before hiding. */
  intent(): { visible: boolean; alwaysOnTop: boolean } | null;
  /** A user drag/resize owns the geometry right now. */
  busy(): boolean;
  /** Developer mode or an explicit launch switch; diagnostics are off otherwise. */
  diagnostics(): boolean;
  giveUp?(reason: PetPresentationReason): void;
  schedule?(fn: () => void, ms: number): () => void;
  now?(): number;
  echo?(line: string): void;
}

/** Offsets (ms after the request) at which the native pet window is re-checked. */
export const PET_SETTLE_CHECKS_MS: readonly number[] = [150, 500, 1200, 2500, 4000];
const MAX_REPAIRS = 3;

/**
 * Explicit recovery as one ordered native sequence. It calls setOpacity only when
 * something lowered the opacity below 1: on Windows Electron implements setOpacity
 * by adding WS_EX_LAYERED plus SetLayeredWindowAttributes(LWA_ALPHA) for the rest
 * of the process (even for 1), while the transparent pet is a DirectComposition
 * window that Chromium keeps non-layered. An unconditional setOpacity(1) therefore
 * has a native side effect; a lowered opacity is still restored (the recovery
 * contract kept by scripts/pet-recovery-smoke.mjs).
 */
export function presentRecoveredPet(win: PetWindowLike, bounds: Bounds): void {
  // restore() on a merely hidden HWND shows it without an Electron show event.
  if (win.isMinimized() || win.isMaximized()) win.restore();
  win.setBounds(bounds);
  win.setIgnoreMouseEvents(false);
  win.setAlwaysOnTop(true, PET_TOPMOST_LEVEL);
  if (win.getOpacity() < 1) win.setOpacity(1);
  win.show();
  win.moveTop();
}

export function onAnyDisplay(bounds: Bounds, areas: readonly Bounds[]): boolean {
  if (!(bounds.width > 0 && bounds.height > 0)) return false;
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  return areas.some(area => x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height);
}

interface Sample { visible: boolean; minimized: boolean; alwaysOnTop: boolean; opacity: number; bounds: Bounds; onScreen: boolean }
function sampleWindow(win: PetWindowLike, areas: readonly Bounds[]): Sample {
  const bounds = win.getBounds();
  return { visible: win.isVisible(), minimized: win.isMinimized(), alwaysOnTop: win.isAlwaysOnTop(),
    opacity: win.getOpacity(), bounds, onScreen: onAnyDisplay(bounds, areas) };
}
export function petPresentationProblems(sample: Sample, wantOnTop: boolean): PetPresentationProblem[] {
  const problems: PetPresentationProblem[] = [];
  if (sample.minimized) problems.push('minimized');
  else if (!sample.visible) problems.push('hidden');
  if (!(sample.bounds.width > 0 && sample.bounds.height > 0)) problems.push('zero-size');
  else if (!sample.onScreen) problems.push('off-screen');
  if (wantOnTop && !sample.alwaysOnTop) problems.push('not-on-top');
  return problems;
}
function flat(sample: Sample): Record<string, unknown> {
  const { bounds } = sample;
  return { visible: sample.visible, minimized: sample.minimized, top: sample.alwaysOnTop, opacity: sample.opacity,
    x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height, onScreen: sample.onScreen };
}

/** Bounded in-memory log of pet window facts. Off unless developer mode or the launch switch is on. */
export class PetWindowDiagnostics {
  private readonly items: PetWindowDiagnosticEntry[] = [];
  constructor(private readonly enabled: () => boolean, private readonly now: () => number = defaultNow,
    private readonly limit = 80, private readonly echo?: (line: string) => void) {}
  private on(): boolean { try { return this.enabled() === true; } catch { return false; } }
  record(event: string, detail: Record<string, unknown> = {}): void {
    if (!this.on()) return;
    const clean: PetWindowDiagnosticEntry['detail'] = {};
    for (const [key, value] of Object.entries(detail).slice(0, 24)) {
      if (typeof value === 'string') clean[key] = value.slice(0, 80);
      else if (typeof value === 'number') clean[key] = Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
      else if (typeof value === 'boolean' || value === null) clean[key] = value;
    }
    const entry: PetWindowDiagnosticEntry = { t: Math.round(this.now()), event: String(event).slice(0, 40), detail: clean };
    this.items.push(entry);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    try { this.echo?.(`[pet-window] ${JSON.stringify(entry)}`); } catch { /* Logging never affects presentation. */ }
  }
  view(): PetWindowDiagnosticsView {
    const enabled = this.on();
    return { enabled, entries: enabled ? this.items.map(item => ({ ...item, detail: { ...item.detail } })) : [] };
  }
}

/**
 * Keeps an explicitly requested pet presentation (startup, show, restore) true for a
 * short settle window. A native hide, minimize or move off every display that no
 * saved intent asked for is repaired a bounded number of times; a saved hide, a user
 * drag or a newer request always wins.
 */
export class PetPresentation {
  private readonly log: PetWindowDiagnostics;
  private generation = 0;
  private cancel: (() => void) | null = null;
  constructor(private readonly ports: PetPresentationPorts) {
    this.log = new PetWindowDiagnostics(() => ports.diagnostics(), ports.now ?? defaultNow, 80, ports.echo);
  }
  recover(win: PetWindowLike, bounds: Bounds): void {
    this.note('restore-request', win);
    presentRecoveredPet(win, bounds);
    this.note('restore-presented', win);
    this.arm('restore', bounds);
  }
  arm(reason: PetPresentationReason, target?: Bounds): void {
    this.disarm();
    const generation = this.generation, offsets = [...PET_SETTLE_CHECKS_MS];
    const goal = target ? { ...target } : undefined;
    let index = 0, repairs = 0;
    const schedule = this.ports.schedule ?? defaultSchedule;
    const next = (repaired: boolean) => {
      index++;
      // A repair at the last checkpoint gets one more look instead of being assumed.
      if (index >= offsets.length) {
        if (!repaired) { this.log.record('settled', { reason }); this.cancel = null; return; }
        offsets.push(offsets[offsets.length - 1] + 600);
      }
      this.cancel = schedule(check, offsets[index] - offsets[index - 1]);
    };
    const check = () => {
      if (generation !== this.generation) return;
      // Runs from a main-process timer: a throwing native call must end the watch, never the app.
      try { inspect(); } catch (error) { this.log.record('check-failed', { reason, error: error instanceof Error ? error.message : String(error) }); }
    };
    const inspect = () => {
      const win = this.ports.window();
      if (!win || win.isDestroyed()) { this.log.record('stop', { reason, cause: 'destroyed' }); return; }
      const intent = this.ports.intent();
      if (!intent?.visible) { this.log.record('stop', { reason, cause: 'saved-hidden' }); return; }
      if (this.ports.busy()) { this.log.record('check', { reason, skipped: 'busy' }); next(false); return; }
      const before = this.sample(win), problems = petPresentationProblems(before, intent.alwaysOnTop);
      if (!problems.length) { this.log.record('check', { reason, ...flat(before) }); next(false); return; }
      if (repairs >= MAX_REPAIRS) {
        this.log.record('gave-up', { reason, problems: problems.join(','), ...flat(before) });
        this.cancel = null;
        try { this.ports.giveUp?.(reason); } catch { /* A fallback must not throw into a timer. */ }
        return;
      }
      repairs++;
      try { this.repair(win, problems, reason, goal); }
      catch (error) { this.log.record('repair-failed', { reason, error: error instanceof Error ? error.message : String(error) }); }
      this.log.record('repair', { reason, problems: problems.join(','), ...flat(this.sample(win)) });
      next(true);
    };
    this.log.record('arm', { reason });
    this.cancel = schedule(check, offsets[0]);
  }
  disarm(): void { this.generation++; this.cancel?.(); this.cancel = null; }
  dispose(): void { this.disarm(); }
  note(event: string, win: PetWindowLike | null = this.ports.window()): void {
    if (!win || win.isDestroyed()) { this.log.record(event, { destroyed: true }); return; }
    let intent: ReturnType<PetPresentationPorts['intent']> = null;
    try { intent = this.ports.intent(); } catch { /* Settings not loaded yet. */ }
    try { this.log.record(event, { ...flat(this.sample(win)), wanted: intent?.visible ?? null }); }
    catch { this.log.record(event, { sample: 'unavailable' }); }
  }
  noteRenderer(value: unknown): void {
    const sample = readPetPresentationSample(value);
    this.log.record('renderer', { ...sample });
  }
  view(): PetWindowDiagnosticsView { return this.log.view(); }
  private areas(): Bounds[] {
    try { return this.ports.screen().getAllDisplays().map(display => display.workArea); } catch { return []; }
  }
  private sample(win: PetWindowLike): Sample { return sampleWindow(win, this.areas()); }
  private repair(win: PetWindowLike, problems: PetPresentationProblem[], reason: PetPresentationReason, target?: Bounds): void {
    if (problems.includes('minimized')) win.restore();
    if (problems.includes('zero-size') || problems.includes('off-screen')) win.setBounds(this.placement(win, target));
    if (problems.includes('not-on-top')) win.setAlwaysOnTop(true, PET_TOPMOST_LEVEL);
    if (problems.includes('minimized') || problems.includes('hidden')) {
      // Only an explicit one-click recovery raises and activates the pet, as recovery itself does.
      if (reason === 'restore') win.show(); else win.showInactive();
    }
    if (reason === 'restore') win.moveTop();
  }
  private placement(win: PetWindowLike, target?: Bounds): Bounds {
    if (target && onAnyDisplay(target, this.areas())) return { ...target };
    const current = win.getBounds(), area = this.ports.screen().getDisplayMatching(current).workArea;
    const width = Math.max(1, Math.min(current.width > 0 ? current.width : PET_SIZE.width, area.width));
    const height = Math.max(1, Math.min(current.height > 0 ? current.height : PET_SIZE.height, area.height));
    return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height };
  }
}

const SAMPLE_KEYS = ['reason', 'visibility', 'hostVisible', 'canvasWidth', 'canvasHeight', 'clientWidth', 'clientHeight',
  'devicePixelRatio', 'contextLost', 'frameAdvanced'] as const;
/** The pet renderer's own view of whether it can draw; diagnostic only, never authority. */
export function readPetPresentationSample(value: unknown): PetPresentationSample {
  const fail = (): never => { throw new Error('桌宠呈现报告格式不正确。'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>, keys = Object.keys(v);
  if (keys.length !== SAMPLE_KEYS.length || keys.some(key => !(SAMPLE_KEYS as readonly string[]).includes(key))) fail();
  if (v.reason !== 'startup' && v.reason !== 'restore') fail();
  if (!['visible', 'hidden', 'prerender', 'unknown'].includes(v.visibility as string)) fail();
  if (typeof v.hostVisible !== 'boolean' || typeof v.frameAdvanced !== 'boolean') fail();
  if (v.contextLost !== null && typeof v.contextLost !== 'boolean') fail();
  for (const key of ['canvasWidth', 'canvasHeight', 'clientWidth', 'clientHeight'] as const) {
    const n = v[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100_000) fail();
  }
  const ratio = v.devicePixelRatio;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio > 16) fail();
  return {
    reason: v.reason as PetPresentationSample['reason'], visibility: v.visibility as PetPresentationSample['visibility'],
    hostVisible: v.hostVisible as boolean, canvasWidth: v.canvasWidth as number, canvasHeight: v.canvasHeight as number,
    clientWidth: v.clientWidth as number, clientHeight: v.clientHeight as number, devicePixelRatio: ratio as number,
    contextLost: v.contextLost as boolean | null, frameAdvanced: v.frameAdvanced as boolean,
  };
}

function defaultNow(): number { return typeof process !== 'undefined' ? process.uptime() * 1000 : Date.now(); }
function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}
