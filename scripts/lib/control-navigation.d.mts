export type ControlRoot = 'chat' | 'characters' | 'appearance' | 'memory' | 'providers' | 'agent' | 'privacy';
/** The control window's top-level pages in sidebar order (kept equal to src/ui/control-navigation-state.ts by a test). */
export declare const CONTROL_ROOTS: readonly ControlRoot[];
export declare function navigateControlPage(page: unknown, pageId: ControlRoot, options?: { target?: string; allowLegacy?: boolean }): Promise<void>;
