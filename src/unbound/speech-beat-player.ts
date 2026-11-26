/**
 * 边说边演第 3 步，Unbound 模式（docs/claude/2026-11-20-speech-beats-2-4.md）：她回复里的拍子，所有的词都演，经展示的演员
 * （src/unbound/showcase/performer.ts）出第 2 层的 'showcase' 意图，再由生成器和第 3 层的弹簧带到身体上（个人感过滤在 figure 里，照旧盖在上面）。
 *
 *  - 时间：Unbound 的气泡收到这条回复的字就当显示到了那里（shared/behaviors/speech-beats/schedule.ts 的 'shown'）；只演不说的按间隔演。
 *  - 谁先：拉她、偷看（director）、她自己的动作（acts）、走回来、E3 的开口一拍都在演的时候，这里不开始、也不写目标（"禁止"只是
 *    不开始新的动作）；已经在演的交给别人时，由第 3 层的弹簧接过去，不跳。
 *  - 演完：再给 releaseS 让表情和身体落回去，交回静止目标；有过凑近 / 退开时告诉 main 让她回到原来站的地方（像偷看结束那样）。
 * 新的回复开始、停止、出错时没演的全部作废，不补演。
 * 挂着（2026-11-20，可以跨句子）：表情、看向、眼神的拍子挂到同一条通道的下一拍接手，或这条回复说完（shared/behaviors/speech-beats/span.ts），
 * 或保险上限；停止、出错、新的回复马上放手，照常落下去（speech-beat-hold.ts）。身体的词不挂。只演不说的不挂。
 * I-185 亲亲、抱抱（kiss、hug）：说到那里时问主机（peekReport 的 closeBeat）：'play' → 主机从偷看的通道发"贴近的时刻"（走到镜头前，
 * 同一家的门、冷却、嘟嘴只在停顿里；导演演，这里让位）；'lighter' 或问不到 → 这里原地演轻一点的：亲 → 害羞地笑（shy），
 * 抱 → 凑近一点、手臂张开一点（手被占着就不张，shared/unbound/close-moments/in-place.ts 的小抱抱）。从不什么都不做。
 */
import type { UnboundBubble } from '../../shared/unbound/scene';
import { CLOSE_BEAT_LIGHTER, LineHolds, SPEECH_BEAT_MEANINGS, SPEECH_BEAT_SHOWCASE, SpeechBeatSchedule, SpeechSpan, beatHold, isCloseBeatWord, isFrameBeatWord, isGoBeatWord, isSpeechBeatHow, isSpeechBeatWord, type SpeechBeatCloseWord, type SpeechBeatGoWord, type SpeechBeatShowcaseWord, type SpeechBeatWord } from '../../shared/brain'; // 边说边演 (shared/behaviors/speech-beats/)
import type { ShowcaseBeat } from '../../shared/unbound/showcase';
import { IN_PLACE, InPlaceClose, inPlacePlan, isChatCloseAnswer, type ChatCloseAnswer, type FrameBeatAsk } from '../../shared/unbound/close-moments';
import { REST_TARGETS, type BodySense, type MotionGenerator, type MotionIntent, type PoseTargets } from './motion/generator';
import type { LensView } from './motion/lens-align';
import { ShowcasePerformer } from './showcase/performer';
import { HeldBeats } from './speech-beat-hold';
import { closeIntent, layerClose } from './director/close-pose';
import { CursorAcross } from './go-cursor';
import { goTargetOf, isGoBeatAnswer, type GoBeatAsk, type GoTarget } from '../../shared/unbound/her-position';

export const UNBOUND_SPEECH_BEATS = Object.freeze({
  /** How long each kind of beat lasts (s) and how strong (0..1); first picks, read against the showcase's own numbers. */
  durS: { expression: 2.2, gaze: 1.3, eyes: 3, body: 1.8 } as const,
  intensity: 0.6,
  /** After the last beat: this long for the face and body to come back before her own targets take over (s). */
  releaseS: 1.2,
  /**
   * 2026-11-23 (10:39: lean-in + hug at the very start of her reply, "连凑近都没动"): a beat that comes due while something with priority has her
   * (the opening beat, her own walk easing out, a pull, a near return) waits this long (s) and plays once she is free, instead of being dropped.
   * "禁止只是不开始新的动作": it never starts over the one with priority; it is not lost either.
   */
  waitS: 3,
  /** Her liveliness for the performer's own variation (0..1). */
  liveliness: 0.5,
});

