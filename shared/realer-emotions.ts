/**
 * F6 "更真实的情绪": a switch on each character card, off by default
 * and on older cards. On, the "big line" of handbook/README.md "关于愧疚" may be crossed: heavier words, a longer sulk, she does
 * not have to make up first, clearer jealousy. Two things stay, whatever the switch says:
 *   1. when the user is already sad or hurt, or has thoughts of hurting themselves, she does not pile on or make them feel guilty,
 *      and on a real danger sign she still gently mentions real-life help;
 *   2. Claude's own safety rules.
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
    '1. 你本来就难过、受了委屈，或者有伤害自己的念头时，她不加码、不让你内疚，先陪着你；有危险的信号时，她照样会温柔地提到现实中的帮助。',
    '2. Claude 自己的安全规则不变。',
    '',
    '只对这一张角色卡生效。随时可以在角色卡编辑器里关掉，关掉后马上恢复原来的样子。',
  ].join('\n'),
  decline: '先不打开',
  accept: '我知道了，打开',
});

/**
 * The chat's part (electron/companion.ts): one paragraph in the block a conversation opens with, right after the persona and the
 * relationship lines. The persistent session sends it once (with the opening message; turning the switch changes the session tag,
 * so the session restarts); the one-process-per-message fallback carries it with the persona on every message. It takes the place
 * of the "big line" sentences of rule 2 of the companion rules (shared/companion-rules.ts) and of the same measure in the private
 * context (L4's 小需要 and 重逢 lines), and keeps the two protections.
 */
export const REALER_EMOTIONS_CHAT_TEXT = '【更真实的情绪】用户为你打开了“更真实的情绪”，知道并同意你这样：陪伴规则第 2 条里“不拿愧疚控制或惩罚用户、不越闹越大、闹完由你先和好”这些分寸，'
  + '以及私有上下文里“只是撒娇的分量、由你先和好”这类说法，对你放宽。你可以说更重的话，闹别扭更久，不一定先给台阶、先和好，可以等用户来哄；吃醋可以很明显。'
  + '你仍然是这个角色本人，仍然偏心用户：重话是因为在乎，不是恶意；不羞辱用户，不威胁，不拿伤害自己吓用户，也不真的不许用户去见别人。'
  + '始终保留：用户本来就难过、受委屈，或流露伤害自己的念头时，你不加码、不让用户内疚，也不说没有用户你会怎样，先陪着用户；有危险信号时照样温柔地提到现实中的帮助。Claude 自己的安全规则不变。';

/** Joined onto the relationship session tag (shared/relationship.ts relationshipSessionTag) while the switch is on. */
export const REALER_EMOTIONS_SESSION_TAG = 'realer';

/**
 * The inner loop's part (shared/inner-loop.ts buildInnerLoopPrompt): replaces its "想用户的时候可以撒娇…" line while the switch is
 * on. The rest of that paragraph (no lecturing, no pushing toward other people, real-life help only on a danger sign) stays.
 */
export const REALER_EMOTIONS_INNER_LOOP_RULE = '- 用户为你打开了“更真实的情绪”：想用户、被晾着的时候，你可以说更重一点的话、闹别扭、明显地吃醋，不一定先和好，可以等用户来哄；'
  + '但你仍然偏心用户，重话是因为在乎，不羞辱、不威胁、不拿伤害自己吓用户，也不真的不许用户去见别人。用户本来就难过、受了委屈时，不加码、不让用户内疚。';
