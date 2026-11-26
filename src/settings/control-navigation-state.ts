export type ControlPage = "chat" | "characters" | "appearance" | "memory" | "providers" | "agent" | "assistant" | "privacy";

export const CONTROL_PAGE_TITLES: Readonly<Record<ControlPage, string>> = {
  chat: "陪伴对话", characters: "角色", appearance: "模型与镜头", memory: "聊天记忆",
  providers: "连接与声音", agent: "Claude 任务", assistant: "Claude 助手", privacy: "隐私与设置",
};

export interface ControlNavigationLeaf {
  readonly id: string;
  readonly label: string;
  readonly page: ControlPage;
  readonly target: string;
}
export interface ControlNavigationGroup {
  readonly id: string;
  readonly label: string;
  readonly glyph?: string;
  readonly children: readonly ControlNavigationNode[];
}
export type ControlNavigationNode = ControlNavigationLeaf | ControlNavigationGroup;
export interface ControlNavigationLocation {
  readonly page: ControlPage;
  readonly target: string;
  readonly leafId: string;
}

const leaf = (page: ControlPage, id: string, label: string, target: string): ControlNavigationLeaf => ({ page, id, label, target });
const group = (id: string, label: string, children: readonly ControlNavigationNode[], glyph?: string): ControlNavigationGroup => ({ id, label, children, glyph });

