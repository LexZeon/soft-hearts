// Chat settings (R41 extension, user request 2026-11-01): Claude may *propose* one
// setting change in a nonce-protected private block after its reply; the host turns a
// strictly valid proposal into an options card and applies only what the user taps,
// through the agent-channel registry (same tiers, same confirmation dialog). The chat
// itself still has no tools. No Electron import: tests drive this module directly.
import { randomUUID } from 'node:crypto';
import type { AppSettings } from '../shared/contracts';
import {
  AGENT_SETTING_STATE_LABELS, AGENT_SETTINGS, validateAgentSettingValue,
  type AgentSettingId, type AgentSettingSpec, type AgentSettingValue,
} from '../shared/agent-channel';
import { CHAT_SETTING_CANCEL, type ChatSettingCardState, type ChatSettingCardView } from '../shared/chat-settings';
import { settingDetail, settingViews, type SettingCards, type SettingExtras } from './agent-channel/app-tools';
import { AgentToolRegistry, type AgentCallResult, type AgentRegistryOptions, type AgentToolDefinition } from './agent-channel/registry';

// A setting marked `chat: false` (体验记录) is for the agent channel only: never in her system prompt, never a chat card.
const exposed = (spec: AgentSettingSpec) => ((spec.tier as string) === 'reversible' || (spec.tier as string) === 'confirm') && spec.chat !== false;
// I-025: `chat: 'turn'` (语音输入、本机语音识别) is offered only in the per-turn context, never in her fixed system prompt, so
// her first reply token does not change (a change there needs a first-token A/B first).
const fixed = (spec: AgentSettingSpec) => exposed(spec) && spec.chat !== 'turn';

/**
 * What she says about a change that is not in the list above (2026-11-06, docs/claude/2026-11-06-perception-line.md). The old sentence sent
 * screen, camera and microphone to the control window; since 三方互通 (I-014/I-025) some of those she can propose on a turn that carries the
 * format (语音输入, 知道你是不是在忙…), and the pet itself has the switches for the rest. Keys and running commands never go through the
 * channel; she does not talk the user into turning a sense on.
 */
export const CHAT_SETTINGS_UNLISTED_TEXT = '列表里没有的，只有那一轮的私有上下文给了该项的格式，才按格式提议；没给格式时请用户自己改：'
  + '密钥、语音方案、删除记录、权限、运行命令到控制窗口，屏幕、摄像头、麦克风、电脑声音点桌宠上的开关。不要主动劝用户打开这些。';
/** The sentence before 2026-11-06 (kept for the first-token A/B and the test that pins the change). */
export const CHAT_SETTINGS_UNLISTED_TEXT_BEFORE = '用户想改的东西不在这个列表里（例如密钥、模型、语音方案、屏幕/摄像头/麦克风、删除记录、权限）时，请用户到控制窗口自己改。';

function allowedText(spec: AgentSettingSpec): string {
  if (spec.kind === 'number') return `${spec.min}–${spec.max} 的整数（${spec.unit}）`;
  return spec.choices.map(choice => `${JSON.stringify(choice.value)}（${choice.label}）`).join(' / ');
}

/**
 * Fixed text for the persistent session's system prompt (constant app text built from
 * the catalog: no user data, no current values).
 */
export function chatSettingsSystemText(specs: readonly AgentSettingSpec[] = AGENT_SETTINGS): string {
  const lines = specs.filter(fixed).map(spec => `${spec.id}：${spec.label}，${allowedText(spec)}`);
  return '【聊天里调设置】用户可以请你调整下面几项桌宠设置（id：名称，可选值）：\n' + lines.join('\n')
    + '\n你自己不能改设置。只有某一轮的私有上下文里给出“设置提议”格式时，才可以按格式附加一个提议；应用会给用户一张选项卡片，由用户点按钮决定。'
    + '不要声称已经改好。' + CHAT_SETTINGS_UNLISTED_TEXT;
}

/**
 * Cheap gate for spending tokens on current values and the proposal protocol: does
 * this message plausibly concern one of the settings? Words for the settings
 * themselves (音量、朗读、置顶、鼠标、呼吸、帧率…), their symptoms (太吵、挡住、卡顿、
 * 费电…) and generic change verbs (调高、改成、关掉…). False positives only cost the
 * extra lines; a miss means Claude can only answer in words (and suggest wording).
 */
