/**
 * I-209 (docs/claude/2026-11-24-i209-step1.md, docs/claude/2026-11-24-i209-step3-instances.md): several characters on the full-screen
 * stage. The pure half: who is on stage (presence.ts), where each one is kept (place-book.ts), how step 1 kept them apart (lanes.ts), the
 * frame-cost guard (guard.ts), step 3's shared world of bodies (bodies.ts: one floor, the windows' order, never through each other, stepping
 * aside), one voice at a time (floor.ts) and what crosses between the host and the pages (wire.ts).
 */
export { COMPANY_ID, COMPANY_MAX_PRESENT, CompanyChoice, type CompanyBlock, type CompanyCard, type CompanyLook } from './presence';
export { PLACE_BOOK_MAX, emptyPlaceBook, parsePlaceBook, placeBookFile, type PlaceBook } from './place-book';
export { COMPANY_KNOBS, arrange, clearOf, firstWish, needAcross, offStage, type CompanyKnobs, type ExtraLane, type Spot } from './lanes';
export { COMPANY_GUARD_KNOBS, CompanyGuard, type CompanyGuardVerdict } from './guard';
export { STAGE_BODY_KNOBS, asideGoal, contactM, keepApart, obstaclesFor, parseStageBody, parseStageView, predicted, stackOrder,
  type FloorPoint, type Obstacle, type StageBody, type StageOther, type StageView } from './bodies';
export { FLOOR_QUEUE_MAX, StageFloor, type FloorTurn } from './floor';
export { EXTRA_PACE_KNOBS, ExtraPace, FULL_PACE, INVOLVEMENT_KINDS, involvedIn, type Involvement, type InvolvementKind, type OwnInvolvement, type PaceDecision } from './extra-pace';
export { FRAME_SAMPLER_KNOBS, FrameSampler, type FrameMinute } from './frame-sampler';
export { UNBOUND_COMPANY_REQUESTS, UNBOUND_STAGE_EVENTS, UNBOUND_STAGE_REQUESTS, parseCompanyGuard } from './wire';
