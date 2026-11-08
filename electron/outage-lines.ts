import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from './atomic-file';
import { OUTAGE_LINE_KINDS, type OutageLineKind } from '../shared/chat-availability';

/**
 * Her own words for the days chat does not work, prepared in advance for the active character card.
 *
 * While chat works, one tool-less Claude call per card writes 3 short lines for each situation (login
 * expired, allowance used up, offline, Claude Code missing, too busy, something else, and "I'm back"), in the
 * card's own voice (login expired, allowance used up, offline, blocked secure connection, Claude Code missing, too busy, something else, and "I'm back"). They are cached on this machine, keyed by a hash of the card's compiled text, so a card
 * that changes gets new lines and a card that does not never costs another call. When there is no cache yet the
 * windows use their generic gentle sentences. Output that is not strictly what was asked for is dropped whole.
 */
export type OutageLines = Record<OutageLineKind, string[]>;

/** Bump when the prompt or the checks change: every cached set is then written again, once. */
export const OUTAGE_LINES_VERSION = 1;
const LINES_PER_KIND = 3;
const MAX_LINE_CHARS = 60;

export function outageCardKey(persona: string): string {
  return createHash('sha256').update(`soft-hearts-outage-lines/v${OUTAGE_LINES_VERSION}\n${persona}`).digest('hex').slice(0, 32);
}

export function outageLinesPrompt(persona: string): string {
  return `你就是下面这位角色本人，正在和用户一起待在桌面上。应用偶尔会暂时联系不上你的"大脑"，那时你没法像平时那样回答用户。请提前想好这些时候你会怎么对用户说，用你自己的口吻。

<character-card>
${persona}
</character-card>

按下面 ${OUTAGE_LINE_KINDS.length} 种情形，各写 ${LINES_PER_KIND} 句不同的短话。每句不超过 40 个字，是你直接对用户说的话，像平时聊天那样：
- "login-expired"：你好像"认不出自己了"，请用户去设置里帮你看一眼。
- "quota"：你今天说了很多话，像是累了，要先歇一会儿再陪用户。
- "network"：好像连不上网，等网络好了再陪用户说话。
- "certificate"：网络好像被什么拦住了、连不上安全的连接，请用户去设置里看看说明。
- "not-found"：你一时找不到自己"思考的地方"，请用户去设置里看看。
- "rate-limited"：一下子有点转不过来，请用户稍等一小会儿。
- "other"：刚才好像出了点小问题，没能回答，请用户再试一次。
- "recovered"：恢复了，你回来了。

规则：
1. 完全用角色的口吻和性格来说（傲娇、害羞、温柔……由角色决定），三句之间不要套同一个模板。
2. 不要出现任何技术词：Claude、API、服务器、网络协议、错误码、token、终端、命令行、报错。
3. 不要写具体的时间、数字或网址。
4. 不要替用户说话，不要编造用户没说过的事。
5. 用角色卡里使用的语言来写。
只输出一个 JSON 对象，不要代码块，不要解释，格式严格如下，每个数组恰好 ${LINES_PER_KIND} 个字符串：
{${OUTAGE_LINE_KINDS.map(kind => `"${kind}":["","",""]`).join(',')}}`;
}

