/**
 * I-078 第 2 步 (docs/claude/2026-11-11-i078-sleep-step2-3.md): does the user's own message clearly ask her to wake up?
 * The confirmed design (docs/mood/fatigue-sleep-and-furniture.md): talking to her while she sleeps only wakes her a little each time
 * (gradually); "醒醒" from the user wakes her at once. Only the user's typed or spoken words are read (never her reply, a web page or
 * a tool result). Conservative on purpose: a report about oneself ("我刚起床", "I woke up at 7"), a negation ("别叫醒她", "don't wake
 * up") or an idiom ("醒醒神") is not a request; when unsure it is not one, and the message still wakes her a little as any message.
 */

const CLAUSE = /[，,。.!！?？~～\n;；…、:：()（）"“”]+/;
/**
 * Chinese wake phrases. 起床 / 起来 only as a call (with a sentence particle or 快/该/赶紧 before), since "起床" alone is often a
 * report ("我起床了", "几点起床").
 */
const ZH = /(醒醒(?![神脑])|醒一醒|快醒|该醒了|醒来吧|醒过来|别睡了|别再睡了|不要睡了|不要再睡了|别睡啦|(?:快|该|赶紧|快点)起床|起床(?:啦|吧|咯|喽|了喂)|(?:快|该|赶紧|快点)起来(?:啦|吧|了)?|起来啦|起来吧)/;
/** Before the phrase in its clause: a first-person subject or a time question makes it a report, a negation makes it "don't". */
const ZH_NOT = /(我|咱|俺|几点|什么时候|啥时候|明天|明早|今早|每天|刚|才|已经|别叫|不用|不要叫|不想|没)/;
const ZH_NEGATED = /(别|不要|不用|不必|没有?|不)$/;
/** English: the clause starts with the call (after interjections and at most one name-like word). */
const EN_CALL = /^(?:(?:hey|hi|oi|oh|ok|okay|come on|please|psst|sweetie|honey|babe|dear|darling|sleepyhead)\s+)*(?:([a-z][a-z'-]*)\s+)?(?:time to\s+)?(wake up|wakey(?:\s+wakey)?|rise and shine|get up|up you get)\b/;
const EN_NOT_LEAD = new Set(['i', 'we', 'they', 'he', 'she', 'it', 'you', "you'll", 'to', 'will', 'did', "didn't", "don't", 'dont', 'not', 'never', "can't", 'cant',
  'when', 'before', 'after', 'usually', 'always', 'should', 'would', 'could', 'might', 'gotta', 'must', 'and', 'then', 'so', 'just', 'to']);

/** True when one clause of `text` is the user asking her to wake up. Bounded: only the first 600 characters are read. */
export function explicitWakeRequest(text: unknown): boolean {
  if (typeof text !== 'string' || !text.trim()) return false;
  for (const raw of text.slice(0, 600).toLowerCase().split(CLAUSE)) {
    const clause = raw.trim();
    if (!clause) continue;
    const zh = ZH.exec(clause);
    if (zh) {
      const before = clause.slice(0, zh.index);
      if (!ZH_NOT.test(before) && !ZH_NEGATED.test(before)) return true;
    }
    const en = EN_CALL.exec(clause.replace(/\s+/g, ' '));
    if (en && !(en[1] && EN_NOT_LEAD.has(en[1]))) return true;
  }
  return false;
}
