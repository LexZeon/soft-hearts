// I-025 "三方互通是整体的": the one list of what can be changed in soft hearts and through which of the
// three ways (在设置里点 / 对她说 / 对你自己的 Claude 说). The handbook Claude reads through the channel (read_handbook) is
// generated from this list; tests/capability-coverage.test.mjs fails when a control of the settings window is neither listed
// here nor marked 不开放 with a reason. Data only: the host registry still validates and enforces every call.
import { AGENT_SETTINGS, AGENT_TOOLS, agentSetting, type AgentSettingId, type AgentSettingSpec } from './agent-channel';

/**
 * - direct: done at once when asked (with the "由 Claude 操作" notice; most can be undone).
 * - user-words: privacy, money, deletion and the like. Through the channel with 三方互通 on, the call must carry the user's
 *   own words from the conversation (userWords) or it is refused; with 三方互通 off a dialog asks. In her chat a card asks.
 * - never: not open to the channel or her chat at all (keys, running commands, arbitrary files, permanent deletion...).
 */
export type CapabilityLevel = 'direct' | 'user-words' | 'never';
export const CAPABILITY_LEVEL_LABELS: Readonly<Record<CapabilityLevel, string>> = Object.freeze({
  direct: '直接改（显示“由 Claude 操作”，多数能撤回）',
  'user-words': '需要用户原话（三方互通开着时，通道调用要带上用户在对话里说的原话；关着时弹窗确认；对她说时先给卡片）',
  never: '永不开放',
});

export type CapabilityCategory = 'window' | 'chat' | 'characters' | 'appearance' | 'memory' | 'providers' | 'agent' | 'privacy';
export const CAPABILITY_CATEGORIES: Readonly<Record<CapabilityCategory, string>> = Object.freeze({
  window: '桌宠与预览', chat: '陪伴对话', characters: '角色', appearance: '模型与镜头', memory: '聊天记忆',
  providers: '连接与声音', agent: 'Claude 任务', privacy: '隐私与设置',
});

/** How the channel reads and changes it: a set_setting id, or a tool (with fixed arguments and where to read the value). */
export type CapabilityChannel = { setting: AgentSettingId } | { tool: string; args?: Readonly<Record<string, unknown>>; read?: string };

export interface CapabilityEntry {
  id: string;
  /** 中文名. */
  label: string;
  /** 说明: what it does, in a sentence. */
  description: string;
  category: CapabilityCategory;
  /** 取值 in words; empty for set_setting entries (taken from the setting's choices). */
  values: string;
  level: CapabilityLevel;
  /** When the level depends on the value, e.g. only turning it on needs the user's words. */
  levelNote?: string;
  /** Absent: the channel cannot change it (yet, or never). */
  channel?: CapabilityChannel;
  /** Other channel tools that change the same thing (a shortcut such as show_pet for pet_visible). */
  alsoTools?: readonly string[];
  /** Its controls in the settings window (shared/capability-controls.ts patterns). */
  controls: readonly string[];
  /** never: why. Not yet three-way: what is missing. */
  reason?: string;
  /** Only the interface itself (navigation, opening or closing a panel, searching, copying text): nothing to interconnect. */
  ui?: true;
}

const ui = (id: string, label: string, category: CapabilityCategory, controls: readonly string[], reason: string): CapabilityEntry =>
  ({ id, label, description: reason, category, values: '—', level: 'never', controls, reason, ui: true });
const never = (id: string, label: string, category: CapabilityCategory, controls: readonly string[], reason: string, description = reason): CapabilityEntry =>
  ({ id, label, description, category, values: '—', level: 'never', controls, reason });
const setting = (id: AgentSettingId, category: CapabilityCategory, controls: readonly string[], extra: Partial<CapabilityEntry> = {}): CapabilityEntry => {
  const spec = agentSetting(id);
  if (!spec) throw new Error(`no setting ${id}`);
  // A setting whose values need consent (`confirmWhen`: the paid voice, the microphone, a download…) is "需要用户原话".
  return { id, label: spec.label, description: spec.description, category, values: '', level: spec.tier === 'confirm' || spec.confirmWhen?.length ? 'user-words' : 'direct',
    channel: { setting: id }, controls, ...extra };
};
/** Not three-way yet: only the settings window can change it; `reason` says what is missing. */
const gap = (id: string, label: string, category: CapabilityCategory, description: string, values: string, level: Exclude<CapabilityLevel, 'never'>,
  controls: readonly string[], reason = '内部通道还没有这个操作，对她说也还不能改；现在只能在设置里点。'): CapabilityEntry =>
  ({ id, label, description, category, values, level, controls, reason });

const ON_OFF = '开 / 关';

