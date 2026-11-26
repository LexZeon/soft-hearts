// Two small pure helpers of the character wall, split out of CharacterPage.ts (it had reached its size ceiling; I-219). CharacterPage re-exports both.
import { uiText, uiTemplate } from '../foundation/ui-language';
import type { CharacterCard } from '../../shared/foundation/character-card';

/**
 * I-018: a card worth talking over on its own after it was imported or created: it has some persona besides the name
 * (a card made for a model with one line, C1, is not; "和 Claude 聊聊这个角色" still opens one any time).
 */
export function cardWorthDiscussing(card: Pick<CharacterCard, 'description' | 'personality' | 'scenario' | 'greeting' | 'examples' | 'systemPrompt'>): boolean {
  const text = [card.description, card.personality, card.scenario, card.greeting, card.examples, card.systemPrompt].map(value => value.trim()).join('');
  return [...text].length >= 40;
}

/** 今天 14:20 / 昨天 09:05 / 11月1日 (local time). */
export function lastChatText(at: number | null, now = Date.now()): string {
  if (at === null) return uiText('还没聊过');
  const day = (ms: number) => { const date = new Date(ms); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); };
  const date = new Date(at), time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return uiTemplate`上次聊天：今天 ${time}`;
  if (days === 1) return uiTemplate`上次聊天：昨天 ${time}`;
  return uiTemplate`上次聊天：${date.getMonth() + 1}月${date.getDate()}日`;
}
