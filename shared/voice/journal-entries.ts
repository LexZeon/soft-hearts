// 体验记录 (the experience journal): the entry types of the voice part (声音): speech, voice-input, audio-reading, reading-time, voice-time, voice-capture, voice-call, speech-cue.
// shared/memory/journal.ts joins every part's slice and keeps THE BOUNDARY written at its top: a line holds times, the character
// id, a type, fixed enum values, numbers and a plain-language reason from a fixed table; never a word of chat, a file path or a key.
// Moved here from shared/memory/journal.ts on 2026-11-16 (docs/claude/2026-11-16-journal-split.md) without changing a line it writes.
// THE RULE FOR A NEW ENTRY TYPE: it goes into its part's slice, shared/<part>/journal-entries.ts: its input shape in the part's
// <Part>JournalInput, its closed word lists beside it, its case in the slice's three functions (reason, build, describe) and its
// name in <PART>_JOURNAL_TYPES. Then its name goes into JOURNAL_TYPES in shared/memory/journal.ts, valid inputs for it into
// BASES in tests/helpers/journal-behaviour.ts, and both goldens are regenerated (scripts/dev/journal-surface.mjs --write,
// scripts/dev/journal-behaviour.ts --write), saying why in the commit. A part without a slice gets one: a new file like this, one
// entry in each of the four slice tables of shared/memory/journal.ts, and its names on the part's index.ts.
import { FIRST_CHAR_PROCESSES, count, finite, has, ms, round, unit, type FirstCharProcess, type JournalTranslate } from '../foundation/journal-fields';
import { SPEECH_CUE_OUTCOMES, SPEECH_CUE_OUTCOME_WORDS, SPEECH_CUE_PAIRS, SPEECH_CUE_REASON_WORDS, type SpeechCueOutcome, type SpeechCueReason } from './speech-cue';
import { CALL_LOOK_ANSWERS, CALL_LOOK_JUDGES, CALL_LOOK_RESULTS, CALL_LOOK_SENSES, callLookLabels, type CallLookFields } from './call-look-journal';
import { SPEECH_FAILURES, VOICE_INPUT_FAILURES, type SpeechFailure, type VoiceInputFailure } from './speech-failure';
import { DEFERRED_WHILES, SETTING_DEFERRALS, type DeferredWhile, type SettingDeferral } from './interrupt-policy';
import { readingSegmentsFrom, readingSegmentsWords, speechDetailFrom, speechDetailWords, type ReadingSegmentsFields, type SpeechFailureDetail } from './voice-gaps-journal';
import { ASSISTANT_NAME } from '../foundation/assistant-name';

/*
 * 第一批新记录项 (2026-11-06, docs/claude/2026-11-06-journal-batch1.md): numbers and closed categories only, never a word of chat.
 * reading-time: one reply's reading (how long until the first sound, how long it waited, how many characters, which voice, how it ended).
 */
export const READING_PROVIDERS = ['system', 'bailian', 'fish', 'other'] as const;
export type ReadingProvider = (typeof READING_PROVIDERS)[number];
export const READING_RESULTS = ['played', 'partial', 'unread'] as const;
export type ReadingResult = (typeof READING_RESULTS)[number];
export const READING_WHYS = ['cancelled', 'off', 'failed', 'hidden'] as const;
export type ReadingWhy = (typeof READING_WHYS)[number];
/** (the 16:55 reading cuts): who ended a reading that was cancelled (closed words; no known cause keeps the old line). */
export const READING_CANCEL_BYS = ['new-reply', 'interrupt', 'hang-up', 'stop', 'error', 'superseded',
  // ("有一句话没读出来", a cancel with no cause): the other places that cancel a reading; 'unlogged' is a path that gave no reason (never written by a path that knows it)
  'voice-input', 'hidden', 'switch', 'window', 'away', 'unlogged',
  // 2026-11-24 (12:26, a reply shown and never read): why a reply that was shown was not handed to her voice, or asked for and dropped on the way
  'newer-line', 'no-appraisal', 'not-complete', 'not-asked', 'not-shown', 'chat-busy', 'not-ready'] as const;
