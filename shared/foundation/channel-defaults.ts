/**
 * The one place for channel-dependent defaults of things the user has not tried yet (the whole build goes
 * to stable after the user tries it in development; the experimental parts stay off there until the user turns them on).
 *
 * How it reads:
 *  - `channel` is the installed channel as electron/desktop-channel.ts names it ('stable' | 'development'); '' / null / undefined is a
 *    source run or an unmanaged build. Only 'stable' takes the stable value; development and source runs keep what they had.
 *  - A choice the user saved (true / false) always wins over the channel's default; only an unset one (null) follows the channel.
 *  - Never override a saved choice: nothing here writes anything.
 * Older gates with their own pattern (LONG_CHAT_STABLE in shared/behaviors/long-chat/knobs.ts, SPEAK_ONLY_STABLE in
 * electron/brain/speak-only/rules.ts, PROMPT_SWITCHES_STABLE in shared/brain/prompt-switches.ts) say the same thing for the chat prompts; they
 * stay where they are (their switch is the developer's, not a user setting). Add a new "off in stable until tried" gate here.
 * The list the user reads: docs/claude/2026-11-19-stable-defaults.md.
 */

export type GateChannel = 'stable' | 'development' | '' | null | undefined;

/** The user-facing gates that have a switch in settings. */
export type ChannelGateId = 'unboundEntry' | 'touchSoft' | 'speechBeats' | 'threeOnStage' | 'chimeIn';
export const CHANNEL_GATE_IDS: readonly ChannelGateId[] = Object.freeze(['unboundEntry', 'touchSoft', 'speechBeats', 'threeOnStage', 'chimeIn']);

/** Each gate's value on the stable channel. Since every gate is on there too, so stable equals development; kept as a table so a future gate can start off in stable again. */
export const CHANNEL_GATES_STABLE: Readonly<Record<ChannelGateId, boolean>> = Object.freeze({
  /** 「让她出来」 (before the 0.2.0 release the stable channel follows the development defaults: on in stable too; on only shows the entry, the senses page still lists every sense before anything turns on): the tray item, the control window's button and Ctrl+Alt+U (the developer panel's own switch is not gated). */
  unboundEntry: true,
  /** 「碰了才软」 (stable follows the development defaults): the touched soft region dents and springs back. */
  touchSoft: true,
  /**
   * 「边说边演（Claude 编排）」 (docs/claude/2026-11-20-speech-beats-2-4.md): her expressions and small moves follow each sentence. Decided
   * 2026-11-19 (off in stable until tried there); before the 0.2.0 release: on in stable too.
   */
  speechBeats: true,
  /** 「三人同框（Beta）」 (stable follows the development defaults, still marked Beta; I-209): up to three on the full-screen stage. */
  threeOnStage: true,
  /**
   * 「她们都能接话」 (I-209 step 4; on the spending, up to 3 Claude calls and 3 Fish
   * readings per line with this switch on by default: "可以"): on stage, the others decide with their own haiku whether to answer a line. On
   * in every channel (it only acts while 「三人同框（Beta）」 is on). Off: only the one you clicked answers.
   */
  chimeIn: true,
});

/** What an unset gate means on this channel. */
export function channelGateDefault(id: ChannelGateId, channel: GateChannel): boolean {
  return channel === 'stable' ? CHANNEL_GATES_STABLE[id] : true;
}

/** The user's saved choices; null: not chosen, follow the channel. */
export type ChannelGateChoices = Readonly<Record<ChannelGateId, boolean | null>>;
export const NO_GATE_CHOICES: ChannelGateChoices = Object.freeze({ unboundEntry: null, touchSoft: null, speechBeats: null, threeOnStage: null, chimeIn: null });

/** A saved choice wins; an unset one follows the channel. */
export function resolveChannelGate(id: ChannelGateId, choices: Partial<ChannelGateChoices> | null | undefined, channel: GateChannel): boolean {
  const saved = choices?.[id];
  return typeof saved === 'boolean' ? saved : channelGateDefault(id, channel);
}

/** Anything from disk or from a window, down to booleans and nulls (other fields are not copied). */
export function parseChannelGateChoices(value: unknown): ChannelGateChoices {
  const out: Record<ChannelGateId, boolean | null> = { unboundEntry: null, touchSoft: null, speechBeats: null, threeOnStage: null, chimeIn: null };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const id of CHANNEL_GATE_IDS) {
      const own = Object.prototype.hasOwnProperty.call(value, id) ? (value as Record<string, unknown>)[id] : undefined;
      if (typeof own === 'boolean') out[id] = own;
    }
  }
  return out;
}

/** What the settings page shows for each gate. */
export interface ChannelGateView { on: boolean; saved: boolean | null; channelDefault: boolean }
export type ChannelGatesView = Readonly<Record<ChannelGateId, ChannelGateView>>;

export function channelGatesView(choices: Partial<ChannelGateChoices> | null | undefined, channel: GateChannel): ChannelGatesView {
  const view = {} as Record<ChannelGateId, ChannelGateView>;
  for (const id of CHANNEL_GATE_IDS) {
    const saved = typeof choices?.[id] === 'boolean' ? (choices[id] as boolean) : null;
    view[id] = { on: saved ?? channelGateDefault(id, channel), saved, channelDefault: channelGateDefault(id, channel) };
  }
  return view;
}
