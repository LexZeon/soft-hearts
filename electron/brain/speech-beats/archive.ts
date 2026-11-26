/**
 * 边说边演第 2 步：聊天记录旁边的一个小文件 `speech-beats.json`，记每条有拍子的回复演了什么。
 *
 * 聊天记录本身（electron/memory/memory.ts）只存去掉标记的字，一条回复只存一次：只演不说的那条，正文是空的。这里另记：
 * 哪个角色和连接（散列）、哪一轮、拍子（封闭词表的词和位置）、灰色小字。不存她的话，也不存用户的话。
 *  - 她的长对话窗口（I-134）读聊天记录时，开关开着就把标记插回她自己的话里（只演不说的那条也就进得了她的历史）；关着时不用它。
 *  - 旧版本不认这个文件，也不会坏：聊天记录的格式没有变（退回旧版本照样读得了聊天记录）。
 * 最多留 MAX_ENTRIES 条（最新的）。读坏了、不存在就当空的，从不让聊天失败；只在 record 时写盘，一次一个，原子写。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../../foundation/atomic-file';
import { isSpeechBeatWord, keptBeat } from '../../../shared/behaviors/speech-beats/choose';
import { withSpeechBeatMarkers } from '../../../shared/behaviors/speech-beats/history';
import type { SpeechBeat } from '../../../shared/behaviors/speech-beats/interface';
import type { MemoryScope } from '../../../shared/memory';
import type { CardLanguage } from '../../../shared/foundation/character-card';
import { cleanCut, cutMarkerText, cutPlace, type CutRecord } from '../../../shared/foundation/reply-cut';

/** A beat as the file keeps it: the closed word, its place, and (I-175) her closed "how long" when she wrote one. */
const kept = (beat: SpeechBeat): SpeechBeat => keptBeat(beat); // I-203: a pause keeps its "long"

export const SPEECH_BEATS_FILE = 'speech-beats.json';
export const SPEECH_BEATS_MAX_ENTRIES = 400;

/** What the recycle bin keeps of a scope's (or a record's) entries: no words of anyone, only the vocabulary's words, positions and the grey line. */
export interface SpeechBeatsPart { items: { turn: string; beats: SpeechBeat[]; line: string; performanceOnly: boolean; at: number; cut?: CutRecord }[] }

/** `cut` (2026-11-23/24): where and why her words stopped before the end (shared/foundation/reply-cut.ts): offsets and a closed cause, no words; it goes where the reply goes. */
interface Entry { key: string; beats: SpeechBeat[]; line: string; performanceOnly: boolean; at: number; cut?: CutRecord }

/** The same shape of scope key as her chat archive's (a hash of the character and the connection scope). */
export function speechBeatScopeKey(scope: MemoryScope): string {
  return createHash('sha256').update(JSON.stringify([String(scope?.characterId ?? ''), String(scope?.providerScope ?? '')])).digest('hex');
}

function readEntries(raw: unknown): Entry[] {
  if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1 || !Array.isArray((raw as { entries?: unknown }).entries)) return [];
  const out: Entry[] = [];
  for (const value of (raw as { entries: unknown[] }).entries.slice(-SPEECH_BEATS_MAX_ENTRIES)) {
    const entry = value as Partial<Entry> | null;
    if (!entry || typeof entry.key !== 'string' || entry.key.length > 300 || !Array.isArray(entry.beats)) continue;
    const beats = entry.beats.filter((beat): beat is SpeechBeat => !!beat && isSpeechBeatWord((beat as SpeechBeat).word) && Number.isSafeInteger((beat as SpeechBeat).at) && (beat as SpeechBeat).at >= 0)
      .slice(0, 32).map(kept);
    const cut = cleanCut(entry.cut);
    if (!beats.length && !cut) continue;
    out.push({ key: entry.key, beats, line: typeof entry.line === 'string' ? entry.line.slice(0, 200) : '', performanceOnly: entry.performanceOnly === true,
      at: typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0, ...(cut ? { cut } : {}) });
  }
  return out;
}

