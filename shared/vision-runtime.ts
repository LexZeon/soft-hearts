import type { ProactiveOrigin } from './proactive-speech';
/**
 * `autoCapture` / `intervalSeconds` were R09 自动截图 (a latest screen frame kept in memory every 2–300 s so a message could
 * attach it faster). Retired by 识图分三档第 1 步 (docs/claude/2026-11-03-image-depth-step1.md): a frame is taken only at the
 * moment the user asks her to look and dropped after that turn. The fields stay in the contract (additive only): the host
 * always reports `autoCapture: false` and ignores both when a window still sends them.
 */
export interface VisionOptions { autoCapture: boolean; intervalSeconds: number; proactiveVision: boolean; }
export interface VisionRuntimeState extends VisionOptions { supported: boolean; status: string; }
export type VisionOptionsPatch = Partial<VisionOptions>;
/** What R09 reports now: off, at its old default interval. */
export const RETIRED_AUTO_CAPTURE: Readonly<Pick<VisionOptions, 'autoCapture' | 'intervalSeconds'>> = Object.freeze({ autoCapture: false, intervalSeconds: 10 });

/**
 * The host's reading of `setVisionOptions`: the shape is checked as before (an unknown key or a wrong type is refused), the two
 * retired R09 keys are accepted and dropped, and only `proactiveVision` (R10 根据画面主动聊天) is returned.
 */
export function acceptVisionOptionsPatch(value: unknown): Pick<VisionOptionsPatch, 'proactiveVision'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('画面选项格式不正确。');
  const patch = value as Record<string, unknown>, keys = Object.keys(patch);
  if (!keys.length || keys.some(key => !['autoCapture', 'intervalSeconds', 'proactiveVision'].includes(key))
    || ('autoCapture' in patch && typeof patch.autoCapture !== 'boolean')
    || ('intervalSeconds' in patch && typeof patch.intervalSeconds !== 'number')
    || ('proactiveVision' in patch && typeof patch.proactiveVision !== 'boolean')) throw new Error('只允许修改主动话题选项。');
  return typeof patch.proactiveVision === 'boolean' ? { proactiveVision: patch.proactiveVision } : {};
}
export interface VisionInitiative { id: string; text: string; origin: ProactiveOrigin; }
export type VisionInitiativeEvent = { type: 'offer'; message: VisionInitiative } | { type: 'cancel'; id: string };
/** Display/archive label of an inner-loop line ("主动 · 自己想说的"). */
export const INNER_INITIATIVE_LABEL = '自己想说的';

/** Both host receipt and renderer use this one host-derived display string. */
export function formatVisionPresentation(message: Readonly<VisionInitiative>): string {
  const origin = message?.origin;
  if (!message || typeof message.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(message.id)
    || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 400
    || !origin || origin.kind !== 'proactive' || origin.id !== message.id
    || !Number.isSafeInteger(origin.at) || origin.at < 0 || !Array.isArray(origin.sources)
    || origin.sources.length < 1 || origin.sources.length > 2 || new Set(origin.sources).size !== origin.sources.length
    // The inner loop's own line shares this delivery path; it never mixes with an observed source.
    || !(origin.sources.every(source => source === 'screen' || source === 'camera')
      || (origin.sources.length === 1 && origin.sources[0] === 'inner'))) throw new Error('Invalid visual presentation identity');
  const labels = origin.sources.map(source => source === 'screen' ? '屏幕' : source === 'camera' ? '摄像头' : INNER_INITIATIVE_LABEL);
  if (!Array.isArray(origin.labels) || labels.length !== origin.labels.length
    || labels.some((label, index) => label !== origin.labels[index])) throw new Error('Invalid visual presentation sources');
  return `主动 · ${labels.join('、')}\n${message.text}`;
}

/** Audio-source opportunities may never enter the ordinary visual dispatch. */
export function isVisualAttentionCue(value: unknown): value is { id: string; kind: 'speech'; until: number; source?: undefined } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cue = value as Record<string, unknown>;
  return cue.kind === 'speech' && cue.source === undefined && typeof cue.id === 'string'
    && /^[A-Za-z0-9_-]{1,100}$/.test(cue.id) && typeof cue.until === 'number' && Number.isFinite(cue.until);
}
