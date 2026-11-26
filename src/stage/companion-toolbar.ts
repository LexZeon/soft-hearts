/** no-pet-ok: the next lines name the existing file src/stage/PetUI.ts and its class
 * The companion window's toolbar, moved out of src/stage/PetUI.ts. PetUI keeps // no-pet-ok: the existing class name the chat, the reply and the
 * window handles; this owns how the toolbar shows (hover, keyboard, fold), its tooltip, and what every button says.
 *
 * One state, one render: every setter changes `state` and `render()` writes every button's pressed state, busy mark and tooltip from it, so
 * a button can never keep an old look because one path forgot to update it. A switch clicked here is marked busy until the host answers
 * (voice input can take seconds to start), so a click is never met with nothing.
 */
import { uiText, uiTemplate } from '../foundation/ui-language';
import type { RuntimeState } from '../../shared/foundation/runtime-state';
import { HOVER_REVEAL_MARGIN, HoverVisibility, nearHoverZone } from './HoverVisibility';
import { cameraWords } from '../senses';
import { ToolbarSources, type ToolbarSourcePorts } from './toolbar-sources';

// no-pet-ok: the existing file and function names
/** The toolbar's element ids in the companion markup (src/stage/PetUI.ts renderPet); the old names stay, the code calls it the companion toolbar. */
const IDS = Object.freeze({
  toolbar: 'pet-toolbar', // no-pet-ok: an existing element id
  toggle: 'pet-toolbar-toggle', // no-pet-ok: an existing element id
  tooltip: 'pet-tooltip', // no-pet-ok: an existing element id
  indicator: 'pet-media-indicator', // no-pet-ok: an existing element id
  voice: 'pet-voice-input', // no-pet-ok: an existing element id
  screen: 'pet-screen-sharing', // no-pet-ok: an existing element id
  camera: 'pet-camera-sharing', // no-pet-ok: an existing element id
  listen: 'pet-system-audio-sharing', // no-pet-ok: an existing element id
  pin: 'pet-always-on-top', // no-pet-ok: an existing element id
  size: 'pet-size-toggle', // no-pet-ok: an existing element id
  edit: 'pet-camera-edit', // no-pet-ok: an existing element id
  developer: 'pet-developer-mode', // no-pet-ok: an existing element id
});
const BUTTONS = '#pet-toolbar > button, .pet-resize-handle'; // no-pet-ok: existing element ids
const SHARING_OPTIONS = ':scope > .pet-sharing-options'; // no-pet-ok: an existing class name
export type ToolbarSwitch = 'voiceInput' | 'screenSharing';
interface ToolbarState {
  runtime: RuntimeState | null;
  systemAudio: { active: boolean; status: string };
  dance: { active: boolean; status: string };
  pin: { on: boolean; pending: boolean; available: boolean };
  adjusting: boolean;
  editing: boolean;
  developer: boolean;
  busy: Set<ToolbarSwitch>;
}
export interface CompanionToolbarPorts {
  /** Folding: the popups the toolbar opened close, a drag ends (the companion UI's old setToolbarCollapsed did this). */
  beforeFold(): void;
  error(message: string): void;
}
const SWITCHES: ReadonlyArray<readonly [string, ToolbarSwitch, string]> = [[IDS.voice, 'voiceInput', '语音输入'], [IDS.screen, 'screenSharing', '屏幕共享']];

export class CompanionToolbar {
  readonly element: HTMLElement;
  readonly visibility: HoverVisibility;
  readonly sources: ToolbarSources;
  private near = false;
  private collapsed = false;
  private readonly state: ToolbarState = {
    runtime: null, systemAudio: { active: false, status: '' }, dance: { active: false, status: '' },
    pin: { on: false, pending: false, available: false }, adjusting: false, editing: false, developer: false, busy: new Set(),
  };
  private readonly focusIn = (event: FocusEvent) => this.visibility.focus((event.target as HTMLElement).matches(':focus-visible'));
  private readonly focusOut = (event: FocusEvent) => {
    const target = event.relatedTarget as HTMLElement | null;
    this.visibility.focus(Boolean(target && (this.element.contains(target) || this.sources.isOpen) && target.matches(':focus-visible')));
  };

  constructor(private readonly ports: CompanionToolbarPorts) {
    this.element = document.getElementById(IDS.toolbar)!;
    this.visibility = new HoverVisibility(visible => {
      this.element.classList.toggle('is-visible', visible);
      if (!visible) { this.hideTooltip(); this.sources?.close(); }
    });
    this.sources = new ToolbarSources(document, { held: open => this.visibility.hold(open || this.state.adjusting), error: message => ports.error(message) });
    this.element.addEventListener('focusin', this.focusIn);
    this.element.addEventListener('focusout', this.focusOut);
    for (const button of document.querySelectorAll<HTMLButtonElement>(BUTTONS)) {
      button.dataset.tooltip = button.title;
      button.removeAttribute('title');
      button.addEventListener('pointerenter', () => this.showTooltip(button));
      button.addEventListener('pointerleave', () => this.hideTooltip());
      // Keyboard focus only: a mouse click focuses the button too, and that used to bring the tooltip straight back after the press hid it.
      button.addEventListener('focus', () => { if (button.matches(':focus-visible')) this.showTooltip(button); });
      button.addEventListener('blur', () => this.hideTooltip());
      button.addEventListener('pointerdown', () => this.hideTooltip());
    }
    document.getElementById(IDS.toggle)!.onclick = () => this.setCollapsed(!this.collapsed);
    this.setCollapsed(false);
  }

