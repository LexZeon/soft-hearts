import type { PetFramingPreset } from './pet-framing';

/** Hint only. Main reclassifies its accepted current-human message and creates a one-use ticket. */
export function scanFramingRequest(value: unknown): PetFramingPreset | 'ambiguous' | 'none' {
  if (typeof value !== 'string' || !value || value.length > 160
    || /[\r\n\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff"'`“”‘’「」『』<>:：\\/]/u.test(value)) return 'none';
  const text = value.normalize('NFKC').trim().toLowerCase().replace(/[。.!！?？]+$/u, '').trim();
  const zh = text.replace(/ +/gu, '').replace(/^(?:请你|请|麻烦你|麻烦|帮我)/u, '');
  if (/^(?:(?:把|给)?(?:当前)?(?:桌宠|你)(?:切到|改成|调成|调整为|设为|显示)?(?:全身|全身取景)|(?:切到|改成|调整为)(?:桌宠)?全身(?:取景)?|全身取景)(?:一下|好吗|可以吗)?$/u.test(zh)
    || /^(?:please )?(?:show|frame) (?:the )?(?:current )?pet (?:in )?(?:full body|full-body)$/u.test(text)) return 'full';
  if (/^(?:(?:把|给)?(?:当前)?(?:桌宠|你)(?:切到|改成|调成|调整为|设为|显示)?(?:近景|近景取景|半身取景)|(?:切到|改成|调整为)(?:桌宠)?近景(?:取景)?|近景取景)(?:一下|好吗|可以吗)?$/u.test(zh)
    || /^(?:please )?(?:show|frame) (?:the )?(?:current )?pet (?:in )?(?:portrait|close-up)$/u.test(text)) return 'portrait';
  if (/^(?:(?:把|让)?(?:桌宠|你)?(?:拉近|靠近|拉远|远一点|近一点|换个取景|调整取景|调整镜头)(?:一点|点|一下)?|(?:桌宠)?(?:全身|近景)(?:还是|或)(?:全身|近景)(?:取景)?|取景)$/u.test(zh)
    || /^(?:please )?(?:zoom in|zoom out|change framing|adjust framing)$/u.test(text)) return 'ambiguous';
  return 'none';
}
