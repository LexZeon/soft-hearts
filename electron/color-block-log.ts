/**
 * I-031 色块诊断日志, the host's side (temporary).
 *
 * The pet window (src/stage/color-block-log.ts) sends what the 色块哨兵 saw. Here every field is checked again against a closed
 * shape (finite numbers clamped, names length-limited, pictures only small PNG data URLs) and written to a diagnostics folder
 * outside every profile: %LOCALAPPDATA%\soft-hearts-diagnostics\color-block\<channel>\ for the installed stable and development
 * channels; a source or test run writes nothing unless SOFT_HEARTS_DIAGNOSTICS_DIR names a folder. One JSON per block with its two pictures, near misses as lines in one file, a Chinese README. Caps: 50
 * blocks, 200 near-miss lines, 8 MB in all, one block per 10 s, and nothing more 14 days after the first write (started.json),
 * or once a file named STOP (or STOP.txt) is in the folder. Every write is atomic; nothing here can fail the pet (accept never throws).
 * Remove: this file, src/stage/color-block-log.ts, shared/color-block.ts and the one block in electron/main.ts that loads it.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { EXECUTABLE_NAME } from '../scripts/lib/app-identity.mjs';
import {
  COLOR_BLOCK_FRAME_COLUMNS, COLOR_BLOCK_GAP_MS, COLOR_BLOCK_IMAGE_BYTES, COLOR_BLOCK_IMAGE_PREFIX, COLOR_BLOCK_MAX_FRAMES,
  COLOR_BLOCK_MAX_RUNS, COLOR_BLOCK_MAX_STRIPS, COLOR_BLOCK_NEAR_GAP_MS,
  type ColorBlockEnv, type ColorBlockEvent, type ColorBlockFrames, type ColorBlockInspect, type ColorBlockNearMiss, type ColorBlockReport,
  type ColorBlockSample, type ColorBlockWatchStats,
} from '../shared/color-block';
import { MOTION_ACTIVITIES, type MotionActivity } from '../shared/journal';

export const COLOR_BLOCK_LIMITS = Object.freeze({
  blocks: 50, nearLines: 200, totalBytes: 8 * 1024 * 1024, stopAfterMs: 14 * 24 * 3_600_000,
  blockGapMs: COLOR_BLOCK_GAP_MS, nearGapMs: COLOR_BLOCK_NEAR_GAP_MS, jsonBytes: 512 * 1024, nearLineBytes: 4 * 1024,
});
export type ColorBlockChannel = 'stable' | 'development' | 'source';
export interface ProcessCounts { softHeartsNext: number; electron: number }

/** Tests and pretrial runs point the log at their own temporary folder (it then holds color-block\<channel>\). */
export const COLOR_BLOCK_DIRECTORY_VARIABLE = 'SOFT_HEARTS_DIAGNOSTICS_DIR';

/**
 * The folder for this channel, or null: the installed stable and development channels write under %LOCALAPPDATA%; a source
 * or test run writes only where COLOR_BLOCK_DIRECTORY_VARIABLE says (a pretrial's relay keeps the real %LOCALAPPDATA%, and
 * its blocks must never land beside the user's). Never inside %APPDATA%, where the profiles live.
 */
export function colorBlockDirectory(env: Record<string, string | undefined>, channel: string | null | undefined): string | null {
  const override = env[COLOR_BLOCK_DIRECTORY_VARIABLE], installed = channel === 'stable' || channel === 'development';
  const base = override ? override : installed ? env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'soft-hearts-diagnostics') : null;
  if (!base || !path.isAbsolute(base)) return null;
  const directory = path.resolve(base, 'color-block', channelOf(channel));
  const roaming = env.APPDATA && path.isAbsolute(env.APPDATA) ? path.resolve(env.APPDATA) : null;
  if (roaming) {
    const relative = path.relative(roaming, directory);
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) return null;
  }
  return directory;
}
const channelOf = (channel: string | null | undefined): ColorBlockChannel => channel === 'stable' || channel === 'development' ? channel : 'source';

