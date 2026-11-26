// Agent internal channel: fixed, data-only catalog shared by the host, the MCP shim
// (through the JSON file) and, later, the renderer's options card. Nothing here grants
// authority: the host registry validates and enforces every call.
import catalog from './agent-channel-catalog.json';
import { ASSISTANT_NAME } from '../foundation/assistant-name';

/** `never` actions are not defined, listed or callable; the tier exists so a registry can refuse them explicitly. */
export type AgentPolicyTier = 'read' | 'reversible' | 'confirm' | 'never';
export type AgentExposedTier = Exclude<AgentPolicyTier, 'never'>;
export const AGENT_TIER_LABELS: Readonly<Record<AgentPolicyTier, string>> = Object.freeze({
  read: '只读', reversible: '可撤回，直接执行并提示',
  // I-025: with 三方互通 on these need the user's own words from the conversation (userWords), no dialog.
  // 敏感操作弹窗: the sensitive ones (privacy, spending, deleting, files) also open the dialog with the words.
  confirm: `需要用户原话：三方互通打开时调用要带上 userWords（用户在对话里说的原话），没有就不执行；其中隐私、花钱（包括用你的 ${ASSISTANT_NAME} 用量）、删除、下载或载入文件的，带了原话 soft hearts 也会弹窗，由用户点；关掉三方互通时都在弹窗里确认`, never: '不开放',
});

/**
 * 敏感操作弹窗: why a setting value needs consent (`consent` in the catalog). Everything but `behavior` is sensitive:
 * with 三方互通 on, the external channel's call needs the user's words AND the soft hearts dialog. An unknown or missing reason is
 * sensitive (fail closed).
 */
export const AGENT_CONSENT_REASONS = Object.freeze(['privacy', 'spending', 'delete', 'files', 'behavior'] as const);
export type AgentConsentReason = (typeof AGENT_CONSENT_REASONS)[number];
/**
 * 敏感操作弹窗: tools whose consent-needing calls are always sensitive (set_perception: opening a sense; voice_preview: a paid voice;
 * set_setting goes by each setting's `consent`). The host definitions mark the same ones (tests/sensitive-always-dialog.test.ts).
 */
export const AGENT_ALWAYS_DIALOG_TOOLS: readonly string[] = Object.freeze(['import_character_card', 'update_character_card', 'load_model', 'voice_preview',
  'delete_memories', 'clear_song_memory', 'set_perception', 'convert_character_language', 'delete_character',
  // 2026-11-24: a character's own voice set to a paid provider (spending; docs/claude/2026-11-24-channel-voice-spend.md).
  'set_character_voice']);

export interface AgentToolDescriptor {
  name: string;
  /** Short Chinese label, also used in the "由 Claude 操作" notice. */
  title: string;
  tier: AgentExposedTier;
  /**
   * I-014: only defined while 三方互通 is on (perception switches, memory deletion into the recycle bin). With it off they
   * are refused like an unknown tool, as before.
   */
  interconnectOnly?: boolean;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
}

export type AgentSettingId = 'read_aloud' | 'readout_volume' | 'pet_visible' | 'always_on_top' | 'follow_mouse' | 'breath' | 'fps' | 'slow_warm_up' | 'realer_emotions' | 'experience_journal'
  | 'voice_provider' | 'recycle_bin_days'
  // I-025 语音输入: the microphone switch and the local recognizer's download.
  | 'voice_input' | 'local_asr'
  // I-091 像打语音电话一样和她聊天: a call (the microphone listens continuously while it is on).
  | 'voice_call'
  // I-025 第 3 段: the rest of the settings window that the host can already change by itself.
  | 'click_through' | 'ui_language' | 'developer_mode' | 'music_strength' | 'music_always_dance' | 'voice_rate' | 'voice_mood_influence'
  // I-029: where reading aloud starts (dev comparison of whole sentence vs the first comma).
  | 'voice_first_chunk'
  // F7 停停说说 (default off; turning it on spends the user's Claude quota: one haiku call per reply).
  | 'pause_talk'
  | 'chat_model' | 'proactive_vision' | 'feed_recognition' | 'pose_sensing' | 'physics_hair' | 'physics_chest' | 'physics_quality'
  // I-027 心情调整员 (on by default since 2026-11-07; turning it on spends the user's Claude quota).
  | 'mood_judge'
  // I-006 第 1 步 「知道你是不是在忙」 (default on; turning it ON needs the user's own words, turning it off is direct).
  | 'user_activity'
  // I-037 新的反应方式 (on by default in every version since 2026-11-07; turning it ON spends the user's Claude quota: one haiku call per message).
  | 'new_reactions'
  // 她主动找你说话：少一点 / 适中 / 多一点.
  | 'proactive_talk'
  // I-085 她自己看一眼 (default on; turning it ON spends the user's Claude quota: one haiku call per look, at most 4 an hour).
  | 'self_look'
  // I-117 所在地区（求助信息用）: which region's help line the safety card shows first (direct; no privacy or quota).
  | 'crisis_region'
  // 2026-11-23 全屏里她出来的位置: the place she starts at every time out in Unbound (default: set where she stands now; none: no default). Direct, nothing private.
  | 'unbound_default_place'
  // 2026-11-24 Drama 3 每月上限: spending, so every value needs the user's words AND the dialog (tier confirm).
  | 'drama3_monthly_limit';
