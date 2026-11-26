// 体验记录 (the experience journal): the entry types of the safety part (连接、任务和安全): setting, agent-words, claude-link, part-off.
// shared/memory/journal.ts joins every part's slice and keeps THE BOUNDARY written at its top: a line holds times, the character
// id, a type, fixed enum values, numbers and a plain-language reason from a fixed table; never a word of chat, a file path or a key.
// Moved here from shared/memory/journal.ts on 2026-11-16 (docs/claude/2026-11-16-journal-split.md) without changing a line it writes.
// THE RULE FOR A NEW ENTRY TYPE: it goes into its part's slice, shared/<part>/journal-entries.ts: its input shape in the part's
// <Part>JournalInput, its closed word lists beside it, its case in the slice's three functions (reason, build, describe) and its
// name in <PART>_JOURNAL_TYPES. Then its name goes into JOURNAL_TYPES in shared/memory/journal.ts, valid inputs for it into
// BASES in tests/helpers/journal-behaviour.ts, and both goldens are regenerated (scripts/dev/journal-surface.mjs --write,
// scripts/dev/journal-behaviour.ts --write), saying why in the commit. A part without a slice gets one: a new file like this, one
// entry in each of the four slice tables of shared/memory/journal.ts, and its names on the part's index.ts.
import { finite, has, round, type JournalTranslate } from '../foundation/journal-fields';
import { AGENT_SETTINGS, AGENT_SETTING_STATE_LABELS, AGENT_TOOLS, type AgentSettingId } from './agent-channel';
import { PART_OFF_REASON, isPartUnit, partLabel, unitLabel } from '../foundation/part-health';
import { LINK_FAILURES, LINK_FAILURE_WORDS, LINK_RECORD_STATES, LINK_STATE_REASON, LINK_TRIGGERS, LINK_UNREADABLE, LINK_UNREADABLE_WORDS, plainVersion, smallCount, type LinkFailure, type LinkRecordState, type LinkTrigger, type LinkUnreadable } from './claude-link-diag';
import { ASSISTANT_NAME } from '../foundation/assistant-name';

const SETTING_IDS = AGENT_SETTINGS.map(spec => spec.id);
/** How a setting changed: the channel, a chat card, or (click-through, I-223) the settings page, the tray's rescue, 恢复桌宠, 恢复默认设置. */
export const SETTING_VIAS = ['agent', 'chat', 'settings', 'tray', 'recover', 'reset'] as const;
export type SettingVia = (typeof SETTING_VIAS)[number];
const SETTING_VIA_REASON: Record<SettingVia, string> = { agent: '通过内部通道改了设置', chat: '通过聊天卡片改了设置', settings: '在设置页改了设置', tray: '用托盘菜单改了设置', recover: '点了恢复桌宠，设置跟着恢复', reset: '恢复默认设置时改了设置' };
const AGENT_TOOL_NAMES = AGENT_TOOLS.map(tool => tool.name);
/** I-025: an agent-words line's item when it is neither a setting nor a tool (e.g. a perception kind), and its value as text. */
const WORDS_ITEM = /^[a-z][a-z0-9_]{0,31}$/u;
const WORDS_VALUE = /^[A-Za-z0-9_,.-]{0,32}$/u;
function settingValue(settingId: AgentSettingId, value: unknown): boolean | number | string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (finite(value)) return round(value, 3);
  const spec = AGENT_SETTINGS.find(item => item.id === settingId);
  // A string is only ever one of the catalog's own enum values; any other text is refused.
  if (typeof value === 'string' && spec && spec.kind === 'enum' && spec.choices.some(choice => choice.value === value)) return value;
  return undefined;
}

function describeValue(entry: Extract<SafetyJournalInput, { type: 'setting' }>, value: boolean | number | string | null, tr: JournalTranslate): string {
  if (value === null) return tr('未知');
  const spec = AGENT_SETTINGS.find(item => item.id === entry.id);
  if (spec && spec.kind !== 'number') { const choice = spec.choices.find(item => item.value === value); if (choice) return tr(choice.label); }
  return spec && spec.kind === 'number' ? `${value}${spec.unit}` : String(value);
}

/** The journal entry types of this part, in JOURNAL_TYPES order (shared/memory/journal.ts dispatches by it). */
export const SAFETY_JOURNAL_TYPES = ['setting', 'agent-words', 'claude-link', 'part-off'] as const;

