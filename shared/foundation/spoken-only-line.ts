// I-178: the one sentence that says "write only what you say out loud". It lives in the chat's technical notes
// (shared/foundation/i139-texts.ts TECH_NOTES, which is built from it) and now in every prompt that makes her speak on her own, so a
// line she volunteers (a pause in a video, a glance at the screen, a touch) never carries stage directions in brackets either:
// the bubble is read aloud. One constant, so the two never drift apart. Pure.

export const SPOKEN_ONLY_LINE = {
  zh: '回复里只写说出口的话，不写括号里的动作说明或旁白，也不写内部标注（气泡里的字会被朗读出来）。',
  en: 'Write only what you say out loud: no actions or asides in brackets, no internal notes (the bubble is read aloud).',
} as const;
