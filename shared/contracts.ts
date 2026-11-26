// The window↔host API: DesktopAPI, what window.desktop offers her and the control windows (2026-11-16 split into per-part slices,
// docs/claude/2026-11-16-contracts-split.md). This file only joins the slices and re-exports the old names, so every
// `import … from '…/shared/contracts'` keeps working; tests/contracts-surface.test.mjs pins the whole surface.
//
// THE RULE FOR A NEW WINDOW↔HOST CALL: it goes into its part's slice, shared/<part>/desktop-api.ts (interface <Part>DesktopAPI),
// together with any wire type only that part uses; electron/safety/preload.ts gets the matching typed entry
// (invoke('name', …) or subscribe('desk:…', …)). Never a generic invoke, a pass-through channel or a method taking a channel name.
// A new part gets a new slice and one more name in the `extends` list below. Nothing in this file or the slices may be a value.
import type { SettingsDesktopAPI } from './settings/desktop-api';
import type { StageDesktopAPI } from './stage/desktop-api';
import type { SensesDesktopAPI } from './senses/desktop-api';
import type { MemoryDesktopAPI } from './memory/desktop-api';
import type { MoodDesktopAPI } from './mood/desktop-api';
import type { BrainDesktopAPI } from './brain/desktop-api';
import type { UnboundDesktopAPI } from './unbound/desktop-api';
import type { InitiativeDesktopAPI } from './initiative/desktop-api';
import type { SafetyDesktopAPI } from './safety/desktop-api';
import type { CardsDesktopAPI } from './cards/desktop-api';
import type { VoiceDesktopAPI } from './voice/desktop-api';
import type { ActionsDesktopAPI } from './actions/desktop-api';

// The part-free vocabulary lives in shared/foundation/ (2026-11-16); it is re-exported here for compatibility only. New code imports
// it from the foundation file; the wire types only one part uses live in that part's slice and are re-exported below.
import type { ProviderKind, ProviderConfig, VoiceInputConfig, VoiceInputEngine, CameraConfig, AssetRef, AppSettings } from './foundation/settings';
import type { VoiceRefusal, AudioReadingRefusal, RuntimeState, CameraRefusal, RuntimePatch, SystemAudioState, WindowVisibilityState } from './foundation/runtime-state';
import type { StreamEvent } from './brain'; // the chat stream's wire type is the brain part's (wiring rewrite step 2)
import type { Attachment, ChatMessage } from './foundation/chat';
import type { PetReplyAnchor, PetReplyUpdate, PetReplyPieces } from './foundation/pet-reply';
export type { ProviderKind, ProviderConfig, VoiceInputConfig, VoiceInputEngine, CameraConfig, AssetRef, AppSettings };
export type { VoiceRefusal, AudioReadingRefusal, RuntimeState, CameraRefusal, RuntimePatch, SystemAudioState, WindowVisibilityState };
export type { StreamEvent };
export type { Attachment, ChatMessage };
export type { PetReplyAnchor, PetReplyUpdate, PetReplyPieces };
export type { AssetSaveBaseline } from './settings/desktop-api';
export type {
  ModelPhysicsSettingsPatch, PointerPosition, PetWindowOperation, PetPresentationSample, PetWindowDiagnosticEntry, PetWindowDiagnosticsView,
} from './stage/desktop-api';
export type { ScreenSource } from './senses/desktop-api';
export type { ChatRequest, ChatStarted } from './brain/desktop-api';

export interface DesktopAPI extends SettingsDesktopAPI, StageDesktopAPI, SensesDesktopAPI, MemoryDesktopAPI, MoodDesktopAPI, BrainDesktopAPI,
  UnboundDesktopAPI, InitiativeDesktopAPI, SafetyDesktopAPI, CardsDesktopAPI, VoiceDesktopAPI, ActionsDesktopAPI {}
declare global {
  interface Window {
    desktop: DesktopAPI;
  }
}
