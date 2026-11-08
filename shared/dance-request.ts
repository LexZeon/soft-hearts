/**
 * "跳一个" in the chat (M1): the smallest recognition on the existing chat path. It is not a command
 * and grants nothing: a match only becomes a request that adds to her own want to dance for a while
 * (shared/music-desire.ts), and she decides by her character. No tail note and no prompt text is
 * involved, so nothing here depends on the chat brain.
 *
 * Deliberately narrow: a clause has to *start* (after polite fillers) with the dance verb, so
 * "我昨天去跳舞了", "你会跳舞吗", "别跳了", "不想跳舞" are not requests.
 */
const MAX_SCANNED = 400;
const CLAUSE_SPLIT = /[，,。.！!？?；;、~～…:：\n\r]+/u;

/** Polite or filler words that may stand before the verb. */
const ZH_FILLER = /^(?:那你|那就|那|你|您|请|麻烦|快点|快|赶紧|赶快|来吧|来个|来|再来|再|给我|给我们|为我|为我们|替我|帮我|现在|可以|能不能|可不可以|可以不可以|能|要不要|想不想|愿不愿意|愿意|嘿|喂|诶|哎|好啊|好呀|好|嗯|先|就|试试|试着|试一试|不如|不妨)+/u;
/** The verb and what may follow it right away. */
const ZH_VERB = /^(?:跳|扭)(?:舞蹈|舞|个|一个|一下|一支|支|一段|段|一曲|曲|起来|一扭|吧|一会|会儿|$)/u;
const ZH_NOUN = /^(?:一个|个|一段|段|一支|支|一曲|曲)?(?:舞蹈|舞)(?:吧|给我|给我们|看看|来看看|$)/u;

const EN_FILLER = /^(?:(?:please|pls|hey|ok|okay|now|so|then|can you|could you|would you|will you|why don'?t you|let'?s|let me see you|go ahead and)\s+)+/iu;
const EN_VERB = /^(?:dance|do a (?:little )?dance|show me a dance|bust a move)(?![a-z])/iu;

export function scanDanceRequest(text: string): boolean {
  if (typeof text !== 'string') return false;
  const clauses = text.slice(0, MAX_SCANNED).trim().split(CLAUSE_SPLIT).map(clause => clause.trim()).filter(Boolean);
  for (const clause of clauses) {
    const zh = clause.replace(/\s+/gu, '').replace(ZH_FILLER, '');
    if (ZH_VERB.test(zh) || ZH_NOUN.test(zh)) return true;
    const en = clause.replace(EN_FILLER, '');
    if (EN_VERB.test(en)) return true;
  }
  return false;
}
