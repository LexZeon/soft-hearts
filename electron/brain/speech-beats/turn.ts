/**
 * 边说边演第 2 步（docs/claude/2026-11-20-speech-beats-2-4.md）：一条回复的标记，在主机这边从头到尾。
 *
 * 顺序（electron/wiring/brain-chat-wiring.ts 的聊天一轮）：
 *  1. input(push)：Claude 流进来的每段字先过 SpeechBeatFilter，回复协议（开头标记、草稿拦截、尾注）、气泡、朗读、聊天记录、
 *     日记、记忆都只见去掉标记的字。她自己的 ⟦⟧ 不管开关开没开都去掉（开关关着时也不会漏）。
 *  2. end(push)：流完、没被停掉时，过滤器留着等闭合的那几个字放出去。
 *  3. shown(delta)：每段真要显示的字在显示之前调；拍子挪到显示的字上（place.ts），开关开着时发给窗口。
 *  4. complete(shownText)：回复完整完成（存档、心情之后）调一次：剩下的拍子、只演不说吗、灰色小字、进她历史的字；有拍子才发 final。
 *  5. cancel()：停止、出错、过期的回复：之后什么都不发（窗口那边也会作废没演的）。
 * 提示词那句（sentence）只在开关开着时有；关着时一个字都不加。I-185：固定的那句后面，跟一小句这一轮用不了的词（availability.ts；都能用时不加）。
 * 先后顺序。I-203 起按她放的帧：
 * 全屏 Unbound 里（开始时给了 gate），⟦kiss⟧ / ⟦hug⟧ 本身不再留字（她走过来的路上话照常说）；⟦hug-held⟧（前面有亲抱时）和 ⟦pause⟧ 后面还有字时，
 * 从拍子后第一个看得见的字起整段先留在这里（气泡、朗读、聊天记录、存档都还没见到），拍子本身马上发出去；等抱住了 / 停够了、或不会发生、
 * 或到上限（electron/unbound/close-sequence.ts）才放出去。亲的嘴贴上时（gate.quiet），新来的字也先留着，退开时放。拍子前面的字照常先走，
 * 朗读在那里断一句（onHold）。end() 等留着的字放完；停掉时丢掉，不复活。
 * 2026-11-25：⟦kiss⟧ / ⟦hug⟧ 所在的那一句照常边走边说，从下一句起留着，等真的亲上、抱住
 * （gate.wait('contact')：亲的时候接着由 gate.quiet 留到退开）、或不会发生、或到上限才放（shared/behaviors/speech-beats/contact-hold.ts 找位置）。
 * 被打断（大幅拉开、脸够不到）：gate 告诉这一轮（cut），留着的字和后面的字照样进存档（整条存一次），
 * 但气泡和朗读已被接线停下；complete() 时交出一份打断记录（onCut：位置、原因），接线写进打断记录、给她那一轮立刻的事实。
 */
import { SpeechBeatFilter, describeBeats, holdsWordsAt, isCloseBeatWord, speechBeatSentence } from '../../../shared/behaviors/speech-beats/choose';
import { speechBeatAvailabilityLine, type SpeechBeatSituation } from '../../../shared/behaviors/speech-beats/availability';
import { SpeechBeatPlacer } from '../../../shared/behaviors/speech-beats/place';
import { offeredBeatWords, windowCloseMomentsOn, withoutCloseBeats } from '../../../shared/behaviors/speech-beats/window-close'; // 2026-11-24: the small window has no kiss / hug (knob)
import { speechBeatHistoryText } from '../../../shared/behaviors/speech-beats/history';
import { SPEECH_BEAT_FRAME_WORDS, SPEECH_BEAT_GO_WORDS, SPEECH_BEAT_WORDS, type SpeechBeat, type SpeechBeatChunk, type SpeechBeatsEvent } from '../../../shared/behaviors/speech-beats/interface';
import type { CutRecord } from '../../../shared/foundation/reply-cut';
import { contactCut, contactHoldOn, type ContactSeek } from '../../../shared/behaviors/speech-beats/contact-hold'; // 2026-11-25: words wait for the contact

