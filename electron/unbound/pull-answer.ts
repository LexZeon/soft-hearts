/**
 * Step 5c (拉她), the host's answer to the page's pull messages (moved out of electron/unbound/host.ts unchanged on 2026-11-24, I-209 step 1,
 * so the host file only shrinks): only from the shown window while she can be touched (as a click). A start makes the pull yours in the
 * arbiter (her own things ease out); a report goes to the touch brain as kind 'pull'; an end where she walked along makes that spot her
 * place (as a walk of hers would) and keeps her own walks away for a while.
 */
import { parseUnboundPull } from '../../shared/unbound/pull';
import { NEUTRAL_MOOD } from '../../shared/unbound/director';
import { PULL_KNOBS, pullStanceOf, type PullStanceOf } from '../../shared/stage';
import type { UnboundHostPorts, UnboundWindowLike } from './host-ports';
import type { LifeHost } from './life';
import type { PeekDirectorHost } from './peek';

export interface PullAnswerLinks {
  ports(): Pick<UnboundHostPorts, 'life' | 'peek' | 'pull'>;
  /** The window she is shown in, visible. */
  shown(win: UnboundWindowLike): boolean;
  life(): LifeHost | null;
  peek(): PeekDirectorHost | null;
  /** A walk of hers ended here (her place follows and is kept). */
  arrived(at: { xM: number; depthM: number }): void;
}

export class UnboundPullAnswer {
  constructor(private readonly links: PullAnswerLinks) {}
  private get ports() { return this.links.ports(); }
  private get life() { return this.links.life(); }
  private get peek() { return this.links.peek(); }

  answer(win: UnboundWindowLike, value: unknown): { accepted: boolean; stance?: PullStanceOf | null; sleepy?: number } | undefined {
    const message = parseUnboundPull(value);
    if (!message || !this.links.shown(win)) return message?.phase === 'start' ? { accepted: false } : undefined;
    if (message.phase === 'start') {
      // Asleep: not a pull (the first version neither wakes her nor drags a sleeping body). Otherwise her stance from her mood now.
      const asleep = (() => { try { return this.ports.life?.asleep() ?? this.ports.peek?.asleep() ?? false; } catch { return false; } })();
      if (asleep) return { accepted: false };
      this.life?.pulled('start');
      const mood = (() => { try { return this.ports.life?.mood() ?? this.ports.peek?.mood() ?? null; } catch { return null; } })();
      return { accepted: true, stance: mood ? pullStanceOf({ values: mood, baseline: NEUTRAL_MOOD, sleepy: mood.A }) : null, sleepy: mood?.A ?? 0 };
    }
    const ended = message.report.ended;
    if (ended !== 'holding') {
      const walked = typeof message.report.steps === 'number' && message.report.steps > 0;
      this.life?.pulled('end', walked, PULL_KNOBS.stayMinutes);
      if (walked && message.place) this.links.arrived(message.place);
      if (walked && message.place && message.near) this.peek?.pulledNear(message.nearHeldMs); // I-159 E, I-184: let go at the eyes: she decides (after the place)
    }
    if (message.stick !== true) try { this.ports.pull?.(message.report); } catch (error) { console.error(error); } // I-196: a joystick pull is a pull, never a touch for the touch brain
  }
}
