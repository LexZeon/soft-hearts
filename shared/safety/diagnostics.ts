/**
 * I-061 「复制诊断信息」: the short plain-text block a user can paste to their own Claude or into a GitHub issue.
 *
 * THE BOUNDARY (tests/i061-diagnostics.test.ts feeds it hostile input): every value is checked against a closed set or a strict
 * pattern before it is printed, and journal lines are read field by field from closed sets, so an unexpected field (a chat
 * sentence, a path, a key, a model name) is never looked at. Never printed: chat, character cards, profile or diary text, file paths,
 * keys or tokens, the channel's endpoint or token, an email address, character ids or names. A last pass removes anything that
 * still looks like a path, an address or a long token, in case a future change lets one through. Nothing here sends anything.
 */
import { LINK_FAILURES, LINK_RECORD_STATES, linkExplanation, plainVersion, type LinkFailure, type LinkRecordState } from './claude-link-diag';
import { INTERNAL_WORD_RULES } from '../brain';
import { SPEECH_FAILURES, VOICE_INPUT_FAILURES } from '../voice';
import { ASSISTANT_CLI_NAME } from '../foundation/assistant-name';

export const DIAGNOSTIC_CHANNELS = ['stable', 'dev', 'source'] as const;
export type DiagnosticChannel = (typeof DIAGNOSTIC_CHANNELS)[number];
const OS_ARCHES = ['x64', 'arm64', 'ia32', 'arm'] as const;
/** How many recent problems the block lists. */
export const DIAGNOSTIC_PROBLEMS = 5;
/** A first-char time above this is listed as a problem (the morning check's own limit, scripts/experience/daily-check.mjs). */
export const DIAGNOSTIC_SLOW_FIRST_CHAR_MS = 2500;

export interface DiagnosticsInput {
  app: { version: unknown; commit: unknown; channel: unknown };
  os: { platform: unknown; release: unknown; arch: unknown };
  /** From `claude --version` (shared/safety/claude-link-diag.ts claudeVersionOf); anything else prints as unknown. */
  claudeCodeVersion: unknown;
  /** 三方互通 and the channel itself. */
  interconnect: unknown;
  channelOpen: unknown;
  /** The last link check of this run: its state, failure category and time; null when none ran yet. */
  link: { state: unknown; failure?: unknown; checkedAt?: unknown } | null;
  /** AppSettings.experienceJournal. */
  journalEnabled: unknown;
  /** Recent journal entries, oldest first (JournalEntry objects, or anything: only closed fields are read). */
  entries: readonly unknown[];
  /** Overhaul step 7: the units switched off alone, `<part>/<unit>` (closed words; anything else is dropped). Absent or empty: no line. */
  partsOff?: readonly unknown[];
}

const has = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