export type AgentSettingValue = boolean | number | string;
export interface AgentSettingChoice<V extends AgentSettingValue = AgentSettingValue> { value: V; label: string }
/**
 * `chat: false`: only the agent channel offers it; the companion's chat setting cards never do (electron/brain/chat-settings.ts).
 * `chat: 'turn'` (I-025): her chat may offer it, but only through the per-turn settings context of a message that mentions it;
 * it is not in her fixed system prompt (changing that prompt needs a first-token A/B first).
 * `interconnectOnly`: listed and settable only while 三方互通 is on (I-014).
 * `confirmWhen` (I-025): these values need consent (confirm tier: the user's own words with 三方互通 on, a dialog with it off).
 * `tier: 'confirm'` (2026-11-24): every value needs consent (the Drama 3 monthly limit: each change is a spending decision).
 * `consent` (敏感操作弹窗, 2026-11-12): why those values need consent; see AGENT_CONSENT_REASONS and settingAlwaysDialog.
 * `cardConsent`: in her chat, the card itself shows what happens and the user's tap is that consent (no second dialog).
 * `chatWords` (I-025 第 3 段): for a `chat: 'turn'` setting, the words (regular expressions) that bring it into this turn's
 * settings context; without them it comes whenever the message concerns settings at all.
 */
interface AgentSettingBase {
  id: AgentSettingId; label: string; description: string; tier: AgentExposedTier; chat?: boolean | 'turn'; interconnectOnly?: boolean;
  confirmWhen?: AgentSettingValue[]; consent?: AgentConsentReason; cardConsent?: boolean; chatWords?: string[];
}
export type AgentSettingSpec =
  | (AgentSettingBase & { kind: 'boolean'; choices: AgentSettingChoice<boolean>[] })
  | (AgentSettingBase & { kind: 'enum'; choices: AgentSettingChoice<string | number>[] })
  | (AgentSettingBase & { kind: 'number'; min: number; max: number; step: number; unit: string; presets: AgentSettingChoice<number>[] });
/** A setting with the host's current value (`null` when the host cannot read it right now). */
export type AgentSettingView = AgentSettingSpec & { value: AgentSettingValue | null };

export const AGENT_SERVER_INFO: Readonly<{ name: string; title: string }> = Object.freeze({ ...catalog.server });
export const AGENT_TOOLS: readonly AgentToolDescriptor[] = Object.freeze(catalog.tools as AgentToolDescriptor[]);
export const AGENT_SETTINGS: readonly AgentSettingSpec[] = Object.freeze(catalog.settings as AgentSettingSpec[]);
export const AGENT_NEVER_EXPOSED: readonly string[] = Object.freeze([...catalog.neverExposed]);
/** Values a setting can be in but cannot be set to (I-025 local_asr while it downloads, or on a computer it does not support). */
export const AGENT_SETTING_STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({ downloading: '正在下载', unsupported: '这台电脑用不了',
  // How a chat card names the state now, where the button's words would read oddly ("现在：下载").
  'local_asr:installed': '已下载', 'local_asr:not-installed': '还没下载', 'pose_sensing:installed': '已下载', 'pose_sensing:not-installed': '还没下载' });

/**
 * 敏感操作弹窗: whether this setting's consent-needing values are sensitive (a dialog even with the user's words, 三方互通 on). Only an
 * explicit `behavior` reason is ordinary; anything else, unknown or missing, is sensitive. A setting with nothing to consent to: false.
 */
export function settingAlwaysDialog(spec: Pick<AgentSettingSpec, 'confirmWhen' | 'tier'> & { consent?: unknown }): boolean {
  if (!settingHasConsent(spec)) return false;
  return spec.consent !== 'behavior';
}
/** Whether some value of this setting needs consent: a confirm-tier setting (every value) or one with `confirmWhen` values. */
export function settingHasConsent(spec: Pick<AgentSettingSpec, 'confirmWhen' | 'tier'>): boolean {
  return spec.tier === 'confirm' || !!spec.confirmWhen?.length;
}
/** Whether setting it to this value needs consent (the user's words with 三方互通 on, the dialog with it off). */
export function settingValueNeedsConsent(spec: Pick<AgentSettingSpec, 'confirmWhen' | 'tier'>, value: AgentSettingValue): boolean {
  return spec.tier === 'confirm' || !!spec.confirmWhen?.some(item => item === value);
}

export function agentSetting(id: unknown): AgentSettingSpec | undefined {
  return typeof id === 'string' ? AGENT_SETTINGS.find(setting => setting.id === id) : undefined;
}

