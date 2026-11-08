// Keeps "UTF-8 read as GBK" garbage out of her reply (docs/claude/2026-11-03-mojibake-guard.md).
//
// On 2026-11-03 a reply came back from the model with runs like "鍙戠敓浜嗕粈涔" and "锛屾垜": Chinese text whose UTF-8
// bytes were decoded as GBK somewhere (most likely on a screenshot she was shown) and then copied out by the model. Such a
// run can be undone exactly: encode it back to GBK bytes and decode those bytes as UTF-8 ("鍙戠敓浜嗕粈" → "发生了什").
//
// The decision is made here and nowhere else:
//   * a run is garbage only if its GBK bytes decode as UTF-8 into at least two Chinese characters or punctuation marks,
//     most of them everyday ones, and the run itself is mostly rare characters (as garbage is; an ordinary name such as
//     "宸风华" whose bytes happen to spell "巷绪" is mostly everyday characters). Ordinary text (rare characters, old-style
//     names, poems, Traditional Chinese, Japanese, emoji, code) practically never lines up like that, and passes byte for
//     byte; when in doubt a run passes as it is (garbage shown beats her words changed);
//   * a run that decodes is replaced by what it decodes to (repaired); the pieces around it that cannot be decoded (a
//     character cut in half, the "?" a decoder left for a lost byte, a few odd characters where the copy went wrong) are
//     dropped, never shown or read;
//   * a sentence end ("。！？!?") never helps a run to be judged garbled, and once ordinary text shows after a repaired run (a
//     sentence end, Chinese punctuation, an everyday character) the judgement starts afresh: a rare name a few words later
//     is not read as more of the same garbage (Codex T-207 round 2: "浣犲ソ。她叫宸。" had become "你好。她叫巡");
//   * nothing is ever rewritten in ordinary text.
//
// Streaming (MojibakeGuard): only a character that can begin such a run (a GBK character whose first byte is a UTF-8 lead
// byte of Chinese text and whose second byte a continuation byte; 515 characters, all of them rare) is held. In ordinary
// text the next character already fails to line up and both go out; every other character passes in the same push() call,
// so the first character of an ordinary reply is never delayed. A garbled run is confirmed after two decoded characters
// (about three garbled ones; at most LONG_RUN decoded ones) and from then on goes out repaired as it decodes, so not even
// its first garbled character is shown. MoodReplyProtocol (electron/mood-chat.ts) runs every reply through this first.

/** GBK two-byte code of each BMP character, 0 for none; built once from the platform's own GBK decoder (null if it has none). */
let table: Uint16Array | null | undefined;

function gbkTable(): Uint16Array | null {
  if (table !== undefined) return table;
  try {
    // One decode of every two-byte code, each followed by a line break (no GBK byte is 0x0a), takes a few milliseconds.
    const bytes = new Uint8Array(126 * 190 * 3);
    let n = 0;
    for (let lead = 0x81; lead <= 0xfe; lead++) for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      bytes[n++] = lead; bytes[n++] = trail; bytes[n++] = 0x0a;
    }
    const parts = new TextDecoder('gbk').decode(bytes.subarray(0, n)).split('\n');
    const map = new Uint16Array(0x10000);
    let i = 0;
    for (let lead = 0x81; lead <= 0xfe; lead++) for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      const part = parts[i++];
      if (part?.length === 1 && part !== '�' && !map[part.charCodeAt(0)]) map[part.charCodeAt(0)] = (lead << 8) | trail;
    }
    table = map;
  } catch { table = null; }
  return table;
}

/** Builds the GBK table now (a few milliseconds), so the first character of a reply never waits for it. */
export function prepareMojibakeCheck(): boolean { return gbkTable() !== null; }

/** The GBK two-byte code of a character, 0 when it has none (ASCII, emoji, characters outside GBK). */
export function gbkCode(char: string): number {
  const map = gbkTable();
  const cp = char.codePointAt(0) ?? 0;
  return map && cp < 0x10000 ? map[cp] : 0;
}

const isContinuation = (byte: number): boolean => byte >= 0x80 && byte <= 0xbf;
/** Length of the UTF-8 sequence a Chinese text's byte can start: 3 (E2–E9, EF), 4 (F0, emoji); 1 for a printable ASCII byte a GBK trail swallowed. */
function sequenceLength(byte: number): number {
  if ((byte >= 0xe2 && byte <= 0xe9) || byte === 0xef) return 3;
  if (byte === 0xf0) return 4;
  return byte >= 0x40 && byte <= 0x7e ? 1 : 0;
}

