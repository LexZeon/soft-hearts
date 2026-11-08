// Shared by the main process and both windows: what "chat is not available" looks like on the wire, and the
// plain-language copy for it. Nothing here runs a command or touches a file.
import { CLAUDE_FAILURE_KINDS, type ClaudeFailureKind } from './claude-failure';
import { t, currentUiLanguage } from './ui-language';

export type ChatFailureKind = ClaudeFailureKind;
/** The six failure kinds, plus the line she says when chat comes back. */
export const OUTAGE_LINE_KINDS = [...CLAUDE_FAILURE_KINDS, 'recovered'] as const;
export type OutageLineKind = (typeof OUTAGE_LINE_KINDS)[number];

/**
 * Travels on the failed chat's `error` stream event. `speak` is false for a repeat of a failure she already
 * announced (until chat recovers); `line` is her own words from the active card's cache, or null when there is
 * none yet (the window then uses the generic gentle sentence for `kind`).
 */
export interface ChatOutageNotice { kind: ChatFailureKind; speak: boolean; line: string | null }

export interface ChatAvailabilityView {
  state: 'ok' | 'unavailable';
  kind?: ChatFailureKind;
  /** Epoch ms of the first failure of this outage. */
  since?: number;
  /** Epoch ms the limit is expected to lift, only when the failure text said so. */
  resumeAt?: number;
  /** A retry is running. */
  checking: boolean;
  /** Present for one update after chat came back: her "recovered" line (null when none is cached). */
  recovered?: { line: string | null };
}

/** The only repair actions the control window may ask for. Each takes no argument. */
export type ChatAvailabilityAction = 'retry' | 'help' | 'network-settings';
export const CHAT_AVAILABILITY_ACTIONS: readonly ChatAvailabilityAction[] = ['retry', 'help', 'network-settings'];

export function actionsFor(kind: ChatFailureKind): ChatAvailabilityAction[] {
  if (kind === 'login-expired' || kind === 'not-found' || kind === 'certificate') return ['retry', 'help'];
  if (kind === 'network') return ['retry', 'network-settings'];
  return ['retry'];
}

/** Which of the two fixed guide pages "help" opens for a failure kind: install and sign-in, or proxy and certificates. */
export function helpTopicFor(kind: ChatFailureKind | undefined): 'setup' | 'network-config' {
  return kind === 'certificate' ? 'network-config' : 'setup';
}

export function actionLabel(action: ChatAvailabilityAction, kind?: ChatFailureKind): string {
  if (action === 'retry') return t('重试');
  if (action === 'network-settings') return t('打开系统网络设置');
  return t(kind === 'certificate' ? '查看公司代理和证书的说明' : '查看 Claude Code 安装与登录说明');
}

const tr = (source: string, ...values: unknown[]) => t(source, Object.fromEntries(values.map((value, index) => [String(index), String(value)])));

// ---- her words ------------------------------------------------------------------------------------

/** Gentle sentences for when no card-specific line is cached yet. Character-neutral on purpose. */
const GENERIC_LINES: Record<OutageLineKind, string> = {
  'login-expired': '我好像认不出自己的登录了……可以去设置里帮我看一眼吗？',
  quota: '我今天说得有点多，要先歇一会儿啦。',
  network: '好像连不上网了……等网络好了，我再陪你说话。',
  certificate: '网络好像被什么拦住了，连不上安全的连接……可以去设置里看看说明吗？',
  'not-found': '我现在没办法好好思考……可以去设置里帮我看一眼吗？',
  'rate-limited': '我有点转不过来了，让我缓一小会儿，好吗？',
  other: '刚才好像出了点小问题，没能回答你……再试一次好吗？',
  recovered: '我回来啦。',
};
export function genericOutageLine(kind: OutageLineKind): string {
  return t(GENERIC_LINES[kind] ?? GENERIC_LINES.other);
}

const LINE_LIMIT = 200;
/**
 * What the chat window shows in place of a technical error. null: this is not an outage failure, use the
 * ordinary path. '': a repeat of something she already said, show nothing new.
 */
export function outageDisplayText(notice: unknown): string | null {
  if (!notice || typeof notice !== 'object') return null;
  const { kind, speak, line } = notice as Partial<ChatOutageNotice>;
  if (typeof kind !== 'string' || !(CLAUDE_FAILURE_KINDS as readonly string[]).includes(kind)) return null;
  if (speak !== true) return '';
  return typeof line === 'string' && line.trim() && line.length <= LINE_LIMIT ? line.trim() : genericOutageLine(kind as OutageLineKind);
}

// ---- the control window's plain-language status -----------------------------------------------------

function dayKey(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
/** "13:20", "明天 13:20" or "11月5日 15:00", in the machine's own zone unless one is given. */
export function formatResumeTime(resumeAt: number, now: number, timeZone?: string): string {
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(resumeAt));
  if (dayKey(resumeAt, timeZone) === dayKey(now, timeZone)) return clock;
  if (dayKey(resumeAt, timeZone) === dayKey(now + 86_400_000, timeZone)) return tr('明天 {0}', clock);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, month: 'numeric', day: 'numeric' }).formatToParts(new Date(resumeAt));
  const month = parts.find(part => part.type === 'month')?.value ?? '', day = parts.find(part => part.type === 'day')?.value ?? '';
  const date = currentUiLanguage() === 'en'
    ? new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(new Date(resumeAt))
    : `${month}月${day}日`;
  return `${date} ${clock}`;
}

export interface OutageDescription { reason: string; hint: string; actions: ChatAvailabilityAction[] }
export function describeOutage(view: Pick<ChatAvailabilityView, 'kind' | 'resumeAt'>, now = Date.now(), timeZone?: string): OutageDescription {
  const kind = view.kind ?? 'other';
  const eta = view.resumeAt === undefined ? null
    : view.resumeAt > now ? tr('预计 {0} 恢复。', formatResumeTime(view.resumeAt, now, timeZone))
    : t('已经过了预计的恢复时间，可以点「重试」。');
  const actions = actionsFor(kind);
  switch (kind) {
    case 'login-expired':
      return { reason: t('Claude Code 的登录过期了'), hint: t('需要重新登录一次：看一下说明，在终端运行 claude 完成登录，然后点「重试」。'), actions };
    case 'quota':
      return { reason: t('Claude 的使用额度暂时用完了'), hint: eta ?? t('没有读到恢复时间，额度刷新后点「重试」就行。'), actions };
    case 'network':
      return { reason: t('连不上 Claude，网络可能断开了'), hint: t('网络恢复后点「重试」。'), actions };
    case 'certificate':
      return { reason: t('网络是通的，但安全连接被拦住了（常见于公司代理或杀毒软件的网络扫描）'), hint: t('这不是断网，重试多半没用。看一下说明里“公司代理和证书”一节，让网络管理员或安全软件放行后，再点「重试」。'), actions };
    case 'not-found':
      return { reason: t('找不到 Claude Code'), hint: t('请先安装官方 Claude Code 并登录，然后点「重试」。'), actions };
    case 'rate-limited':
      return { reason: t('Claude 现在有点忙（请求太密或服务繁忙）'), hint: eta ?? t('过一小会儿再点「重试」。'), actions };
    default:
      return { reason: t('这次没能得到 Claude 的回复，原因没认出来'), hint: t('可以点「重试」。如果一直这样，打开开发者模式可以看到详情。'), actions };
  }
}
