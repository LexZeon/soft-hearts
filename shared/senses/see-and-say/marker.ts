/**
 * I-166: her own closer look is a hidden marker she may write once in a reply,
 * ⟦look-camera⟧ or ⟦look-screen⟧. Like the speech-beat markers (shared/behaviors/speech-beats/choose.ts) it is taken out of the stream
 * before anything else sees it: never shown, read aloud or archived. Pure; no clock, no model.
 *
 * The form is chosen so a marker this filter somehow missed is still dropped whole by the speech-beat filter that runs right after it
 * (a ⟦ with letters and hyphens only, not a beat word, is dropped there), so it can never show. A few spellings she may slip into
 * (a colon or a space instead of the hyphen, any case) count too; anything else after ⟦ is handed on unchanged.
 */
export type LookSense = 'camera' | 'screen';
export const LOOK_SENSES: readonly LookSense[] = ['camera', 'screen'];

/** The canonical markers (what her prompt names). */
export const LOOK_MARKER: Readonly<Record<LookSense, string>> = Object.freeze({ camera: '⟦look-camera⟧', screen: '⟦look-screen⟧' });

const SPELLINGS: ReadonlyMap<string, LookSense> = new Map(LOOK_SENSES.flatMap(sense =>
  ['-', ':', ' ', '_'].map(join => [`⟦look${join}${sense}⟧`, sense] as [string, LookSense])));
const OPEN = '⟦';
const MAX = Math.max(...[...SPELLINGS.keys()].map(key => key.length));
const prefixOfMarker = (held: string): boolean => { for (const key of SPELLINGS.keys()) if (key.startsWith(held)) return true; return false; };

/** `at[i]`: where in `text` marker `marks[i]` stood (the text before it, in this chunk, is `text.slice(0, at[i])`). */
export interface LookMarkerChunk { text: string; marks: LookSense[]; at: number[] }

/**
 * One filter per stream: push each chunk, end once. A ⟦ is held (at most the length of the longest spelling) until it is clearly a look
 * marker (taken out, reported in `marks`) or clearly not one (handed on unchanged, for the speech-beat filter downstream).
 */
export class LookMarkerFilter {
  private held = '';
  private ended = false;

  push(chunk: string): LookMarkerChunk { return this.run(typeof chunk === 'string' ? chunk : '', false); }

  /** The stream ended: what is held goes out unchanged (an unclosed ⟦look-ca… is the speech-beat filter's to drop). */
  end(): LookMarkerChunk {
    const last = this.run('', true);
    this.ended = true;
    return last;
  }

  /** Characters held right now (tests). */
  get holding(): number { return this.held.length; }

  private run(input: string, final: boolean): LookMarkerChunk {
    if (this.ended) return { text: '', marks: [], at: [] };
    const queue = Array.from(input), marks: LookSense[] = [], at: number[] = [];
    let out = '';
    while (queue.length) {
      const char = queue.shift()!;
      if (!this.held) { if (char === OPEN) this.held = char; else out += char; continue; }
      this.held += char;
      const lower = this.held.toLowerCase(), sense = SPELLINGS.get(lower);
      if (sense) { marks.push(sense); at.push(out.length); this.held = ''; continue; }
      if (prefixOfMarker(lower) && this.held.length < MAX) continue;
      // Not a look marker: its first character goes on unchanged, the rest is read again (a new ⟦ may start inside it).
      const held = this.held;
      this.held = '';
      out += held.charAt(0);
      queue.unshift(...Array.from(held.slice(1)));
    }
    if (final && this.held) { out += this.held; this.held = ''; }
    return { text: out, marks, at };
  }
}

/** A whole text at once (tests, replay). */
export function stripLookMarkers(text: string): LookMarkerChunk {
  const filter = new LookMarkerFilter();
  const first = filter.push(text), last = filter.end();
  return { text: first.text + last.text, marks: [...first.marks, ...last.marks], at: [...first.at, ...last.at.map(index => index + first.text.length)] };
}
