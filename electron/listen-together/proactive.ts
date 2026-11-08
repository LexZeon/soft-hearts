// I-016 B part, step 5 (docs/claude/2026-11-03-listen-together.md): she may say one line at a natural pause, from the note.
// The pause point offers one observation to the mood host (the same host-issued speech cue, hourly quota, cooldown and
// "no reply → stop" as every proactive line); the chat model writes the line in her voice; the pet shows it through the
// existing ambient bubble and readout (desk:ambient-comment-offer → acknowledgeAmbientComment). One cue is spent once; a
// cancelled, late or out-of-context result never shows. This replaces "every transcript piece may start an Opus comment"
// (electron/ambient-comments.ts noteTranscript), which no longer receives the listen-together transcripts.

import { randomUUID } from 'node:crypto';
import { parseAmbientComment, type AmbientCommentOffer, type AmbientCommentSession } from '../ambient-comments';
import type { AmbientComment, AmbientTranscript } from '../../shared/ambient-audio';
import { validateAmbientSpeechObservation, type AmbientSpeechObservation, type MoodCue, type MoodLabel } from '../../shared/mood';
import type { MoodView } from '../../shared/mood-runtime';
import type { ListenNote } from '../../shared/listen-together';
import { LISTEN_CANDIDATE_MS, LISTEN_SPOKEN_WINDOW_MS, listenSpeakPrompt, listenWillSpeak, type ListenWillInput } from '../../shared/listen-proactive';

interface Lease { readonly signal: AbortSignal; commit(): boolean; cancel(): void }
export interface ListenProactiveDeps {
  gate: { readonly busy: boolean; setScope(scope: string): void; tryAcquire(input: { scope: string; opportunityId: string; expiresAt: number }, source: 'ambient'): Lease | null };
  /** The listen session (electron/main.ts currentAmbientSession while the switch is on). */
  currentSession(): AmbientCommentSession | null;
  canComment(): boolean;
  persona(): string;
  moodText(): string;
  /** The chat model (her voice). */
  generate(prompt: string, signal: AbortSignal): Promise<string>;
  offer(comment: AmbientCommentOffer): void;
  /** Her mood label and tendencies right now, for the will to speak. */
  mood(): { primary: MoodLabel; tendencies?: ListenWillInput['tendencies'] } | null;
  /** The note still exists (not deleted) and its latest content. */
  readNote(id: string): ListenNote | null;
  /** The user answered her line about this note. */
  talked(noteId: string, at: number): void;
  /** Replaceable as a whole (tests). */
  will?(input: ListenWillInput): boolean;
  /** I-010 互动余额 is wired (the opening choice's roll is the soft cap): the 3-hour count no longer presses her will to speak. */
  budgeted?: boolean;
  now?(): number;
  random?(): number;
  createId?(): string;
}

/** Observation numbers far above the legacy archive's own sequence numbers, so the two never share an observation id. */
const OBSERVATION_BASE = 1_000_000;
type Candidate = { note: ListenNote; pause: 'ended' | 'paused'; session: AmbientCommentSession; source: AmbientSpeechObservation; until: number };

const same = (a: AmbientCommentSession, b: AmbientCommentSession | null) => b !== null && a.owner === b.owner && a.sessionId === b.sessionId
  && a.contextIdentity === b.contextIdentity && a.scope.characterId === b.scope.characterId && a.scope.providerScope === b.scope.providerScope;

export class ListenProactive {
  private candidateNow: Candidate | null = null;
  private readonly offered = new Set<string>();
  private readonly handled = new Set<string>();
  private serial = 0;
  private generating: { controller: AbortController; lease: Lease } | null = null;
  private pending: { offer: AmbientCommentOffer; session: AmbientCommentSession; noteId: string; until: number; lease: Lease } | null = null;
  private lastSpoken: { session: AmbientCommentSession; noteId: string; until: number } | null = null;
  private spoken: number[] = [];
  private revision = 0;
  private readonly now: () => number;
  /** Counts only (the frequency simulation and the developer view). `passed`: the opening choice (I-020 #10) gave the cue to something else. */
  readonly counts = { pauses: 0, declined: 0, offered: 0, generated: 0, shown: 0, passed: 0 };

  constructor(private readonly deps: ListenProactiveDeps) { this.now = deps.now ?? Date.now; }

