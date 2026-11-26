// 「带我去」 (I-051): when the user asks for something she cannot change by chat, the reply gets a button that opens the control
// window's page for it. This module is the local map "说法 → 页面" plus the plain data the host sends; nothing here changes a
// setting or grants a permission, and the renderer only ever holds an id from this closed set. No part of her prompt is involved.

import { TAKE_ME_THERE_PLACES, type TakeMeTherePlaceId } from './take-me-there-places';

export type TakeMeThereId =
  | TakeMeTherePlaceId // I-163: the pages added later (take-me-there-places.ts)
  | 'task-folder' | 'claude-tasks' | 'screen' | 'camera' | 'mic' | 'listen'
  | 'bailian-key' | 'fish-key' | 'voice-scheme' | 'delete-memory' | 'delete-data' | 'import-character' | 'import-model'
  | 'her-folder'
  // I-071 v2 第三步: the character page, where each card has 「转成英文版 / 中文版」; and the Claude 助手 page (navigation only).
  | 'convert-character' | 'claude-assistant';

export interface TakeMeThereDestination {
  /** The control window's navigation leaf (src/settings/control-navigation-state.ts); a test fails when it disappears. */
  readonly leafId: string;
  /** The page's name on the button: 「带我去：<title>」. */
  readonly title: string;
}

const OLD_DESTINATIONS = {
  'task-folder': { leafId: 'agent-scope', title: 'Claude 任务 · 工作目录' },
  'claude-tasks': { leafId: 'agent-switch', title: 'Claude 任务' },
  screen: { leafId: 'privacy-screen', title: '屏幕共享' },
  camera: { leafId: 'privacy-camera', title: '摄像头' },
  mic: { leafId: 'privacy-mic', title: '麦克风' },
  listen: { leafId: 'privacy-mic', title: '电脑声音 · 一起听' },
  'bailian-key': { leafId: 'voice-emotional', title: '百炼语音' },
  'fish-key': { leafId: 'voice-emotional', title: 'Drama 3 语音' }, // I-070: the same page, where the user picks Drama 3 and enters its key
  'voice-scheme': { leafId: 'voice-system', title: '朗读声音' },
  'delete-memory': { leafId: 'memory-list', title: '聊天记忆' },
  'delete-data': { leafId: 'privacy-data', title: '数据与记录' },
  'import-character': { leafId: 'character-add', title: '新增角色' },
  'import-model': { leafId: 'model-local', title: '导入模型' },
  'her-folder': { leafId: 'memory-her-folder', title: '她的文件夹' }, // I-050
  'convert-character': { leafId: 'character-wall', title: '角色卡片 · 转成另一种语言' }, // I-071 v2: the card's 「更多」 has the button
  'claude-assistant': { leafId: 'assistant-chat', title: 'Claude 助手' }, // I-071 v2
} as const satisfies Readonly<Record<Exclude<TakeMeThereId, TakeMeTherePlaceId>, TakeMeThereDestination>>;
export const TAKE_ME_THERE: Readonly<Record<TakeMeThereId, TakeMeThereDestination>> = { ...OLD_DESTINATIONS, ...TAKE_ME_THERE_PLACES };
export const TAKE_ME_THERE_IDS = Object.keys(TAKE_ME_THERE) as TakeMeThereId[];
export const isTakeMeThereId = (value: unknown): value is TakeMeThereId =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(TAKE_ME_THERE, value);

/** What the host sends to the window that owns a reply: show the button, or take it away. */
export interface TakeMeThereView {
  kind: 'take-me-there';
  version: 1;
  offerId: string;
  destination: TakeMeThereId;
  state: 'open' | 'gone';
}
/** The one request the renderer may send back (a tap): the offer it was shown and its destination. */
export interface TakeMeThereRequest { offerId: string; destination: TakeMeThereId }
/**
 * I-173: which item on the page to flash. `anchor` is the id of
 * one element (the window looks it up by id only, never as a selector); `character` is a card id whose tile's 「更多」 menu opens (deleting a
 * card lives there). Navigation only: nothing is clicked, nothing changes.
 */
