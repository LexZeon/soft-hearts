/**
 * I-159 C: the whole API the card beside her gets (`window.unboundCard`). Two things only: one tap on a button of the card it was
 * shown, and "here is a card (or its update)". No Node, no paths, no general invoke, no way to ask for anything but the tap.
 */
export const UNBOUND_CARD_CHANNELS = Object.freeze({
  choose: 'unbound:card-choose',
  show: 'unbound:card-show',
} as const);

export interface UnboundCardIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, card: unknown, language?: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, card: unknown, language?: unknown) => void): unknown;
}
export interface UnboundCardApi {
  /** A tap: the host answers with the card's new state (or null: nothing live to tap). */
  choose(request: { proposalId: string; choiceId: string }): Promise<unknown>;
  /** The host shows a card or updates it. `language` is the interface language ('' when it did not say). */
  onCard(callback: (card: unknown, language: string) => void): () => void;
}
export const UNBOUND_CARD_API_KEYS = Object.freeze(['choose', 'onCard'] as const);

export function createUnboundCardApi(ipc: UnboundCardIpc): UnboundCardApi {
  const api: UnboundCardApi = {
    choose: request => {
      const raw = request as { proposalId?: unknown; choiceId?: unknown } | null;
      if (!raw || typeof raw.proposalId !== 'string' || typeof raw.choiceId !== 'string') return Promise.reject(new TypeError('choose takes a proposal id and a choice id'));
      return ipc.invoke(UNBOUND_CARD_CHANNELS.choose, { proposalId: raw.proposalId.slice(0, 120), choiceId: raw.choiceId.slice(0, 20) });
    },
    onCard: callback => {
      if (typeof callback !== 'function') throw new TypeError('callback must be a function');
      const listener = (_event: unknown, card: unknown, language?: unknown) => callback(card, typeof language === 'string' ? language.slice(0, 16) : '');
      ipc.on(UNBOUND_CARD_CHANNELS.show, listener);
      return () => { ipc.removeListener(UNBOUND_CARD_CHANNELS.show, listener); };
    },
  };
  return Object.freeze(api);
}
