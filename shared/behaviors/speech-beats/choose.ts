/**
 * 边说边演的纯规则（接口见 interface.ts，旋钮见 knobs.ts，方案 docs/claude/2026-11-19-per-reply-choreo-plan.md）：
 * 词表的意思、提示词里那一句、流式过滤（把 ⟦词⟧ 从字里去掉并记成拍子）、只演不说时的灰色小字。不调用任何模型，不碰时钟。
 */
import { SPEECH_BEAT_CONTACT, SPEECH_BEAT_KNOBS, type SpeechBeatKnobs } from './knobs';
import { SPEECH_BEAT_CLOSE_WORDS, SPEECH_BEAT_FRAME_WORDS, SPEECH_BEAT_GO_WORDS, SPEECH_BEAT_HOWS, SPEECH_BEAT_PAUSE_LONG, SPEECH_BEAT_WORDS, type SpeechBeat, type SpeechBeatFrameWord, type SpeechBeatChannel, type SpeechBeatChunk, type SpeechBeatCloseWord, type SpeechBeatGoTo, type SpeechBeatGoWord, type SpeechBeatHow, type SpeechBeatShowcaseWord, type SpeechBeatSummary, type SpeechBeatWord } from './interface';
import { BROKEN_SUFFIX, MARKERISH, goPending, goToOf, readGoTo } from './go-to';

const WORD_SET: ReadonlySet<string> = new Set<string>([...SPEECH_BEAT_WORDS, ...SPEECH_BEAT_GO_WORDS, ...SPEECH_BEAT_FRAME_WORDS]);
export const isSpeechBeatWord = (value: string): value is SpeechBeatWord => WORD_SET.has(value);
/** I-185: kiss or hug (the close-moment words: not showcase beats). */
export const isCloseBeatWord = (value: unknown): value is SpeechBeatCloseWord => (SPEECH_BEAT_CLOSE_WORDS as readonly unknown[]).includes(value);
/** I-193: the "go where" words (full-screen Unbound only: she walks; no showcase beat, no close moment). */
export const isGoBeatWord = (value: unknown): value is SpeechBeatGoWord => (SPEECH_BEAT_GO_WORDS as readonly unknown[]).includes(value);
export const isSpeechBeatHow = (value: unknown): value is SpeechBeatHow => (SPEECH_BEAT_HOWS as readonly unknown[]).includes(value);
/** I-203: a frame of a kiss or a hug (hug-held, pause, let-go): no showcase beat; full-screen Unbound plays it through its host. */
export const isFrameBeatWord = (value: unknown): value is SpeechBeatFrameWord => (SPEECH_BEAT_FRAME_WORDS as readonly unknown[]).includes(value);
/** I-203: her words after this beat wait at it (in full-screen, where the host holds them): a hug-held, a pause. A kiss / hug itself never holds them. */
export const holdsWordsAt = (word: unknown): boolean => word === 'hug-held' || word === 'pause';
/** A beat's "how" as kept: her once / line, or (I-203) the long of a pause; anything else is dropped. */
export const beatHowOf = (word: unknown, how: unknown): SpeechBeat['how'] =>
  word === 'pause' ? (how === SPEECH_BEAT_PAUSE_LONG ? SPEECH_BEAT_PAUSE_LONG : undefined) : isSpeechBeatHow(how) ? how : undefined;
/** I-193: a beat's target as kept: only `go` carries one (go-to.ts goToOf). */
export const beatGoToOf = (word: unknown, goTo: unknown): SpeechBeatGoTo | undefined => (word === 'go' ? goToOf(goTo) : undefined);
/** The beat with its "how" (beatHowOf) and, for `go`, its target (I-193) as kept. */
export const keptBeat = (beat: SpeechBeat, at = beat.at): SpeechBeat => {
  const how = beatHowOf(beat.word, beat.how), goTo = beatGoToOf(beat.word, beat.goTo);
  return { word: beat.word, at, ...(how ? { how } : {}), ...(goTo ? { goTo } : {}) };
};