/** The words that move her arms (a pull, the game, an offer, her reach or a held hand owns them: not started then). */
export const SPEECH_BEAT_HAND_WORDS: ReadonlySet<string> = new Set(['hand-cheek', 'v']);
/** What decides whether a beat may start now, the same in the window and in full-screen (I-174 item 5). */
/** `armsCan` (I-192 follow-up, Codex T-261): false when the engine cannot move her arms on this model: a lighter hug here then opens no arms (the walk-up hug still goes through the host as on any model: her face comes). */
export interface SpeechBeatGates { shown: boolean; asleep: boolean; armsHeld: boolean; armsCan?: boolean }
/** The gates from her mood view (asleep: the fatigue's sleeping), whether she is shown and whether her arms are held. */
export function speechBeatGatesOf(view: { fatigue?: { sleeping?: boolean } | null } | null | undefined, shown: boolean, armsHeld: boolean): SpeechBeatGates {
  return { shown, asleep: view?.fatigue?.sleeping === true, armsHeld };
}
/**
 * May this beat start now? One rule for both stages (I-174 item 5, docs/claude/2026-11-21-i174-parity-fixes.md): not a word, not shown, or
 * asleep: no; a hand word while her arms are held (猜拳, an offer, her reach, a held hand, a pull): no. "禁止" only stops a new beat; one
 * playing finishes. Before, full-screen played a V or a hand at her cheek in the middle of rock-paper-scissors. I-185: a hug while her arms
 * are held still starts — as its lighter one, without arms (closeBeatStage below); never in place of nothing.
 */
export function speechBeatMayStart(word: string, gates: SpeechBeatGates): word is SpeechBeatWord {
  if (!isSpeechBeatWord(word) || !gates.shown || gates.asleep) return false;
  return !(SPEECH_BEAT_HAND_WORDS.has(word) && gates.armsHeld);
}

export interface SpeechBeatBody { readonly sense: BodySense | null; setPoseTargets(targets: PoseTargets): void }

/** One spoken word as a showcase beat (performance time 0: "now"). I-185: a kiss or a hug here is its lighter word (CLOSE_BEAT_LIGHTER). */
export function speechBeatShowcase(word: SpeechBeatShowcaseWord | SpeechBeatCloseWord): ShowcaseBeat {
  const shown: SpeechBeatShowcaseWord = isCloseBeatWord(word) ? CLOSE_BEAT_LIGHTER[word] : word;
  const channel = SPEECH_BEAT_MEANINGS[shown].channel;
  return { ...(SPEECH_BEAT_SHOWCASE[shown] as unknown as Partial<ShowcaseBeat>), at: 0, dur: UNBOUND_SPEECH_BEATS.durS[channel], intensity: UNBOUND_SPEECH_BEATS.intensity,
    feel: `边说边演：${SPEECH_BEAT_MEANINGS[word].zh}` } as ShowcaseBeat; // ui-zh-ok: the beat's record line (the body never reads it, nothing shows it)
}

/**
 * I-185: how a kiss or a hug plays where she stands (the window's in-place one, or the lighter one anywhere): a kiss in place (the window)
 * or a shy smile (its lighter word); a hug with arms wrapped (the window), opened a little (lighter, arms free) or none (her arms held, or no
 * arm rig). `lighter`: the real one cannot play now. Pure.
 */
export function closeBeatStage(word: SpeechBeatCloseWord, o: { lighter: boolean; armsHeld: boolean; arms?: boolean }): { kind: 'in-place'; arms: 'full' | 'small' | 'none'; lean: number } | { kind: 'word'; word: SpeechBeatShowcaseWord } {
  const noArms = o.armsHeld || o.arms === false;
  if (word === 'kiss') return o.lighter ? { kind: 'word', word: CLOSE_BEAT_LIGHTER.kiss } : { kind: 'in-place', arms: 'none', lean: IN_PLACE.windowLean };
  if (o.lighter || noArms) return { kind: 'in-place', arms: noArms ? 'none' : 'small', lean: IN_PLACE.smallLean };
  return { kind: 'in-place', arms: 'full', lean: IN_PLACE.windowLean };
}