/** What an interrupted kiss or hug of this reply was (electron/unbound/close-sequence.ts CloseCutEvent, the same shape). */
export interface SpeechBeatCut { kind: 'kiss' | 'hug'; frame: 'walking' | 'holding'; cause: 'pulled-away' | 'could-not-reach' }
/** Where her words after a frame wait for it (electron/unbound/close-sequence.ts CloseBeatSequence, given by the Unbound wiring). */
export interface SpeechBeatCloseGate {
  /** 2026-11-25 'contact': the words after a kiss / hug's sentence (`beat`: which of this reply's kiss / hug beats, from 1, and which it is). */
  wait(word: 'hug-held' | 'pause' | 'contact', beat?: { nth: number; kind: 'kiss' | 'hug' }): { done: Promise<unknown>; cancel(): void };
  /** I-203: her lips are on in a kiss from her reply: new words wait until she pulls back (null: they may go). */
  quiet?(): Promise<void> | null;
  /** I-203: this reply hears when its kiss or hug is interrupted (`shown`: how much of it was presented; null: all given out so far). */
  attach?(listener: { cut(event: SpeechBeatCut, shown: number | null): void }): () => void;
}
/** Sentence ends (where a sentence of hers is complete). */
const SENTENCE_END = /[。！？!?…~～\n]/u;
/** Where the sentence that `at` is in started (at itself when the text before it ends a sentence). */
function sentenceStart(text: string, at: number): number {
  let end = Math.max(0, Math.min(text.length, at));
  while (end > 0 && /\s/u.test(text[end - 1]!)) end--;
  if (end === 0 || SENTENCE_END.test(text[end - 1]!)) return Math.max(0, Math.min(text.length, at));
  for (let i = end - 1; i >= 0; i--) if (SENTENCE_END.test(text[i]!)) return i + 1;
  return 0;
}

export interface SpeechBeatOutcome {
  readonly beats: readonly SpeechBeat[];
  readonly performanceOnly: boolean;
  /** 只演不说时的灰色小字；否则空串。 */
  readonly line: string;
  /** 这一轮进她历史的字（开关开着带标记）；null：不进（开关关着时只演不说的那条）。 */
  readonly history: string | null;
}

/** 显示的字里有没有可看可听的东西（文字、数字、表情符号）；和 choose.ts 的 performanceOnly 同一条线。 */
const SPOKEN = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

export class SpeechBeatTurn {
  private readonly filter = new SpeechBeatFilter();
  private readonly placer = new SpeechBeatPlacer();
  private readonly placed: SpeechBeat[] = [];
  private closed = false;
  private outcome: SpeechBeatOutcome | null = null;
  /** 先后顺序: the filtered length fed so far, a kiss / hug whose following words have not come yet, the wait and what it holds. */
  private fed = 0;
  private pendingClose: SpeechBeat | null = null;
  private wait: { cancel(): void } | null = null;
  /** K14: the filtered position of the beat the current wait is about (a frame, or the kiss / hug of a contact wait); null: none to judge. */
  private waitAt: number | null = null;
  private held: SpeechBeatChunk[] = [];
  private drained: (() => void) | null = null;
  private stopped = false;
  /** Where the read-aloud breaks its sentence at a held beat (the wiring sets it: the words before the beat are a piece of their own). */
  onHold: (() => void) | null = null;
  /**
   * I-203: this reply's kiss or hug was interrupted: called once, after the reply completed (archived once, whole), with the cut record
   * (where, why: offsets into the shown text) and what the moment was. The wiring files the record and hands her the facts.
   */
  onCut: ((cut: CutRecord, event: SpeechBeatCut, text: string) => void) | null = null;
  /** I-203: the filtered position of this reply's first kiss / hug (a hug-held waits only after one). */
  private closeAt: number | null = null;
  /** I-203: interrupted (the event and how far the reply was presented), and the push its held words go out through. */
  private cutBy: { event: SpeechBeatCut; shown: number } | null = null;
  private push: ((type: 'delta', text: string) => void) | null = null;
  private shownLength = 0;
  private readonly detach: (() => void) | null;
  /** 2026-11-24: a window turn without kiss / hug: those beats (and the frames) are taken out of the reply's beats; `droppedClose` counts them. */
  private readonly noClose: boolean;
  private droppedClose = 0;
  /** 2026-11-25: a kiss / hug whose next sentence has not come yet (where its scan stands), the kiss / hug beats seen (their order). */
  private contact: { at: number; seek: ContactSeek; nth: number; kind: 'kiss' | 'hug' } | null = null;
  private closeSeen = new Set<string>();
  private readonly contactOn: boolean;

