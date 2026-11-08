import { Quaternion, type Bone, type SkinnedMesh } from 'three';
import type { BodyPoseProperty } from '../../shared/personalize-body';

/**
 * Applies a static, already-qualified FK property set over the current frame.
 * This class does not establish model identity or approve a binding: callers
 * must do that before constructing it. It never advances or replaces a mixer.
 */
export class PersonalizeStaticPose {
  private readonly entries: { bone: Bone; value: Quaternion; weight?:number; currentTorsoDelta?:true }[];
  private previous: Quaternion[] | null = null;
  private appliedEntries: typeof this.entries = [];

  constructor(mesh: SkinnedMesh, properties: readonly BodyPoseProperty[], rest: readonly { bone: Bone; quaternion: Quaternion }[]) {
    if (!properties.length || properties.length > 16) throw Error('静态身体姿势的属性数量不正确。');
    const used = new Set<number>();
    this.entries = properties.map(property => {
      const { boneIndex, boneName, quaternion: q, weight, currentTorsoDelta } = property;
      if (!Number.isSafeInteger(boneIndex) || boneIndex < 0 || used.has(boneIndex)
        || !Array.isArray(q) || q.length !== 4 || !q.every(Number.isFinite)
        || (weight!==undefined&&(!Number.isFinite(weight)||weight<=0||weight>1))) {
        throw Error('静态身体姿势的属性不正确。');
      }
      const bone = mesh.skeleton.bones[boneIndex];
      if (!bone || bone.name !== boneName) {
        if(currentTorsoDelta===true&&boneIndex===5&&boneName==='上半身')return null;
        throw Error('姿势与目标骨架身份不匹配。');
      }
      const offset = new Quaternion(q[0], q[1], q[2], q[3]);
      if (Math.abs(offset.lengthSq() - 1) > 1e-5) throw Error('静态身体姿势旋转未归一化。');
      if(currentTorsoDelta!==undefined){
        const parent=mesh.skeleton.bones[2];
        if(currentTorsoDelta!==true||boneIndex!==5||boneName!=='上半身'
          ||weight!==1||q[0]!==0||q[1]!==0||q[3]<=0||Math.abs(q[2])>Math.sin(10*Math.PI/360)||(q[2]===0&&q[3]===1))throw Error('躯干当前姿态目标不正确。');
        if(!parent||parent.name!=='グルーブ'||bone.parent!==parent)return null;
      }
      let value:Quaternion;
      if(currentTorsoDelta)value=offset;
      else {
        // Static classes alone use the exact mesh's immutable bind snapshot.
        const snapshot = rest[boneIndex];
        if (!snapshot || snapshot.bone !== bone) throw Error('姿势骨架绑定层级不完整。');
        const bind = snapshot.quaternion.clone();
        if (![bind.x, bind.y, bind.z, bind.w].every(Number.isFinite) || Math.abs(bind.lengthSq() - 1) > 1e-5) {
          throw Error('姿势骨架绑定旋转不正确。');
        }
        value=bind.multiply(offset).normalize();
      }
      used.add(boneIndex);
      return { bone, value, ...(weight===undefined?{}:{weight}),...(currentTorsoDelta?{currentTorsoDelta:true as const}:{}) };
    }).filter((entry):entry is NonNullable<typeof entry>=>entry!==null);
  }

  /** Capture only this frame's current properties; restore before the next tick. */
  hasBone(bone:Bone|null|undefined):boolean { return !!bone && this.entries.some(entry=>entry.bone===bone); }

  apply(strength: number, excludedBone?:Bone|null, allowTorso=true): number {
    if (this.previous) throw Error('请先恢复上一帧的身体姿势。');
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw Error('姿势强度不正确。');
    this.appliedEntries=this.entries.filter(entry=>{
      if(entry.bone===excludedBone)return false;if(!entry.currentTorsoDelta)return true;
      const q=entry.bone.quaternion,values=[q.x,q.y,q.z,q.w];
      return allowTorso&&values.every(Number.isFinite)&&Math.max(...values.map(Math.abs))>0;
    });
    this.previous = this.appliedEntries.map(({ bone }) => bone.quaternion.clone());
    for (const { bone, value, weight, currentTorsoDelta } of this.appliedEntries){
      if(currentTorsoDelta){const q=bone.quaternion,max=Math.max(Math.abs(q.x),Math.abs(q.y),Math.abs(q.z),Math.abs(q.w));
        q.set(q.x/max,q.y/max,q.z/max,q.w/max).normalize().multiply(value).normalize();}
      else bone.quaternion.slerp(value, weight??strength);
    }
    return this.appliedEntries.length;
  }

  /** Withdraw only the new current-base torso before a motion bridge captures display state. */
  restoreCurrentTorso():void {
    if(!this.previous)return;
    for(let i=this.appliedEntries.length-1;i>=0;i--){
      if(!this.appliedEntries[i].currentTorsoDelta)continue;
      this.appliedEntries[i].bone.quaternion.copy(this.previous[i]);
      this.appliedEntries.splice(i,1);this.previous.splice(i,1);
    }
  }

  restore(): void {
    const previous = this.previous;
    if (!previous) return;
    this.previous = null;
    this.appliedEntries.forEach(({ bone }, index) => bone.quaternion.copy(previous[index]));this.appliedEntries=[];
  }
}
