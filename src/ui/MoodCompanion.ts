import { uiText, uiTemplate } from './ui-language';
import type { MoodInput, MoodView, MoodParameterIdentity } from "../../shared/mood-runtime";
import { MoodPanel } from "./MoodPanel";
import { DEFAULT_PET_INTERACTION_CONFIG, PetInteraction, validatePetInteractionConfig, type PetHeadRegion, type PetInteractionConfig, type PetInteractionEvent, type PetInteractionFeedback, type PetInteractionState } from "./PetInteraction";
import { MoodTouchChannel } from './mood-touch-channel';
import { MoodViewLifetime, type MoodReadTicket } from './mood-view-lifetime';
import { PetWindowDiagnosticsPanel } from './PetWindowDiagnosticsPanel';
import { ProceduralLifeToggle } from './procedural-life-toggle';
import type { PetWindowDiagnosticsView } from '../../shared/contracts';
import type { ExpressionRecipe, ExpressionSupport } from '../../shared/expression-preview';

export interface MoodCompanionAPI {
  getMood(): Promise<MoodView>;
  onMood(callback: (view: MoodView) => void): () => void;
  setMoodDeveloperMode(enabled: boolean): Promise<MoodView>;
  setMoodExpressions(enabled: boolean): Promise<MoodView>;
  setMoodParameters(parameters: unknown, expected: MoodParameterIdentity): Promise<MoodView>;
  restoreMoodParameters(expected: MoodParameterIdentity): Promise<MoodView>;
  moodInteraction(input: MoodInput): Promise<MoodView>;
  openControls(): Promise<void>;
  /** Controls only: developer log of pet window visibility (R37). */
  getPetWindowDiagnostics?(): Promise<PetWindowDiagnosticsView>;
}
type LocalMoodInput = MoodInput extends infer T ? T extends MoodInput ? Omit<T, "token"> : never : never;

/** A late cancellation for an old contact must not clear a fresh DOWN. */
export function matchesDirectContactCancellation(view: Pick<MoodView, 'characterId' | 'token' | 'directContactCancellation'>, sessionId: string): boolean {
  const value: unknown = view.directContactCancellation;
  if (!sessionId || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 && ['characterId', 'token', 'sessionId'].every(key => typeof record[key] === 'string')
    && record.characterId === view.characterId && record.token === view.token && record.sessionId === sessionId;
}

/** Ordered narrow input; a context change invalidates queued work and late responses. */
export class MoodInputQueue {
  private token = "";
  private epoch = 0;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly send: (input: MoodInput) => Promise<MoodView>, private readonly receive: (view: MoodView) => void, private readonly error: (message: string) => void) {}
  setToken(token: string): void { if (token !== this.token) { this.token = token; this.invalidate(); } }
  invalidate(): void { this.epoch++; }
  push(input: LocalMoodInput): Promise<void> {
    const epoch = this.epoch, token = this.token;
    const pending = this.queue.then(async () => {
      if (this.disposed || epoch !== this.epoch || !token) return;
      try {
        const view = await this.send({ ...input, token } as MoodInput);
        if (!this.disposed && epoch === this.epoch && token === this.token) this.receive(view);
      } catch (error) { if (!this.disposed && epoch === this.epoch) this.error(String(error)); }
    });
    this.queue = pending;
    return pending;
  }
  settled(): Promise<void> { return this.queue; }
  dispose(): void { this.disposed = true; this.invalidate(); }
}

export interface MoodCompanionOptions {
  isPet: boolean;
  surface: HTMLElement;
  getHeadRegion(): PetHeadRegion | null;
  canInteract(): boolean;
  onFeedback(feedback: PetInteractionFeedback): void;
  onInteraction(active: boolean): void;
  onView(view: MoodView): void;
  /** Main supplies the accepted active-card ID; absent means new fatigue UI is unbound. */
  getCharacterId?(): string | null;
  /** Trusted context/disconnect notification for separately owned Stage presentation. */
  onScopeInvalidated?(): void;
  /** I-019: an accepted snack's file and its interaction session (PetInteraction onSnack), pet window only. */
  onSnack?(file: File, sessionId: string): void;
  getDegradation?(): string;
  /** M1: the developer line for her want to dance (empty when not in developer mode). */
  getMusicDesire?(): string;
  /** E1: what this window's stage can show of 惊喜 / 害羞 (the developer panel's 「预览」 buttons). */
  getExpressionSupport?(recipe: ExpressionRecipe): ExpressionSupport | null;
  onError?(message: string): void;
  /** Developer comparison switch for procedural small motions and expression (runtime only, default on). */
  onProceduralLife?(enabled: boolean): void;
  api?: MoodCompanionAPI;
}