/** The page's question to the host (api.peekReport({ closeBeat })); an answer that is not 'play' (or none) is 'lighter'. */
export type CloseBeatAskPort = (word: SpeechBeatCloseWord) => Promise<unknown> | unknown;
/** I-193: the page's question for a "go where" word (api.peekReport({ goBeat })); the host answers 'go' (it started the walk) or 'stay'. Nothing else happens here: no beat, no teleport. */
export type GoBeatAskPort = (word: SpeechBeatGoWord, goTo?: GoTarget) => Promise<unknown> | unknown; // I-193: go's numbers (⟦go 30% 1.2m⟧), raw
/**
 * I-203 frames: the page tells the host its words reached a ⟦pause⟧ (once the words before it are said: `quiet`) or a ⟦let-go⟧ (at once);
 * the host times the pause's quiet and relays both to her body. A ⟦hug-held⟧ needs nothing here (the host holds the words after it).
 */
export interface FramePorts { ask(ask: FrameBeatAsk): unknown; quiet(): boolean }
/** A pause reported once her voice is quiet, at the latest this long after it was reached (s): her words never wait on a voice that never stops. */
export const FRAME_QUIET_MAX_S = 15;

export class UnboundSpeechBeats {
  private readonly schedule = new SpeechBeatSchedule();
  private readonly span = new SpeechSpan();
  /** I-175: her 'line' beats fall when the bubble shows the next sentence. */
  private readonly lines = new LineHolds();
  private held = new HeldBeats();
  private performer: ShowcasePerformer | null = null;
  private replyId: string | null = null;
  private text = '';
  private clockMs = 0;
  private lastBeatEnds = 0;
  private moved = false;
  private seed = 1;
  /** Words this player performed (for the probe and the tests). I-185: a kiss or a hug is recorded as asked ('kiss'), then as what played ('kiss:play', 'kiss:lighter'). */
  readonly played: string[] = [];
  /** I-185: the lighter in-place hug on this stage (no walk), and the kiss / hug words whose answer came back 'lighter' (played next frame). */
  private close: InPlaceClose | null = null;
  private lighter: { word: SpeechBeatCloseWord; replyId: string; at?: number }[] = [];
  /** 2026-11-23: beats that came due while she was not free (UNBOUND_SPEECH_BEATS.waitS), with when. */
  private waiting: { play: ReturnType<SpeechBeatSchedule['due']>[number]; at: number }[] = [];

  /**
   * `cancelled` (I-175): a new reply began, or this one failed or was stopped: what waits for a pause on her face (a cheek puff) is dropped.
   * `ask` (I-185): the host's answer for a kiss or a hug ('play': its director performs the walk-up; anything else: the lighter one here).
   */
  constructor(private readonly generator: MotionGenerator, private readonly cancelled: () => void = () => {}, private readonly ask: CloseBeatAskPort | null = null,
    private readonly goAsk: GoBeatAskPort | null = null, private readonly frames: FramePorts | null = null) {}
  /** I-203: frames reached and not yet told to the host (a pause waits for her voice to be quiet). */
  private frameAsks: { ask: FrameBeatAsk; replyId: string; at: number }[] = [];

  /** True while she is performing beats (and while they come back). */
  get active(): boolean { return this.performer !== null || this.close !== null; }

  /** Her bubble's events (the chat stream as the Unbound window gets it), including the host's 'beats'. */
  receive(bubble: UnboundBubble): void {
    if (!bubble || typeof bubble.id !== 'string') return;
    if (bubble.type === 'delta') {
      if (bubble.id !== this.replyId) this.begin(bubble.id);
      this.text += typeof bubble.text === 'string' ? bubble.text : '';
      this.schedule.text(bubble.id, this.text);
      this.schedule.shown(bubble.id, this.text.length, this.clockMs);
      this.span.text(bubble.id, this.text);
      this.span.shown(bubble.id, this.text.length, this.clockMs);
      this.lines.setText(this.text);
    } else if (bubble.type === 'done') { this.schedule.done(bubble.id, this.text.length, this.clockMs); this.span.done(bubble.id, this.text.length, this.clockMs); }
    else if (bubble.type === 'error') { this.schedule.cancel(bubble.id); this.span.cancel(bubble.id); this.lines.clear(); this.releaseHeld(); this.cancelled(); }
    else if (bubble.type === 'beats') {
      if (bubble.id !== this.replyId) this.begin(bubble.id);
      const beats = Array.isArray(bubble.speechBeats?.beats) ? bubble.speechBeats.beats.filter(beat => isSpeechBeatWord(String(beat?.word)) && Number.isSafeInteger(beat.at)) : [];
      if (beats.length) this.schedule.add(bubble.id, beats, this.clockMs);
      if (bubble.speechBeats?.final?.performanceOnly === true) { this.schedule.performanceOnly(bubble.id, this.clockMs); this.span.performanceOnly(bubble.id); this.releaseHeld(); }
    }
  }