// ------------------------------------------------------------------------------------------------ validation (closed shapes)

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Exactly these keys (all present); anything else rejects the whole report. */
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key)) ? value : null;
}
class Invalid extends Error {}
const fail = (): never => { throw new Invalid(); };
function num(value: unknown, min: number, max: number, digits = 4): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail();
  const f = 10 ** digits;
  return Math.round(Math.min(max, Math.max(min, value)) * f) / f;
}
const int = (value: unknown, min: number, max: number) => num(value, min, max, 0);
const nullableNum = (value: unknown, min: number, max: number, digits = 4) => value === null ? null : num(value, min, max, digits);
const bool = (value: unknown) => typeof value === 'boolean' ? value : fail();
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max * 4) return fail();
  return (value as string).normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').slice(0, max);
}
/** A bone or morph name as the journal keeps it (40 plain characters). */
const partName = (value: unknown) => { const name = text(value, 40).replace(/[\/:*?"<>|\\]/g, ''); return name || fail(); };
function list<T>(value: unknown, max: number, item: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) return fail();
  return value.map(item);
}
const activityNames = (value: unknown): MotionActivity[] => {
  const names = list(value, MOTION_ACTIVITIES.length, name => typeof name === 'string' && (MOTION_ACTIVITIES as readonly string[]).includes(name) ? name as MotionActivity : fail());
  return [...new Set(names)];
};
const PIXELS = 1_000_000, SIDE = 16_384;

function sample(value: unknown): ColorBlockSample {
  const v = exact(value, ['drawn', 'pixels', 'total', 'width', 'height', 'widen', 'reach', 'strips']) ?? fail();
  const reach = v.reach === null ? null : exact(v.reach, ['minX', 'maxX', 'minY', 'maxY']) ?? fail();
  return { drawn: num(v.drawn, 0, 1), pixels: int(v.pixels, 0, PIXELS), total: int(v.total, 0, PIXELS), width: int(v.width, 0, SIDE), height: int(v.height, 0, SIDE),
    widen: num(v.widen, 0, 1_000, 3),
    reach: reach ? { minX: num(reach.minX, -1e6, 1e6, 1), maxX: num(reach.maxX, -1e6, 1e6, 1), minY: num(reach.minY, -1e6, 1e6, 1), maxY: num(reach.maxY, -1e6, 1e6, 1) } : null,
    strips: list(v.strips, COLOR_BLOCK_MAX_STRIPS, strip => {
      const s = exact(strip, ['x', 'y', 'w', 'h', 'drawn']) ?? fail();
      return { x: int(s.x, 0, SIDE), y: int(s.y, 0, SIDE), w: int(s.w, 0, SIDE), h: int(s.h, 0, SIDE), drawn: int(s.drawn, 0, PIXELS) };
    }) };
}
function watch(value: unknown): ColorBlockWatchStats {
  const v = exact(value, ['samples', 'hits', 'blocks', 'cleared', 'stayed', 'widen', 'stopped']) ?? fail();
  return { samples: int(v.samples, 0, 1e9), hits: int(v.hits, 0, 1e9), blocks: int(v.blocks, 0, 1e9), cleared: int(v.cleared, 0, 1e9), stayed: int(v.stayed, 0, 1e9),
    widen: num(v.widen, 0, 1_000, 3), stopped: bool(v.stopped) };
}
function inspect(value: unknown): ColorBlockInspect | null {
  if (value === null) return null;
  const v = exact(value, ['bones', 'morphs', 'modelHeight', 'farthestBone', 'worstScale', 'worstMorph', 'geometryBroken']) ?? fail();
  const named = <K extends string>(item: unknown, key: K, min: number, max: number) => {
    if (item === null) return null;
    const n = exact(item, ['name', key]) ?? fail();
    return { name: partName(n.name), [key]: nullableNum(n[key], min, max, 4) } as { name: string } & Record<K, number | null>;
  };
  return { bones: int(v.bones, 0, 100_000), morphs: int(v.morphs, 0, 100_000), modelHeight: num(v.modelHeight, 0, 1e6, 3),
    farthestBone: named(v.farthestBone, 'heights', 0, 1e9), worstScale: named(v.worstScale, 'scale', 0, 1e9), worstMorph: named(v.worstMorph, 'weight', -1e9, 1e9),
    geometryBroken: bool(v.geometryBroken) };
}
function frames(value: unknown): ColorBlockFrames {
  const v = exact(value, COLOR_BLOCK_FRAME_COLUMNS) ?? fail();
  const length = Array.isArray(v.atMs) ? v.atMs.length : fail();
  const range: Record<string, [number, number, number]> = { atMs: [-60_000, 0, 1], dtMs: [0, 600_000, 2], pointerOver: [0, 1, 0], physics: [0, 1, 0], contextLost: [0, 65_535, 0] };
  return Object.fromEntries(COLOR_BLOCK_FRAME_COLUMNS.map(column => {
    const [min, max, digits] = range[column] ?? [-100, 100, 4];
    const values = list(v[column], COLOR_BLOCK_MAX_FRAMES, item => num(item, min, max, digits));
    return values.length === length ? [column, values] : fail();
  })) as ColorBlockFrames;
}
function env(value: unknown): ColorBlockEnv {
  const v = exact(value, ['renderer', 'vendor', 'bufferWidth', 'bufferHeight', 'canvasWidth', 'canvasHeight', 'dpr', 'fov', 'zoom', 'aspect', 'distance', 'fps', 'contextLost', 'contextRestored']) ?? fail();
  return { renderer: text(v.renderer, 200), vendor: text(v.vendor, 200), bufferWidth: int(v.bufferWidth, 0, SIDE), bufferHeight: int(v.bufferHeight, 0, SIDE),
    canvasWidth: int(v.canvasWidth, 0, SIDE), canvasHeight: int(v.canvasHeight, 0, SIDE), dpr: num(v.dpr, 0, 16, 3),
    fov: nullableNum(v.fov, 0, 180, 3), zoom: nullableNum(v.zoom, 0, 1_000, 3), aspect: nullableNum(v.aspect, 0, 1_000, 3), distance: nullableNum(v.distance, 0, 1e6, 3),
    fps: nullableNum(v.fps, 0, 1_000, 0), contextLost: int(v.contextLost, 0, 1e6), contextRestored: int(v.contextRestored, 0, 1e6) };
}
/** A PNG data URL of at most COLOR_BLOCK_IMAGE_BYTES once decoded, with the PNG signature; else the report is rejected. */
function image(value: unknown): Buffer | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.startsWith(COLOR_BLOCK_IMAGE_PREFIX)) return fail();
  const body = (value as string).slice(COLOR_BLOCK_IMAGE_PREFIX.length);
  if (body.length > Math.ceil(COLOR_BLOCK_IMAGE_BYTES / 3) * 4 || body.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body)) return fail();
  const bytes = Buffer.from(body, 'base64');
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length <= COLOR_BLOCK_IMAGE_BYTES && bytes.length > signature.length && signature.every((byte, i) => bytes[i] === byte) ? bytes : fail();
}
const CAUSE_PARTS = ['bone', 'morph', 'geometry', 'gpu'] as const;

