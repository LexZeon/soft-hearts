/**
 * I-209 step 3: a turn of someone else on stage is written by HER card. The chat turn copies the app's
 * settings, whose persona is the desktop companion's (cards-ready-wiring keeps it in step with the active card); for another owner the copy
 * gets her own card's persona. Never the desktop companion's words in her place: a card that cannot be read throws (the turn fails), it never
 * falls back to the other one.
 */
/**
 * I-209 step 3: whether the history handed to Claude comes from HER own archive rather
 * than the control window's list. The control window shows every line you say on stage in one list (it sends them all), so with others on
 * stage that list mixes who said what. Her archive keeps only her own lines and yours, each with its speaker. As before (the renderer's list)
 * only when 新聊天 is off, it is the desktop companion's turn and nobody else is on stage.
 */
export function ownHistory(longChat: boolean, owner: string | null | undefined, current: string | null | undefined, othersOnStage: number): boolean {
  return longChat || (!!owner && owner !== current) || othersOnStage > 0;
}

export function ownerSettings<T extends { persona: string }>(settings: T, owner: string | null | undefined, current: string | null | undefined,
  personaOf: (characterId: string) => string): T {
  if (!owner || owner === current) return settings;
  const persona = personaOf(owner);
  if (typeof persona !== 'string' || !persona.trim()) throw new Error('这位角色的人设读不出来。');
  return { ...settings, persona };
}
