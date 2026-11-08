// I-018 理解讨论, host side (docs/claude/2026-11-03-character-understanding.md). After a card is imported, created or
// updated in place (or when the user asks), Claude opens a short discussion about the character on the 角色 page: how it
// reads her, the words that are easy to misread, a mood plan (extended values asked one by one), its questions. The user
// answers like a chat, at most three times; then Claude writes the 理解说明 and the user's OK saves it into the same card.
// Only this card and this discussion go to Claude: no chats, diary or profile, and nothing of it reaches her chat memory.
// No Electron here: the card store, the Claude call and the window are passed in.
// Brain interface (docs/claude/brain-interface.md): one tool-less Claude Code call per step, its own system prompt, the
// chat model (the one who plays her should be the one who understands her).
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ClaudeTask } from './claude';
import {
  CHARACTER_TEXT_LIMITS, effectiveCharacterMood, validateUnderstandingNotes,
  type CharacterCard, type CharacterCardState, type CharacterDraft, type CharacterTextField,
} from '../shared/character-cards';
import {
  MAX_UNDERSTANDING_ANSWER, MAX_UNDERSTANDING_REPLY, UNDERSTANDING_MAX_ROUNDS, UNDERSTANDING_SYSTEM_PROMPT, UNDERSTANDING_TRIGGERS,
  applyMoodPlan, parseUnderstandingFinal, parseUnderstandingTurn, resolveMoodPlan, understandingPrompt, validateUnderstandingSaveChoices,
  type MoodPlanView, type UnderstandingContext, type UnderstandingFinal, type UnderstandingFinalView, type UnderstandingMessage,
  type UnderstandingPhase, type UnderstandingStep, type UnderstandingTranscriptEntry, type UnderstandingTrigger, type UnderstandingView,
} from '../shared/character-understanding';
import type { MoodParameters } from '../shared/mood';

export type UnderstandingStream = (task: ClaudeTask, signal: AbortSignal, emit: (type: string, text: string) => void) => Promise<unknown>;

/** One step: a tool-less call with the discussion's own system prompt and the chat model; the whole answer as text. */
export async function askUnderstanding(prompt: string, model: string, signal: AbortSignal, stream: UnderstandingStream): Promise<string> {
  let text = '', overflow = false;
  await stream({ kind: 'chat', model, workingDirectory: os.tmpdir(), writable: false, prompt, imageDataUrls: [], systemPrompt: UNDERSTANDING_SYSTEM_PROMPT },
    signal, (type, value) => {
      if (type !== 'delta' || overflow) return;
      if (text.length + value.length > MAX_UNDERSTANDING_ANSWER) { overflow = true; return; }
      text += value;
    });
  if (overflow) throw new Error('这次的回答太长了，没有读完。');
  return text;
}

export interface CharacterUnderstandingDeps {
  /** The card as the store has it now (undefined: it is gone). */
  card(id: string): CharacterCard | undefined;
  /** The store's fingerprint of the card: a save is refused when the card changed during the discussion. */
  fingerprint(id: string): string;
  /** The chat model setting ('' = Claude Code's default). */
  model(): string;
  stream: UnderstandingStream;
  /** The control window's copy of the discussion (null: none). */
  publish(view: UnderstandingView | null): void;
  /** Saves the draft into the same card (same id, a backup first; the app's in-place update) and returns the state. */
  save(id: string, draft: CharacterDraft, expected: string): Promise<CharacterCardState>;
  nonce?(): string;
  sessionId?(): string;
}

interface Session {
  id: string;
  context: Omit<UnderstandingContext, 'nonce'>;
  fingerprint: string;
  current: MoodParameters;
  phase: UnderstandingPhase;
  rounds: number;
  finishedBy: 'user' | 'rounds';
  transcript: UnderstandingTranscriptEntry[];
  messages: UnderstandingMessage[];
  final: { parsed: UnderstandingFinal; view: UnderstandingFinalView } | null;
  error: string | null;
  retry: UnderstandingStep | null;
  /** The last Claude answer could not be read (a retry of that step replaces it). */
  unreadable: boolean;
  savedNotes: string;
  controller: AbortController | null;
  seq: number;
}

const FIELDS = Object.keys(CHARACTER_TEXT_LIMITS) as CharacterTextField[];
const friendly = (error: unknown) => {
  const message = error instanceof Error && error.message ? error.message : '';
  return message ? message.slice(0, 200) : '没有回应。';
};

/** One discussion at a time; a new one ends the old (its late answer is dropped). */
export class CharacterUnderstandingHost {
  private session: Session | null = null;
  private version = 0;
  constructor(private readonly deps: CharacterUnderstandingDeps) {}

  current(): UnderstandingView | null { return this.session ? this.view(this.session) : null; }

