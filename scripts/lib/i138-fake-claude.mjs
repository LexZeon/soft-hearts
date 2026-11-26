// I-138 offline stand-in for Claude Code when the experiment spawns a FORKED process (`--resume <id> --fork-session`, slash commands on,
// session persistence on). The app's fake (prompt-eval-fake-claude.mjs) accepts only the app's exact argv, so this wrapper records what was
// asked (to the JSONL file named by I138_FAKE_LOG: booleans and the session id, never prompts), puts the app's isolation flags back, and then
// runs the app's fake. No network, no account.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const out = [];
const info = { resumed: null, fork: false, slashCommands: true, persistence: true };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--resume') { info.resumed = args[++i] ?? null; continue; }
  if (args[i] === '--fork-session') { info.fork = true; continue; }
  out.push(args[i]);
}
info.slashCommands = !out.includes('--disable-slash-commands');
info.persistence = !out.includes('--no-session-persistence');
const at = out.indexOf('--setting-sources');
if (at >= 0) {
  const missing = ['--disable-slash-commands', '--no-session-persistence'].filter(flag => !out.includes(flag));
  out.splice(at, 0, ...missing);
}
if (process.env.I138_FAKE_LOG) appendFileSync(process.env.I138_FAKE_LOG, JSON.stringify({ event: 'start', ...info }) + '\n');
process.argv.splice(2, process.argv.length - 2, ...out);
await import('./prompt-eval-fake-claude.mjs');
