// 「带我去」 places added by I-163 (new features were missing from 带我去 / 帮我打开). Data only: one place is a page or
// section of the control window (a navigation leaf of src/settings/control-navigation-state.ts), the title on the button, and the words
// a user says for it. A place only ever opens a page and flashes the item; it never turns a switch on or off. The privacy, paid and
// permission switches keep their own consent rules (a card in her chat, the user's words on the channel, a dialog).
//
// To add a page or switch to the app: add its place here (or point it at an existing one in take-me-there-coverage.ts) and add the
// English title to shared/foundation/ui-copy.take-me-there.en.ts. tests/take-me-there-coverage.test.ts fails until you do.

export interface TakeMeTherePlace {
  readonly leafId: string;
  readonly title: string;
  /** What users call it; a name must be specific enough that saying it next to "去 / 打开 / 在哪" means this page. */
  readonly names: readonly string[];
}

const place = (leafId: string, title: string, ...names: string[]): TakeMeTherePlace => ({ leafId, title, names });

export const TAKE_ME_THERE_PLACES = {
  // I-173: the chat page itself (talking to her, and where the "chat is unavailable" notice with its buttons shows).
  'chat-page': place('chat-messages', '聊天', '聊天页', '聊天页面', '聊天界面', '和她聊天的地方'),
  // Developer mode (a button on the 隐私与设置 page) and what only shows inside it. Opening never turns developer mode on.
  'developer-mode': place('privacy-developer', '开发者模式', '开发者模式', '开发模式', '开发者面板', '开发者选项'),
  'physics-lab': place('privacy-developer', '物理调参台（开发者模式里）', '物理调参台', '物理窗口', '物理实验室', '物理调参', '调参台', '物理参数', '软体调参', '果冻调参'),
  'unbound-lab': place('privacy-developer', 'Unbound 试验开关（开发者模式里）', 'Unbound试验', 'Unbound 试验', 'Unbound设置', 'Unbound 设置', 'Unbound的设置', 'Unbound 参数'),
  // The stable channel's switches that start off (让她出来, 碰了才软).
  'trial-features': place('privacy-channel-gates', '还在试用的功能', '还在试用的功能', '试用的功能', '试用功能', '试验功能', '试用开关'),
  'unbound-entry': place('privacy-channel-gates', '让她出来（Unbound）', '让她出来', 'Unbound', 'unbound', '出来玩', '她出来'),
  'touch-soft': place('privacy-channel-gates', '碰了才软', '碰了才软', '拉她', '拉伸', '果冻', '软一点', '软体', '陷下去'),
  // The companion window's own switches (显示桌宠, 始终置顶, 鼠标穿透).
  'companion-window': place('privacy-pet', '桌宠窗口（置顶、鼠标穿透）', '穿透模式', '鼠标穿透', '点击穿透', '穿透', '始终置顶', '置顶', '桌宠窗口', '显示桌宠'), // no-pet-ok: privacy-pet is the existing navigation leaf id
  // Voice and call.
  voiceprint: place('voiceprint', '只认你的声音', '只认你的声音', '只认我的声音', '声纹', '认我的声音', '认你的声音'),
  'voice-input': place('voice-input-config', '语音输入', '语音输入设置', '识别方式', '语音识别', '本机语音识别'),
  // Chat memory, the profile drawer and the things she keeps.
  'user-profile': place('chat-profile', '用户画像 · 称呼表', '称呼表', '用户画像', '她对我的称呼', '我对她的称呼', '画像', '日记'),
  'moving-memory': place('memory-moving', '最打动她的一件事', '最打动她的一件事', '最打动她', '打动她的事'),
  'our-things': place('memory-our-things', '我们的小东西', '我们的小东西', '小点心', '她给我的东西', '零食记录'),
  'people-things': place('memory-people-things', '你生活里的人和事', '人和事', '叫法归并', '人物称呼', '她认识的人'),
  'memory-search': place('memory-query', '查找记忆', '查找记忆', '搜索记忆', '翻记忆', '看记忆', '记忆列表'),
  // The assistant's how-to for touching her (摸头、捏脸、喂零食、牵手 are gestures on her body, not a page; the assistant knows where).
  'touching-help': place('assistant-chat', 'Claude 助手 · 问怎么摸她、喂零食', '摸头', '摸她', '摸你', '捏脸', '喂零食', '喂你零食', '牵手', '触摸手册'),
  // Characters. I-173: deleting a card comes first (its names say 删除, so 「怎么删除角色卡片」 is not the plain wall); the tile's 「更多」 has it.
  'delete-character': place('character-wall', '角色卡片 · 更多 → 删除', '删除角色', '删掉角色', '删角色', '删除角色卡', '删掉角色卡', '删除这个角色'),
  'characters-page': place('character-wall', '角色', '角色页', '角色卡片', '换角色', '切换角色', '角色列表', '角色墙'),
  'character-voice': place('character-voice', '她的声音', '她的声音', '角色的声音', '角色声音', '换她的声音', '声音描述', '兼容提示词', '新角色的默认声音'), // I-162 step 2
  'character-persona': place('character-cards', '人设与心情模板', '人设', '心情模板', '改人设', '性格设置', '台词设置'),
  'character-response': place('character-response', '按心情反应细调', '反应细调', '心情反应', '按心情反应'),
  'blush-calibration': place('character-blush', '模型红晕校准', '红晕校准', '脸红校准', '红晕', '脸红位置'),
  'reaction-dispositions': place('character-reaction-dispositions', '她的反应倾向', '反应倾向', '害羞程度', '黏人程度'),
  // Model, motion, physics, camera, small expressions, natural behaviour.
  'bundled-model': place('model-gene', '预装 Gene 模型', '预装模型', '预装Gene', '换回Gene', '换回 Gene'),
  motion: place('motion-bundled', '动作库', '动作库', '预装动作', '本地动作', 'VMD', '动作设置'),
  physics: place('physics-hair', '头发和胸部物理', '头发物理', '胸部物理', '头发跟随', '胸部弹性', '物理质量', '物理开关'),
  'stage-camera': place('camera-values', '镜头', '镜头设置', '调镜头', '取景', '全身取景', '半身取景', '镜头角度'),
  'single-emoji': place('appearance-emoji', '独立表情与贴纸', '独立表情', '角色贴纸', '表情贴纸', '贴纸'),
  'natural-motion': place('natural-gaze', '自然表现', '视线跟随', '呼吸幅度', '渲染帧率', '帧率', '自然表现'),
  // Connection and voice output.
  'chat-model': place('provider-model', '聊天模型', '聊天模型', '换聊天模型', '换模型档位', '聊天连接'),
  // Privacy and settings sections.
  'face-check': place('privacy-face-check', '认出是不是你（Beta）', '认出是不是你', '认脸', '脸部识别', '登记我的脸', '登记脸'),
  'pose-sensing': place('privacy-pose-sensing', '本机姿态感知组件', '姿态感知', '姿势识别组件', '感知组件'),
  'ui-language': place('privacy-ui-language', '界面语言', '界面语言', '界面换成', '换成英文界面', '换界面语言'),
  'agent-channel': place('privacy-agent-channel', 'Claude 内部通道', '内部通道', '三方互通', '通道设置', '接入命令'),
  'feed-recognition': place('privacy-feed', '喂食认图', '喂食认图', '认图', '喂食设置'),
  'proactive-talk': place('privacy-proactive-talk', '她主动找你说话', '主动找我说话', '主动说话', '主动聊天', '主动搭话'),
  'crisis-region': place('privacy-crisis-region', '所在地区（求助信息用）', '所在地区', '求助信息', '求助电话', '我在哪个地区'),
  'user-activity': place('privacy-user-activity', '知道你是不是在忙', '知道我在不在忙', '在不在忙', '忙不忙'),
  'mood-judge': place('privacy-mood-judge', '心情调整员', '心情调整员', '心情判断', '心情调整'),
  reactions: place('privacy-reactions', '新的反应方式', '新的反应方式', '新反应', '反应方式'),
  journal: place('privacy-journal', '体验记录', '体验记录', '体验日志', '体验记录开关'),
} as const satisfies Readonly<Record<string, TakeMeTherePlace>>;

export type TakeMeTherePlaceId = keyof typeof TAKE_ME_THERE_PLACES;