export type ReadingCancelBy = (typeof READING_CANCEL_BYS)[number];
const READING_CANCEL_BY_LABEL: Readonly<Record<ReadingCancelBy, string>> = Object.freeze({ 'new-reply': '她的下一条回复开始了', interrupt: '你打断了她', 'hang-up': '电话挂断了',
  stop: '叫停了朗读', error: '朗读出错', superseded: '这条回复被换掉了（合并、换了上下文）',
  'voice-input': '你开口说话了', hidden: '桌宠窗口收起了', switch: '换了模式、声音或设置', window: '窗口关了', away: '你走开了，朗读安静结束', unlogged: '有一条取消的路没记原因',
  'newer-line': '你的下一句话先到了，这条没交给声音', 'no-appraisal': '这条回复没有语气评估，没交给声音', 'not-complete': '这段话没处理完整，这条没交给声音',
  'not-asked': '交给声音以后，声音一直没来要第一句', 'not-shown': '窗口没显示，这条没读', 'chat-busy': '新的一轮已经开始，这条没读', 'not-ready': '气泡还没就绪，这条没读' });
const SETTING_DEFERRAL_LABEL: Readonly<Record<SettingDeferral, string>> = Object.freeze({ connection: '换了连接', persona: '她的角色设定变了', 'sight-off': '关掉了看' });
const DEFERRED_WHILE_LABEL: Readonly<Record<DeferredWhile, string>> = Object.freeze({ replying: '她正在回复', speaking: '她正在朗读' });
export const VOICE_TIME_RESULTS = ['text', 'no-sound', 'no-words', 'failed'] as const;
export type VoiceTimeResult = (typeof VOICE_TIME_RESULTS)[number];
export const VOICE_TIME_ENGINES = ['local', 'compatible', 'other'] as const;
export const VOICE_CAPTURE_ENDS = ['stopped', 'no-sound', 'failed'] as const;
export type VoiceCaptureEnd = (typeof VOICE_CAPTURE_ENDS)[number];
export const VOICE_DEVICES = ['default', 'specified', 'unknown'] as const;
/** I-091 (shared/voice/voice-call.ts): how a call started and why it ended. */
export const VOICE_CALL_VIAS = ['button', 'chat', 'channel', 'name'] as const; // 'name': she was called by name in Unbound (v1 step 3)
export const VOICE_CALL_END_REASONS = ['user', 'silence', 'voice-off', 'asleep', 'hidden', 'quit'] as const;
export const VOICE_CALL_END_BYS = ['smart-turn', 'smart-waited', 'silence'] as const;
const VOICE_CALL_END_BY_LABEL: Readonly<Record<(typeof VOICE_CALL_END_BYS)[number], string>> = Object.freeze({
  'smart-turn': '说完了吗模型判断你说完了，马上交给识别', 'smart-waited': '说完了吗模型判断你还没说完，等够了安静才算说完', silence: '按安静时长判断你说完' });
/**
 * What a held clip was, and what interrupted her (shared/behaviors/interrupt/judge.ts). I-204: new lines
 * say 'chars' (three or more recognized characters) and carry the clip's recognized characters and echo match; 'sentence' and 'command'
 * (the 2026-11-19 rule) stay readable in older lines.
 */
export const VOICE_HELD_KINDS = ['filler', 'fragment', 'echo'] as const;
export const VOICE_INTERRUPT_BYS = ['sentence', 'command', 'chars'] as const;
const VOICE_HELD_LABEL: Readonly<Record<(typeof VOICE_HELD_KINDS)[number], string>> = Object.freeze({
  filler: '只有“嗯、啊”这类语气词', fragment: '认出的字不够', echo: '是她自己正在读的话' });
const VOICE_INTERRUPT_LABEL: Readonly<Record<(typeof VOICE_INTERRUPT_BYS)[number], string>> = Object.freeze({
  sentence: '一句完整的话', command: '叫停的话，比如“等一下”', chars: '认出了够数的字' });
/** I-204: a held or interrupting clip's numbers (recognized characters 0–100000, echo match 0–1); absent when not given. */
function gateFields(v: Record<string, unknown>): { chars?: number; match?: number } {
  const chars = count(v.chars, 100_000), match = unit(v.match);
  return { ...(chars === undefined ? {} : { chars }), ...(match === undefined ? {} : { match }) };
}
/** The numbers in words: "；认出 N 个字，和她念的对得上 0.42". */
function gateWords(entry: { chars?: number; match?: number }, tr: JournalTranslate): string {
  return (entry.chars === undefined ? '' : tr('；认出 {0} 个字', String(entry.chars))) + (entry.match === undefined ? '' : tr('；和她正在念的话对得上 {0}', entry.match.toFixed(2)));
}
const VOICE_CALL_END_LABEL: Readonly<Record<(typeof VOICE_CALL_END_REASONS)[number], string>> = Object.freeze({
  user: '你挂的', silence: '很久没人说话，自动挂断', 'voice-off': '语音输入关了', asleep: '她睡着了', hidden: '桌宠不在屏幕上', quit: '应用退出' });

