/** A bounded current-human text hint. It never saves settings or grants consent. */
export type ReadoutVolumeTextHint =
  | { kind: 'none' }
  | { kind: 'explicit'; percent: number }
  | { kind: 'ambiguous'; percent?: number; direction?: 'up' | 'down' }
  | { kind: 'invalid' };

const structured = /[\r\n\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff"'`“”‘’「」『』<>:：\\/]/u;
const target = '(?:(?:桌宠|softhearts|soft-hearts)的?)?(?:(?:语音)?朗读|播报|读出)(?:的)?(?:音量|声音)';
const anyTarget = `(?:${target}|音量|声音)`;
const zhAbsolute = new RegExp(`^(?:(?:把|将)?(${anyTarget})(?:设为|设置为|设置到|设成|调到|调为|调整到|调整为|改为|改成)|(?:设置|调整)(${anyTarget})(?:为|到))(?:(百分之))?([^%]+)(%)?$`, 'u');
const zhRelative = new RegExp(`^(?:(?:把|将)?${anyTarget}(?:调|调整)?(?:大|小|高|低)(?:一?点|一些)|(?:调大|调小|提高|降低|增加|减少)${anyTarget}(?:一点|一些|[0-9]+%)?|(?:把|将)?${anyTarget}(?:提高|降低|增加|减少)[0-9]+%)$`, 'u');
const zhChange = new RegExp(`^(?:(?:调整|设置|改变)${anyTarget}(?:一下)?|${anyTarget}(?:调整|怎么调))$`, 'u');

function integerPercent(text: string): number | null {
  if (/^\d+$/u.test(text)) {
    const value = Number(text);
    return Number.isSafeInteger(value) && value >= 0 && value <= 100 ? value : null;
  }
  const digits = '零一二三四五六七八九';
  if (text === '〇') return 0;
  if (text === '一百') return 100;
  if (text.length === 1 && digits.includes(text)) return digits.indexOf(text);
  const match = /^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/u.exec(text);
  return match ? (match[1] ? digits.indexOf(match[1]) : 1) * 10 + (match[2] ? digits.indexOf(match[2]) : 0) : null;
}

export function scanReadoutVolumeRequest(input: unknown): ReadoutVolumeTextHint {
  if (typeof input !== 'string' || !input || input.length > 256 || structured.test(input)) return { kind: 'none' };
  const text = input.normalize('NFKC').trim();
  if (!text || text.length > 256 || structured.test(text)) return { kind: 'none' };
  const sentence = text.replace(/[。.!！?？]+$/u, '').trim();
  let zh = sentence.toLowerCase().replace(/ +/gu, '');
  for (let i = 0; i < 3; i++) {
    const next = zh.replace(/^(?:请你|请|麻烦你|麻烦|帮我|能不能帮我|可以帮我)/u, '');
    if (next === zh) break;
    zh = next;
  }
  zh = zh.replace(/(?:一下|好吗|可以吗)$/u, '');
  const absolute = zhAbsolute.exec(zh);
  if (absolute) {
    const named = absolute[1] ?? absolute[2], percent = integerPercent(absolute[4]);
    if (percent === null) return { kind: 'invalid' };
    return /朗读|播报|读出/u.test(named) && !!(absolute[3] || absolute[5])
      ? { kind: 'explicit', percent } : { kind: 'ambiguous', percent };
  }
  if (zhRelative.test(zh)) return { kind: 'ambiguous', direction: /小|低|减少/u.test(zh) ? 'down' : 'up' };
  if (zhChange.test(zh)) return { kind: 'ambiguous' };
  const en = sentence.toLowerCase().replace(/\s+/gu, ' ').replace(/^(?:please |can you |could you )/u, '');
  const match = /^(?:set|change|adjust) ((?:(?:readout|reading|speech|tts) )?volume) to ([^ %]+)(%)?$/u.exec(en);
  if (match) {
    const percent = integerPercent(match[2]);
    if (percent === null) return { kind: 'invalid' };
    return match[1] !== 'volume' && !!match[3] ? { kind: 'explicit', percent } : { kind: 'ambiguous', percent };
  }
  if (/^(?:turn|make) (?:the )?(?:(?:readout|reading|speech|tts) )?volume (?:up|down|louder|quieter)$/u.test(en))
    return { kind: 'ambiguous', direction: /down|quieter/u.test(en) ? 'down' : 'up' };
  return { kind: 'none' };
}
