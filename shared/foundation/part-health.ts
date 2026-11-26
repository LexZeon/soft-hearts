// 一部分关了 (overhaul step 7, docs/claude/2026-11-17-isolation-step7.md; plan docs/claude/2026-11-16-wiring-rewrite-plan.md section 3).
// The closed table of the app's parts and their units (one per createX in electron/wiring/<part>-wiring.ts; tests/part-health.test.ts keeps
// it equal to every PartHandle's `units`), their names in the user's words, and the notices' texts. The journal's part-off line, the
// control window's banner, the tray line and get_status / get_diagnostics all read this table: a part or unit not in it is never shown
// or written. No Electron, no DOM.
import type { PartHealthView, PartOffView } from './ports';

/** Each part's name in the control window (the parts' own names: handbook/architecture.md). */
export const PART_LABELS = {
  cards: '角色卡', actions: '身体动作', settings: '设置', unbound: 'Unbound', safety: '连接任务和安全', voice: '声音', senses: '感知',
  memory: '记忆', initiative: '主动', mood: '心情', stage: '舞台', brain: '大脑',
} as const;
export type PartId = keyof typeof PART_LABELS;

/** Every unit of every part, with its name in the user's words. Core units are listed too (they are never switched off). */
export const UNIT_LABELS = {
  cards: { cards: '角色卡', responses: '反应设定', 'personalize-language': '个性化语言', switch: '换角色', roster: '角色名册', avatars: '小头像',
    'card-update': '角色卡更新', understanding: '理解讨论', stickers: '贴图' },
  actions: { 'bundled-assets': '内置模型和动作', 'her-actions': '她的动作', 'body-motion': '身体动作', gesture: '手势', 'behavior-motion': '行为动作',
    'motion-fits': '动作适配', 'motion-library': '动作库', 'motion-coverage': '动作覆盖', 'motion-packs': '动作包', 'asset-pick': '选模型和动作' },
  settings: { 'companion-commands': '陪伴命令', framing: '取景', sync: '设置同步', save: '保存设置', 'ui-language': '界面语言' },
  unbound: { unbound: 'Unbound（试验）' },
  safety: { 'crisis-card': '求助卡', 'test-commands': '测试命令', 'claude-tasks': 'Claude 任务', 'agent-channel': '内部通道', assistant: 'Claude 助手' },
  voice: { 'reply-speech': '朗读回复', 'speech-runtime': '朗读', 'voice-call': '语音通话', 'call-vad': '通话断句', 'call-streaming': '通话边说边读',
    'fish-budget': 'Drama 3 额度', 'speech-diagnostics': '朗读诊断', 'speech-playback': '播放', 'speech-preview': '试听' },
  senses: { 'pose-sensing': '姿势感知', 'face-check': '认出你', 'local-asr': '本机语音识别', 'user-activity': '你在不在', 'ambient-audio': '一起听',
    'audio-capture': '声音采集', 'audio-reading': '读取音频', 'listen-together': '一起听的记录', 'watch-together': '一起看', 'system-audio': '电脑的声音',
    'voice-route': '语音输入路线', 'ambient-asr': '环境语音识别', 'foreground-asr': '语音输入识别', 'voice-host': '语音输入', media: '摄像头和屏幕',
    'camera-samples': '摄像头画面', 'screen-snapshots': '屏幕画面', 'look-turns': '看一眼', 'look-attachments': '发图片', 'camera-glance': '摄像头一瞥',
    'camera-eye': '摄像头视线', 'closer-look': '凑近看', 'screen-glance': '屏幕一瞥', 'watch-along': '和她一起看', 'user-gaze': '你看她',
    'vision-presentation': '画面呈现', 'proactive-vision': '她主动看', 'visual-self': '她看自己', 'vision-support': '看图能力', 'music-settings': '音乐设置' },
  memory: { 'user-profiles': '用户画像', diary: '日记', 'period-review': '周回顾和月回顾', 'her-note': '她的小记', 'moving-memory': '心动的记忆',
    'text-memorials': '文字纪念', upcoming: '她记得的计划', 'memory-semantic': '按意思回想', 'memory-notes': '聊天小记', 'recycle-bin': '回收站' },
  initiative: { 'proactive-speech-gate': '主动说话', 'sense-router': '看一眼听一下', 'self-look': '她自己想看你', rps: '猜拳', feeding: '喂她吃东西',
    'take-me-there': '带我去', 'her-folder': '她的文件夹', keepsake: '留给你的', 'special-day': '特别的日子', give: '递东西', hands: '牵手',
    'inner-loop': '她自己的念头', impulse: '想找你说话', 'r20-offers': '任务提议', moments: '她认出的时刻' },
  mood: { 'mood-judge': '心情判断', reactions: '反应', touch: '触碰', 'fatigue-activity': '困倦', 'blush-calibration': '脸红校准', 'realer-expiry': '更真实的情绪' },
  stage: { 'pet-window': '桌宠窗口', 'reply-window': '回复气泡', presentation: '出场', 'pointer-input': '鼠标', 'window-drag': '拖动', topmost: '置顶',
    'single-emoji': '单个表情', 'body-pose': '身体姿势', 'personalize-authoring': '个性化编写', 'expression-preview': '表情预览', 'her-life-motion': '她自己的生活',
    'model-profile': '模型档案', 'model-capability': '模型体检', 'physics-settings': '物理设置' },
  brain: { companion: '聊天和心情', 'claude-chat': 'Claude 聊天', 'chat-turn': '聊天', 'chat-outage': '连不上时', 'module-router': '话题分流', 'pause-talk': '停停说说',
    'reply-rhythm': '回复节奏', 'reply-latency': '回复用时', 'chat-settings': '聊天设置', 'chat-incidents': '聊天故障记录', 'greeting-archive': '问候' },
} as const satisfies { readonly [P in PartId]: Readonly<Record<string, string>> };

