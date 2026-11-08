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
import path from 'node:path';
import type { AgentClaudeCodeLink } from '../../shared/agent-channel';
import { registrationArguments, type ShimLaunch } from './setup-text';

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
const STATUS = /^(.+)\s-\s(?:[✓✔✗✘×⚠!⏸⊘-]\s|(?:connected|failed|needs|pending|disabled|rejected|connection error)\b)/iu;
const SERVER_LINE = /^[A-Za-z0-9_.-]+: /u;

export function claudeCodeEntry(stdout: string, name: string): ClaudeCodeEntry | null {
  const listed = listedInClaudeCode(stdout, name);
  if (listed === null) return null;
  if (!listed) return { listed: false };
  const lines = plain(stdout).split(/\r?\n/u).map(line => line.trim());
  const starts = lines.flatMap((line, index) => line.startsWith(`${name}:`) ? [index] : []);
  // Twice (another scope, or a format this does not know): which one is in effect cannot be told.
  if (starts.length !== 1) return { listed: true, command: null };
  let row = lines[starts[0]].slice(name.length + 1);
  for (let index = starts[0] + 1; !STATUS.test(row) && index < lines.length && index <= starts[0] + 12; index++) {
    // A wrapped row continues on the next lines; another server's row or an empty line ends it.
    if (!lines[index] || SERVER_LINE.test(lines[index])) break;
    row += ` ${lines[index]}`;
  }
  const match = STATUS.exec(row.trim());
  const command = match?.[1].trim() ?? '';
  return { listed: true, command: command || null };
}