export interface TakeMeThereFocus { anchor?: string; character?: string }
/** Host → control window: show this page (and, I-173, flash one item on it). */
export interface ControlNavigateRequest extends TakeMeThereFocus { destination: TakeMeThereId }

const ANCHOR_ID = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u;
const CARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** I-173: an element id the window may look up (letters, digits, - and _; never a selector). */
export const isTakeMeThereAnchor = (value: unknown): value is string => typeof value === 'string' && ANCHOR_ID.test(value);
/** I-173: a card id (UUID). */
export const isTakeMeThereCharacter = (value: unknown): value is string => typeof value === 'string' && CARD_ID.test(value);
/**
 * I-173: the one request the host sends the control window, from untrusted parts (the channel's open_control_page, a tap): a known page,
 * and only a well-formed anchor and card id; anything else is dropped (the page still opens), an unknown page gives null.
 */
export function controlNavigateRequest(destination: unknown, focus?: unknown): ControlNavigateRequest | null {
  if (!isTakeMeThereId(destination)) return null;
  const input = focus && typeof focus === 'object' && !Array.isArray(focus) ? focus as Record<string, unknown> : {};
  return { destination, ...(isTakeMeThereAnchor(input.anchor) ? { anchor: input.anchor } : {}),
    ...(isTakeMeThereCharacter(input.character) ? { character: input.character.toLowerCase() } : {}) };
}

// A clause is a stretch without sentence punctuation; a "no" anywhere in it cancels it (别打开摄像头).
// I-173: 别 inside a word (识别、区别、分别、特别、告别、辨别、鉴别、性别、级别、类别) is not a "no": "带我去识别方式" once gave no button.
const NO = /(?<![识区分特告辨鉴性级类])别|不要|不用|不想|不许|不准|不让|禁止|不可以|不能|先别|不必|无需|没必要|不需要/u;
const ASK_BEFORE_LET = "帮我|帮忙|给我|替我|", ASK_AFTER_LET = "|请|麻烦|能不能|能否|可不可以|可以|你能|能帮|想|要|允许|授权|准许|怎么|如何|在哪|去哪|带我";
const OPEN = '(?:打开|开启|启动|启用|开一下|开下|开)';
const END = '(?![上里中左右下边])';
const rx = (source: string) => new RegExp(source, 'iu');

interface Rule { id: TakeMeThereId; /** Explicit action on the thing. */ strong?: RegExp[]; /** Ambiguous wording that counts only with a request word in the same clause. */ weak?: RegExp[] }

