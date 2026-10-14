import { remoteSourceId, type SourceCapabilities, type SourceHealth } from "@core/sessions/session";
import { MACHINE } from "@site-tour/feed/hour";

/**
 * The sources of the landing page's hour, as each adapter reports itself
 * when it reads its sessions with nothing wrong: what it reads, how often, and
 * what its agent can report. This computer's sources come first, in the
 * collector's order: Claude Code, Codex, the Antigravity CLI, Antigravity,
 * Mistral Vibe and Gemini CLI, none of the four installed here, and status
 * files. Then the other machine, connected over SSH.
 *
 * The adapters run in Node, so their declarations cannot be bundled into the
 * page. Their words are written here in their place, and a test holds each
 * table of capabilities to the adapter's own, so the page cannot say more than
 * the app does.
 */

export const CLAUDE_CODE_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": { level: "yes" },
  "needs-you": { level: "yes" },
  finished: {
    level: "partly",
    reason: "Only background jobs. Any other session leaves the list when it ends.",
  },
  failed: {
    level: "partly",
    reason: "Only background jobs. Any other session leaves the list without saying how it ended.",
  },
  names: { level: "yes" },
  jump: {
    level: "partly",
    reason:
      "In VS Code, in tmux, and in a tab of Terminal or iTerm2 on a Mac. Not in the desktop app or another terminal.",
  },
  "quiet-for": {
    level: "no",
    reason: "The file Agent Lookout reads is not rewritten as a session works.",
  },
  tokens: {
    level: "partly",
    reason: "On the computer it runs on, from its newest reply, read while its details are open.",
  },
  stop: {
    level: "partly",
    reason: "In a terminal, in VS Code and for background jobs. Not in the desktop app.",
  },
  answer: {
    level: "partly",
    reason:
      "With the Agent Lookout plugin, by Allow, Deny or a permission rule. Allow only if all is shown: never edits, plans or questions.",
  },
};

export const CODEX_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": { level: "yes" },
  "needs-you": {
    level: "no",
    reason: "Codex does not record approval waits, so a session waiting for you shows as working.",
  },
  finished: {
    level: "partly",
    reason: "From Codex 0.155 on, once no Codex program has the session open.",
  },
  failed: { level: "no", reason: "Codex does not record errors in its files." },
  names: {
    level: "partly",
    reason:
      "The desktop app does not keep its titles in the names file Agent Lookout reads, so its sessions take their folder's name.",
  },
  jump: {
    level: "no",
    reason: "Codex's files name no process to find, and Codex documents no link to a session.",
  },
  "quiet-for": { level: "yes" },
  tokens: { level: "yes" },
  stop: {
    level: "no",
    reason: "Codex's files name no process that Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason:
      "Codex records no approval waits, so there is nothing to answer from here, by hand or by a permission rule.",
  },
};

export const STATUS_FILE_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": { level: "partly", reason: "If the agent writes working and idle." },
  "needs-you": { level: "partly", reason: "If the agent writes waiting." },
  finished: { level: "partly", reason: "If the agent writes finished." },
  failed: { level: "partly", reason: "If the agent writes failed." },
  names: {
    level: "partly",
    reason: "If the agent writes a name. Otherwise the folder's or the file's name is used.",
  },
  jump: { level: "no", reason: "Nothing in a status file is used to reach a session." },
  "quiet-for": { level: "partly", reason: "If the agent writes its file again as it works." },
  tokens: { level: "no", reason: "A status file has no field for token counts." },
  stop: {
    level: "no",
    reason: "Any program can write a status file, so nothing in one is used to stop a session.",
  },
  answer: {
    level: "no",
    reason:
      "A status file only says a session waits, and holds nothing to answer it through, by hand or by a permission rule.",
  },
};