/**
 * What Chinese text is made of: punctuation, symbols, kana, CJK (with the extensions beyond the BMP, so a garbled "𠮷" is
 * held from its first character like any other, Codex T-207 M03), full-width forms, variation selectors, emoji.
 */
const PLAUSIBLE: ReadonlyArray<readonly [number, number]> = [[0x2000, 0x2bff], [0x3000, 0x30ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xfe00, 0xfe0f], [0xfe30, 0xfe4f], [0xff00, 0xffef], [0x1f000, 0x1faff], [0x20000, 0x2fa1f]];
const plausibleRange = (low: number, high: number): boolean => PLAUSIBLE.some(([from, to]) => low <= to && high >= from);
/** Marks that only shape the character before them (variation selectors, the zero-width joiner, the keycap): not counted. */
const isModifier = (cp: number): boolean => (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d || cp === 0x20e3;

/** Everyday text: GB2312 level-1 characters, common punctuation and full-width forms, kana, emoji. */
function isCommon(cp: number): boolean {
  const map = gbkTable();
  const code = map && cp < 0x10000 ? map[cp] : 0;
  if (code) {
    const lead = code >> 8, trail = code & 0xff;
    if (trail >= 0xa1 && ((lead >= 0xb0 && lead <= 0xd7) || lead === 0xa1 || lead === 0xa3)) return true;
  }
  // Dashes, quotes, ellipsis; the symbols and dingbats chat uses as emoji ("❤""☀""✨""⭐"); CJK punctuation; kana;
  // full-width ASCII and currency; emoji.
  return (cp >= 0x2010 && cp <= 0x2027) || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x2b50 && cp <= 0x2b55)
    || (cp >= 0x3000 && cp <= 0x301f) || (cp >= 0x3041 && cp <= 0x30ff)
    || (cp >= 0xff01 && cp <= 0xff5e) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff);
}

/** A GBK character that is not everyday text (see isCommon): what is left around a garbled run when the copy went wrong. */
const isRare = (char: string): boolean => gbkCode(char) !== 0 && !isCommon(char.codePointAt(0)!);

/**
 * Full-width sentence ends. Their GBK bytes (A1 A3, A3 A1, A3 BF) continue a UTF-8 sequence, so a name before one could be
 * read on through it ("宸。" as "巡", "鈥愭。" as "‐档"). Codex T-207 round 2: a sentence end never counts as evidence. It
 * ends the run before it, as a character outside GBK does ("!" and "?" are outside GBK), unless it is exactly the two
 * bytes the run's last character still needs: in real garbage that is how "归档" "衣" "裡" come out ("褰掓。" "！"). Even
 * then the character it completes is not counted, so only the characters around it can confirm the run.
 */
const STOPS = new Set(['。', '！', '？']);
/** Chinese punctuation, the half-width sentence ends and a line break: shown as they are, they end what came before. */
const CLEAN_MARKS = new Set(['。', '！', '？', '!', '?', '，', '、', '；', '：', '…', '—', '“', '”', '‘', '’', '（', '）', '《', '》', '「', '」', '\n']);
/**
 * Ordinary text showing as it is (Codex T-207 round 2): a sentence end, Chinese punctuation, a new line, or an everyday
 * character (GB2312 level 1). After one of these, a run is judged as in a reply that had no garbage yet. (Spaces and
 * English words do not count: garbage interleaved with English, "鐪? handbook銆乨ocs", still needs the shorter rule.)
 */
function isClean(char: string): boolean {
  if (CLEAN_MARKS.has(char)) return true;
  const code = gbkCode(char), lead = code >> 8;
  return lead >= 0xb0 && lead <= 0xd7 && (code & 0xff) >= 0xa1;
}

/**
 * Can this character begin a garbled run? Its first GBK byte starts a UTF-8 sequence of Chinese text and its second byte
 * continues it. Only rare characters (GB2312 level 2 and the GBK extensions) have that shape.
 */
export function canStartMojibake(char: string): boolean {
  const code = gbkCode(char);
  if (!code) return false;
  const lead = code >> 8, second = code & 0xff;
  const length = sequenceLength(lead);
  if (length < 3 || !isContinuation(second)) return false;
  const known = ((lead & (length === 3 ? 0x0f : 0x07)) << 6) | (second & 0x3f);
  const rest = 6 * (length - 2);
  return plausibleRange(known << rest, ((known + 1) << rest) - 1);
}