// Order matters: the first rule that fits a clause wins. Things she can change by chat (volume, fps, ...) are not here.
// `who` is the regex fragment for whom a request can be addressed to: 你|她 and, at run time, the active character's own name (see requesterWords).
const buildRules = (who: string): readonly Rule[] => [
  // I-050: her own folder comes before the task folder ("给你一个文件夹" is hers; "让她看我的文件夹" stays the task folder).
  { id: 'her-folder', strong: [rx('给(?:你|她)[^，。]{0,6}文件夹'), rx('(?:你|她)的(?:小)?文件夹[^，。]{0,4}(?:在哪|怎么|打开|开启|设置|选)')],
    weak: [rx('(?:你|她)的(?:小)?文件夹')] },
  { id: 'task-folder',
    strong: [rx('(?:选|设|换|给)[^，。]{0,4}(?:工作)?(?:文件夹|目录)')],
    weak: [rx('(?:访问|读取|读|看|查看|浏览|打开|整理|修改|编辑|改|写入|写|搜索|翻|碰|动|管)[^，。]{0,8}(?:文件夹|文件|目录)'),
      rx('(?:文件夹|文件|目录)[^，。]{0,3}(?:权限|访问)'), rx('工作目录')] },
  { id: 'claude-tasks',
    strong: [rx(`${OPEN}[^，。]{0,6}(?:Claude\\s*任务|任务功能|任务模式)`)],
    weak: [rx('Claude\\s*任务|执行任务|运行命令|跑命令|执行命令|跑代码|运行代码|写代码|改代码')] },
  { id: 'screen',
    strong: [rx(`(?:${OPEN}|允许|授权|共享|分享)[^，。]{0,3}?(?:屏幕共享|共享屏幕|分享屏幕|屏幕分享|屏幕)${END}`),
      rx(`(?:屏幕共享|共享屏幕|分享屏幕|屏幕分享)[^，。]{0,3}${OPEN}`)],
    weak: [rx(`让(?:${who})[^，。]{0,4}看[^，。]{0,3}屏幕${END}`), rx(`看[^，。]{0,3}我的屏幕${END}`), rx('屏幕共享|共享屏幕')] },
  { id: 'camera',
    strong: [rx(`(?:${OPEN}|允许|授权)[^，。]{0,3}?(?:摄像头|摄像机|webcam)`), rx(`(?:摄像头|摄像机|webcam)[^，。]{0,3}${OPEN}`)],
    weak: [rx(`让(?:${who})[^，。]{0,4}看[^，。]{0,3}(?:摄像头|摄像机)`), rx('用(?:摄像头|摄像机)'), rx('摄像头|摄像机')] },
  { id: 'listen',
    strong: [rx(`(?:${OPEN}|允许|授权)[^，。]{0,3}?(?:一起听|电脑声音|电脑的声音|系统音频)`)],
    weak: [rx(`让(?:${who})[^，。]{0,3}听[^，。]{0,4}(?:电脑|歌|音乐)`), rx('一起听|电脑声音|电脑的声音|系统音频')] },
  { id: 'mic',
    strong: [rx(`(?:${OPEN}|允许|授权)[^，。]{0,3}?(?:麦克风|语音输入)`), rx(`(?:麦克风|语音输入)[^，。]{0,3}${OPEN}`)],
    weak: [rx('麦克风|语音输入')] },
  { id: 'bailian-key',
    strong: [rx('(?:百炼|dashscope)[^，。]{0,8}(?:密钥|key|api|配置|填|输入)'), rx('(?:密钥|key)[^，。]{0,6}(?:百炼|dashscope)')] },
  { id: 'fish-key',
    strong: [rx('(?:drama\\s*3|fish\\s*audio|fish)[^，。]{0,8}(?:密钥|key|api|配置|填|输入)'), rx('(?:密钥|key)[^，。]{0,6}(?:drama\\s*3|fish\\s*audio)')] },
  { id: 'voice-scheme', strong: [rx('(?:换|切换)[^，。]{0,6}(?:声音|音色|嗓音|语音方案)')] },
  { id: 'delete-memory', strong: [rx('(?:删除|删掉|清空|清除|清理)[^，。]{0,6}记忆')] },
  { id: 'delete-data', strong: [rx('(?:删除|删掉|清空|清除|清理)[^，。]{0,6}(?:聊天记录|记录|对话|数据|日记)')] },
  // I-173: deleting a card (after the memory and data rules, so "删除角色的记忆" stays 'delete-memory').
  { id: 'delete-character', strong: [rx('(?:删除|删掉|删)[^，。]{0,4}(?:角色卡|角色)')] },
  // I-173: the Claude 助手 page had no sentence of its own (navigation only; asking it is the user's own surface).
  { id: 'claude-assistant', weak: [rx('Claude\\s*助手|克劳德助手')] },
  // I-071 v2 第三步: "把你转成英文版" / "我想要一个英文版的你" (not the interface language: "把界面换成英文" has no 你/版/角色).
  { id: 'convert-character',
    strong: [rx('(?:把你|你)[^，。]{0,4}(?:转|变|换|翻译)成[^，。]{0,3}(?:英文|英语|中文)'), rx('(?:转|变|换|翻译)成[^，。]{0,3}(?:英文|英语|中文)(?:版|角色|的你)'),
      rx('(?:英文|英语|中文)版(?:的)?(?:你|角色|角色卡)'), rx('\\b(?:convert|turn|translate)\\b[^,.]{0,30}\\b(?:you|her|character|card)\\b[^,.]{0,12}\\b(?:english|chinese)\\b'),
      rx('\\b(?:english|chinese) version of (?:you|her)\\b')] },
  { id: 'import-character', strong: [rx('(?:导入|新增|添加|新建|创建|加)[^，。]{0,4}(?:角色卡|角色|人设)')] },
  { id: 'import-model', strong: [rx('(?:导入|换|加载|载入|更换|选)[^，。]{0,4}(?:模型|mmd|pmx)')] },
];

