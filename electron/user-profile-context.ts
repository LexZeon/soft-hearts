import type { ChatMessage } from '../shared/contracts';
import { UserProfileStore, type UserProfileView } from './user-profile';
import { isConversationOpening } from './diary/diary-data';

const communication = /回答|回复|说话|语气|称呼|叫我|简短|详细|交流|\b(?:repl(?:y|ies)|response|speak|tone|concise|detailed|call me)\b/iu;
const common = new Set(['喜欢', '希望', '想要', '你好', '用户', '我的', '可以', 'the', 'and', 'you', 'like', 'prefer', 'please']);
function terms(value: string): Set<string> {
  const normalized = value.normalize('NFKC').toLowerCase().slice(0, 4000);
  const result = new Set<string>();
  for (const word of normalized.match(/[a-z0-9]{3,40}|[\p{Script=Han}]{2,}/gu) ?? []) {
    if (/^[a-z0-9]/.test(word)) { if (!common.has(word)) result.add(word); }
    else for (let at = 0; at + 1 < word.length && result.size < 256; at++) {
      const pair = word.slice(at, at + 2); if (!common.has(pair)) result.add(pair);
    }
    if (result.size >= 256) break;
  }
  return result;
}

/** Bounded literal relevance only, not a new semantic search or personality score. */
export function selectUserProfileContext(view: UserProfileView, query: string): string[] {
  if (!view.enabled) return [];
  const queryTerms = terms(query);
  return view.entries.filter(entry => entry.kind !== 'pending_inference').map(entry => {
    const baseline = communication.test(entry.text) ? 1 : 0;
    const overlap = [...terms(entry.text)].filter(term => queryTerms.has(term)).length;
    return { entry, score: baseline * 2 + Math.min(overlap, 8) };
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.entry.manual) - Number(a.entry.manual) || b.entry.updatedAt - a.entry.updatedAt)
    .slice(0, 4).map(item => item.entry.id);
}

/** Each lease belongs to one actual host request; cancellation is local evidence. */
export class UserProfileContext {
  private readonly requests = new Map<string, () => boolean>();
  private cancellation = { requested: 0, localAbortAccepted: 0, failed: 0 };
  constructor(private readonly store: UserProfileStore) {}
  /** `messages` (the request's history window): on a conversation's first user turn her recent diary rides along (L3). */
  begin(query: string, cancel: () => boolean, messages?: readonly ChatMessage[], options: { memes?: boolean } = {}): string | null {
    try {
      const ids = selectUserProfileContext(this.store.view(), query);
      const diary = isConversationOpening(messages);
      if (!ids.length && !diary) return null;
      // 熟悉度: `memes` is the relationship's decision (default: from the first day; slowly warming: from "熟悉").
      const handle = this.store.createContext(ids, { diary, memes: options.memes === true });
      if (handle) this.requests.set(handle, cancel);
      return handle;
    } catch { return null; }
  }
  read(handle: string | null): string | null {
    if (!handle || !this.requests.has(handle)) return null;
    try { return this.store.readContext(handle); } catch { return null; }
  }
  release(handle: string | null): void {
    if (!handle) return;
    this.requests.delete(handle); this.store.releaseContext(handle);
  }
  invalidate(): { requested: number; localAbortAccepted: number; failed: number } {
    const pending = [...this.requests.values()]; this.requests.clear();
    const receipt = { requested: pending.length, localAbortAccepted: 0, failed: 0 };
    for (const cancel of pending) {
      try { if (cancel()) receipt.localAbortAccepted++; else receipt.failed++; }
      catch { receipt.failed++; }
    }
    this.cancellation = receipt;
    return { ...receipt }; // This does not prove a provider stopped or erased sent data.
  }
  get lastCancellation(): { requested: number; localAbortAccepted: number; failed: number } { return { ...this.cancellation }; }
}