type Decoded = { cp: number; length: number } | 'more' | null;

/** The UTF-8 sequence at `at`: a plausible character, 'more' while it could still become one, or null. */
function decodeAt(bytes: readonly number[], at: number): Decoded {
  const length = sequenceLength(bytes[at]);
  if (!length) return null;
  if (length === 1) return { cp: bytes[at], length };
  let cp = bytes[at] & (length === 3 ? 0x0f : 0x07);
  for (let k = 1; k < length; k++) {
    if (at + k >= bytes.length) {
      const rest = 6 * (length - k);
      return plausibleRange(cp << rest, ((cp + 1) << rest) - 1) ? 'more' : null;
    }
    if (!isContinuation(bytes[at + k])) return null;
    cp = (cp << 6) | (bytes[at + k] & 0x3f);
  }
  return plausibleRange(cp, cp) ? { cp, length } : null;
}

/** A run being looked at: the characters since a possible start, their bytes, and what they decode to so far. */
interface Run {
  chars: string[];
  /** Where each character's bytes end (a GBK character is two bytes; "€" for the lone byte 0x80 is one). */
  ends: number[];
  bytes: number[];
  /** Bytes decoded so far. */
  at: number;
  /** Decoded text not handed on yet (all of it, until the run is confirmed). */
  out: string;
  /** Decoded multi-byte characters, and how many of them are everyday ones. */
  decoded: number;
  common: number;
  confirmed: boolean;
  /** The last character is a "€" whose bytes the next character decides (see runBytes). */
  euro: boolean;
  /** The character the next decode completes ends in a sentence end's bytes: it is not counted (see STOPS). */
  uncounted: boolean;
}

/**
 * Everyday decoded characters that confirm a run in a reply that had no garbled run yet (one is enough once it had one);
 * at least two thirds of what the run decoded to must be everyday characters. A run that keeps decoding for LONG_RUN
 * characters is garbled whatever it decodes to (ordinary text never lines up that long), which also bounds how long a
 * run is held before it is decided.
 */
const CONFIRM = 2;
const LONG_RUN = 6;
/**
 * The garbled characters themselves must look garbled, too: at least half of them are not everyday text (isRare). Garbage
 * made of Chinese text is mostly GBK extension and level-2 characters (about 85% of them); an ordinary name or identifier
 * whose GBK bytes happen to spell everyday characters ("宸风华" spells "巷绪", Codex T-207 M01) is mostly everyday characters
 * itself and stays as it is. This only ever makes the decision stricter: it can let garbage through, never change ordinary text.
 */
const looksGarbled = (run: Run): boolean => run.chars.filter(isRare).length * 2 >= run.chars.length;
const confirms = (run: Run, seen: boolean): boolean => looksGarbled(run)
  && ((run.common >= (seen ? 1 : CONFIRM) && run.common * 3 >= run.decoded * 2) || run.decoded >= LONG_RUN);
/** Odd characters dropped right after a garbled run that broke off in the middle (the copy went wrong there). */
const GARBAGE_AFTER_BREAK = 3;

/**
 * The bytes a character stands for inside a garbled run: its GBK code. A GBK decoder makes "€" of the lone byte 0x80 and of
 * the pair A2 E3 alike; inside a run it is 0x80, unless the sequence needs exactly one more byte: then the next character
 * decides (a continuation byte after it means the pair, so "鍛€€" is "呢" and the start of "。", not "呀").
 */
function runBytes(char: string): number[] | null {
  if (char === '\u20ac') return [0x80];
  const code = gbkCode(char);
  return code ? [code >> 8, code & 0xff] : null;
}

/** Continuation bytes the unfinished sequence at the end of the run still needs (0 when it ends between sequences). */
function needed(run: Run): number {
  if (run.at >= run.bytes.length) return 0;
  return sequenceLength(run.bytes[run.at]) - (run.bytes.length - run.at);
}

export interface MojibakeCounts {
  /** Garbled runs replaced by what they decode to. */
  repaired: number;
  /** Garbled characters replaced (the length of those runs). */
  repairedChars: number;
  /** Characters dropped because they could not be decoded (cut halves, residue, odd characters around a run). */
  dropped: number;
}

