// I-071 v2 第三步 转换: from the source snapshot and the translations to the new card's own data (pure; no file is touched
// here). Everything carries the NEW card's id and scope only, so nothing can be read or written for the source by it.
//
// Her notes ("她记得的事") become sealed chat memories of the new card: one per note, with an empty user line and her translated
// recollection as her line. That is how a memory is recalled (electron/memory/memory.ts retrieve: tags and title match, the excerpt is
// her line). The empty user line keeps them out of the chat window (recentConversation), out of the days-known backfill and out
// of the notebook's queue (no user words to note); they are listed and deletable in 聊天记忆 like any other memory.
import { randomUUID } from 'node:crypto';
import type { CardLanguage, CharacterDraft } from '../../../shared/foundation/character-card';
import { DEFAULT_MEMORY_CONFIG, type MemoryMessage } from '../../../shared/memory';
import { nicknameAskStartsOver, type ConversionLeftOutItem, type ConversionNameRole, type ConversionReferent } from '../../../shared/cards/character-convert';
import type { RelationshipData } from '../../../shared/memory';
import type { TtsStyleBinding } from '../../../shared/foundation/tts-config';
import { DIARY_LIMITS, diaryText, type UserDiaryEntry } from '../../memory';
import { REVIEW_LIMITS, reviewWords, type ReviewData, type ReviewEntry } from '../../memory';
import { finishedWeeks, readyMonth } from '../../memory';
import { PRIVATE_LITERAL } from '../../foundation/private-literal';
import { relationshipBackfillKey } from '../../memory';
import { RECORDING_ON_MARKER, profileTextFingerprint, userProfileScopeId, type UserProfileEntry } from '../../memory';
import { addressReferent } from './addresses';
import { addressTexts, localDay, sourceCorpus, type SourceSnapshot } from './snapshot';
import { leftOutFormClosure } from './variants';
import type { MemoryItem, MemoryValue, NameMap, PersonaText } from './translate';

export interface ConversionBundle {
  newId: string;
  providerScope: string;
  draft: CharacterDraft;
  /** The same model as the source card (absent when the source had no link). */
  model: { modelPath: string; modelName?: string } | null;
  /** Sealed chat memories under the new scope (MemoryStore.restoreRecords' shape). */
  records: CarrierRecord[];
  /** The new scope's profile file (UserProfileStore.restoreScope's shape), or null when there is nothing to carry. */
  profile: Record<string, unknown> | null;
  relationship: RelationshipData;
  voice: TtsStyleBinding[];
  /** I-088 第 1 条: her carried weekly and monthly look-backs as the new scope's own file (ReviewStore's data), or null when there are none. */
  reviews?: { scopeId: string; data: ReviewData } | null;
  carried: { notes: number; profileEntries: number; diaryDays: number; reviews?: number; voice: string; recording: boolean };
  /** Fix 8: what the new card's own stores refused or that came back empty (a credential-looking profile line, a duplicate…), listed. */
  skipped?: ConversionLeftOutItem[];
}

export interface CarrierRecord {
  id: string; scopeKey: string; conversationId: string; title: string; tags: string[]; category: '日常';
  manual: { title: boolean; tags: boolean; category: boolean };
  createdAt: number; updatedAt: number; lastFinishedAt: number; weight: number; weightAt: number;
  mentions: []; messages: MemoryMessage[]; sealed: true;
}

/** The key of a look-back's translation item: rw<Monday> for a week, rm<YYYY-MM> for a month. */
const reviewItemKey = (entry: ReviewEntry): string => `r${entry.kind === 'week' ? 'w' : 'm'}${entry.key}`;