const READING_PROVIDER_LABEL: Readonly<Record<ReadingProvider, string>> = { system: '系统语音', bailian: '百炼语音', fish: 'Drama 3 语音', other: '其他朗读方式' };
const READING_WHY_LABEL: Readonly<Record<ReadingWhy, string>> = { cancelled: '被取消', off: '朗读关着', failed: '朗读出错', hidden: '桌宠窗口没显示' };
const VOICE_DEVICE_LABEL: Readonly<Record<(typeof VOICE_DEVICES)[number], string>> = { default: '默认', specified: '指定的', unknown: '不明的' };

/** Plain words for the closed failure categories (journal lines only). */
export const SPEECH_FAILURE_LABEL: Readonly<Record<SpeechFailure, string>> = {
  network: '网络', auth: '鉴权', quota: '额度', service: '服务错误', timeout: '超时', other: '其他',
};
export const VOICE_INPUT_FAILURE_LABEL: Readonly<Record<VoiceInputFailure, string>> = {
  'needs-component': '本机识别组件还没下载', preparing: '本机识别组件还在准备', 'local-failed': '本机识别出错', unreachable: '识别服务连不上',
  service: '识别服务出错', timeout: '识别超时', other: '其他', 'no-sound': '麦克风几乎没有声音', empty: '听到了声音但没识别出字',
};

/** The journal entry types of this part, in JOURNAL_TYPES order (shared/memory/journal.ts dispatches by it). */
export const VOICE_JOURNAL_TYPES = ['speech', 'voice-input', 'audio-reading', 'reading-time', 'voice-time', 'voice-capture', 'voice-call', 'speech-cue', 'reading-segments', 'setting-deferred'] as const;