/**
 * Stateful filter over one reply. `push()` returns what may be shown now (empty while a possible start is held);
 * `finish()` returns the rest. Ordinary text passes unchanged and in order; only garbled runs are replaced or dropped.
 */
export class MojibakeGuard {
  readonly counts: MojibakeCounts = { repaired: 0, repairedChars: 0, dropped: 0 };
  private run: Run | null = null;
  /**
   * This reply just had a garbled run: from then on a shorter run is enough (one decoded everyday character, as in
   * "銆乭andbook" → "、handbook" between English words), and a lone cut-off character goes ("锛" before a line end).
   * Ordinary text shown after it (isClean) ends this: the next run is judged afresh (Codex T-207 round 2).
   */
  private seen = false;
  /** After a run that ended on a lost byte: one "?" or "\ufffd" a decoder put there goes too. */
  private residue = false;
  private garbage = 0;
  private readonly enabled: boolean;

  constructor() { this.enabled = prepareMojibakeCheck(); }

  push(text: string): string {
    if (!text || !this.enabled) return text ?? '';
    let out = '';
    for (const char of text) out += this.take(char);
    return out;
  }

  finish(): string {
    const out = this.close('finish');
    this.residue = false;
    this.garbage = 0;
    return out;
  }

  /** True when something garbled was replaced or dropped in this reply. */
  changed(): boolean { return this.counts.repaired > 0 || this.counts.dropped > 0; }

  /**
   * Hands back, unjudged, the characters still held (the stream moved on to something that is not shown, such as the
   * reply's private state tail) and starts over. Nothing is counted.
   */
  release(): string {
    const run = this.run;
    this.run = null;
    this.residue = false;
    this.garbage = 0;
    if (!run) return '';
    let whole = 0;
    while (run.confirmed && whole < run.chars.length && run.ends[whole] <= run.at) whole++;
    return run.chars.slice(whole).join('');
  }

  private take(char: string): string {
    let out = '';
    // A sentence end is never evidence (Codex T-207 round 2): the run ends before it and it is looked at on its own, unless
    // it is exactly the last two bytes the run's last character needs ("褰掓。" is "归档"); that character is not counted.
    if (this.run && STOPS.has(char)) {
      if (this.run.euro || needed(this.run) !== 2) out += this.close('stop');
      else this.run.uncounted = true;
    }
    const bytes = runBytes(char);
    if (this.run?.euro) out += this.settleEuro(!!bytes && isContinuation(bytes[0]));
    if (this.run) {
      const run = this.run;
      if (bytes) {
        run.chars.push(char);
        if (char === '\u20ac' && needed(run) === 1) { run.euro = true; return out; }
        run.bytes.push(...bytes);
        run.ends.push(run.bytes.length);
        return out + this.advance();
      }
      // A run cut off by the decoder's replacement character for its lost byte ("鍐" + "\ufffd", "寮€鍏" + "\ufffd"): a lone
      // start is garbage, and a run that decoded to everyday text so far is a garbled one. (Before a plain "?" this is not
      // decided: "愣?" is ordinary text, and a rare character, an everyday one and "?" happen in ordinary text too.)
      if (char === '\ufffd' && !run.confirmed && run.at < run.bytes.length) {
        if (run.decoded === 0) {
          this.run = null;
          this.seen = true;
          this.counts.dropped += run.chars.length + 1;
          return out;
        }
        if (run.common * 2 >= run.decoded) { this.confirm(run); out += run.out; run.out = ''; }
      }
      out += this.close('break');
    }
    // The "?" or "\ufffd" a decoder put where a garbled run lost its last byte goes with the run.
    const residue = this.residue;
    this.residue = false;
    if (residue && (char === '?' || char === '\ufffd')) { this.counts.dropped++; return out; }
    if (canStartMojibake(char)) {
      this.run = { chars: [char], ends: [2], bytes: bytes!, at: 0, out: '', decoded: 0, common: 0, confirmed: false, euro: false, uncounted: false };
      return out + this.advance();
    }
    return out + this.plain(char);
  }

  /** Ends the run (and any run that ending it begins again from its characters). */
  private close(reason: 'break' | 'stop' | 'finish'): string {
    let out = '';
    while (this.run) out += this.run.euro ? this.settleEuro(false) : this.end(reason);
    return out;
  }

