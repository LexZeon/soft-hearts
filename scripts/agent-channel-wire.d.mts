export const WIRE_VERSION: 1;
export const WIRE_APP: 'soft-hearts-next';
export const MAX_FRAME_BYTES: number;
export const AGENT_PIPE_PREFIX: string;
export function agentPipeName(username: string, profileDirectory: string): string;
export function nonce(): string;
export function clientProof(token: string, serverNonce: string, clientNonce: string): string;
export function serverProof(token: string, clientNonce: string, serverNonce: string): string;
export function proofEquals(expected: string, actual: unknown): boolean;
export function encodeFrame(value: unknown): string;
export class FrameReader {
  constructor(onFrame: (frame: Record<string, unknown>) => void, onError: (reason: 'too_large' | 'malformed') => void, maxBytes?: number);
  push(chunk: Buffer | string): void;
  fail(reason: 'too_large' | 'malformed'): void;
}