/** What a caller hands to the writer for this part's types (shared/memory/journal.ts JournalInput joins every part's). */
export type VoiceJournalInput =
  /** 朗读失败: a paid reading (Bailian, or Drama 3 since I-070) that did not play, by closed category only — never the reply, never an address or key. */
  | ({ type: 'speech'; characterId: string | null; provider: 'bailian' | 'fish'; failure: SpeechFailure } & SpeechFailureDetail /* 2026-11-24: error kind, retried, which reply and sentence */)
  /** 语音输入没听到: why recognition failed or was refused, by closed category; never audio, never words. */
  | { type: 'voice-input'; characterId: string | null; engine: 'local' | 'compatible'; failure: VoiceInputFailure; stopped: boolean; /** Loudest level of the clip in whole dBFS (a number, never audio); only on 'empty'. */ peakDb?: number }
  /**
   * 陪听歌、看剧的转写没成 (2026-11-03, electron/senses/asr/ambient-route.ts): why a switch could not turn on (`refused`) or a clip of the
   * played sound was not transcribed, by the same closed categories as voice input; never audio, never words.
   */
  | { type: 'audio-reading'; characterId: string | null; engine: 'local' | 'compatible'; failure: VoiceInputFailure; refused: boolean }
  /** 她的朗读时间: one reply's reading. firstAudioMs: first text shown -> first sound; waitMs: accepted -> handed to the voice. */
  | { type: 'reading-time'; characterId: string | null; firstAudioMs: number | null; waitMs: number | null; chars: number; provider: ReadingProvider;
      result: ReadingResult; why: ReadingWhy | null; firstSinceStart: boolean; /** Only with why 'cancelled': who cancelled it. */ cancelBy?: ReadingCancelBy;
      /** I-150: the first sound waited this long for the headphones to wake (already inside firstAudioMs); absent when not held. */ wakeHoldMs?: number;
      /** 2026-11-24: only with why 'failed': a paid reading failed after the same sentence had been tried a second time; `reply`: the reply's number in this run (lines up with the speech row). */ afterRetry?: true; reply?: number }
  /** 语音输入时间: from the end of the user's speech to the text (ms), the recognition alone (ms), the clip's length (s); never the words. */
  | { type: 'voice-time'; characterId: string | null; ms: number | null; recognizeMs: number | null; seconds: number | null; result: VoiceTimeResult;
      engine: (typeof VOICE_TIME_ENGINES)[number] }
  /** 语音输入的麦克风数字: what one capture received (chunks, loudest sample and RMS, the gate, sample rate, device kind, her speaking pause). */
  | { type: 'voice-capture'; characterId: string | null; end: VoiceCaptureEnd; chunks: number; peak: number; rms: number; threshold: number;
      sampleRate: number; device: (typeof VOICE_DEVICES)[number]; pausedAtStart: boolean; pausedMs: number; seconds: number }
  /**
   * I-091 像打语音电话一样和她聊天: a call started (how), ended (why, how long, turns, interruptions), one turn's timing from the
   * user's last voiced moment (ms; null when it did not happen), or her Claude process for a call turn (warm or not, first delta).
   * Numbers and closed categories only; never audio or words.
   */
  | { type: 'voice-call'; characterId: string | null; event: 'start'; via: (typeof VOICE_CALL_VIAS)[number] }
  | { type: 'voice-call'; characterId: string | null; event: 'end'; reason: (typeof VOICE_CALL_END_REASONS)[number]; seconds: number; turns: number; bargeIns: number;
      /** I-177 batch 2 ("先侧耳听，再判断"): with a cloud voice, how the clips said over her ended: she stopped (a sentence or a stop word) or went on. Counts only. */
      ducks?: { stop: number; resume: number } }
  | { type: 'voice-call'; characterId: string | null; event: 'turn'; endpointMs: number | null; handInMs: number | null; textMs: number | null;
      fillerMs: number | null; firstCharMs: number | null; firstSoundMs: number | null; soundAfterCharMs?: number | null; earlyRead?: boolean | null; bargeIn: boolean;
      /** I-099: the user's last speech frame → her first sound (her "嗯" or the reply); `vad`: that frame was found by the call's VAD. */
      endToSoundMs?: number | null; vad?: boolean;
      /** I-099/I-100: how the end was decided: the turn model said finished / it said not yet and the long silence ended it / the plain silence rule. */
      endBy?: (typeof VOICE_CALL_END_BYS)[number];
      /** I-099/I-100: the guard switched the turn model off for the rest of this call (it kept making her wait for nothing). */
      smartTurnOff?: 'guard';
      /** I-161: a segment that asked her to look: the decision, the capture and the tickets (ms; the host's own number). */
      lookMs?: number | null }
  | { type: 'voice-call'; characterId: string | null; event: 'claude'; process: FirstCharProcess; firstDeltaMs: number | null }
  /** I-161: one segment that considered a look: by which path, which senses were on, what the judgment answered, and why no look happened. Closed words only. */
  | ({ type: 'voice-call'; characterId: string | null; event: 'look' } & CallLookFields)
  /**
   * a recognized clip that was held (did not interrupt her, was not a turn: fillers only, a fragment, her own echo, or
   * noise heard as "嗯"), whether she was speaking, and whether a call was on in that window; or a clear sentence / stop command that
   * interrupted her. A count with closed categories only; never the words.
   */
  | { type: 'voice-call'; characterId: string | null; event: 'held'; kind: (typeof VOICE_HELD_KINDS)[number]; overHer: boolean; call: boolean; chars?: number; match?: number }
  | { type: 'voice-call'; characterId: string | null; event: 'interrupt'; by: (typeof VOICE_INTERRUPT_BYS)[number]; overHer: boolean; call: boolean; chars?: number; match?: number }
  /**
   * I-197: in a call, a line said after the previous one was handed over and before her voice started was added on to it: how long
   * after (gapMs), whether that request had already been written to her process, how many characters she wrote that were never voiced
   * and so were dropped. Numbers and a flag only.
   */
  | { type: 'voice-call'; characterId: string | null; event: 'add-on'; gapMs: number | null; written: boolean; dropped: number }
  /** I-066 你现在方便吗: a speech cue held or let pass before the inner loop, and what became of a held intent (shared/voice/speech-cue.ts). Never words. */
  | { type: 'speech-cue'; characterId: string; outcome: SpeechCueOutcome; why: SpeechCueReason }
  /** 2026-11-24 每一句话都停: one reply's per-sentence timing (synthesis time, the silence before it played, provider). Numbers and closed words only. */
  | ({ type: 'reading-segments'; characterId: string | null } & ReadingSegmentsFields)
  /** 2026-11-25 只有插话会打断她: a change that had to restart or clear something waited until her reply and its voice were done (closed words only). */
  | { type: 'setting-deferred'; characterId: string | null; what: SettingDeferral; during: DeferredWhile };

// ---------------------------------------------------------------- the fixed plain-language reasons