  /** The "€" waiting at the end of the run becomes the pair A2 E3 (`pair`) or the byte 0x80. */
  private settleEuro(pair: boolean): string {
    const run = this.run!;
    run.euro = false;
    run.bytes.push(...(pair ? [0xa2, 0xe3] : [0x80]));
    run.ends.push(run.bytes.length);
    return this.advance();
  }

  /** A character that is not part of a run: shown, unless it is one of the odd characters right after a run that broke off. */
  private plain(char: string): string {
    if (this.garbage > 0) {
      if (char === '\ufffd' || isRare(char)) { this.garbage--; this.counts.dropped++; return ''; }
      this.garbage = 0;
    }
    if (this.seen && isClean(char)) this.seen = false;
    return char;
  }

  /** Decodes what it can of the run; confirms it, hands on repaired text, or ends it at the first byte that does not fit. */
  private advance(): string {
    const run = this.run!;
    let out = '';
    while (run.at < run.bytes.length) {
      const next = decodeAt(run.bytes, run.at);
      if (next === 'more') break;
      if (next === null) return out + this.end('invalid');
      run.out += String.fromCodePoint(next.cp);
      run.at += next.length;
      // A variation selector or joiner ("❤" + U+FE0F) belongs to the character before it and is not counted (T-207 M04);
      // nor is a character completed by a sentence end's bytes (round 2).
      const counted = !run.uncounted;
      run.uncounted = false;
      if (counted && next.length > 1 && !isModifier(next.cp)) { run.decoded++; if (isCommon(next.cp)) run.common++; }
      if (!run.confirmed && confirms(run, this.seen)) this.confirm(run);
      if (run.confirmed) { out += run.out; run.out = ''; }
    }
    return out;
  }

  private confirm(run: Run): void {
    run.confirmed = true;
    this.seen = true;
    this.counts.repaired++;
    this.garbage = 0;
    this.residue = false;
  }

  /**
   * The run is over: `break` (a character outside GBK came), `stop` (a sentence end came), `invalid` (a byte that does not
   * fit) or `finish`. A confirmed run keeps its repaired text and drops the characters it could not decode; an unconfirmed
   * one was ordinary text: its first character goes out and the rest is looked at again.
   */
  private end(reason: 'break' | 'stop' | 'invalid' | 'finish'): string {
    const run = this.run!;
    this.run = null;
    if (!run.confirmed) {
      // Right after garbage, a character cut off before a line end or an English word (nothing of it decoded) is garbage
      // too. (Not before a full-width sentence end: a rare character there is as likely a name, and garbage shown beats
      // her words changed; nor when a sentence end completed it, round 2.)
      if (this.seen && reason !== 'invalid' && reason !== 'stop' && run.at === 0) {
        this.counts.dropped += run.chars.length;
        this.residue = true;
        return '';
      }
      let out = this.plain(run.chars[0]);
      for (const char of run.chars.slice(1)) out += this.take(char);
      return out;
    }
    const out = run.out;
    let whole = 0;
    while (whole < run.chars.length && run.ends[whole] <= run.at) whole++;
    this.counts.repairedChars += whole;
    if (reason !== 'invalid') {
      // What is left is an incomplete sequence: the garbled run's own last character(s), cut where a byte was lost.
      const left = run.chars.length - whole;
      this.counts.dropped += left;
      this.residue = left > 0;
      return out;
    }
    // The copy went wrong here (or ordinary text follows). A character cut in half goes, and so do a few odd ones right after
    // it. A run that ended cleanly between two characters proves no copy error: what follows may be ordinary text (a
    // Japanese "凪" is a rare GBK character too, Codex T-207 M02) and is looked at afresh, never dropped.
    const half = whole < run.chars.length && (whole === 0 ? 0 : run.ends[whole - 1]) < run.at;
    if (half) this.counts.dropped++;
    this.garbage = half ? GARBAGE_AFTER_BREAK : 0;
    let rest = '';
    for (const char of run.chars.slice(whole + (half ? 1 : 0))) rest += this.take(char);
    return out + rest;
  }
}

/** The same decision for a whole text at once (a reply that did not stream, a proactive line). */
export function cleanMojibake(text: string): { text: string; counts: MojibakeCounts } {
  const guard = new MojibakeGuard();
  const out = guard.push(text) + guard.finish();
  return { text: out, counts: { ...guard.counts } };
}
