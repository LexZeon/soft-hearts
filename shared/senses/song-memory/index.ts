/**
 * I-077 step 2: the songs she knows, as a handful of numbers each (docs/claude/2026-11-11-i077-step2.md).
 *
 * A fingerprint is the numbers of a song's first seconds (tempo, the three bands' shares, brightness, how plucked it sounds, onset
 * density) and the lengths of its first sections. No audio, no title, no words, no time of day; it stays in the profile directory, one
 * file per character (electron/senses/song-memory.ts), is cleared on request, never goes into a card export and is never sent anywhere.
 *
 * Recognition is cautious on purpose: a song needs several plays on record, its numbers must be within the tolerances of the song
 * heard now AND clearly nearer than any other song on record. A near-duplicate (the same tempo with another sound, a remix, a cover)
 * is therefore either its own song or no match, never a wrong "again this one". Pure: no files, no clock (the caller passes the day).
 */
import { SONG_MEMORY_KNOBS } from './knobs';

/** What the stage measures of one song (the intro's numbers; `sec`: the first section changes, seconds from the song's start). */
export interface SongSketch {
  /** The locked tempo in beats per minute; 0 = no beat was locked. */
  bpm: number;
  /** The low, mid and high bands' shares of the sound (sum 1). */
  bands: [number, number, number];
  bright: number;
  pluck: number;
  /** Onsets per second. */
  dens: number;
  sec: number[];
}
export interface SongPrint extends SongSketch {
  /** A random id (not derived from the sound); it only tells one print from another. */
  id: string;
  plays: number;
  /** The last day it was heard (days since 1970). */
  last: number;
}
export interface SongMatch { id: string; distance: number; plays: number }

const SKETCH_KEYS = ['bpm', 'bands', 'bright', 'pluck', 'dens', 'sec'];
const PRINT_KEYS = [...SKETCH_KEYS, 'id', 'plays', 'last'];
const MAX_SECTIONS = 4;
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const inRange = (x: unknown, lo: number, hi: number): x is number => finite(x) && x >= lo && x <= hi;
const round = (x: number, places = 3) => { const f = 10 ** places; return Math.round(x * f) / f; };

/** Numbers only, in range, no other key: anything else is not a sketch (null). The result is a fresh, rounded copy. */
export function validateSketch(value: unknown): SongSketch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !SKETCH_KEYS.includes(key))) return null;
  if (!(inRange(v.bpm, 0, 400) && inRange(v.bright, 0, 1) && inRange(v.pluck, 0, 1) && inRange(v.dens, 0, 40))) return null;
  if (!Array.isArray(v.bands) || v.bands.length !== 3 || !v.bands.every(b => inRange(b, 0, 1))) return null;
  if (!Array.isArray(v.sec) || v.sec.length > MAX_SECTIONS || !v.sec.every(s => inRange(s, 0, 900))) return null;
  const sec = (v.sec as number[]).slice().sort((a, b) => a - b).map(s => round(s, 1));
  return { bpm: round(v.bpm, 1), bands: [round(v.bands[0]), round(v.bands[1]), round(v.bands[2])], bright: round(v.bright), pluck: round(v.pluck), dens: round(v.dens, 2), sec };
}
export function validatePrint(value: unknown): SongPrint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !PRINT_KEYS.includes(key))) return null;
  if (typeof v.id !== 'string' || !/^[0-9a-f]{8}$/.test(v.id) || !finite(v.plays) || !Number.isInteger(v.plays) || v.plays < 1 || v.plays > 99_999 || !finite(v.last) || !Number.isInteger(v.last) || v.last < 0 || v.last > 1_000_000) return null;
  const { id, plays, last, ...rest } = v;
  const sketch = validateSketch(rest);
  return sketch ? { ...sketch, id: id as string, plays: plays as number, last: last as number } : null;
}

export interface SongDistance { /** Root mean square of the terms (1 = every number exactly at its tolerance). */ d: number; /** The largest single term. */ worst: number }

/** How far two songs' numbers are apart, each term in units of its tolerance (the sections are not part of it: they are not known at the intro). */
export function songDistance(a: SongSketch, b: SongSketch): SongDistance {
  const k = SONG_MEMORY_KNOBS.recognition, terms: number[] = [];
  if (a.bpm > 0 && b.bpm > 0) {
    const direct = Math.abs(Math.log(a.bpm / b.bpm)), folded = Math.min(Math.abs(Math.log(2 * a.bpm / b.bpm)), Math.abs(Math.log(a.bpm / (2 * b.bpm))));
    // A double or half tempo (the beat found an octave away) counts as one full tolerance on top of what is left.
    terms.push(Math.min(direct, folded + k.bpmRatio) / k.bpmRatio);
  } else terms.push(a.bpm > 0 || b.bpm > 0 ? 1.2 : 0);
  terms.push((Math.abs(a.bands[0] - b.bands[0]) + Math.abs(a.bands[1] - b.bands[1]) + Math.abs(a.bands[2] - b.bands[2])) / k.bands);
  terms.push(Math.abs(a.bright - b.bright) / k.bright);
  terms.push(Math.abs(a.pluck - b.pluck) / k.pluck);
  terms.push(Math.abs(a.dens - b.dens) / Math.max(1, Math.max(a.dens, b.dens)) / k.density);
  return { d: Math.sqrt(terms.reduce((s, t) => s + t * t, 0) / terms.length), worst: Math.max(...terms) };
}

/** The first section changes of two plays of one song agree (or one of them has none yet). */
const sectionsAgree = (a: readonly number[], b: readonly number[]) => !a.length || !b.length || Math.abs(a[0]! - b[0]!) <= SONG_MEMORY_KNOBS.keep.sectionSeconds;

