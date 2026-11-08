// R20 permission policy for a Claude Code task process. Pure decisions plus a narrow,
// injectable file system: no Electron, no process. Claude Code itself already auto-allows
// reads inside its working folder and refuses file tools outside it (--restricted); every
// request that still reaches the app's permission tool is decided here:
//   read tools inside the folder  -> allow without asking
//   anything outside the folder   -> deny without asking
//   file changes inside the folder and every shell command -> ask the user, one at a time
//   network and every other tool  -> deny
import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { CodexTaskApproval, CodexTaskMode } from '../../shared/codex-tasks';

export interface PermissionRequest { tool_name: string; input: Record<string, unknown>; tool_use_id?: string }
export type ApprovalDraft = Pick<CodexTaskApproval, 'kind' | 'reason' | 'command' | 'workingDirectory' | 'files' | 'permissionWarning'>;
export type PolicyOutcome =
  | { kind: 'allow' }
  | { kind: 'deny'; message: string }
  | { kind: 'ask'; approval: ApprovalDraft };

export const READ_TOOLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Read: ['file_path'], Glob: ['path'], Grep: ['path'], LS: ['path'], NotebookRead: ['notebook_path'],
});
export const WRITE_TOOLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Write: ['file_path'], Edit: ['file_path'], MultiEdit: ['file_path'], NotebookEdit: ['notebook_path'],
});
/** Bash, and the PowerShell tool Claude Code uses on Windows without Git Bash. */
export const COMMAND_TOOLS: readonly string[] = Object.freeze(['Bash', 'PowerShell']);
export const NETWORK_TOOLS: readonly string[] = Object.freeze(['WebFetch', 'WebSearch']);
/** Fields that may name a path but are optional (absent means the working folder). */
const OPTIONAL_PATHS = new Set(['Glob.path', 'Grep.path', 'LS.path']);

export const DENY_OUTSIDE = '只能在你选定的文件夹里操作；这个位置在文件夹以外，已拒绝。';
export const DENY_NETWORK = '桌宠任务不允许联网（WebFetch / WebSearch）。';
export const DENY_TOOL = '这个工具在桌宠任务里不可用。';
export const DENY_READ_ONLY = '这次任务是只读的，不能修改文件。需要修改时，请让用户以“可以修改”重新开始或继续任务。';
export const DENY_BACKGROUND = '桌宠任务不支持后台命令，请直接运行命令。';
const MAX_COMMAND = 16_000;

export interface PolicyFs {
  realpath(file: string): Promise<string>;
  /** Text of an existing regular file up to `limit` bytes, or null when it does not exist. */
  readText(file: string, limit: number): Promise<string | null>;
}
export const nodePolicyFs: PolicyFs = {
  realpath: file => realpath(file),
  async readText(file, limit) {
    let info;
    try { info = await stat(file); } catch { return null; }
    if (!info.isFile()) return null;
    if (info.size > limit) return `\0large:${info.size}`;
    return readFile(file, 'utf8');
  },
};

export interface PolicyContext {
  /** Real (canonical) path of the user-selected folder. */
  folder: string;
  mode: CodexTaskMode;
  platform?: NodeJS.Platform;
  fs?: PolicyFs;
}

const pathApi = (platform: NodeJS.Platform) => platform === 'win32' ? path.win32 : path.posix;
const caseless = (platform: NodeJS.Platform) => platform === 'win32' || platform === 'darwin';

/** True when `candidate` is the folder itself or below it (lexically; both already canonical). */
export function isWithin(folder: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const api = pathApi(platform);
  const fold = (value: string) => caseless(platform) ? value.toLowerCase() : value;
  const relative = api.relative(fold(api.resolve(folder)), fold(api.resolve(candidate)));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative));
}

/** Path shapes never accepted: NUL, Windows device/UNC paths and alternate data streams. */
export function unsafePathShape(value: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!value || value.length > 4096 || value.includes('\0')) return true;
  if (platform !== 'win32') return false;
  if (/^[\\/]{2}/.test(value)) return true;
  return value.slice(/^[a-zA-Z]:/.test(value) ? 2 : 0).includes(':');
}

