/** Internal, non-authoritative text hint. Only Main may bind a current human
 * request, authorize the one catalog action, commit, or issue a receipt.
 * This bounded grammar intentionally leaves unsupported phrasings to chat. */
export type AlwaysOnTopTextHint = 'on' | 'off' | 'clarify' | 'none';

const MAX_INPUT_LENGTH = 256;
const quotedOrStructured = /[\r\n\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069"'`“”‘’「」『』<>:：]/u;

const chineseOn = [
  /^保持桌宠置顶$/u,
  /^(?:把|将)?(?:桌宠|softhearts|你)?(?:设为|设置为|改为|改成|保持|一直保持|始终保持|一直|始终)?置顶(?:显示|状态)?$/u,
  /^(?:让)?(?:桌宠|softhearts|你)(?:一直|始终)置顶$/u,
  /^开启(?:桌宠|softhearts)?(?:的)?置顶(?:显示|状态)?$/u,
];
const chineseOff = [
  /^(?:取消|关闭|解除)(?:桌宠|softhearts|你)?(?:的)?(?:一直|始终)?置顶(?:显示|状态)?$/u,
  /^(?:把|将)?(?:桌宠|softhearts|你)?(?:设为|设置为|改为|改成)?(?:不要|不再|别|不)置顶(?:了)?$/u,
  /^(?:让)?(?:桌宠|softhearts|你)(?:不要|不再|别|不)置顶(?:了)?$/u,
];
const chineseClarify = [
  /^(?:桌宠|softhearts|你)?(?:不要|别)(?:挡着|挡住)(?:我|我的工作)(?:了)?$/u,
  /^(?:桌宠|softhearts|你)?(?:不要|别)压在(?:其他|别的)窗口(?:上|上面)?$/u,
  /^(?:不要|别)取消(?:桌宠|softhearts)?置顶$/u,
  /^(?:把|将)?(?:这个|当前)?窗口置顶$/u,
  /^(?:切换|调整)(?:桌宠|softhearts)?(?:的)?置顶(?:状态)?$/u,
];

/** Never extracts a command substring from quotes, code, narration or a mixed
 * request. A returned hint is not proof of human origin or execution consent. */
export function scanAlwaysOnTopRequest(input: unknown): AlwaysOnTopTextHint {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_INPUT_LENGTH) return 'none';
  const normalized = input.normalize('NFKC').trim().replace(/\bdon['’]t\b/giu, 'do not');
  if (!normalized || quotedOrStructured.test(normalized)) return 'none';
  const sentence = normalized.replace(/[。.!！?？]+$/u, '').trim();
  if (!sentence) return 'none';

  let chinese = sentence.toLowerCase().replace(/[\t ]+/gu, '');
  // Politeness is stripped at the sentence boundary, never searched within it.
  for (let index = 0; index < 3; index += 1) {
    const next = chinese.replace(/^(?:请你|请|麻烦你|麻烦|可以帮我|能不能帮我|能不能|帮我)/u, '');
    if (next === chinese) break;
    chinese = next;
  }
  chinese = chinese.replace(/(?:一下|好吗|好么|可以吗|行吗|吗)$/u, '');
  if (chineseOn.some(pattern => pattern.test(chinese))) return 'on';
  if (chineseOff.some(pattern => pattern.test(chinese))) return 'off';
  if (chineseClarify.some(pattern => pattern.test(chinese))) return 'clarify';

  const english = sentence.toLowerCase().replace(/\s+/gu, ' ')
    .replace(/^(?:please |can you |could you )/u, '')
    .replace(/^please /u, '');
  if (/^(?:(?:keep|set|make) (?:the pet|soft hearts|you) (?:always )?on top|(?:enable|turn on) always on top(?: for (?:the pet|soft hearts))?)$/u.test(english)) return 'on';
  if (/^(?:(?:disable|turn off|cancel) always on top(?: for (?:the pet|soft hearts))?|(?:stop keeping|do not keep|don't keep) (?:the pet|soft hearts|you) (?:always )?on top)$/u.test(english)) return 'off';
  if (/^(?:stop blocking (?:me|my work)|do not block me|don't block me)$/u.test(english)) return 'clarify';
  return 'none';
}
