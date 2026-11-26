// The window's send guard for tests that run the real sendChat source in a vm context (src/brain/send-guard.ts, 2026-11-22).
import { SendGuard } from '../../src/brain/send-guard';
import type { SendDropFact } from '../../shared/brain';

/** A real guard on a fake clock; notices and journal facts are collected. */
export function testSendGuard(options: { now?: () => number; notices?: [string, boolean][]; journal?: SendDropFact[]; from?: 'controls' | 'companion'; timeoutMs?: number; saveWaitMs?: number } = {}): SendGuard {
  return new SendGuard({ now: options.now ?? (() => 0), from: () => options.from ?? 'controls', notify: (text, error) => { options.notices?.push([text, error]); },
    journal: fact => { options.journal?.push(fact); } }, options.timeoutMs, options.saveWaitMs);
}
