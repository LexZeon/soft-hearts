// I-014: with 三方互通 on and the channel open, the app connects
// itself to the user's own Claude Code once. It asks `claude mcp list` whether this edition's server name is there and,
// if not, runs the same `claude mcp add --transport stdio --scope user …` the panel shows for copying. A name this
// profile registered before and the user later removed is never added back by itself (the panel's 「重新接上」 does it).
// A failure is only reported; nothing else in the app depends on it.
//
// Re-pointing (2026-11-03): every stable update installs into a new versioned folder, so a name this profile registered
// keeps pointing at the version that registered it. When the list shows this profile's own registration pointing at
// another program, it is moved to this version without ever leaving the user with nothing registered: the new launch is
// added first under a spare name (`<name>-update`), then the old entry is removed, the new one added under the real name,
// and the spare removed. A write-ahead mark in the profile (`journal`) lets the next start finish or clean up a re-point
// that was cut off. A same-named entry this app did not register is never changed by itself (the panel says so and
// 「重新接上」 does it); an entry whose launch line cannot be read is never changed by itself either.
//
// Codex T-112 round 033 (2026-11-03): "ours" is a fingerprint, not a name: one of this app's launch lines whose
// `--profile` is this profile's folder (ownLaunchLine). A same-named entry for another profile, or a spare name the user
// reused, is someone else's: reported, never removed or changed. The spare of a pending re-point is removed only once
// the real name is known to be this launch (a successful add, or a fresh list showing it); while the old entry cannot be
// removed, the real name cannot be added or is taken, or cannot be read, the spare and the mark stay.
//
// Claude Code specific (docs/claude/brain-interface.md): the command lines and the list format live here only.
// Only the two real desktop profiles do this; test profiles (smoke, pretrial, unit tests) never touch the user's
// Claude Code configuration. No Electron import: tests pass a fake `claude`.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentClaudeCodeLink } from '../../../shared/safety/agent-channel';
import type { LinkUnreadable, LinkUnreadableFacts } from '../../../shared/safety/claude-link-diag';
import { registrationArguments, type ShimLaunch } from './setup-text';
import { ASSISTANT_CLI_NAME } from '../../../shared/foundation/assistant-name';

export interface ClaudeRun { code: number | null; stdout: string; stderr: string; error?: string }
/** Runs `claude <args>`; never a shell. */
export type ClaudeCodeRunner = (args: readonly string[], timeoutMs: number) => Promise<ClaudeRun>;