/** A part's units, in the table's order. */
export function partUnits(part: string): readonly string[] {
  return Object.prototype.hasOwnProperty.call(UNIT_LABELS, part) ? Object.keys(UNIT_LABELS[part as PartId]) : [];
}
export function isPartUnit(part: unknown, unit: unknown): part is PartId {
  return typeof part === 'string' && typeof unit === 'string' && partUnits(part).includes(unit);
}
export function partLabel(part: string): string {
  return Object.prototype.hasOwnProperty.call(PART_LABELS, part) ? PART_LABELS[part as PartId] : '';
}
export function unitLabel(part: string, unit: string): string {
  return isPartUnit(part, unit) ? (UNIT_LABELS[part] as Readonly<Record<string, string>>)[unit] : '';
}

/** A switched-off unit's reason: `<start|tick|callback>:<error.name>`, nothing else. */
export const PART_OFF_REASON = /^(start|tick|callback):[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** Fills `{0}`, `{1}` …: what a translator (the window's uiText) does in Chinese. */
export type PartHealthTranslate = (source: string, ...values: readonly unknown[]) => string;
const plain: PartHealthTranslate = (source, ...values) => source.replace(/\{(\d+)\}/g, (marker, index: string) => Number(index) < values.length ? String(values[Number(index)]) : marker);

/** The plan's texts (section 3), as they are (translated through `tr` in the window: shared/foundation/ui-copy.part-health.en.ts). */
export function partOffNotice(entry: Pick<PartOffView, 'part' | 'unit' | 'when'>, tr: PartHealthTranslate = plain): string {
  const part = tr(partLabel(entry.part) || entry.part), unit = tr(unitLabel(entry.part, entry.unit) || entry.unit);
  return entry.when === 'start'
    ? tr('{0}（{1}）这次没能启动，我先把它单独关掉了，别的都照常。重启 soft hearts 通常就好；还不行的话，点「复制诊断信息」发给 Claude。', part, unit)
    : tr('{0}刚才连续出错，先关掉了，别的照常；重启后会再试。', part);
}
/** Beside a switch whose unit is off. */
export const PART_OFF_SWITCH_NOTE = '这部分暂时关了';
/** What a privacy action answers while a unit whose data it would touch is off (plan section 3: never half a deletion). */
export const PRIVACY_PART_OFF_MESSAGE = '有一部分没启动，暂时不能删，重启后再试。';
/** The fatal dialog's text (a core unit did not start). */
export function fatalStartNotice(part: string, category: string, tr: PartHealthTranslate = plain): string {
  return tr('soft hearts 没能启动：{0}没有准备好（{1}），所以没有继续。请重启试试；还不行，把这段话告诉 Claude。', tr(partLabel(part) || part), category);
}
/** The tray's one line while anything is off (empty when nothing is). */
export function partHealthTrayLine(view: PartHealthView | null | undefined, tr: PartHealthTranslate = plain): string {
  const off = view?.off ?? [];
  if (!off.length) return '';
  const parts = [...new Set(off.map(entry => tr(partLabel(entry.part) || entry.part)))];
  return tr('有一部分暂时关了：{0}', parts.join(tr('、')));
}
/** A desk: call answered PART_OFF (electron/wiring/parts-wiring.ts PartOffError): the window shows the switch note, not the raw error. */
export function isPartOffMessage(message: unknown): boolean {
  return typeof message === 'string' && /\bPART_OFF\b/.test(message);
}
/** get_status / get_diagnostics: which units are off, as `<part>/<unit>` (closed words only). */
export function partsOffList(view: PartHealthView | null | undefined): string[] {
  return (view?.off ?? []).filter(entry => isPartUnit(entry.part, entry.unit)).map(entry => `${entry.part}/${entry.unit}`);
}
