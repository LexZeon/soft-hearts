// A touch on her that the user made with the mouse (I-136, docs/claude/2026-11-14-unbound-v1-scope.md「定稿」5–7).
// The companion window or Unbound only reports what happened (kind, which part, how); the brain side decides what shows on her
// face (locally, from her hormones, mood values and character), whether she says something (also hers, no settings switch),
// and tells Claude what happened and what she showed. Nothing here is a reaction.
//
// Pat, pinch and food keep their own paths (shared/mood/her-state.ts HER_CONTACTS); this is for the new touches: a click on her
// (step 2) and pulling a part of her (step 5).

export const TOUCH_KINDS = ['click', 'pull'] as const;
export type TouchKind = typeof TOUCH_KINDS[number];

/** Plain, neutral parts. The chest, belly and hips are all 'torso' on purpose. */
export const TOUCH_PARTS = ['head', 'hair', 'face', 'shoulder', 'arm', 'hand', 'torso', 'leg', 'foot', 'other'] as const;
export type TouchPart = typeof TOUCH_PARTS[number];

export const TOUCH_PLACES = ['pet', 'unbound'] as const;
export type TouchPlace = typeof TOUCH_PLACES[number];

export const PULL_ENDS = ['holding', 'released', 'broke-free', 'cancelled'] as const;
export type PullEnd = typeof PULL_ENDS[number];
/** Step 5e: what her body did beyond leaning (followed = walked along, Unbound; pulled-back = she pulled back on a hard pull). */
export const PULL_RESPONSES = ['followed', 'pulled-back'] as const;
export type PullResponse = typeof PULL_RESPONSES[number];

export interface TouchEvent {
  kind: TouchKind;
  part: TouchPart;
  /** Her left or right (not the screen's); null when it has no side. */
  side: 'left' | 'right' | null;
  where: TouchPlace;
  /** When it happened (ms since epoch, the reporter's clock). */
  at: number;
  /** Pull only: how hard, 0–1 (how far it was dragged relative to her height). */
  strength?: number;
  /** Pull only: the drag direction on screen, a unit-ish vector (x right, y down). */
  direction?: { x: number; y: number };
  /** Pull only: how long it has been held so far (ms). */
  heldMs?: number;
  /** Pull only: 'holding' for the "still pulling" report, then how it ended. */
  ended?: PullEnd;
  /** Pull only (step 5e): what her body did, fixed words. */
  response?: PullResponse;
  /** Pull only (step 5c): steps she walked along, 0–50. */
  steps?: number;
}

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Strict: anything that is not exactly a touch event is null. Pull fields are kept only on a pull and clamped. */
export function parseTouchEvent(value: unknown): TouchEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isOneOf(TOUCH_KINDS, raw.kind) || !isOneOf(TOUCH_PARTS, raw.part) || !isOneOf(TOUCH_PLACES, raw.where) || !finite(raw.at)) return null;
  const side = raw.side === 'left' || raw.side === 'right' ? raw.side : raw.side == null ? null : undefined;
  if (side === undefined) return null;
  const event: TouchEvent = { kind: raw.kind, part: raw.part, side, where: raw.where, at: raw.at };
  if (raw.kind !== 'pull') return event;
  if (finite(raw.strength)) event.strength = Math.min(1, Math.max(0, raw.strength));
  const direction = raw.direction as Record<string, unknown> | undefined;
  if (direction && typeof direction === 'object' && finite(direction.x) && finite(direction.y)) {
    const length = Math.hypot(direction.x, direction.y);
    if (length > 0) event.direction = { x: direction.x / length, y: direction.y / length };
  }
  if (finite(raw.heldMs)) event.heldMs = Math.max(0, Math.min(10 * 60_000, raw.heldMs));
  if (isOneOf(PULL_ENDS, raw.ended)) event.ended = raw.ended;
  if (isOneOf(PULL_RESPONSES, raw.response)) event.response = raw.response;
  if (finite(raw.steps) && raw.steps > 0) event.steps = Math.min(50, Math.floor(raw.steps));
  return event;
}

/** The part in plain Chinese, for her context lines ("用户刚才点了你一下（肩膀）"). */
export const TOUCH_PART_WORDS: Readonly<Record<TouchPart, string>> = {
  head: '头', hair: '头发', face: '脸', shoulder: '肩膀', arm: '胳膊', hand: '手', torso: '身上', leg: '腿', foot: '脚', other: '身上',
};