export interface ClaudeCodeLinkOptions {
  name: string;
  launch: ShimLaunch;
  /** null: Claude Code was not found (scripts/claude-discovery.mjs). */
  runner: ClaudeCodeRunner | null;
  /** False for anything but the user's two real desktop profiles (see autoLinkAllowed). */
  allowed: boolean;
  /** Registered by this profile before (InterconnectStore.autoRegistered; the host records a new `registered`/`updated`). */
  registeredBefore: boolean;
  /** 「重新接上」: add it even though the user removed it before; point a same-named entry at this version. */
  force?: boolean;
  timeoutMs?: number;
  /** A re-point of this name was started and not finished (InterconnectStore.repointing). */
  repointPending?: boolean;
  /**
   * Write-ahead mark of a re-point: true before its first change, false once nothing is left over. Resolves false when it
   * could not be written; a re-point then does not start. Without it the app never re-points (as before).
   */
  journal?(pending: boolean): Promise<boolean>;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const plain = (text: string) => text.replace(ANSI, '');

/** Whether `claude mcp list` output names this server; null when the output is not a list at all. */
export function listedInClaudeCode(stdout: string, name: string): boolean | null {
  const text = plain(stdout);
  const lines = text.split(/\r?\n/u).map(line => line.trim());
  if (lines.some(line => line.startsWith(`${name}:`))) return true;
  if (/no mcp servers configured/i.test(text)) return false;
  // Every other server is listed as "<name>: <command or url> - <status>" (✓ Connected, ✗ Failed to connect, ⚠ Needs …);
  // an error message ("error: unknown command") is not a list.
  const listLine = /^[A-Za-z0-9_.-]+: .+ - (?:[✓✗⚠!]|connected|failed|needs|pending)/i;
  return lines.some(line => listLine.test(line)) || /checking mcp server health/i.test(text) ? false : null;
}

/** One server in `claude mcp list`: absent, or listed with its launch line (null when it could not be read). */
export type ClaudeCodeEntry = { listed: false } | { listed: true; command: string | null };

// Claude Code 2.1.316 prints a stdio server as `${name}: ${command} ${args.join(" ")} - ${status}`, the status being
// "✓ Connected", "! Needs authentication", "- Not configured", "✗ Failed to connect — <issue>", "⏸ Pending approval …",
// "⊘ Disabled …". Arguments are not quoted, so paths keep their spaces; a path may itself hold " - " ("OneDrive - 公司"),
// so the status is the last " - " followed by a status mark. The list is drawn by Ink, which may wrap a long row.
//
// Codex X-449 (C238, 2026-11-12): white space inside a path is part of its identity ("合成 Gene" and "合成Gene" are two folders).
// A wrapped row is joined with WRAP where Ink broke it, and only there may white space be missing or extra. A wrapped row is
// good enough to say "this is linked", never to change or remove a registration: that waits for `claude mcp get`.
const WRAP = '\n';
const STATUS = /^([\s\S]+)\s-\s(?:[✓✔✗✘×⚠!⏸⊘-]\s|(?:connected|failed|needs|pending|disabled|rejected|connection error)\b)/iu;
const SERVER_LINE = /^[A-Za-z0-9_.-]+: /u;

/** The launch line of the row that starts at `start` (null when its status mark never shows up). */
function rowCommand(lines: readonly string[], start: number, name: string): string | null {
  let row = lines[start].slice(name.length + 1);
  for (let index = start + 1; !STATUS.test(row) && index < lines.length && index <= start + 12; index++) {
    // A wrapped row continues on the next lines; another server's row or an empty line ends it.
    if (!lines[index] || SERVER_LINE.test(lines[index])) break;
    row += `${WRAP}${lines[index]}`;
  }
  const match = STATUS.exec(row.trim());
  return match?.[1].trim() || null;
}
const listLines = (stdout: string) => plain(stdout).split(/\r?\n/u).map(line => line.trim());
const rowStarts = (lines: readonly string[], name: string) => lines.flatMap((line, index) => line.startsWith(`${name}:`) ? [index] : []);

export function claudeCodeEntry(stdout: string, name: string): ClaudeCodeEntry | null {
  const listed = listedInClaudeCode(stdout, name);
  if (listed === null) return null;
  if (!listed) return { listed: false };
  const lines = listLines(stdout), starts = rowStarts(lines, name);
  // Twice (another scope, or a format this does not know): which one is in effect cannot be told.
  if (starts.length !== 1) return { listed: true, command: null };
  return { listed: true, command: rowCommand(lines, starts[0], name) };
}

/**
 * `claude mcp get <name>` (2.1.316) prints one server as fixed lines: "  Scope: User config (available in all your projects)",
 * "  Status: …", "  Type: stdio", "  Command: <program>", "  Args: <arguments joined by one space>". The launch line is
 * Command + Args, the same text the list shows before its status, but nothing here depends on how the list was drawn or wrapped,
 * and when the name is in more than one scope it tells the one in effect. Only a user-scope stdio entry is read: that is the one
 * `claude mcp add/remove --scope user` changes. null for anything else (not found, another scope, another type).
 */
export function claudeCodeGetCommand(stdout: string): string | null {
  const lines = plain(stdout).split(/\r?\n/u);
  const field = (label: string) => lines.filter(line => line.startsWith(`  ${label}:`)).map(line => line.slice(label.length + 3).trim());
  const [scope, type, command, args] = [field('Scope'), field('Type'), field('Command'), field('Args')];
  if (scope.length !== 1 || type.length !== 1 || command.length !== 1 || args.length > 1) return null;
  if (!/^user\b/i.test(scope[0]) || type[0].toLowerCase() !== 'stdio' || !command[0]) return null;
  return [command[0], args[0] ?? ''].join(' ').trim();
}

/** Case, slash direction and quotes do not matter; white space does (it is part of a folder's name). */
const normal = (text: string) => text.replace(/"/g, '').replace(/\\/g, '/').toLowerCase();
const identity = (text: string) => normal(text).trim();
const escape = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&');
/**
 * A pattern for `target` as a listed row may show it: Ink may have broken the row between any two characters (a WRAP there), and
 * the white space at a break is gone. Everywhere else the text must be exact.
 */
function wrapPattern(target: string): string {
  const parts = normal(target).match(/\s+|\S/gu) ?? [];
  return parts.map(part => /^\s/u.test(part) ? `(?:${escape(part)}|\\n)` : escape(part)).join('\\n?');
}
/** A listed launch line joined from a wrapped row: only a read-only verdict may rest on it. */
export const wrappedLine = (command: string) => command.includes(WRAP);
/**
 * Diagnostic only (2026-11-12): why a listed row ended up `unverified`, as a category and two small numbers; no text is kept and
 * no decision uses it. `cut`: the list run timed out or exited non-zero yet named the server.
 */
export function unreadableFacts(stdout: string, name: string, cut: boolean): LinkUnreadableFacts {
  const lines = listLines(stdout), starts = rowStarts(lines, name);
  const rows = Math.min(starts.length, 9), headerRepeated = (plain(stdout).match(/checking mcp server health/gi) ?? []).length > 1;
  const commands = starts.map(start => rowCommand(lines, start, name));
  let why: LinkUnreadable;
  if (cut) why = 'cut-off';
  else if (starts.length >= 2) why = new Set(commands.filter((c): c is string => c !== null).map(identity)).size <= 1 ? 'repeated-same' : 'repeated-different';
  else if (commands[0] == null) why = 'no-status';
  else if (wrappedLine(commands[0]) && appLaunchLine(commands[0])) why = 'wrapped';
  else why = 'not-app-line';
  return { why, rows, headerRepeated };
}
/** The listed launch line is this launch. */
export function sameLaunch(command: string, launch: ShimLaunch): boolean {
  return new RegExp(`^${wrapPattern([launch.command, ...launch.args].join(' '))}$`, 'u').test(identity(command));
}
/** The listed launch line is one of this app's (`<program> <…/soft-hearts-mcp.mjs> --profile <folder>`), of any version. */
export function appLaunchLine(command: string): boolean {
  return new RegExp(`${wrapPattern('soft-hearts-mcp.mjs --profile ')}\\n?\\S`, 'u').test(identity(command));
}
/**
 * The fingerprint of this profile's own registration: one of this app's launch lines (any version) whose `--profile` is
 * this launch's profile folder. Another profile's line, the user's wrapper or any other program is not ours.
 */
export function ownLaunchLine(command: string, launch: ShimLaunch): boolean {
  const at = launch.args.indexOf('--profile'), profile = at >= 0 ? launch.args[at + 1] : undefined;
  return !!profile && appLaunchLine(command) && new RegExp(`${wrapPattern(`soft-hearts-mcp.mjs --profile ${profile}`)}$`, 'u').test(identity(command));
}
/** The spare name a re-point adds the new launch under first. */
export const spareName = (name: string) => `${name}-update`;

function reason(run: ClaudeRun): string {
  const text = plain(`${run.error ?? ''} ${run.stderr || run.stdout}`).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (text || (run.code === null ? '没有在时限内结束' : `退出码 ${run.code}`)).slice(0, 140);
}
const thrown = (error: unknown) => error instanceof Error ? error.message.slice(0, 140) : '未知错误';

export const CLAUDE_CODE_TEXT = Object.freeze({
  idle: `三方互通或内部通道关着，不会自动接上你的 ${ASSISTANT_CLI_NAME}。`,
  checking: `正在检查你的 ${ASSISTANT_CLI_NAME}…`,
  skipped: `这是测试用的配置目录，不会自动接上你的 ${ASSISTANT_CLI_NAME}。`,
  missing: `没找到你的 ${ASSISTANT_CLI_NAME}。装好并登录后重新打开 soft hearts，或者复制下面的命令自己运行一次。`,
  linked: (name: string) => `已接上你的 ${ASSISTANT_CLI_NAME}（${name}）。`,
  registered: (name: string) => `已接上你的 ${ASSISTANT_CLI_NAME}：刚把 ${name} 加了进去，新开的 ${ASSISTANT_CLI_NAME} 会话里就能用。`,
  removed: (name: string) => `你的 ${ASSISTANT_CLI_NAME} 里现在没有 ${name}（以前自动接上过，可能是你移除了），所以没有再加。需要时点「重新接上」。`,
  failed: (why: string) => `没能自动接上你的 ${ASSISTANT_CLI_NAME}（${why}）。可以复制下面的命令自己运行一次。`,
  updated: (name: string) => `已接上你的 ${ASSISTANT_CLI_NAME}：${name} 原来指向别的版本，刚改成了这个版本，新开的 ${ASSISTANT_CLI_NAME} 会话里就能用。`,
  updatedLeftover: (name: string, spare: string) => `已接上你的 ${ASSISTANT_CLI_NAME}：${name} 刚改成了这个版本；多出来的临时登记 ${spare} 没能删掉，下次打开 soft hearts 会再清理。`,
  stale: (name: string) => `你的 ${ASSISTANT_CLI_NAME} 里的 ${name} 指向的不是这个版本。它不是自动登记的，所以没有改；要改成这个版本，点「重新接上」。`,
  unverified: (name: string) => `你的 ${ASSISTANT_CLI_NAME} 里有 ${name}，但没能读出它指向哪个程序，没有核对是不是这个版本。用不了时点「重新接上」。`,
  keptOld: (name: string, why: string) => `没能把 ${name} 改成这个版本（${why}）。原来的登记没动，原来的程序还在时照样能用；可以点「重新接上」再试。`,
  temporary: (name: string, spare: string, why: string) => `${name} 暂时没能改好（${why}），现在先用临时名字 ${spare} 接着这个版本。下次打开 soft hearts 会自动改回 ${name}，也可以点「重新接上」。`,
  uncertain: (name: string, why: string) => `没能确认 ${name} 改好了没有（${why}）。下次打开 soft hearts 会自动再检查一次；用不了时点「重新接上」。`,
  unjournaled: (name: string) => `没能在配置目录里记下改动进度，为了不弄丢登记，这次没有改 ${name}。可以点「重新接上」再试。`,
  spareTaken: (name: string, spare: string) => `你的 ${ASSISTANT_CLI_NAME} 里的 ${name} 指向的不是这个版本；要用来过渡的名字 ${spare} 已经被占用（不是自动加的），所以没有改。`,
  otherProfile: (name: string) => `你的 ${ASSISTANT_CLI_NAME} 里的 ${name} 指向另一个配置目录里的 soft hearts，不是这个配置自动登记的，所以没有改；要改成这个版本，点「重新接上」。`,
  keptBoth: (name: string, spare: string, why: string) => `没能把 ${name} 改成这个版本（${why}），原来的 ${name} 没动；现在先用临时名字 ${spare} 接着这个版本。下次打开 soft hearts 会再试，也可以点「重新接上」。`,
  nameTaken: (name: string, spare: string) => `${name} 刚被别的登记占用了（不是这个配置自动登记的），没有动它；现在先用临时名字 ${spare} 接着这个版本。要改回 ${name}，点「重新接上」。`,
  /** Appended while a spare of ours is kept because the real name is not (known to be) this version. */
  spareKept: (spare: string, current: boolean) => current ? `临时名字 ${spare} 指向这个版本，先留着它，这期间照样能用。` : `以前改到一半留下的临时名字 ${spare} 先留着。`,
});

/** A command that exited with an error code changed nothing; one that timed out or could not start may have. */
const clean = (run: ClaudeRun) => run.code !== null && run.code !== 0;

export async function linkClaudeCode(options: ClaudeCodeLinkOptions): Promise<AgentClaudeCodeLink> {
  const { name, launch } = options, timeoutMs = options.timeoutMs ?? 60_000, spare = spareName(name);
  const view = (state: AgentClaudeCodeLink['state'], message: string): AgentClaudeCodeLink => ({ state, name, message });
  if (!options.allowed) return view('skipped', CLAUDE_CODE_TEXT.skipped);
  if (!options.runner) return view('missing', CLAUDE_CODE_TEXT.missing);
  const runner = options.runner;
  /** Never throws: a runner that throws is a command whose outcome is unknown. */
  const run = (args: readonly string[]): Promise<ClaudeRun> => runner(args, timeoutMs)
    .catch(error => ({ code: null, stdout: '', stderr: '', error: thrown(error) }));
  const add = (target: string) => run(registrationArguments(launch, target));
  const remove = (target: string) => run(['mcp', 'remove', target, '--scope', 'user']);
  const exists = (result: ClaudeRun) => /already exists/i.test(plain(`${result.stderr}\n${result.stdout}`));
  const journal = async (value: boolean) => { try { return await options.journal!(value); } catch { return false; } };

  /**
   * A listed row whose launch line the list text did not give (drawn another way, wrapped, listed twice): the same name read with
   * `claude mcp get`, one more read-only command. Anything it cannot read leaves the row unreadable, as before. `needExact`
   * (X-449): a wrapped row is read that way too, before anything is changed on its strength.
   */
  const settled = async (found: ClaudeCodeEntry, target: string, needExact = false): Promise<ClaudeCodeEntry> => {
    if (!found.listed || (found.command !== null && !(needExact && wrappedLine(found.command)))) return found;
    const got = await run(['mcp', 'get', target]);
    const command = got.code === 0 ? claudeCodeGetCommand(got.stdout) : null;
    return command ? { listed: true, command } : found;
  };
  const pending = options.repointPending === true && !!options.journal;
  let entry: ClaudeCodeEntry, spareEntry: ClaudeCodeEntry, listText = '';
  const list = await run(['mcp', 'list']);
  {
    const text = `${list.stdout}\n${list.stderr}`, found = claudeCodeEntry(text, name);
    if (found === null || (list.code !== 0 && !found.listed)) return view('failed', CLAUDE_CODE_TEXT.failed(reason(list)));
    const spareFound = claudeCodeEntry(text, spare) ?? { listed: false };
    entry = list.code === 0 ? await settled(found, name) : found; listText = text;
    // The spare of a pending re-point may be removed: read it exactly.
    spareEntry = list.code === 0 ? await settled(spareFound, spare, pending) : spareFound;
  }
  /** Read exactly: from `claude mcp get`, or a list row that was not wrapped. */
  const exact = (found: ClaudeCodeEntry | null): found is { listed: true; command: string } =>
    !!found?.listed && found.command !== null && !wrappedLine(found.command);
  // "This launch" may rest on a wrapped row (it only ever leads to "linked"); "ours", which can lead to a change, may not.
  const current = (found: ClaudeCodeEntry | null) => !!found?.listed && found.command !== null && sameLaunch(found.command, launch);
  const mine = (found: ClaudeCodeEntry | null) => exact(found) && ownLaunchLine(found.command, launch);
  // The spare is ours only while a re-point of ours is pending and it carries this profile's fingerprint (any version);
  // a spare name the user reused, or one that cannot be read, is never removed.
  let spareOurs = pending && mine(spareEntry), spareCurrent = spareOurs && current(spareEntry);
  // Codex X-451: a spare that is listed but could not be read exactly (wrapped and `mcp get` failed, or no launch line) is not
  // known to be someone else's either. While a re-point is pending it is never removed, and the mark stays, so the next start
  // reads it again instead of forgetting a spare that may be ours.
  const spareUnknown = pending && spareEntry.listed && !exact(spareEntry);
  /** A fresh list shows the real name as this launch ("already exists" alone does not say whose it is). */
  const confirmed = async () => {
    const again = await run(['mcp', 'list']);
    if (again.code !== 0) return false;
    const found = await settled(claudeCodeEntry(`${again.stdout}\n${again.stderr}`, name) ?? { listed: false }, name, true);
    return exact(found) && current(found);
  };
  /** The spare is kept, so is the mark: what the panel says about it. */
  const keep = (why: string) => spareCurrent ? CLAUDE_CODE_TEXT.temporary(name, spare, why) : CLAUDE_CODE_TEXT.uncertain(name, why);

  /** Only once the real name is this version: our spare goes (someone else's never), then the mark. */
  const tidy = async (done: AgentClaudeCodeLink): Promise<AgentClaudeCodeLink> => {
    if (spareOurs && (await remove(spare)).code !== 0) return view(done.state, CLAUDE_CODE_TEXT.updatedLeftover(name, spare));
    if (spareUnknown) return done; // the mark stays: the spare is read again next start
    await journal(false);
    return done;
  };
  /** The real name was just added: done. "Already exists": done only if a fresh list shows this launch under it. */
  const settle = async (added: ClaudeRun): Promise<AgentClaudeCodeLink> => {
    if (added.code === 0 || (exists(added) && await confirmed())) return tidy(view('updated', CLAUDE_CODE_TEXT.updated(name)));
    if (exists(added)) return view('failed', spareCurrent ? CLAUDE_CODE_TEXT.nameTaken(name, spare) : CLAUDE_CODE_TEXT.uncertain(name, reason(added)));
    return view('failed', keep(reason(added)));
  };

  if (!entry.listed) {
    // A re-point of ours removed it and was cut off before adding it back: finish it, whatever `registeredBefore` says.
    if (pending) return settle(await add(name));
    if (options.registeredBefore && !options.force) return view('removed', CLAUDE_CODE_TEXT.removed(name));
    const added = await add(name);
    // Registered meanwhile (another copy of the app, or by hand): it is there, which is all that matters.
    if (added.code !== 0 && !exists(added)) return view('failed', CLAUDE_CODE_TEXT.failed(reason(added)));
    return view('registered', CLAUDE_CODE_TEXT.registered(name));
  }

  // This launch and nothing pending: "linked", which changes nothing, so a wrapped row is enough. Anything else may change
  // something: the row is read exactly first (X-449).
  if (current(entry) && !pending) return view('linked', CLAUDE_CODE_TEXT.linked(name));
  // (A row with no launch line at all was already asked about once, above.)
  if (list.code === 0 && entry.listed && entry.command !== null && wrappedLine(entry.command)) entry = await settled(entry, name, true);
  const command = entry.listed ? entry.command : null;
  // A pending re-point is tidied (our spare removed) only on an exact reading; otherwise the spare and the mark stay for the next start.
  if (current(entry)) return pending && exact(entry) ? tidy(view('linked', CLAUDE_CODE_TEXT.linked(name))) : view('linked', CLAUDE_CODE_TEXT.linked(name));
  const readable = command !== null && appLaunchLine(command) && !wrappedLine(command);
  // Without a journal (older callers) nothing is ever re-pointed, as before.
  if (!options.journal) return view('linked', CLAUDE_CODE_TEXT.linked(name));
  if (!options.force && !((options.registeredBefore || pending) && mine(entry))) {
    // Not ours to change. A spare of ours stays (it may be the only one that works), and its mark with it.
    if (pending && !spareOurs && !spareUnknown) await journal(false);
    const shown = !readable ? { ...view('unverified', CLAUDE_CODE_TEXT.unverified(name)), unreadable: unreadableFacts(listText, name, list.code !== 0) }
      : mine(entry) ? view('stale', CLAUDE_CODE_TEXT.stale(name)) : view('stale', CLAUDE_CODE_TEXT.otherProfile(name));
    return spareOurs ? { ...shown, message: `${shown.message}${CLAUDE_CODE_TEXT.spareKept(spare, spareCurrent)}` } : shown;
  }
  // A spare-named entry that cannot be read exactly during a pending re-point: nothing is changed, the mark stays.
  if (spareUnknown) return view('failed', CLAUDE_CODE_TEXT.uncertain(name, `临时名字 ${spare} 没能读出来`));
  // A spare-named entry that is not a leftover of ours is someone else's: nothing is changed.
  if (spareEntry.listed && !spareOurs) {
    if (pending) await journal(false);
    return view('stale', CLAUDE_CODE_TEXT.spareTaken(name, spare));
  }
  if (!await journal(true)) return view('failed', CLAUDE_CODE_TEXT.unjournaled(name));

  // 1. The new launch under the spare name, unless a leftover of ours is already there (it stays the fallback until the
  //    real name is this version). Until this works nothing is changed.
  if (!spareOurs) {
    const spared = await add(spare);
    if (spared.code !== 0) {
      if (clean(spared) && !exists(spared)) { await journal(false); return view('failed', CLAUDE_CODE_TEXT.keptOld(name, reason(spared))); }
      return view('failed', CLAUDE_CODE_TEXT.uncertain(name, reason(spared)));
    }
    spareOurs = spareCurrent = true;
  }
  // 2. The old entry. If it cannot be removed the spare stays, and the mark: the old program may be gone already
  //    (B01), and the next start tries again.
  const removed = await remove(name);
  if (removed.code !== 0)
    return view('failed', clean(removed) && spareCurrent ? CLAUDE_CODE_TEXT.keptBoth(name, spare, reason(removed)) : CLAUDE_CODE_TEXT.uncertain(name, reason(removed)));
  // 3. The new launch under the real name; 4. only then the spare goes.
  return settle(await add(name));
}

/**
 * The user's two real desktop profiles only: `<appData>/soft-hearts-claude` (stable) and `<appData>/soft-hearts-claude-dev`
 * (development and source runs). Any other folder is a test profile. `SOFT_HEARTS_CLAUDE_CODE_LINK=off` turns it off.
 */
export function autoLinkAllowed(profileDirectory: string, appDataDirectory: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, tmpDirectory: string = tmpdir()): boolean {
  if (/^(?:off|0|false|no)$/i.test(env.SOFT_HEARTS_CLAUDE_CODE_LINK ?? '')) return false;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const same = (a: string, b: string) => platform === 'win32' ? api.resolve(a).toLowerCase() === api.resolve(b).toLowerCase() : api.resolve(a) === api.resolve(b);
  // I-064: the pretrial's registration check. Claude Code is pointed (CLAUDE_CONFIG_DIR) at a throw-away folder that the check
  // itself made directly inside the temp folder and named for this purpose; every `claude mcp` command then reads and writes
  // only that folder, so the user's own Claude Code configuration is never reached. Any other value changes nothing here.
  const config = env.CLAUDE_CONFIG_DIR;
  if (config && api.isAbsolute(config) && /^soft-hearts-pretrial-claude-config-[a-z0-9]{4,32}$/i.test(api.basename(config))
    && same(api.dirname(api.resolve(config)), tmpDirectory)) return true;
  return ['soft-hearts-claude', 'soft-hearts-claude-dev'].some(folder => same(profileDirectory, api.join(appDataDirectory, folder)));
}

/** `claude` itself (or, in tests, node with a fake script in `prefix`), never through a shell; output bounded to 64 KB. */
export function spawnClaudeRunner(executable: string, env: NodeJS.ProcessEnv, prefix: readonly string[] = [],
  /** Tests move the time limit by hand; the app does not pass this. */
  timers: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void } = { set: setTimeout, clear: handle => clearTimeout(handle as NodeJS.Timeout) },
  /**
   * I-202: the app's start gate for Claude Code processes (electron/brain/claude-start-gate.ts, passed by the wiring with the short hold:
   * `claude mcp` makes no model request). Each command waits for it and lets go when it ends. Tests leave it out.
   */
  startGate?: () => Promise<{ release(): void }>): ClaudeCodeRunner {
  const runOne = spawnOne(executable, env, prefix, timers);
  if (!startGate) return runOne;
  return async (args, timeoutMs) => {
    let pass: { release(): void };
    try { pass = await startGate(); }
    catch (error) { return { code: null, stdout: '', stderr: '', error: error instanceof Error ? error.message.slice(0, 300) : '没有启动' }; }
    try { return await runOne(args, timeoutMs); } finally { pass.release(); }
  };
}

function spawnOne(executable: string, env: NodeJS.ProcessEnv, prefix: readonly string[],
  timers: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }): ClaudeCodeRunner {
  return (args, timeoutMs) => new Promise<ClaudeRun>(resolve => {
    let stdout = '', stderr = '', done = false;
    const finish = (run: ClaudeRun) => { if (done) return; done = true; timers.clear(timer); resolve(run); };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable, [...prefix, ...args], { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { finish({ code: null, stdout: '', stderr: '', error: (error as Error).message }); return; }
    const timer = timers.set(() => { try { child.kill(); } catch { /* Gone. */ } finish({ code: null, stdout, stderr, error: '没有在时限内结束' }); }, timeoutMs);
    // setEncoding keeps a multi-byte character (✔, a Chinese folder name) that a pipe read cut in two together; per-chunk toString turned both halves into U+FFFD.
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    const take = (target: 'out' | 'err') => (chunk: string) => {
      if (target === 'out') { if (stdout.length < 65_536) stdout += chunk; }
      else if (stderr.length < 65_536) stderr += chunk;
    };
    child.stdout?.on('data', take('out'));
    child.stderr?.on('data', take('err'));
    child.on('error', error => finish({ code: null, stdout, stderr, error: error.message }));
    child.on('close', code => finish({ code, stdout, stderr }));
  });
}
