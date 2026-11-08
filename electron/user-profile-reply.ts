import type { UserProfileAcceptance, UserProfileCandidate, UserProfileStore } from './user-profile';

type ProfileStorePort = Pick<UserProfileStore, 'beginObservation' | 'releaseAcceptance' | 'cancelObservation' | 'completeObservation'>;
export interface UserProfileReplyCompletion { id: string; profileReplyAccepted?(): boolean }
export type UserProfileReplyStatus = 'complete' | 'stopped' | 'error' | 'unsupported';
export interface UserProfileReplyOutcome { status: 'saved' | 'ignored' | 'failed'; added: number }

// Deliberately conservative literal capture, not a general semantic classifier.
const ambiguousMessage = /["'`“”‘’「」『』<>\[\]]|(?:^|\n)\s*>|https?:\/\/|角色扮演|扮演|假装|假设|假如|如果|设想|情景|场景|举例|举个例子|比如|例如|翻译|改写|润色|转述|台词|剧本|小说|故事|他说|她说|他们|她们|朋友|同事|某人|对方|别人|(?:\b(?:quote|role.?play|pretend|translate|rewrite|fiction)\b)|\bmy friend\b/iu;
const thirdParty = /[他她]|\b(?:he|she|they|their|his|her)\b/iu;
const sensitive = /抑郁|焦虑|诊断|疾病|癌|病史|药物|宗教|政治|党派|民族|种族|性取向|同性|异性恋|身份证|护照|银行卡|信用卡|住址|地址|密码|密钥|秘钥|api[_ -]?key|\b(?:health|diagnos\w*|religion|politic\w*|sexual\w*|race|passport|address|password|secret|token|bearer)\b|\bsk-[A-Za-z0-9._-]+|[A-Za-z]:[\\/]|file:\/\/|\/Users\/|\/home\//iu;
const optOut = /别记|不要记|不准记|别保存|不要保存|无需记录|开玩笑|说笑|反话|并非|不是我|不是说我|不是事实|不是真的|假的|虚构|才怪|不代表|但是|不过|不再|已经不|\b(?:joke|joking|sarcasm)\b|do not (?:save|remember)|don.t (?:save|remember)/iu;
const commandOrQuestion = /[?？]|(?:吗|呢|吧)$|[你您]|帮我|替我|执行|删除|运行|命令|文件|按钮|打开|关闭|\b(?:you|execute|delete|command|powershell|sudo)\b/iu;

function singleClause(core: string): boolean {
  if (/[，,；;：:]/u.test(core) || /但|其实|然而|却|而是|只是|引用|引述|\b(?:but|however|actually|instead)\b/iu.test(core)) return false;
  const prefix = /^(?:我(?:(?:可能|也许|大概)(?:更|比较)?)?(?:(?:更|比较|最)?(?:不喜欢|喜欢|偏好)|通常|一般|经常|习惯|平时|每天|每周|需要|希望|想要)|I (?:(?:might|may) )?(?:like|dislike|prefer|need|want|usually|often)\b)/iu.exec(core);
  if (!prefix) return true; // Nickname/month-day have their own complete anchored grammar.
  const rest = core.slice(prefix[0].length).trim();
  return !!rest && !/不|没|无|非|否|喜欢|偏好|需要|希望|想要|习惯|通常|经常|我(?:是|叫)|\b(?:I|not|no|without|never|like|dislike|prefer|need|want|usually|often)\b/iu.test(rest);
}

function kindFor(core: string): UserProfileCandidate['kind'] | null {
  if (commandOrQuestion.test(core) || sensitive.test(core) || thirdParty.test(core)) return null;
  if (/^(?:我(?:可能|也许|大概)(?:更|比较)?(?:喜欢|偏好|习惯|需要).+|I (?:might|may) (?:like|prefer|need)\b.+)$/iu.test(core)) return 'pending_inference';
  if (/^(?:我(?:更|比较|最)?(?:不喜欢|喜欢|偏好).+|我(?:需要|希望|想要).+|I (?:like|dislike|prefer|need|want)\b.+)$/iu.test(core)) return 'preference';
  if (/^(?:我(?:通常|一般|经常|习惯|平时|每天|每周).+|I (?:usually|often)\b.+)$/iu.test(core)) return 'fact';
  const name = /^(?:我叫|叫我|称呼我|我的名字是|我的称呼是|call me )([\p{L}\p{N}_ -]{1,24})$/iu.exec(core);
  if (name && /\p{L}/u.test(name[1])) return 'fact';
  const birthday = /^我的生日是(0?[1-9]|1[0-2])月(0?[1-9]|[12]\d|3[01])日$/u.exec(core);
  if (birthday) {
    const month = Number(birthday[1]), day = Number(birthday[2]);
    if (day <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]) return 'fact';
  }
  return null;
}

