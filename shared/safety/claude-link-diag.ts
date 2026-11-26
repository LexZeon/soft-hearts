/**
 * I-061: what the experience journal and the 「复制诊断信息」 text may say about the internal channel's link to the user's own
 * Claude Code. Closed sets only: a state name, a failure category and a version number. The text behind a failure (Claude Code's
 * own error output, which can hold paths with the user's name) is turned into a category here and never kept.
 * Why it exists: on another machine Claude Code 2.1.319 refused the registration and the cause took long to find
 * (docs/claude/2026-11-09-channel-env-arg.md); the state and the version are what a helper needs first.
 */

/** The link states worth a journal line (`idle` and `checking` are not results). */
import { ASSISTANT_CLI_NAME } from '../foundation/assistant-name';
export const LINK_RECORD_STATES = ['linked', 'registered', 'updated', 'removed', 'missing', 'failed', 'skipped', 'stale', 'unverified'] as const;
export type LinkRecordState = (typeof LINK_RECORD_STATES)[number];

/** Why a check failed, as a category. */
export const LINK_FAILURES = ['arguments', 'timeout', 'cannot-start', 'permission', 'exit-code', 'repoint', 'journal', 'name-taken', 'other'] as const;
export type LinkFailure = (typeof LINK_FAILURES)[number];

/**
 * Why a listed registration could not be read (state `unverified` only; electron/safety/agent-channel/claude-code-link.ts decides).
 * Categories and small numbers only, never the list's text. Diagnostic only: no linking decision depends on it.
 */
// 'wrapped' (X-449): the list wrapped the row and `claude mcp get` could not read it exactly; a wrapped row is never acted on.
export const LINK_UNREADABLE = ['repeated-same', 'repeated-different', 'no-status', 'not-app-line', 'cut-off', 'wrapped'] as const;
export type LinkUnreadable = (typeof LINK_UNREADABLE)[number];
export interface LinkUnreadableFacts { why: LinkUnreadable; /** how many times the name's row appears, 0..9 */ rows: number; headerRepeated: boolean }

/** A row count as stored: a whole number 0..9. */
export const smallCount = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9 ? value : null;

/** Who started the check: the app itself (startup, re-point after an update) or the panel's 「重新接上」. */
export const LINK_TRIGGERS = ['auto', 'manual'] as const;
export type LinkTrigger = (typeof LINK_TRIGGERS)[number];

const PLAIN_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** "2.1.319" out of `claude --version` ("2.1.319 (Claude Code)"); null when there is no plain version number. Nothing else is kept. */
export function claudeVersionOf(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const found = /(?<![\d.])(\d{1,3}\.\d{1,3}\.\d{1,3})(?![\d.])/.exec(text.slice(0, 400));
  return found && PLAIN_VERSION.test(found[1]) ? found[1] : null;
}

/** A value that may be stored/printed as a version: exactly three dot-separated numbers. */
export const plainVersion = (value: unknown): string | null => typeof value === 'string' && PLAIN_VERSION.test(value) ? value : null;

/**
 * The failure category of a link result. `message` is the panel's text (it ends in Claude Code's own words); only the category
 * leaves this function. Order matters: the more specific wording comes first.
 */
export function classifyLinkFailure(message: unknown): LinkFailure {
  const text = typeof message === 'string' ? message : '';
  if (/Invalid environment variable|unknown option|unexpected argument|invalid (?:option|argument)|missing required argument|too many arguments/i.test(text)) return 'arguments';
  if (/没有在时限内结束|timed? ?out|ETIMEDOUT/i.test(text)) return 'timeout';
  if (/ENOENT|EACCES.*spawn|spawn .*(?:failed|error)|not recognized as an internal|cannot find/i.test(text)) return 'cannot-start';
  if (/EACCES|EPERM|permission denied|access is denied/i.test(text)) return 'permission';
  if (/没能在配置目录里记下改动进度/.test(text)) return 'journal';
  if (/被别的登记占用|已经被占用/.test(text)) return 'name-taken';
  if (/没能把 .+ 改成这个版本|暂时没能改好|没能确认 .+ 改好了没有/.test(text)) return 'repoint';
  if (/退出码 \d+/.test(text)) return 'exit-code';
  return 'other';
}

