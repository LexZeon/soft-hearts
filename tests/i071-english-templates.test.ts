// I-071 small English templates: the date line and the special-day hint and line. Fake clock, made-up entries, fake Claude; Chinese stays as it was.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { SpecialDayHost } from '../electron/memory/special-day/host';
import { SPECIAL_DAY_SYSTEM_PROMPT, SPECIAL_DAY_SYSTEM_PROMPT_EN, specialLinePrompt, specialLineWithClaude } from '../electron/memory/special-day/model';
import { SPECIAL_DAY_LIMITS, cleanSpokenLine, mentionsDay, specialDayHintLine } from '../shared/memory/special-day';
import { todayLine } from '../shared/memory/relationship';
import type { CardLanguage } from '../shared/foundation/character-card';

const temps: string[] = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'sh-i071-')); temps.push(dir); return dir; };
const at = (hour: number, day = 10) => new Date(2026, 10, day, hour).getTime();

test('todayLine in English: weekday, day, month and part of day from the same clock; Chinese is what it was', () => {
  const when = (h: number) => new Date(2026, 10, 10, h, 30).getTime(); // 2026-11-10 is a Tuesday
  assert.match(todayLine(when(15), 'en'), /^\[Today\] Tuesday, 10 November, afternoon\. Go by this/);
  assert.match(todayLine(when(3), 'en'), /small hours/);
  assert.match(todayLine(when(9), 'en'), /morning/);
  assert.match(todayLine(when(21), 'en'), /evening/);
  assert.equal(todayLine(when(15)), todayLine(when(15), 'zh-CN'));
  assert.match(todayLine(when(15)), /^【今天】11 月 10 日，星期二，下午。/);
});

test('special-day hint: English wording for both kinds, no "record" or "reminder" talk, Chinese unchanged', () => {
  for (const kind of ['birthday', 'anniversary'] as const) {
    const line = specialDayHintLine(kind, 'en');
    assert.ok(!/[一-鿿]/.test(line), `${kind} has no Chinese`);
    assert.match(line, /bad mood/);
    assert.match(line, /Do not mention "records" or "reminders"/);
    assert.equal(specialDayHintLine(kind), specialDayHintLine(kind, 'zh-CN'));
    assert.match(specialDayHintLine(kind), /这一轮用你自己的方式提到它/);
  }
  assert.match(specialDayHintLine('birthday', 'en'), /birthday/);
  assert.match(specialDayHintLine('anniversary', 'en'), /anniversary/);
});

test('the English line she writes herself: its own prompt, a longer cut, and the same safety cleaning', () => {
  assert.ok(!/[一-鿿]/.test(SPECIAL_DAY_SYSTEM_PROMPT_EN));
  const en = specialLinePrompt({ persona: 'Name: Gene', moodWords: 'calm', kind: 'birthday', language: 'en' });
  assert.match(en, /^\[Character\]\nName: Gene/);
  assert.match(en, /birthday/);
  assert.ok(!/[一-鿿]/.test(en));
  assert.match(specialLinePrompt({ persona: 'x', moodWords: '平静', kind: 'birthday' }), /^【角色】\n/, 'Chinese prompt is as before');
  const sentence = 'Happy birthday, I hope today is a gentle one for you and that someone brings you cake.';
  assert.ok([...sentence].length > SPECIAL_DAY_LIMITS.lineMaxChars && [...sentence].length <= SPECIAL_DAY_LIMITS.lineMaxCharsEn);
  assert.equal(cleanSpokenLine(sentence), '', 'the Chinese cut would have dropped it');
  assert.equal(cleanSpokenLine(sentence, 'en'), sentence);
  assert.equal(cleanSpokenLine('x'.repeat(SPECIAL_DAY_LIMITS.lineMaxCharsEn + 1), 'en'), '');
  assert.equal(cleanSpokenLine('see https://x.y', 'en'), '');
  assert.ok(mentionsDay('birthday', 'Happy birthday!'), 'the local word check already knows the English words');
});

test('the model call uses the system prompt of its language', async () => {
  const used: string[] = [];
  const stream = async (task: { systemPrompt?: string }, _signal: AbortSignal, emit: (type: string, text: string) => void) => { used.push(task.systemPrompt ?? ''); emit('delta', 'ok'); return null; };
  await specialLineWithClaude('p', '', new AbortController().signal, stream as any, 'en');
  await specialLineWithClaude('p', '', new AbortController().signal, stream as any);
  assert.deepEqual(used, [SPECIAL_DAY_SYSTEM_PROMPT_EN, SPECIAL_DAY_SYSTEM_PROMPT]);
});

test('the host hands the hint and the call her language; a broken or missing source is Chinese', async () => {
  const run = async (language: (() => CardLanguage) | undefined) => {
    const asked: (CardLanguage | undefined)[] = [];
    const host = new SpecialDayHost({
      file: () => path.join(temp(), 'special-day.json'), characterId: () => 'c1', folderOn: () => false, recordingTexts: () => ['我的生日是11月10日'],
      journal: () => {}, calm: () => true, now: () => at(9),
      ask: async (_kind, _signal, lang) => { asked.push(lang); return lang === 'en' ? 'Happy birthday, Gene here' : '生日快乐呀'; },
      ...(language ? { language } : {}),
    });
    const turn = host.beginHint('good morning');
    return { line: turn?.line ?? '', asked, host };
  };
  assert.equal((await run(() => 'en')).line, specialDayHintLine('birthday', 'en'));
  assert.equal((await run(() => 'zh-CN')).line, specialDayHintLine('birthday'));
  assert.equal((await run(undefined)).line, specialDayHintLine('birthday'));
  assert.equal((await run(() => { throw new Error('boom'); })).line, specialDayHintLine('birthday'));
});