// I-163: a place is matched by name only when a "go" word sits next to it (去 / 打开 / 在哪 ...), so just mentioning it is not enough.
const GO_BEFORE = '(?:怎么|如何|带我去|带我到|带我找|带我看|去|到|打开|开一下|开下|开启|进入|进去|找一下|找到|看一下|看看|调一下|调整|设置|怎么(?:打开|进|开|调|设|找)|在哪里?找?)';
const GO_AFTER = '(?:在哪里?|怎么(?:打开|进|开|调|设|找|摸|捏|喂|牵|玩|做|弄)|入口|页面|窗口|设置|开关|打开)';
const escapeText = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const PLACE_RULES: ReadonlyArray<{ id: TakeMeTherePlaceId; patterns: RegExp[] }> = (Object.keys(TAKE_ME_THERE_PLACES) as TakeMeTherePlaceId[]).map(id => ({
  id, patterns: TAKE_ME_THERE_PLACES[id].names.flatMap(name => [rx(`${GO_BEFORE}[^，。]{0,6}${escapeText(name)}`), rx(`${escapeText(name)}[^，。]{0,4}${GO_AFTER}`)]),
}));

/**
 * Whom a request can be addressed to in "让<…>看屏幕": 你, 她, and the active character's own name when the caller passes it (the base name,
 * shared/cards baseCardName, without a language tag). No name is written in this source; an empty or very long name adds nothing.
 */
export function requesterWords(characterName?: unknown): string {
  const name = typeof characterName === 'string' ? characterName.trim() : '';
  return name && name.length <= 40 ? `你|她|${escapeText(name)}` : '你|她';
}
interface RuleSet { rules: readonly Rule[]; ask: RegExp }
const ruleSets = new Map<string, RuleSet>();
function ruleSetFor(who: string): RuleSet {
  let set = ruleSets.get(who);
  if (!set) {
    if (ruleSets.size > 20) ruleSets.clear(); // a few characters at most; a renamed card builds a new set
    set = { rules: buildRules(who), ask: new RegExp(`${ASK_BEFORE_LET}让(?:${who})${ASK_AFTER_LET}`, 'u') };
    ruleSets.set(who, set);
  }
  return set;
}
/**
 * Which page the user's message clearly asks to do or open something on, or null. Chit-chat that merely mentions the thing
 * ("我在看屏幕上的剧", "这个文件好大") and refusals ("别打开摄像头") give null. Pure; no model involved. `characterName`: the active character's base name, see requesterWords.
 */
export function matchTakeMeThere(text: unknown, characterName?: unknown): TakeMeThereId | null {
  if (typeof text !== 'string') return null;
  const { rules, ask } = ruleSetFor(requesterWords(characterName));
  for (const clause of text.slice(0, 1000).split(/[，。！？!?,.;；\n]+/u)) {
    if (!clause.trim() || NO.test(clause)) continue;
    const asked = ask.test(clause);
    for (const rule of rules) {
      if (rule.strong?.some(pattern => pattern.test(clause))) return rule.id;
      if (asked && rule.weak?.some(pattern => pattern.test(clause))) return rule.id;
    }
    for (const rule of PLACE_RULES) if (rule.patterns.some(pattern => pattern.test(clause))) return rule.id;
  }
  return null;
}
