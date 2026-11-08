// I-029: replay invented replies through the real reading path with a fake stream, a fake native bubble, fake voices and a
// virtual clock (docs/claude/2026-11-04-i029-comma-first-reading.md). Real: the draft filter (electron/reply-draft-guard.ts),
// the host plan (electron/completed-reply-speech.ts), the native prefix proof (electron/completed-prefix-proof.ts), the paced
// bubble (src/ui/reply-presentation.ts) and the renderer queue (src/ui/completed-reply-speech-queue.ts), wired in the order
// of electron/main.ts nextReplySpeechSegment's streamed (prefix) branch. Fake: provider timing, IPC and paint latency, and
// both voices (no audio, no network, no paid call). Used by tests/i029-first-chunk.test.ts and scripts/first-chunk-replay.ts.
import { CompletedReplySpeech } from '../../electron/completed-reply-speech';
import { CompletedPrefixProof } from '../../electron/completed-prefix-proof';
import { ReplyDraftGuard } from '../../electron/reply-draft-guard';
import { CompletedReplySpeechQueue, type ReplySpeechSession } from '../../src/ui/completed-reply-speech-queue';
import { ReplyPresentationState } from '../../src/ui/reply-presentation';
import { IncrementalReplySegments } from '../../shared/incremental-reply-segments';
import { speakableText } from '../../shared/speakable-text';
import { spokenUnits, type FirstSpeechChunk } from '../../shared/first-speech-chunk';
import type { ApprovedReplySpeechSegment } from '../../shared/tts';
import type { PauseTalkPlan } from '../../shared/behaviors/pause-talk/interface';

export type Voice = 'system' | 'bailian';
export interface StreamProfile { name: string; label: string; chunk: [number, number]; interval: [number, number]; stall?: { chance: number; ms: [number, number] } }
/** Fake provider timing. Claude Code streams token deltas; these bracket a quick, a slow and a stalling stream. */
export const PROFILES: readonly StreamProfile[] = Object.freeze([
  { name: 'fast', label: '快（约 60 字/秒）', chunk: [1, 4], interval: [20, 60] },
  { name: 'slow', label: '慢（约 17 字/秒）', chunk: [1, 3], interval: [80, 160] },
  { name: 'stall', label: '快但偶尔卡顿（12% 的增量前停 0.4–1 秒）', chunk: [1, 4], interval: [20, 60], stall: { chance: 0.12, ms: [400, 1000] } },
]);
/** Fake latencies (ms). IPC one way, native bubble paint after its text arrives, voice start. */
export const LATENCY = Object.freeze({ ipc: 3, paint: 30, systemStart: [150, 300] as [number, number], systemNext: [60, 150] as [number, number],
  bailianFirstAudio: [900, 1500] as [number, number], unitsPerSecond: 4.5 });

