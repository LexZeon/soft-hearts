/**
 * 边说边演第 3 步：一条回复的拍子什么时候演（纯的：时间由调用的人传进来，测试用假时钟）。
 *
 *  - 朗读开着（pacing 'voice'）：念到那里才演。念到一段时（voiced），这段开头以前的拍子马上演，这段中间的按每字的估计时间演。
 *    这条一直没开始念（被关掉、太长、窗口藏着）：字都显示完以后再等 voiceGraceMs，改成跟着字演。
 *  - 朗读关着（pacing 'shown'）：气泡显示到那个字时演。回复出得太快时一阵子里只演前 burstKeep 个位置，免得表情堆在一起；
 *    多的挪到下一阵子演（2026-11-23 起不丢：她回复里写的动作没有冷却、没有上限，冷却只档自主行为）。
 *  - 只演不说（final 说的）：几拍按顺序隔 performanceGapMs 演。
 *  - 新的回复开始、停止、清空、出错：没演的全部作废，不补演（一条回复只演一次，晚到的不演）。
 * 同一个位置的几拍一起演（可叠加的叠加）；先后由舞台的通道和优先级决定，这里只管时间。
 */
import { SPEECH_BEAT_TIMING, type SpeechBeatTimingKnobs } from './knobs';
import type { SpeechBeat, SpeechBeatWord } from './interface';
import { beatGoToOf, beatHowOf, isCloseBeatWord, isFrameBeatWord } from './choose';
/** A kiss / hug or (I-203) a frame: due right after the last shown or read character (the words after it may wait for it). */
const atTheWords = (word: unknown): boolean => isCloseBeatWord(word) || isFrameBeatWord(word);

export type SpeechBeatPacing = 'voice' | 'shown';
/** One beat due now. `how` (I-175): her "how long" for it (none: as before). */
export interface SpeechBeatPlay { readonly replyId: string; readonly word: SpeechBeatWord; readonly at: number; readonly how?: SpeechBeat['how']; readonly goTo?: SpeechBeat['goTo'] }

interface Pending { word: SpeechBeatWord; at: number; dueAt: number | null; burstable: boolean; how?: SpeechBeat['how']; goTo?: SpeechBeat['goTo'] }
interface Reply {
  id: string; pacing: SpeechBeatPacing; startedAt: number; beats: Pending[];
  shownLength: number; shownAt: number; total: number | null; doneAt: number | null; text: string;
  voiced: boolean; voicedFrom: number; performanceOnly: boolean;
  burst: { start: number; positions: Set<number> } | null;
}

export class SpeechBeatSchedule {
  private reply: Reply | null = null;
  private droppedCount = 0;

  constructor(private readonly knobs: SpeechBeatTimingKnobs = SPEECH_BEAT_TIMING) {}

  get replyId(): string | null { return this.reply?.id ?? null; }
  /** 作废的拍子数（新回复顶掉的、停止的、太晚的、一阵子里堆不下的）。 */
  get dropped(): number { return this.droppedCount; }
  get pending(): number { return this.reply?.beats.length ?? 0; }

  /** 新的一条回复：之前那条没演的全部作废。 */
  begin(replyId: string, pacing: SpeechBeatPacing, now: number): void {
    this.cancel();
    this.reply = { id: replyId, pacing, startedAt: now, beats: [], shownLength: 0, shownAt: now, total: null, doneAt: null, text: '',
      voiced: false, voicedFrom: 0, performanceOnly: false, burst: null };
  }

  /** 这条回复新落下的拍子（位置是显示的字里的）。别的回复的拍子不收。 */
  add(replyId: string, beats: readonly SpeechBeat[], now: number): void {
    const reply = this.current(replyId);
    if (!reply || reply.performanceOnly) return;
    for (const beat of beats) {
      // Already read past (a beat that arrives after its sentence began): now, never later.
      // 2026-11-23: a kiss / hug with no words before it has nothing to wait for (its own words wait for it: nothing may depend on progress that cannot come).
      const late = reply.pacing === 'voice' && ((reply.voiced && beat.at < reply.voicedFrom) || (atTheWords(beat.word) && beat.at <= 0));
      reply.beats.push({ word: beat.word, at: beat.at, dueAt: late ? now : null, burstable: reply.pacing === 'shown' && !isFrameBeatWord(beat.word), ...((how => how ? { how } : {})(beatHowOf(beat.word, beat.how))),
        ...((goTo => goTo ? { goTo } : {})(beatGoToOf(beat.word, beat.goTo))) }); // I-193: go's numbers ride along to the host's question
    }
    if (reply.pacing === 'shown') this.reach(reply, now, false);
  }

  /** 这条回复到现在的全文（找念到哪一段用）。 */
  text(replyId: string, full: string): void {
    const reply = this.current(replyId);
    if (reply && typeof full === 'string') reply.text = full;
  }

  /** 气泡显示到第 length 个字。 */
  shown(replyId: string, length: number, now: number): void {
    const reply = this.current(replyId);
    if (!reply || !Number.isFinite(length)) return;
    if (length > reply.shownLength) { reply.shownLength = length; reply.shownAt = now; }
    if (reply.pacing === 'shown') this.reach(reply, now, false);
  }

