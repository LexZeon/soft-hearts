/**
 * BERT / WordPiece tokenizer for BGE-small-zh-v1.5, written for this project (no npm dependency, no copied code). It follows
 * the pinned model files' own tokenizer settings (tokenizer.json of the Xenova conversion: BertNormalizer clean_text +
 * handle_chinese_chars, no lower-casing, no accent stripping; BertPreTokenizer; WordPiece "##", unk [UNK], max 100 chars per
 * word; template [CLS] x [SEP]). Pure: the vocabulary (vocab.txt, one token per line, line number = id) is passed in.
 */

const CJK: readonly (readonly [number, number])[] = [
  [0x4e00, 0x9fff], [0x3400, 0x4dbf], [0x20000, 0x2a6df], [0x2a700, 0x2b73f], [0x2b740, 0x2b81f], [0x2b820, 0x2ceaf], [0xf900, 0xfaff], [0x2f800, 0x2fa1f],
];
const isCjk = (cp: number) => CJK.some(([lo, hi]) => cp >= lo && cp <= hi);
const isWhitespace = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || /\p{Zs}/u.test(ch);
const isControl = (ch: string) => ch !== '\t' && ch !== '\n' && ch !== '\r' && /[\p{Cc}\p{Cf}]/u.test(ch);
const isPunctuation = (ch: string) => {
  const cp = ch.codePointAt(0)!;
  return (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126) || /\p{P}/u.test(ch);
};

export const MAX_WORD_CHARS = 100;

export class WordPieceTokenizer {
  readonly ids: ReadonlyMap<string, number>;
  readonly cls: number; readonly sep: number; readonly unk: number; readonly pad: number;

  constructor(vocabText: string) {
    const ids = new Map<string, number>();
    vocabText.replace(/\r\n/g, '\n').split('\n').forEach((token, index) => { if (token !== '' && !ids.has(token)) ids.set(token, index); });
    for (const special of ['[CLS]', '[SEP]', '[UNK]', '[PAD]']) if (!ids.has(special)) throw new Error(`vocabulary lacks ${special}`);
    this.ids = ids; this.cls = ids.get('[CLS]')!; this.sep = ids.get('[SEP]')!; this.unk = ids.get('[UNK]')!; this.pad = ids.get('[PAD]')!;
  }

  /** Normalizer + pre-tokenizer: the words (CJK characters and punctuation each alone). */
  words(text: string): string[] {
    const out: string[] = [];
    let word = '';
    const flush = () => { if (word) { out.push(word); word = ''; } };
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0 || cp === 0xfffd || isControl(ch)) continue;
      if (isWhitespace(ch)) { flush(); continue; }
      if (isCjk(cp) || isPunctuation(ch)) { flush(); out.push(ch); continue; }
      word += ch;
    }
    flush();
    return out;
  }

  /** WordPiece of one word: greedy longest match from the left, "##" for the rest; a word with an unmatched stretch is [UNK] whole. */
  piece(word: string): number[] {
    const chars = Array.from(word);
    if (chars.length > MAX_WORD_CHARS) return [this.unk];
    const out: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length, found: number | undefined;
      while (start < end) {
        const part = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
        const id = this.ids.get(part);
        if (id !== undefined) { found = id; break; }
        end--;
      }
      if (found === undefined) return [this.unk];
      out.push(found); start = end;
    }
    return out;
  }

  /** [CLS] tokens [SEP], cut to `maxTokens` (the [SEP] is kept). */
  encode(text: string, maxTokens = 128): number[] {
    const body: number[] = [];
    const room = Math.max(0, Math.min(512, maxTokens) - 2);
    for (const word of this.words(typeof text === 'string' ? text : '')) {
      for (const id of this.piece(word)) { if (body.length < room) body.push(id); }
      if (body.length >= room) break;
    }
    return [this.cls, ...body, this.sep];
  }
}
