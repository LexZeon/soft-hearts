// I-139 chat assembly (A1; docs/claude/2026-11-15-i139-chat.md, plan docs/claude/2026-11-15-i139-big-rewrite-plan.md 六 and 八).
// Everything here is used only while the I-139 switch is on (shared/brain/prompt-switches.ts `relaxed`); the callers pass it in, so with the
// switch off nothing here runs and every prompt stays byte for byte what it was. Pure: no I/O, no clock, no persona or user data of its own.
//
// Three things:
//  1. the fixed system prompt, in the agreed order (relaxedSystemPrompt);
//  2. the opening's layers 1 and 2, put in front of the persona at the final assembly (openingLayers / withOpeningLayers);
//  3. "said once per Claude process" lines (perception, 三方互通): the host hands the session the exact lines it put into this turn's
//     context, and the session leaves out a line its process has already been told, unless it changed or this turn carries a picture
//     or sound (planOnceLines / applyOnceSwaps). Kept per PROCESS, never per conversation: after any restart (a long-chat rollover, a
//     prewarmed replacement, an app restart, a crash) the first real turn says every line again, so she never takes a sense she was
//     not told about as off, nor one she was told about as on after it changed (a "she cannot see the screen" line said on every turn).
import { COMPANION_CARE, PERCEPTION_RELAXED, STRANGER_LINE, SYSTEM_OPENING, TECH_NOTES, i139Text, openingLayerOne, openingLayerTwo, type I139Language } from '../../shared/foundation/i139-texts';
import { cardLanguageOf, type CardLanguage } from '../../shared/foundation/character-card';
import { COMPANION_REFUSAL_RULES } from '../../shared/brain/companion-refusal-rules';
import { perceptionTurnLine, type PerceptionTurn } from '../../shared/brain/perception-rule';
import type { HerStateNow } from '../../shared/mood';
import { OPENING_SYSTEM_SENTENCE } from './reply-opening';

/** What the opening needs under the switch: the card's name (layer 1) and language. Present only while the switch is on. */
export interface RelaxedChat {
  name: string;
  language?: I139Language | null;
}

/** Layer 2's value: the thing that moved her most (A3 supplies it; absent or null: no layer 2). */
export type OpeningMemory = { date: string; text: string } | null;

/**
 * The fixed system prompt under the switch, in this order: who she is (SYSTEM_OPENING), how she cares (COMPANION_CARE, in place of the
 * numbered rules and every why variant), the refusal section only when it is on, what she can perceive, the settings catalog when the
 * caller has one, the technical notes, and the opening-marker sentence as today (same words, appended to the last paragraph as it was
 * appended to the old base text).
 */
export function relaxedSystemPrompt(options: { language?: I139Language | null; refusal: boolean; refusalText?: string; settingsCatalog?: string | null; opening: boolean }): string {
  const language = options.language ?? null;
  return [
    i139Text(SYSTEM_OPENING, language),
    i139Text(COMPANION_CARE, language),
    options.refusal ? options.refusalText ?? COMPANION_REFUSAL_RULES : '',
    i139Text(PERCEPTION_RELAXED, language),
    options.settingsCatalog ?? '',
    i139Text(TECH_NOTES, language),
  ].filter(Boolean).join('\n') + (options.opening ? OPENING_SYSTEM_SENTENCE : '');
}

/** Layers 1 and 2 of the opening, one paragraph each ('' for a nameless card: nothing is invented). */
export function openingLayers(chat: RelaxedChat, memory?: OpeningMemory): string {
  const name = chat.name.trim();
  return [name ? openingLayerOne(name, chat.language) : '', openingLayerTwo(memory, chat.language)].filter(Boolean).join('\n\n');
}

/** `persona` (the composed opening persona) with the layers in front. Applied at the final assembly, never inside basePersona. */
export function withOpeningLayers(persona: string, chat: RelaxedChat | null | undefined, memory?: OpeningMemory): string {
  if (!chat) return persona;
  const layers = openingLayers(chat, memory);
  return layers ? `${layers}\n\n${persona}` : persona;
}

/**
 * One line of this turn's private context that a process needs to hear only once (and again when it changes).
 * `text` is exactly what the host put into the context. `stable` is what counts as "the same" (default `text`): for perception, the
 * sight part only, so a touch or a hearing sentence riding on one turn does not make the next turn look changed. `fresh` replaces `text`
 * when this process has not been told the line yet (perception: the full hearing sentence, which the host otherwise says once per
 * conversation). `always`: this turn carries news in the line (a picture, a sound, a touch): said whatever was told before.
 */
export interface OnceLine {
  key: string;
  text: string;
  stable?: string;
  fresh?: string;
  always?: boolean;
}

/** One change to this turn's context: `from` (a line, exactly) becomes `to` ('' leaves the line out, with its separator). */
export interface OnceSwap { from: string; to: string }

/**
 * Which lines this process hears this turn. `told` is what the process has been told (key → stable), `picture`: the turn carries an
 * image. Returns the swaps to apply to the turn's context and what to remember once the message is written.
 */