  /**
   * `on`：这一轮开关的值（开始时读一次，整轮不变）；`send`：发给两个窗口（同一条回复的 id）；`situation`（I-185）：开始时此刻能做什么（null：不知道，什么都不加）；
   * `gate`（2026-11-23）：全屏 Unbound 里她放的帧留字（null：不等）；`language`：她这张卡的语言（帧那一句用）。
   */
  constructor(readonly on: boolean, private readonly send: (event: SpeechBeatsEvent) => void, private readonly situation: SpeechBeatSituation | null = null,
    private readonly gate: SpeechBeatCloseGate | null = null, private readonly language: string | null = null,
    /** 2026-11-24: the small window has kiss / hug (the knob; read once per turn). Only a turn that knows it is the window's leaves them out (surface 'window'). */
    windowClose: boolean = windowCloseMomentsOn(),
    /** 2026-11-25: her words after a kiss / hug's sentence wait for its contact (the knob SPEECH_BEAT_CONTACT; read once per turn). */
    contactHold: boolean = contactHoldOn()) {
    this.noClose = situation?.surface === 'window' && !windowClose;
    this.contactOn = contactHold;
    let detach: (() => void) | null = null;
    try { detach = gate?.attach?.({ cut: (event, shown) => this.cut(event, shown) }) ?? null; } catch { detach = null; }
    this.detach = detach;
  }

  /** 加在她这一轮回复说明里的那一句（I-185：后面跟这一轮用不了的词，都能用时不加）；开关关着时是空串（提示词一字不变）。 */
  sentence(spoken = false): string {
    if (!this.on) return '';
    const offered = offeredBeatWords(this.situation?.surface, !this.noClose); // 2026-11-24: the window's sentence and line name no kiss / hug while the knob is off
    const line = speechBeatAvailabilityLine(this.situation, offered);
    // I-193: the "go where" words are offered only where she can walk (full-screen Unbound); the window's sentence is as it was.
    // I-203: the frames too, and only where the host holds her words for them (this turn has the gate: typed and voice-input chat in full-screen).
    const full = this.situation?.surface === 'full';
    const words = full ? [...SPEECH_BEAT_WORDS, ...SPEECH_BEAT_GO_WORDS, ...(this.gate ? SPEECH_BEAT_FRAME_WORDS : [])] : this.noClose ? offered : undefined;
    return speechBeatSentence(words, spoken, this.language) + (line ? '\n' + line : '');
  }

  /** 包住 Claude 流用的 push：字先过滤；别的事件原样过去。`signal`：这条回复被停掉时，留着等动作的字丢掉。 */
  input<T extends string>(push: (type: T, text: string) => void, signal?: AbortSignal): (type: T, text: string) => void {
    signal?.addEventListener('abort', () => this.cancel(), { once: true });
    this.push = push as (type: 'delta', text: string) => void;
    return (type, text) => {
      if (type !== 'delta') { push(type, text); return; }
      this.feed(this.kept(this.filter.push(typeof text === 'string' ? text : '')), push as (type: 'delta', text: string) => void);
    };
  }

  /** 流完了（没被停掉）：过滤器留着的字放出去；等着动作的字放完（或这条回复被停掉）以后才算完。 */
  end<T extends string>(push: (type: T, text: string) => void): Promise<void> {
    this.feed(this.kept(this.filter.end()), push as (type: 'delta', text: string) => void);
    this.unstick(push as (type: 'delta', text: string) => void);
    if (!this.wait || this.stopped) return Promise.resolve();
    return new Promise(resolve => { this.drained = resolve; });
  }

