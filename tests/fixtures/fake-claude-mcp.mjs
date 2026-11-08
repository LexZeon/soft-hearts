// A stand-in for `claude mcp list` / `claude mcp add` / `claude mcp remove` (tests/three-way-interconnect.test.ts,
// tests/claude-code-repoint.test.ts). It reads and writes only the JSON file named by FAKE_CLAUDE_STATE (a temporary
// folder); it never looks at ~/.claude.json or any real setting.
//
// State: { servers: string[], calls: string[][], commands?: {name: launch line}, status?: {name: status},
//   rows?: string[] (extra raw list lines), wrap?: columns (wrap long list rows like Ink), failList?, failAdd?: true | names,
//   failRemove?: names, hang?: ["add:<name>" | "remove:<name>"] (do it, then never exit),
//   collide?: {name: launch line} (another entry takes the name just before the next add of it) }.
// The list prints a stdio server the way Claude Code 2.1.316 does: `${name}: ${command} ${args.join(" ")} - ${status}`.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.FAKE_CLAUDE_STATE;
if (!file) { process.stderr.write('FAKE_CLAUDE_STATE is not set\n'); process.exit(2); }
const state = JSON.parse(readFileSync(file, 'utf8'));
state.commands ??= {};
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => writeFileSync(file, JSON.stringify(state));
const has = (list, name) => list === true || (Array.isArray(list) && list.includes(name));
/** Did the operation; now it never ends (a timeout after the change was made). */
const maybeHang = (operation, name) => { if (has(state.hang, `${operation}:${name}`)) setInterval(() => {}, 1000); else process.exit(0); };
const wrap = (line, width) => {
  const out = [];
  while (width && line.length > width) {
    const space = line.lastIndexOf(' ', width);
    const cut = space > 0 ? space : width;
    out.push(line.slice(0, cut)); line = line.slice(space > 0 ? cut + 1 : cut);
  }
  out.push(line);
  return out.join('\n');
};

if (args[0] === 'mcp' && args[1] === 'list') {
  save();
  if (state.failList) { process.stderr.write('error: not logged in\n'); process.exit(1); }
  if (!state.servers.length && !state.rows?.length) { process.stdout.write('No MCP servers configured. Use `claude mcp add` to add a server.\n'); process.exit(0); }
  const rows = state.servers.map(name => `${name}: ${state.commands[name] ?? '"C:\\some\\server.exe"'} - ${state.status?.[name] ?? '✓ Connected'}`);
  process.stdout.write('Checking MCP server health…\n\n' + [...rows, ...(state.rows ?? [])].map(row => wrap(row, state.wrap)).join('\n') + '\n');
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'add') {
  // Options before the name, the launch line after `--` (as the real command requires).
  const split = args.indexOf('--');
  const name = args[split - 1];
  if (has(state.failAdd, name)) { save(); process.stderr.write('Error: Invalid configuration\n'); process.exit(1); }
  if (split < 0 || !name || name.startsWith('-')) { save(); process.stderr.write('error: missing name\n'); process.exit(1); }
  // Someone else registers the name just before this add (Codex round 033 B02): theirs stays, this one is refused.
  if (state.collide?.[name] !== undefined) {
    if (!state.servers.includes(name)) state.servers.push(name);
    state.commands[name] = state.collide[name]; delete state.collide[name];
  }
  if (state.servers.includes(name)) { save(); process.stderr.write(`MCP server ${name} already exists in user config\n`); process.exit(1); }
  state.servers.push(name);
  state.commands[name] = args.slice(split + 1).join(' ');
  save();
  process.stdout.write(`Added stdio MCP server ${name} to user config\n`);
  maybeHang('add', name);
} else if (args[0] === 'mcp' && args[1] === 'remove') {
  const name = args[2];
  const scope = args[args.indexOf('--scope') + 1];
  if (scope !== 'user' || !name) { save(); process.stderr.write('error: expected --scope user\n'); process.exit(1); }
  if (has(state.failRemove, name)) { save(); process.stderr.write('Error: could not write the user config\n'); process.exit(1); }
  if (!state.servers.includes(name)) { save(); process.stderr.write(`No user-scoped MCP server found with name: ${name}\n`); process.exit(1); }
  state.servers = state.servers.filter(entry => entry !== name);
  delete state.commands[name];
  save();
  process.stdout.write(`Removed MCP server "${name}" from user config\n`);
  maybeHang('remove', name);
} else {
  save();
  process.stderr.write(`unknown command: ${args.join(' ')}\n`);
  process.exit(1);
}