  /** A natural pause with a note worth mentioning (electron/listen-together/core.ts). She decides here whether she wants to. */
  candidate(note: ListenNote, pause: 'ended' | 'paused'): void {
    const key = `${note.id}:${note.rolls}`, session = this.deps.currentSession(), now = this.now();
    if (!note.mention || this.offered.has(key) || !session || session.scope.characterId !== note.characterId) return;
    this.offered.add(key); if (this.offered.size > 256) this.offered.delete(this.offered.values().next().value!);
    this.counts.pauses++;
    this.spoken = this.spoken.filter(at => now - at <= LISTEN_SPOKEN_WINDOW_MS);
    let mood: ReturnType<ListenProactiveDeps['mood']> = null;
    try { mood = this.deps.mood(); } catch { mood = null; }
    const will = this.deps.will ?? listenWillSpeak;
    if (!will({ mention: note.mention, mood: mood?.primary ?? null, tendencies: mood?.tendencies, spokenRecently: this.spoken.length, random: (this.deps.random ?? Math.random)(),
      ...(this.deps.budgeted === true ? { budgeted: true } : {}) })) {
      this.counts.declined++; return;
    }
    let source: AmbientSpeechObservation;
    try { source = validateAmbientSpeechObservation({ kind: 'ambient', sessionId: session.sessionId, observationId: `${session.sessionId}:${OBSERVATION_BASE + ++this.serial}` }); }
    catch { return; }
    this.candidateNow = { note: structuredClone(note), pause, session: structuredClone(session), source, until: now + LISTEN_CANDIDATE_MS };
    this.counts.offered++;
  }

  /** The mood tick asks: is there a listen observation waiting? (no model call, no budget spent here) */
  nextSourceObservation(): AmbientSpeechObservation | undefined {
    this.expire();
    const c = this.candidateNow;
    if (!c || !same(c.session, this.deps.currentSession()) || this.generating || this.pending || this.deps.gate.busy || !this.deps.canComment()) return undefined;
    return { ...c.source };
  }

  /** This speech cue carries the pause-point candidate waiting now. */
  holds(cue: MoodCue | null | undefined): boolean {
    this.expire();
    const c = this.candidateNow;
    return !!c && !!cue && cue.kind === 'speech' && !!cue.source && cue.source.sessionId === c.source.sessionId && cue.source.observationId === c.source.observationId;
  }

  /**
   * Look, don't take (I-020 #10, electron/inner-loop/opening-host.ts): would observe() start her line on this cue now? The same
   * checks, without spending the candidate, holding the gate or asking the model.
   */
  canTake(cue: MoodCue | null | undefined): boolean {
    if (!cue || !this.holds(cue) || this.handled.has(cue.id) || cue.until <= this.now()) return false;
    const c = this.candidateNow!, session = this.deps.currentSession();
    let note: ListenNote | null = null;
    try { note = this.deps.readNote(c.note.id); } catch { note = null; }
    return !!session && same(c.session, session) && !!note && !this.generating && !this.pending && !this.deps.gate.busy && this.deps.canComment();
  }

  /** The opening choice gave this pause point to something else (her small feeling, an invite, or silence): the candidate goes, unspoken. */
  pass(cue: MoodCue | null | undefined): void {
    if (!cue || !this.holds(cue)) return;
    this.handled.add(cue.id); if (this.handled.size > 256) this.handled.delete(this.handled.values().next().value!);
    this.candidateNow = null; this.counts.passed++;
  }

