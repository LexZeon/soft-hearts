// 保存她念出来的声音（用来比对）: the dev-only keep-her-voice tool (docs/claude/2026-11-24-voice-keep.md). Public page of this folder; the wiring
// (electron/wiring/voice-keep-wiring.ts) and the voice part's page use it from here.
export { voiceKeepAvailable } from './availability';
export type { VoiceKeepChannel } from './availability';
export { VoiceKeepHost } from './host';
export type { VoiceKeepHostPorts } from './host';
export { HER_READING, VoiceKeepRecorder } from './recorder';
export type { KeepInfo, SentenceTee } from './recorder';
export { voiceKeepChannelTool, VOICE_KEEP_DESCRIPTOR, VOICE_KEEP_TOOL } from './channel-tool';
export { VOICE_KEEP_DEFAULT_DAYS, VOICE_KEEP_MAX_DAYS, VOICE_KEEP_MIN_DAYS, VOICE_KEEP_SIZE_CAP_BYTES } from './knobs';
