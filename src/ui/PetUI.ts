import { uiText, uiHtml, uiMarkup, uiTemplate } from './ui-language';
import type { AppSettings, PetReplyAnchor, PetReplyUpdate, PetWindowOperation, RuntimePatch, RuntimeState, SystemAudioState } from '../../shared/contracts';
import { icon } from './icons';
import { HOVER_REVEAL_MARGIN, HoverVisibility, nearHoverZone } from './HoverVisibility';
import { ReplySpeechState } from './reply-speech';
import { ReplyReader } from './ReplyReader';
import { formatReplyBubbles } from './reply-segments';
import { REPLY_BUBBLE_POLICY, replyPieces, type ReplyBubblePolicy } from '../../shared/reply-bubbles';
import { readReplyLingerAnswer, readReplyLingerLeft, replyLingerLongestMs } from '../../shared/behaviors/reply-linger/perform';
import { PetPopups, type PetPopupHandle, type PetPopupKey } from './pet-popups';
import { CameraSharingPanel, cameraWords } from './CameraSharingPanel';

/** I-028: the toolbar's popups whose panels are made outside PetUI (src/main.ts); PetUI wires the other five itself. */
export type PetHostedPopupKey = Exclude<PetPopupKey, 'system-audio' | 'user-profile' | 'reply-reader' | 'notice-detail' | 'camera-sharing'>;

interface PetActions {
  edit(enabled?: boolean): void;
  onInteractionBlockChange?(blocked: boolean): void;
  feature(feature: keyof RuntimePatch): void;
  /** 和她一起看: opens (or closes) 「和她一起听」 and screen sharing together. */
  watchTogether?(): void;
  /** I-036: the camera panel's two switches (window.desktop.setRuntimeState); the reply may carry why 「姿势识别」 stayed off. */
  camera?(patch: RuntimePatch): Promise<RuntimeState>;
  explainRuntime?(reply: RuntimeState): void;
  systemAudio?(): void;
  toggleAlwaysOnTop?(): void;
  closeSystemAudioPanel?(): void;
  toggleUserProfile?(): void;
  closeUserProfile?(): void;
  developerMode?(): void;
  /** I-028: folding the toolbar closes these too (src/ui/pet-popups.ts). */
  popups: Readonly<Record<PetHostedPopupKey, PetPopupHandle>>;
  send(): void;
  stop(): void;
  error(message: string): void;
}

export function renderPet(app: HTMLElement): void {
  app.innerHTML = uiHtml`<div id="stage" class="pet-stage"></div>
    <div id="pet-toolbar" class="pet-toolbar" role="toolbar" aria-label="桌宠功能">
      <button id="pet-move-window" title="按住拖动窗口" aria-label="按住拖动窗口">${icon('move')}</button>
      <button id="pet-always-on-top" type="button" title="始终置顶" aria-label="始终置顶" aria-pressed="false" disabled>${icon('pin')}</button>
      <button id="pet-size-toggle" title="进入窗口调整模式" aria-label="窗口调整模式" aria-pressed="false">${icon('size')}</button>
      <button id="pet-camera-edit" title="调整镜头" aria-label="调整镜头" aria-pressed="false">${icon('sliders')}</button>
      <button id="pet-voice-input" title="语音输入：关闭" aria-label="语音输入" aria-pressed="false">${icon('mic')}</button>
      <button id="pet-screen-sharing" title="屏幕共享：关闭" aria-label="屏幕共享" aria-pressed="false">${icon('screen')}</button>
      <button id="pet-watch-together" title="和她一起看" aria-label="和她一起看" aria-pressed="false">${icon('eye')}</button>
      <button id="pet-camera-sharing" title="摄像头共享：关闭" aria-label="摄像头共享" aria-pressed="false">${icon('camera')}</button>
      <button id="pet-system-audio-sharing" title="读取本机音频" aria-label="读取本机音频" aria-expanded="false" aria-controls="ambient-audio-controls" aria-pressed="false">${icon('music')}<span class="pet-panel-chevron" aria-hidden="true">▾</span></button>
      <button id="pet-developer-mode" title="开发者模式：关闭" aria-label="开发者模式" aria-pressed="false">${icon('terminal')}</button>
      <button id="notice-details" class="notice-details-button" type="button" title="查看问题详情" aria-label="查看问题详情" hidden>${icon('terminal')}</button>
      <button id="open-controls" title="打开控制窗口" aria-label="打开控制窗口">${icon('cpu')}</button>
      <button id="user-profile-toggle" type="button" title="用户画像" aria-label="用户画像" aria-controls="user-profile-panel" aria-expanded="false">${icon('chat')}</button>
      <button id="pet-read-reply" type="button" title="查看完整回复" aria-label="查看完整回复" disabled>${icon('chat')}</button>
      <button id="pet-toolbar-toggle" type="button" title="收起工具栏" aria-label="收起工具栏" aria-expanded="true" aria-controls="pet-toolbar">&gt;</button>
      <output id="pet-window-size" class="pet-window-size" aria-label="当前窗口尺寸"></output>
    </div>
    <div id="ambient-audio-controls"></div><section id="pet-camera-panel" class="pet-camera-panel" data-mood-ui aria-label="摄像头共享" hidden></section><section id="user-profile-panel" class="user-profile-panel" data-mood-ui aria-label="用户画像" hidden></section>
    <div class="pet-window-adjustment" role="group" aria-label="窗口宽高调整">
      <button id="pet-resize-nw" class="pet-resize-handle pet-resize-nw" title="按住左上角调整窗口宽高" aria-label="按住左上角调整窗口宽高"></button>
      <button id="pet-resize-ne" class="pet-resize-handle pet-resize-ne" title="按住右上角调整窗口宽高" aria-label="按住右上角调整窗口宽高"></button>
      <button id="pet-resize-sw" class="pet-resize-handle pet-resize-sw" title="按住左下角调整窗口宽高" aria-label="按住左下角调整窗口宽高"></button>
      <button id="pet-resize-se" class="pet-resize-handle pet-resize-se" title="按住右下角调整窗口宽高" aria-label="按住右下角调整窗口宽高"></button>
      <div class="pet-window-help">拖动四角调整窗口宽高 · Esc 完成<button id="pet-window-done" type="button">完成</button></div>
    </div>
    <div id="pet-tooltip" class="pet-tooltip hidden" role="tooltip"></div>
    <output id="pet-media-indicator" class="pet-media-indicator hidden"></output><div id="pet-edit-help" class="pet-edit-help hidden">左键原地转向 · 右键平移<br />WASD 移动 · Space 上升 · Z 下降<br />Shift ¼ 微调 · Tab 重新取景 · Esc 完成</div>
    <section id="pet-answer" class="hidden" aria-hidden="true"><div id="pet-answer-body"></div></section>
    <dialog id="pet-reply-reader" class="pet-reply-reader" data-mood-ui aria-labelledby="pet-reply-reader-title"><header><strong id="pet-reply-reader-title">完整回复</strong><button id="pet-reply-reader-close" type="button" aria-label="关闭完整回复">关闭</button></header><p id="pet-reply-reader-status" role="status"></p><div id="pet-reply-reader-body" tabindex="0" aria-label="完整回复正文"></div></dialog>
    <div class="pet-chat"><div id="attachments" class="attachments"></div><form id="chat-form"><textarea id="chat-input" rows="1" placeholder="和我说点什么…" aria-label="聊天消息"></textarea><button id="send-chat" type="submit" aria-label="发送消息">${icon('send')}</button><button id="stop-chat" type="button" class="hidden" aria-label="停止回复">${icon('stop')}</button></form><div id="voice-action-slot" class="voice-action-slot"></div><span id="chat-state">Enter 发送 · Shift + Enter 换行</span></div>
    <output id="pet-voice-state" class="pet-voice-state hidden" role="status"></output><div id="messages" class="hidden"></div><div id="pet-empty">还没有载入 MMD 模型<br /><small>点击设置，选择你的 PMX / PMD</small></div><div id="pet-status" class="pet-caption"></div><div id="toast" class="toast" role="status"></div><section id="notice-detail-panel" class="notice-detail-panel" data-mood-ui aria-label="问题详情" hidden><strong>问题详情</strong><button id="notice-detail-close" type="button">关闭</button><pre id="notice-detail-text"></pre></section>`;
}