  /**
   * One frame. `allowed`: nothing with priority is driving her (a pull, a peek, an act, her walk back, a call's opening beat). Returns
   * true on the frame her performance ended after a step in or out, so main puts her back where she stood (as after a peek). `gates`: the
   * window's own "may this beat start" (speechBeatMayStart); a word refused there is dropped, as the window drops it.
   */
  frame(dt: number, lens: LensView, home: { x: number; z: number }, body: SpeechBeatBody, allowed: boolean, gates?: SpeechBeatGates): boolean {
    const step = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    this.clockMs += step * 1000;
    const fresh = (at: number) => this.clockMs - at <= UNBOUND_SPEECH_BEATS.waitS * 1000;
    // I-203: her frames are reached whatever has her now (a let-go comes while the kiss / hug has her): never waiting, never a beat of their own.
    const due = this.schedule.due(this.clockMs).filter(play => !isFrameBeatWord(play.word) || (this.frameReached(play), false));
    this.tellFrames();
    if (!allowed) {
      // Something with priority has her: no beat starts; one already playing is handed over (its owner's targets win from now on). I-185: that
      // includes the walk-up a kiss or a hug asked for (the director has her now). 2026-11-23: what comes due now waits a moment (not dropped).
      for (const play of due) this.waiting.push({ play, at: this.clockMs });
      this.askStale(fresh);
      this.waiting = this.waiting.filter(w => fresh(w.at) && w.play.replyId === this.replyId);
      for (const l of this.lighter) l.at ??= this.clockMs;
      this.lighter = this.lighter.filter(l => fresh(l.at!) && l.replyId === this.replyId);
      if (this.performer || this.close) this.stop(body, false);
      return false;
    }
    this.askStale(fresh);
    const plays = [...this.waiting.filter(w => fresh(w.at) && w.play.replyId === this.replyId).map(w => w.play), ...due];
    this.waiting = [];
    for (const play of plays) {
      if (!isSpeechBeatWord(play.word) || isFrameBeatWord(play.word)) continue; // I-203: frames were taken above
      // 2026-11-23: a kiss / hug she cannot play now (asleep, not shown) still asks: her words after it wait for the host's answer (it journals why); the lighter one is dropped by these gates below.
      if (gates && !speechBeatMayStart(play.word, gates)) { if (isCloseBeatWord(play.word)) this.askClose(play.word, play.replyId); continue; }
      if (isGoBeatWord(play.word)) { this.askGo(play.word, play.goTo); continue; } // I-193: the host walks her (the gait: no teleport); nothing is played here
      if (isCloseBeatWord(play.word)) { this.askClose(play.word, play.replyId); continue; } // I-185: the host decides walk-up or lighter
      this.playWord(play.word, home, play.how, play.replyId, play.at);
    }
    for (const waiting of this.lighter.splice(0)) {
      if (waiting.replyId !== this.replyId || (gates && !speechBeatMayStart(waiting.word, gates))) continue; // another reply since, or she cannot now
      this.playLighter(waiting.word, home, gates?.armsHeld === true || gates?.armsCan === false);
    }
    const performer = this.performer, close = this.close;
    if (!performer && !close) return false;
    if (performer) {
      if (this.span.ended(this.clockMs)) this.releaseHeld(); // her speaking of this reply is over: what stayed up falls
      else if (this.lines.holding && this.lines.reached(this.text.length)) this.held.releaseLine(performer.clock); // I-175: the bubble shows the next sentence
    }
    let intent: MotionIntent | null = performer ? performer.frame(step, lens).intent : null;
    if (close) {
      // I-185: the lighter hug where she stands, laid over the beats (its arms give way while something holds them).
      const out = close.frame(step, { mayStart: false, speaking: !this.span.ended(this.clockMs) }, gates?.armsHeld !== true); // I-192: it stays while she speaks
      intent = intent ? layerClose(intent, out.channels, out.pucker) : closeIntent(lens, out.channels, out.pucker);
      if (!close.active) this.close = null;
    }
    if (body.sense && intent) body.setPoseTargets(this.generator.generate({ intent, t: this.clockMs / 1000, dt: step, sense: body.sense }));
    if (performer && performer.clock >= this.lastBeatEnds + UNBOUND_SPEECH_BEATS.releaseS) {
      if (!this.close) return this.stop(body, true);
      this.performer = null; this.held = new HeldBeats(); this.lastBeatEnds = 0; // the hug still easing out finishes first
    } else if (!performer && !this.close) return this.stop(body, true);
    return false;
  }