  /** Opens a discussion about card `id`; Claude speaks first. */
  start(id: unknown, trigger: unknown, changedFields: unknown = []): UnderstandingView {
    if (typeof id !== 'string') throw new Error('角色卡不存在。');
    if (!UNDERSTANDING_TRIGGERS.includes(trigger as UnderstandingTrigger)) throw new Error('讨论的来由不对。');
    if (!Array.isArray(changedFields) || changedFields.some(field => !FIELDS.includes(field as CharacterTextField))) throw new Error('变动的部分不对。');
    const card = this.deps.card(id);
    if (!card) throw new Error('角色卡不存在。');
    this.end();
    const session: Session = {
      id: (this.deps.sessionId ?? randomUUID)(),
      context: { card: structuredClone(card), trigger: trigger as UnderstandingTrigger, changedFields: [...new Set(changedFields as CharacterTextField[])] },
      fingerprint: this.deps.fingerprint(id), current: effectiveCharacterMood(card),
      phase: 'thinking', rounds: 0, finishedBy: 'user', transcript: [], messages: [], final: null, error: null, retry: null, unreadable: false,
      savedNotes: card.understandingNotes ?? '', controller: null, seq: 0,
    };
    this.session = session;
    void this.ask(session, 'open');
    return this.view(session);
  }