/** Reserve actual UI layout even while interaction CSS temporarily hides its paint. */
export function isPetControlPoint(owner: Pick<Document, "querySelectorAll">, clientX: number, clientY: number): boolean {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
  for (const element of owner.querySelectorAll<HTMLElement>("#pet-toolbar, .pet-window-help, .pet-resize-handle, .pet-chat, [data-mood-ui]")) {
    const rect = element.getBoundingClientRect();
    // display:none (including collapsed panels) has no area; visibility:hidden retains it.
    if (rect.width > 0 && rect.height > 0 && clientX >= rect.left && clientY >= rect.top && clientX < rect.left + rect.width && clientY < rect.top + rect.height) return true;
  }
  return false;
}

/** Connects host state, the developer observer, and pet-only direct input. */
export class MoodCompanion {
  private readonly api: MoodCompanionAPI;
  private readonly inputQueue: MoodInputQueue;
  private viewLifetime = new MoodViewLifetime();
  private readonly container: HTMLElement;
  private readonly panel: MoodPanel;
  private readonly expressions: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly compact: HTMLButtonElement | null;
  private readonly feedback: HTMLOutputElement;
  private readonly storage: HTMLOutputElement;
  private readonly touchEditor: HTMLTextAreaElement | null;
  private readonly touchNotice: HTMLOutputElement | null;
  private interactionConfig: PetInteractionConfig = { ...DEFAULT_PET_INTERACTION_CONFIG };
  private touchChannel: MoodTouchChannel | null = null;
  private touchBusy = false;
  private readonly touchButtons: HTMLButtonElement[] = [];
  private readonly lifeToggle: ProceduralLifeToggle;
  private collapsed: boolean;
  private localPhase: PetInteractionState["phase"] = "idle";
  private localSpeed = 0;
  private localHover = 0;
  private input: PetInteraction | null = null;
  private view: MoodView | null = null;
  private unsubscribe: (() => void) | null = null;
  private toggle: HTMLElement | null = null;
  private visible = true;
  /** I-028: closed with the pet's toolbar; developer mode stays on, and the panel shows again when it is next turned on. */
  private panelClosed = false;
  private disposed = false;
  private initialized = false;
  private suppressInputState = false;
  private lastSession = "";
  private lifecycle = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private compactTimer: ReturnType<typeof setInterval> | null = null;
  private lastStorageError = "";
  constructor(private readonly options: MoodCompanionOptions) {
    this.api = options.api ?? (window as unknown as { desktop: MoodCompanionAPI }).desktop;
    this.inputQueue = new MoodInputQueue(input => this.api.moodInteraction(input), view => this.applyView(view), message => this.error(message));
    const owner = options.surface.ownerDocument;
    this.container = owner.createElement("aside"); this.container.className = "mood-companion";
    this.container.dataset.moodUi = "true"; this.container.hidden = true;
    this.collapsed = options.isPet;
    const heading = owner.createElement("div"); heading.className = "mood-companion-heading";
    const headingText = owner.createElement("strong"); headingText.textContent = uiText("心情观察"); heading.append(headingText);
    this.compact = options.isPet ? owner.createElement("button") : null;
    if (this.compact) { this.compact.type = "button"; this.compact.id = 'mood-open-controls'; this.compact.addEventListener("click", this.openControls); heading.append(this.compact); }
    this.feedback = owner.createElement("output"); this.feedback.className = "mood-local-feedback"; this.feedback.id = "mood-local-feedback";
    this.feedback.setAttribute("aria-label", uiText("当前本地互动与鼠标速度"));
    this.feedback.textContent = options.isPet ? uiText("日常 · 速度 0.00 W/s") : uiText("状态由桌宠窗口统一结算");
    this.storage = owner.createElement("output"); this.storage.className = "mood-storage-error"; this.storage.hidden = true;
    this.body = owner.createElement("div"); this.body.className = "mood-companion-body";
    this.container.append(heading, this.feedback, this.storage, this.body);
    this.expressions = owner.createElement("button"); this.expressions.type = "button"; this.expressions.className = "mood-expression-toggle";
    this.expressions.addEventListener("click", this.toggleExpressions);
    this.body.append(this.expressions);
    this.lifeToggle = new ProceduralLifeToggle(this.body, { onChange: enabled => this.options.onProceduralLife?.(enabled) });
    this.panel = new MoodPanel(this.body, {
      onApply: async parameters => { if (this.view) this.applyView(await this.api.setMoodParameters(parameters, { characterId: this.view.characterId, token: this.view.token })); },
      onRestore: async () => { if (this.view) this.applyView(await this.api.restoreMoodParameters({ characterId: this.view.characterId, token: this.view.token })); },
      onWake: async () => { if (this.view) { const id = crypto.randomUUID(); await this.inputQueue.push({ type: 'wake', id, sessionId: id }); } },
      onClose: async () => this.applyView(await this.api.setMoodDeveloperMode(false)),
      expressionSupport: recipe => this.options.getExpressionSupport?.(recipe) ?? null,
      onError: message => this.error(message),
    });
    this.touchEditor = owner.createElement("textarea");
    this.touchNotice = owner.createElement("output");
    if (this.touchEditor && this.touchNotice) {
      const tuning = owner.createElement("details"); tuning.className = "mood-touch-tuning";
      const summary = owner.createElement("summary"); summary.textContent = uiText("互动手感");
      const hint = owner.createElement("p"); hint.textContent = uiText("仅本次运行生效，不保存到角色卡。命中头皮立即提示并平滑回应；同次接触 2 秒后设置栏淡出，静止不计奖励。下方六项时间单位 ms，速度为头宽/秒，扫过幅度为头宽比例。嘴边准备至少 500 ms。");
      this.touchEditor.id = "mood-touch-parameters"; this.touchEditor.rows = 9; this.touchEditor.spellcheck = false; this.touchEditor.maxLength = 3000;
      this.touchEditor.setAttribute("aria-label", uiText("本次运行互动手感 JSON")); this.touchEditor.value = JSON.stringify(this.interactionConfig, null, 2);
      const apply = owner.createElement("button"); apply.type = "button"; apply.id = "mood-touch-apply"; apply.textContent = uiText("应用本次手感"); apply.addEventListener("click", this.applyTouchConfig);
      const restore = owner.createElement("button"); restore.type = "button"; restore.id = "mood-touch-restore"; restore.textContent = uiText("恢复默认手感"); restore.addEventListener("click", this.restoreTouchConfig);
      this.touchButtons.push(apply, restore);
      const actions = owner.createElement("div"); actions.className = "mood-actions"; actions.append(apply, restore);
      tuning.append(summary, hint, this.touchEditor, actions, this.touchNotice); this.body.append(tuning);
    }
    const diagnostics = this.api.getPetWindowDiagnostics?.bind(this.api);
    if (!options.isPet && diagnostics) new PetWindowDiagnosticsPanel(this.body, diagnostics);
    this.refreshCollapse();
    const controlsHost = options.isPet ? null : owner.querySelector<HTMLElement>('.content-card');
    if (controlsHost) {
      controlsHost.classList.add('mood-observer-host');
      this.container.classList.add('mood-controls-observer');
      controlsHost.prepend(this.container);
    } else owner.body.append(this.container);
  }
  async init(): Promise<void> {
    if (this.disposed || this.initialized) return;
    this.initialized = true;
    this.toggle = this.options.surface.ownerDocument.getElementById(this.options.isPet ? "pet-developer-mode" : "open-mood");
    this.toggle?.addEventListener("click", this.toggleDeveloper);
    this.lifeToggle.connect();
    this.unsubscribe = this.api.onMood(view => this.applyView(view));
    if (this.options.isPet) this.input = new PetInteraction(this.options.surface, {
      getHeadRegion: () => this.options.getHeadRegion(),
      canInteract: () => Boolean(this.view) && this.options.canInteract(),
      blocksPoint: (x, y) => isPetControlPoint(this.options.surface.ownerDocument, x, y),
      onState: state => this.inputState(state),
      onFeedback: feedback => {
        if (this.disposed) return;
        this.localSpeed = feedback.speed; this.localHover = feedback.hover ?? (feedback.contact ? 1 : 0);
        this.fadePetUI(feedback); this.renderFeedback(); this.options.onFeedback(feedback);
      },
      onEvent: event => this.inputEvent(event),
      onSnack: (file, sessionId) => { if (!this.disposed) this.options.onSnack?.(file, sessionId); },
      onError: message => this.error(message),
      onCancel: reason => this.reset(reason),
      config: this.interactionConfig,
    });
    this.touchChannel = new MoodTouchChannel({
      isPet: this.options.isPet,
      token: () => this.view?.token ?? null,
      apply: this.options.isPet ? config => this.applyLocalTouchConfig(config) : undefined,
    });
    if (this.options.isPet) this.compactTimer = setInterval(() => {
      if (this.view?.developerMode && this.visible && !this.disposed) { this.positionCompact(); this.panel.setMusicDesire(this.options.getMusicDesire?.() ?? ''); }
    }, 200);
    await this.refreshView();
  }
  private clearFatigueView(): void {
    if (this.view) this.view = { ...this.view, fatigue: undefined };
    this.panel.clearFatigue();
  }
  private async refreshView(): Promise<void> {
    const ticket = this.viewLifetime.ticket();
    try { const view = await this.api.getMood(); this.applyView(view, ticket); }
    catch (error) {
      if (!this.disposed && this.viewLifetime.isCurrent(ticket)) {
        this.viewLifetime.invalidate(); this.inputQueue.setToken(''); this.clearFatigueView(); this.error(String(error));
      }
    }
  }
  private applyView(view: MoodView, ticket?: MoodReadTicket): void {
    if (this.disposed || !this.viewLifetime.accept(view, ticket)) return;
    let expected: string | null | undefined;
    try { expected = this.options.getCharacterId?.(); } catch { expected = null; }
    if (this.options.getCharacterId && (!expected || expected !== view.characterId)) {
      this.inputQueue.setToken(''); this.clearFatigueView(); return;
    }
    // Preserve the legacy mood bridge when no active-card authority is supplied,
    // but never infer the new per-character fatigue display from a model/provider.
    if (!expected) view = { ...view, fatigue: undefined };
    const changed = this.view?.token !== view.token;
    this.view = structuredClone(view);
    this.inputQueue.setToken(view.token);
    if (changed) { this.touchChannel?.invalidate(); this.resetLocal(); }
    else if (this.options.isPet && matchesDirectContactCancellation(view, this.lastSession)) this.reset('native-blur');
    const storageError = "storageError" in view && typeof view.storageError === "string" ? view.storageError : "";
    if (storageError && storageError !== this.lastStorageError) this.error(storageError);
    this.lastStorageError = storageError;
    this.storage.hidden = !storageError; this.storage.textContent = storageError ? uiTemplate`保存失败：${storageError}` : "";
    this.options.onView(view);
    let actualDegradation = "";
    try { actualDegradation = this.options.getDegradation?.() ?? ""; } catch (error) { this.error(String(error)); }
    const degradation = [view.expressions ? actualDegradation || uiText("局部表情与姿态；用户选择的动作优先") : uiText("自动情绪表现已暂停；真实鼠标带动仍保留"), storageError ? uiTemplate`保存失败：${storageError}` : ""].filter(Boolean).join("；");
    this.panel.update({ ...view, degradation });
    this.panel.setVisible(view.developerMode);
    if (!view.developerMode) this.panelClosed = false;
    this.container.hidden = !view.developerMode || !this.visible || this.panelClosed;
    this.expressions.textContent = view.expressions ? uiText("暂停自动表现") : uiText("恢复自动表现");
    this.expressions.setAttribute("aria-pressed", String(!view.expressions));
    this.toggle?.setAttribute("aria-pressed", String(view.developerMode));
    if (this.toggle) this.toggle.dataset.tooltip = view.developerMode ? uiText("开发者模式：开启，点击关闭") : uiText("开发者模式：关闭，点击查看心情状态");
    // #13 (I-020): a speech cue no longer becomes one of two fixed lines here. Who speaks is chosen in the host
    // (electron/inner-loop/opening-host.ts); with the inner loop off she says nothing of her own.
    if (this.options.isPet) this.renderFeedback(); else this.positionCompact();
  }
  private readonly openControls = () => {
    if (!this.disposed) void this.api.openControls().catch(error => this.error(String(error)));
  };
  private refreshCollapse(): void {
    this.body.hidden = this.collapsed;
    this.container.classList.toggle("is-compact", this.collapsed);
    if (this.compact) { this.compact.textContent = uiText("在控制窗查看"); this.compact.setAttribute("aria-label", uiText("在控制窗口查看完整心情状态和参数")); }
    this.positionCompact();
  }
  private positionCompact(): void {
    if (!this.options.isPet || !this.collapsed) { this.container.style.top = ""; return; }
    let head: PetHeadRegion | null;
    try { head = this.options.getHeadRegion(); } catch { return; }
    if (!head) { this.container.classList.remove('mood-no-room'); this.container.style.top = ""; return; }
    const surface = this.options.surface.getBoundingClientRect();
    const view = this.options.surface.ownerDocument.defaultView!;
    const width = this.container.offsetWidth || 156, height = this.container.offsetHeight || 54;
    const x = surface.left + head.x, y = surface.top + head.y, radius = head.radius;
    // A conservative head/upper-body corridor is only used to keep debug UI out
    // of the model. It never changes head hits, movement units or food geometry.
    const protectedRegion = { left: x - radius * 2.1, right: x + radius * 2.1, top: y - radius * 1.2, bottom: y + radius * 8 };
    const controls = [...this.options.surface.ownerDocument.querySelectorAll<HTMLElement>('#pet-toolbar, .pet-window-help, .pet-resize-handle, .pet-chat')]
      .map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
    const intersects = (left: number, top: number, rect: { left: number; top: number; right: number; bottom: number }) =>
      left < rect.right && left + width > rect.left && top < rect.bottom && top + height > rect.top;
    const candidates = [
      [view.innerWidth - width - 8, 54], [8, 54],
      [view.innerWidth - width - 8, protectedRegion.bottom + 8], [8, protectedRegion.bottom + 8],
      [view.innerWidth - width - 8, 8], [8, 8],
    ];
    const free = candidates.find(([left, top]) => left >= 8 && top >= 8 && left + width <= view.innerWidth - 8 && top + height <= view.innerHeight - 8
      && !intersects(left, top, protectedRegion) && !controls.some(rect => intersects(left, top, rect)));
    this.container.classList.toggle('mood-no-room', !free);
    if (free) { this.container.style.top = `${free[1]}px`; this.container.style.left = `${free[0]}px`; this.container.style.right = 'auto'; }
  }
  private fadePetUI(feedback: Pick<PetInteractionFeedback, 'contact' | 'feeding' | 'hover'>): void {
    if (!this.options.isPet) return;
    const amount = feedback.contact || feedback.feeding ? 1 : Math.min(1, Math.max(0, Number.isFinite(feedback.hover) ? feedback.hover! : 0));
    const body = this.options.surface.ownerDocument.body;
    body.style.setProperty('--pet-interaction-opacity', String(1 - amount));
    body.classList.toggle('pet-ui-faded', amount >= 1);
  }
  private applyLocalTouchConfig(config: PetInteractionConfig): PetInteractionConfig {
    if (!this.input || this.disposed) throw new Error(uiText('桌宠互动尚未就绪。'));
    this.reset("tuning"); this.input.configure(config); this.interactionConfig = { ...config };
    if (this.touchEditor) this.touchEditor.value = JSON.stringify(config, null, 2);
    this.renderFeedback();
    return { ...this.interactionConfig };
  }
  private readonly applyTouchConfig = async () => {
    if (this.disposed || !this.touchEditor || this.touchBusy || !this.view) return;
    const token = this.view.token;
    try {
      const config = validatePetInteractionConfig(JSON.parse(this.touchEditor.value));
      this.touchBusy = true; this.touchButtons.forEach(button => { button.disabled = true; });
      this.touchNotice!.textContent = uiText('正在等待桌宠确认…');
      const applied = this.options.isPet ? this.applyLocalTouchConfig(config)
        : await (this.touchChannel?.request(config) ?? Promise.reject(new Error(uiText('手感通道未就绪，本次应用未确认。'))));
      if (this.disposed || this.view?.token !== token) return;
      this.interactionConfig = { ...applied };
      this.touchEditor.value = JSON.stringify(applied, null, 2); this.renderFeedback();
      this.touchNotice!.textContent = uiText("已确认应用桌宠本次手感；原有心情数值与记忆保留。重启恢复默认。");
    } catch (error) {
      if (!this.disposed && this.view?.token === token) { this.touchNotice!.textContent = String(error); this.error(String(error)); }
    } finally {
      this.touchBusy = false; this.touchButtons.forEach(button => { button.disabled = false; });
    }
  };
  private readonly restoreTouchConfig = () => {
    if (!this.touchEditor) return;
    if (this.touchBusy) return;
    this.touchEditor.value = JSON.stringify(DEFAULT_PET_INTERACTION_CONFIG, null, 2); void this.applyTouchConfig();
  };
  private readonly toggleDeveloper = () => {
    if (!this.view || this.disposed) return;
    const enabled = !this.view.developerMode;
    void this.api.setMoodDeveloperMode(enabled).then(async view => {
      this.applyView(view);
      if (enabled && this.options.isPet && !this.disposed) await this.api.openControls();
    }).catch(error => this.error(String(error)));
  };
  private readonly toggleExpressions = () => {
    if (!this.view || this.disposed) return;
    void this.api.setMoodExpressions(!this.view.expressions).then(view => this.applyView(view)).catch(error => this.error(String(error)));
  };
  private inputState(state: PetInteractionState): void {
    if (this.suppressInputState || this.disposed || !this.view) return;
    this.localPhase = state.phase; this.renderFeedback();
    // Cheek hover starts only the existing visual contact clock; the early
    // return below prevents it from opening a host session or earning input.
    this.options.onInteraction(state.phase !== "idle" && state.phase !== "rua-hover");
    // Local dwell keeps the ordinary UI and must never open a host rua session.
    // A previous real session's bounded tail/idle timer may still drain normally.
    if (state.phase === 'rua-hover' || state.phase === 'cheek-hover') return;
    if (state.phase === 'idle' && this.idleTimer !== null) return;
    this.clearIdleTimer();
    if (state.phase === "idle") {
      const sessionId = this.lastSession;
      if (!sessionId) return;
      const lifecycle = this.lifecycle;
      // The tracker's 5 Hz flush gets one chance to send already measured tail time.
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.disposed || lifecycle !== this.lifecycle) return;
        void this.inputQueue.push({ type: "phase", phase: "idle", sessionId });
        if (this.lastSession === sessionId) this.lastSession = '';
      }, 220);
      return;
    }
    this.lastSession = state.sessionId!;
    if (state.phase === "feeding-accepted") return; // food acceptance must reach the host first.
    const phase = state.phase === "feeding-wait" ? "food-wait" : state.phase === "feeding-ready" ? "food-ready" : state.phase === 'cheek' ? 'cheek' : "rua";
    void this.inputQueue.push({ type: "phase", phase, sessionId: this.lastSession });
  }
  private inputEvent(event: PetInteractionEvent): void {
    if (this.disposed || this.suppressInputState || !this.view) return;
    if (event.type === "rua" || event.type === 'cheek') void this.inputQueue.push(event);
    else {
      void this.inputQueue.push(event);
      void this.inputQueue.push({ type: "phase", phase: "food-eating", sessionId: event.sessionId });
    }
  }
  private clearIdleTimer(): void { if (this.idleTimer !== null) clearTimeout(this.idleTimer); this.idleTimer = null; }
  private renderFeedback(): void {
    if (!this.options.isPet) return;
    const phase = { idle: uiText("日常"), "rua-hover": uiTemplate`等待摸头 ${Math.round(this.localHover * 100)}%`, rua: uiText("接触"), 'cheek-hover': uiText('脸颊可捏'), cheek: uiText('捏脸持握'), "feeding-wait": uiText("等待点心"), "feeding-ready": uiText("张嘴准备"), "feeding-accepted": uiText("接受点心") }[this.localPhase];
    this.feedback.textContent = uiTemplate`${phase} · 速度 ${this.localSpeed.toFixed(2)} W/s`;
    this.feedback.dataset.phase = this.localPhase;
    this.feedback.dataset.sessionId = this.input?.state.sessionId ?? '';
    this.feedback.dataset.speed = String(this.localSpeed);
    this.feedback.dataset.hover = String(this.localHover);
    this.feedback.dataset.touchConfig = this.view?.developerMode ? JSON.stringify(this.interactionConfig) : '';
    this.positionCompact();
  }
  private resetLocal(): void {
    this.lifecycle++; this.clearIdleTimer(); this.lastSession = "";
    this.localPhase = "idle"; this.localSpeed = 0; this.localHover = 0; this.renderFeedback();
    this.fadePetUI({ contact: false, feeding: false, hover: 0 });
    this.suppressInputState = true;
    try { this.input?.reset(); } finally { this.suppressInputState = false; }
    this.options.onInteraction(false);
  }
  reset(reason?: string): void {
    const sessionId = this.lastSession;
    this.inputQueue.invalidate(); this.resetLocal();
    if (reason === 'context' || reason === 'character' || reason === 'disconnect') {
      this.viewLifetime.invalidate(); this.inputQueue.setToken(''); this.touchChannel?.invalidate();
      this.clearFatigueView(); this.options.onScopeInvalidated?.();
      if (reason !== 'disconnect') void this.refreshView();
      return;
    }
    if (sessionId && this.view && !this.disposed) void this.inputQueue.push({ type: "phase", phase: "idle", sessionId });
  }
  /** I-028: the panel is on screen (in the pet window: the compact 心情观察). */
  get panelOpen(): boolean { return !this.disposed && !this.container.hidden; }
  /** I-028: hides the panel only; developer mode, the mood and every setting stay as they are. */
  closePanel(): void {
    if (this.disposed) return;
    this.panelClosed = true; this.container.hidden = true;
  }
  setHostVisible(visible: boolean): void {
    this.visible = visible;
    this.container.hidden = !visible || !this.view?.developerMode || this.panelClosed;
    if (!visible) this.reset("hidden");
    this.input?.setHostVisible(visible);
  }
  private error(message: string): void { if (!this.disposed) this.options.onError?.(message); }
  dispose(): void {
    if (this.disposed) return;
    const sessionId = this.lastSession, token = this.view?.token;
    this.resetLocal(); this.viewLifetime.dispose(); this.clearFatigueView(); this.disposed = true;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.toggle?.removeEventListener("click", this.toggleDeveloper);
    this.compact?.removeEventListener("click", this.openControls);
    this.expressions.removeEventListener("click", this.toggleExpressions);
    this.input?.dispose(); this.input = null; this.inputQueue.dispose();
    this.touchChannel?.dispose(); this.touchChannel = null; this.lifeToggle.dispose();
    if (this.compactTimer !== null) clearInterval(this.compactTimer); this.compactTimer = null;
    if (this.options.isPet) {
      const body = this.options.surface.ownerDocument.body;
      body.style.removeProperty('--pet-interaction-opacity'); body.classList.remove('pet-ui-faded');
    }
    this.panel.dispose(); this.container.remove();
    if (sessionId && token) void this.api.moodInteraction({ token, sessionId, type: "phase", phase: "idle" }).catch(() => {});
  }
}
