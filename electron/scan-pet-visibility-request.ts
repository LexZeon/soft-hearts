/** A bounded, non-authoritative hint for one literal current human message.
 * The host still owns identity, confirmation, execution and the actual receipt. */
export type PetVisibilityTextHint = 'show' | 'hide' | 'ambiguous' | 'none';

const MAX_LENGTH = 256;
const STRUCTURED = /[\r\n\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff"'`“”‘’「」『』<>:：\\/]/u;
const ZH_PET = '(?:桌宠(?:窗口)?|桌面宠物|softhearts|soft-hearts)';
const EN_PET = '(?:the (?:desktop )?pet|the desktop companion|soft hearts|soft-hearts)';
const zhShow = new RegExp(`^(?:(?:把|将)${ZH_PET}(?:显示|展示)(?:出来)?|(?:显示|展示)${ZH_PET}(?:出来)?|让${ZH_PET}(?:显示出来|出现))$`, 'u');
const zhHide = new RegExp(`^(?:(?:把|将)${ZH_PET}(?:隐藏(?:起来)?|藏起来)|(?:隐藏|藏起)${ZH_PET}|让${ZH_PET}(?:隐藏(?:起来)?|藏起来))$`, 'u');
const zhAmbiguous = new RegExp(`^(?:(?:我)?(?:看不到|找不到|没看到)${ZH_PET}(?:了)?|${ZH_PET}(?:不见了|看不到了|消失了)|(?:切换|调整)${ZH_PET}(?:的)?(?:显示|可见|显隐|显示隐藏)(?:状态)?|(?:显示|隐藏)还是(?:显示|隐藏)${ZH_PET}|(?:不要|别|不)(?:显示|隐藏)${ZH_PET}|(?:把|将)?(?:它|这个|那个|窗口)(?:显示|隐藏)|(?:显示|隐藏)(?:它|这个|那个|窗口))$`, 'u');
const enShow = new RegExp(`^(?:show|display) ${EN_PET}$`, 'u');
const enHide = new RegExp(`^hide ${EN_PET}$`, 'u');
const enAmbiguous = new RegExp(`^(?:(?:i )?(?:cannot|can not|can't) (?:see|find) ${EN_PET}|${EN_PET} (?:is missing|disappeared)|(?:toggle|change) (?:the )?(?:visibility of ${EN_PET}|${EN_PET}(?:'s)? visibility)|(?:show|hide) (?:it|the window)|(?:do not|don't) (?:show|hide) ${EN_PET})$`, 'u');

/** No substring extraction from narration, quotations or unrelated instructions.
 * A narrowly recognized second topmost clause is retained for host arbitration. */
export function scanPetVisibilityRequest(input: unknown): PetVisibilityTextHint {
  if (typeof input !== 'string' || !input || input.length > MAX_LENGTH) return 'none';
  const cleaned = input.replace(/\bcan['’]t\b/giu, 'cannot').replace(/\bdon['’]t\b/giu, 'do not');
  if (STRUCTURED.test(cleaned)) return 'none';
  const normalized = cleaned.normalize('NFKC').trim();
  if (!normalized || normalized.length > MAX_LENGTH || STRUCTURED.test(normalized)) return 'none';
  const sentence = normalized.replace(/[。.!！?？]+$/u, '').trim();
  if (!sentence) return 'none';
  let zh = sentence.toLowerCase().replace(/ +/gu, '');
  for (let i = 0; i < 3; i++) {
    const next = zh.replace(/^(?:请你|请|麻烦你|麻烦|可以帮我|能不能帮我|能不能|帮我)/u, '');
    if (next === zh) break;
    zh = next;
  }
  zh = zh.replace(/(?:一下|好吗|好么|可以吗|行吗|吗)$/u, '');
  const topmost = /^(.*?)(?:并且|并|然后|再)(?:保持|取消|开启|关闭|解除)?(?:桌宠的?|softhearts的?)?置顶$/u.exec(zh);
  const directZh = topmost ? topmost[1] : zh;
  if (zhShow.test(directZh)) return 'show';
  if (zhHide.test(directZh)) return 'hide';
  if (!topmost && zhAmbiguous.test(zh)) return 'ambiguous';

  const en = sentence.toLowerCase().replace(/\s+/gu, ' ')
    .replace(/^(?:please |can you |could you |would you )/u, '').replace(/^please /u, '');
  const enMixed = /^(.*?)(?: and | then )(?:keep|make) (?:it|the pet) (?:always )?on top$/u.exec(en);
  const directEn = enMixed ? enMixed[1] : en;
  if (enShow.test(directEn)) return 'show';
  if (enHide.test(directEn)) return 'hide';
  if (!enMixed && enAmbiguous.test(en)) return 'ambiguous';
  return 'none';
}
