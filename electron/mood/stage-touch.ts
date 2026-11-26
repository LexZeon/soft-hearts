/**
 * I-209 step 4 (docs/claude/2026-11-24-i209-step4.md; step 3's leftover: "the other characters' moods change when touched, pulled or kissed /
 * hugged, as the first one's do"): the mood input of a character on the full-screen stage besides the desktop companion.
 *
 * The desktop companion's touch goes through MoodHost.interaction (one active session, her view's token). Someone else on stage has her own
 * live mood (StageMoods) but no such session, so this keeps one per character and turns her page's reports into the same mood events the
 * first one's become, applied to HER profile (MoodHost.event with her id):
 *  - a pat (rua) and a pinch (cheek): the phase, then each report's effective time through the same budget the first one has (at most what
 *    real time allows, 600 ms banked), a pinch once per session;
 *  - a pull: when it ends, the same lift the touch brain gives the first one (shared/behaviors/touch-response/mood.ts touchLift);
 *  - feeding and waking stay the desktop companion's (her snack and her sleep are hers): refused.
 * Kisses and hugs are her close moments' mood moments (MoodMoments.note with her id), wired beside this. Memory only.
 */
import { randomUUID } from 'node:crypto';
import type { MoodEvent, MoodValues } from '../../shared/foundation/mood';
import { touchLift } from '../../shared/behaviors/touch-response/mood';

export interface StageTouchPorts {
  /** One mood event on her profile (MoodHost.event(event, characterId)). */
  event(event: MoodEvent, characterId: string): void;
  /** A touch lift on her profile (MoodHost.lift(lift, characterId)). */
  lift(lift: { id: string; delta: Partial<MoodValues>; reason: string; context: 'neutral'; keepReason: true }, characterId: string): boolean;
  /** Her live view now (what the page reads back). */
  view(characterId: string): unknown;
  clock(): number;
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const BANK_MS = 600;

interface Session { id: string; mode: 'rua' | 'cheek'; startedAt: number; creditedAt: number; budget: number; accepted: boolean }

export class StageTouchMood {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly ports: StageTouchPorts) {}

  /** Her page's direct-touch input (the same shapes the first one's page sends); returns her view, throws on anything else. */
  interaction(characterId: string, value: unknown): unknown {
    if (!ID.test(characterId) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('互动输入不正确。');
    const input = value as Record<string, unknown>, now = this.ports.clock();
    if (typeof input.sessionId !== 'string' || !ID.test(input.sessionId)) throw new Error('互动已失效，请重新接触角色。');
    const session = this.sessions.get(characterId);
    if (input.type === 'phase') {
      if (input.phase === 'idle') {
        if (session?.id === input.sessionId) { this.sessions.delete(characterId); this.ports.event({ type: 'phase', id: randomUUID(), phase: 'idle' }, characterId); }
        return this.ports.view(characterId);
      }
      if (input.phase !== 'rua' && input.phase !== 'cheek') throw new Error('这位角色这一步只接受抚摸和捏脸。');
      if (session?.id !== input.sessionId) this.sessions.set(characterId, { id: input.sessionId, mode: input.phase, startedAt: now, creditedAt: now, budget: 0, accepted: false });
      else if (session.mode !== input.phase) throw new Error('互动类型已改变，请重新开始。');
      this.ports.event({ type: 'phase', id: randomUUID(), phase: input.phase }, characterId);
      return this.ports.view(characterId);
    }
    if (!session || session.id !== input.sessionId || typeof input.id !== 'string' || !ID.test(input.id)) throw new Error('互动事件已过期。');
    const activeMs = Number(input.activeMs);
    if (input.type === 'rua') {
      if (session.mode !== 'rua' || !Number.isFinite(activeMs) || activeMs <= 0 || activeMs > 500) throw new Error('有效抚摸量不正确。');
      session.budget = Math.min(BANK_MS, session.budget + Math.max(0, now - session.creditedAt));
      session.creditedAt = now;
      const ms = Math.min(session.budget, activeMs);
      session.budget -= ms;
      if (ms > 0) this.ports.event({ type: 'rua', id: input.id, effectiveMs: ms }, characterId);
    } else if (input.type === 'cheek') {
      if (session.mode !== 'cheek' || session.accepted || !Number.isFinite(activeMs) || activeMs < 180 || activeMs > 500 || activeMs > now - session.startedAt) throw new Error('有效捏脸量不正确。');
      session.accepted = true;
      this.ports.event({ type: 'rua', id: `cheek-${session.id}`.slice(0, 100), effectiveMs: activeMs, reason: '有效捏脸' }, characterId);
    } else throw new Error('这位角色这一步只接受抚摸和捏脸。');
    return this.ports.view(characterId);
  }

  /** A pull of hers ended (her page's report): the lift the first one gets from the touch brain. True when her mood moved. */
  pulled(characterId: string, report: unknown): boolean {
    if (!ID.test(characterId) || !report || typeof report !== 'object' || Array.isArray(report)) return false;
    const r = report as Record<string, unknown>;
    const ended = r.ended === 'released' || r.ended === 'broke-free' || r.ended === 'cancelled' || r.ended === 'holding' ? r.ended : null;
    const strength = Number(r.strength), heldMs = Number(r.heldMs);
    if (!ended || !Number.isFinite(strength) || !Number.isFinite(heldMs)) return false;
    const lift = touchLift({ kind: 'pull', part: null, count: 1, strength, heldMs, ended }, { fresh: true, counted: true });
    if (!lift) return false;
    try { return this.ports.lift({ id: `touch-${characterId}-${randomUUID()}`.slice(0, 160), delta: lift.delta, reason: lift.reason, context: 'neutral', keepReason: true }, characterId); } catch { return false; }
  }

  /** She left the stage: her open session goes. */
  forget(characterId: string): void { this.sessions.delete(characterId); }
}
