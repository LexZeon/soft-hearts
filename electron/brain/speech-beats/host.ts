/**
 * 边说边演（docs/claude/2026-11-20-speech-beats-2-4.md）在主机这边的入口：聊天一轮从这里拿一个 SpeechBeatTurn，
 * 她的长对话窗口从这里拿插回了标记的聊天记录。一个配置文件夹一份（第一次用时建，不在导入时做任何事）。
 * 开关（「边说边演（Claude 编排）」）的值由接线读（shared/foundation/channel-defaults.ts 的 speechBeats：稳定版默认关，存下的选择优先）。
 */
import type { MemoryScope } from '../../../shared/memory';
import type { CardLanguage } from '../../../shared/foundation/character-card';
import type { SpeechBeatsEvent } from '../../../shared/behaviors/speech-beats/interface';
import type { SpeechBeatSituation } from '../../../shared/behaviors/speech-beats/availability';
import { SpeechBeatArchive } from './archive';
import { SpeechBeatTurn, type SpeechBeatCloseGate, type SpeechBeatCut } from './turn';
import { cleanCut, type CutRecord } from '../../../shared/foundation/reply-cut';

export { SpeechBeatTurn, type SpeechBeatCloseGate, type SpeechBeatCut, type SpeechBeatOutcome } from './turn';
export { SpeechBeatArchive, SPEECH_BEATS_FILE } from './archive';

/** Her chat archive as the long-chat window reads it (electron/brain/long-chat/host.ts LongChatArchive), with the reply hook. */
interface ChatWindowArchive {
  chatWindowSource(scope: MemoryScope, excludeTurnId?: string, replyFor?: (turnId: string, content: string) => string | null): ReturnType<LongChatSource>;
}
type LongChatSource = (scope: MemoryScope, excludeTurnId?: string) => { role: 'user' | 'assistant'; content: string; createdAt: number }[];

export class SpeechBeatsHost {
  readonly archive: SpeechBeatArchive;
  private situation: (() => SpeechBeatSituation | null) | null = null;
  private gate: SpeechBeatCloseGate | null = null;
  constructor(directory: string, archive?: SpeechBeatArchive) { this.archive = archive ?? new SpeechBeatArchive(directory); }

  /** I-185: where "what can she do now" is read (electron/wiring/unbound-wiring.ts gives it; absent: every word is offered, as before). */
  situate(read: (() => SpeechBeatSituation | null) | null): void { this.situation = typeof read === 'function' ? read : null; }
  /** 2026-11-23: where her words after a kiss or a hug wait for it (electron/unbound/close-sequence.ts); used only in full-screen Unbound while she is shown. */
  sequence(gate: SpeechBeatCloseGate | null): void { this.gate = gate && typeof gate.wait === 'function' ? gate : null; }

  /**
   * I-203: a reply whose kiss or hug was interrupted completed (archived once, whole): its cut record is filed beside it (the generic cut record,
   * shared/foundation/reply-cut.ts, cause 'pulled-away' / 'could-not-reach'), then whoever listens hears what it was (the Unbound wiring: her one
   * immediate turn's facts). Never throws into the chat turn.
   */
  fileCut(scope: MemoryScope, turnId: string, cut: CutRecord, event: SpeechBeatCut, text: string): void {
    const clean = cleanCut(cut);
    if (!clean || typeof turnId !== 'string' || !turnId) return;
    try { void this.archive.recordCut(scope, turnId, clean).catch(() => undefined); } catch { /* a record only */ }
    try { this.cutHeard?.(event, clean, typeof text === 'string' ? text : '', scope.characterId); } catch { /* information only */ } // I-209 step 2: whose reply was cut
  }
  heardCut(listener: ((event: SpeechBeatCut, cut: CutRecord, text: string, owner: string) => void) | null): void { this.cutHeard = typeof listener === 'function' ? listener : null; }
  private cutHeard: ((event: SpeechBeatCut, cut: CutRecord, text: string, owner: string) => void) | null = null;

  /**
   * One reply: `on` is the switch as it is now (read once for the whole turn), with what she can do now (read once too). `ordered` (2026-11-23):
   * this reply's stream waits behind a kiss / hug (the typed and voice-input chat turn awaits its end); a call's legs stream through the call's
   * own reading and do not.
   */
  begin(on: boolean, send: (event: SpeechBeatsEvent) => void, ordered = false): SpeechBeatTurn {
    let now: SpeechBeatSituation | null = null;
    if (on === true && this.situation) { try { now = this.situation() ?? null; } catch { now = null; } }
    // Only where she walks up for them (full-screen Unbound, shown): the window plays them in place over her words.
    return new SpeechBeatTurn(on === true, send, now, ordered === true && on === true && now?.surface === 'full' && now.shown ? this.gate : null, this.cardLanguage());
  }

  /** Her archive for the long-chat window: with the switch on, her replies come back as she wrote them (markers in place). */
  longChatArchive<A extends ChatWindowArchive>(memory: A | null | undefined, on: boolean, language?: CardLanguage | null): { chatWindowSource: LongChatSource } | null {
    if (!memory) return null;
    return { chatWindowSource: (scope, excludeTurnId) => memory.chatWindowSource(scope, excludeTurnId, this.archive.replyFor(scope, on, language ?? this.cardLanguage())) };
  }

  /** Her chat's language, for the cut marker of a cut reply (the companion sets it; absent: the marker reads in Chinese). */
  languageFrom(read: (() => CardLanguage | null) | null): void { this.language = typeof read === 'function' ? read : null; }
  private language: (() => CardLanguage | null) | null = null;
  cardLanguage(): CardLanguage | null { try { return this.language?.() ?? null; } catch { return null; } }
}

const hosts = new Map<string, SpeechBeatsHost>();
/** The host for this profile folder (made on first use). */
export function speechBeatsFor(directory: string): SpeechBeatsHost {
  let host = hosts.get(directory);
  if (!host) { host = new SpeechBeatsHost(directory); hosts.set(directory, host); }
  return host;
}