export type ValidColorBlock = (Omit<ColorBlockEvent, 'images'> & { images: { found: Buffer | null; after: Buffer | null } }) | ColorBlockNearMiss;

/** The report rebuilt from checked fields only, or null (an extra or missing field, a wrong type, an oversize picture). */
export function validateColorBlockReport(value: unknown): ValidColorBlock | null {
  try {
    if (!isRecord(value)) return null;
    if (value.kind === 'near') {
      const v = exact(value, ['kind', 'found', 'watch', 'dt', 'activities']) ?? fail();
      const dt = exact(v.dt, ['frames', 'meanMs', 'maxMs', 'slowFrames']) ?? fail();
      return { kind: 'near', found: sample(v.found), watch: watch(v.watch),
        dt: { frames: int(dt.frames, 0, COLOR_BLOCK_MAX_FRAMES), meanMs: num(dt.meanMs, 0, 600_000, 2), maxMs: num(dt.maxMs, 0, 600_000, 2), slowFrames: int(dt.slowFrames, 0, COLOR_BLOCK_MAX_FRAMES) },
        activities: activityNames(v.activities) };
    }
    if (value.kind !== 'block') return null;
    const v = exact(value, ['kind', 'cause', 'cleared', 'found', 'after', 'watch', 'inspect', 'frames', 'activities', 'env', 'images']) ?? fail();
    const cause = exact(v.cause, ['part', 'name']) ?? fail();
    const part = (CAUSE_PARTS as readonly unknown[]).includes(cause.part) ? cause.part as (typeof CAUSE_PARTS)[number] : fail();
    const name = part === 'gpu' || part === 'geometry' ? (cause.name === part ? part : fail()) : partName(cause.name);
    const images = exact(v.images, ['found', 'after']) ?? fail();
    return { kind: 'block', cause: { part, name }, cleared: v.cleared === null ? null : bool(v.cleared), found: sample(v.found), after: v.after === null ? null : sample(v.after),
      watch: watch(v.watch), inspect: inspect(v.inspect), frames: frames(v.frames),
      activities: list(v.activities, COLOR_BLOCK_MAX_RUNS, run => { const r = exact(run, ['atMs', 'names']) ?? fail(); return { atMs: num(r.atMs, -60_000, 0, 1), names: activityNames(r.names) }; }),
      env: env(v.env), images: { found: image(images.found), after: image(images.after) } };
  } catch (error) {
    if (error instanceof Invalid) return null;
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ processes

/** Counts of this edition's executable and of electron.exe in `tasklist /FO CSV /NH` output. */
export function parseTasklist(output: string): ProcessCounts {
  const own = EXECUTABLE_NAME.toLowerCase();
  let softHeartsNext = 0, electron = 0;
  for (const line of output.split(/\r?\n/)) {
    const name = /^\s*"([^"]*)"/.exec(line)?.[1]?.toLowerCase();
    if (name === own) softHeartsNext++;
    else if (name === 'electron.exe') electron++;
  }
  return { softHeartsNext, electron };
}
/** Once per block event: the two counts (Windows only), never names or command lines of anything else. */
export function countProcesses(): Promise<ProcessCounts | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => resolve(error ? null : parseTasklist(String(stdout))));
    } catch { resolve(null); }
  });
}

