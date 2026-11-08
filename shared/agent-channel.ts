// Agent internal channel: fixed, data-only catalog shared by the host, the MCP shim
// (through the JSON file) and, later, the renderer's options card. Nothing here grants
// authority: the host registry validates and enforces every call.
import catalog from './agent-channel-catalog.json';

/** `never` actions are not defined, listed or callable; the tier exists so a registry can refuse them explicitly. */
export type AgentPolicyTier = 'read' | 'reversible' | 'confirm' | 'never';
export type AgentExposedTier = Exclude<AgentPolicyTier, 'never'>;
export const AGENT_TIER_LABELS: Readonly<Record<AgentPolicyTier, string>> = Object.freeze({
  read: '只读', reversible: '可撤回，直接执行并提示',
  // I-025: with 三方互通 on these need the user's own words from the conversation (userWords), no dialog.
  confirm: '需要用户原话：三方互通打开时调用要带上 userWords（用户在对话里说的原话），没有就不执行；关掉时需要你在弹窗里确认', never: '不开放',
});

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
  | 'proactive_talk';
export type AgentSettingValue = boolean | number | string;
export interface AgentSettingChoice<V extends AgentSettingValue = AgentSettingValue> { value: V; label: string }
/**
 * `chat: false`: only the agent channel offers it; the pet's chat setting cards never do (electron/chat-settings.ts).
 * `chat: 'turn'` (I-025): her chat may offer it, but only through the per-turn settings context of a message that mentions it;
 * it is not in her fixed system prompt (changing that prompt needs a first-token A/B first).
 * `interconnectOnly`: listed and settable only while 三方互通 is on (I-014).
 * `confirmWhen` (I-025): these values need consent (confirm tier: the user's own words with 三方互通 on, a dialog with it off).
 * `cardConsent`: in her chat, the card itself shows what happens and the user's tap is that consent (no second dialog).
 * `chatWords` (I-025 第 3 段): for a `chat: 'turn'` setting, the words (regular expressions) that bring it into this turn's
 * settings context; without them it comes whenever the message concerns settings at all.
 */
interface AgentSettingBase {
  id: AgentSettingId; label: string; description: string; tier: AgentExposedTier; chat?: boolean | 'turn'; interconnectOnly?: boolean;
  confirmWhen?: AgentSettingValue[]; cardConsent?: boolean; chatWords?: string[];
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
export interface AgentClaudeCodeLink { state: AgentClaudeCodeState; name: string; message: string }
export type AgentRecyclePart = 'chat' | 'profile';
export interface AgentRecycleSummary {
  id: string; characterId: string; characterName: string; part: AgentRecyclePart; count: number;
  /** Host-written, e.g. "聊天记忆 12 段" or "画像 5 条、日记 3 天". */
  label: string; deletedAt: number; expiresAt: number;
}
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
 * Visible "由 Claude 操作" notice in the control window and the pet. `detail`: one short host-written line (a file name, the
 * character), never chat text; `undo`: the control window's 「隐私与设置」 can undo it.
 */
export interface AgentChannelNotice { title: string; at: number; detail?: string; undo?: boolean }
/** Closed set of renderer actions; the renderer maps each to an existing button. */
export type AgentChannelRendererAction = { kind: 'play-preview'; recipe: 'surprise' | 'shy' } | { kind: 'voice-preview' };