export interface ReplayCase { id: string; text: string; note: string; /** Text the draft filter must drop (never read, never shown). */ draft?: string }
/** Invented replies only (never the user's chats): different first-sentence lengths, with and without commas, held starts. */
export const CASES: readonly ReplayCase[] = Object.freeze([
  { id: 'short-first', note: '第一句很短，没有逗号', text: '嗯。今天过得怎么样呀？有没有好好吃饭？' },
  { id: 'short-first-2', note: '第一句很短，没有逗号', text: '好呀！那我们现在就开始吧。你先说。' },
  { id: 'medium-comma', note: '中等长度，第一句有逗号', text: '今天我一直在想你，你什么时候回来呀？我把好吃的都留着呢。' },
  { id: 'medium-comma-2', note: '中等长度，第一句有逗号', text: '你回来啦，今天辛苦了吧？先喝口水，歇一会儿。' },
  { id: 'long-comma', note: '第一句很长，前面就有逗号', text: '我刚才在窗边看了好久的云，它们慢慢地飘过去，有一朵特别像你上次说的那只猫。你今天看到了吗？' },
  { id: 'long-late-comma', note: '第一句很长，逗号很靠后', text: '其实我一直很想跟你说一件事情但是总觉得时机不太对，所以拖到了现在。你愿意听我说吗？' },
  { id: 'early-short-comma', note: '第一个逗号前太短（嗯，），等下一个逗号', text: '嗯，我想了想，今天还是早点睡比较好。明天还要早起呢。' },
  { id: 'early-short-comma-2', note: '第一个逗号前太短（好，）', text: '好，那我们说定了，明天一起去散步。不许反悔哦。' },
  { id: 'no-comma-long', note: '第一句较长，没有逗号', text: '我今天学会了一首新的歌想唱给你听。你想听吗？' },
  { id: 'question-comma', note: '问句，有逗号', text: '你今天是不是很累呀，要不要我陪你安静地待一会儿？' },
  { id: 'bracket-direction', note: '开头是括号里的动作，括号里有逗号', text: '（揉了揉眼睛，打了个哈欠）嗯……你回来啦，我刚才差点睡着了。' },
  { id: 'star-action', note: '开头是星号动作，星号里有逗号', text: '*伸了个懒腰，眨眨眼*你回来啦，今天怎么样？有没有想我？' },
  { id: 'enumeration', note: '有顿号（顿号不切）', text: '我今天吃了苹果、香蕉和一点点蛋糕，感觉好满足。你呢？' },
  { id: 'no-terminal', note: '整条没有句号', text: '晚安啦，做个好梦' },
  { id: 'paragraphs', note: '分段', text: '嗯嗯，我听到了。\n\n那我们明天再接着聊，好不好？今天就先休息吧。' },
  { id: 'english-plan', note: '开头是英文计划（过滤器扣住再丢掉）', draft: 'Keep it short and warm, agree to play.',
    text: 'Keep it short and warm, agree to play.好呀，那我们来玩猜拳吧！你先出。' },
  { id: 'english-plan-2', note: '开头是英文计划（过滤器扣住再丢掉）', draft: 'No calling the shots. ',
    text: 'No calling the shots. 嗯，听你的，你想做什么我都陪着你。今天想做什么呢？' },
  { id: 'long-no-comma', note: '第一句很长，没有逗号', text: '今天下午我一个人在家里把所有的书都重新整理了一遍。现在书架看起来整齐多了，你回来一定会喜欢的。' },
  { id: 'semicolon', note: '分号', text: '今天的天气有点冷；出门记得多穿一件衣服。别着凉了。' },
  { id: 'quote', note: '引号里有逗号', text: '“你回来啦，”她小声地说，“我等了你好久。”今天开心吗？' },
  { id: 'english-word', note: '开头一个英文词', text: 'OK，那我们就这么定了，明天下午三点见。到时候我提醒你。' },
  { id: 'two-long', note: '两句都长，都有逗号', text: '刚才你不在的时候我把房间收拾了一下，还给窗台上的小花浇了水，它好像又长高了一点点。等你忙完了，我们一起去看看它好不好？' },
]);

const OWNER = 7, SCOPE = 'scope';

/** Seeded uniform numbers, so a run is repeatable. */
function rng(seed: number): (low: number, high: number) => number {
  let a = seed >>> 0;
  return (low, high) => {
    a = (a + 0x6d2b79f5) >>> 0; let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return low + (((t ^ (t >>> 14)) >>> 0) / 4294967296) * (high - low);
  };
}
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

type Event = { t: number; seq: number; fn: () => void; dead?: boolean };
/** A virtual clock: nothing waits in real time. */
class Sim {
  now = 0;
  private seq = 0;
  private events: Event[] = [];
  at(t: number, fn: () => void): Event { const event = { t: Math.max(t, this.now), seq: this.seq++, fn }; this.events.push(event); return event; }
  after(ms: number, fn: () => void): Event { return this.at(this.now + ms, fn); }
  until(t: number): Promise<void> { return new Promise(resolve => { this.at(t, resolve); }); }
  delay(ms: number): Promise<void> { return this.until(this.now + ms); }
  async run(limit: number): Promise<void> {
    await settle();
    for (;;) {
      this.events.sort((a, b) => a.t - b.t || a.seq - b.seq);
      const event = this.events.shift();
      if (!event || event.t > limit) return;
      if (event.dead) continue;
      this.now = event.t; event.fn(); await settle();
    }
  }
}

