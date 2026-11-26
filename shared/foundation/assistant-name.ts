// I-217 (2026-11-24 night: the release should mark where the name Claude is written, and the user's own agent can replace it):
// the name of the user's own assistant / agent, shown in the interface, gathered in ONE place. On this build it is Claude, and every
// string below comes out byte for byte the same as before. A port onto another agent changes these two lines (see docs/PORTING.md,
// "Where the app says Claude"). A port that is not on Claude should put its own name here and not claim to be Claude.
//
// Two ways the name reaches the screen:
//   1. Text that goes through t() (src/ windows, the ui-copy dictionaries, zh and en): the dictionaries keep the word "Claude" as written,
//      and t() swaps it at the last step with applyAssistantNames(). That is why the dictionaries are not full of ${...} pieces.
//   2. Host-side messages that never go through t() (errors, notices, dialogs in electron/): they build the text from the constants
//      below. Which files still hold a literal name on purpose is listed in scripts/dev/claude-names-allowlist.json.

/** The agent's name in plain sentences: 「Claude 助手」, 「由 Claude 操作」, "your Claude". */
export const ASSISTANT_NAME: string = 'Claude';
/** What the program that runs the agent is called on screen: 「你的 Claude Code」. The command itself is plugged in with CLAUDE_PATH (docs/PORTING.md). */
export const ASSISTANT_CLI_NAME: string = 'Claude Code';

const BUILT_IN_NAME = 'Claude';
const BUILT_IN_CLI_NAME = 'Claude Code';
// What t() puts in. Same as the two constants; only a test changes it (to show that the swap reaches the screen text).
let shownName = ASSISTANT_NAME, shownCli = ASSISTANT_CLI_NAME;
export function setShownAssistantNamesForTest(name: string = ASSISTANT_NAME, cli: string = ASSISTANT_CLI_NAME): void { shownName = name; shownCli = cli; }

/**
 * Swap the built-in name for the configured one in a piece of interface text. The command name goes first so "Claude Code" does not become
 * "<name> Code". Identity on this build. The names are passed in so the test can show that changing them changes every string.
 */
export function applyAssistantNames(text: string, name: string = shownName, cli: string = shownCli): string {
  if (name === BUILT_IN_NAME && cli === BUILT_IN_CLI_NAME) return text;
  return text.replace(/\bClaude(?: Code)?\b/g, found => found === BUILT_IN_CLI_NAME ? cli : name);
}