/** The memory items to translate for this snapshot, keyed n<i> (notes), d<date> (diary), rw/rm<period> (look-backs), p<i> (profile), v (voice). */
export function conversionItems(snapshot: SourceSnapshot): MemoryItem[] {
  const items: MemoryItem[] = snapshot.notes.map((note, index) => ({ k: `n${index}`, kind: 'note' as const, v: {
    title: note.body.title, summary: note.body.summary, people: [...note.body.people], things: [...note.body.things], mood: note.body.mood,
    plans: [...note.body.plans], tags: [...note.body.tags] } }));
  for (const entry of snapshot.profile?.diary ?? []) items.push({ k: `d${entry.date}`, kind: 'diary', v: { text: entry.text, ...(entry.meme ? { meme: entry.meme } : {}) } });
  for (const entry of snapshot.reviews ?? []) items.push({ k: reviewItemKey(entry), kind: 'review', v: { text: entry.text, ...(entry.carry ? { carry: entry.carry } : {}), ...(entry.words.length ? { words: [...entry.words] } : {}) } });
  (snapshot.profile?.entries ?? []).forEach((entry, index) => items.push({ k: `p${index}`, kind: 'profile', v: { text: entry.text } }));
  snapshot.voice.bindings.forEach((binding, index) => {
    if (binding.instruction.trim() || binding.fishActingStyle?.trim())
      items.push({ k: `v${index}`, kind: 'voice', v: { ...(binding.instruction.trim() ? { instruction: binding.instruction } : {}), ...(binding.fishActingStyle?.trim() ? { actingStyle: binding.fishActingStyle } : {}) } });
  });
  return items;
}

/** The glossary: every name with the user's choice; a nickname left unset has `to: ''`; the forms of address found in her memories ride along. */
export function nameMap(snapshot: SourceSnapshot, chosen: Record<ConversionNameRole, string | null>, aliases: readonly { from: string; to: string; kind?: 'term'; refers?: ConversionReferent }[] = []): NameMap {
  const out: NameMap = {};
  for (const name of snapshot.names) {
    if (name.id !== 'her-name' && name.id !== 'her-nickname' && name.id !== 'user-nickname') continue;
    out[name.id] = { from: name.text, to: chosen[name.id] ?? '' };
  }
  // Fix 4: who a form of address names (read from her memories) decides what replaces it when it is left for later; one the
  // assistant added (extra) is read here the same way.
  const texts = addressTexts(snapshot.notes, snapshot.profile, snapshot.reviews);
  if (aliases.length) out.aliases = aliases.map(alias => {
    const refers = alias.kind === 'term' ? null : alias.refers ?? addressReferent(alias.from, texts);
    return { from: alias.from, to: alias.to, ...(alias.kind ? { kind: alias.kind } : {}), ...(refers ? { refers } : {}) };
  });
  // Fix 8 (Codex T-240 F01): every other written form of each name left for later that occurs in what is converted (pinyin, Xiao /
  // Little forms, an English rendering next to it, its people-and-things group); never a form equal to a kept or chosen name.
  const entries = [...(['her-name', 'her-nickname', 'user-nickname'] as const).flatMap(role => out[role] ? [{ ...out[role]!, term: false, role }] : []),
    ...(out.aliases ?? []).map(alias => ({ from: alias.from, to: alias.to, term: alias.kind === 'term', role: 'alias' as const }))];
  const leftOut = entries.filter(entry => !entry.to && !entry.term && entry.role !== 'her-name' && entry.from.trim());
  if (leftOut.length) {
    const corpus = [sourceCorpus(snapshot), ...snapshot.voice.bindings.flatMap(binding => [binding.instruction, binding.fishActingStyle ?? ''])].filter(Boolean);
    const keep = entries.filter(entry => entry.to).flatMap(entry => [entry.from, entry.to]);
    const forms = leftOut.map(entry => ({ of: entry.from, forms: leftOutFormClosure(entry.from, corpus, snapshot.aliasGroups ?? [], keep).filter(form => form !== entry.from) }))
      .filter(entry => entry.forms.length);
    if (forms.length) out.leftOutForms = forms;
  }
  return out;
}

const RECALL_LINE: Readonly<Record<CardLanguage, { head: string; people: string; things: string; mood: string; plans: string; sep: string }>> = {
  en: { head: '(Remembered from before, not our exact words)', people: 'People', things: 'Things', mood: 'How it felt', plans: 'Plans', sep: ', ' },
  'zh-CN': { head: '（以前的事，我记得的大概，不是原话）', people: '人物', things: '事情', mood: '心情', plans: '打算', sep: '、' },
};

