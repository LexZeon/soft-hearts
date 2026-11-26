// I-112 / I-115 prompt switches (docs/claude/2026-11-14-i112-i115-prompts.md). Independent switches so the blind test can toggle them:
//  why:       I-112 A + C + the principle-6 sync in the companion rules (shared/brain/companion-rules.ts). true: the full block (round 1);
//             'short': round 2's short why at the very start of the fixed prompt plus the anti-draft line;
//  situation: I-115 A + C, her mood told as a situation instead of numbers, and the mood recorder reading her whole personality section;
//  route:     round 2's routed mode (shared/brain/prompt-route.ts): per turn the program decides, from her mood and the user's message,
//             whether the situation text and/or the short why are used. With route on, `situation` and `why` are not read for those two.
// Defaults follow I-098 (electron/brain/speak-only/rules.ts): on in the development channel and in source runs, off in the stable channel.
// The development default stays full why + situation until the round-2 results; route is never on by default.
// relaxed:   I-139 (docs/claude/2026-11-15-i139-big-rewrite-plan.md): every text she reads comes from shared/foundation/i139-texts.ts instead.
//             Effective only together with I-098 speak-only (relaxedPromptsActive); off by default in every channel until the two
//             gates pass; SOFT_HEARTS_PROMPT_I139 = 1 turns it on for experiments.
// With everything off every prompt is byte for byte what it was. The app sets them once at start (electron/main.ts); tests and the
// blind-test harness pass explicit options to the assemblers instead.
import type { WhyMode } from './companion-rules';

export interface PromptSwitches { why: boolean | 'short'; situation: boolean; route?: boolean; relaxed?: boolean }

/** Stable channel values: all off until the usual acceptance (user's I-030 nightly rule). */
export const PROMPT_SWITCHES_STABLE: PromptSwitches = { why: false, situation: false };

export type PromptSwitchChannel = 'stable' | 'development' | null | undefined;

/**
 * Development channel and source runs. Back to all off on 2026-11-14 (round 2 of the blind test: the user picked replies written by a
 * Claude who knows the user on all 30 pages; the why versions produced 5 of 90 broken replies, the others 0). The user did not answer
 * this recommendation; it was taken while the user was away and can be undone here or with SOFT_HEARTS_PROMPT_WHY / _SITUATION = 1.
 */
export const PROMPT_SWITCHES_DEVELOPMENT: PromptSwitches = { why: false, situation: false };

/** Every channel off now (development since 2026-11-14, stable always); the environment variables still turn a switch on for experiments. */
export function promptSwitchDefaults(channel: PromptSwitchChannel, packaged: boolean): PromptSwitches {
  if (channel === 'development') return { ...PROMPT_SWITCHES_DEVELOPMENT };
  if (channel === 'stable') return { ...PROMPT_SWITCHES_STABLE };
  return packaged ? { ...PROMPT_SWITCHES_STABLE } : { ...PROMPT_SWITCHES_DEVELOPMENT };
}

/** SOFT_HEARTS_PROMPT_WHY = 0, 1 or short; SOFT_HEARTS_PROMPT_SITUATION, _ROUTE and _I139 = 0 or 1 override one switch (development use). */
export function promptSwitchesFromEnv(base: PromptSwitches, env: Record<string, string | undefined>): PromptSwitches {
  const read = (value: string | undefined, fallback: boolean) => value === '1' ? true : value === '0' ? false : fallback;
  const raw = env.SOFT_HEARTS_PROMPT_WHY;
  const why: PromptSwitches['why'] = raw === 'short' ? 'short' : raw === '1' ? true : raw === '0' ? false : base.why;
  const route = read(env.SOFT_HEARTS_PROMPT_ROUTE, base.route === true);
  const relaxed = read(env.SOFT_HEARTS_PROMPT_I139, base.relaxed === true);
  return { why, situation: read(env.SOFT_HEARTS_PROMPT_SITUATION, base.situation), ...(route ? { route } : {}), ...(relaxed ? { relaxed } : {}) };
}

/** The why mode the FIXED system prompt is assembled with: route on means 'routed' (the per-turn router decides the why itself). */
export function systemWhyMode(switches: PromptSwitches): WhyMode {
  return switches.route === true ? 'routed' : switches.why;
}

let current: PromptSwitches = { ...PROMPT_SWITCHES_STABLE };
export function getPromptSwitches(): PromptSwitches { return current; }
export function setPromptSwitches(next: PromptSwitches): void {
  current = { why: next.why === 'short' ? 'short' : next.why === true, situation: next.situation === true, ...(next.route === true ? { route: true } : {}), ...(next.relaxed === true ? { relaxed: true } : {}) };
}

/** I-139 is used only when its switch is on AND speak-only (I-098) is on (plan 六 item 4). */
export function relaxedPromptsActive(switches: PromptSwitches, speakOnly: boolean): boolean {
  return switches.relaxed === true && speakOnly === true;
}
