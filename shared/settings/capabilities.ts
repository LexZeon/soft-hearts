// I-025 "三方互通是整体的": the one list of what can be changed in soft hearts and through which of the
// three ways (在设置里点 / 对她说 / 对你自己的 Claude 说). The handbook Claude reads through the channel (read_handbook) is
// generated from this list; tests/capability-coverage.test.mjs fails when a control of the settings window is neither listed
// here nor marked 不开放 with a reason. Data only: the host registry still validates and enforces every call.
import { AGENT_ALWAYS_DIALOG_TOOLS, AGENT_SETTINGS, AGENT_TOOLS, agentSetting, settingAlwaysDialog, type AgentSettingId, type AgentSettingSpec } from '../safety';
import { ASSISTANT_NAME, ASSISTANT_CLI_NAME } from '../foundation/assistant-name';

/**
 * - direct: done at once when asked (with the "由 Claude 操作" notice; most can be undone).
 * - user-words: privacy, money, deletion and the like. Through the channel with 三方互通 on, the call must carry the user's
 *   own words from the conversation (userWords) or it is refused; with 三方互通 off a dialog asks. In her chat a card asks.
 *   敏感操作弹窗: the sensitive ones (privacy, spending, deleting, files: capabilityAlwaysDialog) open the dialog
 *   with 三方互通 on as well, after the user's words.
 * - never: not open to the channel or her chat at all (keys, running commands, arbitrary files, permanent deletion...).
 */
export type CapabilityLevel = 'direct' | 'user-words' | 'never';
export const CAPABILITY_LEVEL_LABELS: Readonly<Record<CapabilityLevel, string>> = Object.freeze({
  direct: `直接改（显示“由 ${ASSISTANT_NAME} 操作”，多数能撤回）`,
  'user-words': '需要用户原话（三方互通开着时，通道调用要带上用户在对话里说的原话，其中隐私、花钱、删除、下载或载入文件的还会在 soft hearts 里弹窗由用户点（手册里 dialog 为 true）；关着时弹窗确认；对她说时先给卡片）',
  never: '永不开放',
});

