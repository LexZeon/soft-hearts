/**
 * The full-screen page's side of the one interruption arbiter (rules in shared/unbound/action-ends): which of her
 * actions is playing now (what a press on her would meet), and what a large pull does to it. Nothing here reacts to the mouse moving.
 *
 *   actionNow    the director's performance (the close family: kiss, hug, the look), the opening beat before she speaks, the preview's act,
 *                her reply's beats, her own life (a walk or a small thing); null: nothing, a press is the pull as before
 *   endForPull   a large pull ended it (the arbiter's row says so): the director yields her to the pull (cancelled 'pull', reported to the host:
 *                she is told next turn), the opening beat winds down, the act winds down. Her reply's beats and her own life give way by
 *                themselves once the pull is real (main's frame and the host's life arbiter).
 */
import { endsAction, type ActionKind } from '../../shared/unbound/action-ends';

export interface ActionOwners {
  director: { readonly active: boolean; readonly phase: string | null; yieldTo(reason: 'pull'): void };
  speech: { readonly active: boolean; interrupt(reason: 'pull'): void };
  acts: { readonly active: boolean; cancel(): void };
  beats: { readonly active: boolean };
  life: { readonly active: boolean; readonly walking: boolean };
}

/** What a press on her meets now (the first that owns her), or null. A performance on its way home still counts (it owns where she walks). */
export function actionNow(o: ActionOwners): ActionKind | null {
  if (o.director.active && o.director.phase !== 'done') return 'look'; // the close family: one row (kiss, hug and the look end alike)
  if (o.speech.active) return 'opening';
  if (o.acts.active) return 'act';
  if (o.beats.active) return 'beat';
  if (o.life.active) return o.life.walking ? 'walk' : 'life';
  return null;
}

/** A large pull reached `kind`: end what the arbiter says it ends (true when it did). */
export function endForPull(kind: ActionKind, o: ActionOwners): boolean {
  if (!endsAction(kind, 'pull')) return false;
  if (kind === 'kiss' || kind === 'hug' || kind === 'look') { if (o.director.active) o.director.yieldTo('pull'); }
  else if (kind === 'opening') { if (o.speech.active) o.speech.interrupt('pull'); }
  else if (kind === 'act') { if (o.acts.active) o.acts.cancel(); }
  return true;
}
