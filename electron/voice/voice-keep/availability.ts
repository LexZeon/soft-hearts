// The one place that says where the keep-her-voice tool exists: development builds and source runs only (the same split as
// shared/brain/prompt-switches.ts promptSwitchDefaults: a source run has no installed channel and is not packaged). The stable channel
// and any packaged build without a channel get false, whatever a stale settings file says. Everything of the tool asks this first.
export type VoiceKeepChannel = 'stable' | 'development' | '' | null | undefined;
export function voiceKeepAvailable(channel: VoiceKeepChannel, packaged: boolean): boolean {
  if (channel === 'development') return true;
  if (channel === 'stable') return false;
  return !packaged;
}
