/**
 * I-017 "啥都是状态" (docs/claude/2026-11-03-her-state-line.md): the host side of what she hears and does right now.
 *
 * Two facts meet here. The host owns whether she may hear at all (the audio-rhythm switch, "允许她听到", or the old 声音理解 in
 * music mode) and where from. The pet window owns what her body does to it (src/stage/music-choice.ts decides; the stage reports
 * through preload `noteStageState`). A report is only believed while it is fresh, only from the pet window (electron/main.ts
 * checks the sender), and never goes backwards: within one page load `seq` must grow, and a page load that was replaced is not
 * heard again.
 */
import type { AudioCaptureState } from '../shared/audio-capture';
import type { AmbientRuntimeState } from '../shared/ambient-audio-runtime';
import {
  asksAboutHearing, carriesTranscript, contactsToTell, hearingInnerLoopLine, parseStageStateReport,
  type HeardKind, type HearingNow, type HearingSource, type HerContact, type HerStateNow, type StageMusicState,
} from '../shared/her-state';
import { userActivityKey, userActivitySentence } from '../shared/behaviors/user-activity/effects';
import type { UserActivityView } from '../shared/behaviors/user-activity/interface';

/** The pet window reports on every change and at least this often. */
export const STAGE_STATE_HEARTBEAT_MS = 5_000;
/** Older than this, the report says nothing (the window may be hidden and throttled, or gone). */
export const STAGE_STATE_TTL_MS = 15_000;
const RETIRED_KEEP = 8;

export class StageStateHost {
  private latest: { instance: string; seq: number; music: StageMusicState; always: boolean; beat?: number; at: number } | null = null;
  private readonly retired: string[] = [];
  constructor(private readonly now: () => number = Date.now) {}

  /** One report from the pet window. False: malformed, older than what is held, or from a page load already replaced. */
  accept(value: unknown): boolean {
    const report = parseStageStateReport(value), at = this.now();
    if (!report || !Number.isFinite(at)) return false;
    const held = this.latest;
    if (held && held.instance === report.instance && report.seq <= held.seq) return false;
    if (this.retired.includes(report.instance)) return false;
    if (held && held.instance !== report.instance) {
      this.retired.push(held.instance);
      if (this.retired.length > RETIRED_KEEP) this.retired.shift();
    }
    this.latest = { ...report, at };
    return true;
  }

  /** The window closed or reloaded: forget what it said (its next page load starts a new instance). */
  reset(): void {
    if (this.latest) { this.retired.push(this.latest.instance); if (this.retired.length > RETIRED_KEEP) this.retired.shift(); }
    this.latest = null;
  }

  /** The fresh report, or null. `beat` (I-016) only when the window sent one. */
  current(now = this.now()): { music: StageMusicState; always: boolean; beat?: number } | null {
    const held = this.latest;
    if (!held || !(now - held.at >= 0 && now - held.at <= STAGE_STATE_TTL_MS)) return null;
    return { music: held.music, always: held.always, ...(held.beat !== undefined ? { beat: held.beat } : {}) };
  }
}

/** Where she may hear from: the audio-rhythm capture (system audio first), or the old 声音理解 in music mode (system audio). */
export function hearingSource(capture: AudioCaptureState | null | undefined, legacy: Pick<AmbientRuntimeState, 'active' | 'mode'> | null | undefined): HearingSource | null {
  if (capture?.slots?.['system-audio']?.dance === true) return 'system-audio';
  if (capture?.slots?.microphone?.dance === true) return 'microphone';
  if (legacy?.active === true && legacy.mode === 'music') return 'system-audio';
  return null;
}

export interface HerStateSources {
  stage: StageStateHost;
  capture(): AudioCaptureState | null;
  legacy(): Pick<AmbientRuntimeState, 'active' | 'mode'> | null;
  /** MoodHost.recentContacts(). */
  contacts(): readonly { kind: HerContact; at: number }[];
  /** The conversation (CompanionService.currentSpeechScope): the full hearing sentence is told once per conversation and per change. */
  scope?(): string;
  /** I-016: what the sound is (electron/listen-kind-source.ts heardKind); a change of it is a change worth the full sentence. */
  kind?(): HeardKind | undefined;
  /** 2026-11-07: the local recognizer turned the computer's sound into words a moment ago (ListenTogether.spokenWithin): "someone is talking". */
  speaking?(): boolean;
  now?(): number;
  /** I-019: the name of the snack just recognized for the current character (FeedRecognitionHost.recentFoodName), or null. */
  food?(): string | null;
  /** I-006 第 1 步: the user's activity state (electron/user-activity.ts view); a change of it is told once (a short sentence: state and minutes only). */
  activity?(): UserActivityView | null;
}

