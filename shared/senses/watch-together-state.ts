// I-187 和她一起看 as ONE switch.
// On = she sees the screen (screen sharing) AND hears the dialogue (the computer's sound with words: the 'movie' purpose of 读取音频).
// Off = both stop. 「和她一起听」 for music stays its own choice (the 'music' purpose); the two share one capture and never switch each
// other off.
//
// Pure: what the eye button says (watchTogetherLook) and what one click changes (watchTogetherPlan). The companion window renders
// the first (src/stage/watch-together-button.ts) and acts on the second (src/senses/watch-together-toggle.ts). Strings are Chinese
// source keys; the English copies are in shared/foundation/ui-copy.listen.en.ts.

import type { AudioReadingView } from '../voice';

/** Whether the dialogue reaches her right now while words are on. */
export type DialogueHearing = 'hearing' | 'starting' | 'paused' | 'error' | 'off';

export interface WatchTogetherFacts {
  /** Screen sharing is on. */
  screen: boolean;
  /** The host's 读取音频 view (null before the first one arrived). */
  view: Pick<AudioReadingView, 'sources'> | null | undefined;
}

export interface WatchTogetherLook {
  /** Screen and dialogue both on: the button is pressed. */
  on: boolean;
  seeing: boolean;
  /** 一起看's own dialogue part (the 'movie' purpose). */
  dialogue: boolean;
  /** Whether words of the computer's sound reach her (from 一起看's dialogue, or from 「和她一起听」's words). */
  hearing: DialogueHearing;
  /** She is looking at the screen but the dialogue does not reach her: the button must say so (a mark and its tooltip). */
  notHeard: boolean;
  /** The tooltip (a Chinese source key). */
  tooltip: string;
}

export const WATCH_TOGETHER_TOOLTIPS = Object.freeze({
  off: '和她一起看：点一下，她看你的屏幕，也听视频里的台词',
  hearing: '和她一起看：开着，在看画面，也在听台词。点一下都关掉',
  starting: '和她一起看：开着，在看画面；台词还没听到，正在准备…',
  paused: '和她一起看：开着，在看画面；你说话或她朗读时，台词先停一下',
  error: '和她一起看：在看画面，但台词没在听（没能听到电脑的声音）。点两下关掉再打开',
  screenOnly: '和她一起看：只在看画面，台词没在听。点一下也听台词',
  screenWithListen: '和她一起看：在看画面，台词跟着「和她一起听」在听。点一下开成一起看',
  dialogueOnly: '和她一起看：在听台词，画面没在看。点一下也看画面',
} as const);

/** The words of the computer's sound are on (either purpose) and where the capture is. */
function hearingOf(view: WatchTogetherFacts['view']): DialogueHearing {
  const system = view?.sources?.['system-audio'];
  if (!system || (system.music?.intent !== true && system.movie?.intent !== true)) return 'off';
  const phase = system.capture?.phase;
  return phase === 'ready' ? 'hearing' : phase === 'paused' ? 'paused' : phase === 'error' ? 'error' : 'starting';
}

/** What the eye button shows. Whenever she sees the screen and the dialogue does not reach her, `notHeard` is true and the tooltip says so. */
export function watchTogetherLook(facts: WatchTogetherFacts): WatchTogetherLook {
  const seeing = facts.screen === true;
  const dialogue = facts.view?.sources?.['system-audio']?.movie?.intent === true;
  const hearing = hearingOf(facts.view);
  const on = seeing && dialogue;
  const notHeard = seeing && hearing !== 'hearing';
  const tooltip = on
    ? (hearing === 'hearing' ? WATCH_TOGETHER_TOOLTIPS.hearing : hearing === 'paused' ? WATCH_TOGETHER_TOOLTIPS.paused
      : hearing === 'error' ? WATCH_TOGETHER_TOOLTIPS.error : WATCH_TOGETHER_TOOLTIPS.starting)
    : seeing ? (hearing === 'off' ? WATCH_TOGETHER_TOOLTIPS.screenOnly : hearing === 'hearing' ? WATCH_TOGETHER_TOOLTIPS.screenWithListen
      : hearing === 'paused' ? WATCH_TOGETHER_TOOLTIPS.paused : hearing === 'error' ? WATCH_TOGETHER_TOOLTIPS.error : WATCH_TOGETHER_TOOLTIPS.starting)
    : dialogue ? WATCH_TOGETHER_TOOLTIPS.dialogueOnly : WATCH_TOGETHER_TOOLTIPS.off;
  return { on, seeing, dialogue, hearing, notHeard, tooltip };
}

export interface WatchTogetherPlan {
  /** Where the click takes 一起看: on unless both parts are already on. */
  target: boolean;
  /** Screen sharing to set, or null to leave it. */
  screen: boolean | null;
  /** 一起看's dialogue (the 'movie' purpose) to set, or null to leave it. Never touches 「和她一起听」's music. */
  dialogue: boolean | null;
}

/** One click: both on, or (when both are on) both off. Turning it off always stops its dialogue. */
export function watchTogetherPlan(facts: { screen: boolean; dialogue: boolean }): WatchTogetherPlan {
  const target = !(facts.screen && facts.dialogue);
  return { target, screen: facts.screen !== target ? target : null, dialogue: facts.dialogue !== target ? target : null };
}