/** Strict value check against the catalog. Throws a Chinese message the agent can relay. */
export function validateAgentSettingValue(spec: AgentSettingSpec, value: unknown): AgentSettingValue {
  if (spec.kind === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`「${spec.label}」只接受 true 或 false。`);
    return value;
  }
  if (spec.kind === 'enum') {
    const choice = spec.choices.find(item => item.value === value);
    if (!choice) throw new Error(`「${spec.label}」只接受：${spec.choices.map(item => String(item.value)).join('、')}。`);
    return choice.value;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < spec.min || value > spec.max
    || (value - spec.min) % spec.step !== 0)
    throw new Error(`「${spec.label}」只接受 ${spec.min}～${spec.max} 的整数（单位 ${spec.unit}）。`);
  return value;
}

/**
 * Future chat options card: a plain data object the renderer can turn into buttons
 * without code or HTML from the agent. Labels come from the catalog, not the agent.
 */
export interface AgentOptionsCard {
  kind: 'agent-options-card';
  version: 1;
  settingId: AgentSettingId;
  /** The question shown above the buttons (agent-proposed text is still plain text). */
  prompt: string;
  label: string;
  tier: AgentExposedTier;
  current: AgentSettingValue | null;
  options: Array<{ optionId: string; label: string; value: AgentSettingValue; current: boolean }>;
}

export function agentOptionsCard(setting: AgentSettingView, prompt?: string): AgentOptionsCard {
  const choices: AgentSettingChoice[] = setting.kind === 'number' ? setting.presets : setting.choices;
  const text = typeof prompt === 'string' && prompt.trim() ? prompt.trim().slice(0, 200) : `要把「${setting.label}」改成什么？`;
  return {
    kind: 'agent-options-card', version: 1, settingId: setting.id, prompt: text, label: setting.label,
    tier: setting.tier, current: setting.value,
    options: choices.map((choice, index) => ({ optionId: `${setting.id}:${index}`, label: choice.label, value: choice.value,
      current: choice.value === setting.value })),
  };
}

/**
 * I-014 "三方互通": on by default for every edition and every profile; a user who turned it off keeps it
 * off. On: the channel is always open, its confirm-tier tools run at once (with the notice), and the interconnect-only
 * tools are defined. Off: the channel behaves exactly as before (its own switch, every confirmation dialog).
 */
export interface AgentInterconnectView {
  enabled: boolean;
  /** The user (or their Claude) chose the current state; false while the default applies. */
  explicit: boolean;
  /** Its file could not be read: kept off until the user chooses again. */
  unreadable?: boolean;
  /** Days a deleted memory stays in the recycle bin (1–30, default 7). */
  recycleDays: number;
  /** The user's own Claude Code: whether this edition's MCP server is registered there (automatic, once). */
  claudeCode: AgentClaudeCodeLink;
  /** What the recycle bin holds right now, per character (names and counts only, never contents). */
  recycleBin: AgentRecycleSummary[];
}
/**
 * 'updated': this profile's own registration pointed at another version and now points at this one. 'stale': a same-named
 * entry the app did not register points elsewhere (left alone). 'unverified': listed, but its launch line could not be read.
 */
export type AgentClaudeCodeState = 'idle' | 'checking' | 'linked' | 'registered' | 'removed' | 'missing' | 'failed' | 'skipped'
  | 'updated' | 'stale' | 'unverified';
export interface AgentClaudeCodeLink {
  state: AgentClaudeCodeState; name: string; message: string;
  /** I-061: the user's Claude Code version ("2.1.319") when the host learned it in this check; version only. */
  claudeVersion?: string;
  /** Diagnostic only, `unverified` only (shared/safety/claude-link-diag.ts): a category and small numbers, never list text. */
  unreadable?: import('./claude-link-diag').LinkUnreadableFacts;
}
/** What delete_memories can remove (the agent channel never deletes anything else). */
export type AgentRecyclePart = 'chat' | 'profile';
/** I-144: every kind of entry the bin holds (shared/memory/recycle-bin.ts); names and counts only. */
export type AgentRecycleSummary = import('../memory').RecycleSummary;
/** The last Claude action that can be undone (30 minutes, one at a time). */
export interface AgentUndoView { id: string; label: string; expiresAt: number }

/** Control-window status for the opt-in toggle. */
export interface AgentChannelView {
  enabled: boolean;
  /** The local pipe/socket is accepting connections. */
  listening: boolean;
  /** Authenticated clients currently connected. */
  connections: number;
  lastAction: { tool: string; title: string; tier: AgentExposedTier; outcome: AgentCallOutcome; at: number; undo?: AgentUndoView } | null;
  error?: string;
  /** Registration snippets with this machine's app and shim paths; present only while enabled. */
  setup?: { claudeCode: string; desktopConfig: string };
  /** I-014; absent only on hosts built without it (tests). */
  interconnect?: AgentInterconnectView;
}
export type AgentCallOutcome = 'allowed' | 'denied' | 'failed' | 'invalid';
/**
 * Visible "由 Claude 操作" notice in the control window and the companion. `detail`: one short host-written line (a file name, the
 * character), never chat text; `undo`: the control window's 「隐私与设置」 can undo it.
 */
export interface AgentChannelNotice { title: string; at: number; detail?: string; undo?: boolean }
/** Closed set of renderer actions; the renderer maps each to an existing button. */
export type AgentChannelRendererAction = { kind: 'play-preview'; recipe: 'surprise' | 'shy' } | { kind: 'voice-preview' };