const SETTING_WORDS = new RegExp([
  '设置', '调(?:大|小|高|低|成|到|整|节|回|一下)', '改(?:成|为|到|回)', '换成', '设(?:成|为|到)',
  '打开', '开启', '关掉', '关闭', '关上', '别再', '不要再',
  '音量', '声音', '大声', '小声', '太吵', '好吵', '安静', '静音', '朗读', '读出来', '念出来', '别读', '不要读', '播报',
  '隐藏', '藏起来', '显示桌宠', '看不见你', '置顶', '最上面', '最前面', '挡住', '遮住', '挡着',
  '鼠标', '视线', '盯着', '呼吸', '喘', '起伏',
  '帧率', '帧数', '卡顿', '好卡', '很卡', '太卡', '有点卡', '流畅', '顺滑', '耗电', '费电', '省电', '发热', '发烫',
  '慢慢(?:跟我)?熟', '熟起来', '升温', '慢热', '别那么客气', '不要那么客气', '客气一点', '一开始就很熟',
  // F6 "更真实的情绪" (realer_emotions): asking for it in chat brings the settings card; turning it on still shows the consent dialog.
  '情绪更真', '更真实', '真实一点', '别那么懂事', '不要那么懂事', '不用那么懂事',
  '\\b(?:settings?|volume|mute|quiet|louder|softer|read(?:ing)? aloud|fps|frame ?rate|breath(?:ing)?|on top|mouse|hide|lag(?:gy)?)\\b',
].join('|'), 'iu');
const turnPatterns = new WeakMap<AgentSettingSpec, RegExp | null>();
function turnPattern(spec: AgentSettingSpec): RegExp | null {
  if (!turnPatterns.has(spec)) turnPatterns.set(spec, spec.chatWords?.length ? new RegExp(spec.chatWords.join('|'), 'iu') : null);
  return turnPatterns.get(spec) ?? null;
}
/**
 * I-025: the per-turn settings (`chat: 'turn'`) this message is about, by each setting's own words in the catalog (语音输入、麦克风、
 * 鼠标穿透、语速…). Only these come into this turn's context, so her context grows only with what the user is talking about.
 */
export function turnSettingsMentioned(text: unknown, specs: readonly AgentSettingSpec[] = AGENT_SETTINGS): AgentSettingSpec[] {
  if (typeof text !== 'string') return [];
  const sample = text.slice(0, 4000);
  return specs.filter(spec => spec.chat === 'turn' && exposed(spec) && !!turnPattern(spec)?.test(sample));
}
export function mentionsSettings(text: unknown, specs: readonly AgentSettingSpec[] = AGENT_SETTINGS): boolean {
  return typeof text === 'string' && (SETTING_WORDS.test(text.slice(0, 4000)) || turnSettingsMentioned(text, specs).length > 0);
}

/**
 * This turn's current values, compact and self-contained (also works without the system text). The settings of her fixed prompt
 * read `id=value(range)` exactly as before; the per-turn-only ones (I-025) carry their name and choices, since the fixed prompt
 * does not explain them.
 */
export function currentSettingsText(settings: AppSettings, specs: readonly AgentSettingSpec[] = AGENT_SETTINGS, cards?: SettingCards, extras?: SettingExtras,
  include: (spec: AgentSettingSpec) => boolean = () => true): string {
  const views = settingViews(settings, cards, extras);
  return specs.filter(spec => exposed(spec) && include(spec)).map(spec => {
    const value = views.find(view => view.id === spec.id)?.value ?? null;
    const now = value === null ? '未知' : JSON.stringify(value);
    if (spec.chat === 'turn') return `${spec.id}=${now}（${spec.label}，可选 ${allowedText(spec)}）`;
    const range = spec.kind === 'number' ? `（${spec.min}–${spec.max}）` : spec.kind === 'enum' ? `（${spec.choices.map(c => c.value).join('/')}）` : '';
    return `${spec.id}=${now}${range}`;
  }).join('；');
}

