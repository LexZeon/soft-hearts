import test from 'node:test';
import assert from 'node:assert/strict';
import { characterSpeechPersona, SPEECH_PERSONA_LIMIT } from '../electron/speech-persona';

const card = (fields: Partial<{ personality: string; description: string; systemPrompt: string }> = {}) => ({
  personality: '', description: '', systemPrompt: '', ...fields,
});

test('explicit introverted and outgoing personalities remain different without classification', () => {
  const introverted = '内敛而细心，开心时也含蓄，不会高声欢呼。';
  const outgoing = '外向爽朗，开心时会热情地表达喜悦。';
  assert.ok(characterSpeechPersona(card({ personality: introverted })).includes(introverted));
  assert.ok(characterSpeechPersona(card({ personality: outgoing })).includes(outgoing));
  assert.notEqual(characterSpeechPersona(card({ personality: introverted })), characterSpeechPersona(card({ personality: outgoing })));
});

test('legacy style labels are found in the middle and tail without copying the surrounding story', () => {
  const story = 'STORY_NOT_FOR_SPEECH。'.repeat(90);
  const value = characterSpeechPersona(card({ systemPrompt: `${story}性格：内敛，开心时含蓄。${story}\n说话方式：温和简洁，不大声喊叫。` }));
  assert.ok(value.includes('性格：内敛，开心时含蓄。'));
  assert.ok(value.includes('温和简洁，不大声喊叫。'));
  assert.equal(value.match(/说话方式：/gu)?.length, 1);
  assert.ok(!value.includes('STORY_NOT_FOR_SPEECH'));
});

test('style headings on their own line retain the following complete sentence', () => {
  const value = characterSpeechPersona(card({ systemPrompt: `${'BACKGROUND。'.repeat(40)}\n语气：\n即使开心也不尖叫，仍然保持克制。` }));
  assert.ok(value.includes('语气： 即使开心也不尖叫，仍然保持克制。'));
  assert.ok(!value.includes('BACKGROUND'));
});

test('bracketed speaking headings retain complete cross-line style and negative qualifiers', () => {
  const style = '轻缓自然，句尾柔和。';
  const qualifier = '开心时不会高声欢呼。';
  for (const field of ['description', 'systemPrompt'] as const) {
    const value = characterSpeechPersona(card({
      [field]: `${'PUBLIC_BACKGROUND_NOT_FOR_SPEECH。'.repeat(30)}\n【说话方式】\n${style}\n${qualifier}`,
    }));
    assert.ok(value.includes(style), `${field} retains the complete style sentence after its heading`);
    assert.ok(value.includes(qualifier), `${field} retains the full negative qualifier`);
    assert.ok(!value.includes('PUBLIC_BACKGROUND_NOT_FOR_SPEECH'));
    assert.ok(value.length <= SPEECH_PERSONA_LIMIT);
  }
});

test('an explicit bracketed background section ends style extraction before unrelated prose', () => {
  const style = '轻缓自然，句尾柔和。';
  const qualifier = '开心时不会高声欢呼。';
  for (const field of ['description', 'systemPrompt'] as const) {
    const value = characterSpeechPersona(card({
      [field]: `说话方式：${style}\n${qualifier}\n【背景】\n她说话时想到 PUBLIC_PRIVATE_SECTION_SENTINEL，但这段经历不属于声音风格。`,
    }));
    assert.ok(value.includes(style));
    assert.ok(value.includes(qualifier));
    assert.ok(!value.includes('PUBLIC_PRIVATE_SECTION_SENTINEL'), `${field} excludes explicitly separated background even when it mentions speech or negation`);
    assert.ok(!value.includes('【背景】'));
  }
});

test('a speaking heading may carry an explicit adaptation suffix without losing its qualifier', () => {
  const style = '轻缓自然，句尾收住。';
  const qualifier = '也不是每句话都压低声音。';
  const value = characterSpeechPersona(card({ description: `【说话方式·同人演绎】\n${style}\n${qualifier}` }));
  assert.ok(value.includes(style));
  assert.ok(value.includes(qualifier));
  assert.ok(value.length <= SPEECH_PERSONA_LIMIT);
});

test('an arbitrary bracketed section is not treated as authority to extract its prose as speech style', () => {
  const value = characterSpeechPersona(card({
    description: '【出行便笺】\n下一句提到了说话，但它是 PUBLIC_ARBITRARY_SECTION_SENTINEL 的故事对白。',
  }));
  assert.equal(value, '');
});