const newId = (taken: ReadonlySet<string>, random: () => number): string => {
  for (let i = 0; i < 50; i++) { const id = Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0'); if (!taken.has(id)) return id; }
  let n = taken.size; while (taken.has(n.toString(16).padStart(8, '0'))) n++;
  return n.toString(16).padStart(8, '0');
};

export class SongMemory {
  private prints: SongPrint[];
  constructor(prints: readonly SongPrint[] = [], private readonly random: () => number = Math.random) {
    this.prints = prints.map(p => ({ ...p, bands: [...p.bands] as SongPrint['bands'], sec: [...p.sec] }));
  }
  get size(): number { return this.prints.length; }
  /** A copy (the numbers only). */
  list(): SongPrint[] { return this.prints.map(p => ({ ...p, bands: [...p.bands] as SongPrint['bands'], sec: [...p.sec] })); }

  /** The nearest known song when the numbers heard now are within tolerance, it has been heard enough times and no other song comes close. */
  match(sketch: SongSketch): SongMatch | null {
    const k = SONG_MEMORY_KNOBS.recognition;
    let best: { p: SongPrint; r: SongDistance } | null = null, second = Infinity;
    for (const p of this.prints) {
      const r = songDistance(sketch, p);
      if (!best || r.d < best.r.d) { if (best) second = Math.min(second, best.r.d); best = { p, r }; }
      else second = Math.min(second, r.d);
    }
    if (!best || best.p.plays < k.minPlays || best.r.d > k.limit || best.r.worst > k.worst) return null;
    if (second <= k.limit * 1.6 && second < k.margin * best.r.d) return null; // another song is nearly as near: not sure which
    return { id: best.p.id, distance: best.r.d, plays: best.p.plays };
  }

  /** One more play of a song (the end of a song that was heard long enough): into the nearest print of the same song, or a new print. */
  learn(sketch: SongSketch, today: number): { id: string; plays: number; added: boolean } {
    const k = SONG_MEMORY_KNOBS.recognition, keep = SONG_MEMORY_KNOBS.keep;
    let best: { p: SongPrint; r: SongDistance } | null = null;
    for (const p of this.prints) {
      const r = songDistance(sketch, p);
      if (r.d <= k.limit && r.worst <= k.worst && sectionsAgree(sketch.sec, p.sec) && (!best || r.d < best.r.d)) best = { p, r };
    }
    let entry: SongPrint, added = false;
    if (best) {
      entry = best.p;
      const w = Math.min(entry.plays, keep.meanWeight), mix = (old: number, now: number) => (old * w + now) / (w + 1);
      // A tempo found an octave away this time is brought to the print's own octave before averaging.
      let bpm = sketch.bpm;
      if (bpm > 0 && entry.bpm > 0) { const r = bpm / entry.bpm; if (r > 1.7 && r < 2.3) bpm /= 2; else if (r > 0.43 && r < 0.59) bpm *= 2; }
      entry.bpm = bpm > 0 && entry.bpm > 0 ? round(mix(entry.bpm, bpm), 1) : entry.bpm > 0 ? entry.bpm : round(bpm, 1);
      entry.bands = [round(mix(entry.bands[0], sketch.bands[0])), round(mix(entry.bands[1], sketch.bands[1])), round(mix(entry.bands[2], sketch.bands[2]))];
      entry.bright = round(mix(entry.bright, sketch.bright)); entry.pluck = round(mix(entry.pluck, sketch.pluck)); entry.dens = round(mix(entry.dens, sketch.dens), 2);
      entry.sec = entry.sec.map((s, i) => i < sketch.sec.length && Math.abs(s - sketch.sec[i]!) <= keep.sectionSeconds ? round(mix(s, sketch.sec[i]!), 1) : s);
      for (let i = entry.sec.length; i < sketch.sec.length && i < MAX_SECTIONS; i++) entry.sec.push(sketch.sec[i]!);
      entry.plays = Math.min(99_999, entry.plays + 1); entry.last = today;
    } else {
      entry = { ...sketch, bands: [...sketch.bands] as SongPrint['bands'], sec: [...sketch.sec], id: newId(new Set(this.prints.map(p => p.id)), this.random), plays: 1, last: today };
      this.prints.push(entry); added = true;
    }
    this.prune(entry, today);
    return { id: entry.id, plays: entry.plays, added };
  }

  private prune(keep: SongPrint, today: number): void {
    const k = SONG_MEMORY_KNOBS.keep;
    this.prints = this.prints.filter(p => p === keep || !(p.plays <= 1 && today - p.last > k.staleDays));
    if (this.prints.length > k.maxSongs) {
      const order = this.prints.filter(p => p !== keep).sort((a, b) => a.plays - b.plays || a.last - b.last);
      const drop = new Set(order.slice(0, this.prints.length - k.maxSongs));
      this.prints = this.prints.filter(p => !drop.has(p));
    }
  }

  /** Forget everything; how many songs there were. */
  clear(): number { const n = this.prints.length; this.prints = []; return n; }
}

/** The file's body: numbers only. */
export function serializeSongMemory(memory: SongMemory): string { return JSON.stringify({ version: 1, songs: memory.list() }); }
/** Reads a file's text; a row that is not exactly numbers in range is dropped. Throws when the file is not a song memory at all. */
export function parseSongMemory(text: string): SongPrint[] {
  const data = JSON.parse(text) as { version?: unknown; songs?: unknown };
  if (!data || typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.songs)) throw new Error('Invalid song memory');
  const out: SongPrint[] = [], seen = new Set<string>();
  for (const row of data.songs) { const p = validatePrint(row); if (p && !seen.has(p.id)) { seen.add(p.id); out.push(p); } }
  return out.slice(0, SONG_MEMORY_KNOBS.keep.maxSongs);
}