/** All entries refer to existing controls or stable sections, never application actions. */
export const CONTROL_NAVIGATION: readonly ControlNavigationGroup[] = [
  group("chat", CONTROL_PAGE_TITLES.chat, [
    group("chat-session", "会话", [
      leaf("chat", "chat-messages", "当前消息", "messages"),
      leaf("chat", "chat-new", "新对话入口", "new-chat"),
    ]),
    // I-163: the profile drawer (her nickname table is in it); the target is the top-bar button that opens it, which a tap only flashes.
    group("chat-profile-group", "画像与称呼", [
      leaf("chat", "chat-profile", "用户画像与称呼表", "user-profile-toggle"),
    ]),
    group("chat-compose", "发送与快照", [
      leaf("chat", "chat-input", "输入消息", "chat-input"),
      leaf("chat", "chat-screen", "屏幕快照入口", "attach-screen"),
      leaf("chat", "chat-camera", "摄像头单帧入口", "attach-camera"),
    ]),
  ], "chat"),
  // C2 角色页: second, right below the chat; the character cards moved here from 连接与声音.
  group("characters", CONTROL_PAGE_TITLES.characters, [
    leaf("characters", "character-wall", "角色卡片", "character-wall"),
    leaf("characters", "character-add", "新增角色", "character-add"),
    group("characters-edit", "编辑与细调", [
      leaf("characters", "character-cards", "人设与心情模板", "character-cards"),
      leaf("characters", "character-voice", "她的声音", "character-voice-controls"),
      leaf("characters", "character-response", "按心情反应细调", "character-response-controls"),
      leaf("characters", "character-blush", "模型红晕校准", "blush-calibration"),
      leaf("characters", "character-reaction-dispositions", "她的反应倾向", "reaction-dispositions"),
    ]),
  ], "heart"),
  group("appearance", CONTROL_PAGE_TITLES.appearance, [
    group("appearance-model", "模型", [
      leaf("appearance", "model-local", "本地模型入口", "import-model"),
      leaf("appearance", "model-gene", "预装 Gene 入口", "use-bundled-model"),
    ]),
    group("appearance-motion", "动作", [
      leaf("appearance", "motion-local", "本地 VMD 入口", "appearance-motion"),
      leaf("appearance", "motion-bundled", "预装动作库", "motion-library"),
    ]),
    group("appearance-physics", "局部物理", [
      leaf("appearance", "physics-hair", "头发跟随", "physics-hair-enabled"),
      leaf("appearance", "physics-chest", "胸部弹性", "physics-chest-enabled"),
      leaf("appearance", "physics-quality", "物理质量", "physics-quality"),
    ]),
    group("appearance-camera", "镜头", [
      leaf("appearance", "camera-edit", "调整模式入口", "camera-edit"),
      leaf("appearance", "camera-values", "角度、距离与中心", "camera-section"),
      leaf("appearance", "camera-framing", "全身与半身取景入口", "frame-full"),
    ]),
    group("appearance-emoji-group", "独立表情与贴纸", [
      leaf("appearance", "appearance-emoji", "独立表情与角色贴纸", "single-emoji-controls"),
    ]),
    group("appearance-natural", "自然表现", [
      leaf("appearance", "natural-gaze", "视线跟随", "follow-mouse"),
      leaf("appearance", "natural-breath", "呼吸幅度", "breath"),
      leaf("appearance", "natural-fps", "渲染帧率", "pet-fps"),
    ]),
  ], "box"),
  group("memory", CONTROL_PAGE_TITLES.memory, [
    group("memory-search", "检索与列表", [
      leaf("memory", "memory-query", "查找记忆", "memory-query"),
      leaf("memory", "memory-list", "记忆列表", "memory-list"),
    ]),
    group("memory-entry", "记录与参数", [
      leaf("memory", "memory-detail", "原文、标题与标签", "memory-detail"),
      leaf("memory", "memory-config", "记忆试验参数", "memory-parameters"),
    ]),
    // I-050: the folder she keeps her own things in (her letters, notes, little gifts).
    group("memory-her-folder-group", "她的文件夹", [
      leaf("memory", "memory-her-folder", "开关、文件夹和她最近做的事", "her-folder"),
    ]),
    // I-139: the one thing that moved her most (shown only while the relaxed prompts are on).
    group("memory-moving-group", "最打动她的一件事", [
      leaf("memory", "memory-moving", "现在记着的、以前的、删除和恢复", "moving-memory"),
    ]),
    // I-086: what you fed her and what she gave you, by date (both ways).
    group("memory-our-things-group", "我们的小东西", [
      leaf("memory", "memory-our-things", "开关、点心和她给你的东西", "our-things"),
    ]),
    // I-088: the people and things of your life, each under all the names you call them.
    group("memory-people-things-group", "你生活里的人和事", [
      leaf("memory", "memory-people-things", "叫法归并、改名、待确认", "people-things"),
    ]),
  ], "chat"),
  group("providers", CONTROL_PAGE_TITLES.providers, [
    group("providers-connection", "聊天连接", [
      leaf("providers", "provider-model", "聊天模型", "provider-model"),
    ]),
    group("providers-asr", "语音输入", [
      leaf("providers", "voice-input-config", "服务、模型与语言", "providers-asr"),
      leaf("providers", "voiceprint", "只认你的声音", "voiceprint"), // Unbound v1 step 3 (I-163)
    ]),
    group("providers-voice", "语音输出", [
      leaf("providers", "voice-system", "系统声音与试听入口", "system-voice-options"),
      leaf("providers", "voice-emotional", "百炼配置与试听入口", "emotional-voice"),
    ]),
  ], "cpu"),
  group("agent", CONTROL_PAGE_TITLES.agent, [
    leaf("agent", "agent-switch", "开关（默认关闭）", "codex-task-switch"),
    leaf("agent", "agent-list", "任务列表", "codex-task-list"),
    group("agent-task", "任务操作", [
      leaf("agent", "agent-prompt", "新建与继续入口", "codex-task-form"),
      leaf("agent", "agent-scope", "工作目录与权限", "codex-task-consent"),
    ]),
    group("agent-progress", "进展与审批", [
      leaf("agent", "agent-transcript", "任务进展", "codex-task-progress"),
      leaf("agent", "agent-approvals", "待审批操作", "codex-task-approvals"),
    ]),
  ], "terminal"),
  // I-071 v2 第二步: the user's own Claude for using and adjusting the app, separate from her chat.
  group("assistant", CONTROL_PAGE_TITLES.assistant, [
    leaf("assistant", "assistant-chat", "和 Claude 助手说话", "assistant-input"),
  ], "spark"),
  group("privacy", CONTROL_PAGE_TITLES.privacy, [
    group("privacy-sharing", "输入与共享", [
      leaf("privacy", "privacy-mic", "麦克风开关位置", "runtime-voice"),
      leaf("privacy", "privacy-screen", "屏幕共享开关位置", "runtime-screen"),
      leaf("privacy", "privacy-camera", "摄像头开关位置", "runtime-camera"),
    ]),
    leaf("privacy", "privacy-pet", "桌宠窗口", "privacy-window"),
    leaf("privacy", "privacy-face-check", "认出是不是你（Beta）", "face-check"),
    leaf("privacy", "privacy-pose-sensing", "本机姿态感知组件", "pose-sensing"),
    leaf("privacy", "privacy-ui-language", "界面语言", "interface-language"),
    leaf("privacy", "privacy-agent-channel", "Claude 内部通道", "agent-channel"),
    leaf("privacy", "privacy-proactive-talk", "她主动找你说话", "proactive-talk-section"),
    leaf("privacy", "privacy-channel-gates", "还在试用的功能（让她出来、碰了才软）", "channel-gates"),
    leaf("privacy", "privacy-feed", "喂食认图", "feed-recognition"),
    leaf("privacy", "privacy-crisis-region", "所在地区（求助信息用）", "crisis-region-section"),
    leaf("privacy", "privacy-user-activity", "知道你是不是在忙", "user-activity"),
    leaf("privacy", "privacy-mood-judge", "心情调整员", "mood-judge"),
    leaf("privacy", "privacy-reactions", "新的反应方式", "reactions"),
    leaf("privacy", "privacy-journal", "体验记录", "experience-journal"),
    leaf("privacy", "privacy-data", "数据、恢复与退出入口", "privacy-data"),
    leaf("privacy", "privacy-developer", "开发者模式入口", "privacy-developer"),
  ], "shield"),
];