/** Exact current-user spans only. No inferred identity, year/age, model output or historical scan. */
export function literalUserProfileCandidates(value: unknown): readonly Readonly<UserProfileCandidate>[] {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
    || ambiguousMessage.test(value) || sensitive.test(value) || thirdParty.test(value) || optOut.test(value)) return Object.freeze([]);
  const results: Readonly<UserProfileCandidate>[] = [], seen = new Set<string>();
  let positivePreference = false, negativePreference = false;
  for (const match of value.matchAll(/[^\r\n。！？.!?]+(?:[。！？.!?]|(?=\r?\n|$))/gu)) {
    const raw = match[0], quote = raw.trim();
    if (!quote) continue;
    if (quote.length > 280) return Object.freeze([]);
    const core = quote.replace(/[。.!！]$/u, '').trim(), kind = kindFor(core);
    if (!kind || !singleClause(core)) return Object.freeze([]);
    if (/^(?:我(?:更|比较|最)?不喜欢|I dislike\b)/iu.test(core)) negativePreference = true;
    if (/^(?:我(?:更|比较|最)?喜欢|I (?:like|prefer)\b)/iu.test(core)) positivePreference = true;
    if (positivePreference && negativePreference) return Object.freeze([]);
    if (seen.has(quote) || results.length === 4) continue;
    const start = match.index! + raw.indexOf(quote), end = start + quote.length;
    const candidate: UserProfileCandidate = { kind, quoteStart: start, quoteEnd: end,
      ...(kind === 'pending_inference' ? { text: quote } : {}) };
    results.push(Object.freeze(candidate)); seen.add(quote);
  }
  return Object.freeze(results);
}

/** One optional side effect of the existing ordinary reply; it never starts or rewards a chat. */
export class UserProfileReplyCollector {
  private cancelled = false;
  private finishing: Promise<UserProfileReplyOutcome> | null = null;
  private constructor(private readonly store: ProfileStorePort, private readonly requestId: string,
    private observation: string | null, private readonly candidates: readonly Readonly<UserProfileCandidate>[]) {}

  static create(input: { store: ProfileStorePort; acceptance: UserProfileAcceptance | null; requestId: string; userText: unknown }): UserProfileReplyCollector | null {
    const { store, acceptance, requestId } = input;
    if (!acceptance) return null;
    try {
      const candidates = literalUserProfileCandidates(input.userText);
      if (!/^[A-Za-z0-9_-]{1,100}$/u.test(requestId) || !candidates.length) { store.releaseAcceptance(acceptance); return null; }
      const observation = store.beginObservation(acceptance);
      return observation ? new UserProfileReplyCollector(store, requestId, observation, candidates) : null;
    } catch { store.releaseAcceptance(acceptance); return null; }
  }

  cancel(): void {
    this.cancelled = true;
    if (this.observation) { this.store.cancelObservation(this.observation); this.observation = null; }
  }

  /** Main must await that exact turn.finish(status) first. Missing/neutral fallback is unsupported. */
  finish(turn: UserProfileReplyCompletion, status: UserProfileReplyStatus): Promise<UserProfileReplyOutcome> {
    if (this.finishing) return this.finishing;
    let accepted = false;
    try { accepted = !this.cancelled && !!this.observation && status === 'complete'
      && turn.id === this.requestId && turn.profileReplyAccepted?.() === true; } catch { /* Unsupported accessor never breaks ordinary chat. */ }
    if (!accepted) { this.cancel(); return Promise.resolve({ status: 'ignored', added: 0 }); }
    const observation = this.observation!;
    this.finishing = (async () => {
      try {
        return await this.store.completeObservation(observation, this.requestId, this.candidates);
      } catch {
        // Profile persistence is separate from the already completed ordinary reply.
        return { status: 'failed' as const, added: 0 };
      } finally {
        this.store.cancelObservation(observation);
        if (this.observation === observation) this.observation = null;
      }
    })();
    return this.finishing;
  }
}