  /** The user's answer; the third one wraps the discussion up. */
  reply(sessionId: unknown, text: unknown): UnderstandingView {
    const session = this.find(sessionId);
    if (session.phase !== 'waiting' || session.rounds >= UNDERSTANDING_MAX_ROUNDS) throw new Error('现在不能回答。');
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_UNDERSTANDING_REPLY || text.includes('\0'))
      throw new Error(`回答要是 ${MAX_UNDERSTANDING_REPLY} 字以内的文字。`);
    const entry = { from: 'user' as const, text: text.trim() };
    session.transcript.push(entry); session.messages.push(entry);
    session.rounds++; session.unreadable = false;
    if (session.rounds >= UNDERSTANDING_MAX_ROUNDS) { session.finishedBy = 'rounds'; void this.ask(session, 'final'); }
    else void this.ask(session, 'follow');
    return this.view(session);
  }

  /** "就这样": Claude writes the wrap-up now. */
  finish(sessionId: unknown): UnderstandingView {
    const session = this.find(sessionId);
    if (!['waiting', 'failed'].includes(session.phase) || !session.transcript.some(entry => entry.from === 'claude'))
      throw new Error('现在还不能整理。');
    session.finishedBy = session.rounds >= UNDERSTANDING_MAX_ROUNDS ? 'rounds' : 'user';
    void this.ask(session, 'final');
    return this.view(session);
  }

  /** "再试一次": the step that failed or could not be read. */
  retry(sessionId: unknown): UnderstandingView {
    const session = this.find(sessionId);
    const step = session.retry;
    if (!step || !['waiting', 'failed'].includes(session.phase)) throw new Error('没有要重试的。');
    if (session.unreadable && step !== 'final' && session.transcript.at(-1)?.from === 'claude') { session.transcript.pop(); session.messages.pop(); }
    session.unreadable = false;
    void this.ask(session, step);
    return this.view(session);
  }

  /** 跳过 / 关闭: the discussion ends; a call in flight stops and its answer is dropped. Nothing is saved. */
  close(sessionId: unknown): void {
    if (this.session && this.session.id === sessionId) { this.end(); this.deps.publish(null); }
  }

  /** "存进卡": the user's OK on the wrap-up. Same card, same id; her chats, diary, profile and familiarity are untouched. */
  async save(sessionId: unknown, input: unknown): Promise<CharacterCardState> {
    const session = this.find(sessionId);
    if (session.phase !== 'final' || !session.final) throw new Error('还没有可以存的理解说明。');
    const choices = validateUnderstandingSaveChoices(input);
    const notes = validateUnderstandingNotes(choices.notes);
    const id = session.context.card.id;
    session.phase = 'saving'; session.error = null; this.publish(session);
    try {
      const card = this.deps.card(id);
      if (!card) throw new Error('角色卡不存在。');
      if (this.deps.fingerprint(id) !== session.fingerprint) throw new Error('这张卡在讨论期间改过了，理解说明没有存。可以重新和 Claude 聊一次。');
      const plan = session.final.view.mood;
      const parameters = choices.applyMood && plan.items.length ? applyMoodPlan(session.current, plan.items, new Set(choices.extended)) : null;
      const warm = choices.slowWarmUp ?? card.slowWarmUp === true;
      const draft: CharacterDraft = {
        ...Object.fromEntries(FIELDS.map(key => [key, card[key]])) as Pick<CharacterDraft, CharacterTextField>,
        ...(parameters ? { mood: { version: 1 as const, parameters } } : card.mood ? { mood: card.mood } : {}),
        ...(warm ? { slowWarmUp: true } : {}),
        ...(notes ? { understandingNotes: notes } : {}),
      };
      const state = await this.deps.save(id, draft, session.fingerprint);
      if (this.session === session) {
        session.phase = 'saved'; session.savedNotes = notes;
        session.fingerprint = this.deps.fingerprint(id);
        this.publish(session);
      }
      return state;
    } catch (error) {
      if (this.session === session) { session.phase = 'final'; session.error = friendly(error); this.publish(session); }
      throw error;
    }
  }

  private find(sessionId: unknown): Session {
    if (!this.session || this.session.id !== sessionId) throw new Error('这段讨论已经结束了。');
    return this.session;
  }
  private end(): void {
    this.session?.controller?.abort();
    this.session = null;
  }
  private publish(session: Session): void { if (this.session === session) this.deps.publish(this.view(session)); }

  private async ask(session: Session, step: UnderstandingStep): Promise<void> {
    session.controller?.abort();
    const seq = ++session.seq;
    const controller = new AbortController();
    session.controller = controller;
    session.phase = step === 'final' ? 'finishing' : 'thinking';
    session.error = null; session.retry = null;
    this.publish(session);
    // A late answer (the discussion was closed, replaced or asked again) changes nothing.
    const live = () => this.session === session && session.seq === seq && !controller.signal.aborted;
    let raw: string;
    try {
      const context: UnderstandingContext = { ...session.context, nonce: (this.deps.nonce ?? (() => randomBytes(8).toString('hex')))() };
      const prompt = understandingPrompt(context, step, session.transcript, { rounds: session.rounds, finishedBy: session.finishedBy });
      raw = await askUnderstanding(prompt, this.deps.model(), controller.signal, this.deps.stream);
    } catch (error) {
      if (!live()) return;
      session.controller = null;
      session.phase = 'failed'; session.retry = step;
      session.error = `Claude 这次没能回答：${friendly(error)}`;
      this.publish(session);
      return;
    }
    if (!live()) return;
    session.controller = null;
    if (step === 'final') {
      try {
        const parsed = parseUnderstandingFinal(raw);
        session.final = { parsed, view: this.finalView(session, parsed) };
        session.phase = 'final';
      } catch {
        session.messages.push({ from: 'claude', step, turn: null, raw });
        session.phase = 'waiting'; session.retry = 'final';
        session.error = '没能读懂这次整理的结果，原文照登在上面；什么都没存。可以「再整理一次」。';
      }
    } else {
      session.transcript.push({ from: 'claude', raw });
      try {
        const turn = parseUnderstandingTurn(raw, step);
        const mood: MoodPlanView | null = turn.mood ? resolveMoodPlan(turn.mood, session.current) : null;
        session.messages.push({ from: 'claude', step, turn: { ...turn, mood }, raw: null });
      } catch {
        session.messages.push({ from: 'claude', step, turn: null, raw });
        session.unreadable = true; session.retry = step;
        session.error = '这次的回答格式不对，原文照登在上面。可以接着回答，也可以「再试一次」。';
      }
      session.phase = 'waiting';
    }
    this.publish(session);
  }

  private finalView(session: Session, parsed: UnderstandingFinal): UnderstandingFinalView {
    const card = session.context.card;
    return {
      notes: parsed.notes, summary: parsed.summary, mood: resolveMoodPlan(parsed.mood, session.current),
      slowWarmUp: { value: parsed.slowWarmUp, current: card.slowWarmUp === true },
      realerEmotions: { suggested: parsed.realerEmotions === true && card.realerEmotions !== true, current: card.realerEmotions === true },
      cardEdits: parsed.cardEdits,
    };
  }

  private view(session: Session): UnderstandingView {
    return structuredClone({
      sessionId: session.id, version: ++this.version, cardId: session.context.card.id, cardName: session.context.card.name, trigger: session.context.trigger,
      phase: session.phase, rounds: session.rounds, maxRounds: UNDERSTANDING_MAX_ROUNDS, messages: session.messages,
      final: session.final?.view ?? null, error: session.error, retry: session.retry, savedNotes: session.savedNotes,
    });
  }
}

/** The control window's IPC methods (desk:<name>), each a thin call into the host. */
export function characterUnderstandingHandlers(host: CharacterUnderstandingHost): Record<string, (...args: unknown[]) => unknown> {
  return {
    getCharacterUnderstanding: () => host.current(),
    startCharacterUnderstanding: (id, trigger, changedFields) => host.start(id, trigger, changedFields ?? []),
    replyCharacterUnderstanding: (sessionId, text) => host.reply(sessionId, text),
    finishCharacterUnderstanding: sessionId => host.finish(sessionId),
    retryCharacterUnderstanding: sessionId => host.retry(sessionId),
    closeCharacterUnderstanding: sessionId => { host.close(sessionId); },
    saveCharacterUnderstanding: (sessionId, choices) => host.save(sessionId, choices),
  };
}