export const ANTIGRAVITY_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": { level: "yes" },
  "needs-you": {
    level: "partly",
    reason:
      "While agy asks you to approve a tool, from its own log. A question it asks you shows as working.",
  },
  finished: {
    level: "partly",
    reason:
      "Once ps shows no agy program running that could have the conversation open. Not on Windows.",
  },
  failed: {
    level: "partly",
    reason:
      "Only when agy records an error of its own or a failed reply. A tool that fails shows as working.",
  },
  names: {
    level: "partly",
    reason:
      "The title agy gives a conversation once it has one, and the folder its program's log names. Until then, its conversation ID.",
  },
  jump: {
    level: "no",
    reason:
      "The transcripts name no terminal, and agy documents no link that opens a conversation.",
  },
  "quiet-for": { level: "yes" },
  tokens: { level: "yes" },
  stop: {
    level: "no",
    reason:
      "No agy program is tied to one conversation surely enough for Agent Lookout to confirm it and stop it.",
  },
  answer: {
    level: "no",
    reason: "Its approval prompt takes an answer only in the terminal agy runs in.",
  },
};

export const ANTIGRAVITY_APP_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": { level: "yes" },
  "needs-you": {
    level: "partly",
    reason:
      "While a chat waits for you to approve a step, read from its database with sqlite3, on macOS and Linux. What it asks is not shown.",
  },
  finished: {
    level: "partly",
    reason: "Once ps shows the app is closed, on macOS. Not on Linux or Windows yet.",
  },
  failed: {
    level: "partly",
    reason:
      "Only when Antigravity records an error of its own or a failed reply. A tool that fails shows as working.",
  },
  names: {
    level: "partly",
    reason:
      "The title Antigravity gives a chat, and the folder its list of chats names, read with sqlite3. Until then, its ID.",
  },
  jump: {
    level: "no",
    reason: "Antigravity documents no link that opens one of its chats.",
  },
  "quiet-for": { level: "yes" },
  tokens: { level: "yes" },
  stop: {
    level: "no",
    reason: "The app runs every chat in one program, so no chat can be stopped alone.",
  },
  answer: {
    level: "no",
    reason: "Antigravity documents no way to answer one of its approvals from outside the app.",
  },
};

export const MISTRAL_VIBE_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": { level: "yes" },
  "needs-you": {
    level: "no",
    reason:
      "This version does not read Vibe's approval waits, so a session waiting for you shows as working.",
  },
  finished: {
    level: "partly",
    reason:
      "Once no Vibe program holds it, or one took it in the last 30 seconds and wrote nothing. The desktop app lets go after each turn.",
  },
  failed: {
    level: "partly",
    reason:
      "When a turn ends on an error Vibe records. A Vibe that stops mid-turn without closing shows as finished.",
  },
  names: {
    level: "partly",
    reason:
      "The title Vibe or you give a session. Until it has one, or with Vibe's titles turned off, its folder's name.",
  },
  jump: {
    level: "no",
    reason:
      "Vibe's files name no terminal or window, and Vibe documents no link that opens a session.",
  },
  "quiet-for": { level: "yes" },
  tokens: { level: "no", reason: "This version does not read Vibe's token counts." },
  stop: {
    level: "no",
    reason:
      "The process holding a Vibe session can hold others too, so none can be confirmed and stopped alone.",
  },
  answer: {
    level: "no",
    reason: "Vibe takes its answers only in its own terminal, editor or app.",
  },
};

export const GEMINI_CLI_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "Gemini CLI writes a tool call only once it ends, so a reply with text whose tool still waits or runs shows as idle.",
  },
  "needs-you": {
    level: "no",
    reason:
      "Gemini CLI does not write approval waits to its files, so a session waiting for you shows as working or idle.",
  },
  finished: {
    level: "no",
    reason:
      "Gemini CLI writes no end mark, so a closed session keeps its last status, idle or working, until a day after its last update.",
  },
  failed: {
    level: "no",
    reason:
      "Agent Lookout does not read Gemini CLI's errors yet, so a session whose request failed shows as idle.",
  },
  names: {
    level: "partly",
    reason:
      "The title Gemini CLI saves once a later start in the same folder sums the session up. Until then, the folder's name.",
  },
  jump: {
    level: "no",
    reason:
      "Gemini CLI's files name no process or terminal, and it documents no link that opens a session.",
  },
  "quiet-for": { level: "yes" },
  tokens: { level: "no", reason: "Agent Lookout does not read Gemini CLI's token counts yet." },
  stop: {
    level: "no",
    reason: "Gemini CLI's files name no process that Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason:
      "Gemini CLI records no approval waits, so there is nothing to answer from here, by hand or by a permission rule.",
  },
};

