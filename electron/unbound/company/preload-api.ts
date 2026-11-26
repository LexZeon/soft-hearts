/**
 * I-209: the full-screen page's part of window.unbound for the others on stage. Fixed channels, plain values; the host checks the window and
 * parses every value (electron/unbound/company/host.ts, stage.ts):
 *  - step 1's frame-cost guard: "one fewer on stage";
 *  - step 3 (each one her own full screen): her body now, she has walked out (sent back), and the shared world as the stage tells her.
 */
import { UNBOUND_COMPANY_REQUESTS, UNBOUND_STAGE_EVENTS, UNBOUND_STAGE_REQUESTS, type CompanyGuardVerdict, type StageBody, type StageView } from '../../../shared/unbound/company';

export interface UnboundCompanyApi {
  /** The frame-cost guard's verdict: one fewer on stage. */
  companyGuard(verdict: CompanyGuardVerdict): Promise<void>;
  /** Her body now (while two or more are on stage). */
  stageBody(body: StageBody & { arrived?: boolean }): Promise<void>;
  /** She was sent back and has walked out of the screen. */
  stageLeft(): Promise<void>;
  /** 2026-11-24: her frame times of the last minute (numbers and a tier word): one journal row. */
  stageFrames(row: Record<string, unknown>): Promise<void>;
  /** 2026-11-25: her mouth while she read one reply (closed words and numbers per stretch): one journal row under her id. */
  stageMouth(entry: { sentences: unknown[] }): Promise<void>;
  onStage(callback: (view: StageView) => void): () => void;
}
export const UNBOUND_COMPANY_API_KEYS = Object.freeze(['companyGuard', 'stageBody', 'stageLeft', 'stageFrames', 'stageMouth', 'onStage'] as const);

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;
type Subscribe = <T>(channel: string, callback: (value: T) => void) => () => void;
const oneObject = (name: string, value: unknown) => !value || typeof value !== 'object' || Array.isArray(value) ? Promise.reject(new TypeError(`${name} takes one object`)) : null;

export function createUnboundCompanyApi(invoke: Invoke, subscribe: Subscribe): UnboundCompanyApi {
  return {
    companyGuard: verdict => (oneObject('companyGuard', verdict) ?? invoke(UNBOUND_COMPANY_REQUESTS.guard, verdict)) as Promise<void>,
    stageBody: body => (oneObject('stageBody', body) ?? invoke(UNBOUND_STAGE_REQUESTS.body, body)) as Promise<void>,
    stageLeft: () => invoke(UNBOUND_STAGE_REQUESTS.left) as Promise<void>,
    stageFrames: row => (oneObject('stageFrames', row) ?? invoke(UNBOUND_STAGE_REQUESTS.frames, row)) as Promise<void>,
    stageMouth: entry => (oneObject('stageMouth', entry) ?? invoke(UNBOUND_STAGE_REQUESTS.mouth, entry)) as Promise<void>,
    onStage: callback => subscribe(UNBOUND_STAGE_EVENTS.stage, callback),
  };
}