export const CAPABILITIES: readonly CapabilityEntry[] = Object.freeze([
  // ——— 桌宠与预览（控制窗口顶栏、预览区和全局界面）
  setting('pet_visible', 'window', ['#show-pet', '#pet-visible'], { alsoTools: ['show_pet'] }),
  { id: 'recover_pet', label: '一键恢复桌宠', description: '桌宠居中显示，恢复默认大小和镜头；模型和连接不变。', category: 'window', values: '一次操作', level: 'direct',
    channel: { tool: 'recover_pet', read: 'get_status → windows.pet' }, controls: ['#recover-pet'] },
  { id: 'play_preview', label: '表情试作（惊喜 / 害羞）', description: '在控制窗口的模型预览里播放一次现成的表情试作，不保存。', category: 'window',
    values: 'surprise（惊喜）/ shy（害羞）', level: 'direct', channel: { tool: 'play_preview', read: '—' },
    controls: ['#surprise-preview', '#shy-preview', '[data-expression-preview]'] },
  gap('pet_framing', '桌宠取景（半身 / 全身）', 'window', '把桌宠的镜头切到半身或全身取景。', '半身 / 全身', 'direct', ['#frame-portrait', '#frame-full'],
    '取景要在桌宠窗口里按她此刻的姿势和模型算出镜头，通道那边没有画面，还没有接口（在聊天里说“看全身”她会自己取景）。'),
  ui('ui_navigation', '侧边导航', 'window', ['@control-navigation'], '只是在设置窗口里翻页。'),
  ui('ui_panels', '展开、收起和关闭面板', 'window', ['summary', '#user-profile-toggle', '#notice-details', '#notice-detail-close', '@user-profile-panel 「关闭」',
    '#surprise-stop', '#close-screen', '#cancel-reset', '#goto-characters', '#camera-edit'], '只是打开、收起或关闭界面上的一块，不改任何设置。'),
  ui('chat_retry', '重新检查聊天连接', 'window', ['[data-chat-availability=retry]'], '只是再试一次连接，不改任何设置。'),
  never('network_settings', '打开系统网络设置', 'window', ['[data-chat-availability=network-settings]'], '会打开 Windows 的系统设置，属于系统和安全设置，不开放。'),

  // ——— 陪伴对话
  never('chat_itself', '和她聊天本身', 'chat', ['@tab-chat'],
    '这是和她说话本身（输入、发送、停止、开新对话、给她看屏幕快照或拍一张）。对她说就在这里说；内部通道不替你说话、不替你发图（不冒充用户聊天）。'),

  // ——— 角色
  { id: 'active_character', label: '当前角色（换成她）', description: '换成另一张角色卡：模型、人设和记忆一起换。', category: 'characters',
    values: '角色卡 id（list_characters 里有）', level: 'direct', channel: { tool: 'activate_character', read: 'list_characters → activeId' },
    controls: ['[data-character-action=switch]', '#character-select'] },
  { id: 'character_persona', label: '人设文字', description: '名字、身份描述、个性、开场白、情境、对话示例和额外指令。通道用一张角色卡 JSON 文件原地更新同一个她（记忆都保留，更新前先备份）。',
    category: 'characters', values: '角色卡 JSON 文件（soft hearts v1～v3 或 Tavern）', level: 'user-words', channel: { tool: 'update_character_card', read: 'list_characters（不含正文）' },
    controls: ['#character-name', '#character-description', '#character-personality', '#character-greeting', '#character-scenario', '#character-examples', '#persona',
      '#character-save', '#character-save-activate', '[data-character-action=update-file]', '[data-character-action=confirm-update]'] },
  { id: 'character_import', label: '导入角色卡', description: '从一张角色卡 JSON 文件加一个新角色。导入不授予任何文件或执行权限。', category: 'characters',
    values: '角色卡 JSON 文件的绝对路径', level: 'user-words', channel: { tool: 'import_character_card', read: 'list_characters' },
    controls: ['#character-import', '[data-character-add=import]'] },
  { id: 'character_new_current', label: '用现在的模型新建角色', description: '用桌面上现在的模型新建一张角色卡（名字取自模型，人设之后再填）。', category: 'characters',
    values: '一次操作', level: 'direct', channel: { tool: 'create_character_for_current_model', read: 'list_characters' }, controls: ['[data-character-add=current]'] },
  gap('character_new', '空白新建、选模型文件新建、复制角色', 'characters', '空白新建一张卡、选一个模型文件新建，或复制一张角色卡。', '一次操作', 'direct',
    ['#character-new', '#character-duplicate', '[data-character-action=duplicate]', '[data-character-add=blank]', '[data-character-add=file]'],
    '这几种都是在编辑器里接着填写或在文件对话框里选文件，还没有通道接口；用现在的模型新建、导入角色卡已经可以。'),
  never('character_export', '导出角色卡', 'characters', ['#character-export', '[data-character-action=export]'],
    '导出要你在保存对话框里选位置写文件；任意写文件不开放。'),
  never('character_delete', '删除角色卡', 'characters', ['#character-delete', '[data-character-action=delete]', '[data-character-action=forget-memories]',
    '[data-character-action=confirm-delete]'], '删除角色卡（以及同时删除她的记忆）不开放，只能你自己在设置里点。'),
  { id: 'character_model', label: '角色关联的模型', description: '切换到这个角色时自动载入哪个模型。通道把当前载入的模型关联到角色（要关联别的文件，先用 load_model 载入）。',
    category: 'characters', values: '角色卡 id', level: 'user-words', channel: { tool: 'bind_current_model_to_character', read: 'list_characters → modelName' },
    controls: ['[data-character-action=bind-current]', '#character-bind-model', '[data-character-action=bind-file]'] },
  { id: 'character_unbind_model', label: '解除角色和模型的关联', description: '让这个角色不再自动载入某个模型；现在载入的模型不变。', category: 'characters',
    values: '角色卡 id', level: 'direct', channel: { tool: 'unbind_character_model', read: 'list_characters → modelName' }, controls: ['#character-unbind-model'] },
  gap('character_avatar', '重新截头像', 'characters', '用现在的模型重新截一张角色卡头像。', '一次操作', 'direct', ['[data-character-action=avatar]'],
    '头像是控制窗口的预览画面截的，通道那边没有画面，还没有接口。'),
  setting('slow_warm_up', 'characters', ['#character-slow-warm-up']),
  setting('realer_emotions', 'characters', ['#character-realer-emotions'], { level: 'user-words', levelNote: '打开时需要；关掉直接改' }),
  { id: 'character_mood_template', label: '心情模板', description: '她心情的静息基线、敏感度和恢复快慢（D/O/E/N/C）以及完整模板。随角色卡文件一起更新。',
    category: 'characters', values: '角色卡 JSON 里的 mood 模板', level: 'user-words', channel: { tool: 'update_character_card', read: '—' },
    controls: ['#character-mood-*'] },
  gap('character_blush', '自动脸红（开关、强度、大小）', 'characters', '这个角色会不会自动脸红，脸红多深、多大。', '开 / 关；强度和大小 0～100%', 'direct', ['#character-blush-*'],
    '存在角色卡的心情模板里，要和编辑器里没保存的修改合在一起，还没有单独的接口（可以用 update_character_card 整张更新）。'),
  { id: 'character_response', label: '按心情反应细调', description: '不同心情、互动阶段和情境下她反应的强弱。随角色卡文件一起更新。', category: 'characters',
    values: '角色卡 JSON 里的反应细调', level: 'user-words', channel: { tool: 'update_character_card', read: '—' }, controls: ['#response-*', '#character-retry-response-copy'] },
  never('character_understanding', '和 Claude 聊聊这个角色（理解说明）', 'characters',
    ['[data-character-action=understand]', '[data-understanding-action]', '@character-wall textarea 「回答 Claude」'],
    '这是你和 Claude 一起讨论角色卡的对话本身；理解说明由这段讨论写，不由通道直接改。'),
  ui('character_editor_open', '打开编辑、心情和反应、更多', 'characters', ['[data-character-action=edit]', '[data-character-action=tune]', '[data-character-action=more]',
    '[data-character-action=cancel-delete]', '[data-character-action=cancel-update]'], '只是打开或收起角色卡的编辑区域。'),
  gap('personalize_language', '文字语言习惯（personalize）', 'characters', '和 Claude 一起研究台词，整理她的称呼、句子节奏、语气和禁用表达，确认后保存。',
    '规则文字；保存 / 停用 / 恢复上次', 'user-words', ['[data-authoring-field]', '[data-authoring-action]', '[data-language-field]', '[data-language-action]'],
    '这是一步步和 Claude 一起做的制作流程（研究、澄清、确认保存），还没有通道接口。'),
  gap('personalize_visual', '眉眼制作（personalize）', 'characters', '选一张静图让 Claude 研究眉眼，或手调表情组合，预览后确认保存。',
    '眉眼组合；保存 / 停用 / 恢复上次', 'user-words', ['[data-visual-field]', '[data-visual-action]', '[data-expression-field]', '[data-expression-morph]', '[data-expression-action]'],
    '要你选图片、看预览再确认，还没有通道接口；选图片属于任意读文件，通道不会替你选。'),
  gap('personalize_body', '身体姿态（personalize）', 'characters', '手调或请 Claude 观察静图得到一个姿势，预览后确认保存。', '姿势参数；保存 / 停用 / 恢复上次', 'user-words',
    ['[data-body-field]', '[data-body-action]'], '要你看预览再确认，还没有通道接口；选图片属于任意读文件，通道不会替你选。'),
  gap('blush_calibration', '模型红晕校准', 'characters', '按模型调整红晕相对眼睛和嘴的位置。', '偏移和间距', 'direct', ['#blush-calibration-*'],
    '要看着预览调，还没有通道接口。'),
  // I-024 这个模型能做什么 (src/ui/ModelCapabilityPanel.ts): one row per MODEL_CAPABILITY_IDS entry, stored per model.
  { id: 'model_capability_switch', label: '这个模型能做什么：每项开 / 关', category: 'characters',
    description: '按模型打开或关掉能闭眼、能脸红、有口型、能做睡姿、能做手势、困的脸、能流泪。关一定关；模型没有的打不开。存在本机，不改模型文件。',
    values: 'closeEyes / blush / mouth / sleepPose / gesture / drowsyFace / tears：on / off（只对现在的模型）', level: 'direct',
    channel: { tool: 'set_model_capability', read: 'list_model_capabilities' }, controls: ['[data-model-capability=switch]'] },
  { id: 'model_capability_try', label: '这个模型能做什么：试一下', category: 'characters',
    description: '在桌宠上把这一项演一次（闭眼、脸红、张嘴、睡姿、挥手、困的脸、流泪），演完回到原样，不保存。', values: '一次试演', level: 'direct',
    channel: { tool: 'try_model_capability', read: 'list_model_capabilities' }, controls: ['[data-model-capability=try]'] },
  // 通用骨架第 5 步 · 通道: 她回复里可以选的七个小动作，也让用户自己的 Claude 叫她做。没有设置窗口的按钮，所以 controls 为空。
  { id: 'her_small_actions', label: '让她做一个小动作（挥手 / 点头 / 歪头 / 比心 / 鼓掌 / 眨一只眼 / 撅嘴）', category: 'characters',
    description: '让桌宠做这七个小动作之一，只做一次，不保存；和她回复时自己选的是同一套。这个模型做不了就不做并说缺什么，她在睡觉、被摸头或别的互动里、或自动表现关着时让位。不能借它让她说话或改设置。',
    values: 'wave / nod / tilt / heart / clap / wink / pout', level: 'direct', channel: { tool: 'play_her_action', read: 'list_model_capabilities → actions' }, controls: [] },
  // I-037: the six 反应倾向, decided with the user, per character id (never in the card); 角色页 sliders and 「按角色卡推算」.
  { id: 'reaction_dispositions', label: '她的反应倾向（害羞、黏人、活泼、好哄、情绪起伏、克制）', category: 'characters',
    description: '当前角色对你的话和动作有多敏感（新的反应方式按它们打分）。只属于当前角色，存在本机，不写进角色卡；可以回到按角色卡推算的值。',
    values: '六项各 0～100 的整数（50 一般）；或回到按角色卡推算', level: 'direct', channel: { tool: 'set_reaction_dispositions', read: 'set_reaction_dispositions 的返回值' },
    controls: ['#reaction-disposition-*', '#reaction-dispositions-reset'] },

  // ——— 模型与镜头
  { id: 'model', label: '当前模型', description: '载入一个本机 MMD 模型（.pmx / .pmd），替换当前模型；能撤回到原来的模型。', category: 'appearance',
    values: '.pmx 或 .pmd 文件的绝对路径', level: 'user-words', channel: { tool: 'load_model', read: 'get_status → model' }, controls: ['#import-model', '#empty-import'] },
  { id: 'bundled_model', label: '使用预装 Gene', description: '换回应用自带的 Gene 模型（清除当前动作；能撤回到原来的模型）。', category: 'appearance', values: '一次操作',
    level: 'user-words', channel: { tool: 'use_bundled_model', read: 'get_status → model' }, controls: ['#use-bundled-model'] },
  gap('vmd_motion', '本地 VMD 动作', 'appearance', '载入或清除一个本地 VMD 动作。', 'VMD 文件；清除', 'user-words', ['#import-motion', '#clear-motion'],
    '载入要在文件对话框里选，清除要和控制窗口的预览一起处理，还没有通道接口。'),
  setting('physics_hair', 'appearance', ['#physics-hair-enabled']),
  setting('physics_chest', 'appearance', ['#physics-chest-enabled']),
  setting('physics_quality', 'appearance', ['#physics-quality']),
  gap('physics_strength', '头发和胸部的效果强度', 'appearance', '局部物理两个部位各自的效果强度。', '0～100%', 'direct', ['#physics-hair-strength', '#physics-chest-strength'],
    '还没有通道接口（开关和质量已经可以）。'),
  gap('camera', '虚拟镜头', 'appearance', '桌宠的水平角度、俯仰、距离、视野和中心。', '数值', 'direct', ['#camera-yaw', '#camera-pitch', '#camera-distance', '#camera-fov', '#camera-target*'],
    '镜头和桌宠的取景、拖动、手动调整连在一起，直接改数字可能和正在进行的取景打架，还没有通道接口。'),
  gap('single_emoji', '独立表情', 'appearance', '允许她在身边单独显示一个表情，以及能用哪些表情；可以预览一次。', '开 / 关；每个表情开 / 关', 'direct',
    ['#single-emoji-*', '[data-emoji-control]', '[data-emoji-id]'], '一组开关一起保存，还没有通道接口。'),
  gap('character_stickers', '角色贴纸', 'appearance', '用当前角色的参考图生成贴纸表情，预览后保存。', '一次制作', 'user-words', ['[data-sticker-control]'],
    '会用你的 Claude 额度生成图片，要你看预览再保存，还没有通道接口。'),
  setting('follow_mouse', 'appearance', ['#follow-mouse']),
  setting('breath', 'appearance', ['#breath']),
  setting('music_strength', 'appearance', ['#music-strength']),
  setting('music_always_dance', 'appearance', ['#music-always-dance']),
  setting('fps', 'appearance', ['#pet-fps']),
  gap('motion_library', '预装动作库：启用动作', 'appearance', '把预装的动作启用到身体姿态、手势或面部表情通道，或清除一个通道。', '动作和通道；清除', 'direct',
    ['#motion-target-layer', '#motion-layer-*', '#motion-install-*', '#motion-cancel-*'], '要先在控制窗口里试播、确认适合这个模型，还没有通道接口。'),
  gap('motion_tag_weights', '动作的个人 tag 权重', 'appearance', '给动作加自己的标签和权重，影响她挑动作。', '标签和权重', 'direct',
    ['@motion-library 「添加标签」', '@motion-library 「保存权重」', '@motion-library 「放弃草稿并重读」'], '是一份草稿式的编辑，还没有通道接口。'),
  ui('motion_library_browse', '动作库的浏览、筛选、试播和对比', 'appearance', ['@motion-library'], '筛选、搜索、试播预览和轨道对比只在设置窗口里看，不改她用的动作。'),

  // ——— 聊天记忆
  ui('memory_browse', '查找和翻看记忆', 'memory', ['#memory-query', '#memory-tag', '#memory-search', '@memory-panel 「上一页」', '@memory-panel 「下一页」', '@memory-list',
    '#ambient-transcript-query', '#ambient-transcript-tag', '#ambient-transcript-search', '#ambient-transcript-previous', '#ambient-transcript-next', '@ambient-transcript-list'],
  '只是在设置窗口里查找和翻看；通道从不返回聊天原文。'),
  never('memory_edit', '改一段记忆的标题、标签和分类', 'memory', ['#memory-title', '#memory-tags', '@memory-detail select', '#memory-save'],
    '她的记忆内容只由你自己改，Claude 不改。'),
  never('memory_delete_one', '删除一段聊天记忆', 'memory', ['#memory-delete'],
    '这是永久删除，不开放。要删一个角色的全部聊天记忆，可以用 delete_memories 先放进回收站（期限内能找回）。'),
  never('memory_parameters', '记忆试验参数', 'memory', ['#memory-parameters', '@memory-tuning 「应用记忆参数」'], '开发时调试用的试验参数，不开放。'),
  never('listen_delete', '一起听：清空原文、删除笔记', 'memory', ['[data-role=listen-clear-raw]', '[data-role=listen-delete]'], '这是永久删除，不开放。'),
  never('ambient_delete', '删除播放声音的文字记录', 'memory', ['#ambient-transcript-delete'], '这是永久删除，不开放。'),
  { id: 'delete_memories', label: '删除一个角色的记忆（进回收站）', description: '把一个角色的聊天记忆、或画像和日记放进回收站，期限内能找回，到期才清理。', category: 'memory',
    values: 'chat（聊天记忆）/ profile（画像和日记）', level: 'user-words', channel: { tool: 'delete_memories', read: 'list_recycle_bin' }, controls: [] },

  // ——— 连接与声音
  setting('chat_model', 'providers', ['#provider-model']),
  gap('asr_engine', '语音识别方式和语言', 'providers', '用本机自带识别还是兼容接口地址；识别语言；兼容接口的地址和模型。', '本机 / 兼容接口；语言代码', 'user-words',
    ['#asr-engine', '#asr-language', '#asr-url', '#asr-model'], '兼容接口会把你的声音发到那个地址，地址只能你自己填；方式和语言还没有单独的通道接口。'),
  never('asr_key', '识别服务密钥', 'providers', ['#asr-key'], '密钥永远不经过内部通道和聊天。'),
  setting('local_asr', 'providers', ['@local-asr 「下载」', '@local-asr 「重试」', '@local-asr 「取消」', '@local-asr 「删除识别组件」'],
    { level: 'user-words', levelNote: '下载、取消和删除都需要' }),
  ui('local_asr_later', '以后再说', 'providers', ['@local-asr 「以后再说」', '@pose-sensing 「以后再说」'], '只是收起下载提示。'),
  never('component_import', '导入离线组件包', 'providers', ['@local-asr 「已有离线组件包？导入…」', '@local-asr 「导入离线组件包…」',
    '@pose-sensing 「已有离线组件包？导入…」', '@pose-sensing 「导入离线组件包…」'], '要你在文件对话框里选文件；任意读文件不开放。'),
  setting('read_aloud', 'providers', ['#voice-enabled'], { alsoTools: ['set_read_aloud'] }),
  setting('voice_rate', 'providers', ['#voice-rate']),
  setting('voice_mood_influence', 'providers', ['#voice-mood']),
  setting('voice_first_chunk', 'providers', ['#voice-first-chunk']),
  setting('pause_talk', 'providers', ['#voice-pause-talk'], { levelNote: '打开时需要（每条回复多问一次 haiku，会用你的 Claude 用量）；关掉直接改' }),
  gap('system_voice_name', '用哪个系统声音', 'providers', '朗读用电脑上的哪一个系统声音。', '声音名', 'direct', ['#voice-select'],
    '系统声音的名单只有窗口里读得到（各台电脑不同），通道看不到，还没有接口。'),
  { id: 'voice_preview', label: '试听语音', description: '用当前语音方案读一句固定的话。百炼会产生一次付费调用。', category: 'providers', values: '一次试听', level: 'user-words',
    channel: { tool: 'voice_preview', read: '—' }, controls: ['#test-voice', '#tts-preview', '#tts-preview-panel'] },
  ui('voice_preview_controls', '试听文字和停止试听', 'providers', ['#tts-preview-text', '#tts-stop'], '只影响设置窗口里的这一次试听。'),
  setting('readout_volume', 'providers', ['#voice-volume']),
  setting('voice_provider', 'providers', ['#tts-provider']),
  never('tts_connection', '百炼连接地址和地域', 'providers', ['#tts-api-host', '#tts-region'], '改连接地址可能把你的密钥发到别处，只能你自己改。'),
  never('tts_key', '百炼密钥', 'providers', ['#tts-api-key', '#tts-clear-key'], '密钥永远不经过内部通道和聊天。'),
  gap('tts_voice_style', '百炼模型、音色和表达风格', 'providers', '百炼的模型、音色，以及这个角色的情绪、表达风格和语速。', '模型 id、音色 id、风格文字、语速', 'direct',
    ['#tts-model', '#tts-voice', '#tts-emotion', '#tts-instruction', '#tts-rate', '#tts-save'], '按角色和模型分开存，和密钥在同一份配置里一起保存，还没有单独的通道接口。'),
  ui('tts_guides', '百炼控制台和开通说明', 'providers', ['#tts-open-console', '#tts-open-guide', '@tts-introduction'], '只是打开说明或网页。'),

  // ——— Claude 任务
  never('claude_tasks', 'Claude 任务（读写文件、运行命令）', 'agent', ['@codex-tasks'], '任务执行会运行命令、读写文件，永远不开放给内部通道和聊天；开关和每一步批准都只能你自己点。'),

  // ——— 隐私与设置
  setting('developer_mode', 'privacy', ['#open-mood']),
  setting('voice_input', 'privacy', ['#runtime-voice'], { level: 'user-words', levelNote: '打开时需要；关掉直接改', alsoTools: ['set_perception'] }),
  { id: 'screen_sharing', label: '屏幕共享', description: '让她看到桌宠所在的屏幕。默认关。', category: 'privacy', values: ON_OFF, level: 'user-words', levelNote: '打开时需要；关掉直接改',
    channel: { tool: 'set_perception', args: { kind: 'screen' }, read: 'get_status → perception.screen' }, controls: ['#runtime-screen'] },
  // I-036: the camera is two independent switches; this row is the old single one (on: 姿势识别; off: both off).
  { id: 'camera_sharing', label: '摄像头共享', description: '两个开关任一开着就算开：发图片、姿势识别。用这一项打开等于打开姿势识别；关掉两个都关。默认关。', category: 'privacy', values: ON_OFF, level: 'user-words', levelNote: '打开时需要；关掉直接改',
    channel: { tool: 'set_perception', args: { kind: 'camera' }, read: 'get_status → perception.camera' }, controls: ['#runtime-camera', '#runtime-camera-images'] },
  { id: 'camera_images', label: '摄像头发图片', description: '你发消息时附一张很小的摄像头画面（约 320×240），叫她看时发清楚的一张；不用下载。默认关。', category: 'privacy', values: ON_OFF, level: 'user-words', levelNote: '打开时需要；关掉直接改',
    channel: { tool: 'set_perception', args: { kind: 'camera_images' }, read: 'get_status → perception.cameraImages' }, controls: ['#runtime-camera-images'] },
  { id: 'camera_pose', label: '摄像头姿势识别', description: '只在这台电脑上识别你在不在、朝向和动作，画面不离开电脑；第一次要下载组件。默认关。', category: 'privacy', values: ON_OFF, level: 'user-words', levelNote: '打开时需要；关掉直接改',
    channel: { tool: 'set_perception', args: { kind: 'camera_pose' }, read: 'get_status → perception.cameraPose' }, controls: ['#runtime-camera'] },
  { id: 'system_audio', label: '电脑声音（陪听音乐 / 陪看视频）', description: '让她听到电脑里放的声音。开关在桌宠上。默认关。', category: 'privacy',
    values: 'music（陪听音乐）/ movie（陪看视频）开 / 关', level: 'user-words', levelNote: '打开时需要；关掉直接改',
    channel: { tool: 'set_perception', args: { kind: 'system_audio' }, read: 'get_status → perception.systemAudio' }, controls: [] },
  setting('pose_sensing', 'privacy', ['@pose-sensing 「下载」', '@pose-sensing 「重试」', '@pose-sensing 「取消」', '@pose-sensing 「删除感知组件」'],
    { levelNote: '下载、取消和删除都需要' }),
  gap('pose_redetect', '重新检测姿态感知硬件', 'privacy', '重新检测能不能用显卡做姿态感知。', '一次操作', 'direct', ['@pose-sensing 「重新检测硬件」'],
    '诊断用的操作，还没有通道接口。'),
  setting('proactive_vision', 'privacy', ['[data-screen-option]'], { levelNote: '打开时需要；关掉直接改' }),
  setting('ui_language', 'privacy', ['#ui-language']),
  setting('always_on_top', 'privacy', ['#always-on-top']),
  setting('click_through', 'privacy', ['#click-through']),
  { id: 'interconnect', label: '三方互通', description: '你的 Claude、和她聊天、设置互相通着。通道只能把它关掉（关掉后通道也断开）。', category: 'privacy',
    values: '关（on 只在你手动开着通道、关了三方互通时能用，而且要弹窗确认）', level: 'direct', channel: { tool: 'set_interconnect', read: 'get_status → interconnect' },
    controls: ['[data-agent-channel=interconnect]'] },
  never('agent_channel_switch', '内部通道开关', 'privacy', ['[data-agent-channel=enabled]'], '通道开关是安全设置，只能你自己点；三方互通开着时它一直开。'),
  never('claude_code_link', '重新接上 Claude Code', 'privacy', ['[data-agent-channel=relink]'], '要运行 claude 命令改你的 Claude Code 配置；运行命令不开放。'),
  { id: 'undo_last_action', label: '撤回 Claude 的上一步', description: '撤回 Claude 最近一次能撤回的操作（30 分钟内）。', category: 'privacy', values: '一次操作', level: 'direct',
    channel: { tool: 'undo_last_action', read: '—' }, controls: ['[data-agent-channel=undo]'] },
  ui('agent_channel_copy', '复制接入命令', 'privacy', ['[data-agent-channel=copy-claude-code]', '[data-agent-channel=copy-desktop-config]'], '只是复制文字。'),
  setting('recycle_bin_days', 'privacy', ['[data-agent-channel=recycle-days]']),
  { id: 'restore_memories', label: '从回收站找回记忆', description: '把回收站里的一项放回原来的角色。', category: 'privacy', values: '回收站编号', level: 'direct',
    channel: { tool: 'restore_memories', read: 'list_recycle_bin' }, controls: ['@agent-channel 「找回」'] },
  setting('feed_recognition', 'privacy', ['#feed-recognition-enabled'], { levelNote: '打开时需要；关掉直接改' }),
  // I-027: turning it on spends the user's Claude quota (haiku, at most 200 calls a day), so it needs the user's own words.
  setting('mood_judge', 'privacy', ['#mood-judge-enabled'], { levelNote: '打开时需要（会用你的 Claude 用量）；关掉直接改' }),
  // I-037: one haiku call per message (the user's Claude quota); on by default in every version (2026-11-07). Turning it on needs the user's own words.
  setting('new_reactions', 'privacy', ['#reactions-enabled'], { levelNote: '打开时需要（会用你的 Claude 用量）；关掉直接改' }),
  setting('proactive_talk', 'chat', ['#proactive-talk']),
  setting('user_activity', 'privacy', ['#user-activity-enabled'], { levelNote: '默认开；关掉直接改，重新打开时需要（它是一种新的感知）' }),
  setting('experience_journal', 'privacy', ['[data-journal=enabled]']),
  ui('journal_filter', '体验记录按角色筛选', 'privacy', ['[data-journal=filter]'], '只是在设置窗口里筛选。'),
  never('reset_settings', '重置应用设置', 'privacy', ['#reset-settings', '#confirm-reset'], '会清除配置、密钥和当前对话，不可撤回，只能你自己点。'),
  never('quit_app', '退出应用', 'privacy', ['#quit-app'], '退出后通道也断开，只能你自己点。'),
  gap('profile_recording', '允许记录用户画像', 'privacy', '她会不会把你说的事记进画像。', ON_OFF, 'user-words', ['@user-profile-panel 「允许记录*」'],
    '这个开关按当前角色和连接分开，要带上画像面板读到的那一份的编号才能改，还没有通道接口。'),
  never('profile_edit', '改或删画像、日记、称呼和文字纪念', 'privacy', ['@user-profile-panel textarea', '@user-profile-panel select', '@user-profile-panel input',
    '@user-profile-panel 「保存修改」', '@user-profile-panel 「删除」', '@user-profile-panel 「修改日记」', '@user-profile-panel 「删除这天的日记」', '@user-profile-panel 「清空全部日记」',
    '@user-profile-panel 「保存称呼」', '@user-profile-panel 「删除称呼」', '@user-profile-panel 「保存纪念修改」', '@user-profile-panel 「删除纪念」'],
  '她的画像、日记、给你的称呼和文字纪念只由你自己改；单条删除是永久删除，不开放。要删一个角色的全部画像和日记，用 delete_memories 先放进回收站。'),
  ui('profile_reload', '重新读取纪念', 'privacy', ['@user-profile-panel 「重新读取纪念」'], '只是重新读取显示。'),
]);