/** What a caller hands to the writer for this part's types (shared/memory/journal.ts JournalInput joins every part's). */
export type SafetyJournalInput =
  | { type: 'setting'; characterId: string | null; id: AgentSettingId; previous: boolean | number | string | null; value: boolean | number | string | null; via: SettingVia }
  /**
   * I-025 需要用户原话: Claude did something that needs the user's consent, on the user's own words in the
   * conversation. Only which item (a setting id or the tool), what it became (a closed short value) and how many characters the
   * words had; never the words themselves. 敏感操作弹窗 (2026-11-12): `dialog` when the soft hearts dialog still asked (sensitive
   * ones), with the user's answer there; a declined one changed nothing.
   */
  | { type: 'agent-words'; characterId: string | null; tool: string; item: string; value: boolean | number | string | null; words: number;
    dialog?: 'allowed' | 'declined' }
  /** I-061 内部通道接 Claude Code: the state of one link check, a closed failure category when it failed, the Claude Code version ("2.1.319") when known, who started it. Never a path, a command line or Claude Code's own output. */
  | { type: 'claude-link'; characterId: string | null; state: LinkRecordState; failure?: LinkFailure; version?: string; trigger: LinkTrigger; unreadable?: LinkUnreadable; rows?: number; headerRepeated?: boolean }
  /**
   * Overhaul step 7 (docs/claude/2026-11-17-isolation-step7.md): the part runner switched one unit off on its own. Which part and unit
   * (closed: shared/foundation/part-health.ts) and why: `failure` is `<start|tick|callback>:<error.name>`, never the error's message.
   * (The plan wrote this field as `reason`; a journal line's `reason` is the fixed plain-language text, so it is `failure` here.)
   */
  | { type: 'part-off'; characterId: string | null; part: string; unit: string; failure: string };

// ---------------------------------------------------------------- the fixed plain-language reasons

/** The fixed reason of this part's entries (shared/memory/journal.ts journalReason). Only enum fields choose it; nothing a caller wrote can reach it. */
export function safetyJournalReason(entry: SafetyJournalInput): string {
  switch (entry.type) {
    case 'setting': return SETTING_VIA_REASON[entry.via];
    case 'agent-words': return entry.dialog === 'declined' ? `照你的原话，${ASSISTANT_NAME} 请求了一件要你同意的事，你在弹窗里没有允许` : `照你的原话，${ASSISTANT_NAME} 做了一件要你同意的事`;
    case 'claude-link': return LINK_STATE_REASON[entry.state];
    case 'part-off': return entry.failure.startsWith('start:') ? '一部分这次没能启动，单独关掉了，别的照常' : '一部分连续出错，单独关掉了，别的照常';
  }
}

// ---------------------------------------------------------------- building a line (the whitelist)

/**
 * This part's lines, field by field from closed sets (shared/memory/journal.ts buildJournalEntry checked the input, the type and the
 * character id, and adds the version, the time and the reason). Null when anything does not fit.
 */
