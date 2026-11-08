/** A renderer may use this hint to avoid destructive optimistic chat cleanup.
 * Only trusted host admission can authorize the fixed action. */
export function scanStopReadoutRequest(value: unknown): 'none' | 'explicit' | 'ambiguous' {
  if (typeof value !== 'string' || !value || value.length > 256
    || /[\r\n\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff"'`“”‘’「」『』<>:：\\/]/u.test(value)) return 'none';
  const text = value.normalize('NFKC').trim().toLowerCase().replace(/[。.!！?？]+$/u, '').trim();
  const zh = text.replace(/ +/gu, '').replace(/^(?:请你|请|麻烦你|麻烦|帮我)/u, '').replace(/^(?:先)/u, '');
  if (/^(?:(?:停止|停下|暂停)(?:当前|这次|本次)?(?:语音朗读|朗读|播报|读出)|别读了|不要再读了)(?:一下|好吗|可以吗)?$/u.test(zh)
    || /^(?:please )?(?:stop|pause) (?:the )?(?:(?:current|this) )?(?:reading|readout|tts)$/u.test(text)) return 'explicit';
  if (/^(?:停一下|停止声音|暂停声音)$/u.test(zh)
    || /^(?:please )?(?:stop|pause) (?:the )?sound$/u.test(text)) return 'ambiguous';
  return 'none';
}