/** The sentence the Codex adapter says of waits, beside its sessions. */
export const CODEX_NEEDS_YOU_NOTE =
  "Codex's session files do not record when it is waiting for your approval, so a Codex session that is waiting for you shows as working.";

/**
 * What Claude Code on the other machine can report, as it is seen from here:
 * what its Agent Lookout says, with Jump, Stop and Answer as no, since each
 * acts on this computer only, and Tokens as no, since its counts are read
 * only on that machine.
 */
export const CLAUDE_CODE_THERE_CAPABILITIES: SourceCapabilities = {
  ...CLAUDE_CODE_CAPABILITIES,
  jump: { level: "no", reason: `Jump acts on this computer only, not on ${MACHINE.name}.` },
  tokens: {
    level: "no",
    reason: `Read only on ${MACHINE.name}, while a session's details are open there.`,
  },
  stop: { level: "no", reason: `Stop acts on this computer only, not on ${MACHINE.name}.` },
  answer: { level: "no", reason: `Answer acts on this computer only, not on ${MACHINE.name}.` },
};

/** The port on this computer that ssh forwards to the other machine's Agent Lookout. */
const FORWARDED_PORT = 52417;

/** The command the tunnel to the other machine runs, as its card shows it. */
export const MACHINE_COMMAND = [
  "/usr/bin/ssh",
  "-N",
  "-o",
  "BatchMode=yes",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-L",
  `127.0.0.1:${FORWARDED_PORT}:127.0.0.1:${MACHINE.port}`,
  "--",
  MACHINE.target,
].join(" ");

/**
 * Each source's health, checked a moment before `now`. `filesRead` is how many
 * status files there are, and `version` the version of Agent Lookout, which the
 * other machine runs too.
 */
