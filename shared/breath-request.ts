/** Literal hint only; accepted current-human identity and execution remain host-owned. */
export type BreathRequest = { kind: 'none' | 'on' | 'off' | 'ambiguous' | 'invalid' }
  | { kind: 'percent'; percent: number };
export function scanBreathRequest(value: unknown): BreathRequest {
  if (typeof value !== 'string' || !value || value.length > 256
    || /[\r\n\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff"'`“”‘’「」『』<>:：\\/]/u.test(value)) return { kind: 'none' };
  const text = value.normalize('NFKC').trim().toLowerCase().replace(/[。.!！?？]+$/u, '').trim();
  const zh = text.replace(/ +/gu, '').replace(/^(?:请你|请|麻烦你|麻烦|帮我)/u, '');
  const subject = '(?:(?:桌宠|桌面宠物)的?)?呼吸(?:强度|设置)?';
  if (new RegExp(`^(?:开启|打开|启用)${subject}$`, 'u').test(zh)
    || /^(?:please )?(?:enable|turn on) (?:the pet's |pet )?breathing$/u.test(text)) return { kind: 'on' };
  if (new RegExp(`^(?:关闭|关掉|禁用|停止)${subject}$`, 'u').test(zh)
    || /^(?:please )?(?:disable|turn off) (?:the pet's |pet )?breathing$/u.test(text)) return { kind: 'off' };
  const match = new RegExp(`^(?:把|将)?${subject}(?:设为|设置为|调到|调整为|改为)(-?\\d+(?:\\.\\d+)?)%$`, 'u').exec(zh)
    ?? /^(?:please )?set (?:the pet's |pet )?breathing(?: strength)? to (-?\d+(?:\.\d+)?)%$/u.exec(text);
  if (match) { const percent = Number(match[1]); return /^\d{1,3}$/u.test(match[1]) && percent <= 100
    ? { kind: 'percent', percent } : { kind: 'invalid' }; }
  if (new RegExp(`^(?:(?:切换|调整)${subject}|${subject}(?:开还是关|开启还是关闭)|(?:把|将)?${subject}(?:调大|调小|大一点|小一点)(?:点|一点)?)$`, 'u').test(zh)
    || /^(?:please )?(?:toggle|change|adjust) (?:pet )?breathing(?: strength)?$/u.test(text)) return { kind: 'ambiguous' };
  return { kind: 'none' };
}
