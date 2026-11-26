/**
 * I-209 step 4: in the control window's chat list, a reply of someone else on the full-screen
 * stage (not the desktop companion) shows her name instead of the companion's. The host says who it is (ChatStarted.speaker, only then); the
 * reply's row was just made by beginChat, so its label is the last assistant row's.
 */
export function labelReplySpeaker(root: ParentNode | null | undefined, speaker: unknown): boolean {
  if (!root || typeof speaker !== 'string' || !speaker.trim()) return false;
  const rows = root.querySelectorAll('.message.assistant');
  const label = rows[rows.length - 1]?.querySelector('.message-label');
  if (!label) return false;
  label.textContent = Array.from(speaker.trim()).slice(0, 40).join('');
  return true;
}