export function planOnceLines(told: ReadonlyMap<string, string>, lines: readonly OnceLine[], picture: boolean): { swaps: OnceSwap[]; tell: [string, string][] } {
  const swaps: OnceSwap[] = [], tell: [string, string][] = [];
  for (const line of lines) {
    if (!line || typeof line.key !== 'string' || typeof line.text !== 'string' || !line.text) continue;
    const stable = line.stable ?? line.text;
    const before = told.get(line.key);
    if (before === undefined) {
      if (line.fresh && line.fresh !== line.text) swaps.push({ from: line.text, to: line.fresh });
      tell.push([line.key, stable]);
    } else if (line.always || picture || before !== stable) tell.push([line.key, stable]);
    else swaps.push({ from: line.text, to: '' });
  }
  return { swaps, tell };
}

/**
 * The context with the swaps applied. A line is found as a whole paragraph or line (after "\n\n" or "\n", or at the very start); a line
 * left out takes that separator with it. A line that is not found changes nothing, so a mismatch only ever means "said once more".
 */
export function applyOnceSwaps(context: string, swaps: readonly OnceSwap[]): string {
  let out = context;
  for (const swap of swaps) {
    if (!swap.from) continue;
    let at = -1;
    for (let from = 0; from <= out.length;) {
      const index = out.indexOf(swap.from, from);
      if (index < 0) break;
      const end = index + swap.from.length;
      const startsLine = index === 0 || out[index - 1] === '\n';
      const endsLine = end === out.length || out[end] === '\n';
      if (startsLine && endsLine) { at = index; break; }
      from = index + 1;
    }
    if (at < 0) continue;
    if (swap.to) { out = out.slice(0, at) + swap.to + out.slice(at + swap.from.length); continue; }
    const cut = out.startsWith('\n\n', at - 2) ? 2 : out[at - 1] === '\n' ? 1 : 0;
    const lead = at - cut === 0 && out.startsWith('\n\n', at + swap.from.length) ? 2 : 0; // the very first paragraph: take the blank after it
    out = out.slice(0, at - cut) + out.slice(at + swap.from.length + lead);
  }
  return out;
}

/**
 * What electron/main.ts reads at the app edge, in one object (so the chat handler gains one name, not six): whether the switch is on
 * with the active card's name and language, the window's labels, layer 2's value, the stranger line, the perception once-line.
 * Every reader is guarded: a failing card read keeps the switch's texts with no name (layer 1 is then left out, never invented).
 */
export interface I139ChatEdge {
  relaxed(): RelaxedChat | null;
  labels(): { relaxed: true; language: I139Language | null } | null;
  /** The active card's language whatever the switch (I-071; 'zh-CN' when the card cannot be read): the chat window's leak rule (long-chat/history.ts). */
  cardLanguage(): CardLanguage;
  openingMemory(scope: unknown): OpeningMemory;
  stranger(chat: RelaxedChat | null | undefined): string | undefined;
  perceptionOnce: typeof perceptionOnceLine;
}
export function i139ChatEdge(ports: { on(): boolean; card(): { name?: unknown; language?: unknown } | null | undefined; openingMemory?(scope: unknown): OpeningMemory }): I139ChatEdge {
  const relaxed = (): RelaxedChat | null => {
    let on = false;
    try { on = ports.on() === true; } catch { on = false; }
    if (!on) return null;
    try { const card = ports.card(); return { name: typeof card?.name === 'string' ? card.name : '', language: cardLanguageOf(card) }; }
    catch { return { name: '', language: null }; }
  };
  return {
    relaxed,
    labels: () => { const chat = relaxed(); return chat ? { relaxed: true, language: chat.language ?? null } : null; },
    cardLanguage: () => { try { return cardLanguageOf(ports.card()); } catch { return 'zh-CN'; } },
    openingMemory: scope => { try { return ports.openingMemory?.(scope) ?? null; } catch { return null; } },
    stranger: chat => chat ? i139Text(STRANGER_LINE, chat.language) : undefined,
    perceptionOnce: perceptionOnceLine,
  };
}

/**
 * The perception line as a once-line: `sight` is this turn's perception, `hearing` what electron/mood/her-state-host.ts gave for it. The line
 * is perceptionTurnLine(sight, hearing) exactly (what the host puts into the context); the stable part is the sight alone; a turn that
 * carries a picture, a transcript, a hearing sentence or a touch is news and always said.
 */
export function perceptionOnceLine(sight: PerceptionTurn, hearing?: HerStateNow, sound = false): OnceLine {
  const text = perceptionTurnLine(sight, hearing);
  const stable = perceptionTurnLine(sight);
  const fresh = hearing ? perceptionTurnLine(sight, { ...hearing, say: 'full' }) : text;
  const picture = sight.attached.screen || sight.attached.camera;
  const always = picture || sound || hearing?.hearing.transcript === true || text !== stable;
  return { key: 'perception', text, stable, ...(fresh !== text ? { fresh } : {}), ...(always ? { always: true } : {}) };
}