  /**
   * 2026-11-25 (K14, docs/claude/2026-11-25-k14-hug-regression.md): the stream ended while her words wait for a beat whose own words have not
   * reached the screen: whatever holds them downstream (a reply without its opening marker shows nothing until the reply is complete, and it
   * completes only after this) lets them out only once this wait is over, and the page can only reach the beat after that. Waiting would end
   * only at a cap (40 s of nothing). The wait lets go instead: her words come as written and the kiss / hug still plays when the page reaches it.
   */
  private unstick(push: (type: 'delta', text: string) => void): void {
    while (this.wait && !this.stopped && !this.cutBy && this.waitAt !== null && this.placer.unshownBefore(this.waitAt)) {
      try { this.wait.cancel(); } catch { /* gone */ }
      this.letGo(push); // may open a later wait (another frame): judged again
    }
  }

  /** 2026-11-24: a window turn without kiss / hug takes them (and their frames) out of the chunk's beats; nothing downstream ever sees them. */
  private kept(chunk: SpeechBeatChunk): SpeechBeatChunk {
    if (!this.noClose) return chunk;
    const { chunk: rest, dropped } = withoutCloseBeats(chunk);
    this.droppedClose += dropped;
    return rest;
  }

  /** True while words after a kiss or a hug wait for it. */
  get holding(): boolean { return !!this.wait; }

  /**
   * One filtered chunk on its way out. While a kiss / hug waits, it is kept. Otherwise its text goes out up to the first spoken character after a
   * kiss / hug (gate given): the beats up to that one go to the windows now, the rest waits for the action (the beats after it with it).
   */
  private feed(chunk: SpeechBeatChunk, push: (type: 'delta', text: string) => void): void {
    if (this.stopped || this.cutBy) { this.out(chunk, push); return; } // stopped: as before (the stream itself stops), never held; cut: all of it to the archive
    if (this.wait) { this.held.push(chunk); return; }
    for (const beat of chunk.beats) if (isCloseBeatWord(beat.word)) { if (this.closeAt === null) this.closeAt = beat.at; this.seeClose(beat); }
    // I-203: her lips are on (a kiss from her reply): her mouth is busy, new words wait until she pulls back.
    let quiet: Promise<void> | null = null;
    try { quiet = this.gate?.quiet?.() ?? null; } catch { quiet = null; }
    if (quiet) { this.held = [chunk]; this.holdUntil(quiet, push); return; }
    // I-203: only her frames hold the words after them: a pause, and a hug-held after a kiss / hug (a kiss / hug itself never does).
    const waits = (beat: SpeechBeat) => holdsWordsAt(beat.word) && (beat.word === 'pause' || (this.closeAt !== null && this.closeAt <= beat.at));
    const base = this.fed, index = this.gate ? chunk.beats.findIndex(waits) : -1;
    const close = this.pendingClose ?? (index >= 0 ? chunk.beats[index] : null);
    const from = this.pendingClose ? 0 : close ? Math.max(0, Math.min(chunk.text.length, close.at - base)) : 0;
    const spoken = close ? chunk.text.slice(from).search(SPOKEN) : -1;
    if (this.contactFirst(chunk, close && spoken >= 0 ? from + spoken : -1, push)) return; // 2026-11-25: a kiss / hug's next sentence stops first
    if (!close || spoken < 0) { // nothing to wait for (yet): out as always; a kiss / hug with nothing spoken after it yet waits for its words
      if (close && !this.pendingClose) this.pendingClose = close;
      this.out(chunk, push);
      return;
    }
    const cut = from + spoken, beatsBefore = this.pendingClose ? [] : chunk.beats.slice(0, index + 1);
    this.out({ text: chunk.text.slice(0, cut), beats: beatsBefore }, push);
    this.pendingClose = null;
    const now = this.placer.reach(close.at); // the beats up to the kiss / hug go to the windows now: the page plays it when it shows the words before it
    if (now.length) { this.placed.push(...now); if (this.on && !this.closed) this.emit({ beats: now }); }
    this.held = [{ text: chunk.text.slice(cut), beats: chunk.beats.slice(beatsBefore.length) }];
    try { this.onHold?.(); } catch { /* the read-aloud never stops a reply */ }
    let wait: { done: Promise<unknown>; cancel(): void };
    try { wait = this.gate!.wait(close.word as 'hug-held' | 'pause'); } catch { wait = { done: Promise.resolve(), cancel() {} }; }
    this.wait = wait; this.waitAt = close.at;
    // 2026-11-25: a cap that let a hug-held go also ends the contact wait of the same moment (one last resort, one row, never two in a row).
    void wait.done.then(why => { if (this.wait !== wait) return; if (why === 'cap' && close.word === 'hug-held') this.contact = null; this.letGo(push); }, () => { if (this.wait === wait) this.letGo(push); });
  }
  /**
   * 2026-11-25: a kiss / hug of this reply, the first time it is seen: its order, and (gate given, the knob on, none pending) the scan for the
   * end of its sentence (the sentence it is in, or the one it is written in front of, goes on while she walks).
   */
  private seeClose(beat: SpeechBeat): void {
    const key = `${beat.word}@${beat.at}`;
    if (this.closeSeen.has(key)) return;
    this.closeSeen.add(key);
    if (!this.gate || !this.contactOn || this.contact) return;
    this.contact = { at: beat.at, seek: 'end', nth: this.closeSeen.size, kind: beat.word === 'kiss' ? 'kiss' : 'hug' };
  }
  /**
   * 2026-11-25: a pending kiss / hug contact stops her words at the first spoken character of its next sentence, if that comes before `frameCut`
   * (the frame's own stop in this chunk; -1: none). True when it held them here; otherwise its scan stage moves on over what goes out.
   */
  private contactFirst(chunk: SpeechBeatChunk, frameCut: number, push: (type: 'delta', text: string) => void): boolean {
    const c = this.contact;
    if (!c) return false;
    const base = this.fed, from = Math.max(0, c.at - base);
    const found = contactCut(chunk.text, from, c.seek);
    if ('cut' in found && (frameCut < 0 || found.cut < frameCut)) {
      const at = base + found.cut;
      this.contact = null;
      this.out({ text: chunk.text.slice(0, found.cut), beats: chunk.beats.filter(beat => beat.at < at) }, push);
      this.held = [{ text: chunk.text.slice(found.cut), beats: chunk.beats.filter(beat => beat.at >= at) }];
      try { this.onHold?.(); } catch { /* the read-aloud never stops a reply */ }
      let wait: { done: Promise<unknown>; cancel(): void };
      try { wait = this.gate!.wait('contact', { nth: c.nth, kind: c.kind }); } catch { wait = { done: Promise.resolve(), cancel() {} }; }
      this.wait = wait; this.waitAt = c.at;
      void wait.done.then(() => { if (this.wait === wait) this.letGo(push); }, () => { if (this.wait === wait) this.letGo(push); });
      return true;
    }
    // Not here: the scan carries on over what goes out now (up to the frame's stop when there is one; the rest comes back through feed).
    const over = frameCut < 0 ? found : contactCut(chunk.text.slice(0, frameCut), from, c.seek);
    c.seek = 'seek' in over ? over.seek : 'next';
    if (c.seek === 'off') this.contact = null; // K14: the protocol's private part began: nothing after it is a sentence of hers, nothing waits
    return false;
  }