// ------------------------------------------------------------------------------------------------ the folder

export const COLOR_BLOCK_README = [
  'soft hearts · 色块诊断日志（临时，I-031）',
  '',
  '这是什么：桌宠的"色块哨兵"发现窗口里突然出现一大块色块时，自动把当时的现场记在这里，方便 Claude 查清楚是哪一层出了问题。查清楚以后会从软件里拿掉。',
  '',
  '记了什么：',
  '- 每次色块一个 block-时间.json：时间；软件版本、提交号、稳定版还是开发版；哨兵扫到的数字；程序里离正常最远的骨骼、骨骼缩放和表情权重，模型数据有没有坏；',
  '  前 5 秒每一帧的间隔、头和眼睛的转向、鼠标位置和在不在她身上、她在做什么、物理开没开、显卡上下文丢过几次；',
  '  显卡和驱动的名字、窗口和画布大小、镜头远近；当时开着几个 soft hearts 和 electron 进程（只记个数）。',
  '- 两张小图：-found.png 是出现时，-after.png 是重传给显卡以后。只截她那块 3D 画布，最宽 240 像素；不截聊天气泡、输入框和桌面。',
  '- near-misses.jsonl：只扫到一次、没算成色块的"差一点"，一次一行，只有数字。',
  '',
  '没有记：聊天内容、记忆、日记、角色卡、你的文件和路径。这个文件夹不在任何配置目录里，桌宠也不会读它。',
  '',
  '自己会停：最多 50 次色块、200 行"差一点"、整个文件夹 8 MB；从第一次写入起 14 天后不再写（开始时间在 started.json）。',
  '想马上停：在这个文件夹里新建一个名叫 STOP 的空文件（STOP.txt 也行）。',
  '可以随时删掉整个文件夹，不影响桌宠和她的记忆。删掉以后如果又出现色块，会重新开始记 14 天。',
  '',
].join('\r\n');

export interface ColorBlockLogOptions {
  directory: string | null;
  channel: ColorBlockChannel;
  version: string;
  commit: string | null;
  clock?(): number;
  countProcesses?(): Promise<ProcessCounts | null>;
}
interface FolderState { blocks: number; nearLines: string[]; bytes: number; startedAt: number | null; stopped: boolean }