  /** 朗读开始念一段（这段的字）。 */
  voiced(replyId: string, segment: string, now: number): void {
    const reply = this.current(replyId);
    if (!reply || reply.pacing !== 'voice' || typeof segment !== 'string') return;
    const piece = segment.trim();
    if (!piece) return;
    let start = reply.text.indexOf(piece, reply.voicedFrom);
    if (start < 0) start = reply.text.indexOf(piece);
    if (start < 0) return;
    reply.voiced = true;
    const end = start + piece.length, last = reply.total !== null && end >= reply.total;
    reply.voicedFrom = end;
    for (const beat of reply.beats) {
      if (beat.dueAt !== null) continue;
      if (beat.at <= start) beat.dueAt = now;
      else if (beat.at < end || (last && beat.at <= reply.total!) || (atTheWords(beat.word) && beat.at <= end)) beat.dueAt = now + (beat.at - start) * this.knobs.voiceMsPerChar;
    }
  }

  /** 回复流完了：全文 total 个字（气泡可能还没显示完）。 */
  done(replyId: string, total: number, now: number): void {
    const reply = this.current(replyId);
    if (!reply || !Number.isFinite(total)) return;
    reply.total = Math.max(0, total);
    reply.doneAt = now;
    if (reply.pacing === 'shown') this.reach(reply, now, false);
  }

  /** 主机说这条只演不说：几拍按顺序隔一段演。 */
  performanceOnly(replyId: string, now: number): void {
    const reply = this.current(replyId);
    if (!reply || reply.performanceOnly) return;
    reply.performanceOnly = true;
    const gap = Math.min(1200, Math.max(600, this.knobs.performanceGapMs));
    reply.beats.forEach((beat, index) => { beat.dueAt = now + index * gap; beat.burstable = false; });
  }

  /** 停止、清空、出错：这条（不给 id 就是当前那条）没演的全部作废。 */
  cancel(replyId?: string): void {
    if (!this.reply || (replyId !== undefined && replyId !== this.reply.id)) return;
    this.droppedCount += this.reply.beats.length;
    this.reply = null;
  }

  /** 现在该演的拍子，按先后。 */
  due(now: number): SpeechBeatPlay[] {
    const reply = this.reply;
    if (!reply) return [];
    if (now - reply.startedAt > this.knobs.staleMs) { this.cancel(); return []; }
    // 朗读开着却一直没念：字显示完、流也完了，再等一会儿就跟着字演。
    if (reply.pacing === 'voice' && !reply.voiced && !reply.performanceOnly && reply.doneAt !== null && reply.total !== null
      && reply.shownLength >= reply.total && now - Math.max(reply.doneAt, reply.shownAt) >= this.knobs.voiceGraceMs) this.reach(reply, now, true);
    const ready = reply.beats.filter(beat => beat.dueAt !== null && beat.dueAt <= now)
      .sort((a, b) => a.dueAt! - b.dueAt! || a.at - b.at);
    const out: SpeechBeatPlay[] = [];
    for (const beat of ready) {
      reply.beats.splice(reply.beats.indexOf(beat), 1);
      if (beat.burstable && !this.admitBurst(reply, beat, now)) { beat.dueAt = reply.burst!.start + this.knobs.burstWindowMs + 1; reply.beats.push(beat); continue; } // later, never dropped
      out.push({ replyId: reply.id, word: beat.word, at: beat.at, ...(beat.how ? { how: beat.how } : {}), ...(beat.goTo ? { goTo: beat.goTo } : {}) });
    }
    return out;
  }

  /** 下一拍最早什么时候到（定时用）；没有定了时间的拍子时 null。 */
  nextAt(): number | null {
    const reply = this.reply;
    if (!reply) return null;
    let next: number | null = null;
    for (const beat of reply.beats) if (beat.dueAt !== null && (next === null || beat.dueAt < next)) next = beat.dueAt;
    if (next === null && reply.pacing === 'voice' && !reply.voiced && reply.doneAt !== null && reply.beats.length)
      next = Math.max(reply.doneAt, reply.shownAt) + this.knobs.voiceGraceMs;
    return next;
  }

  private current(replyId: string): Reply | null { return this.reply && this.reply.id === replyId ? this.reply : null; }

  /** 跟着字演：显示出来的字前面的拍子到了；流完而且全显示了，末尾的也到了。 */
  private reach(reply: Reply, now: number, fallback: boolean): void {
    const all = reply.total !== null && reply.shownLength >= reply.total;
    for (const beat of reply.beats) {
      if (beat.dueAt !== null) continue;
      // 2026-11-23: a kiss / hug right after the last shown character is due now: its own following words wait for it (so `<` alone could never be met).
      if (beat.at < reply.shownLength || ((all || atTheWords(beat.word)) && beat.at <= reply.shownLength)) { beat.dueAt = now; if (fallback && !isFrameBeatWord(beat.word)) beat.burstable = true; } // I-203: a frame is a place in her words, never spread out like a face
    }
  }

  private admitBurst(reply: Reply, beat: Pending, now: number): boolean {
    if (!reply.burst || now - reply.burst.start > this.knobs.burstWindowMs) reply.burst = { start: now, positions: new Set() };
    if (reply.burst.positions.has(beat.at)) return true;
    if (reply.burst.positions.size >= Math.max(1, this.knobs.burstKeep)) return false;
    reply.burst.positions.add(beat.at);
    return true;
  }
}