  setSources(ports: ToolbarSourcePorts): void { this.sources.setPorts(ports); }

  /** The pointer moved (the companion UI's one listener for the toolbar and the chat box). */
  pointer(x: number, y: number, inside: boolean): void {
    this.near = inside && nearHoverZone(this.element.getBoundingClientRect(), x, y, this.near);
    if (this.near) this.visibility.enter(); else this.visibility.leave();
  }
  leave(): void { this.near = false; this.visibility.leave(); this.visibility.contact(false); }
  reset(): void { this.near = false; this.visibility.reset(); this.hideTooltip(); this.sources.close(); }

  /** A switch clicked here: busy until `done` settles or the host's state for it changes. */
  track(feature: ToolbarSwitch, done: unknown): void {
    this.state.busy.add(feature); this.render();
    void Promise.resolve(done).catch(() => {}).finally(() => { if (this.state.busy.delete(feature)) this.render(); });
  }

  applyRuntime(next: RuntimeState): void {
    const before = this.state.runtime;
    for (const feature of [...this.state.busy]) if (before && before[feature] !== next[feature]) this.state.busy.delete(feature);
    this.state.runtime = { ...next };
    this.render();
  }
  setSystemAudio(active: boolean, status?: string): void {
    this.state.systemAudio = { active, status: status !== undefined ? status : active ? this.state.systemAudio.status : '' };
    this.render();
  }
  setDance(active: boolean, status: string): void { this.state.dance = { active, status }; this.render(); }
  setPin(on: boolean, available: boolean): void { this.state.pin = { ...this.state.pin, on, available }; this.render(); }
  setPinPending(pending: boolean): void { this.state.pin = { ...this.state.pin, pending }; this.render(); }
  setAdjusting(on: boolean): void { this.state.adjusting = on; this.visibility.hold(on || this.sources.isOpen); this.render(); }
  setEditing(on: boolean): void { this.state.editing = on; this.render(); }
  setDeveloper(on: boolean): void { this.state.developer = on; this.render(); }
  setSystemAudioExpanded(expanded: boolean): void { document.getElementById(IDS.listen)!.setAttribute('aria-expanded', String(expanded)); }

  /** Writes every button from the one state (the only place that sets their pressed look and words). */
  render(): void {
    const s = this.state, runtime = s.runtime;
    const set = (id: string, pressed: boolean | null, tooltip: string, busy = false) => {
      const button = document.getElementById(id);
      if (!button) return;
      if (pressed !== null) button.setAttribute('aria-pressed', String(pressed));
      if (busy) { button.setAttribute('aria-busy', 'true'); button.dataset.pending = 'true'; } else { button.removeAttribute('aria-busy'); delete button.dataset.pending; }
      button.dataset.tooltip = tooltip;
      if (button.matches(':hover, :focus-visible')) this.showTooltip(button);
    };
    for (const [id, feature, title] of SWITCHES) {
      const on = runtime?.[feature] === true, busy = s.busy.has(feature);
      const words = busy ? uiText(on ? '正在关掉…' : '正在打开…')
        : feature === 'voiceInput' ? (on ? uiText('已开启，按住 T 说话；点击关闭') : uiText('已关闭，点击开启（开启后按住 T 说话）')) // hold T to talk (2026-11-07)
        : on ? uiText('已开启，点击关闭') : uiText('已关闭，点击开启');
      set(id, on, `${uiText(title)}：${words}`, busy);
    }
    if (runtime) set(IDS.camera, runtime.cameraSharing, `${uiText('摄像头共享')}：${cameraWords(runtime)}`);
    const listening = s.systemAudio.active || s.dance.active;
    set(IDS.listen, listening, listening ? uiText('和她一起听：开着，点击可以关掉')
      : s.systemAudio.status || s.dance.status ? uiText('和她一起听：正在连接') : uiText('和她一起听：点击打开'));
    const pin = document.getElementById(IDS.pin) as HTMLButtonElement | null;
    if (pin) pin.disabled = s.pin.pending || !s.pin.available;
    set(IDS.pin, s.pin.on, uiTemplate`始终置顶：${s.pin.on ? uiText('已开启，点击关闭') : uiText('已关闭，点击开启')}`);
    set(IDS.size, s.adjusting, s.adjusting ? uiText('完成窗口调整（Esc）') : uiText('进入窗口调整模式'));
    set(IDS.edit, s.editing, s.editing ? uiText('完成镜头调整（Esc）') : uiText('进入镜头调整模式'));
    set(IDS.developer, s.developer, uiTemplate`开发者模式：${s.developer ? uiText('已开启，点击关闭') : uiText('已关闭，点击开启')}`);
    this.renderIndicator();
  }