export function isNavigationGroup(node: ControlNavigationNode): node is ControlNavigationGroup {
  return "children" in node;
}

/** Run-local disclosure and route state. Collapsing a group never changes the route. */
export class ControlNavigationState {
  private readonly nodes = new Map<string, ControlNavigationNode>();
  private readonly parentIds = new Map<string, readonly string[]>();
  private readonly leavesByPage = new Map<ControlPage, ControlNavigationLeaf[]>();
  private readonly expanded = new Set<string>();
  private location: ControlNavigationLocation;

  constructor() {
    const index = (nodes: readonly ControlNavigationNode[], parents: readonly string[]) => {
      for (const node of nodes) {
        this.nodes.set(node.id, node); this.parentIds.set(node.id, parents);
        if (isNavigationGroup(node)) index(node.children, [...parents, node.id]);
        else {
          const leaves = this.leavesByPage.get(node.page) ?? [];
          leaves.push(node); this.leavesByPage.set(node.page, leaves);
        }
      }
    };
    index(CONTROL_NAVIGATION, []);
    const initial = this.leavesByPage.get("chat")![0];
    this.location = { page: initial.page, target: initial.target, leafId: initial.id };
    this.reveal(initial.id);
  }

  get current(): ControlNavigationLocation { return { ...this.location }; }
  isExpanded(id: string): boolean { return this.expanded.has(id); }
  containsCurrent(id: string): boolean { return this.parentIds.get(this.location.leafId)?.includes(id) ?? false; }

  toggle(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node || !isNavigationGroup(node)) return false;
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    return true;
  }

  selectLeaf(id: string): ControlNavigationLocation | null {
    const node = this.nodes.get(id);
    if (!node || isNavigationGroup(node)) return null;
    this.location = { page: node.page, target: node.target, leafId: node.id };
    this.reveal(node.id);
    return this.current;
  }

  /** Unknown targets fall back to the known page entry, never a renderer selector. */
  navigate(page: ControlPage, target?: string): ControlNavigationLocation | null {
    const leaves = this.leavesByPage.get(page);
    if (!leaves?.length) return null;
    return this.selectLeaf((leaves.find(leaf => leaf.target === target) ?? leaves[0]).id);
  }

  private reveal(id: string): void {
    for (const parent of this.parentIds.get(id) ?? []) this.expanded.add(parent);
  }
}
