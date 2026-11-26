// Where the kept sentences live: <profile>/voice-keep/<YYYY-MM-DD>/<time>_<reply>_<NN>.wav with a .json sidecar beside it. This store only
// writes those two files per sentence, removes whole day folders (by their date name; nothing else in the folder is ever touched, so the
// settings and the event file survive a sweep or 清空) and measures the size. Nothing here knows about models, windows or the network.
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VOICE_KEEP_FOLDER } from './knobs';
import { pcmToWav } from './wav';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The local date of a moment as YYYY-MM-DD (a day is the user's own day). */
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** The oldest day that is still kept: today and the days - 1 before it. */
export function oldestKeptDay(now: number, days: number): string {
  const d = new Date(now);
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (Math.max(1, days) - 1), 12).getTime());
}

/** What the sidecar says about one sentence (names, ids and her words; never the user's side of anything). */
export interface KeptSentence {
  at: number;
  characterId: string | null;
  characterName: string | null;
  provider: 'bailian' | 'fish';
  voiceId: string;
  model?: string;
  text: string;
  readAs?: string;
  replyId: string | null;
  sentenceIndex: number | null;
  /** The reply's first-sentence clock, so a reply's sentences sort together in the folder. */
  replyAt: number;
}
const two = (n: number) => String(n).padStart(2, '0');
const clock = (at: number) => { const d = new Date(at); return `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`; };
const safe = (value: string | null, max: number) => (value ?? 'none').replace(/[^A-Za-z0-9_-]/g, '').slice(0, max) || 'none';

export class VoiceKeepStore {
  constructor(private readonly profileDirectory: string) {}
  get root(): string { return path.join(this.profileDirectory, VOICE_KEEP_FOLDER); }

  /** Writes the sentence's .wav and .json; returns the bytes written. A name taken already gets a counter. */
  async keep(entry: KeptSentence, pcm: Buffer): Promise<number> {
    const day = path.join(this.root, dayKey(entry.at));
    await mkdir(day, { recursive: true });
    const base = `${clock(entry.replyAt)}_${safe(entry.replyId, 24)}_${entry.sentenceIndex === null ? 'xx' : two(entry.sentenceIndex)}`;
    const wav = pcmToWav(pcm);
    for (let attempt = 0; attempt < 50; attempt++) {
      const name = attempt === 0 ? base : `${base}_${attempt + 1}`;
      try {
        await writeFile(path.join(day, `${name}.wav`), wav, { flag: 'wx' });
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
      const sidecar = { time: new Date(entry.at).toISOString(), characterId: entry.characterId, characterName: entry.characterName, provider: entry.provider,
        voiceId: entry.voiceId, ...(entry.model ? { model: entry.model } : {}), text: entry.text, ...(entry.readAs ? { readAs: entry.readAs } : {}),
        replyId: entry.replyId, sentenceIndex: entry.sentenceIndex, audio: `${name}.wav`, format: 'wav 24000 Hz mono 16-bit', bytes: wav.length };
      await writeFile(path.join(day, `${name}.json`), JSON.stringify(sidecar, null, 2), 'utf8');
      return wav.length;
    }
    throw new Error('no free file name');
  }

  /** The day folders on disk, oldest first (only YYYY-MM-DD names). */
  async days(): Promise<string[]> {
    try { return (await readdir(this.root, { withFileTypes: true })).filter(e => e.isDirectory() && DAY.test(e.name)).map(e => e.name).sort(); }
    catch { return []; }
  }

  /** Removes the day folders older than the days the user chose; returns how many. Newer days and every other file stay. */
  async sweep(now: number, days: number): Promise<number> {
    const oldest = oldestKeptDay(now, days);
    let removed = 0;
    for (const day of await this.days()) {
      if (day >= oldest) continue;
      try { await rm(path.join(this.root, day), { recursive: true, force: true }); removed++; } catch { /* tried again next sweep */ }
    }
    return removed;
  }

  /** 清空: every day folder (the settings and the event file stay); returns how many. */
  async clear(): Promise<number> {
    let removed = 0;
    for (const day of await this.days()) {
      try { await rm(path.join(this.root, day), { recursive: true, force: true }); removed++; } catch { /* the rest still goes */ }
    }
    return removed;
  }

  /** Bytes and sentence count on disk (the .wav files). */
  async measure(): Promise<{ bytes: number; sentences: number }> {
    let bytes = 0, sentences = 0;
    for (const day of await this.days()) {
      let names: string[] = [];
      try { names = await readdir(path.join(this.root, day)); } catch { continue; }
      for (const name of names) {
        try { const s = await stat(path.join(this.root, day, name)); bytes += s.size; if (name.endsWith('.wav')) sentences++; } catch { /* gone meanwhile */ }
      }
    }
    return { bytes, sentences };
  }
}