/** Window dragging is confined to the explicit hold-to-drag handle. */
export class PetUI {
  private anchor: PetReplyAnchor = { x: 200, y: 160, visible: false };
  private replyState: 'hidden' | 'waiting' | 'streaming' | 'complete' = 'hidden';
  /**
   * When this window treats the reply as gone. #5: the host alone decides how long a completed reply stays
   * (shared/behaviors/reply-linger/); a 'complete' starts at the longest it may be and becomes the host's answer when it
   * arrives (publishReply), so both windows end it at the same moment. Like the host's, the countdown waits while her face
   * is off screen (replyPausedLeft, Codex T-207 round 2).
   */
  private replyExpiresAt = 0;
  /**
   * Codex T-207 round 2: while her face is off screen, what is left of a completed reply's time (replyExpiresAt is then
   * Infinity); undefined while the countdown runs. The host counts only while the bubble can be seen, which needs her face
   * on screen, so this window never finds a reply over that the host still owes time: a first face anchor 2.8 s after
   * "嗯。" completed had found it over and hidden it before it ever showed.
   */
  private replyPausedLeft?: number;
  /** #5: bumped by every state publication, so a late answer for an older completion is ignored. */
  private replyLingerAsk = 0;
  private replyStreaming = false;
  private replyPublication: Promise<unknown> = Promise.resolve();
  private readonly replySpeech = new ReplySpeechState();
  private replyReader?: ReplyReader;
  private replyPreviewText?: string;
  /** Ordinary chat reply whose native bubble uses R27 pieces (see shared/reply-bubbles.ts). */
  private piecesReplyId?: string;
  /** Tests only. The product switch is REPLY_BUBBLE_POLICY in shared/reply-bubbles.ts. */
  bubblePolicy?: ReplyBubblePolicy;
  private interacting = false;
  private interactionProgress = 0;
  private drag: { id: number; handle: HTMLElement } | null = null;
  private windowAdjusting = false;
  private interactionBlocked = false;
  private runtimeIndicators: string[] = [];
  private systemAudioActive = false;
  private screenSharingOn = false;
  private audioDanceActive = false;
  private audioDanceStatus = '';
  private alwaysOnTopPending = false;
  private systemAudioStatus = '';
  private readonly dragHandle = document.getElementById('pet-move-window')!;
  private readonly operationHandles = new Map<HTMLElement, PetWindowOperation>();
  private readonly toolbar = document.getElementById('pet-toolbar')!;
  private readonly chat = document.querySelector<HTMLElement>('.pet-chat')!;
  private readonly toolbarVisibility: HoverVisibility;
  private readonly chatVisibility: HoverVisibility;
  private toolbarNear = false;
  private toolbarCollapsed = false;
  /** I-028: every popup the toolbar opens, in one place (src/ui/pet-popups.ts). */
  private readonly popups: PetPopups;
  /** I-036: the camera button expands 「发图片」 and 「姿势识别」 (src/ui/CameraSharingPanel.ts). */
  private readonly cameraPanel: CameraSharingPanel;
  private chatNear = false;
  private readonly leave = () => {
    this.toolbarNear = this.chatNear = false;
    this.toolbarVisibility.leave(); this.chatVisibility.leave(); this.toolbarVisibility.contact(false);
  };
  private readonly hoverMove = (event: PointerEvent) => {
    const inside = event.clientX >= 0 && event.clientY >= 0 && event.clientX < window.innerWidth && event.clientY < window.innerHeight;
    this.toolbarNear = inside && nearHoverZone(this.toolbar.getBoundingClientRect(), event.clientX, event.clientY, this.toolbarNear);
    this.chatNear = inside && nearHoverZone(this.chat.getBoundingClientRect(), event.clientX, event.clientY, this.chatNear);
    if (this.toolbarNear) this.toolbarVisibility.enter(); else this.toolbarVisibility.leave();
    if (this.chatNear) this.chatVisibility.enter(); else this.chatVisibility.leave();
  };
  private readonly focus = (event: FocusEvent) => this.toolbarVisibility.focus((event.target as HTMLElement).matches(':focus-visible'));
  private readonly unfocus = (event: FocusEvent) => {
    const target = event.relatedTarget as HTMLElement | null;
    this.toolbarVisibility.focus(Boolean(target && this.toolbar.contains(target) && target.matches(':focus-visible')));
  };
  private readonly chatFocus = () => this.chatVisibility.focus(true);
  private readonly chatUnfocus = (event: FocusEvent) => this.chatVisibility.focus(Boolean(event.relatedTarget && this.chat.contains(event.relatedTarget as Node)));
  private readonly windowFocus = () => { if (this.chat.contains(document.activeElement)) this.chatVisibility.focus(true); };
  private readonly blur = () => { this.endDrag(); this.setWindowAdjusting(false); this.resetHover(); };
  private readonly openNoticeDetails = () => {
    this.actions.closeUserProfile?.();
    this.actions.closeSystemAudioPanel?.();
    const reader = document.getElementById('pet-reply-reader') as HTMLDialogElement;
    if (reader.open) reader.close();
  };
  private readonly keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || (!this.windowAdjusting && !this.drag)) return;
    event.preventDefault(); this.endDrag(); this.setWindowAdjusting(false);
  };
  private readonly resize = () => { document.getElementById('pet-window-size')!.textContent = uiTemplate`窗口 ${window.innerWidth} × ${window.innerHeight}`; this.leave(); this.hideTooltip(); this.positionAnswer(); };
  constructor(private readonly actions: PetActions) {
    const byId = (id: string) => document.getElementById(id)!;
    this.toolbarVisibility = new HoverVisibility(visible => {
      this.toolbar.classList.toggle('is-visible', visible);
      if (!visible) this.hideTooltip();
    });
    this.chatVisibility = new HoverVisibility(visible => this.chat.classList.toggle('is-visible', visible));
    document.documentElement.addEventListener('pointerenter', this.hoverMove);
    document.documentElement.addEventListener('pointerleave', this.leave);
    document.documentElement.addEventListener('pointermove', this.hoverMove);
    this.toolbar.addEventListener('focusin', this.focus);
    this.toolbar.addEventListener('focusout', this.unfocus);
    this.chat.addEventListener('focusin', this.chatFocus); this.chat.addEventListener('focusout', this.chatUnfocus);
    byId('open-controls').onclick = () => void window.desktop.openControls();
    const expanded = (id: string) => byId(id).getAttribute('aria-expanded') === 'true';
    const readerDialog = byId('pet-reply-reader') as HTMLDialogElement, noticePanel = byId('notice-detail-panel');
    this.cameraPanel = new CameraSharingPanel(byId('pet-camera-panel'), byId('pet-camera-sharing'), {
      set: patch => actions.camera ? actions.camera(patch) : Promise.reject(Error(uiText('这个窗口还不能开关摄像头。'))),
      explain: reply => actions.explainRuntime?.(reply), error: message => actions.error(message),
    });
    this.popups = new PetPopups({
      'camera-sharing': { isOpen: () => this.cameraPanel.isOpen, close: () => this.cameraPanel.close() },
      'system-audio': { isOpen: () => expanded('pet-system-audio-sharing'), close: () => actions.closeSystemAudioPanel?.() },
      'user-profile': { isOpen: () => expanded('user-profile-toggle'), close: () => actions.closeUserProfile?.() },
      'reply-reader': { isOpen: () => readerDialog.open, close: () => readerDialog.close() },
      'notice-detail': { isOpen: () => !noticePanel.hidden, close: () => { noticePanel.hidden = true; } },
      ...actions.popups,
    }, message => actions.error(message));
    this.replyReader = new ReplyReader(byId('pet-reply-reader') as HTMLDialogElement,
      byId('pet-reply-reader-body'), byId('pet-read-reply') as HTMLButtonElement,
      byId('pet-reply-reader-close') as HTMLButtonElement, byId('pet-reply-reader-status'), () => {
        if (this.replyReader?.opened) { actions.closeUserProfile?.(); actions.closeSystemAudioPanel?.(); byId('notice-detail-panel').hidden=true; actions.edit(false); this.setWindowAdjusting(false); }
        this.syncInteractionBlock();
      });
    byId('pet-always-on-top').onclick = () => actions.toggleAlwaysOnTop?.();
    byId('pet-toolbar-toggle').onclick = () => this.setToolbarCollapsed(!this.toolbarCollapsed);
    this.setToolbarCollapsed(false);
    byId('pet-size-toggle').onclick = () => this.setWindowAdjusting(!this.windowAdjusting);
    byId('pet-window-done').onclick = () => this.setWindowAdjusting(false);
    byId('pet-camera-edit').onclick = () => { this.setWindowAdjusting(false); actions.edit(); };
    for (const [id, feature] of [['pet-voice-input','voiceInput'],['pet-screen-sharing','screenSharing']] as const)
      byId(id).onclick = () => actions.feature(feature);
    byId('pet-camera-sharing').onclick = () => this.cameraPanel.toggle(); // I-036: expands the two camera switches
    (byId('pet-watch-together') as HTMLButtonElement).disabled = !actions.watchTogether || !actions.systemAudio;
    byId('pet-watch-together').onclick = () => actions.watchTogether?.();
    (byId('pet-system-audio-sharing') as HTMLButtonElement).disabled = !actions.systemAudio;
    byId('pet-system-audio-sharing').onclick = () => {
      if (byId('pet-system-audio-sharing').getAttribute('aria-expanded') !== 'true') {
        actions.closeUserProfile?.();
        byId('notice-detail-panel').hidden=true;
        const reader=byId('pet-reply-reader') as HTMLDialogElement;
        if (reader.open) reader.close();
      }
      actions.systemAudio?.();
    };
    byId('user-profile-toggle').onclick = () => {
      if (byId('user-profile-toggle').getAttribute('aria-expanded') !== 'true') {
        actions.closeSystemAudioPanel?.(); byId('notice-detail-panel').hidden=true;
        const reader=byId('pet-reply-reader') as HTMLDialogElement; if (reader.open) reader.close();
      }
      actions.toggleUserProfile?.();
    };
    byId('notice-details').addEventListener('click', this.openNoticeDetails);
    byId('pet-developer-mode').onclick = () => actions.developerMode?.();
    byId('chat-form').onsubmit = event => { event.preventDefault(); actions.send(); };
    byId('chat-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); actions.send(); } };
    byId('stop-chat').onclick = () => actions.stop();
    for (const button of document.querySelectorAll<HTMLButtonElement>('#pet-toolbar > button, .pet-resize-handle')) {
      button.dataset.tooltip = button.title;
      button.removeAttribute('title');
      button.addEventListener('pointerenter', () => this.showTooltip(button));
      button.addEventListener('pointerleave', () => this.hideTooltip());
      button.addEventListener('focus', () => this.showTooltip(button));
      button.addEventListener('blur', () => this.hideTooltip());
      button.addEventListener('pointerdown', () => this.hideTooltip());
    }
    this.operationHandles.set(this.dragHandle, 'move');
    for (const corner of ['nw', 'ne', 'sw', 'se'] as const) this.operationHandles.set(byId(`pet-resize-${corner}`), corner);
    for (const handle of this.operationHandles.keys()) {
      handle.addEventListener('pointerdown', this.down);
      handle.addEventListener('pointerup', this.end);
      handle.addEventListener('pointercancel', this.end);
      handle.addEventListener('lostpointercapture', this.end);
    }
    window.addEventListener('blur', this.blur);
    window.addEventListener('focus', this.windowFocus);
    window.addEventListener('keydown', this.keydown);
    window.addEventListener('resize', this.resize);
    this.resize();
  }
  applySettings(settings: AppSettings): void {
    const pin = document.getElementById('pet-always-on-top') as HTMLButtonElement;
    pin.disabled = this.alwaysOnTopPending || !this.actions.toggleAlwaysOnTop;
    pin.setAttribute('aria-pressed', String(settings.pet.alwaysOnTop));
    pin.dataset.tooltip = uiTemplate`始终置顶：${settings.pet.alwaysOnTop ? uiText('已开启，点击关闭') : uiText('已关闭，点击开启')}`;
    if (pin.matches(':hover, :focus-visible')) this.showTooltip(pin);
    // Click-through keeps the toolbar usable (the resize corners are visible controls), so only hiding ends an adjustment.
    if (!settings.pet.visible) this.setWindowAdjusting(false);
    this.positionAnswer();
  }
  setAlwaysOnTopPending(pending: boolean): void {
    this.alwaysOnTopPending = pending;
    const pin = document.getElementById('pet-always-on-top') as HTMLButtonElement;
    pin.disabled = pending || !this.actions.toggleAlwaysOnTop;
  }
  /**
   * Manual display preference for this window lifetime only; media and edit state stay separate. I-028: folding also closes
   * every popup the toolbar opened (the interface only: what they control goes on); unfolding opens none of them again.
   */
  private setToolbarCollapsed(collapsed: boolean): void {
    if (collapsed) { this.endDrag(); this.popups.closeAll(); }
    this.toolbarCollapsed = collapsed;
    this.toolbarNear = false;
    this.toolbar.classList.toggle('is-collapsed', collapsed);
    const button = document.getElementById('pet-toolbar-toggle')!;
    const label = collapsed ? uiText('展开工具栏') : uiText('收起工具栏');
    button.textContent = collapsed ? '<' : '>';
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', label);
    button.dataset.tooltip = label;
    this.hideTooltip();
  }
  /**
   * P4: the lowest viewport y (CSS px) where the expanded toolbar reacts to the pointer: its layout
   * bottom plus the margin at which it reveals itself. Framing keeps the model below this, so reaching
   * for her crown neither hits nor summons the toolbar. Folded or faded, the expanded rows still count.
   */
  toolbarReach(): number {
    const bottom = this.expandedToolbarBottom();
    return bottom > 0 ? bottom + HOVER_REVEAL_MARGIN : 0;
  }
  /**
   * Bottom of the expanded toolbar's layout box in viewport CSS px, also while it is folded or faded.
   * Unfolding only for the measurement happens inside one task, so it is never painted; the fade's
   * translate is not part of offsetTop.
   */
  expandedToolbarBottom(): number {
    const folded = this.toolbar.classList.contains('is-collapsed');
    if (folded) this.toolbar.classList.remove('is-collapsed');
    try {
      // offsetTop is relative to the document when the offset parent is <body> (the pet window does not scroll).
      const parent = this.toolbar.offsetParent as HTMLElement | null;
      const origin = !parent || parent === document.body ? 0 : parent.getBoundingClientRect().top + parent.clientTop;
      const bottom = origin + this.toolbar.offsetTop + this.toolbar.offsetHeight;
      return Number.isFinite(bottom) && bottom > 0 ? bottom : 0;
    } finally { if (folded) this.toolbar.classList.add('is-collapsed'); }
  }
  get windowInteractionBlocked(): boolean { return Boolean(this.windowAdjusting || this.drag || this.replyReader?.opened); }
  private syncInteractionBlock(): void {
    const blocked = this.windowInteractionBlocked;
    if (this.interactionBlocked === blocked) return;
    this.interactionBlocked = blocked;
    this.actions.onInteractionBlockChange?.(blocked);
  }
  setWindowAdjusting(enabled: boolean): void {
    this.endDrag();
    this.toolbarVisibility.contact(false);
    if (this.windowAdjusting === enabled) return;
    if (enabled) this.actions.edit(false);
    this.windowAdjusting = enabled;
    document.body.classList.toggle('window-adjusting', enabled);
    const button = document.getElementById('pet-size-toggle')!;
    button.setAttribute('aria-pressed', String(enabled));
    button.dataset.tooltip = enabled ? uiText('完成窗口调整（Esc）') : uiText('进入窗口调整模式');
    this.toolbarVisibility.hold(enabled);
    this.hideTooltip(); this.syncInteractionBlock();
  }
  applyRuntime(state: RuntimeState): void {
    for (const [id, feature, title] of [['pet-voice-input','voiceInput',uiText('语音输入')],['pet-screen-sharing','screenSharing',uiText('屏幕共享')],['pet-camera-sharing','cameraSharing',uiText('摄像头共享')]] as const) {
      const button = document.getElementById(id)!;
      button.setAttribute('aria-pressed', String(state[feature]));
      button.dataset.tooltip = feature === 'cameraSharing' ? `${title}：${cameraWords(state)}`
        : feature === 'voiceInput' ? `${title}：${state[feature] ? uiText('已开启，按住 T 说话；点击关闭') : uiText('已关闭，点击开启（开启后按住 T 说话）')}` // hold T to talk (2026-11-07)
        : `${title}：${state[feature] ? uiText('已开启，点击关闭') : uiText('已关闭，点击开启')}`;
      if (button.matches(':hover, :focus-visible')) this.showTooltip(button);
    }
    this.cameraPanel.update(state);
    this.screenSharingOn = state.screenSharing === true; this.renderWatchTogether();
    this.runtimeIndicators = [state.voiceInput ? uiText('语音输入') : '', state.screenSharing ? uiText('屏幕共享') : '', state.cameraSharing ? uiText('摄像头共享') : ''].filter(Boolean);
    this.renderMediaIndicators();
  }
  setSystemAudioState(state: SystemAudioState, status?: string): void {
    this.systemAudioActive = state.active;
    if (status !== undefined) this.systemAudioStatus = status;
    else if (!state.active) this.systemAudioStatus = '';
    const button = document.getElementById('pet-system-audio-sharing')!;
    button.setAttribute('aria-pressed', String(state.active || this.audioDanceActive));
    button.dataset.tooltip = state.active || this.audioDanceActive
      ? uiText('和她一起听：开着，点击可以关掉')
      : this.systemAudioStatus || this.audioDanceStatus ? uiText('和她一起听：正在连接') : uiText('和她一起听：点击打开');
    if (button.matches(':hover, :focus-visible')) this.showTooltip(button);
    this.renderMediaIndicators();
    this.renderWatchTogether();
  }
  /** 和她一起看 is on while both 「和她一起听」 and screen sharing are. */
  private renderWatchTogether(): void {
    const button = document.getElementById('pet-watch-together'); if (!button) return;
    const on = this.screenSharingOn && (this.systemAudioActive || this.audioDanceActive);
    button.setAttribute('aria-pressed', String(on));
    button.dataset.tooltip = on ? uiText('和她一起看：开着（一起听和屏幕共享），点击都关掉') : uiText('和她一起看：点击同时打开「和她一起听」和屏幕共享');
    if (button.matches(':hover, :focus-visible')) this.showTooltip(button);
  }
  setAudioDanceState(active: boolean, status: string): void {
    this.audioDanceActive = active; this.audioDanceStatus = status; this.renderWatchTogether();
    this.setSystemAudioState({ active: this.systemAudioActive }, this.systemAudioStatus);
  }
  setSystemAudioExpanded(expanded: boolean): void {
    document.getElementById('pet-system-audio-sharing')!.setAttribute('aria-expanded', String(expanded));
  }
  private renderMediaIndicators(): void {
    const active = [...this.runtimeIndicators];
    if (this.systemAudioActive || this.systemAudioStatus)
      active.push(this.systemAudioStatus || uiText('系统声音采集 · 当前已选用途'));
    if (this.audioDanceStatus) active.push(this.audioDanceStatus);
    const indicator = document.getElementById('pet-media-indicator')!;
    indicator.textContent = active.join(' · '); indicator.classList.toggle('hidden', !active.length);
  }
  setEditing(enabled: boolean): void {
    this.endDrag();
    this.toolbarVisibility.contact(false);
    if (enabled) this.setWindowAdjusting(false);
    document.body.classList.toggle('camera-editing', enabled);
    document.getElementById('pet-camera-edit')!.setAttribute('aria-pressed', String(enabled));
    document.getElementById('pet-camera-edit')!.dataset.tooltip = enabled ? uiText('完成镜头调整（Esc）') : uiText('进入镜头调整模式');
    document.getElementById('pet-edit-help')!.classList.toggle('hidden', !enabled);
  }
  setHostVisible(visible: boolean): void { if (!visible) { this.actions.closeUserProfile?.(); this.hideAnswer(); this.setWindowAdjusting(false); this.resetHover(); } }
  setDeveloperMode(enabled: boolean): void {
    document.body.classList.toggle('developer-mode', enabled);
    const button = document.getElementById('pet-developer-mode')!;
    button.setAttribute('aria-pressed', String(enabled));
    button.dataset.tooltip = uiTemplate`开发者模式：${enabled ? uiText('已开启，点击关闭') : uiText('已关闭，点击开启')}`;
  }
  setInteraction(active: boolean): void {
    if (this.interacting === active) return;
    this.interacting = active;
    document.body.classList.toggle('pet-interacting', active);
    this.hideTooltip();
    this.toolbarVisibility?.contact(active);
    this.setInteractionProgress(active ? 1 : 0);
  }
  setInteractionProgress(value: number): void {
    if (!Number.isFinite(value)) return;
    const progress = Math.max(0, Math.min(1, value));
    if (this.interactionProgress === progress) return;
    this.interactionProgress = progress;
    if (this.replyState === 'hidden') return;
    if (Date.now() >= this.replyExpiresAt) {
      this.replyState = 'hidden'; this.publishReply({ state: 'hidden' }); return;
    }
    // This is paint only. Re-sending complete/text would restart the host TTL.
    this.publishReply({ interactionOpacity: 1 - progress });
  }
  setFaceAnchor(point: PetReplyAnchor): void {
    const wasInSight = this.faceInSight();
    this.anchor = point;
    if (this.replyState === 'complete' && wasInSight !== this.faceInSight()) this.followSight();
    this.positionAnswer();
  }
  /** Her face is on screen, as the stage last reported it (an anchor missing altogether counts as on screen). */
  private faceInSight(): boolean { return this.anchor?.visible !== false; }
  /** Her face left or came back: a completed reply's countdown waits, or goes on from what was left (Codex T-207 round 2). */
  private followSight(): void {
    const now = Date.now();
    if (this.faceInSight()) {
      if (this.replyPausedLeft !== undefined) { this.replyExpiresAt = now + this.replyPausedLeft; this.replyPausedLeft = undefined; }
    } else if (Number.isFinite(this.replyExpiresAt) && now < this.replyExpiresAt) {
      this.replyPausedLeft = this.replyExpiresAt - now; this.replyExpiresAt = Infinity;
    }
  }
  /** A completed reply stays `left` ms from `from` while her face is on screen; off screen the time waits (followSight). */
  private replyDeadline(from: number, left: number): void {
    if (this.faceInSight()) { this.replyExpiresAt = from + left; this.replyPausedLeft = undefined; }
    else { this.replyExpiresAt = Infinity; this.replyPausedLeft = left; }
  }
  beginAnswer(id: string): void { if (!this.replySpeech.matches(id)) { this.replyReader?.clear(); this.replyPreviewText = undefined; } this.replySpeech.begin(id); }
  /** Explicit reader access after restore does not replay the native bubble. */
  refreshAnswerReader(text: string, streaming: boolean): void { this.replyReader?.update(text, streaming); }
  showWaiting(id: string): HTMLElement {
    this.replyReader?.clear();
    this.replyPreviewText = undefined;
    this.replySpeech.begin(id);
    this.replyStreaming = true;
    this.replyState = 'waiting';
    this.replyExpiresAt = Infinity;
    const body = document.getElementById('pet-answer-body')!;
    body.classList.remove('message-error');
    body.textContent = '';
    this.publishReply({ text: '', state: 'waiting', anchor: this.anchor });
    return body;
  }
  endAnswerSpeech(id: string): void {
    const wasPending = this.replySpeech.pending;
    if (!this.replySpeech.end(id) || !wasPending || this.replyState === 'hidden' || this.replyStreaming) return;
    this.replyState = 'complete';
    this.replyDeadline(Date.now(), replyLingerLongestMs());
    // End notifications can release a visible reply; they never restore hidden text.
    this.publishReply({ state: 'complete' });
  }
  /** `sentenceEnds` opts an ordinary streamed chat reply into R27 bubble pieces. */
  showAnswer(text: string, streaming = false, replyId?: string, segmented = false, sentenceEnds?: readonly number[]): HTMLElement {
    const sameReply = !!replyId && this.replySpeech.matches(replyId);
    if (!sameReply) { this.replyReader?.clear(); this.replyPreviewText = undefined; this.piecesReplyId = undefined; }
    if (replyId) this.replySpeech.begin(replyId); else this.replySpeech.clear();
    this.replyStreaming = streaming;
    const body = document.getElementById('pet-answer-body')!;
    const previousText = sameReply ? body.textContent ?? '' : '';
    body.classList.remove('message-error');
    body.textContent = text;
    this.replyReader?.update(text, streaming);
    if (!text.trim()) {
      this.replyState = 'hidden'; this.replyExpiresAt = 0;
      this.publishReply({ state: 'hidden' });
    }
    else {
      // The native window keeps streaming/pending playback open without a deadline.
      const retained = streaming || this.replySpeech.pending;
      this.replyState = retained ? 'streaming' : 'complete';
      if (retained) this.replyExpiresAt = Infinity; else this.replyDeadline(Date.now(), replyLingerLongestMs());
      // Ordinary chat has a full local reader; its preview follows new sentences.
      // Proactive sources stay literal, preserving the exact host display proof.
      let displayText = segmented ? formatReplyBubbles(text) : text;
      if (segmented && displayText.length > 32000) {
        if (text === previousText && this.replyPreviewText) displayText = this.replyPreviewText;
        else if (previousText.trim()) {
          const prefix = uiText('…（可在工具栏查看完整回复）\n');
          displayText = displayText.slice(-(32000 - prefix.length));
          if (/^[\uDC00-\uDFFF]/.test(displayText)) displayText = displayText.slice(1);
          displayText = prefix + displayText;
        } else {
          const suffix = uiText('\n…（后续内容可在工具栏查看完整回复）');
          displayText = displayText.slice(0, 32000 - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix;
        }
      }
      // Where the raw text's kept tail starts in the preview (0 when the whole raw text is shown).
      let cut = 0, shift = 0;
      if (!segmented && displayText.length > 32000) {
        // Raw streamed previews keep following the newest visible sentence;
        // the full original remains in the independent reply reader.
        const prefix = uiText('…（可在工具栏查看完整回复）\n');
        cut = displayText.length - (32000 - prefix.length);
        if (/^[\uDC00-\uDFFF]/.test(displayText[cut])) cut++;
        displayText = prefix + displayText.slice(cut);
        shift = prefix.length - cut;
      }
      this.replyPreviewText = displayText;
      if (!segmented && replyId && sentenceEnds) this.piecesReplyId = replyId;
      // Pieces are offsets into the exact raw text, or (Codex T-207 2D) into the bounded preview of a very long reply: its
      // kept sentences keep their own R27 bubbles there, the cut-off start and the note above it form the first one. A
      // formatted (proactive) preview has none.
      const pieces = !segmented && replyId && replyId === this.piecesReplyId && (displayText === text || cut > 0)
        ? replyPieces(displayText, cut > 0 ? sentenceEnds?.filter(end => end > cut).map(end => end + shift) : sentenceEnds,
          this.bubblePolicy ?? REPLY_BUBBLE_POLICY) : null;
      this.publishReply({ text: displayText.slice(0, 32000), state: this.replyState, anchor: this.anchor, segmented, ...(pieces ? { pieces } : {}) });
    }
    return body;
  }
  /** State only: never reveal an unread body or restart an already ended reply. */
  expectAnswerSpeech(id:string):void {
    if(!this.replySpeech.matches(id)||this.replyState==='hidden')return;
    this.replySpeech.expect(id);
    if(this.replySpeech.pending){this.replyState='streaming';this.replyExpiresAt=Infinity;this.publishReply({state:'streaming',anchor:this.anchor});}
  }
  finishAnswer(text = document.getElementById('pet-answer-body')?.textContent ?? '', replyId?: string, expectsSpeech = false, preservePresentation = false, segmented = false): void {
    const retain = preservePresentation && typeof replyId === 'string' && this.replySpeech.matches(replyId)
      && document.getElementById('pet-answer-body')?.textContent === text && this.replyState !== 'hidden';
    if (replyId) {
      this.replySpeech.begin(replyId);
      if (expectsSpeech) this.replySpeech.expect(replyId);
    }
    if (retain) {
      // The exact body has already received a display receipt. Re-publishing
      // even identical text would invalidate that presentation identity.
      this.replyStreaming = false;
      this.replyState = this.replySpeech.pending ? 'streaming' : 'complete';
      if (this.replySpeech.pending) this.replyExpiresAt = Infinity; else this.replyDeadline(Date.now(), replyLingerLongestMs());
      this.publishReply({ state: this.replyState, anchor: this.anchor });
      this.replyReader?.update(text, false);
      return;
    }
    this.showAnswer(text, false, replyId, segmented);
  }
  hideAnswer(): void {
    this.replyReader?.clear();
    this.replyPreviewText = undefined; this.piecesReplyId = undefined;
    this.replySpeech.clear(); this.replyStreaming = false;
    this.replyState = 'hidden'; this.replyExpiresAt = 0;
    this.publishReply({ state: 'hidden' });
  }
  hideAnswerFor(id: string): void { if (this.replySpeech.matches(id)) this.hideAnswer(); }
  private showTooltip(button: HTMLElement): void {
    const tip = document.getElementById('pet-tooltip')!;
    tip.textContent = button.dataset.tooltip ?? button.getAttribute('aria-label');
    tip.classList.remove('hidden');
    const rect = button.getBoundingClientRect();
    const top = rect.bottom + tip.offsetHeight + 14 <= window.innerHeight ? rect.bottom + 8 : rect.top - tip.offsetHeight - 8;
    tip.style.top = `${Math.max(6, top)}px`;
    tip.style.left = `${Math.max(6, Math.min(window.innerWidth - tip.offsetWidth - 6, rect.left + rect.width / 2 - tip.offsetWidth / 2))}px`;
    document.querySelectorAll('[aria-describedby="pet-tooltip"]').forEach(element => element.removeAttribute('aria-describedby'));
    button.setAttribute('aria-describedby', 'pet-tooltip');
  }
  private hideTooltip(): void {
    document.getElementById('pet-tooltip')!.classList.add('hidden');
    document.querySelectorAll('[aria-describedby="pet-tooltip"]').forEach(element => element.removeAttribute('aria-describedby'));
  }
  private resetHover(): void {
    this.toolbarNear = this.chatNear = false;
    this.toolbarVisibility.reset(); this.chatVisibility.reset(); this.hideTooltip();
  }
  private positionAnswer(): void {
    if (this.replyState === 'hidden') return;
    if (Date.now() >= this.replyExpiresAt) { this.replyState = 'hidden'; this.publishReply({ state: 'hidden' }); return; }
    this.publishReply({ anchor: this.anchor });
  }
  /** Wait only for the latest already-invoked content/state update, not ongoing anchor traffic. */
  flushReplyPublication(): Promise<void> { return this.replyPublication.then(() => undefined); }
  private publishReply(update: PetReplyUpdate): void {
    const patch = update.state === 'hidden' || this.interactionProgress === 0
      ? update : { ...update, interactionOpacity: 1 - this.interactionProgress };
    const sentAt = Date.now(), publication = window.desktop.updatePetReply(patch);
    if (patch.text !== undefined || patch.state !== undefined) this.replyPublication = publication;
    // #5: the host's answer to a 'complete' is this reply's lifetime, counted from when it was sent (the host starts its
    // timer a moment later, so this window never outlasts it). Any later state change makes an answer still on its way stale.
    if (patch.state !== undefined) {
      const ask = ++this.replyLingerAsk;
      if (patch.state === 'complete') void publication.then(answer => {
        const ms = readReplyLingerAnswer(answer);
        if (ms !== null && ask === this.replyLingerAsk && this.replyState === 'complete') this.replyDeadline(sentAt, ms);
      }, () => {});
    } else if (this.replyState === 'complete') {
      // Codex T-207 2C: the host counts only while the bubble can be seen, and answers a position or fade update with how
      // long the reply still stays from then; this window follows it, so it never hides a bubble the host still owes time.
      const ask = this.replyLingerAsk;
      void publication.then(answer => {
        const ms = readReplyLingerLeft(answer);
        if (ms !== null && ask === this.replyLingerAsk && this.replyState === 'complete') this.replyDeadline(sentAt, ms);
      }, () => {});
    }
    void publication.catch(error => this.actions.error(String(error)));
  }
  private readonly down = (event: PointerEvent) => {
    const handle = event.currentTarget as HTMLElement;
    const operation = this.operationHandles.get(handle);
    if (event.button !== 0 || event.isPrimary === false || this.drag || !operation || (operation !== 'move' && !this.windowAdjusting)) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    const pointer = this.drag = { id: event.pointerId, handle };
    this.toolbarVisibility.hold(true);
    handle.classList.add('dragging');
    this.hideTooltip(); this.syncInteractionBlock();
    handle.setPointerCapture(event.pointerId);
    void window.desktop.setPetWindowOperation(operation).catch(error => {
      if (this.drag === pointer) this.endDrag();
      this.actions.error(String(error));
    });
  };
  private readonly end = (event: PointerEvent) => { if (this.drag?.id === event.pointerId) this.endDrag(); };
  private endDrag(): void {
    const pointer = this.drag; this.drag = null;
    if (!pointer) return;
    this.toolbarVisibility.hold(this.windowAdjusting);
    pointer.handle.classList.remove('dragging');
    this.syncInteractionBlock();
    void window.desktop.setPetWindowOperation(null).catch(error => this.actions.error(String(error)));
    if (pointer.handle.hasPointerCapture(pointer.id)) pointer.handle.releasePointerCapture(pointer.id);
  }
  dispose(): void {
    document.getElementById('notice-details')?.removeEventListener('click', this.openNoticeDetails);
    document.body.classList.remove('developer-mode');
    this.replyReader?.dispose();
    this.cameraPanel.dispose();
    this.hideAnswer();
    this.setWindowAdjusting(false);
    this.resetHover();
    document.documentElement.removeEventListener('pointerenter', this.hoverMove);
    document.documentElement.removeEventListener('pointerleave', this.leave);
    document.documentElement.removeEventListener('pointermove', this.hoverMove);
    this.toolbar.removeEventListener('focusin', this.focus); this.toolbar.removeEventListener('focusout', this.unfocus);
    this.chat.removeEventListener('focusin', this.chatFocus); this.chat.removeEventListener('focusout', this.chatUnfocus);
    for (const handle of this.operationHandles.keys()) {
      handle.removeEventListener('pointerdown', this.down);
      handle.removeEventListener('pointerup', this.end); handle.removeEventListener('pointercancel', this.end); handle.removeEventListener('lostpointercapture', this.end);
    }
    this.operationHandles.clear();
    window.removeEventListener('blur', this.blur);
    window.removeEventListener('focus', this.windowFocus);
    window.removeEventListener('keydown', this.keydown);
    window.removeEventListener('resize', this.resize);
  }
}
