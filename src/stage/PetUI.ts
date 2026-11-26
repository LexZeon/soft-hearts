import { uiText, uiHtml, uiMarkup, uiTemplate } from '../foundation/ui-language';
import type { AppSettings } from '../../shared/foundation/settings';
import type { PetReplyAnchor, PetReplyUpdate } from '../../shared/foundation/pet-reply';
import type { RuntimePatch, RuntimeState, SystemAudioState } from '../../shared/foundation/runtime-state';
import type { PetWindowOperation } from '../../shared/stage/desktop-api';
import { icon } from '../foundation/icons';
import { HoverVisibility, nearHoverZone } from './HoverVisibility';
import { CompanionToolbar } from './companion-toolbar';
import type { ToolbarSourcePorts } from './toolbar-sources';
import { ReplySpeechState } from '../voice';
import { ReplyReader } from '../brain';
import { formatReplyBubbles } from '../brain';
import { REPLY_BUBBLE_POLICY, replyPieces, type ReplyBubblePolicy } from '../../shared/voice';
import { replyAnchorOf } from '../../shared/brain/reply-anchor';
import { readReplyLingerAnswer, readReplyLingerLeft, replyLingerLongestMs } from '../../shared/brain';
import { ReplyVoiceCap } from './reply-voice-cap';
import { PetPopups, type PetPopupHandle, type PetPopupKey } from './pet-popups';
import { CameraSharingPanel } from '../senses';
import { mountFaceCheckLight } from '../senses';
import { WatchTogetherButton } from './watch-together-button';

/** I-028: the toolbar's popups whose panels are made outside PetUI (src/main.ts); PetUI wires the other five itself. */
export type PetHostedPopupKey = Exclude<PetPopupKey, 'system-audio' | 'user-profile' | 'reply-reader' | 'notice-detail' | 'camera-sharing' | 'source-menu'>;

