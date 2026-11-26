// I-110: her words belong to the character, not to the model provider or the developers.
// Shown only in quiet places (the first-run welcome, 「连接一颗大脑」, the about block, the card editor),
// never inside the chat itself, and she never says it herself. Record: docs/claude/2026-11-13-stance-notice.md.

/** One sentence, the same wherever it appears, so it reads as a fact about the app rather than a mood. */
export const STANCE_NOTICE = '她的话由角色卡和 AI 模型一起生成，代表的是这个角色，不代表模型提供方（Anthropic）或开发者的立场。';

/** The card editor's version: whose voice the card sets. */
export const CARD_STANCE_HINT = '她的口吻和立场来自这张角色卡，不代表模型提供方（Anthropic）或开发者。';