  /** I-203: what is held waits for `until` (her lips leaving yours), then goes on in order. */
  private holdUntil(until: Promise<void>, push: (type: 'delta', text: string) => void): void {
    const wait = { done: until, cancel() {} };
    this.wait = wait; this.waitAt = null; // her lips are on: the page is there, nothing to unstick
    void until.then(() => { if (this.wait === wait) this.letGo(push); }, () => { if (this.wait === wait) this.letGo(push); });
  }

  /**
   * I-203: this reply's kiss or hug was interrupted (a large pull, or her face could not reach). The wiring has already stopped her bubble and
   * her reading of it; what was held and what still streams goes out to the reply as written (the chat window and the archive keep it whole,
   * once), no frame of it waits any more. `shown`: how far it had been presented (null: everything given out so far). Mostly the reply has
   * already completed (her words streamed long before she walked): then the record is filed at once, against the archived text.
   */
  private cut(event: SpeechBeatCut, shown: number | null): void {
    if (this.stopped || this.cutBy) return;
    this.cutBy = { event, shown: typeof shown === 'number' && Number.isSafeInteger(shown) && shown >= 0 ? Math.min(shown, this.shownLength) : this.shownLength };
    if (this.finalText !== null) { this.fileCut(); return; }
    const wait = this.wait;
    this.wait = null; this.pendingClose = null;
    try { wait?.cancel(); } catch { /* gone */ }
    const push = this.push, held = this.held.splice(0);
    if (push) for (const chunk of held) this.out(chunk, push);
    const done = this.drained; this.drained = null; done?.();
  }