/** "2026-11-10 07:30" in the computer's own time. */
export function diagnosticTime(at: unknown): string {
  if (!finite(at) || at < 0 || at > 8.64e15) return 'unknown time';
  const d = new Date(at), two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function osLine(os: DiagnosticsInput['os']): string {
  const release = typeof os.release === 'string' && /^\d{1,5}(?:\.\d{1,6}){0,3}$/.test(os.release) ? os.release : null;
  const arch = has(OS_ARCHES, os.arch) ? os.arch : 'unknown arch';
  if (os.platform === 'win32') {
    const build = release ? Number(release.split('.')[2]) : NaN;
    return `${Number.isFinite(build) && build >= 22000 ? 'Windows 11' : 'Windows'} ${release ?? 'unknown version'}, ${arch}`;
  }
  const name = os.platform === 'darwin' ? 'macOS (Darwin)' : os.platform === 'linux' ? 'Linux' : 'unknown OS';
  return `${name} ${release ?? 'unknown version'}, ${arch}`;
}

/** What one journal entry says is a problem, as a category label; null when it is not one. Reads closed fields only. */
export function problemLabel(entry: unknown): string | null {
  const e = record(entry);
  switch (e.type) {
    case 'speech': return has(SPEECH_FAILURES, e.failure) ? `speech: ${e.failure}` : 'speech: other';
    case 'voice-input': return has(VOICE_INPUT_FAILURES, e.failure) ? `voice-input: ${e.failure}` : 'voice-input: other';
    case 'audio-reading': return has(VOICE_INPUT_FAILURES, e.failure) ? `audio-reading: ${e.failure}` : 'audio-reading: other';
    case 'reply-check': {
      const residue = Array.isArray(e.residue) ? e.residue.filter(item => has(INTERNAL_WORD_RULES, item)) : [];
      return residue.length ? 'reply-check residue' : null;
    }
    case 'draft-filter': return e.whole === true ? 'draft-filter: whole reply removed' : null;
    case 'first-char': return finite(e.ms) && e.ms > DIAGNOSTIC_SLOW_FIRST_CHAR_MS && e.ms <= 600_000 ? `first-char ${(e.ms / 1000).toFixed(1)} s` : null;
    case 'claude-link': {
      if (e.state === 'failed') return `claude-link: failed (${has(LINK_FAILURES, e.failure) ? e.failure : 'other'})`;
      return e.state === 'missing' ? 'claude-link: missing' : null;
    }
    case 'motion': return e.kind === 'block' ? 'motion: color block' : null;
    case 'app': return e.event === 'start' && e.stopped === 'unclean' ? 'app: previous run did not end cleanly' : null;
    case 'pause-stuck': return 'pause-stuck';
    case 'reading-time': return e.result === 'unread' && e.why === 'failed' ? 'reading: failed' : null;
    case 'truncated': return 'journal: day limit reached';
    default: return null;
  }
}

/** The newest problems, newest last, each with its time. */
export function recentProblems(entries: readonly unknown[], limit = DIAGNOSTIC_PROBLEMS): { at: unknown; label: string }[] {
  const found: { at: unknown; label: string }[] = [];
  for (const entry of entries) {
    const label = problemLabel(entry);
    if (label) found.push({ at: record(entry).at, label });
  }
  return found.slice(-limit);
}

/** Last pass: an absolute path, an address, an email or a long token-like run never survives, whatever put it there. */
export function scrubDiagnostics(text: string): string {
  return text
    .replace(/[A-Za-z]:[\\/][^\s,;)]*/g, '[path]')
    .replace(/\\\\[^\s,;)]+/g, '[path]')
    .replace(/(?:\/(?:Users|home|var|tmp|etc|mnt|opt)\/[^\s,;)]*)/g, '[path]')
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[email]')
    .replace(/\b(?:https?|wss?):\/\/[^\s,;)]+/gi, '[address]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[token]');
}

export function formatDiagnostics(input: DiagnosticsInput): string {
  const app = record(input.app), link = input.link ? record(input.link) : null;
  const version = typeof app.version === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][0-9A-Za-z.]{1,24})?$/.test(app.version) ? app.version : 'unknown';
  const commit = typeof app.commit === 'string' && /^[0-9a-f]{7,40}$/.test(app.commit) ? app.commit.slice(0, 12) : 'unknown';
  const channel = has(DIAGNOSTIC_CHANNELS, app.channel) ? app.channel : 'unknown';
  const claude = plainVersion(input.claudeCodeVersion) ?? 'unknown';
  const lines = [
    'soft hearts diagnostics',
    `app: ${version} (commit ${commit}), channel ${channel}`,
    `system: ${osLine(record(input.os) as DiagnosticsInput['os'])}`,
    `${ASSISTANT_CLI_NAME}: ${claude}`,
    `internal channel: 三方互通 ${input.interconnect === true ? 'on' : 'off'}, channel ${input.channelOpen === true ? 'open' : 'closed'}`,
  ];
  if (link && has(LINK_RECORD_STATES, link.state)) {
    const state: LinkRecordState = link.state;
    const failure: LinkFailure | undefined = state === 'failed' ? (has(LINK_FAILURES, link.failure) ? link.failure : 'other') : undefined;
    lines.push(`link state: ${state}${failure ? ` (${failure})` : ''}`, `link meaning: ${linkExplanation(state, failure)}`, `link last checked: ${diagnosticTime(link.checkedAt)}`);
  } else lines.push('link state: not checked in this run', `link meaning: ${linkExplanation('idle')}`);
  if (input.journalEnabled !== true) lines.push('recent problems: the experience log is off, so none are listed');
  else {
    const problems = recentProblems(input.entries);
    lines.push(problems.length ? `recent problems (last ${problems.length}, oldest first):` : 'recent problems: none in the recent log');
    for (const problem of problems) lines.push(`- ${diagnosticTime(problem.at)} ${problem.label}`);
  }
  const partsOff = (input.partsOff ?? []).filter((item): item is string => typeof item === 'string' && /^[a-z][a-z-]{0,39}\/[a-z][a-z0-9-]{0,39}$/.test(item));
  if (partsOff.length) lines.push(`parts switched off alone: ${partsOff.slice(0, 20).join(', ')}`);
  lines.push('Not included: chat, character cards, diary, file paths, keys, addresses.');
  return scrubDiagnostics(lines.join('\n'));
}