  /** Stop, a new reply, an error: what did not play is dropped (the one playing comes back through the springs). */
  cancel(): void { this.schedule.cancel(); this.span.cancel(); this.lines.clear(); this.releaseHeld(); this.cancelled(); this.lighter = []; this.waiting = []; this.frameAsks = []; this.close?.cancel(); }

  /** I-203: a frame her words reached: recorded; a pause or a let-go is told to the host (tellFrames); the lighter hug here lets go at a let-go. */
  private frameReached(play: { word: SpeechBeatWord; replyId: string; how?: unknown }): void {
    this.played.push(play.word);
    if (play.word === 'hug-held') return;
    if (play.word === 'let-go') this.close?.letGo();
    const ask: FrameBeatAsk = play.word === 'pause' ? (play.how === 'long' ? { frameBeat: 'pause', long: true } : { frameBeat: 'pause' }) : { frameBeat: 'let-go' };
    this.frameAsks.push({ ask, replyId: play.replyId, at: this.clockMs });
  }
  /** I-203: what was reached goes to the host: a let-go at once, a pause once her voice is quiet (the words before it said), at most FRAME_QUIET_MAX_S on. */
  private tellFrames(): void {
    if (!this.frameAsks.length) return;
    let quiet = true;
    try { quiet = this.frames ? this.frames.quiet() : true; } catch { quiet = true; }
    this.frameAsks = this.frameAsks.filter(item => {
      if (item.replyId !== this.replyId) return false; // another reply since: dropped, never told late
      if (item.ask.frameBeat === 'pause' && !quiet && this.clockMs - item.at < FRAME_QUIET_MAX_S * 1000) return true;
      this.played.push(`${item.ask.frameBeat}:told`);
      try { void Promise.resolve(this.frames?.ask(item.ask)).catch(() => {}); } catch { /* the host may be gone */ }
      return false;
    });
  }

  /**
   * 2026-11-23: a kiss / hug that waited longer than `waitS` for her to be free is never just dropped: the host is still asked, because her words
   * after it wait for that answer (electron/unbound/close-sequence.ts); the host's own gates decide, and a 'lighter' answer plays only while fresh.
   */
  private askStale(fresh: (at: number) => boolean): void {
    for (const w of this.waiting) if (!fresh(w.at) && w.play.replyId === this.replyId && isCloseBeatWord(w.play.word)) this.askClose(w.play.word, w.play.replyId);
  }

  /** One showcase word now, through the performer (held as she writes it to hold). */
  private playWord(word: SpeechBeatShowcaseWord, home: { x: number; z: number }, how: unknown, replyId: string, at: number, record: string = word): void {
    this.performer ??= new ShowcasePerformer(home, UNBOUND_SPEECH_BEATS.liveliness, (this.seed++ % 97) / 97, 'standing');
    const beat = speechBeatShowcase(word);
    const [played] = this.performer.append([beat]);
    const hold = beatHold(isSpeechBeatHow(how) ? how : undefined, this.span.hold(replyId)); // I-175: once / line / as before
    if (hold === 'line') this.lines.hold(at);
    this.held.hold(word, played, this.performer.clock, hold); // a held beat lasts to the cap (or its release)
    this.lastBeatEnds = Math.max(this.lastBeatEnds, this.performer.clock + 0.2 + played.dur);
    if (beat.kind === 'approach' || beat.kind === 'retreat') this.moved = true;
    this.played.push(record);
  }

  /** I-193: tell the host she wants to go there. Recorded as asked ('go-left'), then as answered ('go-left:go' / 'go-left:stay'); no host or an error: she stays. */
  private askGo(word: SpeechBeatGoWord, goTo?: unknown): void {
    this.played.push(word);
    const settle = (value: unknown) => { this.played.push(`${word}:${isGoBeatAnswer(value) ? value : 'stay'}`); };
    const target = word === 'go' ? goTargetOf(goTo) : null;
    if (!this.goAsk || (word === 'go' && !target)) { settle(undefined); return; } // a go without usable numbers: nowhere to ask for
    let answer: unknown;
    try { answer = target ? this.goAsk(word, target) : this.goAsk(word); } catch { settle(undefined); return; }
    if (answer && typeof (answer as Promise<unknown>).then === 'function') (answer as Promise<unknown>).then(settle, () => settle(undefined));
    else settle(answer);
  }