test('unpunctuated personality and style lines are retained whole', () => {
  const value = characterSpeechPersona(card({ personality: '内敛而细心\n开心时不会高声欢呼', systemPrompt: '背景信息\n语气：温和简洁\n其它背景' }));
  assert.ok(value.includes('内敛而细心'));
  assert.ok(value.includes('开心时不会高声欢呼'));
  assert.ok(value.includes('语气：温和简洁'));
  assert.ok(!value.includes('背景'));
});

test('unknown bracketed legacy sections cannot fall back to copying the whole short prompt', () => {
  assert.equal(characterSpeechPersona(card({
    systemPrompt: '【出行便笺】\n她说话时想起 PUBLIC_SHORT_STORY_SENTINEL。',
  })), '');
});

test('personality background sections are excluded while a later genuine style heading may resume', () => {
  const value = characterSpeechPersona(card({
    personality: '【核心气质】沉稳细心。\n【背景】\nPUBLIC_PERSONALITY_BACKGROUND_SENTINEL。\n【说话方式】\n轻缓自然。\n开心时不会高声欢呼。',
  }));
  assert.ok(value.includes('沉稳细心。'));
  assert.ok(value.includes('轻缓自然。'));
  assert.ok(value.includes('开心时不会高声欢呼。'));
  assert.ok(!value.includes('PUBLIC_PERSONALITY_BACKGROUND_SENTINEL'));
});

test('a quoted style label inside a background sentence cannot reopen extraction', () => {
  for (const field of ['personality', 'description', 'systemPrompt'] as const) {
    assert.equal(characterSpeechPersona(card({
      [field]: '【背景】\n旧便笺写着“语气：PUBLIC_QUOTED_BACKGROUND_SENTINEL”。',
    })), '');
  }
});

test('over-budget explicit personality style cannot retain its claim without the complete qualifier', () => {
  const value = characterSpeechPersona(card({
    personality: '沉稳而细心。\n【说话方式】轻柔自然。\n' + '开心时也不会高声欢呼，'.repeat(50) + '保持克制。',
  }));
  assert.ok(value.includes('沉稳而细心。'));
  assert.ok(!value.includes('轻柔自然'), 'the short style claim cannot escape its oversized qualifier group');
  assert.ok(!value.includes('高声欢呼'));
  assert.ok(value.length <= SPEECH_PERSONA_LIMIT);
});

test('commas and full negations stay together rather than producing contradictory fragments', () => {
  const complete = '她说话并不冷漠，不是没有感情，而是温柔含蓄。';
  const value = characterSpeechPersona(card({ description: complete }));
  assert.equal(value, `说话方式：${complete}`);
  assert.ok(!value.includes('性格：'));
});

test('long unknown legacy prose and unmarked descriptions do not become a fabricated speech persona', () => {
  assert.equal(characterSpeechPersona(card({ systemPrompt: 'UNRELATED_PRIVATE_STORY'.repeat(100) })), '');
  assert.equal(characterSpeechPersona(card({ description: '背景经历。'.repeat(100), systemPrompt: '背景设定。'.repeat(100) })), '');
});

test('short legacy prompts are preserved only when the other persona fields are empty', () => {
  assert.equal(characterSpeechPersona(card({ systemPrompt: 'A quiet, considerate companion.' })), '旧版角色设定：A quiet, considerate companion.');
  assert.equal(characterSpeechPersona(card({ description: '场景背景。', systemPrompt: 'A quiet companion.' })), '');
  assert.equal(characterSpeechPersona(card()), '');
});

test('personality has priority while explicit supporting speech habits retain room', () => {
  const personality = '沉稳、谨慎，重视准确表达。'.repeat(30);
  const value = characterSpeechPersona(card({ personality, systemPrompt: '语速：自然稍慢，停顿紧凑。' }));
  assert.ok(value.startsWith('性格：沉稳、谨慎，重视准确表达。'));
  assert.ok(value.includes('语速：自然稍慢，停顿紧凑。'));
  assert.ok(value.length <= SPEECH_PERSONA_LIMIT);
});

test('many complete personality sentences do not crowd out an explicit speaking habit that fits with the leading personality', () => {
  const first = `沉稳，${'谨慎'.repeat(97)}甲。`;
  const background = `细心，${'踏实'.repeat(97)}乙。`;
  const style = '语速：自然稍慢，轻声留白，句尾收住，开心时仍保持克制和含蓄，不用欢呼或夸张拖长尾音。';
  const value = characterSpeechPersona(card({ personality: first + background, systemPrompt: style }));
  assert.ok(value.includes(first));
  assert.ok(value.includes(style));
  assert.ok(value.length <= SPEECH_PERSONA_LIMIT);
});