/** Canonical form of a path that may not exist yet: realpath of the deepest existing ancestor. */
export async function canonicalPath(candidate: string, platform: NodeJS.Platform, fs: PolicyFs): Promise<string | null> {
  const api = pathApi(platform);
  let current = candidate;
  const rest: string[] = [];
  for (let depth = 0; depth < 128; depth++) {
    try {
      const real = await fs.realpath(current);
      return rest.length ? api.join(real, ...rest.reverse()) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      const parent = api.dirname(current);
      if (parent === current) return null;
      rest.push(api.basename(current));
      current = parent;
    }
  }
  return null;
}

/** Resolves a tool path against the folder and proves it stays inside, following symlinks. */
export async function resolveInside(raw: unknown, context: PolicyContext): Promise<string | null> {
  const platform = context.platform ?? process.platform, fs = context.fs ?? nodePolicyFs, api = pathApi(platform);
  if (typeof raw !== 'string' || unsafePathShape(raw, platform)) return null;
  const absolute = api.resolve(context.folder, raw);
  if (!isWithin(context.folder, absolute, platform)) return null;
  const canonical = await canonicalPath(absolute, platform, fs);
  return canonical && isWithin(context.folder, canonical, platform) ? absolute : null;
}

/** The static directory part of a glob pattern (before the first wildcard). */
function globBase(pattern: string, platform: NodeJS.Platform): string | null {
  const api = pathApi(platform);
  const parts = pattern.split(/[\\/]/);
  if (parts.includes('..')) return null;
  if (!api.isAbsolute(pattern)) return '.';
  const fixed: string[] = [];
  for (const part of parts) { if (/[*?[\]{}]/.test(part)) break; fixed.push(part); }
  return fixed.join(api.sep) || api.sep;
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function pathsInside(tool: string, fields: readonly string[], input: Record<string, unknown>, context: PolicyContext): Promise<string[] | null> {
  const platform = context.platform ?? process.platform;
  const resolved: string[] = [];
  for (const field of fields) {
    const value = input[field];
    if (value === undefined && OPTIONAL_PATHS.has(`${tool}.${field}`)) continue;
    const inside = await resolveInside(value, context);
    if (!inside) return null;
    resolved.push(inside);
  }
  if (tool === 'Glob') {
    if (typeof input.pattern !== 'string') return null;
    const base = globBase(input.pattern, platform);
    if (base === null || (base !== '.' && !(await resolveInside(base, context)))) return null;
  }
  return resolved;
}

export async function classifyPermission(request: PermissionRequest, context: PolicyContext): Promise<PolicyOutcome> {
  const platform = context.platform ?? process.platform;
  const tool = typeof request?.tool_name === 'string' ? request.tool_name : '';
  const input = object(request?.input);
  if (Object.hasOwn(READ_TOOLS, tool))
    return (await pathsInside(tool, READ_TOOLS[tool], input, context)) ? { kind: 'allow' } : { kind: 'deny', message: DENY_OUTSIDE };
  if (Object.hasOwn(WRITE_TOOLS, tool)) {
    const paths = await pathsInside(tool, WRITE_TOOLS[tool], input, context);
    if (!paths?.length) return { kind: 'deny', message: DENY_OUTSIDE };
    if (context.mode !== 'workspace-write') return { kind: 'deny', message: DENY_READ_ONLY };
    const file = await describeFileChange(tool, input, paths[0], context);
    return { kind: 'ask', approval: {
      kind: 'file', reason: 'Claude 想修改文件夹里的文件。', files: [file],
      permissionWarning: sensitivePath(paths[0], context.folder, platform)
        ? '这个文件会影响以后在这个文件夹里运行的工具（例如 Git、编辑器或 Claude Code 的设置），请仔细核对。'
        : '只允许这一次修改；下次修改还会再问你。',
    } };
  }
  if (COMMAND_TOOLS.includes(tool)) {
    const command = input.command;
    if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND) return { kind: 'deny', message: DENY_TOOL };
    if (input.run_in_background === true) return { kind: 'deny', message: DENY_BACKGROUND };
    const description = typeof input.description === 'string' ? input.description.slice(0, 400) : '';
    return { kind: 'ask', approval: {
      kind: 'command', command, workingDirectory: context.folder,
      reason: description ? `Claude 想运行命令：${description}` : 'Claude 想运行一条命令。',
      permissionWarning: commandWarning(platform, context.mode),
    } };
  }
  if (NETWORK_TOOLS.includes(tool)) return { kind: 'deny', message: DENY_NETWORK };
  return { kind: 'deny', message: DENY_TOOL };
}
export function commandWarning(platform: NodeJS.Platform, mode: CodexTaskMode): string {
  const base = platform === 'win32'
    ? 'Windows 上 Claude Code 没有沙箱：这条命令会以你的身份直接运行，可能读写所选文件夹以外的文件，也可能联网。只在看懂命令时允许。'
    : '这条命令会以你的身份运行，可能访问所选文件夹以外的位置，也可能联网。只在看懂命令时允许。';
  return mode === 'read-only' ? `${base}（只读任务：命令也可能修改文件，请核对。）` : base;
}