/** What the channel can read without changing anything (the tools of tier read). */
export const CAPABILITY_READ_TOOLS: readonly string[] = Object.freeze(AGENT_TOOLS.filter(tool => tool.tier === 'read').map(tool => tool.name));

export function capability(id: string): CapabilityEntry | undefined { return CAPABILITIES.find(entry => entry.id === id); }
export const capabilitySetting = (entry: CapabilityEntry): AgentSettingSpec | undefined =>
  entry.channel && 'setting' in entry.channel ? agentSetting(entry.channel.setting) : undefined;

/** 取值 in words: the setting's own choices, or the entry's text. */
export function capabilityValues(entry: CapabilityEntry): string {
  const spec = capabilitySetting(entry);
  if (!spec) return entry.values;
  if (spec.kind === 'number') return `${spec.min}～${spec.max}（${spec.unit}）`;
  return spec.choices.map(choice => `${JSON.stringify(choice.value)}（${choice.label}）`).join(' / ');
}

/** Her chat can offer it as a card (a setting not marked `chat: false`). */
export const capabilityChat = (entry: CapabilityEntry): boolean => { const spec = capabilitySetting(entry); return !!spec && spec.chat !== false; };
/** The channel can change it (set_setting or a tool). */
export const capabilityChannel = (entry: CapabilityEntry): boolean => entry.level !== 'never' && !!entry.channel;
/** A function (not just the interface) that is not open to all three ways yet. */
export const capabilityGap = (entry: CapabilityEntry): boolean => !entry.ui && entry.level !== 'never' && !capabilityChannel(entry);

/** 怎么读 / 怎么改 in one line each. */
export function capabilityHow(entry: CapabilityEntry): { read: string; write: string } {
  const channel = entry.channel;
  if (!channel || entry.level === 'never') return { read: '—', write: entry.level === 'never' ? '不开放' : '还不能通过通道改；只能在设置里点' };
  if ('setting' in channel) return { read: `list_settings 里的 ${channel.setting}`, write: `set_setting {"id":"${channel.setting}","value":…}` };
  const args = channel.args ? JSON.stringify(channel.args).slice(1, -1) : '';
  return { read: channel.read ?? 'get_status', write: `${channel.tool}${args ? ` {${args}, …}` : ''}` };
}

/** Every pattern of every entry, for the coverage scan. */
export function capabilityPatterns(entries: readonly CapabilityEntry[] = CAPABILITIES): Array<{ entry: string; pattern: string }> {
  return entries.flatMap(entry => entry.controls.map(pattern => ({ entry: entry.id, pattern })));
}

/** The settings each setting entry stands for: every set_setting id must be one of them (tests). */
export const CAPABILITY_SETTING_IDS: readonly AgentSettingId[] = Object.freeze(AGENT_SETTINGS.map(spec => spec.id));