/** The fixed reason of this part's entries (shared/memory/journal.ts journalReason). Only enum fields choose it; nothing a caller wrote can reach it. */
export function voiceJournalReason(entry: VoiceJournalInput): string {
  switch (entry.type) {
    case 'speech': return '这次朗读没读出来';
    case 'voice-input': return entry.stopped ? '语音输入没听到你，已经关掉' : entry.failure === 'no-sound' || entry.failure === 'empty' ? '语音输入开着，但没听到字' : '语音输入没能打开';
    case 'audio-reading': return entry.refused ? '陪听歌、看剧没能打开' : '一段播放的声音没能转写';
    case 'reading-time': return entry.result === 'played' ? '她读完了这条回复' : entry.result === 'partial' ? '这条回复只读了一部分' : '这条回复没有读';
    case 'voice-time': return entry.result === 'text' ? '你说完话，转成了文字' : entry.result === 'no-sound' ? '你说话时麦克风没有声音'
      : entry.result === 'no-words' ? '听到了声音但没转出字' : '语音转文字失败了';
    case 'voice-call': return entry.event === 'start' ? '开始了一通电话' : entry.event === 'end' ? '一通电话挂断了' : entry.event === 'turn' ? '电话里这一轮的时间'
      : entry.event === 'held' ? '听到一段话，没打断她、也没当成你说的' : entry.event === 'interrupt' ? '你说了一句话，打断了她' : entry.event === 'look' ? '这一句话里要不要看画面'
      : entry.event === 'add-on' ? '她还没出声，你补的一句接到了上一句后面' : '电话里这一轮她的进程';
    case 'voice-capture': return entry.end === 'no-sound' ? '麦克风一直是静音，语音输入的收音数字' : entry.end === 'failed' ? '语音输入出错了，这是收音数字' : '一次语音输入结束，这是收音数字';
    case 'speech-cue': return SPEECH_CUE_OUTCOME_WORDS[entry.outcome];
    case 'reading-segments': return '这条回复每一句的合成和空档时间';
    case 'setting-deferred': return '一项设置的改动等她说完才生效，没有打断她';
  }
}

// ---------------------------------------------------------------- building a line (the whitelist)

/**
 * This part's lines, field by field from closed sets (shared/memory/journal.ts buildJournalEntry checked the input, the type and the
 * character id, and adds the version, the time and the reason). Null when anything does not fit.
 */
