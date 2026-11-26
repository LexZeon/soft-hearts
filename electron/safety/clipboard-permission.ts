// Every 「复制」 button in the app uses navigator.clipboard.writeText. The session's permission handlers deny whatever
// they do not name, so without this every copy failed with "Write permission denied" (Codex T-230, 2026-11-10): the
// channel setup lines, the Claude Desktop config and 「复制诊断信息」. Only writing, only the main frame of the app's own
// windows; reading the clipboard stays denied.
export const CLIPBOARD_WRITE_PERMISSION = 'clipboard-sanitized-write';

export function allowsClipboardWrite(permission: string, isMainFrame: boolean, ownWindow: boolean): boolean {
  return permission === CLIPBOARD_WRITE_PERMISSION && isMainFrame === true && ownWindow === true;
}