function recollection(value: Extract<MemoryValue, { summary: string }>, target: CardLanguage): string {
  const words = RECALL_LINE[target], colon = target === 'en' ? ': ' : '：';
  return [
    `${words.head} ${value.summary}`.trim(),
    value.people.length ? `${words.people}${colon}${value.people.join(words.sep)}` : '',
    value.things.length ? `${words.things}${colon}${value.things.join(words.sep)}` : '',
    value.mood ? `${words.mood}${colon}${value.mood}` : '',
    value.plans.length ? `${words.plans}${colon}${value.plans.join(words.sep)}` : '',
  ].filter(Boolean).join('\n');
}

export interface BuildInput {
  snapshot: SourceSnapshot;
  target: CardLanguage;
  persona: PersonaText;
  translated: ReadonlyMap<string, MemoryValue>;
  names: Record<ConversionNameRole, string | null>;
  /** The forms of address and proper nouns as the user decided them (`to: ''` = left for later). */
  aliases?: readonly { from: string; to: string; kind?: 'term' }[];
  newId: string;
  providerScope: string;
  /** MemoryStore.noteScope of the new scope (the journal's key for it). */
  scopeKey: string;
  now: number;
  id?: () => string;
  /** Fix 5: keys of the items left out after their re-ask (translateMemories); they are skipped, not an error. */
  leftOut?: ReadonlySet<string>;
}

