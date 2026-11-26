// I-071 v2 第三步 转换: glue. Created by agent-channel/electron-wiring.ts beside the Claude 助手, from closures main.ts already has
// (one property in its createAgentChannel call). The voice part goes through the channel bridge's own settings save, exactly as
// set_voice_style does (keys and the monthly cap are never read or written). Every IPC method here is control-window only.
import type { AppSettings } from '../../../shared/foundation/settings';
import { cardLanguageOf, type CharacterCard, type CharacterCardState, type CharacterDraft } from '../../../shared/foundation/character-card';
import { CONVERSION_TARGET_LABELS, conversionTargetOf, type ConversionJobView } from '../../../shared/cards/character-convert';
import { lintCharacterCard } from '../../../shared/cards/character-card-lint';
import { DEFAULT_TTS_CONFIG, MAX_TTS_STYLE_BINDINGS, type TtsConfig, type TtsStyleBinding } from '../../../shared/voice';
import type { NoteSegmentInfo } from '../../../shared/memory';
import type { RelationshipData } from '../../../shared/memory';
import type { AgentCommitGuard } from '../../safety';
import { relationshipFileName } from '../../memory';
import path from 'node:path';
import { conversionModel } from './model';
import type { ConversionModel } from './translate';
import { ConversionService } from './service';

type Scope = { characterId: string; providerScope: string };
export interface ConversionWiring {
  characterCards(): {
    publicState(): CharacterCardState;
    rosterCards(): { id: string; modelPath?: string; modelName?: string }[];
    presetGeneId(): Promise<string | null>;
    getActive(): { id: string };
  };
  /** Adds the converted card on the host's mutation queue and republishes the cards (main.ts syncCharacter). */
  addCard(id: string, draft: CharacterDraft, model: { modelPath: string; modelName?: string } | null): Promise<unknown>;
  /** Rollback only: removes a card that is not the current one. */
  removeCard(id: string): Promise<unknown>;
  memory(): {
    noteScope(scope: Scope): string; noteSegments(now: number): readonly NoteSegmentInfo[]; providerScopesOf?(characterId: string): string[];
    restoreRecords(records: readonly unknown[], owner?: Scope): Promise<number>; forgetScope(scope: Scope): Promise<number>;
  };
  relationship(): { snapshot(id: string): Promise<RelationshipData>; adopt(id: string, data: RelationshipData): Promise<void>; forget(id: string): Promise<void> };
  profiles(): { restoreScope(scope: Scope, stored: unknown, keepReplaced: (current: unknown) => Promise<void>, options?: { keepRecording?: boolean }): Promise<void>; forgetScope(scope: Scope): Promise<boolean> } | null;
  providerScopes(): string[];
  currentProviderScope(): string;
}

export interface ConversionHostPorts {
  profileDirectory: string;
  wiring: ConversionWiring;
  settings(): AppSettings;
  saveSettings(next: AppSettings, guard: AgentCommitGuard): Promise<unknown>;
  modelChoice(): { model: string; effort: 'low' | 'medium' | 'high' };
  emit(view: ConversionJobView): void;
  register(method: string, operation: (...args: any[]) => unknown, controlOnly?: boolean): void;
  /** Starts a Claude 助手 turn with this text (the user's click on a card is their request). */
  send(text: string): Promise<unknown>;
  uiLanguage(): 'en' | 'zh-CN';
}

const ttsOf = (settings: AppSettings) => structuredClone((settings.tts ?? DEFAULT_TTS_CONFIG) as TtsConfig);