export type CapabilityCategory = 'window' | 'chat' | 'characters' | 'appearance' | 'memory' | 'providers' | 'agent' | 'privacy';
export const CAPABILITY_CATEGORIES: Readonly<Record<CapabilityCategory, string>> = Object.freeze({
  window: '桌宠与预览', chat: '陪伴对话', characters: '角色', appearance: '模型与镜头', memory: '聊天记忆',
  providers: '连接与声音', agent: `${ASSISTANT_NAME} 任务`, privacy: '隐私与设置',
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
  /** Its controls in the settings window (shared/settings/capability-controls.ts patterns). */
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
  // I-065: her 「带我去」 for the user's own Claude; it only opens a page.
  { id: 'open_control_page', label: '打开控制窗口的某一页', description: '带用户去控制窗口的某一页自己操作（和她聊天里的「带我去」是同一件事），比如去「百炼语音」自己填 Key。只导航，不改任何设置。',
    category: 'window', values: '页面（「带我去」的那几页）', level: 'direct', channel: { tool: 'open_control_page', read: '—' }, controls: [] },
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
  never('channel_gates', '还在试用的功能（默认开，可以关：让她出来、碰了才软、三人同框 Beta；她们都能接话）', 'privacy', ['#channel-gate-unbound-entry', '#channel-gate-touch-soft', '#channel-gate-three-on-stage', '#channel-gate-chime-in'],
    '还在试用、默认开着、不想要可以关掉的开关；「让她出来」通向摄像头、麦克风、屏幕的权限包，所以只能你自己在设置里点。'),

  // ——— 陪伴对话
  never('chat_itself', '和她聊天本身', 'chat', ['@tab-chat'],
    '这是和她说话本身（输入、发送、停止、开新对话、给她看屏幕快照或拍一张）。对她说就在这里说；内部通道不替你说话、不替你发图（不冒充用户聊天）。'),

  // ——— 角色
  { id: 'active_character', label: '当前角色（换成她）', description: '换成另一张角色卡：模型、人设和记忆一起换。', category: 'characters',
    values: '角色卡 id（list_characters 里有）', level: 'direct', channel: { tool: 'activate_character', read: 'list_characters → activeId' },
    controls: ['[data-character-action=switch]', '#character-select'] },
  { id: 'character_persona', label: '人设文字', description: '名字、身份描述、个性、开场白、情境、对话示例、额外指令、这张卡说的语言（中文或 English，卡文件里的 language）和睡相（0～100，卡文件里的 sleepHabit）。通道用一张角色卡 JSON 文件原地更新同一个她（记忆都保留，更新前先备份）。',
    category: 'characters', values: '角色卡 JSON 文件（soft hearts v1～v3 或 Tavern）', level: 'user-words', channel: { tool: 'update_character_card', read: 'list_characters（不含正文）' },
    controls: ['#character-name', '#character-description', '#character-personality', '#character-greeting', '#character-scenario', '#character-examples', '#character-language', '#character-sleep-habit', '#persona',
      '#character-save', '#character-save-activate', '[data-character-action=update-file]', '[data-character-action=confirm-update]'] },
  { id: 'character_convert', label: '转换成英文 / 中文角色',
    description: `以一个角色为样本，用你自己的 ${ASSISTANT_CLI_NAME} 生成同样性格和记忆的另一种语言的新角色（新编号，原角色一个字都不动，之后两边记忆不同步）。人设按意思翻译；聊天笔记、画像、最近 30 天日记和只属于你们的梗翻译后复制一次；熟悉度原样带；每个昵称由你选。一定会弹窗，先备份，中途可以取消。`,
    category: 'characters', values: '角色卡 id、目标语言（en 或 zh-CN）、每个名字的选择', level: 'user-words',
    channel: { tool: 'convert_character_language', read: 'prepare_character_conversion、get_character_conversion' },
    alsoTools: ['cancel_character_conversion'], controls: ['[data-character-action=convert]'] },
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
  // I-173: like deleting memories: into the recycle bin, the user's words and always the dialog; never the active card or the last one.
  { id: 'character_delete', label: '删除角色卡（进回收站）', description: '把一张角色卡（可选连同她的全部记忆）放进回收站，期限内能完整找回，到期才清理。不能删正在陪着你的角色（先换走），也不能删最后一张。',
    category: 'characters', values: '角色卡 id；forgetMemories（她的记忆一起删，默认不删）', level: 'user-words', channel: { tool: 'delete_character', read: 'list_characters、list_recycle_bin' },
    controls: ['#character-delete', '[data-character-action=delete]', '[data-character-action=forget-memories]', '[data-character-action=confirm-delete]'] },
  ui('character_recycle_open', '打开角色页的回收站', 'characters', ['[data-recycle=open]'], '只是在角色页展开回收站，看里面有什么；找回、保留天数和永久删除在下面各有各的登记。'),
  { id: 'character_model', label: '角色关联的模型', description: '切换到这个角色时自动载入哪个模型。通道把当前载入的模型关联到角色（要关联别的文件，先用 load_model 载入）。',
    category: 'characters', values: '角色卡 id', level: 'user-words', channel: { tool: 'bind_current_model_to_character', read: 'list_characters → modelName' },
    controls: ['[data-character-action=bind-current]', '#character-bind-model', '[data-character-action=bind-file]'] },
  { id: 'character_unbind_model', label: '解除角色和模型的关联', description: '让这个角色不再自动载入某个模型；现在载入的模型不变。', category: 'characters',
    values: '角色卡 id', level: 'direct', channel: { tool: 'unbind_character_model', read: 'list_characters → modelName' }, controls: ['#character-unbind-model'] },
  gap('character_avatar', '重新截头像', 'characters', '用现在的模型重新截一张角色卡头像。', '一次操作', 'direct', ['[data-character-action=avatar]'],
    '头像是控制窗口的预览画面截的，通道那边没有画面，还没有接口。'),
  setting('slow_warm_up', 'characters', ['#character-slow-warm-up']),
  // I-077 step 2: her music taste is a card trait; it travels in the card file, so the channel changes it with the same update-from-a-file tool.
  { id: 'music_taste', label: '她的音乐口味', description: '她更爱慢歌还是快歌、柔和的还是明亮的、安静的还是热烈的（三项各 0～100，50 = 没有偏好）。只决定她听歌时投入多少，不会嫌弃你放的歌。随角色卡文件一起更新。',
    category: 'characters', values: '角色卡 JSON 里的 musicTaste（tempo / brightness / energy，0～100 的整数）', level: 'user-words', channel: { tool: 'update_character_card', read: '—' },
    controls: ['#character-taste-tempo', '#character-taste-brightness', '#character-taste-energy'] },
  // 小毛病: how often her small slips happen when she reaches out first; a card trait that travels in the card file, so the channel uses the same update-from-a-file tool.
  { id: 'card_slips', label: '她的小毛病多不多', description: '她主动开口时偶尔的小失误（话说一半改口、走神、嘴硬不承认）出现得多不多：关（不会有）/ 少一点 / 默认 / 多一点。随角色卡文件一起更新。',
    category: 'characters', values: '角色卡 JSON 里的 slips（off / less / more；不写就是默认）', level: 'user-words', channel: { tool: 'update_character_card', read: '—' },
    controls: ['#character-slips'] },
  setting('realer_emotions', 'characters', ['#character-realer-emotions'], { level: 'user-words', levelNote: '打开时需要；关掉直接改。打开时可带 duration：day、week（默认）、month、forever；到时间会自动关闭，卡片编辑器里写着截止时间，不弹窗、她不说' }),
  { id: 'character_mood_template', label: '心情模板', description: '她心情的静息基线、敏感度和恢复快慢（D/O/E/N/C）以及完整模板。随角色卡文件一起更新。',
    category: 'characters', values: '角色卡 JSON 里的 mood 模板', level: 'user-words', channel: { tool: 'update_character_card', read: '—' },
    controls: ['#character-mood-*'] },
  gap('character_blush', '自动脸红（开关、强度、大小）', 'characters', '这个角色会不会自动脸红，脸红多深、多大。', '开 / 关；强度和大小 0～100%', 'direct', ['#character-blush-*'],
    '存在角色卡的心情模板里，要和编辑器里没保存的修改合在一起，还没有单独的接口（可以用 update_character_card 整张更新）。'),
  // 2026-11-24: the provider (and its voice id) of any character through set_character_voice; her pace, description and 读法 stay on the page.
  { id: 'character_voice', label: '她自己的声音（服务商、声音、语速音调、声音描述）', description: '一个角色自己用哪家的声音（系统声音、百炼、Drama 3，或跟随新角色的默认声音）和那家的声音编号；任何一张角色卡都可以。语速、音调、声音描述和读法只在「她的声音」里改。',
    category: 'characters', values: 'provider：system / bailian / fish / default；可选 voiceId', level: 'user-words',
    levelNote: '换成百炼或 Drama 3（会花钱）要用户原话，带了也弹窗，不能撤回；换成免费的声音直接改，能撤回', channel: { tool: 'set_character_voice', read: 'list_settings → voices.characters' },
    controls: ['#character-voice-*'] },
  { id: 'character_response', label: '按心情反应细调', description: '不同心情、互动阶段和情境下她反应的强弱。随角色卡文件一起更新。', category: 'characters',
    values: '角色卡 JSON 里的反应细调', level: 'user-words', channel: { tool: 'update_character_card', read: '—' }, controls: ['#response-*', '#character-retry-response-copy'] },
  never('character_understanding', `和 ${ASSISTANT_NAME} 聊聊这个角色（理解说明）`, 'characters',
    ['[data-character-action=understand]', '[data-understanding-action]', `@character-wall textarea 「回答 ${ASSISTANT_NAME}」`],
    `这是你和 ${ASSISTANT_NAME} 一起讨论角色卡的对话本身；理解说明由这段讨论写，不由通道直接改。`),
  ui('character_editor_open', '打开编辑、心情和反应、更多', 'characters', ['[data-character-action=edit]', '[data-character-action=tune]', '[data-character-action=more]',
    '[data-character-action=cancel-delete]', '[data-character-action=cancel-update]'], '只是打开或收起角色卡的编辑区域。'),
  ui('character_archive', '角色档案（只看、搜索）', 'characters', ['[data-character-action=archive]', '[data-archive-action=close]', '[data-archive-action=open-bin]',
    '[data-archive-field=query]'], '只读的一页：看她的日记、笔记、画像、计划、熟悉度，搜一搜；不改、不删任何东西（删除在原来的页和回收站）。'),
  gap('personalize_language','文字语言习惯（personalize）', 'characters', `和 ${ASSISTANT_NAME} 一起研究台词，整理她的称呼、句子节奏、语气和禁用表达，确认后保存。`,
    '规则文字；保存 / 停用 / 恢复上次', 'user-words', ['[data-authoring-field]', '[data-authoring-action]', '[data-language-field]', '[data-language-action]'],
    `这是一步步和 ${ASSISTANT_NAME} 一起做的制作流程（研究、澄清、确认保存），还没有通道接口。`),
  gap('personalize_visual', '眉眼制作（personalize）', 'characters', `选一张静图让 ${ASSISTANT_NAME} 研究眉眼，或手调表情组合，预览后确认保存。`,
    '眉眼组合；保存 / 停用 / 恢复上次', 'user-words', ['[data-visual-field]', '[data-visual-action]', '[data-expression-field]', '[data-expression-morph]', '[data-expression-action]'],
    '要你选图片、看预览再确认，还没有通道接口；选图片属于任意读文件，通道不会替你选。'),
  gap('personalize_body', '身体姿态（personalize）', 'characters', `手调或请 ${ASSISTANT_NAME} 观察静图得到一个姿势，预览后确认保存。`, '姿势参数；保存 / 停用 / 恢复上次', 'user-words',
    ['[data-body-field]', '[data-body-action]'], '要你看预览再确认，还没有通道接口；选图片属于任意读文件，通道不会替你选。'),
  gap('blush_calibration', '模型红晕校准', 'characters', '按模型调整红晕相对眼睛和嘴的位置。', '偏移和间距', 'direct', ['#blush-calibration-*'],
    '要看着预览调，还没有通道接口。'),
  // I-024 这个模型能做什么 (src/stage/ModelCapabilityPanel.ts): one row per MODEL_CAPABILITY_IDS entry, stored per model.
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
  { id: 'model', label: '当前模型', description: '载入一个本机模型（MMD 的 .pmx / .pmd，或 VRM 的 .vrm），替换当前模型；能撤回到原来的模型。', category: 'appearance',
    values: '.pmx、.pmd 或 .vrm 文件的绝对路径', level: 'user-words', channel: { tool: 'load_model', read: 'get_status → model' }, controls: ['#import-model', '#empty-import'] },
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
    `会用你的 ${ASSISTANT_NAME} 额度生成图片，要你看预览再保存，还没有通道接口。`),
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
    `她的记忆内容只由你自己改，${ASSISTANT_NAME} 不改。`),
  never('memory_delete_one', '删除一段聊天记忆', 'memory', ['#memory-delete'],
    '删掉的先进回收站，能在旁边的「最近删除的」找回（I-144b）；删除只在界面上由你点，不经内部通道。要删一个角色的全部聊天记忆，可以用 delete_memories 先放进回收站。'),
  never('memory_parameters', '记忆试验参数', 'memory', ['#memory-parameters', '@memory-tuning 「应用记忆参数」'], '开发时调试用的试验参数，不开放。'),
  // I-050 她的文件夹 (electron/initiative/her-folder/).
  never('her_folder', '她的文件夹', 'memory', ['#her-folder-enabled', '[data-her-folder=change]', '[data-her-folder=restore]'],
    '打开要你在系统对话框里亲自选一个文件夹，路径从不经内部通道或聊天传；恢复也只在这里点。她只能在聊天里按格式提议放一个文字文件，由应用检查后写进那个文件夹。',
    '给她一个只属于她的文件夹：她在里面写信、记东西，只写 .md/.txt，改你的文件前先留原版，删的东西进她的回收站 30 天。'),
  ui('her_folder_open', '打开她的文件夹', 'memory', ['[data-her-folder=open]'], '只是在资源管理器里显示这个文件夹。'),
  // I-139 A3 最打动她的一件事 (electron/memory/moving-memory/).
  never('moving_memory', '最打动她的一件事：删掉当前一件、找回以前的', 'memory', ['[data-moving-memory=delete]', '[data-moving-memory=restore]'],
    '这是她记着的、和你之间的私人记忆。删掉的先进回收站，能在旁边的「最近删除的」找回；删除仍只在界面上由你点，不经内部通道。'),
  never('listen_delete','一起听：清空原文、删除笔记', 'memory', ['[data-role=listen-clear-raw]', '[data-role=listen-delete]'],
    '删掉的笔记和清空的原文都先进回收站，能在旁边的「最近删除的」找回（I-144b）；删除仍只在界面上由你点，不经内部通道。'),
  never('ambient_delete', '删除播放声音的文字记录', 'memory', ['#ambient-transcript-delete'], '删掉的先进回收站，能在旁边的「最近删除的」找回（I-144b）；删除只在界面上由你点，不经内部通道。'),
  { id: 'clear_song_memory', label: '清除她记得的歌', description: '清掉她认得的常放的歌（每首只是前奏的几个数，不是声音、没有歌名）。清除后要重新听过几遍才会再认得；清除的先进回收站（期限内能找回），也能用 undo_last_action 放回去。', category: 'memory',
    values: '没有参数，清空这个角色记得的所有歌', level: 'user-words', channel: { tool: 'clear_song_memory' }, controls: ['[data-role=song-memory-clear]'] },
  { id: 'delete_memories', label: '删除一个角色的记忆（进回收站）', description: '把一个角色的聊天记忆、或画像和日记放进回收站，期限内能找回，到期才清理。她记得的计划、回顾、她的笔记和最打动的那件事跟画像进同一项，找回时一起回来。', category: 'memory',
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
    '@pose-sensing 「已有离线组件包？导入…」', '@pose-sensing 「导入离线组件包…」', '@face-check 「导入离线组件包…」'], '要你在文件对话框里选文件；任意读文件不开放。'),
  setting('read_aloud', 'providers', ['#voice-enabled'], { alsoTools: ['set_read_aloud'] }),
  setting('voice_rate', 'providers', ['#voice-rate']),
  setting('voice_mood_influence', 'providers', ['#voice-mood']),
  setting('voice_first_chunk', 'providers', ['#voice-first-chunk']),
  setting('pause_talk', 'providers', ['#voice-pause-talk'], { levelNote: `打开时需要（每条回复多问一次 haiku，会用你的 ${ASSISTANT_NAME} 用量）；关掉直接改` }),
  // 边说边演 (docs/claude/2026-11-20-speech-beats-2-4.md): saved with the channel switches; not open to the channel for now.
  never('speech_beats', `边说边演（${ASSISTANT_NAME} 编排）`, 'providers', ['#speech-beats'],
    `它改的是每条回复用掉多少你的 ${ASSISTANT_NAME} 用量（提示词多一段），先不经内部通道开放；只能你自己在设置里点。`,
    '她说话时表情和小动作跟着每句话走，有时只用表情回你（聊天页一行灰色小字）。默认开；你点过的选择优先。'),
  gap('system_voice_name', '用哪个系统声音', 'providers', '朗读用电脑上的哪一个系统声音。', '声音名', 'direct', ['#voice-select'],
    '系统声音的名单只有窗口里读得到（各台电脑不同），通道看不到，还没有接口。'),
  { id: 'voice_preview', label: '试听语音', description: '用当前语音方案读一句固定的话。百炼会产生一次付费调用。', category: 'providers', values: '一次试听', level: 'user-words',
    levelNote: '百炼或 Drama 3 试听会花钱：带了原话也会弹窗；系统声音试听不花钱，带原话就直接试听',
    channel: { tool: 'voice_preview', read: '—' }, controls: ['#test-voice', '#tts-preview', '#tts-preview-panel'] },
  ui('voice_preview_controls', '试听文字和停止试听', 'providers', ['#tts-preview-text', '#tts-stop'], '只影响设置窗口里的这一次试听。'),
  setting('readout_volume', 'providers', ['#voice-volume']),
  setting('voice_provider', 'providers', ['#tts-provider']),
  never('tts_connection', '百炼连接地址和地域', 'providers', ['#tts-api-host', '#tts-region'], '改连接地址可能把你的密钥发到别处，只能你自己改。'),
  never('tts_key', '百炼密钥', 'providers', ['#tts-api-key', '#tts-clear-key'], '密钥永远不经过内部通道和聊天。'),
  // I-070 Drama 3 (Fish Audio): the key stays the user's own; the character's own voice id and acting style go through set_voice_style.
  never('tts_fish_key', 'Drama 3（Fish Audio）密钥', 'providers', ['#tts-fish-key', '#tts-fish-clear-key'], '密钥永远不经过内部通道和聊天。'),
  // 2026-11-24: the monthly limit through set_setting (the user's words and the dialog every time); the item keeps its id for 「带我去」.
  setting('drama3_monthly_limit', 'providers', ['#tts-fish-cap'], { id: 'tts_fish_cap', levelNote: '每次改都要用户原话，带了也弹窗；不能撤回' }),
  ui('tts_fish_pages', 'Fish Audio 的「API 密钥」和「API 账单」页', 'providers', ['#tts-fish-open-keys', '#tts-fish-open-billing'], '只是在浏览器里打开这两个固定网页。'),
  // I-065: the same fields the 「百炼语音」 page saves; never the key, the API host or the region.
  { id: 'tts_voice_style', label: '云端朗读的模型、音色和表达风格', description: '百炼的模型（所有角色共用），这个角色和这个模型的音色、情绪、风格文字和语速，以及 Drama 3 当前角色的声音编号和表演提示。不碰任何密钥、连接地址、地域和 Drama 3 的每月上限；本身不合成声音、不花钱。',
    category: 'providers', values: '模型 id、音色 id、情绪、风格文字、语速、Drama 3 声音编号、表演提示、这个角色的朗读声音（只能设跟随默认或系统语音，百炼和 Drama 3 用 set_character_voice；她自己已是 Drama 3 时声音编号会一起填进去）', level: 'direct', channel: { tool: 'set_voice_style', read: '—' },
    controls: ['#tts-model', '#tts-voice', '#tts-emotion', '#tts-instruction', '#tts-rate', '#tts-save', '#tts-fish-voice', '#tts-fish-acting', '#tts-her-voice'] },
  ui('tts_guides', '百炼控制台和开通说明', 'providers', ['#tts-open-console', '#tts-open-guide', '@tts-introduction'], '只是打开说明或网页。'),

  // ——— Claude 任务
  never('claude_tasks', `${ASSISTANT_NAME} 任务（读写文件、运行命令）`, 'agent', ['@codex-tasks'], '任务执行会运行命令、读写文件，永远不开放给内部通道和聊天；开关和每一步批准都只能你自己点。'),
  // I-071 v2 第二步: the assistant itself is the user's own surface; it acts through the tools above, never on its own page.
  never('claude_assistant', `${ASSISTANT_NAME} 助手（控制窗口里你自己的 ${ASSISTANT_NAME}）`, 'agent', ['@assistant-panel'], '和它说话、换它的模型和思考强度、清空它的对话，只能你在这一页自己点；它要动手时用的就是内部通道这些工具，要你同意的都会弹窗。'),

  // ——— 隐私与设置
  setting('developer_mode', 'privacy', ['#open-mood']),
  setting('voice_input', 'privacy', ['#runtime-voice'], { level: 'user-words', levelNote: '打开时需要；关掉直接改', alsoTools: ['set_perception'] }),
  // I-091 像打语音电话一样和她聊天: the 打电话 / 挂断 button sits in both windows' chat box (made by src/voice/voice-call/call-controls.ts, not a settings control).
  setting('voice_call', 'privacy', [], { level: 'user-words', levelNote: '开始通话时需要（还会弹窗）；挂断直接改' }),
  { id: 'screen_sharing', label: '屏幕共享', description: '让她看到桌宠所在的屏幕。默认关。', category: 'privacy', values: ON_OFF, level: 'user-words', levelNote: '打开时需要；关掉直接改',
    channel: { tool: 'set_perception', args: { kind: 'screen' }, read: 'get_status → perception.screen' }, controls: ['#runtime-screen'] },
  // I-036: the camera is two independent switches; this row is the old single one (on: 姿势识别; off: both off).
  { id: 'camera_sharing', label: '摄像头共享', description: '两个开关任一开着就算开：发图片、姿势识别。用这一项打开等于打开姿势识别；关掉两个都关。默认关。', category: 'privacy', values: ON_OFF, level: 'user-words', levelNote: '打开时需要；关掉直接改',
    channel: { tool: 'set_perception', args: { kind: 'camera' }, read: 'get_status → perception.camera' }, controls: ['#runtime-camera', '#runtime-camera-images'] },
  { id: 'camera_images', label: '摄像头发图片', description: '开着时她能看你：平时发消息不附图（用她自己看你一眼记下的一句话），叫她看时发清楚的一张；不用下载。默认关。', category: 'privacy', values: ON_OFF, level: 'user-words', levelNote: '打开时需要；关掉直接改',
    channel: { tool: 'set_perception', args: { kind: 'camera_images' }, read: 'get_status → perception.cameraImages' }, controls: ['#runtime-camera-images'] },
  { id: 'camera_pose', label: '摄像头姿势识别', description: '识别你在不在、朝向、坐着还是站着、动作幅度、挥手，以及你在画面里的位置、离屏幕大概多远和身体各个点的坐标（她用来看向你）；只在这台电脑上算，不保存、不上传，画面不离开电脑。打开就算用户同意她用这些；第一次要下载组件。默认关。', category: 'privacy', values: ON_OFF, level: 'user-words', levelNote: '打开时需要；关掉直接改',
    channel: { tool: 'set_perception', args: { kind: 'camera_pose' }, read: 'get_status → perception.cameraPose' }, controls: ['#runtime-camera'] },
  // I-135 认出"不是你": only the user's own face, as numbers, encrypted, on this computer; only "is it you".
  { id: 'face_check', label: '认出是不是你（Beta）', description: '摄像头开着时，她在这台电脑上看一眼坐在电脑前的是不是你；明显不是你时她会客气疏远一点，偏爱只给你，拿不准都当成是你。只记你自己的脸（一串数字，不是照片），加密存在这台电脑上，随时一键删除；不认别人是谁，也不存别人。第一次打开要下载识别组件；登记要在控制窗口里看着摄像头几秒。默认关。', category: 'privacy', values: ON_OFF, level: 'user-words', levelNote: '打开时需要；关掉直接改',
    channel: { tool: 'set_perception', args: { kind: 'face_check' }, read: 'get_status → perception.faceCheck' }, controls: ['#face-check-toggle', '@face-check 「重试下载」'] },
  never('face_check_data', '登记、删除我的脸部数据', 'privacy', ['@face-check 「登记我的脸」', '@face-check 「取消」', '@face-check 「删除我的脸部数据」', '@face-check 「删除识别组件」'],
    '登记要你本人看着摄像头；删除脸部数据和识别组件是永久删除。都只能你自己在控制窗口里点，不开放给内部通道和聊天。'),
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
  { id: 'interconnect', label: '三方互通', description: `你的 ${ASSISTANT_NAME}、和她聊天、设置互相通着。通道只能把它关掉（关掉后通道也断开）。`, category: 'privacy',
    values: '关（on 只在你手动开着通道、关了三方互通时能用，而且要弹窗确认）', level: 'direct', channel: { tool: 'set_interconnect', read: 'get_status → interconnect' },
    controls: ['[data-agent-channel=interconnect]'] },
  never('agent_channel_switch', '内部通道开关', 'privacy', ['[data-agent-channel=enabled]'], '通道开关是安全设置，只能你自己点；三方互通开着时它一直开。'),
  never('claude_code_link', `重新接上 ${ASSISTANT_CLI_NAME}`, 'privacy', ['[data-agent-channel=relink]'], `要运行 claude 命令改你的 ${ASSISTANT_CLI_NAME} 配置；运行命令不开放。`),
  { id: 'undo_last_action', label: `撤回 ${ASSISTANT_NAME} 的上一步`, description: `撤回 ${ASSISTANT_NAME} 最近一次能撤回的操作（30 分钟内）。`, category: 'privacy', values: '一次操作', level: 'direct',
    channel: { tool: 'undo_last_action', read: '—' }, controls: ['[data-agent-channel=undo]'] },
  ui('agent_channel_copy', '复制接入命令', 'privacy', ['[data-agent-channel=copy-claude-code]', '[data-agent-channel=copy-desktop-config]'], '只是复制文字。'),
  ui('agent_channel_diagnostics', '复制诊断信息', 'privacy', ['[data-agent-channel=copy-diagnostics]'], '只是把版本、系统、通道状态和最近问题的类别复制成文字（I-061）；不含聊天、路径、密钥，也不发送到任何地方。'),
  setting('recycle_bin_days', 'privacy', ['[data-recycle=days]']),
  { id: 'restore_memories', label: '从回收站找回记忆', description: `把回收站里的一项放回原处：${ASSISTANT_NAME} 删掉的聊天记忆、画像和日记，删掉的角色（连同她的记忆），单独删掉的笔记、最打动的那件、一起听的笔记，以及你在各个面板里单条删掉或清空的东西（一段聊天、听到的声音文字、一起听的原文、她记得的歌、画像的一条、一天或全部日记、回顾、计划、称呼、文字纪念、我们的小东西、和 ${ASSISTANT_NAME} 助手的对话）。`, category: 'privacy', values: '回收站编号', level: 'direct',
    channel: { tool: 'restore_memories', read: 'list_recycle_bin' }, controls: ['[data-recycle=restore]'] },
  never('recycle_delete_for_good', '回收站：永久删除', 'privacy', ['[data-recycle=delete-for-good]'], '永久删除只在回收站里由你自己点、再确认一次；不经内部通道。'),
  setting('feed_recognition', 'privacy', ['#feed-recognition-enabled'], { levelNote: '打开时需要；关掉直接改' }),
  // I-027: turning it on spends the user's Claude quota (haiku, at most 200 calls a day), so it needs the user's own words.
  setting('mood_judge', 'privacy', ['#mood-judge-enabled'], { levelNote: `打开时需要（会用你的 ${ASSISTANT_NAME} 用量）；关掉直接改` }),
  // I-037: one haiku call per message (the user's Claude quota); on by default in every version (2026-11-07). Turning it on needs the user's own words.
  setting('new_reactions', 'privacy', ['#reactions-enabled'], { levelNote: `打开时需要（会用你的 ${ASSISTANT_NAME} 用量）；关掉直接改` }),
  setting('proactive_talk', 'chat', ['#proactive-talk']),
  // I-085: one haiku call per look of hers (the user's Claude quota), only with 「发图片」 on. Turning it on needs the user's own words.
  setting('self_look', 'privacy', ['#self-look'], { levelNote: `打开时需要（会用你的 ${ASSISTANT_NAME} 用量）；关掉直接改` }),
  setting('user_activity', 'privacy', ['#user-activity-enabled'], { levelNote: '默认开；关掉直接改，重新打开时需要（它是一种新的感知）' }),
  setting('experience_journal', 'privacy', ['[data-journal=enabled]']),
  // I-117: which region's help line the safety card shows first (the card itself is not a setting: it only appears on a clear danger sign).
  setting('crisis_region', 'privacy', ['#crisis-region']),
  // 2026-11-23: where she stands every time she comes out in full-screen Unbound. Its button lives in the full-screen small panel (「设为默认位置」), not the settings window.
  setting('unbound_default_place', 'appearance', [], { levelNote: '不需要用户原话；她在全屏里站着时才能设（站在哪就记哪）' }),
  ui('journal_filter', '体验记录按角色筛选', 'privacy', ['[data-journal=filter]'], '只是在设置窗口里筛选。'),
  never('reset_settings', '重置应用设置', 'privacy', ['#reset-settings', '#confirm-reset'], '会清除配置、密钥和当前对话，不可撤回，只能你自己点。'),
  never('quit_app', '退出应用', 'privacy', ['#quit-app'], '退出后通道也断开，只能你自己点。'),
  gap('profile_recording', '允许记录用户画像', 'privacy', '她会不会把你说的事记进画像。', ON_OFF, 'user-words', ['@user-profile-panel 「允许记录*」'],
    '这个开关按当前角色和连接分开，要带上画像面板读到的那一份的编号才能改，还没有通道接口。'),
  never('profile_edit', '改或删画像、日记、她记得的事、称呼和文字纪念', 'privacy', ['@user-profile-panel textarea', '@user-profile-panel select', '@user-profile-panel input',
    '@user-profile-panel 「保存修改」', '@user-profile-panel 「删除」', '@user-profile-panel 「修改日记」', '@user-profile-panel 「删除这天的日记」', '@user-profile-panel 「清空全部日记」',
    '@user-profile-panel 「删除这件事」', '@user-profile-panel 「清空她记得的事」',
    '@user-profile-panel 「保存称呼」', '@user-profile-panel 「删除称呼」', '@user-profile-panel 「保存纪念修改」', '@user-profile-panel 「删除纪念」'],
  '她的画像、日记、她记得的你的计划（P-001）、给你的称呼和文字纪念只由你自己改；单条删除和清空都先进回收站，能在旁边的「最近删除的」找回（I-144b），但删除只由你自己在界面上点，不开放给内部通道。要删一个角色的全部画像和日记，用 delete_memories 先放进回收站。'),
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

/**
 * 敏感操作弹窗: a call through the channel opens the soft hearts dialog even with the user's words (三方互通 on):
 * a setting whose `consent` is not "behavior", or one of AGENT_ALWAYS_DIALOG_TOOLS (set_perception: opening; voice_preview: a paid voice).
 */
export function capabilityAlwaysDialog(entry: CapabilityEntry): boolean {
  if (entry.level !== 'user-words' || !capabilityChannel(entry)) return false;
  const spec = capabilitySetting(entry);
  if (spec) return settingAlwaysDialog(spec);
  return !!entry.channel && 'tool' in entry.channel && AGENT_ALWAYS_DIALOG_TOOLS.includes(entry.channel.tool);
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
