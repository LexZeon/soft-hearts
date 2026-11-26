// 设置和控制窗口框架 (settings): this part's slice of the window↔host API. DesktopAPI (shared/contracts.ts) extends every part's slice.
// A new window↔host call of this part goes here, and electron/safety/preload.ts gets the matching typed entry; never a generic invoke.
// The members came over verbatim from shared/contracts.ts in their old order (docs/claude/2026-11-16-contracts-split.md).
import type { CompanionCommandChoiceRequest, CompanionCommandView } from '../settings';
import type { AppSettings, AssetSaveBaseline } from '../foundation/settings';

export type { AssetSaveBaseline };

export interface SettingsDesktopAPI {
  getUiLanguage(): Promise<import('../foundation/ui-language').UiLanguageView>;
  setUiLanguage(preference: import('../foundation/ui-language').UiLanguagePreference): Promise<import('../foundation/ui-language').UiLanguageView>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings, assetBaseline?: AssetSaveBaseline): Promise<AppSettings>;
  onSettings(callback: (settings: AppSettings) => void): () => void;
  chooseCompanionCommand(request: CompanionCommandChoiceRequest): Promise<CompanionCommandView | null>;
  onCompanionCommandView(callback: (view: CompanionCommandView) => void): () => void;
  /** An optional page of the control window (the host ignores anything not in 「带我去」's closed list). */
  openControls(page?: import('../initiative').TakeMeThereId): Promise<void>;
  resetSettings(): Promise<AppSettings>;
  quit(): Promise<void>;
}