/** The per-turn protocol text; `start`/`end` carry this turn's nonce. */
export function settingProposalInstruction(current: string, start: string, end: string): string {
  return `【设置提议】用户这句话可能和桌宠设置有关。可调的设置和当前值：${current}。`
    + `用户明确想改其中一项时：正文用一两句自然地回应，不要说已经改好；然后紧接在状态尾注之后附加且仅附加一次：`
    + `${start}{"id":"readout_volume","value":60,"choices":[40,60],"reason":"不超过20字的原因"}${end}。`
    + 'id 只能是这里列出的设置之一，value 和 choices 只能用它允许的值；choices 可省略，最多 4 个同一项的候选值。应用会把它变成选项卡片，用户点了才会改。'
    + '不清楚想改哪一项或改成多少时：不要附加，直接用一句话问用户，可以说出两三个选项。和设置无关、或想改的不在列表里时：不要附加。';
}

export interface ChatSettingProposal {
  spec: AgentSettingSpec;
  value: AgentSettingValue;
  /** Distinct valid values, the proposal first; at most four. */
  options: AgentSettingValue[];
  reason: string;
}

// Control, zero-width and bidi characters never reach the card.
const hidden = (code: number) => code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f)
  || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2060 && code <= 0x206f) || code === 0xfeff;
function cleanReason(value: unknown): string {
  if (typeof value !== 'string') return '';
  return [...[...value].map(char => hidden(char.codePointAt(0)!) ? ' ' : char).join('').replace(/\s+/gu, ' ').trim()].slice(0, 60).join('');
}

/**
 * Strict parse of the private block's JSON. Unknown keys, unknown or unexposed
 * settings (`never`/`read`), any out-of-range value, more than four distinct options,
 * or a proposal that changes nothing → null.
 */
export function parseChatSettingProposal(raw: unknown, current: (id: AgentSettingId) => AgentSettingValue | null,
  specs: readonly AgentSettingSpec[] = AGENT_SETTINGS): ChatSettingProposal | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 800) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.getPrototypeOf(data) !== Object.prototype) return null;
  const record = data as Record<string, unknown>;
  if (Object.keys(record).some(key => !['id', 'value', 'choices', 'reason'].includes(key))) return null;
  const spec = typeof record.id === 'string' ? specs.find(item => item.id === record.id) : undefined;
  if (!spec || !exposed(spec)) return null;
  const valid = (value: unknown): AgentSettingValue | null => { try { return validateAgentSettingValue(spec, value); } catch { return null; } };
  const value = valid(record.value);
  if (value === null) return null;
  if (record.choices !== undefined && (!Array.isArray(record.choices) || record.choices.length < 1 || record.choices.length > 4)) return null;
  const options: AgentSettingValue[] = [value];
  for (const item of (record.choices as unknown[] | undefined) ?? []) {
    const choice = valid(item);
    if (choice === null) return null;
    if (!options.includes(choice)) options.push(choice);
  }
  if (options.length > 4) return null;
  if (record.reason !== undefined && typeof record.reason !== 'string') return null;
  const now = current(spec.id);
  if (options.every(option => option === now)) return null;
  return { spec, value, options, reason: cleanReason(record.reason) };
}

export function settingValueLabel(spec: AgentSettingSpec, value: AgentSettingValue | null): string {
  if (value === null) return '未知';
  if (spec.kind === 'number') return spec.presets.find(preset => preset.value === value)?.label ?? `${value}${spec.unit}`;
  return spec.choices.find(choice => choice.value === value)?.label ?? AGENT_SETTING_STATE_LABELS[String(value)] ?? String(value);
}

/** I-025: how the card names the state it is in now, where that reads differently from its button (local_asr: 还没下载 / 已下载). */
export function currentValueLabel(spec: AgentSettingSpec, value: AgentSettingValue | null): string {
  return AGENT_SETTING_STATE_LABELS[`${spec.id}:${String(value)}`] ?? settingValueLabel(spec, value);
}

/** The card's receipt after a tap applied; a download and the microphone say what happens next. */
function appliedMessage(spec: AgentSettingSpec, value: AgentSettingValue, label: string): string {
  if (spec.id === 'local_asr' && value === 'installed')
    return '由 Claude 操作：已开始下载本机语音识别，进度在设置「连接与声音 → 语音输入」里。下好以后跟她说“打开语音输入”就行。';
  if (spec.id === 'voice_input' && value === true) return '由 Claude 操作：已打开语音输入（麦克风）。想关的时候跟她说，或者在设置里关。';
  return `由 Claude 操作：已把「${spec.label}」改为 ${label}。随时可以在设置里改回。`;
}