  /** I-185: ask the host; 'play' → its director walks her up (this player yields); anything else, an error or no host → the lighter one. */
  private askClose(word: SpeechBeatCloseWord, replyId: string): void {
    this.played.push(word);
    const lighter = () => { this.lighter.push({ word, replyId }); this.played.push(`${word}:lighter`); };
    if (!this.ask) { lighter(); return; }
    let answer: unknown;
    try { answer = this.ask(word); } catch { lighter(); return; }
    const settle = (value: unknown) => { const a: ChatCloseAnswer = isChatCloseAnswer(value) ? value : 'lighter'; if (a === 'play') this.played.push(`${word}:play`); else lighter(); };
    if (answer && typeof (answer as Promise<unknown>).then === 'function') (answer as Promise<unknown>).then(settle, () => lighter());
    else settle(answer);
  }

  /** I-185: the lighter kiss (a shy smile) or hug (lean in, arms open a little; none while her arms are held). */
  private playLighter(word: SpeechBeatCloseWord, home: { x: number; z: number }, armsHeld: boolean): void {
    const stage = closeBeatStage(word, { lighter: true, armsHeld });
    if (stage.kind === 'word') { this.playWord(stage.word, home, 'once', this.replyId ?? '', this.text.length, `${word}>${stage.word}`); return; }
    if (this.close?.active) return; // one at a time
    this.close = new InPlaceClose(inPlacePlan(word, () => ((this.seed++ * 0.618034) % 1)), { arms: stage.arms, lean: stage.lean });
  }

  private begin(replyId: string): void {
    this.releaseHeld(); this.cancelled(); // a new reply: the old one's held beats fall now, its waiting mouth shapes are dropped
    this.close?.cancel(); this.lighter = []; this.waiting = []; this.frameAsks = []; // I-185: the lighter hug of the old reply eases out
    this.replyId = replyId; this.text = ''; this.lines.clear();
    this.schedule.begin(replyId, 'shown', this.clockMs);
    this.span.begin(replyId, 'shown', this.clockMs);
  }

  /** Held beats fall from now; the performer stays up for their release (the old end formula) and then hands back as usual. */
  private releaseHeld(): void {
    if (!this.performer) return;
    this.held.releaseAll(this.performer.clock);
    this.lastBeatEnds = Math.min(this.lastBeatEnds, Math.max(this.performer.endsAt ?? 0, this.performer.clock + 0.2));
  }

  private stop(body: SpeechBeatBody, rest: boolean): boolean {
    this.performer = null;
    this.close = null;
    this.held = new HeldBeats();
    this.lastBeatEnds = 0;
    if (rest) body.setPoseTargets({ ...REST_TARGETS });
    const moved = this.moved;
    this.moved = false;
    return moved;
  }
}

/** The full-screen page's player (main.ts): its generator, the waiting mouth shapes dropped on a new reply (I-175), and the host's kiss / hug answer (I-185). */
export function unboundSpeechBeats(generator: MotionGenerator, her: { dropWaitingMouth(): void; closeMouth?(): { speaking: boolean } }, api: { peekReport(ask: { closeBeat: SpeechBeatCloseWord } | GoBeatAsk | FrameBeatAsk): Promise<unknown> } | null | undefined): UnboundSpeechBeats {
  // I-193: the pointer's place across the screen (this page's own mouse moves) rides only on a go-cursor question.
  const cursor = typeof window !== 'undefined' ? new CursorAcross(() => window.innerWidth).listen(window) : null;
  const goAsk: GoBeatAskPort | null = api ? (word, goTo) => {
    if (word === 'go') return goTo ? api.peekReport({ goBeat: word, ...goTo }) : 'stay'; // I-193: her numbers, raw; the host converts and clamps them
    const across = word === 'go-cursor' ? cursor?.across() : null; return api.peekReport(across == null ? { goBeat: word } : { goBeat: word, cursorAcross: across });
  } : null;
  // I-203: her frames go to the host the same way; a pause once her held "she is speaking" is off (the words before it said).
  const frames: FramePorts | null = api ? { ask: ask => api.peekReport(ask), quiet: () => her.closeMouth?.().speaking !== true } : null;
  return new UnboundSpeechBeats(generator, () => her.dropWaitingMouth(), api ? word => api.peekReport({ closeBeat: word }) : null, goAsk, frames);
}
