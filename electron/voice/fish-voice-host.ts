import { readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../foundation/atomic-file';
import {
  EMPTY_FISH_BUDGET, FISH_BUDGET_NOTICE, fishCapMicroUsd, fishCostMicroUsd, fishMonthKey, type FishBudgetView,
} from '../../shared/voice/fish-voice';
import type { TtsConfig, TtsStreamEvent, TtsSynthesisResult } from '../../shared/voice/tts';
import { synthesizeFishSpeech, TtsError } from './tts';

// I-070 Drama 3: the monthly spending record, the paid synthesis that respects it, and the two fixed Fish Audio pages the
// settings page may open. The usage file holds numbers only (month, bytes, micro-dollars); never words, never the key.

export const FISH_USAGE_FILE = 'drama3-usage.json';
/** The two pages the settings buttons may open, and nothing else (as electron/brain/chat-availability-host.ts). */
export const FISH_API_KEYS_URL = 'https://fish.audio/app/api-keys/';
export const FISH_BILLING_URL = 'https://fish.audio/app/developers/billing/';
const FIXED_PAGES: ReadonlySet<string> = new Set([FISH_API_KEYS_URL, FISH_BILLING_URL]);

interface UsageState { month: string; bytes: number; spentMicroUsd: number; noticedMonth: string | null }

export interface FishBudgetOptions {
  /** The profile directory, or null before settings are loaded (nothing is then admitted). */
  directory(): string | null;
  now?(): Date;
  /** Every change goes to both windows ('desk:tts-budget'). */
  publish?(view: FishBudgetView): void;
  write?: AtomicFileWriter;
  read?(file: string): string;
}

/**
 * One calendar month of Drama 3 spending. A request is admitted while this month's spending is under the user's cap; the
 * request that crosses it is allowed, and so are the later sentences of that same reply (she never stops mid-reply). After
 * that the windows read in the system voice until the month changes or the cap is raised, with one notice.
 */
export class FishBudget {
  private state: UsageState | null = null;
  private loadedFrom: string | null = null;
  private grace: { month: string; replyId: string } | null = null;
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly options: FishBudgetOptions) {}

  private now(): Date { return this.options.now?.() ?? new Date(); }
  private file(): string | null {
    const directory = this.options.directory();
    return directory ? path.join(directory, FISH_USAGE_FILE) : null;
  }
  /** The current month's record (a new month starts at zero). */
  private current(): UsageState | null {
    const file = this.file();
    if (!file) return null;
    if (this.loadedFrom !== file) {
      this.loadedFrom = file;
      this.state = null;
      try {
        const raw = JSON.parse((this.options.read ?? (name => readFileSync(name, 'utf8')))(file)) as Record<string, unknown>;
        if (raw && typeof raw === 'object' && typeof raw.month === 'string' && /^\d{4}-\d{2}$/u.test(raw.month)
          && Number.isSafeInteger(raw.bytes) && (raw.bytes as number) >= 0
          && Number.isSafeInteger(raw.spentMicroUsd) && (raw.spentMicroUsd as number) >= 0)
          this.state = { month: raw.month, bytes: raw.bytes as number, spentMicroUsd: raw.spentMicroUsd as number,
            noticedMonth: typeof raw.noticedMonth === 'string' ? raw.noticedMonth : null };
      } catch { /* Missing or unreadable: this month starts from zero (and is written back on the next request). */ }
    }
    const month = fishMonthKey(this.now());
    if (!this.state || this.state.month !== month)
      this.state = { month, bytes: 0, spentMicroUsd: 0, noticedMonth: this.state?.noticedMonth === month ? month : null };
    return this.state;
  }

  view(): FishBudgetView {
    const state = this.current();
    return state ? { month: state.month, bytes: state.bytes, spentMicroUsd: state.spentMicroUsd } : EMPTY_FISH_BUDGET(this.now());
  }

  /** May a Drama 3 request go out now under this cap (US dollars)? */
  admit(capUsd: unknown, replyId?: string): boolean {
    const state = this.current();
    if (!state) return false;
    if (state.spentMicroUsd < fishCapMicroUsd(capUsd)) return true;
    return !!replyId && this.grace?.month === state.month && this.grace.replyId === replyId;
  }

  /** The service accepted a request of `bytes` UTF-8 bytes: add its cost at today's price. */
  record(bytes: number, capUsd: unknown, replyId?: string): void {
    const state = this.current();
    if (!state || !Number.isFinite(bytes) || bytes <= 0) return;
    const cap = fishCapMicroUsd(capUsd), before = state.spentMicroUsd;
    state.bytes += Math.ceil(bytes);
    state.spentMicroUsd += fishCostMicroUsd(bytes, this.now());
    let notice = false;
    if (before < cap && state.spentMicroUsd >= cap) {
      this.grace = replyId ? { month: state.month, replyId } : null;
      notice = state.noticedMonth !== state.month;
      state.noticedMonth = state.month;
    }
    this.persist(state);
    try { this.options.publish?.({ ...this.view(), ...(notice ? { notice: true } : {}) }); } catch { /* A closed window changes nothing. */ }
  }

  /** Resolves when every recorded request is on disk (tests, quit). */
  flush(): Promise<void> { return this.writing; }

  private persist(state: UsageState): void {
    const file = this.file();
    if (!file) return;
    const data = JSON.stringify({ version: 1, month: state.month, bytes: state.bytes, spentMicroUsd: state.spentMicroUsd, noticedMonth: state.noticedMonth }, null, 2);
    this.writing = this.writing.then(() => (this.options.write ?? atomicWriteFile)(file, data)).catch(() => { /* Next record retries. */ });
  }
}

