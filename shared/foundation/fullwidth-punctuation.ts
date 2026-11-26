// I-071 fix 6 (sixth test): the Claude 助手 wrote its Chinese text and button labels with ASCII "," "?" "!" ":" between Han
// characters. The prompt asks for full-width marks; this is the host's net under it, for the assistant's displayed Chinese text and
// choice labels only (never code, links or English sentences).
const HAN = '\\p{Script=Han}';
const CLOSERS = '」』”’）)】》';
const MARKS: Readonly<Record<string, string>> = { ',': '，', '?': '？', '!': '！', ':': '：', ';': '；' };
// A mark that follows a Han character and is followed by the end, a line break, (spaces and) a Han character or a closing bracket or quote:
// "你好,世界" "好吗?" "说明: 先看" become full-width; "12:30", "https://x", "Hello, world" and "a.b" never match (no Han right before).
const AFTER_HAN = new RegExp(`(?<=${HAN})([,?!:;])(?=\\s*$|\\n|\\s*${HAN}|[${CLOSERS}])`, 'gu');
// Parts that stay as written: fenced and inline code, links, and the mark that begins a "://".
const KEEP = /```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+|www\.\S+/giu;

/** Is the clause that ends at `end` (back to the line start or the last sentence end, at most 40 characters) mostly Chinese? */
function chineseClause(piece: string, end: number): boolean {
  const clause = piece.slice(Math.max(0, end - 40), end).split(/[\n。！？.!?]/u).pop() ?? '';
  const han = (clause.match(/\p{Script=Han}/gu) ?? []).length, latin = (clause.match(/[A-Za-z]/gu) ?? []).length;
  return han >= latin;
}

/** The text with ASCII , ? ! : ; right after a Han character turned into the full-width mark (code spans and links untouched). */
export function fullWidthChinese(text: string): string {
  if (!/\p{Script=Han}/u.test(text)) return text;
  let out = '', last = 0;
  // Only where the words next to the mark are Chinese: an English sentence with one Chinese word in it keeps its ASCII marks.
  const convert = (piece: string) => piece.replace(AFTER_HAN, (_match, mark: string, offset: number, whole: string) => (mark === ':' && whole.slice(offset + 1, offset + 3) === '//') || !chineseClause(whole, offset) ? mark : MARKS[mark]!);
  for (const match of text.matchAll(KEEP)) {
    out += convert(text.slice(last, match.index)) + match[0];
    last = match.index! + match[0].length;
  }
  return out + convert(text.slice(last));
}

// I-071 fix 8 (Codex T-240 F09): the other direction, for a converted ENGLISH card. The model may write "I went for a walk！" in a
// JSON field; the conversion's own cleaning turns every CJK punctuation mark of a translated text into its ASCII form (a space after
// a sentence or clause mark when a word follows, one before an opening bracket after a word). Curly quotes stay (they are English
// typography too); the conversion's own mark 〔…〕 stays (its checks look for it). A Chinese card is never passed through this.
const ASCII_MARKS: Readonly<Record<string, string>> = {
  '，': ',', '。': '.', '！': '!', '？': '?', '：': ':', '；': ';', '、': ',', '（': '(', '）': ')', '【': '[', '】': ']',
  '「': '"', '」': '"', '『': '"', '』': '"', '《': '"', '》': '"', '～': '~', '　': ' ',
};
const SPACE_AFTER = new Set([',', '.', '!', '?', ':', ';', ')', ']']);
const WIDE = /[　-〿！-～]/gu;
/** `text` with CJK and full-width punctuation as ASCII ("Hi，you！" → "Hi, you!"); everything else unchanged. */
export function asciiPunctuation(text: string): string {
  if (!/[　-〿！-～]/u.test(text)) return text;
  return text.replace(/——/gu, '—').replace(/……/gu, '…').replace(WIDE, (char: string, offset: number, whole: string) => {
    const ascii = ASCII_MARKS[char];
    // Full-width letters, digits and other symbols: their plain form; the rest of the CJK block (〔〕 among them) stays.
    if (ascii === undefined) return char >= '！' ? char.normalize('NFKC') : char;
    const next = whole[offset + 1] ?? '', previous = whole[offset - 1] ?? '';
    if (ascii === '(' || ascii === '[') return /[\p{L}\p{N}]/u.test(previous) ? ` ${ascii}` : ascii;
    return SPACE_AFTER.has(ascii) && /[\p{L}\p{N}("“‘]/u.test(next) ? `${ascii} ` : ascii;
  }).replace(/[ \t]{2,}/gu, ' ');
}
