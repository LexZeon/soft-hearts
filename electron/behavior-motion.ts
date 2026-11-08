import { randomUUID } from 'node:crypto';
import type { MoodSnapshot } from '../shared/mood';
import {
  MAX_BEHAVIOR_CUE_AGE_MS, MAX_BEHAVIOR_CUE_LIFETIME_MS,
  selectBehaviorState, selectBehaviorReaction, BEHAVIOR_SEMANTICS, isBehaviorFaceBindingId,
  type BehaviorMotionCue, type BehaviorMotionPlan, type BehaviorStateSelection, type BehaviorSemantic, type BehaviorFaceBindingId,
  type BehaviorIdleFace,
} from '../shared/behavior-motion';

const MAX_CONSUMED_REACTIONS = 256;
export type BehaviorBindingSource=(semantic:BehaviorSemantic,binding:BehaviorFaceBindingId,strength:number)=>{bindingId:BehaviorFaceBindingId;strength:number}|undefined;

/** Optional presentation only. No mood events, storage, settings or media access. */
export class BehaviorMotionController {
  private scope = '';
  private stateKey = '';
  private state: BehaviorMotionCue | null = null;
  private reaction: BehaviorMotionCue | null = null;
  private reactionSource: string | null = null;
  private readonly consumed = new Set<string>();
  private lastNow = 0;

  constructor(private readonly clock = Date.now, private readonly newId: () => string = randomUUID,
    private readonly bindingFor?:BehaviorBindingSource) {}

  /** Explicit profile edits remove active output without replaying consumed/state identities. */
  cancelPresentation():void{this.state=this.reaction=null;this.reactionSource=null;}
  private mapped<T extends BehaviorStateSelection>(selected:T):T{
    if(!selected.bindingId||!this.bindingFor)return selected;
    try{const value=this.bindingFor(selected.semantic,selected.bindingId,selected.strength);
      if(value&&isBehaviorFaceBindingId(value.bindingId)&&BEHAVIOR_SEMANTICS[selected.semantic].bindingIds.includes(value.bindingId as never)
        &&Number.isFinite(value.strength)&&value.strength>0&&value.strength<=0.7)
        return {...selected,bindingId:value.bindingId,strength:Math.min(selected.strength,value.strength)};
    }catch{/* Invalid optional mapping retains the original accepted selection. */}
    return selected;
  }

  private remember(id: string): void {
    this.consumed.add(id);
    if (this.consumed.size > MAX_CONSUMED_REACTIONS) this.consumed.delete(this.consumed.values().next().value!);
  }

  /** Context cancellation retains consumed identities; a quick return cannot replay them. */
  invalidate(): void {
    this.scope = this.stateKey = '';
    this.state = this.reaction = null;
    this.reactionSource = null;
  }

  cancelReaction(sourceEventId?: string): boolean {
    if (!this.reaction || (sourceEventId !== undefined && this.reactionSource !== sourceEventId)) return false;
    this.reaction = null; this.reactionSource = null;
    return true;
  }

  /** `idleFace`: #11, the face the idle gesture picked for the look or motion cue showing now (MoodHost). */
  update(snapshot: MoodSnapshot, scope: string, enabled: boolean, idleFace?: BehaviorIdleFace | null): BehaviorMotionPlan {
    const value = this.clock();
    const now = this.lastNow = Math.max(this.lastNow, Number.isFinite(value) ? value : this.lastNow);
    if (scope !== this.scope) { this.invalidate(); this.scope = scope; }
    if (this.state && this.state.expiresAt <= now) this.state = null;
    if (this.reaction && this.reaction.expiresAt <= now) this.reaction = null;

    const source = snapshot.cue;
    const sourceKey = source ? `${source.id}:${source.at}` : null;
    const fresh = sourceKey !== null && !this.consumed.has(sourceKey);
    // Consume even suppressed contact/disabled cues before selecting a resource.
    if (sourceKey) this.remember(sourceKey);
    if (!source || this.reaction?.stateKey !== `reaction:${sourceKey}`) this.reaction = null;

    const selected = this.mapped(selectBehaviorState(snapshot));
    const reactionSelection = selectBehaviorReaction(snapshot, idleFace);
    const selectedReaction = reactionSelection ? this.mapped(reactionSelection) : null;
    const allowed = enabled && Number.isFinite(snapshot.intensity.expression) && snapshot.intensity.expression > 0;
    if (!allowed) {
      this.stateKey = '';
      this.state = this.reaction = null;
      return this.plan();
    }
    if (selected.key !== this.stateKey) {
      this.stateKey = selected.key;
      this.state = selected.bindingId && selected.strength > 0 ? {
        id: this.newId(), kind: 'state', bindingId: selected.bindingId,
        semantic: selected.semantic, stateKey: selected.key, at: now,
        expiresAt: now + MAX_BEHAVIOR_CUE_LIFETIME_MS, strength: selected.strength,
      } : null;
    } else if (this.state) {
      // Tuning changes the envelope without creating another clip or event.
      this.state = this.state.bindingId === selected.bindingId ? { ...this.state, strength: selected.strength } : null;
    }
    if (this.reaction) {
      // A reply's interpretation may arrive after its initial neutral ack. Never
      // keep that old face over a new serious meaning, or replay it after input.
      if (!selectedReaction || selectedReaction.bindingId !== this.reaction.bindingId
        || selectedReaction.semantic !== this.reaction.semantic) {
        this.reaction = null; this.reactionSource = null;
      } else this.reaction = { ...this.reaction, strength: selectedReaction.strength };
    }
    if (fresh) {
      const reaction = selectedReaction;
      if (reaction?.bindingId && reaction.at <= now && now - reaction.at <= MAX_BEHAVIOR_CUE_AGE_MS) {
        const expiresAt = Math.min(reaction.expiresAt, reaction.at + MAX_BEHAVIOR_CUE_LIFETIME_MS);
        if (expiresAt > now) {
          this.reactionSource = reaction.sourceEventId;
          this.reaction = {
            id: this.newId(), kind: 'reaction', bindingId: reaction.bindingId,
            semantic: reaction.semantic, stateKey: `reaction:${sourceKey}`, at: reaction.at,
            expiresAt, strength: reaction.strength,
          };
        }
      }
    }
    return this.plan();
  }

  private plan(): BehaviorMotionPlan {
    return { state: this.state ? { ...this.state } : null, reaction: this.reaction ? { ...this.reaction } : null };
  }
}