const pad = (value: number, size = 2) => String(value).padStart(size, '0');
/** Local time for file names and the record (the user reads them in their own time). */
function localStamp(at: number): { file: string; text: string } {
  const d = new Date(at);
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`, time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return { file: `${date}-${time}-${pad(d.getMilliseconds(), 3)}`,
    text: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` };
}

/** Written beside the target, then renamed over it (Windows sharing locks may delay only the rename). */
async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await fsp.rename(temporary, file); return; }
      catch (error) {
        const code = (error as { code?: string }).code;
        if (attempt >= 4 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 << attempt));
      }
    }
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export class ColorBlockLog {
  private queue: Promise<void> = Promise.resolve();
  private lastBlockAt = -Infinity;
  private lastNearAt = -Infinity;
  /** For tests and the pretrial: what came in and what happened to it. */
  readonly counts = { accepted: 0, rejected: 0, written: 0, skipped: 0, failed: 0 };

  constructor(private readonly options: ColorBlockLogOptions) {}

  private now(): number { return this.options.clock ? this.options.clock() : Date.now(); }

  /** The IPC entry: only the pet window's own reports. Never throws; true when queued for writing. */
  note(sender: number, petId: number | null | undefined, value: unknown): boolean {
    if (typeof petId !== 'number' || sender !== petId) { this.counts.rejected++; return false; }
    return this.accept(value);
  }

  accept(value: unknown): boolean {
    try {
      if (!this.options.directory) return false;
      const report = validateColorBlockReport(value);
      if (!report) { this.counts.rejected++; return false; }
      const now = this.now();
      if (report.kind === 'block') {
        if (now - this.lastBlockAt < COLOR_BLOCK_LIMITS.blockGapMs) { this.counts.skipped++; return false; }
        this.lastBlockAt = now;
      } else {
        if (now - this.lastNearAt < COLOR_BLOCK_LIMITS.nearGapMs) { this.counts.skipped++; return false; }
        this.lastNearAt = now;
      }
      this.counts.accepted++;
      this.queue = this.queue.then(() => this.write(report, now)).then(written => { if (written) this.counts.written++; else this.counts.skipped++; },
        () => { this.counts.failed++; });
      return true;
    } catch { this.counts.failed++; return false; }
  }

  /** Resolves once everything accepted so far has been written or dropped. */
  idle(): Promise<void> { return this.queue; }

  private async load(directory: string, now: number): Promise<FolderState> {
    await fsp.mkdir(directory, { recursive: true });
    const state: FolderState = { blocks: 0, nearLines: [], bytes: 0, startedAt: null, stopped: false };
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (/^stop(\.txt)?$/i.test(entry.name)) state.stopped = true;
      if (/^block-.*\.json$/.test(entry.name)) state.blocks++;
      try { state.bytes += (await fsp.stat(path.join(directory, entry.name))).size; } catch { /* gone meanwhile */ }
    }
    try {
      const started = JSON.parse(await fsp.readFile(path.join(directory, 'started.json'), 'utf8')) as { startedAt?: unknown };
      const at = typeof started.startedAt === 'string' ? Date.parse(started.startedAt) : NaN;
      if (Number.isFinite(at)) state.startedAt = at; else state.stopped = true; // unreadable start: stop rather than guess
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') state.stopped = true;
    }
    try { state.nearLines = (await fsp.readFile(path.join(directory, 'near-misses.jsonl'), 'utf8')).split('\n').filter(line => line.trim()); }
    catch { state.nearLines = []; }
    if (state.startedAt !== null && now - state.startedAt >= COLOR_BLOCK_LIMITS.stopAfterMs) state.stopped = true;
    return state;
  }

  private async write(report: ValidColorBlock, now: number): Promise<boolean> {
    const directory = this.options.directory;
    if (!directory) return false;
    // Read fresh each time (a few writes a minute at most): a STOP file or a deleted folder takes effect at once.
    const state = await this.load(directory, now);
    if (state.stopped) return false;
    if (state.startedAt === null) {
      const readme = Buffer.from('﻿' + COLOR_BLOCK_README, 'utf8');
      const started = Buffer.from(JSON.stringify({ startedAt: new Date(now).toISOString(), stopsAt: new Date(now + COLOR_BLOCK_LIMITS.stopAfterMs).toISOString(),
        note: 'I-031 色块诊断日志：从这个时间起 14 天后不再写。' }, null, 2) + '\n', 'utf8');
      if (state.bytes + readme.length + started.length > COLOR_BLOCK_LIMITS.totalBytes) { state.stopped = true; return false; }
      await writeAtomic(path.join(directory, 'README.txt'), readme);
      await writeAtomic(path.join(directory, 'started.json'), started);
      state.bytes += readme.length + started.length;
      state.startedAt = now;
    }
    const stamp = localStamp(now);
    const app = { version: text(this.options.version, 40), commit: this.options.commit && /^[0-9a-f]{7,40}$/.test(this.options.commit) ? this.options.commit : null,
      channel: this.options.channel };
    if (report.kind === 'near') {
      if (state.nearLines.length >= COLOR_BLOCK_LIMITS.nearLines) return false;
      const line = JSON.stringify({ at: new Date(now).toISOString(), local: stamp.text, ...app, ...report });
      if (Buffer.byteLength(line) > COLOR_BLOCK_LIMITS.nearLineBytes) return false;
      const lines = [...state.nearLines, line], content = Buffer.from(lines.join('\n') + '\n', 'utf8');
      const previous = state.nearLines.length ? Buffer.byteLength(state.nearLines.join('\n') + '\n') : 0;
      if (state.bytes - previous + content.length > COLOR_BLOCK_LIMITS.totalBytes) return false;
      await writeAtomic(path.join(directory, 'near-misses.jsonl'), content);
      state.bytes += content.length - previous;
      state.nearLines = lines;
      return true;
    }
    if (state.blocks >= COLOR_BLOCK_LIMITS.blocks) return false;
    let processes: ProcessCounts | null = null;
    try { processes = await (this.options.countProcesses ?? countProcesses)(); } catch { processes = null; }
    const base = `block-${stamp.file}`;
    const pictures = { found: report.images.found, after: report.images.after };
    const names = { found: pictures.found ? `${base}-found.png` : null, after: pictures.after ? `${base}-after.png` : null };
    const { images: _images, frames: rows, ...rest } = report;
    const build = (withImages: boolean) => formatRecord({ what: 'I-031 色块诊断日志：一次色块', at: new Date(now).toISOString(), local: stamp.text, app, processes, ...rest,
      images: withImages ? names : { found: null, after: null, dropped: 'size' } }, rows);
    let json = Buffer.from(build(true), 'utf8');
    let imageBytes = (pictures.found?.length ?? 0) + (pictures.after?.length ?? 0);
    if (state.bytes + json.length + imageBytes > COLOR_BLOCK_LIMITS.totalBytes) { json = Buffer.from(build(false), 'utf8'); imageBytes = 0; }
    if (json.length > COLOR_BLOCK_LIMITS.jsonBytes || state.bytes + json.length + imageBytes > COLOR_BLOCK_LIMITS.totalBytes) return false;
    if (imageBytes) {
      if (pictures.found) await writeAtomic(path.join(directory, names.found!), pictures.found);
      if (pictures.after) await writeAtomic(path.join(directory, names.after!), pictures.after);
    }
    await writeAtomic(path.join(directory, `${base}.json`), json);
    state.bytes += json.length + imageBytes;
    state.blocks++;
    return true;
  }
}

/** Pretty JSON, but each frame column on one line (easy to read side by side). */
function formatRecord(record: Record<string, unknown>, rows: ColorBlockFrames): string {
  const head = JSON.stringify(record, null, 2);
  const columns = COLOR_BLOCK_FRAME_COLUMNS.map(column => `    ${JSON.stringify(column)}: ${JSON.stringify(rows[column])}`).join(',\n');
  return `${head.slice(0, head.lastIndexOf('}')).trimEnd()},\n  "frames": {\n${columns}\n  }\n}\n`;
}

/** What electron/main.ts calls once: the log for this run's channel, or one that writes nothing when there is no folder. */
export function createColorBlockLog(options: { channel: string | null | undefined; version: string; commit: string | null;
  env?: Record<string, string | undefined> }): ColorBlockLog {
  const channel = channelOf(options.channel);
  return new ColorBlockLog({ directory: colorBlockDirectory(options.env ?? process.env, channel), channel, version: options.version, commit: options.commit });
}
