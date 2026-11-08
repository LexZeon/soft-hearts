import type { MemoryScope } from './memory';

export type AmbientMode = 'music' | 'movie';
export type AmbientLanguageCode = 'zh' | 'ja' | 'en';
export type AmbientLanguageEvidence = 'provider' | 'verified-detector';
/** Audited adapter diagnostics, never raw model text or a language-coverage guarantee. */
export interface AmbientLanguageDetection {
  version: 2;
  scope: 'whole-result' | 'subwindow-observations';
  windowAnalysis: 'not-requested' | 'skipped-empty' | 'failed' | 'complete';
}
/** Detection is supplied by an audited host adapter, never inferred from script or UI language. */
export type AmbientLanguage =
  | { status: 'detected'; language: AmbientLanguageCode; source: AmbientLanguageEvidence }
  | { status: 'mixed'; languages: AmbientLanguageCode[]; source: AmbientLanguageEvidence }
  | { status: 'unknown'; source: AmbientLanguageEvidence | 'unverified' }
  | { status: 'unsupported'; language?: string; source: AmbientLanguageEvidence };

export interface AmbientTranscriptInput {
  /** Host-owned stable final-segment identity. A retry must use the same identity. */
  id: string;
  sessionId: string;
  mode: AmbientMode;
  startedAt: number;
  endedAt: number;
  text: string;
  language: AmbientLanguage;
  title?: string;
  tags?: string[];
}
export interface AmbientTranscript extends AmbientTranscriptInput {
  source: 'system-audio' | 'microphone';
  /** Present only in the separate v2 archive; v1 storage is never widened. */
  purposes?: AmbientMode[];
  observations?: { segmentId: string; source: 'system-audio' | 'microphone'; purposes: AmbientMode[]; startedAt: number; endedAt: number; text: string }[];
  title: string;
  tags: string[];
  createdAt: number;
}
export interface AmbientTranscriptSummary extends Omit<AmbientTranscript, 'text'> {
  excerpt: string;
  totalCharacters: number;
}
/** Only an actual displayed assistant comment, acknowledged by the host, may be archived. */
export interface AmbientComment {
  id: string;
  sessionId: string;
  recordIds: string[];
  text: string;
  createdAt: number;
  source: 'ambient-assistant-comment';
}
export type AmbientCommentInput = Omit<AmbientComment, 'source'>;
export interface AmbientTranscriptQuery {
  query?: string;
  tag?: string;
  offset?: number;
  limit?: number;
}
export interface AmbientTranscriptPage {
  records: AmbientTranscriptSummary[];
  total: number;
  offset: number;
  limit: number;
  tags: string[];
}
export interface AmbientContextQuery {
  /** Required: history must not silently enter a new listening session or conversation. */
  sessionId: string;
  now?: number;
  maxRecords?: number;
  maxCharacters?: number;
}
export interface AmbientContextItem extends AmbientTranscriptSummary {
  text: string;
  truncated: boolean;
}
export interface AmbientUserResponse {
  /** The host supplies an accepted real user turn, never an ASR segment or assistant reply. */
  eventId: string;
  recordIds: string[];
  text: string;
  at: number;
}
/** A review input, not a remembered preference or another reward. */
export interface AmbientLongTermCandidate {
  id: string;
  eventId: string;
  recordIds: string[];
  userText: string;
  at: number;
  source: 'user-response-to-system-audio';
  requiresReview: true;
}
export interface AmbientDeleteResult {
  deleted: boolean;
  invalidatedCandidateIds: string[];
  deletedCommentIds?: string[];
}
export type AmbientScope = MemoryScope;

export const AMBIENT_AUDIO_LIMITS = Object.freeze({
  segmentCharacters: 12_000,
  titleCharacters: 120,
  tags: 12,
  tagCharacters: 40,
  pageRecords: 100,
  recentMilliseconds: 10 * 60_000,
  recentRecords: 12,
  recentCharacters: 6000,
  userResponseCharacters: 2000,
  commentCharacters: 500,
  commentRecordReferences: 3,
  archiveBytes: 64 * 1024 * 1024,
});

export function validateAmbientLanguage(value: unknown): AmbientLanguage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('系统音频语言信息不正确。');
  const input = value as Record<string, unknown>;
  const evidence = input.source === 'provider' || input.source === 'verified-detector';
  const code = (item: unknown): item is AmbientLanguageCode => item === 'zh' || item === 'ja' || item === 'en';
  const exact = (keys: string[]) => Object.keys(input).every(key => keys.includes(key));
  if (input.status === 'detected' && evidence && code(input.language) && exact(['status', 'language', 'source'])) {
    return { status: 'detected', language: input.language, source: input.source as AmbientLanguageEvidence };
  }
  if (input.status === 'mixed' && evidence && Array.isArray(input.languages) && input.languages.length >= 2
    && input.languages.length <= 3 && input.languages.every(code) && new Set(input.languages).size === input.languages.length
    && exact(['status', 'languages', 'source'])) {
    return { status: 'mixed', languages: [...input.languages], source: input.source as AmbientLanguageEvidence };
  }
  if (input.status === 'unknown' && (evidence || input.source === 'unverified') && exact(['status', 'source'])) {
    return { status: 'unknown', source: input.source as AmbientLanguageEvidence | 'unverified' };
  }
  if (input.status === 'unsupported' && evidence && (input.language === undefined
    || typeof input.language === 'string' && /^[A-Za-z][A-Za-z0-9 -]{0,31}$/.test(input.language))
    && exact(['status', 'language', 'source'])) {
    return { status: 'unsupported', source: input.source as AmbientLanguageEvidence,
      ...(input.language === undefined ? {} : { language: input.language as string }) };
  }
  throw new Error('系统音频语言信息未经有效检测，不能标记为已识别。');
}