/** What one ordinary chat turn passes to the reply protocol. */
export interface ChatSettingTurn {
  ticket: number;
  /** Null: no proposal is offered this turn (any such block is still hidden and ignored). */
  instruction: ((start: string, end: string) => string) | null;
}

export interface ChatSettingHostOptions {
  /** Host-current settings (never renderer data). */
  settings(): AppSettings;
  /** The character cards, for settings that live on the active card (熟悉度: slow_warm_up). */
  cards?(): SettingCards;
  /** Sends a card (or its update) to the window that owns the reply. */
  send(owner: number, card: ChatSettingCardView): void;
  now?(): number;
  id?(): string;
  /** An open card stops accepting taps after this long. */
  ttlMs?: number;
  specs?: readonly AgentSettingSpec[];
}

interface ActiveCard {
  card: ChatSettingCardView;
  owner: number;
  spec: AgentSettingSpec;
  values: Map<string, AgentSettingValue>;
  expiresAt: number;
}

export type ChatSettingApplier = (id: AgentSettingId, value: AgentSettingValue) => Promise<AgentCallResult>;
/**
 * I-025: what the host knows beyond AppSettings and the cards (the microphone, the local recognizer), for current values and for
 * the card's one-line detail (how much a download is and where it comes from).
 */
export interface ChatSettingFacts { extras?(): SettingExtras }

/**
 * The card's applier: a registry holding only the agent channel's own `set_setting`
 * tool, so the catalog tier decides (reversible → "由 Claude 操作" notice, confirm → the
 * native dialog; `never` is not even defined). The user's tap is the consent, so it
 * does not depend on the external channel's opt-in switch. Audit lines are `chat_*`.
 */
export function chatSettingApplier(tools: readonly AgentToolDefinition[],
  options: Pick<AgentRegistryOptions, 'confirm' | 'notice' | 'audit' | 'confirmTimeoutMs' | 'confirmLock'>): ChatSettingApplier {
  const registry = new AgentToolRegistry(tools.filter(tool => tool.name === 'set_setting'), {
    ...options, enabled: () => true,
    notice: (tool, title) => { try { options.notice?.(tool, title); } catch { /* A missing window must not block the change. */ } },
    audit: entry => options.audit?.({ ...entry, tool: `chat_${entry.tool}` }),
  });
  return (id, value) => registry.call('set_setting', { id, value });
}

/**
 * At most one open card at a time. A card belongs to one reply and one window; a new
 * chat turn, a context change (character, conversation, provider) or the TTL makes it
 * inert. A proposal never changes anything by itself: only `choose()` with a live
 * card's own choice id applies, exactly once.
 */
export class ChatSettingProposals {
  private generation = 0;
  private active: ActiveCard | null = null;
  private applier: ChatSettingApplier | null = null;
  private facts: ChatSettingFacts = {};
  private readonly specs: readonly AgentSettingSpec[];

  constructor(private readonly options: ChatSettingHostOptions) { this.specs = options.specs ?? AGENT_SETTINGS; }

  /** Connected once the agent-channel registry exists (electron/agent-channel/electron-wiring.ts). */
  connect(applier: ChatSettingApplier, facts: ChatSettingFacts = {}): void { this.applier = applier; this.facts = facts; }

  /** A new ordinary chat turn: earlier cards become inert; returns this turn's ticket. */
  beginTurn(userText: unknown): ChatSettingTurn {
    this.invalidate();
    if (!mentionsSettings(userText, this.specs)) return { ticket: this.generation, instruction: null };
    // The settings of her fixed prompt always; a per-turn one only when this message names it (or it has no words of its own).
    const named = new Set(turnSettingsMentioned(userText, this.specs).map(spec => spec.id));
    const current = currentSettingsText(this.options.settings(), this.specs, this.options.cards?.(), this.extras(),
      spec => spec.chat !== 'turn' || !spec.chatWords?.length || named.has(spec.id));
    return { ticket: this.generation, instruction: (start, end) => settingProposalInstruction(current, start, end) };
  }

  /** Character, conversation or provider changed: any open card expires. */
  invalidate(): void {
    this.generation++;
    const active = this.active;
    this.active = null;
    if (active && active.card.state === 'open') this.publish(active, 'expired', '这张卡片已过期，设置没有改。');
  }

