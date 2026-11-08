/** Non-authoritative hint about a single current human message. The host owns
 * identity, choices, setting writes and receipts. Unsupported forms stay chat. */
export type FollowMouseTextHint = 'on' | 'off' | 'ambiguous' | 'none';

const MAX_LENGTH = 256;
const STRUCTURED = /[\r\n\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff"'`“”‘’「」『』<>:：\\/]/u;
const pet = '(?:桌宠|桌面宠物|softhearts|soft-hearts)';
const setting = '(?:鼠标视线跟随|视线跟随鼠标|鼠标视线|视线鼠标跟随|鼠标跟随)';
const on = new RegExp(`^(?:(?:开启|打开|启用)(?:${pet}的?)?${setting}|让${pet}(?:的)?(?:视线|眼睛)(?:跟随|看着)鼠标)$`, 'u');
const off = new RegExp(`^(?:(?:关闭|关掉|禁用|停止|取消)(?:${pet}的?)?${setting}|(?:不要|别|停止)让${pet}(?:的)?(?:视线|眼睛)(?:跟随|看着)鼠标)$`, 'u');
const ambiguous = new RegExp(`^(?:(?:切换|调整)(?:${pet}的?)?${setting}(?:设置|状态)?|(?:${pet}的?)?${setting}(?:开还是关|开启还是关闭)|(?:不要|别)(?:开启|关闭)(?:${pet}的?)?${setting})$`, 'u');
const enSetting = '(?:mouse gaze(?: following| tracking)?|mouse following|gaze (?:following|tracking) (?:the )?mouse|mouse-following gaze)';
const enPet = '(?:the (?:desktop )?pet|the desktop companion|soft hearts|soft-hearts)';
const enOn = new RegExp(`^(?:(?:enable|turn on|start) ${enSetting}(?: for ${enPet})?|(?:make|let) ${enPet} gaze follow (?:the )?mouse)$`, 'u');
const enOff = new RegExp(`^(?:(?:disable|turn off|stop) ${enSetting}(?: for ${enPet})?|stop ${enPet} gaze following (?:the )?mouse)$`, 'u');
const enAmbiguous = new RegExp(`^(?:(?:toggle|change) ${enSetting}(?: for ${enPet})?|(?:do not|dont) (?:enable|disable|turn on|turn off) ${enSetting}(?: for ${enPet})?)$`, 'u');

/** Anchored grammar deliberately does not extract from quotes or other tasks.
 * No mixed-action phrases are recognized; arbitration remains with the caller. */
export function scanFollowMouseRequest(input: unknown): FollowMouseTextHint {
  if (typeof input !== 'string' || !input || input.length > MAX_LENGTH || STRUCTURED.test(input)) return 'none';
  const normalized = input.normalize('NFKC').trim();
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
  if (on.test(zh)) return 'on';
  if (off.test(zh)) return 'off';
  if (ambiguous.test(zh)) return 'ambiguous';
  const en = sentence.toLowerCase().replace(/\s+/gu, ' ')
    .replace(/^(?:please |can you |could you |would you )/u, '').replace(/^please /u, '');
  if (enOn.test(en)) return 'on';
  if (enOff.test(en)) return 'off';
  if (enAmbiguous.test(en)) return 'ambiguous';
  return 'none';
}