const TECHNICAL = /claude|anthropic|\bapi\b|https?:|www\.|token|server|exception|stack ?trace|服务器|错误码|报错|命令行|终端|\bcli\b/i;
const FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f<>`{}\[\]\\]|\d/u;

function validLine(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return [...text].length >= 2 && [...text].length <= MAX_LINE_CHARS && !FORBIDDEN_CHARACTERS.test(text) && !TECHNICAL.test(text);
}

/** Strict: exactly the known kinds (OUTAGE_LINE_KINDS), each with 2–4 usable different lines (the first three are kept). Throws otherwise. */
export function validateOutageLines(data: unknown): OutageLines {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('台词格式不正确。');
  const input = data as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== OUTAGE_LINE_KINDS.length || keys.some(key => !(OUTAGE_LINE_KINDS as readonly string[]).includes(key)))
    throw new Error('台词的分类不对。');
  const result = {} as OutageLines;
  for (const kind of OUTAGE_LINE_KINDS) {
    const list = input[kind];
    if (!Array.isArray(list) || list.length < 2 || list.length > 4 || !list.every(validLine)) throw new Error(`“${kind}”的台词不合格。`);
    const unique = [...new Set(list.map(line => line.trim()))];
    if (unique.length < 2) throw new Error(`“${kind}”的台词重复。`);
    result[kind] = unique.slice(0, LINES_PER_KIND);
  }
  return result;
}

export function parseOutageLines(raw: string): OutageLines {
  if (typeof raw !== 'string' || raw.length > 12_000) throw new Error('台词输出过长。');
  const source = raw.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  return validateOutageLines(JSON.parse(source));
}

export interface OutageLineLimits {
  /** Least time between any two generation attempts. */
  minGapMs: number;
  /** Least time before the same card is tried again after an attempt that did not produce lines. */
  retryCardMs: number;
  /** Attempts in any 24 hours, across cards. */
  maxPerDay: number;
  /** Cards kept in the cache; the oldest are forgotten. */
  maxCards: number;
  timeoutMs: number;
}
export const DEFAULT_OUTAGE_LINE_LIMITS: OutageLineLimits = {
  minGapMs: 10 * 60_000, retryCardMs: 6 * 3_600_000, maxPerDay: 4, maxCards: 16, timeoutMs: 60_000,
};

export type EnsureOutcome = 'cached' | 'generated' | 'limited' | 'busy' | 'invalid' | 'failed';

interface Stored { version: 1; cards: Record<string, { at: number; lines: OutageLines }>; attempts: { at: number; key: string; ok: boolean }[] }

export interface OutageLineBankOptions {
  /** `<profile folder>/outage-lines.json`. */
  file: string | (() => string);
  /** One tool-less Claude call with the current chat model; resolves to its text. */
  generate(prompt: string, signal: AbortSignal): Promise<string>;
  now?: () => number;
  write?: AtomicFileWriter;
  limits?: Partial<OutageLineLimits>;
}

export class OutageLineBank {
  private cards = new Map<string, { at: number; lines: OutageLines }>();
  private attempts: Stored['attempts'] = [];
  private inflight: Promise<EnsureOutcome> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private readonly limits: OutageLineLimits;
  private readonly now: () => number;
  private readonly write: AtomicFileWriter;

  constructor(private readonly options: OutageLineBankOptions) {
    this.limits = { ...DEFAULT_OUTAGE_LINE_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.write = options.write ?? atomicWriteFile;
  }

  private file(): string { return typeof this.options.file === 'function' ? this.options.file() : this.options.file; }

  /** A missing or damaged file is simply "nothing cached yet". Every stored set is checked again. */
  async load(): Promise<void> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.file(), 'utf8')); } catch { return; }
    if (!raw || typeof raw !== 'object' || (raw as Stored).version !== 1) return;
    const stored = raw as Partial<Stored>;
    for (const [key, entry] of Object.entries(stored.cards ?? {})) {
      if (!/^[0-9a-f]{32}$/.test(key) || !entry || typeof entry.at !== 'number') continue;
      try { this.cards.set(key, { at: entry.at, lines: validateOutageLines(entry.lines) }); } catch { /* Dropped. */ }
    }
    this.attempts = (Array.isArray(stored.attempts) ? stored.attempts : [])
      .filter(a => a && typeof a.at === 'number' && typeof a.key === 'string' && typeof a.ok === 'boolean').slice(-64);
  }

  /** The cached set for this card text, or null. */
  lines(persona: string): OutageLines | null {
    return this.cards.get(outageCardKey(persona))?.lines ?? null;
  }

  /** One line for `kind`; `pick` varies it between outages. */
  pick(persona: string, kind: OutageLineKind, pick = 0): string | null {
    const list = this.lines(persona)?.[kind];
    return list?.length ? list[Math.abs(Math.trunc(pick)) % list.length] : null;
  }

  /**
   * Make sure this card has its lines; call it when chat has just worked. Costs nothing when they are cached,
   * and is held back by the limits otherwise (see OutageLineLimits). Never throws.
   */
  ensure(persona: string): Promise<EnsureOutcome> {
    const key = outageCardKey(persona);
    if (this.cards.has(key)) return Promise.resolve('cached');
    if (this.inflight) return Promise.resolve('busy');
    const at = this.now();
    const recent = this.attempts.filter(a => at - a.at < 24 * 3_600_000);
    if (recent.length >= this.limits.maxPerDay
      || recent.some(a => at - a.at < this.limits.minGapMs)
      || recent.some(a => a.key === key && !a.ok && at - a.at < this.limits.retryCardMs)) return Promise.resolve('limited');
    const run = this.generateOnce(persona, key, at).finally(() => { this.inflight = null; });
    this.inflight = run;
    return run;
  }

  private async generateOnce(persona: string, key: string, at: number): Promise<EnsureOutcome> {
    // The attempt is recorded before the call, so a crash in the middle cannot be retried in a tight loop.
    this.attempts = [...this.attempts.filter(a => at - a.at < 24 * 3_600_000), { at, key, ok: false }];
    await this.save();
    let raw: string;
    try { raw = await this.options.generate(outageLinesPrompt(persona), AbortSignal.timeout(this.limits.timeoutMs)); }
    catch { return 'failed'; }
    let lines: OutageLines;
    try { lines = parseOutageLines(raw); } catch { return 'invalid'; }
    this.cards.set(key, { at: this.now(), lines });
    this.attempts[this.attempts.length - 1].ok = true;
    while (this.cards.size > this.limits.maxCards) {
      const oldest = [...this.cards].sort((a, b) => a[1].at - b[1].at)[0][0];
      this.cards.delete(oldest);
    }
    await this.save();
    return 'generated';
  }

  /** Test seam and shutdown: waits for the cache file write in flight. */
  flush(): Promise<void> { return this.saving; }

  private save(): Promise<void> {
    const data: Stored = { version: 1, cards: Object.fromEntries(this.cards), attempts: this.attempts.slice(-64) };
    const next = this.saving.then(async () => {
      await mkdir(path.dirname(this.file()), { recursive: true });
      await this.write(this.file(), JSON.stringify(data));
    }).catch(() => { /* A cache that cannot be written is only a cache. */ });
    this.saving = next;
    return next;
  }
}

/**
 * Turns "chat just worked" into at most one background `ensure()` a little later, and only when the active card
 * has no lines yet and the user is not in the middle of a chat. Never throws, never blocks chat.
 */
export class OutageLineScheduler {
  private timer: unknown = null;
  constructor(private readonly options: {
    bank: Pick<OutageLineBank, 'ensure' | 'lines'>;
    /** The active card's compiled text, or null when there is none. Read again when the wait is over. */
    persona(): string | null;
    /** A chat turn is running right now. */
    busy(): boolean;
    delayMs?: number;
    timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
  }) {}

  private get timers() {
    return this.options.timers ?? {
      set: (callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; },
      clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  worked(): void {
    if (this.timer !== null) return;
    let persona: string | null = null;
    try { persona = this.options.persona(); } catch { return; }
    if (!persona || this.options.bank.lines(persona)) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      try {
        if (this.options.busy()) return; // The next working turn asks again.
        const current = this.options.persona();
        if (current) void this.options.bank.ensure(current).catch(() => {});
      } catch { /* Best effort. */ }
    }, this.options.delayMs ?? 30_000);
  }

  dispose(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}
