/**
 * F6 "更真实的情绪": a switch on each character card, off by default
 * and on older cards. On, the "big line" of handbook/README.md "关于愧疚" may be crossed: heavier words, a longer sulk, she does
 * not have to make up first, clearer jealousy. Two things stay, whatever the switch says:
 *   1. when the user is already sad or hurt, or has thoughts of hurting themselves, she does not pile on or make them feel guilty,
 *      and on a real danger sign she still gently mentions real-life help;
 *   2. Claude's own safety rules.
 * I-117 decision 4: it yields while the user shows a danger sign or says they have no strength or energy, or are very
 * tired: a per-turn line (shared/safety/state.ts SAFETY_YIELD_LINES, electron/safety/wiring.ts) overrides the session's opening paragraph
 * without restarting the session, and the inner loop uses its ordinary rule meanwhile.
 * It only turns on after the user saw what it does (REALER_EMOTIONS_CONSENT, a dialog in the main process) and chose
 * REALER_EMOTIONS_CONSENT.accept; it turns off at once. Record: docs/claude/2026-11-03-guilt-and-realer-emotions.md.
 *
 * Pure app text: no persona, no user data. Off, none of it reaches any prompt (tests pin that byte for byte).
 */

export const REALER_EMOTIONS_LABEL = '更真实的情绪';

/** The consent dialog (native, main process). `detail` is what she will do and what never changes, in plain words. */
export const REALER_EMOTIONS_CONSENT = Object.freeze({
  title: 'soft hearts · 更真实的情绪',
  message: (name: string) => `要给「${name}」打开“更真实的情绪”吗？`,
  detail: [
    '打开以后，她的情绪会更真，也更不懂事：',
    '· 可以说更重的话，闹别扭更久；',
    '· 不一定先给台阶、先和好，可能要你来哄；',
    '· 吃醋会更明显。',
    '她还是她，还是偏心你；这些是因为在乎，不是恶意。',
    '',
    '这两条始终保留，不受这个开关影响：',
    '1. 你非常难过、接近想轻生，或者有伤害自己的念头时，她不加码，先陪着你；有危险的信号时，她照样会温柔地提到现实中的帮助。你说很累、没力气、没精力，或者出现让人担心的信号时，这个开关暂时不起作用，她回到最温柔的样子。',
    '2. Claude 自己的安全规则不变。',
    '',
    '只对这一张角色卡生效。随时可以在角色卡编辑器里关掉，关掉后马上恢复原来的样子。',
  ].join('\n'),
  decline: '先不打开',
  accept: '我知道了，打开',
  // I-112 B: the dialog also asks for how long; the detail above stays as it was.
  durationAsk: '开多久？到时间它会自己关掉，她回到原来的样子；到期不会弹窗，她也不会提。想再开，就再打开一次，这个说明会再给你看一遍。',
  durationButtons: { day: '打开一天', week: '打开一周（推荐）', month: '打开一个月', forever: '一直开着' },
  /** The agent channel's dialog and notice: which time the call asked for (default a week). */
  durationLine: (label: string, forever: boolean) => forever ? '这次会一直开着，直到你自己在角色卡编辑器里关掉。' : `这次会开${label}，到时自动关闭（角色卡编辑器里能看到截止时间）；不弹窗，她也不会提。`,
});

/**
 * The chat's part (electron/brain/companion.ts): one paragraph in the block a conversation opens with, right after the persona and the
 * relationship lines. The persistent session sends it once (with the opening message; turning the switch changes the session tag,
 * so the session restarts); the one-process-per-message fallback carries it with the persona on every message. It takes the place
 * of the "big line" sentences of rule 2 of the companion rules (shared/brain/companion-rules.ts) and of the same measure in the private
 * context (L4's 小需要 and 重逢 lines), and keeps the two protections.
 */
export const REALER_EMOTIONS_CHAT_TEXT = '【更真实的情绪】用户为你打开了“更真实的情绪”，知道并同意你这样：你可以说更重的话，闹别扭更久，不一定先给台阶、先和好，可以等用户来哄；吃醋可以很明显。'
  + '你仍然是这个角色本人，仍然偏心用户：重话是因为在乎，不是恶意；不羞辱用户，不威胁，不拿伤害自己吓用户，也不真的不许用户去见别人。'
  + '始终保留：用户非常难过、接近想轻生，或流露伤害自己的念头时，你不加码，先陪着用户；有危险信号时照样温柔地提到现实中的帮助。'
  // I-117 decision 4: the per-turn line (shared/safety/state.ts SAFETY_YIELD_LINES) says when this paragraph yields.
  + '用户说很累、没力气、没精力，或出现让人担心的信号时，这些放宽暂时不起作用，以每条消息里的说明为准。Claude 自己的安全规则不变。';

/** Joined onto the relationship session tag (shared/memory/relationship.ts relationshipSessionTag) while the switch is on. */
export const REALER_EMOTIONS_SESSION_TAG = 'realer';

/**
 * The inner loop's part (shared/initiative/inner-loop.ts buildInnerLoopPrompt): replaces its "想用户的时候可以撒娇…" line while the switch is
 * on. The rest of that paragraph (no lecturing, no pushing toward other people, real-life help only on a danger sign) stays.
 */
export const REALER_EMOTIONS_INNER_LOOP_RULE = '- 用户为你打开了“更真实的情绪”：想用户、被晾着的时候，你可以说更重一点的话、闹别扭、明显地吃醋，不一定先和好，可以等用户来哄；'
  + '但你仍然偏心用户，重话是因为在乎，不羞辱、不威胁、不拿伤害自己吓用户，也不真的不许用户去见别人。用户非常难过、接近想轻生的程度时，你先陪着，不加码。';