/** Case, slash direction, quotes and white space (a wrapped row) do not matter. */
const squash = (text: string) => text.replace(/"/g, '').replace(/\\/g, '/').replace(/\s+/gu, '').toLowerCase();
/** The listed launch line is this launch. */
export function sameLaunch(command: string, launch: ShimLaunch): boolean {
  return squash(command) === squash([launch.command, ...launch.args].join(' '));
}
/** The listed launch line is one of this app's (`<program> <…/soft-hearts-mcp.mjs> --profile <folder>`), of any version. */
export function appLaunchLine(command: string): boolean {
  return /soft-hearts-mcp\.mjs--profile./u.test(squash(command));
}
/**
 * The fingerprint of this profile's own registration: one of this app's launch lines (any version) whose `--profile` is
 * this launch's profile folder. Another profile's line, the user's wrapper or any other program is not ours.
 */
export function ownLaunchLine(command: string, launch: ShimLaunch): boolean {
  const at = launch.args.indexOf('--profile'), profile = at >= 0 ? launch.args[at + 1] : undefined;
  return !!profile && appLaunchLine(command) && squash(command).endsWith(`soft-hearts-mcp.mjs--profile${squash(profile)}`);
}
/** The spare name a re-point adds the new launch under first. */
export const spareName = (name: string) => `${name}-update`;

function reason(run: ClaudeRun): string {
  const text = plain(`${run.error ?? ''} ${run.stderr || run.stdout}`).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (text || (run.code === null ? '没有在时限内结束' : `退出码 ${run.code}`)).slice(0, 140);
}
const thrown = (error: unknown) => error instanceof Error ? error.message.slice(0, 140) : '未知错误';

export const CLAUDE_CODE_TEXT = Object.freeze({
  idle: '三方互通或内部通道关着，不会自动接上你的 Claude Code。',
  checking: '正在检查你的 Claude Code…',
  skipped: '这是测试用的配置目录，不会自动接上你的 Claude Code。',
  missing: '没找到你的 Claude Code。装好并登录后重新打开 soft hearts，或者复制下面的命令自己运行一次。',
  linked: (name: string) => `已接上你的 Claude Code（${name}）。`,
  registered: (name: string) => `已接上你的 Claude Code：刚把 ${name} 加了进去，新开的 Claude Code 会话里就能用。`,
  removed: (name: string) => `你的 Claude Code 里现在没有 ${name}（以前自动接上过，可能是你移除了），所以没有再加。需要时点「重新接上」。`,
  failed: (why: string) => `没能自动接上你的 Claude Code（${why}）。可以复制下面的命令自己运行一次。`,
  updated: (name: string) => `已接上你的 Claude Code：${name} 原来指向别的版本，刚改成了这个版本，新开的 Claude Code 会话里就能用。`,
  updatedLeftover: (name: string, spare: string) => `已接上你的 Claude Code：${name} 刚改成了这个版本；多出来的临时登记 ${spare} 没能删掉，下次打开 soft hearts 会再清理。`,
  stale: (name: string) => `你的 Claude Code 里的 ${name} 指向的不是这个版本。它不是自动登记的，所以没有改；要改成这个版本，点「重新接上」。`,
  unverified: (name: string) => `你的 Claude Code 里有 ${name}，但没能读出它指向哪个程序，没有核对是不是这个版本。用不了时点「重新接上」。`,
  keptOld: (name: string, why: string) => `没能把 ${name} 改成这个版本（${why}）。原来的登记没动，原来的程序还在时照样能用；可以点「重新接上」再试。`,
  temporary: (name: string, spare: string, why: string) => `${name} 暂时没能改好（${why}），现在先用临时名字 ${spare} 接着这个版本。下次打开 soft hearts 会自动改回 ${name}，也可以点「重新接上」。`,
  uncertain: (name: string, why: string) => `没能确认 ${name} 改好了没有（${why}）。下次打开 soft hearts 会自动再检查一次；用不了时点「重新接上」。`,
  unjournaled: (name: string) => `没能在配置目录里记下改动进度，为了不弄丢登记，这次没有改 ${name}。可以点「重新接上」再试。`,
  spareTaken: (name: string, spare: string) => `你的 Claude Code 里的 ${name} 指向的不是这个版本；要用来过渡的名字 ${spare} 已经被占用（不是自动加的），所以没有改。`,
  otherProfile: (name: string) => `你的 Claude Code 里的 ${name} 指向另一个配置目录里的 soft hearts，不是这个配置自动登记的，所以没有改；要改成这个版本，点「重新接上」。`,
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

  let entry: ClaudeCodeEntry, spareEntry: ClaudeCodeEntry;
  const list = await run(['mcp', 'list']);
  {
    const text = `${list.stdout}\n${list.stderr}`, found = claudeCodeEntry(text, name);
    if (found === null || (list.code !== 0 && !found.listed)) return view('failed', CLAUDE_CODE_TEXT.failed(reason(list)));
    entry = found; spareEntry = claudeCodeEntry(text, spare) ?? { listed: false };
  }
  const pending = options.repointPending === true && !!options.journal;
  const current = (found: ClaudeCodeEntry | null) => !!found?.listed && found.command !== null && sameLaunch(found.command, launch);
  const mine = (found: ClaudeCodeEntry | null) => !!found?.listed && found.command !== null && ownLaunchLine(found.command, launch);
  // The spare is ours only while a re-point of ours is pending and it carries this profile's fingerprint (any version);
  // a spare name the user reused, or one that cannot be read, is never removed.
  let spareOurs = pending && mine(spareEntry), spareCurrent = spareOurs && current(spareEntry);
  /** A fresh list shows the real name as this launch ("already exists" alone does not say whose it is). */
  const confirmed = async () => {
    const again = await run(['mcp', 'list']);
    return again.code === 0 && current(claudeCodeEntry(`${again.stdout}\n${again.stderr}`, name));
  };
  /** The spare is kept, so is the mark: what the panel says about it. */
  const keep = (why: string) => spareCurrent ? CLAUDE_CODE_TEXT.temporary(name, spare, why) : CLAUDE_CODE_TEXT.uncertain(name, why);

  /** Only once the real name is this version: our spare goes (someone else's never), then the mark. */
  const tidy = async (done: AgentClaudeCodeLink): Promise<AgentClaudeCodeLink> => {
    if (spareOurs && (await remove(spare)).code !== 0) return view(done.state, CLAUDE_CODE_TEXT.updatedLeftover(name, spare));
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

  const command = entry.command;
  if (current(entry)) return pending ? tidy(view('linked', CLAUDE_CODE_TEXT.linked(name))) : view('linked', CLAUDE_CODE_TEXT.linked(name));
  const readable = command !== null && appLaunchLine(command);
  // Without a journal (older callers) nothing is ever re-pointed, as before.
  if (!options.journal) return view('linked', CLAUDE_CODE_TEXT.linked(name));
  if (!options.force && !((options.registeredBefore || pending) && mine(entry))) {
    // Not ours to change. A spare of ours stays (it may be the only one that works), and its mark with it.
    if (pending && !spareOurs) await journal(false);
    const shown = !readable ? view('unverified', CLAUDE_CODE_TEXT.unverified(name))
      : mine(entry) ? view('stale', CLAUDE_CODE_TEXT.stale(name)) : view('stale', CLAUDE_CODE_TEXT.otherProfile(name));
    return spareOurs ? { ...shown, message: `${shown.message}${CLAUDE_CODE_TEXT.spareKept(spare, spareCurrent)}` } : shown;
  }
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
export function autoLinkAllowed(profileDirectory: string, appDataDirectory: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (/^(?:off|0|false|no)$/i.test(env.SOFT_HEARTS_CLAUDE_CODE_LINK ?? '')) return false;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const same = (a: string, b: string) => platform === 'win32' ? api.resolve(a).toLowerCase() === api.resolve(b).toLowerCase() : api.resolve(a) === api.resolve(b);
  return ['soft-hearts-claude', 'soft-hearts-claude-dev'].some(folder => same(profileDirectory, api.join(appDataDirectory, folder)));
}

/** `claude` itself (or, in tests, node with a fake script in `prefix`), never through a shell; output bounded to 64 KB. */
export function spawnClaudeRunner(executable: string, env: NodeJS.ProcessEnv, prefix: readonly string[] = []): ClaudeCodeRunner {
  return (args, timeoutMs) => new Promise<ClaudeRun>(resolve => {
    let stdout = '', stderr = '', done = false;
    const finish = (run: ClaudeRun) => { if (done) return; done = true; clearTimeout(timer); resolve(run); };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable, [...prefix, ...args], { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { finish({ code: null, stdout: '', stderr: '', error: (error as Error).message }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* Gone. */ } finish({ code: null, stdout, stderr, error: '没有在时限内结束' }); }, timeoutMs);
    const take = (target: 'out' | 'err') => (chunk: Buffer) => {
      if (target === 'out') { if (stdout.length < 65_536) stdout += chunk.toString('utf8'); }
      else if (stderr.length < 65_536) stderr += chunk.toString('utf8');
    };
    child.stdout?.on('data', take('out'));
    child.stderr?.on('data', take('err'));
    child.on('error', error => finish({ code: null, stdout, stderr, error: error.message }));
    child.on('close', code => finish({ code, stdout, stderr }));
  });
}
