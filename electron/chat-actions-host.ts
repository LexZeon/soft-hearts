import {
  CHAT_ACTION_OF, chatActionRefusal, chatActionWaitsForSpeech, chatActionYield, offeredChatActions,
  type ChatActionModel, type ChatActionMoodView, type ChatActionWord,
} from '../shared/chat-actions';
import { herActionSupport, type HerActionId, type HerActionPlayResult } from '../shared/her-actions';
import { MOTION_SCORE_STAMP, type MotionFitRecord } from '../shared/motion-fit-record';
import type { ModelCapabilityView } from '../shared/model-capability-check';
import type { GestureAnswer } from '../shared/journal';
import { gestureAnswerOf } from './journal/extras';

export interface ChatActionHostPorts {
  /** The current model's approved path, or null: the offered list is kept per model and dropped the moment it changes. */
  modelPath(): string | null;
  /** What the character page reads for the current model (I-024 view) and its stored fit scores; null when not known yet. */
  read(): Promise<{ view: ModelCapabilityView; fits: MotionFitRecord | null } | null>;
  /** One cue to the stage (electron/her-action-host.ts play); its answer only goes to the developer log. */
  play(action: HerActionId): Promise<HerActionPlayResult>;
  /** She is speaking a reply (or about to): a mouth shape waits for the end. */
  speaking(): boolean;
  /** Her mood view (expressions switch, phase, card intensity); only the internal channel's request asks for it. Null: not ready. */
  mood?(): ChatActionMoodView | null;
  developerMode?(): boolean;
  log?(line: string): void;
  /** 体验记录: her pick (null: none) and the answer; the host is the only caller. */
  journal?(word: ChatActionWord | null, answer: GestureAnswer | null, waited: boolean): void;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/**
 * The internal channel's "make her do one of the seven" (docs/claude/2026-11-06-actions-channel.md): the user's own Claude asks
 * for a word; it plays only when this model can do it and her mood view lets it through, with the same rules as her own pick.
 * The answer always says why when nothing was played.
 */
export type ChannelActionStatus = 'played' | 'cannot' | 'yielded' | 'busy' | 'waiting' | 'no-pet' | 'failed';
export interface ChannelActionResult { word: ChatActionWord; played: boolean; status: ChannelActionStatus; reason: string; missing: string[] }

/** What the character page reads for the current model, as the input of the shared "can she do it" rule (null: no profile yet). */
export function modelOfRead(read: { view: ModelCapabilityView; fits: MotionFitRecord | null } | null | undefined): ChatActionModel | null {
  if (!read?.view.modelKey || !read.view.profile) return null;
  return { support: herActionSupport(read.view.profile, read.view.record?.haiku?.bones ?? {}, read.view.record?.haiku?.morphs ?? {}),
    fits: read.fits, stamp: MOTION_SCORE_STAMP, choices: read.view.record?.choices };
}

/** How often a mouth shape checks whether she has finished speaking, how long she has to be quiet first, and when it gives up. */
export const CHAT_ACTION_SPEECH_POLL_MS = 250;
export const CHAT_ACTION_AFTER_SPEECH_MS = 500;
export const CHAT_ACTION_SPEECH_WAIT_MS = 45_000;

/**
 * 她自己用的小动作, host side (universal skeleton step 5; shared/chat-actions.ts). Keeps, per model, the words she may pick
 * (offered(): synchronous, so the turn's prompt never waits on a disk read; the list is refreshed in the background after each
 * read and dropped as soon as the model changes, so a new model offers nothing until its own check is read). Her pick becomes
 * one her-action cue; the stage plays it only if it can, and its answer is not shown anywhere but the developer log.
 * A mouth shape waits until she has finished speaking (speech owns the mouth); a new message drops a pick still waiting.
 */
export class ChatActionHost {
  private cache: { path: string; words: ChatActionWord[] } | null = null;
  private reading: Promise<void> | null = null;
  private waiting: unknown = null;
  /** Her own pick that is waiting for the end of speech (journal only; the channel's request is not hers). */
  private waitingWord: ChatActionWord | null = null;
  private readonly timers: NonNullable<ChatActionHostPorts['timers']>;

  constructor(private readonly ports: ChatActionHostPorts) {
    this.timers = ports.timers ?? { set: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
      clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  }

  /** The words for the current model as last read (empty when unknown, or read for another model); starts a fresh read. */
  offered(): ChatActionWord[] {
    let path: string | null = null;
    try { path = this.ports.modelPath(); } catch { path = null; }
    void this.refresh();
    return path && this.cache?.path === path ? [...this.cache.words] : [];
  }

  /** Reads the current model's check again (one read at a time). */
  refresh(): Promise<void> {
    if (this.reading) return this.reading;
    const path = () => { try { return this.ports.modelPath(); } catch { return null; } };
    const task = (async () => {
      // The model changed while reading: read again for the new one (a few times at most), never keep the old model's words.
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = path();
        if (!before) { this.cache = null; return; }
        let words: ChatActionWord[] = [];
        try { words = offeredChatActions(modelOfRead(await this.ports.read())); } catch { words = []; }
        if (path() === before) { this.cache = { path: before, words }; return; }
      }
      this.cache = null;
    })().finally(() => { this.reading = null; });
    this.reading = task;
    return task;
  }

