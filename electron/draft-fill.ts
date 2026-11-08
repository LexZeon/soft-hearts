import type { MoodLabel } from '../shared/mood';

/**
 * F4: when the draft filter (electron/reply-draft-guard.ts) leaves nothing of a reply, she still says a short line of her own
 * instead of an empty bubble or an error. No model call (the first character must not wait): a line from a small pool,
 * keyed to how she feels now, never the same one twice in a row. The lines are character-neutral and never start with an
 * ellipsis (docs/claude/2026-11-07-care-openings-empty.md). This is a fallback; the host's journal notes it as "filled".
 */
type FillMood = 'warm' | 'low' | 'tense' | 'calm';

const MOOD_GROUP: Readonly<Record<MoodLabel, FillMood>> = {
  calm: 'calm', close: 'warm', content: 'warm', happy: 'warm', excited: 'warm', relieved: 'warm',
  concerned: 'tense', 'tense-expectation': 'tense',
  disappointed: 'low', upset: 'low', sad: 'low', longing: 'low',
};

export const DRAFT_FILL_LINES: Readonly<Record<FillMood, readonly string[]>> = {
  calm: [
    '嗯，我刚才走神了一下，你再说一遍好不好？',
    '唔，刚才没接上你的话，能再说一次吗？',
    '咦，我脑子里空了一下，再讲一遍嘛。',
    '刚刚晃神了，对不起，再说一次给我听？',
  ],
  warm: [
    '哎呀，我光顾着开心，话都没说出口，你再说一遍嘛。',
    '我刚才笑得走神了，你再说一次好不好？',
    '等等等等，我刚才没听进去，再讲一遍给我听。',
    '嘿嘿，我分心了一下，你再说一次嘛。',
  ],
  low: [
    '对不起，我刚才有点发愣，你再说一遍好吗？',
    '我刚刚没打起精神，没接住你的话，能再说一次吗？',
    '嗯，我走神了，别生气，再说一次给我听。',
    '抱歉，刚才脑子慢了一拍，你再讲一遍好吗？',
  ],
  tense: [
    '等一下，我刚才没理好思路，你再说一遍，我认真听。',
    '我刚才没抓住重点，你再说一次好吗？',
    '稍等，我刚才想岔了，再讲一遍给我听。',
    '对不起，我刚才没跟上，再说一次，我听着。',
  ],
};

export class DraftFillLines {
  private readonly last = new Map<string, string>();
  constructor(private readonly random: () => number = Math.random) {}

  /** One line for `primary` (her mood label), never the one she said last for this `key` (a character). */
  pick(primary: MoodLabel | string, key: string): string {
    const pool = DRAFT_FILL_LINES[MOOD_GROUP[primary as MoodLabel] ?? 'calm'];
    const last = this.last.get(key);
    const options = pool.filter(line => line !== last);
    const line = options[Math.min(options.length - 1, Math.floor(this.random() * options.length))];
    this.last.set(key, line);
    return line;
  }
}