/** The journal's own plain-language line per state (no name, no path). */
export const LINK_STATE_REASON: Readonly<Record<LinkRecordState, string>> = {
  linked: `内部通道检查了你的 ${ASSISTANT_CLI_NAME}：已经接上`,
  registered: `内部通道检查了你的 ${ASSISTANT_CLI_NAME}：刚登记上`,
  updated: `内部通道检查了你的 ${ASSISTANT_CLI_NAME}：登记已改到这个版本`,
  removed: `内部通道检查了你的 ${ASSISTANT_CLI_NAME}：登记被移除过，没有再加`,
  missing: `内部通道检查了你的 ${ASSISTANT_CLI_NAME}：没找到它`,
  failed: `内部通道没能接上你的 ${ASSISTANT_CLI_NAME}`,
  skipped: '内部通道检查被跳过（测试用配置目录）',
  stale: `内部通道检查了你的 ${ASSISTANT_CLI_NAME}：登记指向别的版本，没有改`,
  unverified: `内部通道检查了你的 ${ASSISTANT_CLI_NAME}：读不出登记指向哪里`,
};
/** The category's own words (the name's row count follows in the journal panel). */
export const LINK_UNREADABLE_WORDS: Readonly<Record<LinkUnreadable, string>> = {
  'repeated-same': '名字出现了好几次，内容一样',
  'repeated-different': '名字出现了好几次，内容不一样',
  'no-status': '这一行没读到结尾的状态',
  'not-app-line': '读到的启动命令不是本程序的',
  'cut-off': '检查被中途打断了',
  wrapped: '这一行被折成了几行，又没能单独读出来',
};

/** Failure categories in the panel's wording (plain, short, never Claude Code's own text). */
export const LINK_FAILURE_WORDS: Readonly<Record<LinkFailure, string>> = {
  arguments: `${ASSISTANT_CLI_NAME} 不认我们给它的命令参数（多半是版本变了）`,
  timeout: `${ASSISTANT_CLI_NAME} 没有在时限内回应`,
  'cannot-start': `${ASSISTANT_CLI_NAME} 没能启动`,
  permission: `没有权限运行 ${ASSISTANT_CLI_NAME} 或写它的配置`,
  'exit-code': `${ASSISTANT_CLI_NAME} 报了错就退出了`,
  repoint: '改登记到新版本时没做完',
  journal: '没能在配置目录里记下改动进度，所以没有改登记',
  'name-taken': '登记用的名字被别的登记占用了',
  other: '原因不明',
};

/**
 * The panel's wording per state, shortened and without any name or Claude Code output (the panel's own sentences are in
 * electron/safety/agent-channel/claude-code-link.ts CLAUDE_CODE_TEXT). A failure adds its category in words.
 */
export function linkExplanation(state: LinkRecordState | 'idle' | 'checking', failure?: LinkFailure): string {
  switch (state) {
    case 'idle': return `三方互通或内部通道关着，不会自动接上你的 ${ASSISTANT_CLI_NAME}。`;
    case 'checking': return `正在检查你的 ${ASSISTANT_CLI_NAME}。`;
    case 'skipped': return `这是测试用的配置目录，不会自动接上你的 ${ASSISTANT_CLI_NAME}。`;
    case 'missing': return `没找到你的 ${ASSISTANT_CLI_NAME}。`;
    case 'linked': return `已接上你的 ${ASSISTANT_CLI_NAME}。`;
    case 'registered': return `已接上你的 ${ASSISTANT_CLI_NAME}：刚把本版本加了进去。`;
    case 'updated': return `已接上你的 ${ASSISTANT_CLI_NAME}：登记原来指向别的版本，刚改成了这个版本。`;
    case 'removed': return `你的 ${ASSISTANT_CLI_NAME} 里现在没有本版本的登记（以前自动接上过，可能被移除），所以没有再加。`;
    case 'stale': return `你的 ${ASSISTANT_CLI_NAME} 里的登记指向的不是这个版本，没有改。`;
    case 'unverified': return `你的 ${ASSISTANT_CLI_NAME} 里有登记，但没能读出它指向哪个程序。`;
    case 'failed': return `没能自动接上你的 ${ASSISTANT_CLI_NAME}：${LINK_FAILURE_WORDS[failure ?? 'other']}。`;
  }
}