  /** After a complete, archived reply: turns a valid proposal into the one open card. */
  offer(ticket: number, owner: number, replyId: string, raw: string | null | undefined): ChatSettingCardView | null {
    if (ticket !== this.generation || !raw || !this.applier) return null;
    const proposal = parseChatSettingProposal(raw, id => this.currentValue(id), this.specs);
    if (!proposal) return null;
    const current = this.currentValue(proposal.spec.id), id = this.options.id ?? randomUUID;
    const values = new Map<string, AgentSettingValue>();
    const choices = proposal.options.map((value, index) => {
      const choiceId = `c${index}`;
      values.set(choiceId, value);
      return { choiceId, label: settingValueLabel(proposal.spec, value), proposed: value === proposal.value, current: value === current };
    });
    // I-025: a value whose card is the consent says on the card what happens (download size and source, the microphone).
    const detail = settingDetail(proposal.spec.id, proposal.value, this.extras());
    const card: ChatSettingCardView = {
      kind: 'chat-setting-card', version: 1, proposalId: id(), replyId, settingId: proposal.spec.id, label: proposal.spec.label,
      current: currentValueLabel(proposal.spec, current), proposed: settingValueLabel(proposal.spec, proposal.value),
      reason: proposal.reason, confirm: proposal.spec.tier === 'confirm', choices, state: 'open', ...(detail ? { detail } : {}),
    };
    this.generation++; // One card per reply: a second offer for the same ticket is inert.
    this.active = { card, owner, spec: proposal.spec, values, expiresAt: this.now() + (this.options.ttlMs ?? 5 * 60_000) };
    this.send(owner, card);
    return structuredClone(card);
  }

  /** A tap from the owning window. Unknown, stale or second taps change nothing. */
  async choose(sender: number, request: unknown): Promise<ChatSettingCardView | null> {
    const input = request && typeof request === 'object' && !Array.isArray(request) ? request as Record<string, unknown> : {};
    const active = this.active;
    if (!active || typeof input.proposalId !== 'string' || input.proposalId !== active.card.proposalId || typeof input.choiceId !== 'string')
      return null;
    if (sender !== active.owner) throw new Error('请求来源未授权。');
    if (active.card.state !== 'open') return structuredClone(active.card);
    if (this.now() > active.expiresAt) {
      this.active = null;
      return this.publish(active, 'expired', '这张卡片已过期，设置没有改。');
    }
    if (input.choiceId === CHAT_SETTING_CANCEL) {
      this.active = null;
      return this.publish(active, 'cancelled', '已取消，设置没有改。');
    }
    const value = active.values.get(input.choiceId);
    if (value === undefined || !this.applier) return null;
    this.publish(active, 'busy', active.card.confirm ? '请在弹出的确认框里决定。' : '正在修改…');
    let result: AgentCallResult;
    try { result = await this.applier(active.spec.id, value); }
    catch { result = { ok: false, error: { code: 'failed', message: '操作失败。' } }; }
    if (this.active === active) this.active = null;
    const label = settingValueLabel(active.spec, value);
    if (result.ok) {
      const outcome = result.result as { previous?: unknown; value?: unknown } | null;
      return outcome && outcome.previous === outcome.value
        ? this.publish(active, 'unchanged', `「${active.spec.label}」本来就是 ${label}，没有变化。`)
        : this.publish(active, 'applied', appliedMessage(active.spec, value, label));
    }
    const code = result.error.code;
    if (code === 'denied_by_user' || code === 'confirm_timeout')
      return this.publish(active, 'denied', '你没有在确认框里允许，设置没有改。');
    return this.publish(active, 'failed', `没有改成：${result.error.message.slice(0, 120)}`);
  }

  private currentValue(id: AgentSettingId): AgentSettingValue | null {
    return settingViews(this.options.settings(), this.options.cards?.(), this.extras()).find(view => view.id === id)?.value ?? null;
  }

  private extras(): SettingExtras | undefined { try { return this.facts.extras?.(); } catch { return undefined; } }

  private publish(active: ActiveCard, state: ChatSettingCardState, message: string): ChatSettingCardView {
    active.card = { ...active.card, state, message };
    this.send(active.owner, active.card);
    return structuredClone(active.card);
  }

  private send(owner: number, card: ChatSettingCardView): void {
    try { this.options.send(owner, structuredClone(card)); } catch { /* The window may be gone. */ }
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
}