/**
 * I-175: what is inside a marker's brackets: a word, then at most a "how long" suffix (⟦pout once⟧, ⟦smile-warm line⟧). `own` (her ⟦⟧): a word
 * with any other suffix still plays, with the default (the suffix never shows); a backup bracket (【】〖〗[] [[ ]]) counts only with a known
 * suffix or none, so ordinary text in brackets that happens to start with a word ("[content warning]") still shows as written. null: not a marker.
 * I-193: `go` counts only with its numbers (⟦go 30% 1.2m⟧, go-to.ts readGoTo); without them, or with anything else after it, it is no marker
 * (her own bracket is then dropped whole, as any broken one).
 */
export function readMarkerBody(body: string, own: boolean): { word: SpeechBeatWord; how?: SpeechBeat['how']; goTo?: SpeechBeatGoTo } | null {
  const parts = body.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const word = parts[0] ?? '';
  if (!isSpeechBeatWord(word)) return null;
  if (word === 'go') { const goTo = readGoTo(parts.slice(1)); return goTo ? { word, goTo } : null; }
  if (parts.length === 1) return { word };
  // I-203: a pause takes only "long" (⟦pause long⟧); its own bracket with another suffix still pauses, the plain length.
  if (word === 'pause') return parts.length === 2 && parts[1] === SPEECH_BEAT_PAUSE_LONG ? { word, how: SPEECH_BEAT_PAUSE_LONG } : own ? { word } : null;
  if (parts.length === 2 && isSpeechBeatHow(parts[1])) return { word, how: parts[1] };
  return own ? { word } : null;
}

/** 每个词：提示词里写的中文意思（zh）、灰色小字里怎么说（told）、舞台的哪条通道（channel）。 */
export const SPEECH_BEAT_MEANINGS: Readonly<Record<SpeechBeatWord, { readonly zh: string; readonly told: string; readonly channel: SpeechBeatChannel }>> = Object.freeze({
  'look-you': { zh: '看你', told: '看着你', channel: 'gaze' },
  'look-away-left': { zh: '看向左边', told: '看向一边', channel: 'gaze' },
  'look-away-right': { zh: '看向右边', told: '看向一边', channel: 'gaze' },
  'look-down': { zh: '低头看下面', told: '低下头', channel: 'gaze' },
  'smile-small': { zh: '轻笑', told: '轻轻笑了', channel: 'expression' },
  'smile-warm': { zh: '暖笑', told: '暖暖地笑了', channel: 'expression' },
  laugh: { zh: '开心地笑', told: '笑出了声', channel: 'expression' },
  shy: { zh: '害羞', told: '害羞地笑了', channel: 'expression' },
  pout: { zh: '嘟嘴', told: '嘟起嘴', channel: 'expression' },
  surprise: { zh: '惊讶', told: '愣了一下', channel: 'expression' },
  sly: { zh: '坏笑', told: '坏笑了一下', channel: 'expression' },
  content: { zh: '满足', told: '一脸满足', channel: 'expression' },
  tilt: { zh: '歪头', told: '歪了歪头', channel: 'body' },
  'hand-cheek': { zh: '手放脸边', told: '手放到脸边', channel: 'body' },
  v: { zh: '比V', told: '比了个 V', channel: 'body' },
  'lean-in': { zh: '凑近一点', told: '凑近了一点', channel: 'body' },
  'lean-back': { zh: '退开一点', told: '往后退了一点', channel: 'body' },
  kiss: { zh: '亲你', told: '亲了你一下', channel: 'body' },
  hug: { zh: '抱你', told: '抱了抱你', channel: 'body' },
  'blink-slow': { zh: '慢慢眨眼', told: '慢慢眨了眨眼', channel: 'eyes' },
  // I-193: `told` only when the walk really happened (describeBeats' `walked`; 2026-11-24: never "走近了一些" when she did not move).
  'go-left': { zh: '去左边', told: '往左边走了', channel: 'body' },
  'go-right': { zh: '去右边', told: '往右边走了', channel: 'body' },
  'go-middle': { zh: '到中间', told: '走到了中间', channel: 'body' },
  'come-near': { zh: '走近', told: '走近了一些', channel: 'body' },
  'go-far': { zh: '走远', told: '走远了一些', channel: 'body' },
  'go-corner': { zh: '去角落', told: '走到了角落', channel: 'body' },
  'go-cursor': { zh: '到你鼠标旁边', told: '走到了鼠标旁边', channel: 'body' },
  go: { zh: '走到指定位置', told: '走了过去', channel: 'body' }, // I-193 numbers: ⟦go 30% 1.2m⟧ (the sentence's go clause says the format)
  // I-203 frames: what each one is (information only; the sentence's frames clause says how the words go with them).
  'hug-held': { zh: '抱住了', told: '抱住了你', channel: 'body' },
  pause: { zh: '停一会', told: '停了一会', channel: 'body' },
  'let-go': { zh: '松开', told: '松开了', channel: 'body' },
});

