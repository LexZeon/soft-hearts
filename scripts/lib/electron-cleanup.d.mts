import type { ChildProcess } from 'node:child_process';
export interface OwnElectron { close(): Promise<void>; process(): ChildProcess }
export declare function killOwnElectron(target: OwnElectron | ChildProcess | { process(): ChildProcess } | null | undefined): boolean;
export declare function closeElectron(instance: OwnElectron | null | undefined, milliseconds?: number): Promise<{ closed: boolean; killed: boolean; error?: string }>;
export declare function armSmokeWatchdog(current: () => OwnElectron | null | undefined, milliseconds: number, label?: string): () => void;
