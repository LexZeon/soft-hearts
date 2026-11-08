// C2 角色页: the card wall's data, built from closures electron/main.ts supplies (no Electron import, testable).
import { stat } from 'node:fs/promises';
import { BUNDLED_CHARACTER_MODEL } from '../shared/character-cards';
import { effectiveCardModel } from '../shared/character-model';
import { characterInitial, characterTagline, type CharacterModelState, type CharacterRosterEntry, type CharacterRosterView } from '../shared/character-roster';
import { findModelPreview } from './character-avatars';

/** A host card record: the public card fields plus the host-only model path. */
export interface RosterCard { id: string; name: string; description: string; personality: string; modelPath?: string; modelName?: string }

export interface CharacterRosterPorts {
  cards(): RosterCard[];
  activeId(): string;
  revision(): number;
  presetGeneId(): Promise<string | null>;
  /** The saved half-body picture, or null. */
  avatar(id: string): Promise<string | null>;
  /** A model-folder picture file as a small data URL (main.ts resizes it with nativeImage), or null. */
  previewImage(file: string): Promise<string | null>;
  /** 认识第 N 天, or null before the first chat. */
  knownDay(id: string): Promise<number | null>;
  lastChatAt(id: string): number | null;
  pendingSwitchId(): string | null;
  /** Defaults to a file stat; tests replace it. */
  fileExists?(file: string): Promise<boolean>;
  /** Defaults to electron/character-avatars.ts findModelPreview. */
  findPreview?(modelPath: string): Promise<string | null>;
}

const exists = async (file: string) => { try { return (await stat(file)).isFile(); } catch { return false; } };

export async function buildCharacterRoster(ports: CharacterRosterPorts): Promise<CharacterRosterView> {
  const presetGeneId = await ports.presetGeneId(), activeId = ports.activeId();
  const entries: CharacterRosterEntry[] = [];
  for (const card of ports.cards()) {
    const linked = effectiveCardModel(card, presetGeneId);
    let state: CharacterModelState = 'none';
    if (linked === BUNDLED_CHARACTER_MODEL) state = 'bundled';
    else if (linked) state = await (ports.fileExists ?? exists)(linked) ? 'ok' : 'missing';
    let avatar: CharacterRosterEntry['avatar'] = { kind: 'initial', dataUrl: null, initial: characterInitial(card.name) };
    const snapshot = await ports.avatar(card.id).catch(() => null);
    if (snapshot) avatar = { ...avatar, kind: 'snapshot', dataUrl: snapshot };
    else if (state === 'ok' && linked) {
      const file = await (ports.findPreview ?? findModelPreview)(linked).catch(() => null);
      const preview = file ? await ports.previewImage(file).catch(() => null) : null;
      if (preview) avatar = { ...avatar, kind: 'preview', dataUrl: preview };
    }
    let knownDay: number | null = null;
    try { knownDay = await ports.knownDay(card.id); } catch { knownDay = null; }
    let lastChatAt: number | null = null;
    try { lastChatAt = ports.lastChatAt(card.id); } catch { lastChatAt = null; }
    entries.push({ id: card.id, name: card.name, tagline: characterTagline(card), active: card.id === activeId, preset: card.id === presetGeneId,
      model: { state, name: state === 'bundled' ? 'Gene' : state === 'none' ? null : card.modelName ?? null }, avatar, knownDay, lastChatAt });
  }
  return { entries, activeId, revision: ports.revision(), pendingSwitchId: ports.pendingSwitchId() };
}