/**
 * 同一个动作在 Unbound 展示词表里的写法（shared/unbound/showcase.ts 的 ShowcaseBeat，不含 at、dur、intensity、feel）。
 * 这里只放数据，不引用展示模块；tests/speech-beats.test.ts 逐个核对它们在展示词表里都合法。kiss、hug 不在这里（I-185：CLOSE_BEAT_LIGHTER）。
 */
export const SPEECH_BEAT_SHOWCASE: Readonly<Record<SpeechBeatShowcaseWord, Readonly<Record<string, string | number>> & { readonly kind: string }>> = Object.freeze({
  'look-you': { kind: 'hold-gaze' },
  'look-away-left': { kind: 'glance', dir: 'left' },
  'look-away-right': { kind: 'glance', dir: 'right' },
  'look-down': { kind: 'glance', dir: 'down' },
  'smile-small': { kind: 'expression', name: 'confirm-smile', onset: 'quick' },
  'smile-warm': { kind: 'expression', name: 'warm-smile', onset: 'slow' },
  laugh: { kind: 'expression', name: 'laugh', onset: 'quick' },
  shy: { kind: 'expression', name: 'shy', onset: 'slow' },
  pout: { kind: 'expression', name: 'pout', onset: 'quick' },
  surprise: { kind: 'expression', name: 'surprise', onset: 'quick' },
  sly: { kind: 'expression', name: 'sly', onset: 'quick' },
  content: { kind: 'expression', name: 'content', onset: 'slow' },
  tilt: { kind: 'tilt', deg: 10 },
  'hand-cheek': { kind: 'hand-face', where: 'cheek', how: 'palm' },
  v: { kind: 'hand-sign', sign: 'v' },
  'lean-in': { kind: 'approach', amount: 0.15, lean: 0.4 },
  'lean-back': { kind: 'retreat', amount: 0.15 },
  'blink-slow': { kind: 'blink-style', style: 'soft' },
});

/**
 * I-185: when a kiss or a hug cannot play now (full-screen: her arms held, just kissed or hugged, a call, the input box, another moment on;
 * the window: her arms held or no arm rig for a hug), the lighter word plays in its place, never nothing. A hug's lighter one also opens her
 * arms a little where they are free (the stages' small in-place hug); a kiss's is a shy smile.
 */
export const CLOSE_BEAT_LIGHTER: Readonly<Record<SpeechBeatCloseWord, SpeechBeatShowcaseWord>> = Object.freeze({ kiss: 'shy', hug: 'lean-in' });

// ---------------------------------------------------------------- the prompt

/** 标记的写法：她自己的括号。 */
export const SPEECH_BEAT_OPEN = '⟦';
export const SPEECH_BEAT_CLOSE = '⟧';

/**
 * 回复说明里加的那一句（开关开着时才加；方案「提示词改哪几句」，方案已确认）。
 * 和方案草稿的差别只有"形如⟦tilt⟧"几个字：让她知道标记长什么样。
 * `spoken`（通话里）：对方在听，每条回复都要说出话来，不写"整条只有标记"那一句（通话里没有"只演不说"：没有字的回复在通话里是一次失败的回复）。
 */