  private out(chunk: SpeechBeatChunk, push: (type: 'delta', text: string) => void): void {
    this.placer.input(chunk);
    this.fed += chunk.text.length;    if (chunk.text) push('delta', chunk.text);
  }
  /** The action is done (or did not walk up, or a cap): what waited goes out, in order (another kiss / hug in it may wait again). */
  private letGo(push: (type: 'delta', text: string) => void): void {
    this.wait = null;
    const held = this.held.splice(0);
    for (const chunk of held) this.feed(chunk, push);
    if (!this.wait) { const done = this.drained; this.drained = null; done?.(); }
  }

  /** 一段真要显示的字，在显示之前。 */
  shown(delta: string): void {
    if (typeof delta === 'string') this.shownLength += delta.length;
    const beats = this.placer.shown(delta);
    if (!beats.length) return;
    this.placed.push(...beats);
    if (this.on && !this.closed) this.emit({ beats });
  }

  /** 回复完整完成以后一次。`shownText`：显示、存档、朗读的全文。 */
  complete(shownText: string): SpeechBeatOutcome {
    if (this.outcome) return this.outcome;
    const rest = this.placer.finish();
    this.placed.push(...rest);
    const text = typeof shownText === 'string' ? shownText : '';
    const beats = [...this.placed];
    // Judged on what was really shown, never on the raw stream: that one also holds the reply protocol's own letters (an opening marker, the state tail).
    const performanceOnly = (beats.length > 0 || this.droppedClose > 0) && !SPOKEN.test(text); // 2026-11-24: a window reply of only a kiss / hug is still "no words" (it plays nothing, its grey line is empty)
    const outcome: SpeechBeatOutcome = { beats, performanceOnly, line: performanceOnly ? describeBeats(beats) : '',
      history: beats.length === 0 && performanceOnly ? null : speechBeatHistoryText({ text, beats, performanceOnly, on: this.on }) };
    this.outcome = outcome;
    if (this.closed) return outcome;
    this.closed = true;
    this.finalText = text; this.fileCut(); // I-203: cut while she was writing: filed now (after the one archive); cut later: when it happens (until the next reply)
    if (beats.length || this.droppedClose > 0) this.emit({ ...(this.on && rest.length ? { beats: rest } : {}), final: { performanceOnly, line: outcome.line, history: outcome.history } });
    return outcome;
  }

  /** I-203: once: where her words stopped (offsets into what was shown and archived) and why. */
  private finalText: string | null = null;
  private cutFiled = false;
  private fileCut(): void {
    const cut = this.cutBy, text = this.finalText;
    if (!cut || text === null || this.cutFiled || this.stopped || !this.onCut) return;
    this.cutFiled = true;
    const at = Math.min(text.length, cut.shown);
    try { this.onCut({ cause: cut.event.cause, known: true, saidEnd: sentenceStart(text, at), sentenceEnd: at }, { ...cut.event }, text); } catch { /* a record only */ }
  }

  /** 她这一轮在常驻进程的记录里是什么样（完成以后：开关开着带标记；还没完成：原样）。 */
  historyText(clean: string | null): string | null {
    if (clean === null || !this.outcome) return clean;
    return this.outcome.history ?? '';
  }

  /** 停止、出错、过期：之后什么都不发；等着动作的字丢掉（不复活）。 */
  cancel(): void {
    try { this.detach?.(); } catch { /* gone */ }
    this.closed = true; this.stopped = true;
    const wait = this.wait;
    this.wait = null; this.held = [];
    try { wait?.cancel(); } catch { /* gone */ }
    const done = this.drained; this.drained = null; done?.();
  }

  /** I-195: the bodies of her alarm markers so far (the filter took them out of the text; the alarm parser reads them once the reply completed). */
  alarmMarkers(): readonly string[] { return this.filter.summary().alarms ?? []; }

  /** 到现在有没有拍子（含还没落下的）。 */
  get hasBeats(): boolean { return this.placed.length > 0 || this.filter.summary().beats.length > 0; }

  private emit(event: SpeechBeatsEvent): void { try { this.send(event); } catch { /* the windows never change a reply */ } }
}