/** How long a voice reads `spoken` (fake): 4.5 units a second plus the pause its last mark asks for. */
function duration(spoken: string): number {
  const end = /[。！？!?.]["'”’」』）)]*\s*$/u.test(spoken) ? 350 : /[，；,;、]["'”’」』）)]*\s*$/u.test(spoken) ? 200 : 0;
  return Math.max(1, spokenUnits(spoken)) / LATENCY.unitsPerSecond * 1000 + end;
}

export interface PieceLog { index: number; text: string; visibleEnd: number; approvedAt: number; start: number | null; end: number | null; shownAtStart: number }
export interface ReplayResult {
  caseId: string; profile: string; voice: Voice; mode: FirstSpeechChunk; seed: number;
  /** The first character of the reply is on screen. */
  visibleAt: number | null;
  /** The first sound of the reply. */
  audioAt: number | null;
  delayMs: number | null;
  pieces: PieceLog[];
  /** The first piece ends before the first sentence does (comma mode cut it). */
  firstCut: boolean;
  /** Silence between the first two pieces beyond what the voice itself leaves (ms), when both were heard. */
  gapMs: number | null;
  shown: string;
  violations: string[];
}

export interface ReplayOptions {
  profile: StreamProfile; voice: Voice; mode: FirstSpeechChunk; seed: number;
  /** At this time: 'cancel' stops the reply (stop button, voice off); 'supersede' starts the next reply; 'finish' turns the mic on. */
  interrupt?: { at: number; kind: 'cancel' | 'supersede' | 'finish' };
  /** Comparison runs only: the first piece's minimum instead of the voice's own (FIRST_CHUNK_MIN_UNITS). */
  minUnits?: number;
  /** Override the fake cloud voice's first-audio latency range (ms). */
  bailianFirstAudio?: [number, number];
  /** F7 停停说说: haiku's plan for this reply reaches the paced bubble at this virtual time (tests/f7-pause-talk.test.ts). */
  pausePlan?: { plan: PauseTalkPlan; at: number };
}

/** One reply through the whole path. Times are milliseconds of the virtual clock; the provider's first delta is at 1000. */
export async function replay(c: ReplayCase, options: ReplayOptions): Promise<ReplayResult> {
  const sim = new Sim(), random = rng(options.seed * 7919 + c.id.length * 104729 + c.text.length);
  const id = 'r1', violations: string[] = [];
  // ——— Host: draft filter in front, then the plan (frozen mode per reply, as main.ts does at acceptance).
  const guard = new ReplyDraftGuard([], { chinese: true });
  const plans = new CompletedReplySpeech(() => sim.now);
  const fence = plans.beginCommit(OWNER, id, SCOPE, { mode: options.mode, voice: options.voice, minUnits: options.minUnits });
  let hostText = '';
  // ——— Native bubble: every text update is a new revision; its paint receipt arrives LATENCY.paint later unless superseded.
  let bubbleText = '', revision = 0, painted: { text: string; revision: number } | null = null, onScreen = '', visibleAt: number | null = null;
  const waits = new Set<{ revision: number; text: string; resolve(value: boolean): void }>();
  const proof = new CompletedPrefixProof({
    snapshot: () => ({ text: bubbleText, revision, ready: !!bubbleText.trim(), ownerCurrent: true }),
    current: text => !!painted && painted.revision === revision && painted.text === text,
    waitExact: (text, signal) => new Promise<boolean>(resolve => {
      if (painted && painted.revision === revision && painted.text === text) { resolve(true); return; }
      const wait = { revision, text, resolve };
      waits.add(wait);
      signal.addEventListener('abort', () => { if (waits.delete(wait)) resolve(false); }, { once: true });
    }),
  });
  const setBubble = (text: string) => {
    bubbleText = text; const mine = ++revision;
    for (const wait of [...waits]) if (wait.revision !== mine) { waits.delete(wait); wait.resolve(false); }
    proof.changed();
    sim.after(LATENCY.paint, () => {
      // What the user sees changes when it is drawn, whether or not its receipt still counts.
      if (text.length >= onScreen.length) onScreen = text;
      if (visibleAt === null && text.trim()) visibleAt = sim.now;
      if (mine !== revision) return;
      painted = { text, revision: mine };
      for (const wait of [...waits]) if (wait.revision === mine) { waits.delete(wait); wait.resolve(wait.text === text); }
      proof.changed();
    });
  };
  // ——— Renderer: the paced bubble (R27) and the queue.
  const presentation = new ReplyPresentationState({ now: () => sim.now,
    set: (fn, delay) => sim.after(delay, fn) as unknown as ReturnType<typeof setTimeout>,
    clear: timer => { (timer as unknown as Event).dead = true; } });
  presentation.begin(id);
  presentation.startReadout(id, prefix => { sim.after(LATENCY.ipc, () => setBubble(prefix)); });
  const pausePlan = options.pausePlan;
  if (pausePlan) sim.at(pausePlan.at, () => { presentation.setPausePlan(id, { id, ...pausePlan.plan }); });
  let rendererText = '', kicked = false;
  const leases = new Map<number, ApprovedReplySpeechSegment>();
  const pieces: PieceLog[] = [];
  const api = {
    async nextReplySpeechSegment(replyId: string, completedIndex?: number): Promise<ApprovedReplySpeechSegment | null> {
      await sim.delay(LATENCY.ipc);
      const owner = OWNER, scope = SCOPE;
      if (plans.isPrefixReply(owner, replyId, scope)) {
        const committed = await plans.waitForCommit(owner, replyId, scope);
        if (!committed || !plans.commitCurrent(committed, owner, replyId, scope)) return null;
      }
      if (!await plans.waitForPiece(owner, replyId, scope, completedIndex)) return null;
      const segment = plans.next(owner, replyId, scope, completedIndex);
      if (!segment) return null;
      if (!await plans.waitForPresentationReady(owner, replyId, scope, segment)) return null;
      if (!plans.prefixMode(owner, replyId, scope, segment)) throw Error('only the streamed (prefix) branch is replayed');
      const full = plans.fullPresentationText(owner, replyId, scope, segment), signal = plans.presentationSignal(owner, replyId, scope, segment);
      if (full === null || !signal) return null;
      const accepted = await proof.wait(() => plans.fullPresentationText(owner, replyId, scope, segment), segment.visibleText.length, signal,
        plans.presentationRemaining(owner, replyId, scope, segment), candidate => {
          const now = plans.fullPresentationText(owner, replyId, scope, segment);
          if (!plans.ownsLease(owner, replyId, scope, segment) || !now?.startsWith(full) || !now.startsWith(candidate)
            || candidate.length < segment.visibleText.length || !(painted && painted.text === candidate && painted.revision === revision)) return false;
          return plans.approvePresentation(owner, replyId, scope, segment, candidate);
        });
      if (!accepted) return null;
      leases.set(segment.index, segment);
      pieces.push({ index: segment.index, text: segment.text, visibleEnd: segment.visibleText.length, approvedAt: sim.now, start: null, end: null, shownAtStart: 0 });
      await sim.delay(LATENCY.ipc);
      return segment;
    },
    async cancelReplySpeech(replyId: string) { plans.cancel(OWNER, replyId); },
  };
  const heard = (index: number, start: number, length: number) => {
    const piece = pieces.find(p => p.index === index);
    if (!piece) { violations.push(`audio for a piece that was never approved (${index})`); return; }
    if (piece.start !== null) violations.push(`piece ${index} read twice`);
    piece.start = start; piece.end = start + length; piece.shownAtStart = onScreen.length;
    if (onScreen.length < piece.visibleEnd) violations.push(`piece ${index} read before it was on screen (${onScreen.length} < ${piece.visibleEnd})`);
  };
  const session = (): ReplySpeechSession => options.voice === 'system' ? systemSession() : bailianSession();
  // System voice (VoiceOutput.openSystemReply): one utterance after another; append resolves when it starts.
  const systemSession = (): ReplySpeechSession => {
    let tail = Promise.resolve(), stopped = false, closed = false, finishing = false, first = true;
    return {
      append: (text, context) => {
        if (closed || stopped || finishing) return Promise.resolve(false);
        return new Promise<boolean>(resolve => {
          tail = tail.then(async () => {
            if (stopped || finishing) { resolve(false); return; }
            const spoken = speakableText(text);
            if (!spoken) { resolve(true); return; }
            await sim.delay(random(...(first ? LATENCY.systemStart : LATENCY.systemNext))); first = false;
            if (stopped) { resolve(false); return; }
            const length = duration(spoken);
            heard(context.segmentIndex ?? -1, sim.now, length);
            resolve(true);
            await sim.delay(length);
          });
        });
      },
      close: () => { closed = true; return tail; },
      cancel: () => { stopped = true; },
      finishCurrent: () => { finishing = true; },
    };
  };
  // Bailian (VoiceOutput.openReply): one continuous player; requests one after another; append resolves once the segment is
  // synthesized and audible (the "at most one ahead" gate).
  const bailianSession = (): ReplySpeechSession => {
    let networkFree = 0, audioEnd = 0, stopped = false, closed = false, finishing = false, cutAt = Infinity;
    return {
      append: (text, context) => {
        if (closed || stopped || finishing) return Promise.resolve(false);
        const spoken = speakableText(text);
        if (!text.trim() || !spoken) return Promise.resolve(true);
        return new Promise<boolean>(resolve => {
          const length = duration(spoken), request = Math.max(sim.now, networkFree), first = request + random(...(options.bailianFirstAudio ?? LATENCY.bailianFirstAudio));
          const done = first + 0.3 * length, start = Math.max(first, audioEnd);
          networkFree = done; audioEnd = start + length;
          // finishCurrent keeps the segment being heard and drops every later one (VoiceOutput.finishReply).
          sim.at(start, () => { if (!stopped && start <= cutAt) heard(context.segmentIndex ?? -1, start, length); });
          sim.at(Math.max(done, start), () => resolve(!stopped));
        });
      },
      close: () => { closed = true; return sim.until(audioEnd); },
      cancel: () => { stopped = true; },
      finishCurrent: () => { finishing = true; cutAt = sim.now; },
    };
  };
  const queue = new CompletedReplySpeechQueue(api, async () => { throw Error('replies always use a session'); }, () => true, () => session());
  let speaking: Promise<void> | null = null;
  // ——— Provider stream, in fake time.
  const chars = Array.from(c.text);
  let at = 1000;
  for (let i = 0; i < chars.length;) {
    const size = Math.round(random(options.profile.chunk[0], options.profile.chunk[1] + 0.999) - 0.5);
    const delta = chars.slice(i, i + Math.max(1, size)).join(''); i += Math.max(1, size);
    const when = at;
    sim.at(when, () => {
      const released = guard.push(delta);
      if (!released) return;
      plans.append(fence, released); hostText += released;
      sim.after(LATENCY.ipc, () => {
        rendererText += released;
        presentation.content(id, rendererText); presentation.readoutContent(id, rendererText);
        if (!kicked) { kicked = true; speaking = queue.speak(id).catch(error => { violations.push(`queue failed: ${String(error)}`); }); }
      });
    });
    at += random(...options.profile.interval);
    if (options.profile.stall && random(0, 1) < options.profile.stall.chance) at += random(...options.profile.stall.ms);
  }
  sim.at(at, () => {
    const rest = guard.finish();
    if (rest) { plans.append(fence, rest); hostText += rest; }
    // The host records the completed reply, then the task's 'done' reaches the renderer (electron/main.ts launchTask).
    sim.after(1, () => { plans.record(OWNER, id, SCOPE, hostText, { prefix: true, fence }); });
    sim.after(1 + LATENCY.ipc, () => {
      if (rest) { rendererText += rest; presentation.readoutContent(id, rendererText); }
      if (!kicked && rendererText.trim()) { kicked = true; speaking = queue.speak(id).catch(error => { violations.push(`queue failed: ${String(error)}`); }); }
      // 'done' in the pet: prepareReplySpeechPresentation → acknowledgeReplySpeechReady (a reply that streamed no piece waits for it).
      sim.after(LATENCY.ipc, () => {
        void plans.waitForCommit(OWNER, id, SCOPE).then(committed => { if (committed) plans.markPresentationReady(id, SCOPE, committed); });
      });
      presentation.finishReadout(id, () => {});
    });
  });
  let interruptedAt: number | null = null;
  if (options.interrupt) {
    const { at: when, kind } = options.interrupt;
    sim.at(when, () => {
      interruptedAt = sim.now;
      if (kind === 'cancel') queue.cancel();
      else if (kind === 'finish') queue.finishCurrent(id);
      else { plans.beginCommit(OWNER, 'r2', SCOPE, { mode: options.mode, voice: options.voice }); void queue.speak('r2').catch(() => {}); }
    });
  }
  await sim.run(10 * 60_000);
  // Everything the queue waits for is on the virtual clock: once it has run out, the reading is over or stuck.
  let finished = !speaking;
  void (speaking as Promise<void> | null)?.then(() => { finished = true; });
  await settle(); await settle();
  if (!finished) { violations.push('the reading never finished'); queue.cancel(); plans.clear(); await settle(); }
  if (c.draft && hostText.includes(c.draft.trim())) violations.push('the draft filter let the plan through');
  for (const piece of pieces) {
    if (!hostText.includes(piece.text)) violations.push(`piece ${piece.index} is not shown text`);
    if (c.draft && piece.text.includes(c.draft.trim().slice(0, 12))) violations.push(`piece ${piece.index} reads the dropped draft`);
    if (options.interrupt?.kind !== 'finish' && interruptedAt !== null && piece.start !== null && piece.start > interruptedAt) violations.push(`piece ${piece.index} started after the reply was ${options.interrupt?.kind}`);
  }
  const ordered = [...pieces].sort((a, b) => a.index - b.index);
  ordered.forEach((piece, index) => { if (piece.index !== index) violations.push(`pieces out of order at ${index}`); });
  for (let i = 1; i < ordered.length; i++) if (ordered[i].visibleEnd <= ordered[i - 1].visibleEnd) violations.push('pieces overlap');
  if (!options.interrupt && ordered.length && hostText.slice(ordered.at(-1)!.visibleEnd).trim()) violations.push('the end of the reply was never read');
  const audible = ordered.filter(piece => piece.start !== null);
  const audioAt = audible.length ? Math.min(...audible.map(piece => piece.start!)) : null;
  const sentence = new IncrementalReplySegments({ maxReplyChars: 6000 });
  const firstSentence = [...sentence.push(hostText), ...sentence.finish()].find(piece => piece.text.trim());
  const firstCut = !!ordered[0] && !!firstSentence && ordered[0].visibleEnd < firstSentence.end;
  const gapMs = ordered.length > 1 && ordered[0].end !== null && ordered[1].start !== null ? Math.max(0, ordered[1].start - ordered[0].end) : null;
  return { caseId: c.id, profile: options.profile.name, voice: options.voice, mode: options.mode, seed: options.seed, visibleAt,
    audioAt, delayMs: visibleAt !== null && audioAt !== null ? audioAt - visibleAt : null, pieces: ordered, firstCut, gapMs, shown: hostText, violations };
}

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
