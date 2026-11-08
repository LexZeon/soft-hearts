// Registration text for the control window. Pure, so it is tested without Electron.

export interface ShimLaunch { command: string; args: string[]; env: Record<string, string> }

/** The stable and development builds have separate profiles, pipes and tokens, so each registers under its own name. */
export function agentServerName(profileDirectory: string): string {
  return /-dev$/i.test(profileDirectory.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() ?? '') ? 'soft-hearts-next-dev' : 'soft-hearts-next';
}

/**
 * The arguments after `claude` that register this edition in the user's Claude Code: options precede the server name,
 * as `claude mcp add` requires; everything after `--` is the launch line. The copyable text and the automatic
 * registration (I-014, agent-channel/claude-code-link.ts) are both built from this one list.
 */
export function registrationArguments(launch: ShimLaunch, name: string): string[] {
  return ['mcp', 'add', '--transport', 'stdio', '--scope', 'user',
    ...Object.entries(launch.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]), name, '--', launch.command, ...launch.args];
}

export function setupSnippets(launch: ShimLaunch, name: string): { claudeCode: string; desktopConfig: string } {
  const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
  const env = Object.entries(launch.env).map(([key, value]) => `--env ${key}=${value}`).join(' ');
  return {
    claudeCode: `claude mcp add --transport stdio --scope user ${env} ${name} -- ${[launch.command, ...launch.args].map(quote).join(' ')}`,
    desktopConfig: JSON.stringify({ mcpServers: { [name]: launch } }, null, 2),
  };
}