/** The SpeechRuntime synthesizer shape (electron/voice/speech-runtime.ts), with the reply and mood it reads for. */
export interface FishSynthesisContext { replyId?: string; mood?: unknown }
export type FishSynthesizer = (
  config: TtsConfig, text: string, signal: AbortSignal, emit: (event: TtsStreamEvent) => void | Promise<void>, context?: FishSynthesisContext,
) => Promise<TtsSynthesisResult>;

/** Drama 3 under the monthly limit: refused (plainly, as a quota) once the limit is used up, counted once accepted. */
export function budgetedFishSynthesizer(budget: FishBudget, synthesize: typeof synthesizeFishSpeech = synthesizeFishSpeech): FishSynthesizer {
  return (config, text, signal, emit, context) => {
    const cap = config.fishMonthlyCapUsd;
    if (!budget.admit(cap, context?.replyId)) return Promise.reject(new TtsError(`${FISH_BUDGET_NOTICE}。`, 'quota'));
    return synthesize(config, text, signal, emit, {
      mood: context?.mood,
      accepted: bytes => budget.record(bytes, cap, context?.replyId),
    });
  };
}

/** Opens one of the two fixed Fish Audio pages; any other address is refused. */
export async function openFishPage(target: string, openExternal: (url: string) => Promise<void> | void): Promise<void> {
  if (!FIXED_PAGES.has(target)) throw new Error('不能打开这个地址。');
  await openExternal(target);
}

/** IPC names, and nothing else. None takes an argument: no window can choose what is opened. */
export const FISH_VOICE_METHODS = ['getTtsBudget', 'openFishApiKeys', 'openFishBilling'] as const;

/**
 * `register` is main.ts's `host(method, operation, controlOnly)`. Both windows read the month's spending (each one decides
 * its own voice); only the control window opens the two pages.
 */
export function registerFishVoiceIpc(
  register: (method: string, operation: (...args: unknown[]) => unknown, controlOnly?: boolean) => void,
  budget: FishBudget,
  openExternal: (url: string) => Promise<void> | void,
): void {
  const fixed = (method: (typeof FISH_VOICE_METHODS)[number], operation: () => unknown, controlOnly: boolean) =>
    register(method, (...args: unknown[]) => {
      if (args.length) throw new Error('这个操作不接受参数。');
      return operation();
    }, controlOnly);
  fixed('getTtsBudget', () => budget.view(), false);
  fixed('openFishApiKeys', () => openFishPage(FISH_API_KEYS_URL, openExternal), true);
  fixed('openFishBilling', () => openFishPage(FISH_BILLING_URL, openExternal), true);
}