/** Throws when a translation the bundle needs is missing (translateMemories already failed in that case). */
export function buildConversion(input: BuildInput): ConversionBundle {
  const { snapshot, target, persona, translated, names, newId, providerScope, scopeKey, now } = input;
  const id = input.id ?? randomUUID;
  const skipped = (key: string) => input.leftOut?.has(key) === true;
  const take = <K extends MemoryItem['kind']>(key: string): MemoryValue => {
    const value = translated.get(key);
    if (!value) throw new Error('有一条记忆没有翻译好，转换没有继续。');
    return value;
  };
  const card = snapshot.card;
  const draft: CharacterDraft = {
    name: names['her-name'] ?? persona.name, description: persona.description, personality: persona.personality, scenario: persona.scenario,
    greeting: persona.greeting, examples: persona.examples, systemPrompt: persona.systemPrompt, language: target,
    ...(card.mood ? { mood: structuredClone(card.mood) } : {}),
    ...(card.slowWarmUp !== undefined ? { slowWarmUp: card.slowWarmUp } : {}), // her choice travels, off included
    ...(typeof card.sleepHabit === 'number' ? { sleepHabit: card.sleepHabit } : {}), // I-078 第 3 步: how she sleeps is the same her
    ...(card.slips ? { slips: card.slips } : {}), // 小毛病: so is how often she slips
    ...(persona.understandingNotes.trim() ? { understandingNotes: persona.understandingNotes } : {}),
  };
  const records: CarrierRecord[] = snapshot.notes.flatMap((note, index): CarrierRecord[] => {
    if (skipped(`n${index}`)) return [];
    const value = take(`n${index}`) as Extract<MemoryValue, { summary: string }>;
    const at = note.segmentAt, turnId = id();
    return [{
      id: id(), scopeKey, conversationId: `converted-${newId}-${index}`, title: value.title, tags: value.tags.slice(0, 5), category: '日常',
      manual: { title: true, tags: true, category: false }, createdAt: at, updatedAt: at, lastFinishedAt: at,
      weight: DEFAULT_MEMORY_CONFIG.baseWeight, weightAt: at, mentions: [], sealed: true,
      messages: [
        { id: id(), turnId, role: 'user', content: '', createdAt: at, updatedAt: at, status: 'complete' },
        { id: id(), turnId, role: 'assistant', content: recollection(value, target), createdAt: at, updatedAt: at, status: 'complete' },
      ],
    }];
  });
  // Her profile and diary under the new scope; an entry the profile file would refuse (a credential-looking text) is left out.
  let profile: Record<string, unknown> | null = null, profileEntries = 0, diaryDays = 0, recording = false;
  const notCarried: ConversionLeftOutItem[] = [];
  if (snapshot.profile) {
    const keys = new Set<string>();
    const entries: (UserProfileEntry & { key: string; fingerprint: string })[] = [];
    snapshot.profile.entries.forEach((entry, index) => {
      if (skipped(`p${index}`)) return;
      const text = (take(`p${index}`) as { text: string }).text;
      const key = profileTextFingerprint(text);
      // Fix 8: a line the profile file would refuse, or the same as one already carried, is said (by its number, never its text).
      const refused = !text.trim() ? 'missing' : PRIVATE_LITERAL.test(text) ? 'private' : keys.has(key) ? 'duplicate' : null;
      if (refused) { notCarried.push({ key: `p${index}`, kind: 'profile', title: `你的画像第 ${index + 1} 条`, reasons: [refused] }); return; }
      keys.add(key);
      entries.push({ id: id(), kind: entry.kind, text, manual: true, source: { requestId: 'character-convert', messageId: entry.id.slice(0, 200) || 'entry', quote: text },
        createdAt: entry.createdAt, updatedAt: Math.max(entry.updatedAt, entry.createdAt), key, fingerprint: key });
    });
    const diary: UserDiaryEntry[] = [];
    for (const entry of snapshot.profile.diary) {
      if (skipped(`d${entry.date}`)) continue;
      const value = take(`d${entry.date}`) as { text: string; meme?: string };
      const text = diaryText(value.text, DIARY_LIMITS.editedChars), meme = value.meme ? diaryText(value.meme, DIARY_LIMITS.memeStoredChars) : null;
      if (!text) { notCarried.push({ key: `d${entry.date}`, kind: 'diary', title: `${entry.date} 的日记`, reasons: ['missing'] }); continue; }
      diary.push({ date: entry.date, text, writtenAt: entry.writtenAt, ...(entry.editedAt !== undefined ? { editedAt: entry.editedAt } : {}), ...(meme ? { meme } : {}) });
    }
    // Days just before the conversion with no diary: the new card does not write one from the carried memories (its diary starts
    // with its own days). Marked as "tried enough", the same way a day that failed three times is.
    const today = localDay(now);
    const attempts = [];
    for (let back = 1; back <= DIARY_LIMITS.backfillDays; back++) {
      const date = localDay(now - back * 86_400_000);
      if (date !== today && !diary.some(entry => entry.date === date)) attempts.push({ date, count: DIARY_LIMITS.attemptsPerDay, lastAt: now });
    }
    attempts.sort((a, b) => a.date.localeCompare(b.date));
    profileEntries = entries.length; diaryDays = diary.length;
    recording = snapshot.profile.recording;
    if (entries.length || diary.length || recording)
      profile = { version: 1, scopeId: userProfileScopeId({ characterId: newId, providerScope }), revision: 0, entries, blocked: recording ? [RECORDING_ON_MARKER] : [],
        ...(diary.length ? { diary } : {}), ...(attempts.length ? { diaryAttempts: attempts } : {}) };
  }
  // I-088 第 1 条: her newest look-backs under the new scope, translated like the diary days. The new card does not write look-backs
  // of the weeks just before the conversion from the carried memories (its own start): those periods count as tried enough, the same
  // way the diary marks its days.
  const reviewItems: ReviewEntry[] = [];
  for (const entry of snapshot.reviews ?? []) {
    if (skipped(reviewItemKey(entry))) continue;
    const value = take(reviewItemKey(entry)) as { text: string; carry?: string; words?: string[] };
    const text = diaryText(value.text, REVIEW_LIMITS.editedChars);
    if (!text) { notCarried.push({ key: reviewItemKey(entry), kind: 'review', title: `${entry.key} 的回顾`, reasons: ['missing'] }); continue; }
    const carry = entry.kind === 'week' && value.carry ? diaryText(value.carry, REVIEW_LIMITS.carryStoredChars) : null;
    reviewItems.push({ kind: entry.kind, key: entry.key, text, ...(carry ? { carry } : {}), words: reviewWords(value.words, text, REVIEW_LIMITS.wordStoredChars),
      writtenAt: entry.writtenAt, ...(entry.editedAt !== undefined ? { editedAt: entry.editedAt } : {}) });
  }
  let reviews: ConversionBundle['reviews'] = null;
  if (reviewItems.length) {
    const today = localDay(now), tries: ReviewData['tries'] = [];
    for (const key of finishedWeeks(today, REVIEW_LIMITS.backfillWeeks)) if (!reviewItems.some(item => item.kind === 'week' && item.key === key)) tries.push({ id: `week:${key}`, count: REVIEW_LIMITS.attemptsPerPeriod });
    const month = readyMonth(today);
    if (month && !reviewItems.some(item => item.kind === 'month' && item.key === month)) tries.push({ id: `month:${month}`, count: REVIEW_LIMITS.attemptsPerPeriod });
    reviews = { scopeId: userProfileScopeId({ characterId: newId, providerScope }), data: { items: reviewItems, blocked: [], tries, opening: null } };
  }
  // Fix 3: she asks the user once what to call them (nicknameAsked; RelationshipHost.nicknameAsk). When no nickname for the user is
  // carried and one was left for later (the stored one, or a form of address from her memories), the new card has not asked yet in
  // its language: the flag starts over so she asks once, naturally. Carried, or nothing left for later (the user may have said no
  // before): the flag stays as it was. What the user calls HER has no "asked" flag (only the user's own words set it).
  const startsOver = nicknameAskStartsOver(snapshot.relationship.nickname, names['user-nickname'], (input.aliases ?? []).some(alias => alias.kind !== 'term' && !alias.to));
  const relationship: RelationshipData = {
    ...structuredClone(snapshot.relationship),
    // A nickname the user left unset ("先不带，以后在聊天里起") stays empty: the usual ask-once / "叫我 Y" flow fills it in on the new card.
    nickname: names['user-nickname'] ?? null,
    herNickname: names['her-nickname'] ?? null,
    nicknameAsked: startsOver ? false : snapshot.relationship.nicknameAsked,
    // The new scope counts as scanned: the carried memories never add days of their own.
    backfilled: [relationshipBackfillKey({ characterId: newId, providerScope })],
  };
  const bindings = snapshot.voice.bindings;
  // The source's Drama 3 voice id is a voice for the other language (and may be the user's private one): it is never carried.
  const voice: TtsStyleBinding[] = bindings.map((binding, index) => {
    const adapted = translated.get(`v${index}`) as { instruction?: string; actingStyle?: string } | undefined;
    return { characterId: newId, modelPath: binding.modelPath, voice: binding.voice, instruction: adapted?.instruction ?? (binding.instruction.trim() ? '' : binding.instruction),
      emotion: binding.emotion, rate: binding.rate, ...(adapted?.actingStyle ? { fishActingStyle: adapted.actingStyle } : {}) };
  }).sort(// fix 8: the card's own model first (when the shared list has room for only some, that one is added first)
(a, b) => Number(b.modelPath === card.modelPath) - Number(a.modelPath === card.modelPath));
  // Fix 5: say only what really was rewritten (nothing when her style texts are empty; a left-out style text is said as such).
  const adapted = bindings.map((_, index) => translated.get(`v${index}`) as { instruction?: string; actingStyle?: string } | undefined);
  const rewritten = [adapted.some(value => value?.instruction) ? '百炼的风格文字' : '', adapted.some(value => value?.actingStyle) ? 'Drama 3 的表演提示' : ''].filter(Boolean);
  const voiceLeftOut = bindings.some((_, index) => skipped(`v${index}`));
  const voiceLine = !bindings.length ? '她没有自己的朗读设置：新卡用全局的声音（系统声音会自动选这种语言的）'
    : `同一个模型的朗读设置带过去${rewritten.length ? `，${rewritten.join('、')}按新语言改写了` : ''}${voiceLeftOut ? '；风格提示没能翻好，没有带（可以在朗读设置里给新卡重写）' : ''}`
      + `${bindings.some(binding => binding.fishVoiceId) ? '；Drama 3 的声音编号没有带（那是原来语言的声音），新卡先用 Drama 3 全局的声音' : ''}`;
  return { newId, providerScope, draft, model: card.modelPath ? { modelPath: card.modelPath, ...(card.modelName ? { modelName: card.modelName } : {}) } : null,
    records, profile, reviews, relationship, voice, ...(notCarried.length ? { skipped: notCarried } : {}), carried: { notes: records.length, profileEntries, diaryDays, ...(reviewItems.length ? { reviews: reviewItems.length } : {}), voice: voiceLine, recording } };
}