export function buildVoiceJournalEntry(type: string, v: Record<string, unknown>, characterId: string | null): VoiceJournalInput | null {
  let body: VoiceJournalInput | null = null;
  switch (type) {
    case 'speech':
      if ((v.provider !== 'bailian' && v.provider !== 'fish') || !has(SPEECH_FAILURES, v.failure)) return null;
      body = { type, characterId, provider: v.provider, failure: v.failure, ...speechDetailFrom(v) };
      break;
    case 'voice-input':
      if ((v.engine !== 'local' && v.engine !== 'compatible') || !has(VOICE_INPUT_FAILURES, v.failure)) return null;
      body = { type, characterId, engine: v.engine, failure: v.failure, stopped: v.stopped === true,
        ...(typeof v.peakDb === 'number' && Number.isFinite(v.peakDb) ? { peakDb: Math.max(-120, Math.min(0, Math.round(v.peakDb))) } : {}) };
      break;
    case 'audio-reading':
      if ((v.engine !== 'local' && v.engine !== 'compatible') || !has(VOICE_INPUT_FAILURES, v.failure)) return null;
      body = { type, characterId, engine: v.engine, failure: v.failure, refused: v.refused === true };
      break;
    case 'reading-time': {
      const chars = count(v.chars, 100_000);
      if (chars === undefined || !has(READING_PROVIDERS, v.provider) || !has(READING_RESULTS, v.result) || (v.why != null && !has(READING_WHYS, v.why))
        || (v.result === 'played' && v.why != null) || (v.result !== 'played' && v.why == null)) return null;
      body = { type, characterId, firstAudioMs: ms(v.firstAudioMs), waitMs: ms(v.waitMs), chars, provider: v.provider, result: v.result,
        why: (v.why ?? null) as ReadingWhy | null, firstSinceStart: v.firstSinceStart === true,
        ...(v.why === 'cancelled' && has(READING_CANCEL_BYS, v.cancelBy) ? { cancelBy: v.cancelBy } : {}),
        ...(v.why === 'failed' && v.afterRetry === true ? { afterRetry: true as const } : {}), ...(count(v.reply, 1_000_000) === undefined ? {} : { reply: count(v.reply, 1_000_000)! }),
        ...((ms(v.wakeHoldMs) ?? 0) > 0 ? { wakeHoldMs: ms(v.wakeHoldMs)! } : {}) };
      break;
    }
    case 'voice-time': {
      if (!has(VOICE_TIME_RESULTS, v.result) || !has(VOICE_TIME_ENGINES, v.engine)) return null;
      const seconds = finite(v.seconds) && v.seconds >= 0 ? round(Math.min(3_600, v.seconds), 1) : null;
      body = { type, characterId, ms: ms(v.ms), recognizeMs: ms(v.recognizeMs), seconds, result: v.result, engine: v.engine };
      break;
    }
    case 'voice-call': {
      if (v.event === 'start') { if (!has(VOICE_CALL_VIAS, v.via)) return null; body = { type, characterId, event: 'start', via: v.via }; break; }
      if (v.event === 'end') {
        const seconds = count(v.seconds, 7 * 86_400), turns = count(v.turns, 100_000), bargeIns = count(v.bargeIns, 100_000);
        if (!has(VOICE_CALL_END_REASONS, v.reason) || seconds === undefined || turns === undefined || bargeIns === undefined) return null;
        const d = v.ducks && typeof v.ducks === 'object' ? v.ducks as Record<string, unknown> : null, stop = d ? count(d.stop, 100_000) : undefined, resume = d ? count(d.resume, 100_000) : undefined;
        body = { type, characterId, event: 'end', reason: v.reason, seconds, turns, bargeIns, ...(stop !== undefined && resume !== undefined && stop + resume > 0 ? { ducks: { stop, resume } } : {}) }; break;
      }
      if (v.event === 'turn') {
        body = { type, characterId, event: 'turn', endpointMs: ms(v.endpointMs), handInMs: ms(v.handInMs), textMs: ms(v.textMs), fillerMs: ms(v.fillerMs),
          firstCharMs: ms(v.firstCharMs), firstSoundMs: ms(v.firstSoundMs), soundAfterCharMs: ms(v.soundAfterCharMs), earlyRead: typeof v.earlyRead === 'boolean' ? v.earlyRead : null, bargeIn: v.bargeIn === true,
          endToSoundMs: ms(v.endToSoundMs), vad: v.vad === true, ...(has(VOICE_CALL_END_BYS, v.endBy) ? { endBy: v.endBy } : {}), ...(v.smartTurnOff === 'guard' ? { smartTurnOff: 'guard' as const } : {}),
          ...(ms(v.lookMs) === null ? {} : { lookMs: ms(v.lookMs) }) }; break;
      }
      if (v.event === 'held') { if (!has(VOICE_HELD_KINDS, v.kind)) return null; body = { type, characterId, event: 'held', kind: v.kind, overHer: v.overHer === true, call: v.call === true, ...gateFields(v) }; break; }
      if (v.event === 'interrupt') { if (!has(VOICE_INTERRUPT_BYS, v.by)) return null; body = { type, characterId, event: 'interrupt', by: v.by, overHer: v.overHer === true, call: v.call === true, ...gateFields(v) }; break; }
      if (v.event === 'add-on') { const dropped = count(v.dropped, 100_000); if (dropped === undefined) return null; body = { type, characterId, event: 'add-on', gapMs: ms(v.gapMs), written: v.written === true, dropped }; break; }
      if (v.event === 'claude') { if (!has(FIRST_CHAR_PROCESSES, v.process)) return null; body = { type, characterId, event: 'claude', process: v.process, firstDeltaMs: ms(v.firstDeltaMs) }; break; }
      if (v.event === 'look') {
        if (!has(CALL_LOOK_SENSES, v.rules) || !has(CALL_LOOK_JUDGES, v.judge) || !has(CALL_LOOK_ANSWERS, v.answer) || !has(CALL_LOOK_RESULTS, v.result)) return null;
        body = { type, characterId, event: 'look', call: v.call === true, ...(v.chat === true ? { chat: true } : {}), rules: v.rules, judge: v.judge, answer: v.answer, camera: v.camera === true, screen: v.screen === true, result: v.result }; break;
      }
      return null;
    }
    case 'voice-capture': {
      const chunks = count(v.chunks, 10_000_000), rate = count(v.sampleRate, 400_000), paused = count(v.pausedMs, 24 * 3_600_000), seconds = finite(v.seconds) && v.seconds >= 0 ? round(Math.min(86_400, v.seconds), 1) : undefined;
      if (!has(VOICE_CAPTURE_ENDS, v.end) || chunks === undefined || rate === undefined || paused === undefined || seconds === undefined || !has(VOICE_DEVICES, v.device)
        || !finite(v.peak) || !finite(v.rms) || !finite(v.threshold)) return null;
      body = { type, characterId, end: v.end, chunks, peak: round(Math.min(1, Math.max(0, v.peak)), 5), rms: round(Math.min(1, Math.max(0, v.rms)), 5),
        threshold: round(Math.min(1, Math.max(0, v.threshold)), 4), sampleRate: rate, device: v.device, pausedAtStart: v.pausedAtStart === true, pausedMs: paused, seconds };
      break;
    }
    case 'reading-segments': {
      const fields = readingSegmentsFrom(v);
      if (!fields) return null;
      body = { type, characterId, ...fields };
      break;
    }
    case 'setting-deferred':
      if (!has(SETTING_DEFERRALS, v.what) || !has(DEFERRED_WHILES, v.during)) return null;
      body = { type, characterId, what: v.what, during: v.during };
      break;
    case 'speech-cue':
      if (!characterId || !has(SPEECH_CUE_OUTCOMES, v.outcome) || !SPEECH_CUE_PAIRS[v.outcome].includes(v.why as SpeechCueReason)) return null;
      body = { type, characterId, outcome: v.outcome, why: v.why as SpeechCueReason };
      break;
  }
  return body;
}