const TOLD_KEEP = 4;
/**
 * R28 (docs/claude/2026-11-03-her-state-line.md): the hearing sentence on every turn slowed the first token (full +255.5 ms, brief
 * +678.5 ms, 12 pairs each), so it is said in full once per conversation and per switch change (this remembers what was said),
 * briefly on the turns about it, and not at all on the others.
 */
export class HearingTold {
  private readonly told = new Map<string, string>();
  /** True when this conversation was already told this; otherwise remembers it and returns false. */
  repeat(scope: string, sentence: string): boolean {
    if (!scope) return false;
    if (this.told.get(scope) === sentence) return true;
    this.told.delete(scope); this.told.set(scope, sentence);
    while (this.told.size > TOLD_KEEP) this.told.delete(this.told.keys().next().value!);
    return false;
  }
}

const safely = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };
const SETTLED_KINDS: readonly HeardKind[] = ['music', 'show', 'talk'];

/** The readers electron/main.ts uses: this chat turn's state (given the persona it already carries) and the inner loop's line. */
export function createHerState(sources: HerStateSources) {
  const now = () => safely(() => sources.now?.() ?? Date.now(), Date.now());
  const hearing = (transcript: boolean): HearingNow => {
    const source = safely(() => hearingSource(sources.capture(), sources.legacy()), null);
    const stage = source ? sources.stage.current(now()) : null, kind = source ? safely(() => sources.kind?.(), undefined) : undefined;
    const speaking = source === 'system-audio' && safely(() => sources.speaking?.() === true, false);
    return { source, stage: stage ? { music: stage.music, always: stage.always } : null, transcript, ...(kind ? { kind } : {}), ...(speaking ? { speaking } : {}) };
  };
  const told = new HearingTold();
  let sawSpeech = false;
  // Each touch is news once: the turn that first sees it (its mood note or this line) has told her; the next message does not repeat it.
  let handled = new Set<string>();
  const contactsNow = (persona: string): HerContact[] => safely(() => {
    const at = now(), fresh = sources.contacts().filter(item => !handled.has(`${item.kind}:${item.at}`));
    const tell = contactsToTell(fresh, persona, at);
    handled = new Set([...handled, ...fresh.map(item => `${item.kind}:${item.at}`)].slice(-32));
    return tell;
  }, []);
  // I-006: "用户在专心做事 / 刚歇下来" is said on the turn the state changed and not again until it changes (per conversation); the
  // other states (说不准, 不在) say nothing and forget, so the next time she hears it again.
  const activityTold = new Map<string, string>();
  const activityNow = (): string => safely(() => {
    const view = sources.activity?.() ?? null, key = userActivityKey(view), scope = safely(() => sources.scope?.() ?? '', '');
    if (!key) { activityTold.delete(scope); return ''; }
    if (activityTold.get(scope) === key) return '';
    activityTold.delete(scope); activityTold.set(scope, key);
    while (activityTold.size > TOLD_KEEP) activityTold.delete(activityTold.keys().next().value!);
    return userActivitySentence(view);
  }, '');
  return {
    /**
     * What goes into this chat turn's perception line. `persona` is the turn's private context so far (mood note, transcript),
     * `text` the user's message. Full once per conversation and per change of the switch (or of a transcript being there), brief
     * on a message about it, nothing otherwise (R28).
     */
    chatTurn(persona: string, text?: unknown): HerStateNow {
      const heard = hearing(carriesTranscript(persona));
      // I-016: what the sound is counts as a change too, once the host has settled on it (music / show / talk are smoothed over
      // 30–60 s, so they change rarely); the stage's own "rhythm / sound" guess before that is not a change.
      const settled = heard.source && heard.kind && SETTLED_KINDS.includes(heard.kind) ? `|${heard.kind}` : '';
      // 2026-11-07: words arriving while the kind has not settled is news once (the stage said "静", now she hears someone talking); sticky until the switch goes off, so pauses in speech do not repeat it.
      sawSpeech = heard.source ? sawSpeech || heard.speaking === true : false;
      const speech = sawSpeech && !settled ? '|speech' : '';
      const repeat = told.repeat(safely(() => sources.scope?.() ?? '', ''), `${heard.source ?? 'off'}|${heard.transcript}${settled}${speech}`);
      const say = !repeat ? 'full' : asksAboutHearing(text) ? 'brief' : 'none';
      const contacts = contactsNow(persona), food = contacts.includes('food') ? safely(() => sources.food?.() ?? null, null) : null;
      const user = activityNow();
      return { hearing: heard, contacts, say, ...(food ? { food } : {}), ...(user ? { user } : {}) };
    },
    /** The inner loop's hearing line ('' while she hears nothing). Its transcript, if any, is its own block below. */
    innerLoopLine(transcript = false): string { return hearingInnerLoopLine(hearing(transcript)); },
  };
}
