interface RoutedSpeech {
  recipientReply(owner: number, id: string): string | null;
  cancel(owner: number, id: string): boolean;
}
/** Capture the exact old routing identity before cancellation detaches it. */
export function cancelReplySpeechTransport(runtime: RoutedSpeech, owner: number, id: string, cancelReply: (replyId: string) => void): { cancelled: boolean; replyId: string | null } {
  const replyId = runtime.recipientReply(owner, id);
  if (!runtime.cancel(owner, id)) return { cancelled: false, replyId: null };
  if (replyId) cancelReply(replyId);
  return { cancelled: true, replyId };
}
