/**
 * Unbound v1 step 3 (docs/claude/2026-11-17-unbound-step3.md; scope: a table of her name and what the user calls her, appended automatically): the names the
 * user calls her by. Her real name is her card's; what the user calls her grows from the chat (only names the user really said) and
 * the user can add and remove them; what she calls the user stays the one name the user agreed to (shared/memory/relationship.ts).
 * The table is what "calling her" listens for in Unbound (electron/senses/voiceprint/wake.ts). Pure; tests/nickname-table.test.ts.
 */
import { cleanNickname } from './relationship';

/** At most this many names the user calls her (the oldest leaves first). */
export const HER_NICKNAMES_MAX = 12;
/** A name shorter than this is never listened for (a single character is said by accident far too often). */
export const WAKE_NAME_MIN_CHARS = 2;

/** What the control window shows (her current character). */
export interface NicknameTableView {
  /** Her card's name (not removable here: it is her name). */
  herName: string | null;
  /** What the user calls her, oldest first. */
  herNicknames: string[];
  /** What she calls the user (the one the user agreed to), or null. */
  userNickname: string | null;
}

const key = (name: string) => name.normalize('NFKC').toLowerCase();

/** The list with `name` added at the end (an existing one moves to the end: it is the newest again). Null name: unchanged. */
export function withHerNickname(list: readonly string[], raw: unknown): string[] {
  const name = cleanNickname(raw);
  if (!name) return [...list];
  const next = list.filter(item => key(item) !== key(name));
  next.push(name);
  return next.slice(-HER_NICKNAMES_MAX);
}

/** The list without `name` (compared as the user would read it). */
export function withoutHerNickname(list: readonly string[], raw: unknown): string[] {
  const name = cleanNickname(raw);
  return name ? list.filter(item => key(item) !== key(name)) : [...list];
}

/** A stored list as written: plain names only, no duplicates, at most HER_NICKNAMES_MAX; null when it is not one. */
export function cleanHerNicknames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > HER_NICKNAMES_MAX) return null;
  let list: string[] = [];
  for (const item of value) {
    const name = cleanNickname(item);
    if (!name || name !== item) return null;
    list = withHerNickname(list, name);
  }
  return list.length === value.length ? list : null;
}

/** Text as compared for "was it said": NFKC, lower case, without spaces and punctuation. */
export function spokenForm(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** The name really appears in what the user wrote or said (only then is it added on its own). */
export function saidInText(name: unknown, text: unknown): boolean {
  const clean = cleanNickname(name);
  if (!clean || typeof text !== 'string' || !text) return false;
  const needle = spokenForm(clean);
  return needle.length > 0 && spokenForm(text).includes(needle);
}

/** The names that count as calling her: her real name and what the user calls her, at least WAKE_NAME_MIN_CHARS each. */
export function wakeNames(view: Pick<NicknameTableView, 'herName' | 'herNicknames'>): string[] {
  const out: string[] = [], seen = new Set<string>();
  for (const raw of [view.herName, ...view.herNicknames]) {
    if (typeof raw !== 'string') continue;
    const form = spokenForm(raw);
    if (Array.from(form).length < WAKE_NAME_MIN_CHARS || seen.has(form)) continue;
    seen.add(form); out.push(raw);
  }
  return out;
}

/** Which of `names` the recognized text contains, as written (no sound-alikes: that needs a pinyin table, not downloaded). */
export function nameHeard(text: unknown, names: readonly string[]): string | null {
  if (typeof text !== 'string' || !text) return null;
  const said = spokenForm(text);
  for (const name of names) { const form = spokenForm(name); if (form && said.includes(form)) return name; }
  return null;
}