function sensitivePath(file: string, folder: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform);
  const parts = api.relative(folder, file).split(/[\\/]/).map(part => part.toLowerCase());
  const name = parts.at(-1) ?? '';
  return parts.some(part => ['.git', '.claude', '.vscode', '.husky', '.github', '.idea'].includes(part))
    || ['.mcp.json', 'claude.md', 'agents.md', '.gitattributes', '.gitmodules'].includes(name);
}

const PREVIEW_LINES = 24;
const PREVIEW_CHARS = 6_000;
/** Lines of a text; a final newline does not start another line. */
const lines = (value: string) => value ? value.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [];
function clip(value: string): string { return value.length > 400 ? `${value.slice(0, 400)}…` : value; }

/** A short diff summary: trims the common head and tail, then shows the changed region. */
export function changeSummary(before: string, after: string, wholeFile = false): string {
  const a = lines(before), b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const removed = a.slice(head, a.length - tail), added = b.slice(head, b.length - tail);
  const out: string[] = [`@@ ${wholeFile ? `第 ${head + 1} 行起：` : ''}删除 ${removed.length} 行，新增 ${added.length} 行 @@`];
  for (const [sign, part] of [['-', removed], ['+', added]] as const) {
    for (const line of part.slice(0, PREVIEW_LINES)) out.push(`${sign} ${clip(line)}`);
    if (part.length > PREVIEW_LINES) out.push(`${sign} …（其余 ${part.length - PREVIEW_LINES} 行未显示）`);
  }
  return out.join('\n');
}

function bounded(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\n…（预览已截断）` : text;
}

export async function describeFileChange(tool: string, input: Record<string, unknown>, file: string, context: PolicyContext): Promise<{ path: string; diff: string }> {
  const platform = context.platform ?? process.platform, fs = context.fs ?? nodePolicyFs, api = pathApi(platform);
  const shown = api.relative(context.folder, file) || api.basename(file);
  const text = (value: unknown) => typeof value === 'string' ? value : '';
  let diff: string;
  if (tool === 'Write') {
    const existing = await fs.readText(file, 512 * 1024).catch(() => null);
    const content = text(input.content);
    if (existing === null) diff = `新建文件，共 ${lines(content).length} 行。\n${changeSummary('', content)}`;
    else if (existing.startsWith('\0large:')) diff = `覆盖已有的大文件（${existing.slice(7)} 字节），新内容 ${lines(content).length} 行。\n${changeSummary('', content)}`;
    else diff = `覆盖已有文件（原 ${lines(existing).length} 行 → 新 ${lines(content).length} 行）。\n${changeSummary(existing, content, true)}`;
  } else if (tool === 'Edit') {
    diff = `${input.replace_all === true ? '替换所有出现的位置' : '替换一处'}。\n${changeSummary(text(input.old_string), text(input.new_string))}`;
  } else if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits.map(object) : [];
    diff = [`共 ${edits.length} 处修改。`, ...edits.slice(0, 8).map((edit, index) => `#${index + 1}${edit.replace_all === true ? '（全部）' : ''}\n${changeSummary(text(edit.old_string), text(edit.new_string))}`),
      ...(edits.length > 8 ? [`…（其余 ${edits.length - 8} 处未显示）`] : [])].join('\n');
  } else {
    diff = `笔记本单元格 ${text(input.cell_id) || '（新单元格）'}，方式：${text(input.edit_mode) || 'replace'}。\n${changeSummary('', text(input.new_source))}`;
  }
  return { path: shown, diff: bounded(diff) };
}
