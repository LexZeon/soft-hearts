/** Data-only R20 proposal controls. No executor, directory or task identity is accepted here. */
export interface R20OfferCandidate {
  question: string;
  goal: string;
  plan: string;
  scopeHint: string;
}
export interface R20OfferPromptInput {
  userText: string;
  assistantText: string;
  persona: string;
  mood: string;
}
export interface R20OfferCapabilities {
  advice: true;
  taskConfirmation: true;
  computerControl: false;
  executionVerified: false;
  sameTaskSteerVerified: false;
}
export const R20_OFFER_CAPABILITIES: Readonly<R20OfferCapabilities> = Object.freeze({
  advice:true, taskConfirmation:true, computerControl:false, executionVerified:false, sameTaskSteerVerified:false,
});
export type R20OfferStage = 'offered' | 'plan' | 'scope';
export interface R20ProactiveOfferView extends R20OfferCandidate {
  id: string;
  revision: number;
  expiresAt: number;
  stage: R20OfferStage;
  presented: boolean;
  capabilities: R20OfferCapabilities;
}
export interface R20ProactiveOfferState { revision:number; offer:R20ProactiveOfferView|null }
export type R20ProactiveOfferEvent =
  | {type:'offer';revision:number;offer:R20ProactiveOfferView}
  | {type:'presented';revision:number;offer:R20ProactiveOfferView}
  | {type:'cancel';revision:number;id:string};
export interface R20ProactiveOfferAcknowledgement { id:string;revision:number }
/** Scope is text for the original confirmation UI, never a filesystem/permission grant. */
export interface R20ProactiveOfferResponse {
  id:string;
  revision:number;
  requestId:string;
  action:'view'|'scope'|'confirm'|'reply'|'decline'|'cancel';
  text?:string;
  goal?:string;
  scope?:string;
}
export interface R20ProactiveOfferResult {
  status:'shown-plan'|'needs-scope'|'confirmation-opened'|'declined'|'cancelled'|'stale';
  state:R20ProactiveOfferState;
}
