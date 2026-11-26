// 通话里的「带我去」和设置提议 (2026-11-15). In a voice call she must have the same two helps typed chat has: a button to a page
// (TakeMeThere) and a setting card (ChatSettingProposals). Both are the typed chat's own host modules, used the same way: begin a
// turn from the user's words (older buttons and cards go inert), let her reply carry the private setting block, and after a
// complete reply show the button or card. Nothing here changes a setting or opens a page: only the user's tap does, and
// confirm-tier settings keep their own confirmation. No model call is added: the instruction rides in the leg's existing prompt,
// and only on a message that mentions a setting.
import type { ChatSettingProposals } from '../brain/chat-settings';
import type { TakeMeThere, TakeMeThereTurn } from '../initiative';
import type { SettingProposalOption } from '../mood';
import { interconnectTurnLine } from '../brain';
import type { OnceLine } from '../brain';
import type { I139Language } from '../../shared/brain';

export interface CallOfferTurn {
  /** For VoiceCompanionGroup.beginLeg: this utterance's setting instruction; undefined when the message names no setting. */
  readonly settingProposal: SettingProposalOption | undefined;
  /** A private line for her prompt about how to say it in a call ('' when nothing may be offered), then (I-137) the 三方互通 fact. */
  readonly note: string;
  readonly go: TakeMeThereTurn;
  readonly ticket: number;
  /** I-139 (only while `relaxed` gives something): the 三方互通 fact as a once-line, for the session (said on a process's first turn and when it changes). */
  readonly once?: OnceLine;
}

export interface CallOfferPorts {
  takeMeThere: Pick<TakeMeThere, 'beginTurn' | 'offer'>;
  chatSettings: Pick<ChatSettingProposals, 'beginTurn' | 'offer'>;
  /** I-137: 三方互通 is on (read every utterance); her prompt gets the one fact line. Absent: no line, as before. */
  interconnected?(): boolean;
  /** I-139: the switch and the card's language (null or absent: off, the line as before). */
  relaxed?(): { language?: I139Language | null } | null;
}

// She cannot see the screen, so she says what the user will see in her own words instead of reading UI text. Fallback wording only.
const SETTING_NOTE = '\n（通话里：设置提议的卡片会出现在用户屏幕上，你看不到屏幕，也不用念卡片上的字；像说话一样告诉这个人"我把选项放在屏幕上了，你点一下就好"这类意思，改不改由这个人点。）';
const GO_NOTE = '\n（通话里：用户想去的那一页，屏幕上会有一个按钮，点了才会过去；你不用念界面文字，自然地说一句"我把按钮放在旁边了"这类话，不要说已经带这个人过去了或已经改好了。）';

export class CallOffers {
  constructor(private readonly ports: CallOfferPorts) {}

  /** One utterance's text (the whole utterance so far on a continuation): older buttons and cards go away. */
  begin(userText: string): CallOfferTurn {
    const go = this.ports.takeMeThere.beginTurn(userText);
    const setting = this.ports.chatSettings.beginTurn(userText);
    const hasSetting = !!setting.instruction;
    let relaxed: { language?: I139Language | null } | null = null;
    try { relaxed = this.ports.relaxed?.() ?? null; } catch { relaxed = null; }
    const line = this.ports.interconnected ? interconnectTurnLine(() => this.ports.interconnected!(), relaxed) : '';
    return { settingProposal: hasSetting ? { instruction: setting.instruction } : undefined,
      note: (hasSetting ? SETTING_NOTE : go.destination ? GO_NOTE : '') + (line ? '\n' + line : ''), go, ticket: setting.ticket,
      ...(relaxed && line ? { once: { key: 'interconnect', text: line } } : {}) };
  }

  /** After a complete leg: her one setting card, or else the page button (a card is the answer, like in typed chat). */
  offer(turn: CallOfferTurn, owner: number, replyId: string, settingRaw: string | null | undefined): void {
    const card = this.ports.chatSettings.offer(turn.ticket, owner, replyId, settingRaw);
    this.ports.takeMeThere.offer(turn.go, owner, !!card);
  }
}