export class SpeechBeatArchive {
  private entries: Entry[] = [];
  private readonly index = new Map<string, Entry>();
  private writes: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(directory: string, private readonly writeFile: AtomicFileWriter = atomicWriteFile, read: (file: string) => string = file => readFileSync(file, 'utf8')) {
    this.file = path.join(directory, SPEECH_BEATS_FILE);
    try { this.entries = readEntries(JSON.parse(read(this.file))); } catch { this.entries = []; }
    for (const entry of this.entries) this.index.set(entry.key, entry);
  }

  /** One finished reply that had beats (nothing is written for one without). Never throws into the chat path. */
  record(scope: MemoryScope, turnId: string, outcome: { beats: readonly SpeechBeat[]; line: string; performanceOnly: boolean }, now = Date.now()): Promise<void> {
    if (!outcome.beats.length || typeof turnId !== 'string' || !turnId) return Promise.resolve();
    const key = `${speechBeatScopeKey(scope)}|${turnId.slice(0, 100)}`;
    const cut = this.index.get(key)?.cut; // a cut filed while she was still writing stays
    const entry: Entry = { key, beats: outcome.beats.slice(0, 32).map(kept), line: outcome.line.slice(0, 200), performanceOnly: outcome.performanceOnly, at: now, ...(cut ? { cut } : {}) };
    return this.commit([...this.entries.filter(item => item.key !== key), entry]);
  }

  /**
   * Where and why her words stopped before the end of this reply (2026-11-23/24): the one place every kind of cut is filed, a voice barge-in now,
   * a kiss or hug cut short later (electron/brain/speech-beats/cuts.ts is the public door). Beats already filed for the turn stay. Never throws.
   */
  recordCut(scope: MemoryScope, turnId: string, cut: CutRecord, now = Date.now()): Promise<void> {
    const clean = cleanCut(cut);
    if (!clean || typeof turnId !== 'string' || !turnId) return Promise.resolve();
    const key = `${speechBeatScopeKey(scope)}|${turnId.slice(0, 100)}`, old = this.index.get(key);
    const entry: Entry = { key, beats: old?.beats ?? [], line: old?.line ?? '', performanceOnly: old?.performanceOnly === true, at: old?.at ?? now, cut: clean };
    return this.commit([...this.entries.filter(item => item.key !== key), entry]);
  }

  /** Replaces the entries (newest MAX_ENTRIES kept), refreshes the index and writes the file (one write at a time, in order). */
  private commit(next: Entry[]): Promise<void> {
    this.entries = next.slice(-SPEECH_BEATS_MAX_ENTRIES);
    this.index.clear();
    for (const item of this.entries) this.index.set(item.key, item);
    const data = JSON.stringify({ version: 1, entries: this.entries });
    const run = () => this.writeFile(this.file, data);
    const result = this.writes.then(run, run).catch(() => { /* a lost line only loses the markers in her long window */ });
    this.writes = result;
    return result;
  }

  /** Resolves when every write started so far is done (tests, and the quit path). */
  flush(): Promise<void> { return this.writes; }

  // ---- Privacy: this file describes replies, so it leaves and comes back with them (data map row 'speech-beats'; docs/claude/2026-11-20-speech-beats-leftovers.md) ----

  /** A deleted record's turns (the chat store's own scope key, which is the same hash): their entries go, nothing of those replies stays. */
  removeTurns(scopeKeyOfChat: string, turnIds: readonly string[]): Promise<void> {
    const gone = new Set(turnIds.map(id => `${scopeKeyOfChat}|${String(id).slice(0, 100)}`));
    if (!this.entries.some(entry => gone.has(entry.key))) return Promise.resolve();
    return this.commit(this.entries.filter(entry => !gone.has(entry.key)));
  }

  /** Every entry of the scope goes (deleting her chat for a character and connection). */
  removeScope(scope: MemoryScope): Promise<void> {
    const prefix = `${speechBeatScopeKey(scope)}|`;
    if (!this.entries.some(entry => entry.key.startsWith(prefix))) return Promise.resolve();
    return this.commit(this.entries.filter(entry => !entry.key.startsWith(prefix)));
  }

  /** What the scope has, as a copy the bin keeps (null: nothing). Nothing changes. */
  copyScope(scope: MemoryScope): SpeechBeatsPart | null { return this.copyWhere(`${speechBeatScopeKey(scope)}|`, () => true); }

