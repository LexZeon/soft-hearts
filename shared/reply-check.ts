// I-046 (docs/claude/2026-11-07-draft-leak-envelope-plan.md): the closed values of a reply's check before it is kept. Shared so the
// journal line (shared/journal.ts `reply-check`) only ever holds these names and numbers, never the reply's text.

/**
 * How this turn's opening marker went:
 *   off      the turn asked for none (the switch is off): only the check of what was shown ran;
 *   ok       she wrote it, and her words after it are the reply;
 *   missing  she wrote no opening marker at all;
 *   foreign  she wrote one with another turn's code, or one she made up (it does not count);
 *   empty    she wrote it, but nothing after it (the reply came before it).
 */
export const REPLY_MARKER_STATES = ['off', 'ok', 'missing', 'foreign', 'empty'] as const;
export type ReplyMarkerState = (typeof REPLY_MARKER_STATES)[number];

/**
 * Words that only the reply protocol uses, never her talk to the user (electron/reply-opening.ts holds the patterns):
 *   marker          a private marker shape (<sh-open-…>, <sh-state-…> and the like);
 *   body-label      "正文：", the label of a draft of the reply;
 *   tail-word       尾注 / 状态标记 / 开头标记 / 私有上下文;
 *   memorial-field  纪念邀请 / 纪念提议 / 私有提议, or a memorial proposal's field name with a colon (quote: purpose: invite:);
 *   field-name      a tail field name with a colon (context: delta: confidence: gesture:);
 *   english-line    in a Chinese chat, a sentence of English words only (three or more): counted only inside a plan that one of the
 *                   rules above already found, never on its own and never in the check of what was shown.
 */
export const INTERNAL_WORD_RULES = ['marker', 'body-label', 'tail-word', 'memorial-field', 'field-name', 'english-line'] as const;
export type InternalWordRule = (typeof INTERNAL_WORD_RULES)[number];
