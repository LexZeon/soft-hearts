/**
 * C2 角色页：一点就换 (docs/claude/2026-11-03-character-page-plan.md, confirmed 2026-11-03). What the card wall shows
 * for each character. Display data only: no path, no private text beyond the card's own name and a short line of its
 * persona, no memory content. The picture is a data URL the host reads from its own avatar folder or the model's
 * folder (electron/character-avatars.ts).
 */
export type CharacterModelState =
  /** No model linked: switching keeps the model on stage. */
  | 'none'
  /** The preinstalled Gene. */
  | 'bundled'
  /** A local model file that is there. */
  | 'ok'
  /** A local model file that is gone: the card asks the user to choose it again. */
  | 'missing';

export interface CharacterRosterEntry {
  id: string;
  name: string;
  /** One line of her personality (or description); '' when the card has none yet. */
  tagline: string;
  active: boolean;
  /** The preinstalled Gene card (it always goes with the preinstalled Gene model). */
  preset: boolean;
  model: { state: CharacterModelState; name: string | null };
  avatar: { kind: 'snapshot' | 'preview' | 'initial'; dataUrl: string | null; initial: string };
  /** 认识第 N 天; null before the first chat. */
  knownDay: number | null;
  /** Her last chat with the user (ms), on the current chat connection; null when none. */
  lastChatAt: number | null;
}

export interface CharacterRosterView {
  entries: CharacterRosterEntry[];
  activeId: string;
  /** The card revision this view was built from. */
  revision: number;
  /** A switch waiting for her current line to finish. */
  pendingSwitchId: string | null;
}

/** First sentence of the personality, else of the description, at most 40 characters. */
export function characterTagline(card: { personality?: string; description?: string }): string {
  for (const source of [card.personality ?? '', card.description ?? '']) {
    const text = source.replace(/\s+/gu, ' ').trim();
    if (!text) continue;
    const first = text.split(/(?<=[。！？!?；;])\s*|\n/u)[0]?.trim() || text;
    const chars = [...first];
    return chars.length > 40 ? `${chars.slice(0, 39).join('')}…` : first;
  }
  return '';
}

/** The name's first letter for the drawn picture ("G" for Gene, "小" for 小满). */
export function characterInitial(name: string): string {
  const first = [...String(name ?? '').trim()][0] ?? '?';
  return first.toLocaleUpperCase();
}