export function buildSafetyJournalEntry(type: string, v: Record<string, unknown>, characterId: string | null): SafetyJournalInput | null {
  let body: SafetyJournalInput | null = null;
  switch (type) {
    case 'setting': {
      if (!has(SETTING_IDS, v.id) || !SETTING_VIAS.includes(v.via as SettingVia)) return null;
      const previous = settingValue(v.id, v.previous), value = settingValue(v.id, v.value);
      if (previous === undefined || value === undefined) return null;
      body = { type, characterId, id: v.id, previous, value, via: v.via as SettingVia };
      break;
    }
    case 'agent-words': {
      // Closed names only: a channel tool, a setting id or the tool itself; a value that is a flag, a number or a short id.
      const value = v.value === null || typeof v.value === 'boolean' || (finite(v.value) && Math.abs(v.value) < 1e6)
        || (typeof v.value === 'string' && WORDS_VALUE.test(v.value)) ? v.value as boolean | number | string | null : undefined;
      if (!has(AGENT_TOOL_NAMES, v.tool) || typeof v.item !== 'string' || !(has(SETTING_IDS, v.item) || has(AGENT_TOOL_NAMES, v.item) || WORDS_ITEM.test(v.item))
        || value === undefined || !Number.isSafeInteger(v.words) || (v.words as number) < 1 || (v.words as number) > 2000
        || (v.dialog !== undefined && v.dialog !== 'allowed' && v.dialog !== 'declined')) return null;
      body = { type, characterId, tool: v.tool, item: v.item, value, words: v.words as number, ...(v.dialog ? { dialog: v.dialog as 'allowed' | 'declined' } : {}) };
      break;
    }
    case 'claude-link': {
      if (!has(LINK_RECORD_STATES, v.state) || !has(LINK_TRIGGERS, v.trigger) || (v.failure != null && !has(LINK_FAILURES, v.failure)) || (v.failure != null && v.state !== 'failed')) return null;
      // A version is exactly three numbers; anything else (a path, a sentence) is dropped, not kept.
      const version = plainVersion(v.version);
      body = { type, characterId, state: v.state, ...(v.state === 'failed' ? { failure: (v.failure ?? 'other') as LinkFailure } : {}), ...(version ? { version } : {}), trigger: v.trigger,
        // 2026-11-12: why an `unverified` row could not be read; a closed category and two small values, dropped when unknown.
        ...(v.state === 'unverified' && has(LINK_UNREADABLE, v.unreadable) ? { unreadable: v.unreadable as LinkUnreadable,
          ...(smallCount(v.rows) !== null ? { rows: smallCount(v.rows)! } : {}), ...(v.headerRepeated === true ? { headerRepeated: true } : {}) } : {}) };
      break;
    }
    case 'part-off': {
      // Closed words only: a part and unit of the table, `<category>:<error.name>`. An error message never fits PART_OFF_REASON.
      if (!isPartUnit(v.part, v.unit) || typeof v.failure !== 'string' || !PART_OFF_REASON.test(v.failure)) return null;
      body = { type, characterId, part: v.part, unit: v.unit as string, failure: v.failure };
      break;
    }
  }
  return body;
}

// ---------------------------------------------------------------- "刚才发生了什么": one plain line per entry

/** This part's entries in the control window, after the time (shared/memory/journal.ts describeJournalEntry); `reason` is the entry's reason, translated. */
export function describeSafetyJournalEntry(entry: SafetyJournalInput, reason: string, tr: JournalTranslate): string {
  let body: string;
  switch (entry.type) {
    case 'setting': {
      const spec = AGENT_SETTINGS.find(item => item.id === entry.id);
      body = tr('{0}「{1}」：{2} → {3}', reason, spec ? tr(spec.label) : entry.id, describeValue(entry, entry.previous, tr), describeValue(entry, entry.value, tr));
      break;
    }
    case 'agent-words': {
      const spec = AGENT_SETTINGS.find(item => item.id === entry.item), tool = AGENT_TOOLS.find(item => item.name === entry.item);
      const label = spec ? spec.label : tool ? tool.title : entry.item;
      const choice = spec && spec.kind !== 'number' ? spec.choices.find(item => item.value === entry.value)?.label : undefined;
      const value = entry.value === null ? '' : choice ?? (typeof entry.value === 'string' ? AGENT_SETTING_STATE_LABELS[entry.value] ?? entry.value
        : spec?.kind === 'number' ? `${entry.value}${spec.unit}` : String(entry.value));
      body = value ? tr('{0}：「{1}」→ {2}（原话 {3} 字）', reason, tr(label), tr(value), entry.words) : tr('{0}：「{1}」（原话 {2} 字）', reason, tr(label), entry.words);
      if (entry.dialog === 'allowed') body = tr('{0}，弹窗里你点了允许', body);
      break;
    }
    case 'claude-link':
      body = tr('{0}（{1}）', reason, [entry.failure ? tr(LINK_FAILURE_WORDS[entry.failure]) : null, entry.unreadable ? tr(LINK_UNREADABLE_WORDS[entry.unreadable]) : null,
        entry.unreadable && entry.rows !== undefined ? tr('名字出现了 {0} 次', String(entry.rows)) : null, entry.headerRepeated ? tr('检查开头的提示出现了不止一次') : null, entry.version ? tr('Claude Code {0}', entry.version) : tr('版本未知'),
        tr(entry.trigger === 'manual' ? '你点了重新接上' : '自动检查')].filter(Boolean).join(tr('，')));
      break;
    case 'part-off':
      body = tr('{0}：{1}（{2}）', reason, tr(partLabel(entry.part)), tr(unitLabel(entry.part, entry.unit)));
      break;
    default: body = reason;
  }
  return body;
}