export function speechBeatSentence(words: readonly SpeechBeatWord[] = SPEECH_BEAT_WORDS, spoken = false, language?: string | null): string {
  const list = [...SPEECH_BEAT_WORDS, ...SPEECH_BEAT_GO_WORDS, ...SPEECH_BEAT_FRAME_WORDS].filter(word => words.includes(word)).map(word => word + SPEECH_BEAT_MEANINGS[word].zh).join('、');
  const frames = SPEECH_BEAT_FRAME_WORDS.some(word => words.includes(word)) ? speechBeatFramesClause(language) : '';
  // I-193 numbers: what `go` takes, in one short clause (what it is, never when to use it).
  const go = words.includes('go') ? 'go 后面写横向百分比和离用户的米数，形如⟦go 30% 1.2m⟧，两个数可以只写一个。' : '';
  // after the real measurement (docs/claude/2026-11-20-speech-beats-measure.md): "回应可以有表情，也可以没有，也可以跨句子，
  // 也可以只有表情。让角色决定。" / "可以C。（可以减少规矩）" / "比如用户问你的事情要用话回答可以删掉". So it only says what she can do.
  return '像真人说话那样，你说话时可以带着表情和小动作，怎么带由你自己决定：可以每句都有，可以只有一两处，可以一个都没有；'
    + '一个表情可以从这一句一直带到后面几句，到你换下一个或说完为止；'
    + (spoken ? '现在是通话，对方在听你说话：每条回复都要说出话来，不要整条只写标记。'
      : '有时候不说话、只用表情回应更自然，也可以整条只写标记、不写字。')
    // I-175 (kept to one short clause): how long, as a closed suffix.
    + '写法：在要开始的那句话前面写动作标记，形如⟦tilt⟧；后面加 once 只做一下、加 line 只带这一句，如⟦pout once⟧。'
    + "身体可以说出台词没说的那一半，比如嘴上说'才没有'，人却凑近一点。"
    + `标记里只能是：${list}，不要写表外的词。` + go + '标记不会显示，也不会被念出来。' + frames;
}

/**
 * I-203 frames: what each frame does with her body and her words, as
 * information only. Never when to use one (handbook「提示不是锁」6–7: no rule draws a hidden line). zh, or en for an English card.
 */
export function speechBeatFramesClause(language?: string | null): string {
  // 2026-11-25 (user: 先说测试成功啥的，再做动作的): with SPEECH_BEAT_CONTACT on, only the sentence holding kiss / hug is said on the way.
  const wait = SPEECH_BEAT_CONTACT.wordsWaitForContact === true;
  if (language === 'en') return 'kiss and hug can go in frames between your words: from kiss / hug you walk over '
    + (wait ? 'while that sentence goes on, and your next sentences come out once the kiss is done and you pull back, or once you are holding; ' : 'while your words go on; ')
    + 'after hug-held your words wait until you are holding; '
    + 'pause stops your words about 2 seconds (⟦pause long⟧ about 4), and a hug goes on holding through it; at let-go you let go; with no let-go you let go once your words are done and your own hold has passed; '
    + 'while your lips are on in a kiss your words stop by themselves and go on as you pull back.';
  return '亲、抱可以分成几帧写在话中间：kiss、hug 从那里起走过来，'
    + (wait ? '路上说完那一句，后面的话等亲完退开、或抱住了才出来；' : '路上话照常说；')
    + 'hug-held 后面的话等抱住了才出来；pause 话停约 2 秒（⟦pause long⟧ 约 4 秒），抱着就一直抱着；'
    + 'let-go 说到那里松开，没写 let-go 就等话说完、也过了你自己想抱的那一会再松开；亲的时候嘴贴上了话自己停，退开时接着说。';
}

// ---------------------------------------------------------------- the stream filter

/**
 * 认得的括号。⟦⟧ 是她自己的标记：里面不是词表里的词，也整个丢掉（从不显示）。
 * 另外几种是保险：她偶尔写成【词】、〖词〗、[词]、[[词]] 时，里面正好是词表里的词，也当标记去掉；不是的话照原样显示。
 */
const BRACKETS: Readonly<Record<string, string>> = Object.freeze({ [SPEECH_BEAT_OPEN]: SPEECH_BEAT_CLOSE, '【': '】', '〖': '〗', '[': ']' });
const isOpener = (char: string) => Object.hasOwn(BRACKETS, char);
/** I-195: her alarm marker's brackets (the same characters as shared/behaviors/alarms/interface.ts; a test holds them equal), and how much of one is read. */
const ALARM_MARK_OPEN = '⟪';
const ALARM_MARK_CLOSE = '⟫';
const ALARM_HOLD_MAX = 400;
const ALARM_SWALLOW_MAX = 400;
const ALARM_MARKERS_MAX = 8;
const WORDISH = /^[a-z -]*$/iu;
const WORDISH_DOUBLE = /^[a-z -]*\]?$/iu;
const ASCII_PREFIX = /^[a-z -]*/iu;