// ---------------------------------------------------------------- "刚才发生了什么": one plain line per entry

/** This part's entries in the control window, after the time (shared/memory/journal.ts describeJournalEntry); `reason` is the entry's reason, translated. */
export function describeVoiceJournalEntry(entry: VoiceJournalInput, reason: string, tr: JournalTranslate): string {
  let body: string;
  switch (entry.type) {
    case 'speech': body = tr('{0}（{1}）', reason, tr(SPEECH_FAILURE_LABEL[entry.failure])) + speechDetailWords(entry, tr); break;
    case 'voice-input': case 'audio-reading': body = tr('{0}（{1}）', reason, tr(VOICE_INPUT_FAILURE_LABEL[entry.failure])); break;
    case 'reading-time': {
      const parts = [tr(READING_PROVIDER_LABEL[entry.provider]), tr('{0} 字', entry.chars)];
      if (entry.firstAudioMs !== null) parts.push(tr('出声用了 {0} 秒', (entry.firstAudioMs / 1000).toFixed(2)));
      if (entry.wakeHoldMs) parts.push(tr('其中等耳机醒 {0} 秒', (entry.wakeHoldMs / 1000).toFixed(2))); // I-150
      if (entry.waitMs !== null) parts.push(tr('排队 {0} 秒', (entry.waitMs / 1000).toFixed(2)));
      if (entry.why) parts.push(tr(READING_WHY_LABEL[entry.why]) + (entry.cancelBy ? tr('：{0}', tr(READING_CANCEL_BY_LABEL[entry.cancelBy])) : '') + (entry.afterRetry ? tr('，重试一次后仍然失败') : ''));
      if (entry.reply !== undefined) parts.push(tr('第 {0} 条回复', String(entry.reply)));
      if (entry.firstSinceStart) parts.push(tr('启动后第一句'));
      body = tr('{0}（{1}）', reason, parts.join(tr('、')));
      break;
    }
    case 'voice-time': {
      const parts = [tr(entry.engine === 'local' ? '本机识别' : entry.engine === 'compatible' ? '转写地址' : '其他识别方式')];
      if (entry.seconds !== null) parts.push(tr('录了 {0} 秒', entry.seconds.toFixed(1)));
      if (entry.ms !== null) parts.push(tr('说完到出字 {0} 秒', (entry.ms / 1000).toFixed(2)));
      if (entry.recognizeMs !== null) parts.push(tr('其中识别 {0} 秒', (entry.recognizeMs / 1000).toFixed(2)));
      body = tr('{0}（{1}）', reason, parts.join(tr('、')));
      break;
    }
    case 'voice-call': {
      const sec = (n: number | null) => n === null ? tr('没有') : tr('{0} 秒', (n / 1000).toFixed(2));
      if (entry.event === 'start') body = tr('{0}（{1}）', reason, tr(entry.via === 'button' ? '点了通话按钮' : entry.via === 'chat' ? '在聊天里说的' : `你的 ${ASSISTANT_NAME} 替你开的，你在弹窗里允许了`));
      else if (entry.event === 'end') body = tr('{0}（{1}，打了 {2} 秒，{3} 轮，打断她 {4} 次）', reason, tr(VOICE_CALL_END_LABEL[entry.reason]), String(entry.seconds), String(entry.turns), String(entry.bargeIns))
        + (entry.ducks ? tr('；你开口时她先放低声音 {0} 次：停下听你 {1} 次、接着说 {2} 次', String(entry.ducks.stop + entry.ducks.resume), String(entry.ducks.stop), String(entry.ducks.resume)) : ''); // I-177 batch 2
      else if (entry.event === 'turn') body = tr('{0}：从你最后一个字的声音算起，判断说完 {1}、交给识别 {2}、出字 {3}、她先"嗯" {4}、回复第一个字 {5}、第一个声音 {6}{7}{8}{9}{10}', reason,
        sec(entry.endpointMs), sec(entry.handInMs), sec(entry.textMs), sec(entry.fillerMs), sec(entry.firstCharMs), sec(entry.firstSoundMs),
        entry.soundAfterCharMs == null ? '' : tr('（写出第一个字后 {0} 秒开口，{1}）', (entry.soundAfterCharMs / 1000).toFixed(2), entry.earlyRead ? tr('开口时整条回复还没写完') : tr('开口时整条回复已写完')),
        entry.endToSoundMs === undefined ? '' : tr('；你说完到她出声共 {0}（{1}）', sec(entry.endToSoundMs), tr(entry.vad ? '语音检测判断你说完' : '按音量判断你说完')),
        entry.endBy ? tr('；{0}', tr(VOICE_CALL_END_BY_LABEL[entry.endBy])) + (entry.smartTurnOff ? tr('（说完了吗模型这通电话已关掉：老让她白等）') : '') : '',
        entry.bargeIn ? tr('；这一轮是你打断她开始的') : '') + (entry.lookMs == null ? '' : tr('；请她看画面，截图附图用了 {0}', sec(entry.lookMs)));
      else if (entry.event === 'held') body = tr('{0}（{1}；{2}）', reason, tr(VOICE_HELD_LABEL[entry.kind]), tr(entry.overHer ? '她正在说话' : '她没在说话') + (entry.call ? tr('，通话中') : '') + gateWords(entry, tr));
      else if (entry.event === 'interrupt') body = tr('{0}（{1}）', reason, tr(VOICE_INTERRUPT_LABEL[entry.by]) + (entry.overHer ? tr('，她正在说话') : '') + (entry.call ? tr('，通话中') : '') + gateWords(entry, tr));
      else if (entry.event === 'look') { const w = callLookLabels(entry); body = tr('{0}（{1}；开着：{2}；句式规则要看：{3}；语义判断：{4}，答：{5}；结果：{6}）', reason, tr(entry.chat ? '一条消息（打字或语音转文字）' : entry.call ? '通话中' : '语音输入'), tr(w.on), tr(w.rules), tr(w.judge), tr(w.answer), tr(w.result)); }
      else if (entry.event === 'add-on') body = tr('{0}（隔了 {1}；{2}；没念出来就丢掉的字：{3}）', reason, sec(entry.gapMs),
        tr(entry.written ? '上一句已经交给她的进程：停下那一轮，两句一起回' : '上一句还没交给她的进程，并成同一条'), String(entry.dropped));
      else body = tr('{0}：{1}，第一个字 {2}', reason, tr(entry.process === 'warm' ? '进程热着' : entry.process === 'prewarmed' ? '提前待命的新进程' : '临时新开的进程'), sec(entry.firstDeltaMs));
      break;
    }
    case 'voice-capture': {
      const db = (n: number) => n > 0 ? `${(20 * Math.log10(n)).toFixed(0)} dB` : tr('全零');
      const paused = entry.pausedAtStart || entry.pausedMs > 0
        ? tr('；她说话时暂停了 {0} 秒{1}', (entry.pausedMs / 1000).toFixed(1), entry.pausedAtStart ? tr('（开始时就在暂停）') : '') : '';
      body = tr('{0}：{1} 块音频、{2} 秒，最大峰值 {3}，最大 RMS {4}，门槛 {5}，{6} Hz，{7}输入设备{8}', reason, String(entry.chunks), entry.seconds.toFixed(1), db(entry.peak), db(entry.rms),
        db(entry.threshold), String(entry.sampleRate), tr(VOICE_DEVICE_LABEL[entry.device]), paused);
      break;
    }
    case 'speech-cue':
      body = tr('{0}（{1}）', reason, tr(SPEECH_CUE_REASON_WORDS[entry.why]));
      break;
    case 'reading-segments': body = tr('{0}：{1}', reason, readingSegmentsWords(entry, tr)); break;
    case 'setting-deferred': body = tr('{0}（{1}，{2}）', reason, tr(SETTING_DEFERRAL_LABEL[entry.what]), tr(DEFERRED_WHILE_LABEL[entry.during])); break;
    default: body = reason;
  }
  return body;
}
