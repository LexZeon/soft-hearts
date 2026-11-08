// A Chinese planning block in front of the reply (docs/claude/2026-11-07-draft-leak-cn-plan.md): the model writes itself a
// page of notes, sentence after sentence, then the reply ("拿到一些信息：用户想看……。所以只能看到……。回答：……。不要问昵称？……
// 规则：……。Personality: ……。保持简短。你这窗口……"). Its first sentence starts like a note to itself and names the user without
// saying anything to anyone; after it the notes are judged a sentence at a time (ReplyDraftGuard, "note block"):
//   * a note: a label and a colon at its start (NOTE_LABEL), a question to itself about asking or mentioning something
//     (SELF_QUESTION), a cue of the older rules, or a directive with nothing said to anyone (DIRECTIVE);
//   * said to someone: you or me, a particle, ！？～ outside quotes — the reply begins here, the head is over;
//   * plain (a description, "所以只能看到标题和那行字。"): held; dropped when a note follows it, shown as the reply when the
//     reply begins or the text ends right after it.
// Quoted words (the text on the user's screen the notes quote, "骗你们的我才不吃香菜呢。") never count, and a full stop inside
// a quotation does not end the sentence. These helpers depend on the text only, never on how the stream was cut.

/** Where the first sentence of such a block can begin (Chinese chat). A one-character first chunk that can begin one waits for the next chunk. */
export const SELF_NOTE_OPENERS: readonly string[] = ['拿到', '已知', '信息：', '信息:', '分析', '思路'];
/** The one-character first chunks that wait for the next chunk (the others begin too many ordinary replies). */
export const NOTE_WAIT_FIRST: readonly string[] = ['拿'];

/** A label and a colon at the start of a sentence: the heading of a note. */
export const NOTE_LABEL = /^[\s"“]*(?:(?:回答|规则|评价|要点|语气|人设|口吻|风格|策略|思路|分析|结论|总结|计划|备注|注意|判断|信息|已知|目标|格式)[ \t]*[:：]|(?:Personality|Tone|Plan|Persona|Style|Voice|Mood|Rules?|Notes?|Answer|Reply|Response|Strategy|Goal)[ \t]*[:：])/u;

/** A question to itself about whether to ask or mention something ("不要问昵称？", "要不要提一下？"), not one said to the user. */
export const SELF_QUESTION = /(?:要不要|该不该|需不需要|用不用|不要|别|不该)(?:再)?(?:问|提|说)(?![^。！？?\n]*[你您])[^。！？?\n]{0,16}[？?]/u;

/** A directive to itself (inside a note block only): what to do or not to do. */
export const DIRECTIVE = /不能|不要(?!紧)|不该|不必|不用|避免|别(?:说|提|问|再|太)|应该|需要|可以|不问|不提|保守|保持/u;

/** "用户" as the subject of a note, not inside a common noun ("用户名", "用户协议", "老用户"…). */
export const USER_NOTE_WORD = /(?<![老新大])用户(?!名|协议|体验|界面|数据|量|群|手册|中心|须知|等级|权限|账号|帐号)/u;

/** The longest quotation skipped when a sentence end is looked for; a longer one does not hide a full stop. */
const QUOTE_SPAN = 120;
const QUOTE_CLOSE: Record<string, string> = { '“': '”', '"': '"', '「': '」', '『': '』' };

/**
 * Where a quotation that opens at `at` closes in `text` (index of the closing mark), -1 when it does not close on its line within
 * QUOTE_SPAN characters, or null when that is not known yet.
 */
function quoteClose(text: string, at: number, final: boolean): number | null {
  const close = QUOTE_CLOSE[text[at]];
  for (let i = at + 1; i < text.length && i <= at + QUOTE_SPAN; i++) {
    if (text[i] === close) return i;
    if (text[i] === '\n' || text[i] === '\r' || text.startsWith('<sh-', i)) return -1;
  }
  return text.length > at + QUOTE_SPAN || final ? -1 : null;
}

/**
 * End of the Chinese sentence that starts `body` (with its closing quotes and brackets), and the character that ended it
 * (`mark`), or null when it is not complete yet. Like the guard's own sentence ends, but a full stop inside a quotation that
 * closes on its line does not count.
 */
export function noteUnitBounds(body: string, final: boolean): { end: number; mark: number } | null {
  const stop = body.indexOf('<sh-');
  const limit = stop >= 0 ? stop : body.length;
  for (let i = 0; i < limit; i++) {
    const c = body[i];
    if (c === '\n' || c === '\r') return { end: i, mark: i };
    if (QUOTE_CLOSE[c] !== undefined) {
      const close = quoteClose(body.slice(0, limit), i, final || stop >= 0);
      if (close === null) return null;
      if (close > 0) { i = close; continue; }
    }
    if ('。！？!?'.includes(c)) { let j = i + 1; while (j < limit && '”’」』）)"'.includes(body[j])) j++; return { end: j, mark: i }; }
  }
  return stop >= 0 || final ? { end: limit, mark: limit } : null;
}

/** The sentence without what it quotes: closed quotations, and an unclosed one (opening or closing) to its end or from its start. */
export function withoutQuotes(unit: string): string {
  let out = '';
  for (let i = 0; i < unit.length; i++) {
    const close = QUOTE_CLOSE[unit[i]];
    if (close !== undefined) {
      const end = unit.indexOf(close, i + 1);
      if (end < 0) break; // a quotation still open at the end of the sentence
      out += ' '; i = end; continue;
    }
    if ('”」』'.includes(unit[i])) { out = ' '; continue; } // the end of a quotation that opened before this sentence
    out += unit[i];
  }
  return out;
}
