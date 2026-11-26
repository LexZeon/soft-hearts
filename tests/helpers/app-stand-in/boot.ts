// Boots electron/main.ts under node with the Electron and Claude stand-ins (docs/claude/2026-11-17-isolation-step7.md). Run as a child
// process (main.ts keeps module state): `node <tsx cli> tests/helpers/app-stand-in/boot.ts`, with SOFT_HEARTS_STAND_IN_ROOT a fresh temporary
// folder (the profile lives there). It prints one JSON line starting with STAND-IN-REPORT when the script it was given has run.
import module from 'node:module';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const electronStandIn = pathToFileURL(path.join(here, 'electron.ts')).href;
const claudeStandIn = pathToFileURL(path.join(here, 'claude.ts')).href;
(module as unknown as { registerHooks(hooks: { resolve(specifier: string, context: { parentURL?: string }, next: (s: string, c: unknown) => { url: string }): { url: string; shortCircuit?: boolean } }): void })
  .registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'electron') return { url: electronStandIn, shortCircuit: true };
      if (specifier === 'original-fs') return { url: 'node:fs', shortCircuit: true };
      const resolved = next(specifier, context);
      if (/\/electron\/brain\/claude\.ts$/.test(resolved.url) && context.parentURL !== claudeStandIn) return { url: claudeStandIn, shortCircuit: true };
      return resolved;
    },
  });
// electron/main.ts runs as CommonJS in the app (its bundle); here it is a module: __dirname is where its bundle would be.
(globalThis as Record<string, unknown>).__dirname = path.join(here, '..', '..', '..', 'dist-electron');