export function sourcesAt(now: number, filesRead: number, version: string): SourceHealth[] {
  const checkedAt = now - 1_500;
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      state: "ok",
      detail:
        "Sessions are read from Claude Code's session registry and checked against its own list of sessions.",
      watching: [
        { label: "Registry folder", value: "~/.claude/sessions" },
        { label: "Registry read", value: "every 2 seconds" },
        { label: "Command", value: "claude agents --json --all" },
        { label: "Command run", value: "every 30 seconds" },
        {
          label: "Transcript read",
          value: "last message of a waiting session, and of one whose details are open",
        },
      ],
      capabilities: CLAUDE_CODE_CAPABILITIES,
      checkedAt,
    },
    {
      id: "codex",
      label: "Codex",
      state: "ok",
      detail: `Sessions are read from the files Codex saves in ~/.codex/sessions. ${CODEX_NEEDS_YOU_NOTE}`,
      watching: [
        { label: "Sessions folder", value: "~/.codex/sessions" },
        { label: "Read", value: "every 2 seconds" },
        { label: "Open-sessions folder", value: "~/.codex/thread-writer-locks" },
        { label: "Names file", value: "~/.codex/session_index.jsonl" },
        {
          label: "Last message read",
          value: "end of a session's file, while its details are open",
        },
      ],
      capabilities: CODEX_CAPABILITIES,
      checkedAt,
    },
    {
      // The adapter's card when agy is not installed: its folder is looked for, and nothing more.
      id: "antigravity-cli",
      label: "Antigravity CLI",
      state: "unavailable",
      detail:
        "The Antigravity CLI was not found: there is no ~/.gemini/antigravity-cli folder. Agent Lookout looks again every minute.",
      watching: [
        { label: "Conversations folder", value: "~/.gemini/antigravity-cli/brain" },
        { label: "Read", value: "not found" },
        { label: "Command", value: "ps -A -o pid=,ppid=,lstart=,comm=" },
        { label: "Command run", value: "every 10 seconds at most" },
      ],
      capabilities: ANTIGRAVITY_CAPABILITIES,
      checkedAt,
    },
    {
      // The adapter's card when Antigravity 2.0 is not installed: its folder is looked for, and nothing more.
      id: "antigravity-app",
      label: "Antigravity",
      state: "unavailable",
      detail:
        "Antigravity was not found: there is no ~/.gemini/antigravity folder. Agent Lookout looks again every minute.",
      watching: [
        { label: "Conversations folder", value: "~/.gemini/antigravity/brain" },
        { label: "Read", value: "not found" },
        { label: "Command", value: "ps -A -o comm=" },
        { label: "Command run", value: "every 10 seconds at most" },
        { label: "Folders file", value: "~/.gemini/antigravity/conversation_summaries.db" },
        { label: "Folders read", value: "with sqlite3, when the file changes" },
        { label: "Waits read", value: "with sqlite3, when a chat's database changes" },
      ],
      capabilities: ANTIGRAVITY_APP_CAPABILITIES,
      checkedAt,
    },
    {
      // The adapter's card when Mistral Vibe is not installed: its folder is looked for, and nothing more.
      id: "mistral-vibe",
      label: "Mistral Vibe",
      state: "unavailable",
      detail:
        "Mistral Vibe was not found: there is no ~/.vibe/logs/session folder. Agent Lookout looks again every minute.",
      watching: [
        { label: "Sessions folder", value: "~/.vibe/logs/session/unified" },
        { label: "Read", value: "not found" },
        { label: "Open-sessions folder", value: "~/.vibe/logs/session/active" },
      ],
      capabilities: MISTRAL_VIBE_CAPABILITIES,
      checkedAt,
    },
    {
      // The adapter's card when Gemini CLI is not installed: its folder is looked for, and nothing more.
      id: "gemini-cli",
      label: "Gemini CLI",
      state: "unavailable",
      detail:
        "Gemini CLI was not found: there is no ~/.gemini/tmp folder. Agent Lookout looks again every minute.",
      watching: [
        { label: "Sessions folder", value: "~/.gemini/tmp" },
        { label: "Read", value: "not found" },
        { label: "Files read", value: "chats/session-*.jsonl and .project_root in each project" },
        { label: "Programs run", value: "None" },
      ],
      capabilities: GEMINI_CLI_CAPABILITIES,
      checkedAt,
    },
    {
      id: "status-files",
      label: "Status files",
      state: "ok",
      detail:
        "Each file ending in .json in ~/.agent-lookout/sessions is one session, written by the agent it belongs to.",
      watching: [
        { label: "Folder", value: "~/.agent-lookout/sessions" },
        { label: "Read", value: "every 2 seconds" },
        { label: "Files read", value: String(filesRead) },
        { label: "Files skipped", value: "0" },
      ],
      capabilities: STATUS_FILE_CAPABILITIES,
      checkedAt,
    },
    {
      id: remoteSourceId(MACHINE.name),
      label: MACHINE.name,
      machine: MACHINE.name,
      state: "ok",
      detail: `Sessions are read from Agent Lookout ${version} on ${MACHINE.name}, through ssh to ${MACHINE.target}. Jump, Stop, Allow and Deny act on this computer only.`,
      watching: [
        { label: "Connects to", value: MACHINE.target },
        { label: "Command", value: MACHINE_COMMAND },
        { label: "Asks for", value: "/api/health and /api/sessions" },
        { label: "Read", value: "every 2 seconds" },
        { label: "Agent Lookout there", value: version },
        { label: "Claude Code there", value: "Watching" },
        { label: "Codex there", value: "Not found" },
        { label: "Antigravity CLI there", value: "Not found" },
        { label: "Antigravity there", value: "Not found" },
        { label: "Mistral Vibe there", value: "Not found" },
        { label: "Gemini CLI there", value: "Not found" },
        { label: "Status files there", value: "Not set up" },
      ],
      agents: [{ label: "Claude Code", capabilities: CLAUDE_CODE_THERE_CAPABILITIES }],
      checkedAt,
    },
  ];
}
