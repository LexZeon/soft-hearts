import type { ChatMessage } from '../shared/contracts';

// Refusal hints only: never use surrounding text as profile facts or authority.
const nonLiteral = /角色扮演|扮演|假装|假设|假如|虚构|剧本|台词|引用|转述|翻译|改写|润色|举例|例句|\b(?:role.?play|pretend|fiction|quote|translate|rewrite)\b|(?:^|\n)\s*>|```|\[历史中段省略\]/iu;

/** One opaque conversation key and refusal bit; no text or personal facts retained. */
export class UserProfileSource {
  private scope = '';
  private withheld = false;
  observe(scope: string | null, messages: readonly ChatMessage[]): boolean {
    if (!scope || !/^[a-f0-9]{64}$/.test(scope)) return false;
    if (scope !== this.scope) { this.scope = scope; this.withheld = false; }
    if (!Array.isArray(messages) || !messages.length || messages.length > 24) this.withheld = true;
    else for (const message of messages) {
      if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string'
        || message.content.length > 16000 || nonLiteral.test(message.content)) { this.withheld = true; break; }
    }
    return !this.withheld && messages.at(-1)?.role === 'user';
  }
  clear(): void { this.scope = ''; this.withheld = false; }
}