type Verdict =
  | { readonly kind: 'pending' }
  | { readonly kind: 'marker'; readonly word: SpeechBeatWord; readonly how?: SpeechBeat['how']; readonly goTo?: SpeechBeatGoTo }
  /** 她自己的 ⟦ 写坏了：丢掉 ⟦ 和紧跟的英文字母，rest 重新过一遍。tail（I-193）：坏在数字上、留着的全丢了，后面到 ⟧ 为止的字母数字也一起丢。 */
  | { readonly kind: 'drop'; readonly rest: string; readonly tail?: boolean }
  /** 不是标记：第一个字符照原样放出，其余重新过一遍。 */
  | { readonly kind: 'text' };

/** 从一个开括号起攒下的字，现在能不能判。final：后面不会再有字了。 */
function judge(held: string, maxChars: number, final: boolean): Verdict {
  const opener = held.charAt(0);
  const own = opener === SPEECH_BEAT_OPEN;
  const double = opener === '[' && held.charAt(1) === '[';
  const start = double ? 2 : 1;
  const closer = double ? ']]' : BRACKETS[opener]!;
  if (held.length >= start + closer.length && held.endsWith(closer)) {
    const marker = readMarkerBody(held.slice(start, held.length - closer.length), own);
    if (marker) return { kind: 'marker', word: marker.word, ...(marker.how ? { how: marker.how } : {}), ...(marker.goTo ? { goTo: marker.goTo } : {}) };
    return own ? { kind: 'drop', rest: '' } : { kind: 'text' };
  }
  const body = held.slice(start);
  // I-193: digits are held only while the body can still become ⟦go 30% 1.2m⟧ (go-to.ts); a chunk may end anywhere inside the number.
  if (!final && Array.from(held).length <= maxChars && ((double ? WORDISH_DOUBLE : WORDISH).test(body) || goPending(body, double))) return { kind: 'pending' };
  if (!own) return { kind: 'text' };
  const rest = held.slice(1).replace(BROKEN_SUFFIX.test(body) ? BROKEN_SUFFIX : ASCII_PREFIX, '');
  return { kind: 'drop', rest, ...(rest === '' && /\d/u.test(body) ? { tail: true } : {}) };
}

/**
 * 一条回复一个过滤器：每段流进来的字调 push，结束调 end，再取 summary。
 * 一个开括号起的几个字会先留着（最多 knobs.markerMaxChars 个），判清楚是不是标记再放出，所以标记被拆在两段里也能去掉。
 */
export class SpeechBeatFilter {
  private held = '';
  private length = 0;
  private text = '';
  private readonly beats: SpeechBeat[] = [];
  private dropped = 0;
  private ended = false;
  /** I-195: the body of her alarm marker being read (between ⟪ and ⟫); null outside one. */
  private alarm: string | null = null;
  /** I-195: characters still thrown away after an over-long alarm marker, until its ⟫ (0: not swallowing). */
  private swallow = 0;
  private readonly alarms: string[] = [];
  /** I-193: characters of a broken numbered marker still thrown away, up to its ⟧ (0: none). */
  private tail = 0;

  constructor(private readonly knobs: SpeechBeatKnobs = SPEECH_BEAT_KNOBS) {}

  push(chunk: string): SpeechBeatChunk { return this.run(typeof chunk === 'string' ? chunk : '', false); }

  /** 回复结束：留着的字判掉（没闭合的 ⟦ 和紧跟的英文丢掉，别的括号照原样放出）。之后 push 不再接受。 */
  end(): SpeechBeatChunk {
    const last = this.run('', true);
    if (this.alarm !== null) { this.alarm = null; this.dropped += 1; } // never closed: gone, never shown
    this.ended = true;
    return last;
  }

  summary(): SpeechBeatSummary {
    const beats = [...this.beats];
    return { text: this.text, beats, performanceOnly: beats.length > 0 && !/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(this.text), dropped: this.dropped, alarms: [...this.alarms] };
  }