test('late explicit speaking habits inside personality keep room beside the first complete personality sentence', () => {
  const first = `沉稳，${'谨慎'.repeat(97)}甲。`;
  const otherPersonality = `细心，${'踏实'.repeat(102)}乙。`;
  const style = '轻缓自然，句尾收住。';
  const qualifier = '开心时不会高声欢呼。';
  const value = characterSpeechPersona(card({
    personality: `${first}${otherPersonality}\n【说话方式】\n${style}\n${qualifier}`,
  }));
  assert.ok(value.includes(first), 'the complete leading personality remains present');
  assert.ok(value.includes(style), 'earlier personality prose cannot crowd out the later explicit speaking habit');
  assert.ok(value.includes(qualifier), 'the reserved speaking habit keeps its complete negative qualifier');
  assert.ok(value.length <= SPEECH_PERSONA_LIMIT);
});

test('a fitting personality longer than 260 characters survives adding a short supporting style', () => {
  const personality = `内敛，${'克制'.repeat(140)}。`;
  assert.equal(personality.length, 284);
  const style = '语速：自然稍慢。';
  const value = characterSpeechPersona(card({ personality, systemPrompt: style }));
  assert.ok(value.includes(personality), 'the complete personality and short style fit in the shared cap');
  assert.ok(value.includes(style));
  assert.ok(value.length <= SPEECH_PERSONA_LIMIT);
});

test('labelled legacy style retains complete negative qualifiers until a new label or paragraph', () => {
  const qualifier = '开心时不会高声欢呼。';
  const secondQualifier = '也不是每句话都压低声音。';
  const value = characterSpeechPersona(card({ systemPrompt: [
    `性格：安静含蓄。${qualifier}背景：不要带入这段私人背景。`,
    '并非声音风格的另一段私人经历。',
    `说话方式：温柔自然。${secondQualifier}`,
    '没有关系的私人背景。',
  ].join('\n\n') }));
  assert.ok(value.includes(`性格：安静含蓄。 ${qualifier}`));
  assert.ok(value.includes(`温柔自然。 ${secondQualifier}`));
  assert.equal(value.match(/说话方式：/gu)?.length, 1, 'the group heading is not repeated from its source label');
  assert.ok(!value.includes('私人'));
  assert.ok(value.length <= SPEECH_PERSONA_LIMIT);
  const tooLong = characterSpeechPersona(card({ systemPrompt: `性格：${'柔'.repeat(400)}。${'绝不喊叫'.repeat(20)}。` }));
  assert.equal(tooLong, '', 'an over-budget labelled claim is not kept without its negative qualifier');
});

test('oversized sentences are skipped whole and do not hide a later usable style', () => {
  const oversized = `语气：${'长'.repeat(700)}，不要喊叫。`;
  const value = characterSpeechPersona(card({ systemPrompt: `${oversized}口吻：克制、体贴。` }));
  assert.ok(!value.includes('长'));
  assert.ok(!value.includes('不要喊叫'));
  assert.ok(value.includes('口吻：克制、体贴。'));
  assert.ok(value.length <= SPEECH_PERSONA_LIMIT);
});

test('duplicate sentences and equivalent labels are included once across the allowed fields', () => {
  const sentence = '内敛，语气含蓄。';
  const value = characterSpeechPersona(card({ personality: sentence, description: `性格：${sentence}`, systemPrompt: `性格：${sentence}\n说话方式：简短自然。\n说话方式：简短自然。` }));
  assert.equal(value.match(/内敛/gu)?.length, 1);
  assert.equal(value.match(/简短自然/gu)?.length, 1);
});

test('the total excerpt stays within its limit without mutating or reading other card fields', () => {
  const input = {
    ...card({ personality: '内敛但亲切。'.repeat(60), description: '语气：含蓄自然。', systemPrompt: '说话方式：简洁，不机械平读。' }),
    get scenario(): never { throw new Error('scenario must not be read'); },
    get examples(): never { throw new Error('examples must not be read'); },
    get greeting(): never { throw new Error('greeting must not be read'); },
  };
  const before = [input.personality, input.description, input.systemPrompt];
  const value = characterSpeechPersona(input);
  assert.ok(value.length <= SPEECH_PERSONA_LIMIT);
  assert.deepEqual([input.personality, input.description, input.systemPrompt], before);
  const full = '素'.repeat(SPEECH_PERSONA_LIMIT - '性格：'.length);
  assert.equal(characterSpeechPersona(card({ personality: full })).length, SPEECH_PERSONA_LIMIT);
  assert.equal(characterSpeechPersona(card({ personality: `${full}多` })), '');
});