/** `model`: a test seam (a fake Claude); the app always uses the user's own Claude Code (model.ts). */
export function createConversion(ports: ConversionHostPorts, model?: ConversionModel): ConversionService {
  const { wiring } = ports;
  const noGuard: AgentCommitGuard = () => {};
  const card = async (id: string): Promise<(CharacterCard & { modelPath?: string }) | undefined> => {
    const cards = wiring.characterCards(), found = cards.publicState().cards.find(item => item.id === id);
    if (!found) return undefined;
    const link = cards.rosterCards().find(item => item.id === id);
    // C1: the preinstalled Gene card always goes with the preinstalled model, also when its link was removed.
    const modelPath = link?.modelPath ?? (await cards.presetGeneId() === id ? 'bundled:gene' : undefined);
    return { ...structuredClone(found), ...(modelPath ? { modelPath, modelName: link?.modelName ?? found.modelName ?? 'Gene' } : {}) };
  };
  const service = new ConversionService({
    profileDirectory: ports.profileDirectory,
    source: {
      profileDirectory: ports.profileDirectory, card,
      relationship: id => wiring.relationship().snapshot(id),
      providerScopes: () => wiring.providerScopes(), currentProviderScope: () => wiring.currentProviderScope(),
      memory: { noteScope: scope => wiring.memory().noteScope(scope), noteSegments: now => wiring.memory().noteSegments(now),
        providerScopesOf: id => wiring.memory().providerScopesOf?.(id) ?? [] },
      voice: id => {
        const tts = ttsOf(ports.settings());
        const provider = tts.provider === 'bailian' || tts.provider === 'fish' ? tts.provider : 'system';
        return { provider, bindings: (tts.styleBindings ?? []).filter(binding => binding.characterId === id).map(binding => structuredClone(binding)) };
      },
      now: () => Date.now(),
    },
    commit: {
      addCard: async (id, draft, model) => { await wiring.addCard(id, draft, model); },
      removeCard: async id => { if (wiring.characterCards().publicState().cards.some(item => item.id === id)) await wiring.removeCard(id); },
      hasCard: id => wiring.characterCards().publicState().cards.some(item => item.id === id),
      relationship: { adopt: (id, data) => wiring.relationship().adopt(id, data), forget: id => wiring.relationship().forget(id),
        file: id => path.join(ports.profileDirectory, 'relationship', relationshipFileName(id)) },
      get profiles() { return wiring.profiles(); },
      memory: { restoreRecords: (records, owner) => wiring.memory().restoreRecords(records, owner), forgetScope: scope => wiring.memory().forgetScope(scope) },
      voice: {
        // Fix 8 (Codex T-240 F04): the shared list keeps at most MAX_TTS_STYLE_BINDINGS for all characters. It used to keep the last
        // 64 after adding, which could drop another character's binding (and a rollback did not bring it back). Now no other entry
        // is ever dropped: only as many of the new card's bindings as fit are added (its own model's first), the rest are reported.
        // Raising the cap was not chosen: every settings read (electron/voice/tts.ts) normalizes to it, and 64 is plenty in practice.
        add: async (bindings: readonly TtsStyleBinding[]) => {
          const settings = ports.settings(), tts = ttsOf(settings);
          const keep = (tts.styleBindings ?? []).filter(item => !bindings.some(binding => binding.characterId === item.characterId && binding.modelPath === item.modelPath));
          const fits = bindings.slice(0, Math.max(0, MAX_TTS_STYLE_BINDINGS - keep.length));
          if (fits.length) {
            tts.styleBindings = [...keep, ...fits.map(binding => structuredClone(binding))];
            await ports.saveSettings({ ...settings, tts }, noGuard);
          }
          return { skipped: bindings.length - fits.length };
        },
        remove: async (characterId: string) => {
          const settings = ports.settings(), tts = ttsOf(settings);
          if (!(tts.styleBindings ?? []).some(item => item.characterId === characterId)) return;
          tts.styleBindings = (tts.styleBindings ?? []).filter(item => item.characterId !== characterId);
          await ports.saveSettings({ ...settings, tts }, noGuard);
        },
      },
    },
    model: model ?? conversionModel(() => ports.modelChoice()),
    modelChoice: () => ports.modelChoice(),
    lint: (draft, names) => lintCharacterCard(draft, { existingNames: names }),
    cardNames: () => wiring.characterCards().publicState().cards.map(item => item.name),
    emit: view => ports.emit(view),
  });
  // A conversion the app did not finish (quit or crash) is rolled back once the stores are up.
  const recover = () => service.ensureRecovered();
  setTimeout(() => { void recover(); }, 60_000).unref?.();
  // 角色页 「转成英文版 / 中文版」: the Claude 助手 takes over with the conversion started for that card (it explains, asks each name,
  // and the popup decides). The click is the user's request; nothing starts without the popup.
  ports.register('assistantConvertCharacter', async (id: unknown) => {
    await recover();
    if (typeof id !== 'string') throw new Error('角色卡编号不正确。');
    const found = wiring.characterCards().publicState().cards.find(item => item.id === id);
    if (!found) throw new Error('角色卡不存在。');
    const target = conversionTargetOf(cardLanguageOf(found));
    const text = ports.uiLanguage() === 'en'
      ? `Please convert the character "${found.name}" into ${target === 'en' ? 'an English' : 'a Chinese'} version.`
      : `把角色「${found.name}」转成${CONVERSION_TARGET_LABELS[target]}。`;
    return ports.send(text);
  });
  ports.register('assistantCancelConversion', (id: unknown) => service.cancel(id));
  return service;
}
