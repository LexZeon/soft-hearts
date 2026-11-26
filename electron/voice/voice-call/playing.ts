/**
 * "Her call reading is audible or queued to play now" (the 16:55 reading cuts): the interruption gate counts it as her
 * speaking. Only while a call is on; then any of the plan holding a sentence (waiting to be read, being read), the host's reading
 * runtime, or the window's playback lease means she is still speaking. No clock: each of them follows the reading's own state.
 */
export interface CallPlayingPorts {
  /** A call is on. */
  call(): boolean;
  /** The plan or the host's reading runtime still holds a sentence of a reply (CompletedReplySpeech.busy, SpeechRuntime.busy). */
  holding(): boolean;
  /** The window's playback lease of a segment is open (SpeechPlaybackActivity.busy). */
  playback(): boolean;
}

export function callPlaying(ports: CallPlayingPorts): () => boolean {
  const ask = (read: () => boolean): boolean => { try { return read() === true; } catch { return false; } };
  return () => ask(ports.call) && (ask(ports.holding) || ask(ports.playback));
}