  /** Her pick: one cue now, or (a mouth shape while she speaks) once she has been quiet for a moment. A later pick replaces it. */
  request(word: ChatActionWord, hers = true): void {
    this.cancel();
    const action = CHAT_ACTION_OF[word];
    if (!action) return;
    let waited = 0;
    const send = () => {
      this.waiting = null; this.waitingWord = null;
      void this.ports.play(action).then(result => { this.note(word, result.status + (result.detail ? ` ${result.detail}` : '')); if (hers) this.noted(word, gestureAnswerOf(result.status), waited > 0); },
        () => { this.note(word, 'error'); if (hers) this.noted(word, 'failed', waited > 0); });
    };
    if (!chatActionWaitsForSpeech(word) || !this.speaking()) { send(); return; }
    let quietFor = 0;
    this.waitingWord = hers ? word : null;
    const check = () => {
      waited += CHAT_ACTION_SPEECH_POLL_MS;
      quietFor = this.speaking() ? 0 : quietFor + CHAT_ACTION_SPEECH_POLL_MS;
      if (quietFor >= CHAT_ACTION_AFTER_SPEECH_MS) { send(); return; }
      if (waited >= CHAT_ACTION_SPEECH_WAIT_MS) { this.waiting = null; this.waitingWord = null; this.note(word, 'dropped: still speaking'); if (hers) this.noted(word, 'dropped', true); return; }
      this.waiting = this.timers.set(check, CHAT_ACTION_SPEECH_POLL_MS);
    };
    this.waiting = this.timers.set(check, CHAT_ACTION_SPEECH_POLL_MS);
  }

  /** 体验记录: her tail's pick and the answer (null, null: she picked none; 'held': her mood kept it back). Never changes what is played. */
  noted(word: ChatActionWord | null, answer: GestureAnswer | null, waited = false): void {
    try { this.ports.journal?.(word, answer, waited); } catch { /* the journal never changes her actions */ }
  }

  /**
   * The internal channel's request for one of the seven words. Order: the model can do it (the character page's rule, read fresh)
   * -> her mood view lets it through (自动表现, no other interaction, card intensity) -> a mouth shape while she speaks waits for
   * the end -> one cue to the stage, whose own answer (missing part, busy, no pet window) is passed back in words.
   */
  async perform(word: ChatActionWord): Promise<ChannelActionResult> {
    const out = (status: ChannelActionStatus, reason: string, missing: string[] = []): ChannelActionResult =>
      ({ word, played: status === 'played', status, reason, missing });
    const action = CHAT_ACTION_OF[word];
    if (!action) return out('failed', '不是她会做的动作');
    let model: ChatActionModel | null = null;
    try { model = modelOfRead(await this.ports.read()); } catch { model = null; }
    const refusal = chatActionRefusal(word, model);
    if (refusal) return out('cannot', refusal, model?.support?.[action]?.missing ?? []);
    let mood: ChatActionMoodView | null = null;
    try { mood = this.ports.mood?.() ?? null; } catch { mood = null; }
    if (!mood) return out('yielded', '她的心情状态还没准备好');
    const held = chatActionYield(word, mood);
    if (held) return out('yielded', held);
    if (chatActionWaitsForSpeech(word) && this.speaking()) {
      this.request(word, false);
      return out('waiting', '她正在说话，撅嘴要等她说完安静半秒后才做（会自己做；最多等 45 秒，用户发新消息就不做了）');
    }
    this.cancel();
    let result: HerActionPlayResult;
    try { result = await this.ports.play(action); } catch { return out('failed', '没能把动作交给舞台'); }
    const missing = result.missing ?? [];
    switch (result.status) {
      case 'played': return out('played', '已经做了一次');
      case 'missing': return out('cannot', `这个模型做不了，缺：${missing.length ? missing.join('、') : '所需的部位'}`, missing);
      case 'unfit': return out('cannot', '打分判这个动作放在这个模型上不合适，不播');
      case 'busy': return out('busy', '她正忙着别的动作或表情，这次没做');
      case 'no-window': return out('no-pet', '桌宠没在显示（先 show_pet）');
      case 'no-answer': return out('failed', '舞台没有回应');
      default: return out('failed', result.detail || '舞台没能做这个动作');
    }
  }

  /** Drops a pick still waiting for her to finish speaking (a new message, closing). */
  cancel(): void {
    if (this.waiting !== null) {
      this.timers.clear(this.waiting); this.waiting = null;
      if (this.waitingWord) this.noted(this.waitingWord, 'dropped', true);
      this.waitingWord = null;
    }
  }

  /** For tests: a pick is waiting for the end of speech. */
  get pending(): boolean { return this.waiting !== null; }

  private speaking(): boolean { try { return this.ports.speaking() === true; } catch { return false; } }
  private note(word: ChatActionWord, outcome: string): void {
    let developer = false;
    try { developer = this.ports.developerMode?.() === true; } catch { developer = false; }
    if (developer) this.ports.log?.(`[她的小动作] 回复里选了 ${word}：${outcome}`);
  }
}
