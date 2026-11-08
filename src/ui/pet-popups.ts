/**
 * I-028: every floating panel the pet's toolbar opens is
 * listed here, once. Folding the toolbar closes each open one (PetUI.setToolbarCollapsed); unfolding opens none of them
 * again. Closing is the interface only: sharing, listening, reading aloud, a game of 猜拳 and every setting go on as before.
 *
 * Kept complete by structure, not by memory (tests/i028-collapse-panels.test.ts): every toolbar button is either a popup's
 * trigger below or a plain button in PET_TOOLBAR_PLAIN, every panel in the pet's markup is a popup's panel, and every source
 * file that makes floating pet UI (`data-mood-ui`, a dialog, `aria-expanded`) is named here. A new panel that is not, fails.
 */

export interface PetPopupHandle {
  /** The panel is on screen now (its own state; the toolbar's fold does not count). */
  isOpen(): boolean;
  /** Hides the panel. Never stops what it controls and never changes a setting. */
  close(): void;
}

interface PetPopupEntry {
  /** What the user sees, in their words. */
  readonly what: string;
  /** Toolbar buttons (ids in renderPet) that bring it up. */
  readonly triggers: readonly string[];
  /** The element that is hidden or shown (a selector in the pet window; a leading #id is what the trigger's aria-controls names). */
  readonly panel: string;
  /** Source files that make or manage it (checked against the files that make floating pet UI). */
  readonly sources: readonly string[];
}

export const PET_POPUPS = {
  'system-audio': { what: '读取本机音频的控制（和她一起听）', triggers: ['pet-system-audio-sharing'], panel: '#ambient-audio-controls .ambient-audio-panel',
    sources: ['src/ui/AudioReadingClient.ts', 'src/ui/ListenTogetherSwitch.ts'] },
  'user-profile': { what: '用户画像', triggers: ['user-profile-toggle'], panel: '#user-profile-panel',
    sources: ['src/ui/UserProfilePanel.ts', 'src/ui/PetUI.ts'] },
  'reply-reader': { what: '回复全文', triggers: ['pet-read-reply'], panel: '#pet-reply-reader', sources: ['src/ui/ReplyReader.ts', 'src/ui/PetUI.ts'] },
  'notice-detail': { what: '问题详情', triggers: ['notice-details'], panel: '#notice-detail-panel', sources: ['src/ui/ImmersiveNotice.ts', 'src/ui/PetUI.ts'] },
  // Shows while screen or camera sharing is on; closed, it shows again the next time sharing starts.
  'screen-sharing-options': { what: '屏幕共享选项', triggers: ['pet-screen-sharing'], panel: '.pet-sharing-options .screen-sharing-options',
    sources: ['src/ui/ScreenSharingOptions.ts', 'src/main.ts'] },
  // I-036: the camera button expands the two camera switches, 「发图片」 and 「姿势识别」.
  'camera-sharing': { what: '摄像头共享的两个开关（发图片 / 姿势识别）', triggers: ['pet-camera-sharing'], panel: '#pet-camera-panel',
    sources: ['src/ui/CameraSharingPanel.ts', 'src/ui/PetUI.ts'] },
  // Shows while developer mode is on; closed, it shows again the next time developer mode is turned on.
  'mood-companion': { what: '开发者模式的心情小面板', triggers: ['pet-developer-mode'], panel: 'aside.mood-companion',
    sources: ['src/ui/MoodCompanion.ts', 'src/ui/MoodPanel.ts', 'src/ui/ExpressionPreviewButtons.ts'] },
} as const satisfies Record<string, PetPopupEntry>;

export type PetPopupKey = keyof typeof PET_POPUPS;
export const PET_POPUP_KEYS = Object.keys(PET_POPUPS) as PetPopupKey[];

/** Toolbar buttons that open no panel in the pet window, and why. */
export const PET_TOOLBAR_PLAIN: Readonly<Record<string, string>> = {
  'pet-move-window': '按住拖动窗口',
  'pet-always-on-top': '始终置顶：一个设置',
  'pet-size-toggle': '窗口调整模式：一种模式，有自己的"完成"，收起工具栏不打断它',
  'pet-camera-edit': '镜头调整模式：同上',
  'pet-voice-input': '语音输入开关',
  'pet-watch-together': '和她一起看：一个开关，同时开关「和她一起听」和屏幕共享',
  'open-controls': '打开控制窗口：另一个窗口，不是桌宠身边的浮窗',
  'pet-toolbar-toggle': '收起 / 展开工具栏本身',
};

/** Floating UI in the pet window that the toolbar does not open, so folding it leaves them alone. */
export const PET_FLOATING_NOT_POPUPS: Readonly<Record<string, { what: string; why: string; sources: readonly string[] }>> = {
  rps: { what: '猜拳', why: '一局猜拳是正在进行的事，收起工具栏不打断', sources: ['src/ui/RpsOverlay.ts'] },
  chat: { what: '聊天框里的内容：你发的话、她的提议、要你选的选项', why: '是对话的一部分，等你回答或自己淡出，不从工具栏打开',
    sources: ['src/ui/ProactiveAgentOffer.ts', 'src/main.ts'] },
  // 屏幕只读大概 (2026-11-04): her "要我凑近看看吗" as a prompt in the pet's chat.
  'look-offer': { what: '"让她看清楚屏幕吗？"（看吧 / 不用）', why: '是她在对话里问你的话：等你点，或你回一句话、她的邀请过期、换对话、关掉共享时自己消失；收起工具栏不替你回答，也不从工具栏打开',
    sources: ['src/ui/LookOfferPrompt.ts'] },
};

/** Source files with the same markers that never put anything in the pet window. */
export const NOT_IN_PET_WINDOW: Readonly<Record<string, string>> = {
  'src/ui/layout.ts': '控制窗口的页面',
  'src/ui/CharacterPage.ts': '控制窗口的角色页',
  'src/ui/ControlNavigation.ts': '控制窗口的导航',
  'src/ui/AmbientAudio.ts': '旧的环境音面板，桌宠现在用 AudioReadingClient',
};

/** The pet window's popups, all in one place. */
export class PetPopups {
  constructor(private readonly handles: Readonly<Record<PetPopupKey, PetPopupHandle>>, private readonly onError: (message: string) => void = () => {}) {}
  isOpen(key: PetPopupKey): boolean {
    try { return this.handles[key].isOpen(); } catch (error) { this.onError(String(error)); return false; }
  }
  openKeys(): PetPopupKey[] { return PET_POPUP_KEYS.filter(key => this.isOpen(key)); }
  /** Closes every open panel; one that fails to close does not keep the others open. Returns the ones it closed. */
  closeAll(): PetPopupKey[] {
    const closed: PetPopupKey[] = [];
    for (const key of PET_POPUP_KEYS) {
      if (!this.isOpen(key)) continue;
      try { this.handles[key].close(); closed.push(key); } catch (error) { this.onError(String(error)); }
    }
    return closed;
  }
}

/** A popup whose panel is made after PetUI (src/main.ts), so it is looked up each time. */
export function laterPopup<T>(get: () => T | null | undefined, isOpen: (target: T) => boolean, close: (target: T) => void): PetPopupHandle {
  return {
    isOpen: () => { const target = get(); return target != null && isOpen(target); },
    close: () => { const target = get(); if (target != null && isOpen(target)) close(target); },
  };
}