  private renderIndicator(): void {
    const s = this.state, runtime = s.runtime;
    const active = runtime ? [runtime.voiceInput ? uiText('语音输入') : '', runtime.screenSharing ? uiText('屏幕共享') : '', runtime.cameraSharing ? uiText('摄像头共享') : ''].filter(Boolean) : [];
    if (s.systemAudio.active || s.systemAudio.status) active.push(s.systemAudio.status || uiText('系统声音采集 · 当前已选用途'));
    if (s.dance.status) active.push(s.dance.status);
    const indicator = document.getElementById(IDS.indicator)!;
    indicator.textContent = active.join(' · '); indicator.classList.toggle('hidden', !active.length);
  }

  /**
   * Manual display preference for this window lifetime only; media and edit state stay separate. I-028: folding also closes every popup
   * the toolbar opened (the interface only: what they control goes on); unfolding opens none of them again.
   */
  setCollapsed(collapsed: boolean): void {
    if (collapsed) { this.ports.beforeFold(); this.sources.close(); }
    this.collapsed = collapsed;
    this.near = false;
    this.element.classList.toggle('is-collapsed', collapsed);
    const button = document.getElementById(IDS.toggle)!;
    const label = collapsed ? uiText('展开工具栏') : uiText('收起工具栏');
    button.textContent = collapsed ? '<' : '>';
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', label);
    button.dataset.tooltip = label;
    this.hideTooltip();
  }
  get isCollapsed(): boolean { return this.collapsed; }

  /**
   * P4: the lowest viewport y (CSS px) where the expanded toolbar reacts to the pointer: its layout bottom plus the margin at which it
   * reveals itself. Framing keeps the model below this, so reaching for her crown neither hits nor summons the toolbar.
   */
  reach(): number { const bottom = this.expandedBottom(); return bottom > 0 ? bottom + HOVER_REVEAL_MARGIN : 0; }
  /**
   * Bottom of the expanded toolbar's button rows in viewport CSS px, also while it is folded or faded. Unfolding only for the measurement
   * happens inside one task, so it is never painted; the fade's translate is not part of offsetTop. The screen-sharing options that open
   * inside the toolbar while sharing is on are left out (2026-11-22: a 重新取景 while sharing used to push her far down for a panel that
   * fades with the toolbar).
   */
  expandedBottom(): number {
    const folded = this.element.classList.contains('is-collapsed');
    const options = this.element.querySelector?.<HTMLElement>(SHARING_OPTIONS) ?? null;
    const optionsDisplay = options?.style.display;
    if (folded) this.element.classList.remove('is-collapsed');
    if (options) options.style.display = 'none';
    try {
      // offsetTop is relative to the document when the offset parent is <body> (the companion window does not scroll).
      const parent = this.element.offsetParent as HTMLElement | null;
      const origin = !parent || parent === document.body ? 0 : parent.getBoundingClientRect().top + parent.clientTop;
      const bottom = origin + this.element.offsetTop + this.element.offsetHeight;
      return Number.isFinite(bottom) && bottom > 0 ? bottom : 0;
    } finally {
      if (options) options.style.display = optionsDisplay ?? '';
      if (folded) this.element.classList.add('is-collapsed');
    }
  }

  showTooltip(button: HTMLElement): void {
    const tip = document.getElementById(IDS.tooltip)!;
    tip.textContent = button.dataset.tooltip ?? button.getAttribute('aria-label');
    tip.classList.remove('hidden');
    const rect = button.getBoundingClientRect();
    const top = rect.bottom + tip.offsetHeight + 14 <= window.innerHeight ? rect.bottom + 8 : rect.top - tip.offsetHeight - 8;
    tip.style.top = `${Math.max(6, top)}px`;
    tip.style.left = `${Math.max(6, Math.min(window.innerWidth - tip.offsetWidth - 6, rect.left + rect.width / 2 - tip.offsetWidth / 2))}px`;
    document.querySelectorAll(`[aria-describedby="${IDS.tooltip}"]`).forEach(element => element.removeAttribute('aria-describedby'));
    button.setAttribute('aria-describedby', IDS.tooltip);
  }
  hideTooltip(): void {
    document.getElementById(IDS.tooltip)!.classList.add('hidden');
    document.querySelectorAll(`[aria-describedby="${IDS.tooltip}"]`).forEach(element => element.removeAttribute('aria-describedby'));
  }

  dispose(): void {
    this.sources.dispose();
    this.element.removeEventListener('focusin', this.focusIn);
    this.element.removeEventListener('focusout', this.focusOut);
  }
}