interface PetActions {
  edit(enabled?: boolean): void;
  onInteractionBlockChange?(blocked: boolean): void;
  /** A switch; the promise (when given) settles once the host answered, and the button shows it is busy until then. */
  feature(feature: keyof RuntimePatch): unknown;
  /** I-187 和她一起看: the screen and the dialogue, one switch. */
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
  /** I-028: folding the toolbar closes these too (src/stage/pet-popups.ts). */
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
      <button id="pet-voice-input" title="语音输入：关闭" aria-label="语音输入" aria-pressed="false">${icon('mic')}</button><button id="pet-voice-input-sources" class="pet-source-caret" type="button" title="选麦克风" aria-label="选麦克风" aria-haspopup="menu" aria-expanded="false">▾</button><!-- no-pet-ok: element ids -->
      <button id="pet-screen-sharing" title="屏幕共享：关闭" aria-label="屏幕共享" aria-pressed="false">${icon('screen')}</button><button id="pet-screen-sharing-sources" class="pet-source-caret" type="button" title="选屏幕或窗口" aria-label="选屏幕或窗口" aria-haspopup="menu" aria-expanded="false">▾</button><!-- no-pet-ok: element ids -->
      <button id="pet-watch-together" title="和她一起看" aria-label="和她一起看" aria-pressed="false">${icon('eye')}</button>
      <button id="pet-camera-sharing" title="摄像头共享：关闭" aria-label="摄像头共享" aria-pressed="false">${icon('camera')}<span class="pet-panel-chevron" aria-hidden="true">▾</span></button>
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
    <output id="pet-voice-state" class="pet-voice-state hidden" role="status"></output><div id="messages" class="hidden"></div><div id="pet-empty">还没有载入模型<br /><small>点击设置，选择你的 PMX / PMD / VRM</small></div><div id="pet-status" class="pet-caption"></div><div id="toast" class="toast" role="status"></div><section id="notice-detail-panel" class="notice-detail-panel" data-mood-ui aria-label="问题详情" hidden><strong>问题详情</strong><button id="notice-detail-close" type="button">关闭</button><pre id="notice-detail-text"></pre></section>`;
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
  /** Ordinary chat reply whose native bubble uses R27 pieces (see shared/voice/reply-bubbles.ts). */
  private piecesReplyId?: string;
  /** Tests only. The product switch is REPLY_BUBBLE_POLICY in shared/voice/reply-bubbles.ts. */
  bubblePolicy?: ReplyBubblePolicy;
  /** I-165: the bubble follows her voice (src/stage/reply-voice-cap.ts); `held`: it shows "……" for a reply whose text waits for her voice. */
  private voiceCapState?: ReplyVoiceCap;
  private get voiceCap(): ReplyVoiceCap { return this.voiceCapState ??= new ReplyVoiceCap(); }
  private voiceShown?: { id: string; text: string; segmented: boolean; sentenceEnds?: readonly number[] };
  private held = false;
  private interacting = false;
  private interactionProgress = 0;
  private drag: { id: number; handle: HTMLElement } | null = null;
  private windowAdjusting = false;
  private interactionBlocked = false;
  /** I-187: the eye button; the page gives it the 读取音频 view and reads its look. */
  readonly watchButton = new WatchTogetherButton(() => document.getElementById('pet-watch-together'), button => this.bar.showTooltip(button));
  private readonly dragHandle = document.getElementById('pet-move-window')!;
  private readonly operationHandles = new Map<HTMLElement, PetWindowOperation>();
  private readonly chat = document.querySelector<HTMLElement>('.pet-chat')!;
  /** The toolbar: how it shows, its tooltip and every button's look (src/stage/companion-toolbar.ts). */
  readonly bar: CompanionToolbar;
  private readonly chatVisibility: HoverVisibility;
  /** I-028: every popup the toolbar opens, in one place (src/stage/pet-popups.ts). */
  private readonly popups: PetPopups;
  /** I-036: the camera button expands 「发图片」 and 「姿势识别」 (src/senses/CameraSharingPanel.ts). */
  private readonly cameraPanel: CameraSharingPanel;
  private chatNear = false;
  private readonly leave = () => {
    this.chatNear = false;
    this.bar.leave(); this.chatVisibility.leave();
  };
  private readonly hoverMove = (event: PointerEvent) => {
    const inside = event.clientX >= 0 && event.clientY >= 0 && event.clientX < window.innerWidth && event.clientY < window.innerHeight;
    this.bar.pointer(event.clientX, event.clientY, inside);
    this.chatNear = inside && nearHoverZone(this.chat.getBoundingClientRect(), event.clientX, event.clientY, this.chatNear);
    if (this.chatNear) this.chatVisibility.enter(); else this.chatVisibility.leave();
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
  private readonly resize = () => { document.getElementById('pet-window-size')!.textContent = uiTemplate`窗口 ${window.innerWidth} × ${window.innerHeight}`; this.leave(); this.bar.hideTooltip(); this.positionAnswer(); };
  constructor(private readonly actions: PetActions) {
    const byId = (id: string) => document.getElementById(id)!;
    this.bar = new CompanionToolbar({ beforeFold: () => { this.endDrag(); this.popups.closeAll(); }, error: message => actions.error(message) });
    this.chatVisibility = new HoverVisibility(visible => this.chat.classList.toggle('is-visible', visible));
    document.documentElement.addEventListener('pointerenter', this.hoverMove);
    document.documentElement.addEventListener('pointerleave', this.leave);
    document.documentElement.addEventListener('pointermove', this.hoverMove);
    this.chat.addEventListener('focusin', this.chatFocus); this.chat.addEventListener('focusout', this.chatUnfocus);
    byId('open-controls').onclick = () => void window.desktop.openControls();
    // I-135: the small light while the camera is used to recognise whether it is you (only the view's `active` is read).
    if (typeof window.desktop.getFaceCheck === 'function') mountFaceCheckLight(byId('stage').parentElement ?? document.body, { get: () => window.desktop.getFaceCheck(), changed: callback => window.desktop.onFaceCheck(callback) });
    const expanded = (id: string) => byId(id).getAttribute('aria-expanded') === 'true';
    const readerDialog = byId('pet-reply-reader') as HTMLDialogElement, noticePanel = byId('notice-detail-panel');
    this.cameraPanel = new CameraSharingPanel(byId('pet-camera-panel'), byId('pet-camera-sharing'), {
      set: patch => actions.camera ? actions.camera(patch) : Promise.reject(Error(uiText('这个窗口还不能开关摄像头。'))),
      explain: reply => actions.explainRuntime?.(reply), error: message => actions.error(message),
      sources: host => this.bar.sources.mountCamera(host), // I-190: which camera, in the camera panel
    });
    this.popups = new PetPopups({
      'camera-sharing': { isOpen: () => this.cameraPanel.isOpen, close: () => this.cameraPanel.close() },
      'source-menu': { isOpen: () => this.bar.sources.isOpen, close: () => this.bar.sources.close() }, // I-190
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
    byId('pet-size-toggle').onclick = () => this.setWindowAdjusting(!this.windowAdjusting);
    byId('pet-window-done').onclick = () => this.setWindowAdjusting(false);
    byId('pet-camera-edit').onclick = () => { this.setWindowAdjusting(false); actions.edit(); };
    for (const [id, feature] of [['pet-voice-input','voiceInput'],['pet-screen-sharing','screenSharing']] as const)
      byId(id).onclick = () => this.bar.track(feature, actions.feature(feature));
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
    this.bar.setPin(settings.pet.alwaysOnTop, !!this.actions.toggleAlwaysOnTop);
    // Click-through keeps the toolbar usable (the resize corners are visible controls), so only hiding ends an adjustment.
    if (!settings.pet.visible) this.setWindowAdjusting(false);
    this.positionAnswer();
  }
  setAlwaysOnTopPending(pending: boolean): void { this.bar.setPinPending(pending); }
  /** I-190: the source lists arrived (src/wiring/sources-wiring.ts): the ▾ menus work. */
  setSources(ports: ToolbarSourcePorts): void { this.bar.setSources(ports); }
  /** P4: the toolbar's reach for framing (src/stage/companion-toolbar.ts reach). */
  toolbarReach(): number { return this.bar.reach(); }
  expandedToolbarBottom(): number { return this.bar.expandedBottom(); }
  get windowInteractionBlocked(): boolean { return Boolean(this.windowAdjusting || this.drag || this.replyReader?.opened); }
  private syncInteractionBlock(): void {
    const blocked = this.windowInteractionBlocked;
    if (this.interactionBlocked === blocked) return;
    this.interactionBlocked = blocked;
    this.actions.onInteractionBlockChange?.(blocked);
  }
  setWindowAdjusting(enabled: boolean): void {
    this.endDrag();
    this.bar.visibility.contact(false);
    if (this.windowAdjusting === enabled) return;
    if (enabled) this.actions.edit(false);
    this.windowAdjusting = enabled;
    document.body.classList.toggle('window-adjusting', enabled);
    this.bar.setAdjusting(enabled);
    this.bar.hideTooltip(); this.syncInteractionBlock();
  }
  applyRuntime(state: RuntimeState): void {
    this.bar.applyRuntime(state);
    this.cameraPanel.update(state);
    this.watchButton.setScreen(state.screenSharing === true);
  }
  setSystemAudioState(state: SystemAudioState, status?: string): void { this.bar.setSystemAudio(state.active, status); }
  setAudioDanceState(active: boolean, status: string): void { this.bar.setDance(active, status); }
  setSystemAudioExpanded(expanded: boolean): void { this.bar.setSystemAudioExpanded(expanded); }
  setEditing(enabled: boolean): void {
    this.endDrag();
    this.bar.visibility.contact(false);
    if (enabled) this.setWindowAdjusting(false);
    document.body.classList.toggle('camera-editing', enabled);
    this.bar.setEditing(enabled);
    document.getElementById('pet-edit-help')!.classList.toggle('hidden', !enabled);
  }
  setHostVisible(visible: boolean, minimized = false): void { if (!visible) { this.actions.closeUserProfile?.(); if (!minimized) this.hideAnswer(); /* I-171: a minimize keeps her answer */ this.setWindowAdjusting(false); this.resetHover(); } }
  setDeveloperMode(enabled: boolean): void {
    document.body.classList.toggle('developer-mode', enabled);
    this.bar.setDeveloper(enabled);
  }
  setInteraction(active: boolean): void {
    if (this.interacting === active) return;
    this.interacting = active;
    document.body.classList.toggle('pet-interacting', active);
    this.bar?.hideTooltip();
    this.bar?.visibility.contact(active);
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
    // Only what the bubble host accepts: the stage's point may carry more (G1's raisedHand), and one extra key made the host
    // refuse every bubble update while her hand was up for rock-paper-scissors (shared/brain/reply-anchor.ts).
    this.anchor = replyAnchorOf(point);
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
    this.held = false;
    this.publishReply({ text: '', state: 'waiting', anchor: this.anchor });
    return body;
  }
  /**
   * I-165: how much of reply `id` her voice has reached (null: all of it, for good). The bubble shows that much ("……" before the first
   * sentence); a reply already showing text, hidden, or replaced is left as it is (never revived or hidden again).
   */
  setVoiceCap(id: string, cap: number | null): void {
    const shown = this.replySpeech.matches(id) && (this.replyState === 'streaming' || this.replyState === 'complete') && !this.held;
    if (!this.voiceCap.set(id, cap, shown)) return;
    const last = this.voiceShown;
    if (last?.id === id && this.replySpeech.matches(id) && this.replyState !== 'hidden') this.showAnswer(last.text, this.replyStreaming, id, last.segmented, last.sentenceEnds);
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
    // I-165: what her voice has reached of this reply (the whole text when it does not follow); the reader above keeps everything.
    const fullText = text, cap = this.voiceCap.limit(replyId, text);
    if (replyId && cap !== null) this.voiceShown = { id: replyId, text, segmented, sentenceEnds };
    if (cap !== null) text = text.slice(0, cap);
    if (!fullText.trim()) {
      this.replyState = 'hidden'; this.replyExpiresAt = 0;
      this.publishReply({ state: 'hidden' });
    }
    else if (!text.trim()) {
      // Nothing heard yet: "……" (she is about to speak), held without a deadline (the dots already up from showWaiting stay as they are).
      const dots = this.replyState === 'waiting';
      this.replyStreaming = streaming; this.replyState = 'waiting'; this.replyExpiresAt = Infinity;
      if (!this.held) { this.held = true; if (!dots) this.publishReply({ text: '', state: 'waiting', anchor: this.anchor }); }
    }
    else {
      this.held = false;
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
    this.replySpeech.clear(); this.replyStreaming = false; this.held = false;
    this.replyState = 'hidden'; this.replyExpiresAt = 0;
    this.publishReply({ state: 'hidden' });
  }
  hideAnswerFor(id: string): void { if (this.replySpeech.matches(id)) this.hideAnswer(); }
  private resetHover(): void {
    this.chatNear = false;
    this.bar.reset(); this.chatVisibility.reset();
  }
  private positionAnswer(): void {
    if (this.replyState === 'hidden') return;
    if (Date.now() >= this.replyExpiresAt) { this.replyState = 'hidden'; this.publishReply({ state: 'hidden' }); return; }
    this.publishReply({ anchor: this.anchor });
  }
  /** Wait only for the latest already-invoked content/state update, not ongoing anchor traffic. */
  flushReplyPublication(): Promise<void> { return this.replyPublication.then(() => undefined); }
  private publishReply(update: PetReplyUpdate): void {
    // I-165: while the bubble holds "……" for her voice, a state change without text (speech expected, readout finished) must not empty it.
    if (this.held && update.text === undefined && update.state !== undefined && update.state !== 'hidden') {
      const { state: _held, ...rest } = update;
      if (!Object.keys(rest).length) return;
      update = rest;
    }
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
    this.bar.visibility.hold(true);
    handle.classList.add('dragging');
    this.bar.hideTooltip(); this.syncInteractionBlock();
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
    this.bar.visibility.hold(this.windowAdjusting || this.bar.sources.isOpen);
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
    this.bar.dispose();
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
