import type { RouterVerdict } from '../../../shared/brain';
import { cleanNickname } from '../../../shared/memory/relationship';
import { saidInText } from '../../../shared/memory/nickname-table';

export interface NicknameRoutePorts {
  /** ModuleRouter.verdict (electron/brain/module-router/router.ts): haiku's reading of message `requestId` for one module. */
  verdict(requestId: string, moduleId: string): Promise<RouterVerdict>;
  relationship: {
    noteUserNickname(characterId: string, raw: unknown): Promise<unknown>;
    noteHerNickname(characterId: string, raw: unknown): Promise<unknown>;
  };
  /** The card's own name: a message that merely uses it is not a nickname. */
  cardName?(characterId: string): string | null;
}

const same = (a: string, b: string) => a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();

/**
 * 外号 on the I-023 调度台 (docs/claude/2026-11-07-nicknames.md). Called once her reply is done (never before: the router already ran
 * beside Opus). Nothing here waits for the chat: it is a fire-and-forget task whose errors change nothing. A name haiku brings only
 * counts when it passes cleanNickname (1–8 characters, plain text); the user's own "叫我 Y" is saved as theirs (their words are the
 * consent), a nickname for her is saved as hers. Neither name goes anywhere but the relationship file.
 */
export function createNicknameRoute(ports: NicknameRoutePorts): (requestId: string, characterId: string, userText?: string) => void {
  return (requestId, characterId, userText) => {
    void (async () => {
      const [her, user] = await Promise.all([ports.verdict(requestId, 'nickname-her'), ports.verdict(requestId, 'nickname-user')]);
      const cardName = (() => { try { return ports.cardName?.(characterId) ?? null; } catch { return null; } })();
      if (user.kind === 'called') {
        const name = cleanNickname(user.name);
        if (name) await ports.relationship.noteUserNickname(characterId, name);
      }
      if (her.kind === 'called') {
        const name = cleanNickname(her.name);
        // Unbound v1 step 3: a name for her goes into the nickname table only when the user's own words really contain it.
        if (name && !(cardName && same(name, cardName)) && saidInText(name, userText)) await ports.relationship.noteHerNickname(characterId, name);
      }
    })().catch(() => { /* A nickname that is not noticed this time simply is not saved. */ });
  };
}