  /** What these turns have (the chat record that is about to be deleted); null: nothing. Nothing changes. */
  copyTurns(scope: MemoryScope, turnIds: readonly string[]): SpeechBeatsPart | null {
    const wanted = new Set(turnIds.map(id => String(id).slice(0, 100)));
    return this.copyWhere(`${speechBeatScopeKey(scope)}|`, turn => wanted.has(turn));
  }

  private copyWhere(prefix: string, take: (turn: string) => boolean): SpeechBeatsPart | null {
    const items = this.entries.filter(entry => entry.key.startsWith(prefix) && take(entry.key.slice(prefix.length)))
      .map(entry => ({ turn: entry.key.slice(prefix.length), beats: entry.beats.map(kept), line: entry.line, performanceOnly: entry.performanceOnly, at: entry.at, ...(entry.cut ? { cut: { ...entry.cut } } : {}) }));
    return items.length ? { items } : null;
  }

  /** Puts a copy back under the scope (an entry of the same turn is replaced). A part that is not ours rejects, before anything changes. */
  restore(scope: MemoryScope, part: unknown): Promise<void> {
    const items = (part as SpeechBeatsPart | null)?.items;
    if (!Array.isArray(items) || items.length > SPEECH_BEATS_MAX_ENTRIES * 4) return Promise.reject(new Error('回收站里这一项的数据不完整，原文件已保留。'));
    const prefix = `${speechBeatScopeKey(scope)}|`;
    const back = readEntries({ version: 1, entries: items.map(item => ({ ...item, key: `${prefix}${String((item as { turn?: unknown })?.turn ?? '').slice(0, 100)}` })) });
    if (!back.length) return Promise.resolve();
    const keys = new Set(back.map(entry => entry.key));
    return this.commit([...this.entries.filter(entry => !keys.has(entry.key)), ...back].sort((a, b) => a.at - b.at));
  }

  /** What was kept for this turn (null: no beats). */
  get(scope: MemoryScope, turnId: string): { beats: readonly SpeechBeat[]; line: string; performanceOnly: boolean; cut?: CutRecord } | null {
    const entry = this.index.get(`${speechBeatScopeKey(scope)}|${turnId}`);
    return entry ? { beats: entry.beats, line: entry.line, performanceOnly: entry.performanceOnly, ...(entry.cut ? { cut: entry.cut } : {}) } : null;
  }

  /** The cut record of this reply (null: it was said to the end), with the quiet marker the chat window shows at its place in a reply of `length` characters. */
  cutShown(scope: MemoryScope, turnId: string, length: number, language: CardLanguage | null | undefined): { at: number; label: string } | null {
    const cut = this.index.get(`${speechBeatScopeKey(scope)}|${turnId}`)?.cut;
    return cut ? { at: cutPlace(cut, length).at, label: cutMarkerText(cut, language) } : null;
  }

  /**
   * For her long-chat window: her reply as she wrote it (markers back in) while the switch is on; null leaves the archive's text.
   * Off: always null (the archive's clean words; a performance-only turn has none and stays out).
   */
  /**
   * 2026-11-23: a reply that was cut also comes back with the cut marker at its place (own line, whatever the switch says), so later turns know
   * which part the user heard; the archive's text is unchanged (the marker is made here, never stored in the words).
   */
  replyFor(scope: MemoryScope, on: boolean, language?: CardLanguage | null): ((turnId: string, content: string) => string | null) | undefined {
    const key = speechBeatScopeKey(scope);
    return (turnId, content) => {
      const entry = this.index.get(`${key}|${turnId}`), text = typeof content === 'string' ? content : '';
      if (!entry || (!on && !entry.cut)) return null;
      const beats = on ? entry.beats : [];
      if (!entry.cut || !text.trim()) return on ? withSpeechBeatMarkers(text, beats) : null;
      const at = cutPlace(entry.cut, text.length).at, marker = cutMarkerText(entry.cut, language);
      const before = withSpeechBeatMarkers(text.slice(0, at), beats.filter(beat => beat.at < at)).replace(/\s+$/u, '');
      const after = withSpeechBeatMarkers(text.slice(at), beats.filter(beat => beat.at >= at).map(beat => ({ ...beat, at: beat.at - at }))).replace(/^\s+/u, '');
      return [before, marker, after].filter(part => part).join('\n');
    };
  }
}
