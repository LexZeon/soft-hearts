import type { CharacterTextDraft } from '../shared/character-cards';

export const SPEECH_PERSONA_LIMIT = 420;

const SHORT_LEGACY_LIMIT = 240;
const PERSONALITY_LABEL_TEXT = '性格|人格|气质|个性|核心气质|性格特点|personality|temperament';
const LABEL_TEXT = PERSONALITY_LABEL_TEXT + '|说话方式|说话风格|表达方式|表达风格|语气|口吻|语调|语速|措辞|语言风格|声音风格|声线|speaking\\s+style|speech\\s+style|tone|cadence|wording';
const labelledStyle = new RegExp('^(?:[-*#>]\\s*)?(?:' + LABEL_TEXT + ')\\s*[:：]', 'iu');
const labelledPersonality = new RegExp('^(?:[-*#>]\\s*)?(?:' + PERSONALITY_LABEL_TEXT + ')\\s*[:：]', 'iu');
const headingBreak = new RegExp(`((?:${LABEL_TEXT})\\s*[:：])[^\\S\\n]*\\n`, 'giu');
const speechStyle = /说话|讲话|语气|口吻|措辞|语调|语速|停顿|\bspeaks?\b|\bspeaking\b|\bspeech\b|\btone\b|\bcadence\b|\bwording\b/iu;
const initialLabel = new RegExp(`^(?:${LABEL_TEXT})\\s*[:：]\\s*`, 'iu');
const anyLabel = /^(?:[-*#>]\s*)?[\p{L}\p{N} _-]{1,40}\s*[:：]/u;
const negativeQualifier = /不|没有|并非|勿|别|避免|\b(?:not|never|without|avoid|cannot|can't|don't|doesn't|won't)\b/iu;
const repeatedSpeechLabel = /^说话(?:方式|风格)\s*[:：]\s*/u;

function clean(value: string): string {
  return value.replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ').trim();
}

const bracketHeading = /(^|[\n。！？.!?；;])[ \t]*【([^】\n]{1,40})】[ \t]*[:：]?[ \t]*/gu;
const bracketStyleLabel = new RegExp('^(' + LABEL_TEXT + ')(?:\\s*[·・|｜]\\s*[^\\n]+)?$', 'iu');

/** Only known headings grant style context; other sections explicitly end it. */
function normaliseBracketSections(value: string): string {
  return value.replace(bracketHeading, (_match, boundary: string, heading: string) => {
    const label = bracketStyleLabel.exec(heading.trim())?.[1];
    return boundary + (label ? label + '：' : '其他段落：');
  });
}

/** Keep commas and their negations together; an oversized sentence is omitted whole. */
function sentences(value: string): string[] {
  const text = clean(value).replace(headingBreak, '$1 ');
  return (text.match(/[^。！？.!?；;\n]+(?:[。！？.!?；;]+|(?=\n|$))/gu) ?? [])
    .map(part => part.replace(/\s+/gu, ' ').trim()).filter(Boolean);
}

function identity(value: string): string {
  return normaliseBracketSections(value).replace(initialLabel, '').replace(/[\s。！？.!?；;]+/gu, '').toLocaleLowerCase('en-US');
}

/** Carry complete qualifiers inside an explicit style section, without copying its background prose. */
function supportingStyles(value: string): { labelled: string[]; plain: string[]; primary: string[]; speech: string[] } {
  const labelled: string[] = [], plain: string[] = [], primary: string[] = [], speech: string[] = [];
  for (const paragraph of normaliseBracketSections(clean(value)).split(/\n[ \t]*\n/gu)) {
    let group: string[] = [], inStyle = false, inOtherSection = false, personalityGroup = false;
    const finish = () => {
      // Keep the labelled claim and its qualifiers atomic under the total cap.
      if (group.length) {
        const complete = group.join(' ');
        labelled.push(complete);
        (personalityGroup ? primary : speech).push(complete);
      }
      group = [];
    };
    for (const sentence of sentences(paragraph)) {
      if (labelledStyle.test(sentence)) {
        finish(); inStyle = true; inOtherSection = false;
        personalityGroup = labelledPersonality.test(sentence); group.push(sentence);
      } else if (anyLabel.test(sentence)) {
        finish(); inStyle = false; inOtherSection = true;
      } else if (inStyle) {
        if (speechStyle.test(sentence) || negativeQualifier.test(sentence)) group.push(sentence);
      } else if (!inOtherSection) {
        primary.push(sentence);
        if (speechStyle.test(sentence)) plain.push(sentence);
      }
    }
    finish();
  }
  return { labelled, plain, primary, speech };
}

function select(values: readonly string[], budget: number, seen: Set<string>): string {
  let result = '';
  for (const value of values) {
    const key = identity(value);
    if (!key || seen.has(key)) continue;
    const next = result ? `${result} ${value}` : value;
    if (next.length > budget) continue;
    result = next;
    seen.add(key);
  }
  return result;
}

/**
 * Bounded excerpts from the host's already validated active card, never inferred
 * personality scores or a complete prompt. Explicit style sentences anywhere in
 * a legacy prompt are eligible; unmarked long prose has no reliable fallback.
 */
export function characterSpeechPersona(card: Pick<CharacterTextDraft, 'personality' | 'description' | 'systemPrompt'>): string {
  const personality = clean(card.personality);
  const description = clean(card.description);
  const systemPrompt = clean(card.systemPrompt);
  const fromPersonality = supportingStyles(personality);
  // An explicit style and its qualifiers are one candidate even when they live
  // inside personality. Never select an affordable claim without its negation.
  const personalitySentences = fromPersonality.primary;
  const fromDescription = supportingStyles(description), fromSystem = supportingStyles(systemPrompt);
  const styles = [
    ...fromPersonality.speech, ...fromDescription.labelled, ...fromSystem.labelled,
    ...fromPersonality.plain, ...fromDescription.plain, ...fromSystem.plain,
  ].map(value => value.replace(repeatedSpeechLabel, ''));
  const seen = new Set<string>();
  const personalityLabel = '性格：';
  const styleLabel = '说话方式：';
  // Keep a complete leading personality statement and one missing explicit
  // speaking habit when both actually fit. A fixed reservation can discard a
  // valid long sentence; no reservation can crowd all speaking habits out.
  const fullBudget = SPEECH_PERSONA_LIMIT - personalityLabel.length;
  const fullPersonality = select(personalitySentences, fullBudget, new Set());
  const leadingPersonality = personalitySentences.find(value => value.length <= fullBudget);
  const missingStyle = leadingPersonality ? styles.find(value => {
    const room = SPEECH_PERSONA_LIMIT - personalityLabel.length - leadingPersonality.length - 1 - styleLabel.length;
    return value.length <= room && !identity(fullPersonality).includes(identity(value));
  }) : undefined;
  const reserve = missingStyle ? 1 + styleLabel.length + missingStyle.length : 0;
  const persona = select(personalitySentences, fullBudget - reserve, seen);
  const first = persona ? `${personalityLabel}${persona}` : '';
  const styleBudget = SPEECH_PERSONA_LIMIT - first.length - (first ? 1 : 0) - styleLabel.length;
  const style = select(styles, styleBudget, seen);
  if (first || style) return [first, style ? `${styleLabel}${style}` : ''].filter(Boolean).join('\n');
  if (!personality && !description && systemPrompt && systemPrompt.length <= SHORT_LEGACY_LIMIT
    && normaliseBracketSections(systemPrompt) === systemPrompt)
    return `旧版角色设定：${systemPrompt}`;
  return '';
}
