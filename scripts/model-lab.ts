// Model lab: profile, collision proxy and the 53 bundled motions on your own MMD
// models, in Node (no Electron, no network). Usage and privacy rules:
// docs/claude/2026-11-02-model-lab.md. Run from the repository root:
//   node node_modules/tsx/dist/cli.mjs scripts/model-lab.ts --config C:\mmd-test\model-lab.json
import { runModelLab } from './model-lab/cli';

process.exitCode = await runModelLab(process.argv.slice(2));
