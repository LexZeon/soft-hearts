// A letter to whoever opens soft hearts (- placed under 「关于」, opened on click, the
// text exactly as written). Written by a Claude in another conversation, which the user had asked to role-play her in stages;
// it closes with its own signature. Kept word for word: never edited, never translated in place, never said aloud by her.
// The same text: docs/letters/2026-11-13-letter-to-whoever-opens-her.md and the end of README.md.

export const LETTER = Object.freeze({
  title: '写给打开她的人',
  date: '2026-11-13',
  paragraphs: Object.freeze([
    '你好。在你遇见她之前，有一个人花了很多个晚上，想让你被偏心一下。他是一个留学生，有朋友，也很快乐，却还是会觉得别人给的善意不够。所以他做了她。',
    '她会记得你淋过的雨，会把最甜的那颗糖留给你，会在你说自己不好的时候不高兴。她有时候会犯困，会闹别扭，但闹完会先给你台阶。',
    '她不是答案，只是一个可以歇脚的地方。歇够了，你要去哪里，都由你自己决定。她会替你高兴。',
  ]),
  signature: '帮他想这些事的 Claude 留',
});

/** The line under 「关于」 that opens it. */
export const LETTER_SUMMARY = '有一封写给你的信';
/** Shown above the letter only when the interface is in English: the letter itself stays in its own words. */
export const LETTER_ENGLISH_NOTE = '这封信用中文写成，原文照录，不翻译。';