  /** The mood host accepted the observation (a speech cue carrying it): spend it once, here. */
  observe(view: MoodView): void {
    this.expire();
    const cue = view.snapshot.cue, c = this.candidateNow;
    if (!c || !cue || cue.kind !== 'speech' || !cue.source || this.handled.has(cue.id) || cue.until <= this.now()) return;
    if (cue.source.sessionId !== c.source.sessionId || cue.source.observationId !== c.source.observationId) return;
    this.handled.add(cue.id); if (this.handled.size > 256) this.handled.delete(this.handled.values().next().value!);
    this.candidateNow = null; // charged by the mood host already: quiet, cancellation or a busy gate never refunds it
    const session = this.deps.currentSession(), note = this.deps.readNote(c.note.id);
    if (!session || !same(c.session, session) || !note || this.generating || this.pending || !this.deps.canComment()) return;
    const gateScope = `${session.contextIdentity}:${view.token}`;
    this.deps.gate.setScope(gateScope);
    const lease = this.deps.gate.tryAcquire({ scope: gateScope, opportunityId: cue.id, expiresAt: this.now() + 40_000 }, 'ambient');
    if (!lease) return;
    const revision = this.revision, controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lease.signal, AbortSignal.timeout(20_000)]);
    const generation = this.generating = { controller, lease };
    this.counts.generated++;
    const prompt = listenSpeakPrompt(this.deps.persona(), this.deps.moodText(), note, c.pause);
    void this.deps.generate(prompt, signal).then(value => {
      if (signal.aborted || revision !== this.revision || !same(session, this.deps.currentSession()) || !this.deps.canComment() || !this.deps.readNote(note.id)) return;
      const text = parseAmbientComment(value);
      if (!text) return;
      const offer: AmbientCommentOffer = { id: `listen-${(this.deps.createId ?? randomUUID)()}`, sessionId: session.sessionId, text, recordIds: [note.id] };
      this.pending = { offer, session, noteId: note.id, until: this.now() + 20_000, lease };
      this.deps.offer({ ...offer, recordIds: [...offer.recordIds] });
    }).catch(() => { /* silence over replay */ }).finally(() => {
      if (this.generating === generation) this.generating = null;
      if (this.pending?.lease !== lease) lease.cancel();
    });
  }

  owns(id: unknown): boolean { return typeof id === 'string' && id.startsWith('listen-'); }

  awaitingPresentation(owner: number, id: unknown): { offer: AmbientCommentOffer; signal: AbortSignal } | null {
    const p = this.pending;
    if (!p || typeof id !== 'string' || p.offer.id !== id || owner !== p.session.owner || this.now() >= p.until
      || !same(p.session, this.deps.currentSession()) || !this.deps.canComment()) return null;
    return { offer: { ...p.offer, recordIds: [...p.offer.recordIds] }, signal: p.lease.signal };
  }

  /** The pet actually showed this exact offer: commit the one cue, remember it for the user's answer. */
  async acknowledge(owner: number, id: unknown): Promise<AmbientComment | null> {
    const p = this.pending;
    if (!p || typeof id !== 'string' || p.offer.id !== id || owner !== p.session.owner || this.now() >= p.until
      || !same(p.session, this.deps.currentSession()) || !this.deps.canComment()) return null;
    this.pending = null;
    if (!p.lease.commit()) return null;
    const at = this.now();
    this.lastSpoken = { session: p.session, noteId: p.noteId, until: at + 10 * 60_000 };
    this.spoken.push(at); this.counts.shown++;
    return { id: p.offer.id, sessionId: p.session.sessionId, recordIds: [p.noteId], text: p.offer.text, createdAt: at, source: 'ambient-assistant-comment' };
  }

  async acceptUserTurn(_eventId: string, _text: string): Promise<void> {
    this.interrupt();
    const previous = this.lastSpoken; this.lastSpoken = null;
    if (previous && this.now() <= previous.until && same(previous.session, this.deps.currentSession())) {
      try { this.deps.talked(previous.noteId, this.now()); } catch { /* a mark only */ }
    }
  }

  interrupt(): void {
    this.revision++; this.generating?.controller.abort(); this.generating?.lease.cancel(); this.generating = null;
    this.pending?.lease.cancel(); this.pending = null;
  }
  clear(): void { this.interrupt(); this.candidateNow = null; this.lastSpoken = null; }

  private expire(): void {
    const now = this.now();
    if (this.candidateNow && now >= this.candidateNow.until) this.candidateNow = null;
    if (this.pending && now >= this.pending.until) { this.pending.lease.cancel(); this.pending = null; }
  }
}

/** The surface electron/main.ts already calls on its ambient comments (legacy 声音理解 plus listen-together). */
export interface AmbientCommentsLike {
  clear(): void;
  noteTranscript(record: AmbientTranscript): void;
  nextSourceObservation(): AmbientSpeechObservation | undefined;
  interrupt(): void;
  observe(view: MoodView): void;
  awaitingPresentation(owner: number, id: unknown): { offer: AmbientCommentOffer; signal: AbortSignal } | null;
  acknowledge(owner: number, id: unknown): Promise<AmbientComment | null>;
  acceptUserTurn(eventId: string, text: string): Promise<void>;
  /**
   * I-020 #10, look don't take: a sound line could start on this source cue now (the opening choice weighs "聊刚听完的" with it).
   * Absent: a source cue always counts as one (the old 声音理解 decides in observe, as before).
   */
  canTake?(cue: MoodCue): boolean;
  /** I-020 #10: this source cue went to something else; drop what waited for it. */
  pass?(cue: MoodCue): void;
}

/** One object for main.ts: the old 声音理解 comments keep working; the listen-together line takes the listen offers. */
export function routeAmbientComments(legacy: AmbientCommentsLike, listen: ListenProactive): AmbientCommentsLike {
  return {
    // A cue carrying her pause-point candidate is the listen line's; any other source cue is the old 声音理解's to judge.
    canTake: cue => listen.holds(cue) ? listen.canTake(cue) : (legacy.canTake?.(cue) ?? true),
    pass: cue => { listen.pass(cue); legacy.pass?.(cue); },
    clear: () => { legacy.clear(); listen.clear(); },
    noteTranscript: record => legacy.noteTranscript(record),
    nextSourceObservation: () => listen.nextSourceObservation() ?? legacy.nextSourceObservation(),
    interrupt: () => { legacy.interrupt(); listen.interrupt(); },
    observe: view => { listen.observe(view); legacy.observe(view); },
    awaitingPresentation: (owner, id) => listen.owns(id) ? listen.awaitingPresentation(owner, id) : legacy.awaitingPresentation(owner, id),
    acknowledge: (owner, id) => listen.owns(id) ? listen.acknowledge(owner, id) : legacy.acknowledge(owner, id),
    acceptUserTurn: async (eventId, text) => { await listen.acceptUserTurn(eventId, text); await legacy.acceptUserTurn(eventId, text); },
  };
}