  /**
   * I-195: her alarm marker ⟪…⟫ is read here too, so it leaves the text in every path that filters (typed chat, a call, Unbound): its body is kept for
   * the alarm parser (shared/behaviors/alarms/parse.ts), never put into the text. Over ALARM_HOLD_MAX characters it is malformed: dropped, and what
   * follows up to its ⟫ (at most ALARM_SWALLOW_MAX more characters) with it; with no ⟫ at the end of the reply, all of it is dropped.
   */
  private alarmChar(char: string): boolean {
    if (this.swallow > 0) { this.swallow = char === ALARM_MARK_CLOSE ? 0 : this.swallow - 1; return true; }
    if (this.alarm === null) {
      if (this.held || char !== ALARM_MARK_OPEN) return false;
      this.alarm = '';
      return true;
    }
    if (char === ALARM_MARK_CLOSE) {
      if (this.alarms.length < ALARM_MARKERS_MAX) this.alarms.push(this.alarm); else this.dropped += 1;
      this.alarm = null;
    } else {
      this.alarm += char;
      if (this.alarm.length > ALARM_HOLD_MAX) { this.alarm = null; this.swallow = ALARM_SWALLOW_MAX; this.dropped += 1; }
    }
    return true;
  }

  private run(input: string, final: boolean): SpeechBeatChunk {
    if (this.ended) return { text: '', beats: [] };
    const queue = Array.from(input);
    const beats: SpeechBeat[] = [];
    let out = '';
    for (;;) {
      let verdict: Verdict;
      if (queue.length) {
        const char = queue.shift()!;
        if (this.alarmChar(char)) continue;
        if (this.tail > 0 && !this.held) { // I-193: the rest of a broken numbered marker, up to its ⟧, goes with it
          if (char === SPEECH_BEAT_CLOSE) { this.tail = 0; continue; }
          if (MARKERISH.test(char)) { this.tail -= 1; continue; }
          this.tail = 0;
        }
        if (!this.held) { if (isOpener(char)) this.held = char; else out += char; continue; }
        this.held += char;
        verdict = judge(this.held, this.knobs.markerMaxChars, false);
      } else if (final && this.held) {
        verdict = judge(this.held, this.knobs.markerMaxChars, true);
      } else break;
      if (verdict.kind === 'pending') continue;
      const held = this.held;
      this.held = '';
      if (verdict.kind === 'marker') this.addBeat(verdict.word, this.length + out.length, beats, verdict.how, verdict.goTo);
      else if (verdict.kind === 'drop') { this.dropped += 1; this.tail = verdict.tail ? this.knobs.markerMaxChars : 0; queue.unshift(...Array.from(verdict.rest)); }
      else { out += held.charAt(0); queue.unshift(...Array.from(held.slice(1))); }
    }
    this.length += out.length;
    this.text += out;
    return { text: out, beats };
  }

  private addBeat(word: SpeechBeatWord, at: number, into: SpeechBeat[], how?: SpeechBeat['how'], goTo?: SpeechBeatGoTo): void {
    const here = this.beats.filter(beat => beat.at === at);
    if (here.some(beat => beat.word === word)) return; // the same word twice at one spot is one beat
    if (this.beats.length >= this.knobs.maxBeats || here.length >= this.knobs.maxAtOnce) { this.dropped += 1; return; }
    const beat: SpeechBeat = { word, at, ...(how ? { how } : {}), ...(goTo ? { goTo } : {}) };
    this.beats.push(beat);
    into.push(beat);
  }
}

/** 一整段字一次过滤（测试、回放、聊天记录里补算用）。 */
export function filterSpeechBeats(text: string, knobs: SpeechBeatKnobs = SPEECH_BEAT_KNOBS): SpeechBeatSummary {
  const filter = new SpeechBeatFilter(knobs);
  filter.push(text);
  filter.end();
  return filter.summary();
}

// ---------------------------------------------------------------- the grey line

/**
 * 只演不说的那条在聊天页上的灰色小字。没有拍子时是空串。
 * I-193：走位词只在真的走了时才写（`walked` 说这一拍走了没有）；不知道或没走就不写它，免得写成"走近了一些"其实没动。
 */
export function describeBeats(beats: readonly SpeechBeat[], knobs: SpeechBeatKnobs = SPEECH_BEAT_KNOBS, walked?: (beat: SpeechBeat) => boolean): string {
  const told: string[] = [];
  for (const beat of beats) {
    if (!isSpeechBeatWord(beat.word)) continue;
    if (isGoBeatWord(beat.word) && !(walked?.(beat) ?? false)) continue;
    const phrase = SPEECH_BEAT_MEANINGS[beat.word].told;
    if (!told.includes(phrase)) told.push(phrase);
  }
  const kept = told.slice(0, Math.max(0, knobs.describeMax));
  return kept.length ? `（${kept.join('，')}）` : '';
}
